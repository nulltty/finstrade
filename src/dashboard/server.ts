import express from 'express';
import path from 'path';
import crypto from 'crypto';
import { prisma } from '../db/prisma.js';
import { whaleWatcherService } from '../services/watcher.js';
import { whaleDiscovery } from '../services/discovery.js';
import { walletProfiler } from '../services/walletProfiler.js';
import { circuitBreaker } from '../services/circuitBreaker.js';
import { tradeExecutor } from '../services/executor.js';
import { telegramBot } from '../bot/telegram.js';
import { settingsService } from '../services/settings.js';
import { systemStatus } from '../services/status.js';
import { computeReadiness, buildReadinessReport } from '../services/readiness.js';
import { getTradingKeypair, getSolBalance, getSolPriceUsd, getUsdToIdrRate, normalizeHeliusTx } from '../services/solana.js';
import { multiWalletScanner } from '../services/scanner.js';
import { getApiHealthSummary } from '../services/apiHealth.js';
import { createSessionToken, verifySessionToken, parseCookies, SESSION_COOKIE_NAME } from '../services/session.js';
import { multiWalletScannerQueue, signalQueue, whaleDiscoveryQueue } from '../workers/queue.js';
import { env, solanaRpcUrl } from '../config/index.js';
import { logger } from '../services/logger.js';

const PUBLIC_DIR = path.join(process.cwd(), 'src', 'dashboard', 'public');

let balanceCache = { at: 0, sol: null as number | null, address: '' };

async function walletSnapshot() {
  const kp = await getTradingKeypair();
  const address = kp?.publicKey.toBase58() || '';
  if (address && (Date.now() - balanceCache.at > 15000 || balanceCache.address !== address)) {
    balanceCache = { at: Date.now(), sol: await getSolBalance(address), address };
  }
  const [solPrice, idrRate] = await Promise.all([getSolPriceUsd(), getUsdToIdrRate()]);
  const usd = balanceCache.sol !== null ? balanceCache.sol * solPrice : null;
  return {
    address,
    sol: balanceCache.sol,
    usd,
    idr: usd !== null ? usd * idrRate : null,
    idrRate,
    solPrice,
  };
}

// Express 5 forwards rejected promises to the error handler
type Handler = (req: express.Request, res: express.Response) => Promise<any> | any;
const h = (fn: Handler): Handler => fn;

/**
 * What the cockpit should count: the current mode's trades only, and never archived ones.
 * Archived rows stay in the database as a record — soft-deleted history such as paper runs
 * from an older fill model, which would distort today's stats if mixed in.
 * ?includePaper=1 shows both modes, ?includeArchived=1 brings the archived rows back.
 */
function viewFilter(req: { query: Record<string, any> }, paperTrading: boolean) {
  return {
    ...(req.query.includePaper === '1' ? {} : { isPaper: paperTrading }),
    ...(req.query.includeArchived === '1' ? {} : { archived: false }),
  };
}

export function createServer() {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  // Login-page + session-cookie auth whenever COCKPIT_PASSWORD is set; webhooks use their own secret
  if (env.COCKPIT_PASSWORD) {
    const LOGIN_USER = 'finstrade';
    const expectedPass = Buffer.from(env.COCKPIT_PASSWORD);

    app.post('/login', (req, res) => {
      const { username, password } = req.body || {};
      const given = Buffer.from(String(password || ''));
      const userOk = username === LOGIN_USER;
      const passOk = given.length === expectedPass.length && crypto.timingSafeEqual(given, expectedPass);
      if (!userOk || !passOk) return res.redirect('/login.html?error=1');
      res.cookie(SESSION_COOKIE_NAME, createSessionToken(LOGIN_USER), {
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 30 * 24 * 3600 * 1000,
      });
      res.redirect('/');
    });

    app.post('/logout', (_req, res) => {
      res.clearCookie(SESSION_COOKIE_NAME);
      res.redirect('/login.html');
    });

    app.use((req, res, next) => {
      if (req.path.startsWith('/api/webhook/') || req.path === '/health' || req.path === '/login.html') return next();
      const cookies = parseCookies(req.get('cookie'));
      if (verifySessionToken(cookies[SESSION_COOKIE_NAME])) return next();
      if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'auth required' });
      res.redirect('/login.html');
    });
  }

  // CSRF guard: a custom header forces a CORS preflight, so other websites open in
  // the same browser can't fire state-changing requests at the local cockpit.
  app.use('/api', (req, res, next) => {
    if (req.method === 'GET' || req.path.startsWith('/webhook/')) return next();
    if (req.get('x-cockpit') !== '1') return res.status(403).json({ error: 'missing x-cockpit header' });
    next();
  });

  app.get('/health', h(async (_req, res) => {
    const settings = await settingsService.getSettings();
    res.json({ status: 'ok', uptime: process.uptime(), paperTrading: settings.paperTrading, autoTradeMode: settings.autoTradeMode });
  }));

  // ── Cockpit overview (single call the dashboard polls) ──────────────────
  app.get('/api/overview', h(async (req, res) => {
    const since24h = new Date(Date.now() - 24 * 3600 * 1000);
    const settingsPreview = await settingsService.getPublicSettings();
    // Auto-hide paper history once running live, so win/loss stats reflect real trades only.
    // ?includePaper=1 overrides this to inspect the full history including paper trades.
    const modeFilter = viewFilter(req, settingsPreview.paperTrading);
    const [settings, wallet, open, closed, signals24h, statusGroups, whaleGroups, activeWhales, spent24h, queueCounts] = await Promise.all([
      Promise.resolve(settingsPreview),
      walletSnapshot(),
      prisma.position.findMany({ where: { status: { in: ['open', 'closing'] }, ...modeFilter } }),
      prisma.position.findMany({ where: { status: 'closed', ...modeFilter }, select: { pnlPercent: true, costUsd: true, proceedsUsd: true, entryAmount: true, entryPrice: true, exitPrice: true, openedAt: true, closedAt: true, exitReason: true } }),
      prisma.signal.count({ where: { createdAt: { gte: since24h } } }),
      prisma.signal.groupBy({ by: ['status'], _count: { _all: true }, where: { createdAt: { gte: since24h } } }),
      prisma.watchedWallet.groupBy({ by: ['profileStatus'], _count: { _all: true } }),
      prisma.watchedWallet.count({ where: { isActive: true } }),
      prisma.trade.aggregate({ _sum: { totalUsd: true }, where: { side: 'BUY', createdAt: { gte: since24h } } }),
      signalQueue.getJobCounts('waiting', 'active', 'delayed', 'failed'),
    ]);

    const pnlUsdOf = (p: (typeof closed)[number]) =>
      (p.proceedsUsd ?? p.entryAmount * (p.exitPrice || 0)) - (p.costUsd || p.entryAmount * p.entryPrice);
    const realizedPnlUsd = closed.reduce((a, p) => a + pnlUsdOf(p), 0);
    const wins = closed.filter((p) => p.pnlPercent > 0).length;
    const holdMins = closed.filter((p) => p.closedAt).map((p) => (p.closedAt!.getTime() - p.openedAt.getTime()) / 60000);
    const openValueUsd = open.reduce((a, p) => a + p.entryAmount * p.currentPrice, 0);
    const openCostUsd = open.reduce((a, p) => a + (p.costUsd || p.entryAmount * p.entryPrice), 0);
    const exitReasons: Record<string, number> = {};
    for (const p of closed) exitReasons[p.exitReason || 'unknown'] = (exitReasons[p.exitReason || 'unknown'] || 0) + 1;
    // In paper mode the real wallet is not what the run is being judged on, and showing its
    // balance next to simulated PnL invites reading one as the other. Report simulated equity
    // instead — starting cash plus realised PnL plus what the open paper positions are worth —
    // and flag it so the cockpit can label it rather than passing it off as the real balance.
    const shownWallet = settings.paperTrading
      ? (() => {
          const equityUsd = settings.paperStartBalanceUsd + realizedPnlUsd + (openValueUsd - openCostUsd);
          return {
            address: wallet.address,
            simulated: true,
            startUsd: settings.paperStartBalanceUsd,
            sol: wallet.solPrice > 0 ? equityUsd / wallet.solPrice : null,
            usd: equityUsd,
            idr: wallet.idrRate ? equityUsd * wallet.idrRate : null,
            idrRate: wallet.idrRate,
            solPrice: wallet.solPrice,
          };
        })()
      : { ...wallet, simulated: false, startUsd: null };

    // Same scope the breaker itself uses, so the number shown can't contradict the status
    const recentStopLosses = await prisma.position.count({
      where: {
        exitReason: 'stop_loss',
        ...modeFilter,
        closedAt: { gte: new Date(Date.now() - env.CIRCUIT_BREAKER_WINDOW_MINUTES * 60000) },
      },
    });

    res.json({
      now: Date.now(),
      uptimeSec: Math.round(process.uptime()),
      settings,
      wallet: shownWallet,
      rpc: solanaRpcUrl.includes('helius') ? 'helius' : solanaRpcUrl.includes('api.mainnet-beta') ? 'public' : 'custom',
      engines: systemStatus,
      queue: queueCounts,
      circuitBreaker: { ...circuitBreaker.getStatus(), recentStopLosses },
      stats: {
        realizedPnlUsd,
        unrealizedPnlUsd: openValueUsd - openCostUsd,
        openCount: open.length,
        openValueUsd,
        closedCount: closed.length,
        wins,
        losses: closed.length - wins,
        winRate: closed.length ? (wins / closed.length) * 100 : 0,
        bestTradePct: closed.length ? Math.max(...closed.map((p) => p.pnlPercent)) : 0,
        worstTradePct: closed.length ? Math.min(...closed.map((p) => p.pnlPercent)) : 0,
        avgHoldMin: holdMins.length ? holdMins.reduce((a, c) => a + c, 0) / holdMins.length : 0,
        signals24h,
        spent24h: spent24h._sum.totalUsd || 0,
        exitReasons,
      },
      funnel24h: Object.fromEntries(statusGroups.map((g) => [g.status, g._count._all])),
      whales: {
        active: activeWhales,
        ...Object.fromEntries(whaleGroups.map((g) => [g.profileStatus, g._count._all])),
      },
    });
  }));

  app.get('/api/equity', h(async (req, res) => {
    const settings = await settingsService.getPublicSettings();
    const modeFilter = viewFilter(req, settings.paperTrading);
    const closed = await prisma.position.findMany({ where: { status: 'closed', ...modeFilter }, orderBy: { closedAt: 'asc' } });
    let cum = 0;
    res.json(
      closed.map((p) => {
        const pnl = (p.proceedsUsd ?? p.entryAmount * (p.exitPrice || 0)) - (p.costUsd || p.entryAmount * p.entryPrice);
        cum += pnl;
        return { t: p.closedAt?.getTime(), pnl, cum, symbol: p.tokenSymbol };
      })
    );
  }));

  // Score vs actual outcome — for tuning the threshold (Batch 8)
  app.get('/api/performance', h(async (req, res) => {
    const settings = await settingsService.getPublicSettings();
    const modeFilter = viewFilter(req, settings.paperTrading);
    const closed = await prisma.position.findMany({
      where: { status: 'closed', signalId: { not: null }, ...modeFilter },
      include: { signal: { include: { score: true } } },
    });
    res.json(
      closed
        .filter((p) => p.signal?.score)
        .map((p) => ({ score: p.signal!.score!.totalScore, pnl: p.pnlPercent, symbol: p.tokenSymbol, reason: p.exitReason }))
    );
  }));

  // LIVE readiness: is the paper record good enough to risk real money?
  app.get('/api/readiness', h(async (_req, res) => {
    const { trades: _t, ...r } = await computeReadiness();
    res.json(r);
  }));

  // Full snapshot for an external AI reviewer (see prompts/live-readiness-review.md)
  app.get('/api/readiness/export', h(async (_req, res) => {
    const report = await buildReadinessReport();
    res.set('Content-Disposition', `attachment; filename="fins-trade-readiness-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json(report);
  }));

  app.get('/api/audit', h(async (req, res) => {
    const take = Math.min(200, Number(req.query.limit) || 80);
    res.json(await prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take }));
  }));

  // 429 / timeout evidence per provider — the real signal for "time to upgrade?"
  app.get('/api/api-health', h(async (_req, res) => res.json(getApiHealthSummary())));

  // ── Settings ────────────────────────────────────────────────────────────
  app.get('/api/settings', h(async (_req, res) => res.json(await settingsService.getPublicSettings())));

  app.post('/api/settings', h(async (req, res) => {
    const updates = { ...req.body };
    delete updates.hasTradingKey;
    if (typeof updates.telegramBotToken === 'string' && updates.telegramBotToken.includes('...')) delete updates.telegramBotToken;
    await settingsService.updateSettings(updates);
    res.json({ success: true, settings: await settingsService.getPublicSettings() });
  }));

  app.post('/api/settings/test-telegram', h(async (_req, res) => {
    await telegramBot.init();
    const id = await telegramBot.notify('🐟 <b>Fins Trade — test</b>\n✅ Koneksi Telegram berhasil. Bot memantau whale 24/7.');
    if (id === null) return res.status(400).json({ error: 'Telegram not configured or message failed — check token & chat id' });
    res.json({ success: true });
  }));

  // ── Webhooks ────────────────────────────────────────────────────────────
  app.post('/api/webhook/helius', h(async (req, res) => {
    if (req.headers.authorization !== env.WEBHOOK_SECRET) return res.status(401).json({ error: 'unauthorized' });
    const txs = Array.isArray(req.body) ? req.body : [req.body];
    const solPrice = await getSolPriceUsd();
    const settings = await settingsService.getSettings();

    let signals = 0;
    let exits = 0;
    for (const tx of txs) {
      if (!tx?.signature || !tx?.feePayer) continue;
      const r = await multiWalletScanner.handleWhaleTx(
        tx.feePayer,
        normalizeHeliusTx(tx, tx.feePayer),
        solPrice,
        settings,
        tx
      );
      signals += r.signals;
      exits += r.exits;
    }
    res.json({ success: true, received: txs.length, signals, exits });
  }));

  // ── Whale wallets ───────────────────────────────────────────────────────
  app.get('/api/wallets', h(async (_req, res) => {
    res.json(
      await prisma.watchedWallet.findMany({
        orderBy: [{ isActive: 'desc' }, { whaleScore: 'desc' }, { createdAt: 'desc' }],
        take: 300,
      })
    );
  }));

  app.post('/api/wallets', h(async (req, res) => {
    const { address, chain = 'solana', label, tags } = req.body;
    if (!address) return res.status(400).json({ error: 'Address is required' });
    const wallet = await whaleDiscovery.addWallet({ address, chain, label, tags });
    walletProfiler.profileAndSave(address).catch((err) => logger.warn({ err: err?.message }, 'Profile of new wallet failed'));
    res.json({ success: true, wallet });
  }));

  app.post('/api/wallets/:id/toggle', h(async (req, res) => {
    res.json({ success: true, wallet: await whaleDiscovery.toggleWallet(req.params.id as string) });
  }));

  app.post('/api/wallets/:id/profile', h(async (req, res) => {
    const w = await prisma.watchedWallet.findUnique({ where: { id: req.params.id as string } });
    if (!w) return res.status(404).json({ error: 'not found' });
    res.json({ success: true, profile: await walletProfiler.profileAndSave(w.address) });
  }));

  app.delete('/api/wallets/:id', h(async (req, res) => {
    await whaleDiscovery.deleteWallet(req.params.id as string);
    res.json({ success: true });
  }));

  app.post('/api/wallets/auto-discover', h(async (_req, res) => {
    await whaleDiscoveryQueue.add('auto-discover-whales', {}, { jobId: `discover-manual-${Date.now()}` });
    res.json({ success: true, queued: true });
  }));

  app.post('/api/wallets/scan-now', h(async (_req, res) => {
    await multiWalletScannerQueue.add('scan-active-whales', {}, { jobId: `scan-manual-${Date.now()}` });
    res.json({ success: true, queued: true });
  }));

  // ── Signals, positions, trades ──────────────────────────────────────────
  app.get('/api/signals', h(async (_req, res) => {
    res.json(await prisma.signal.findMany({ orderBy: { createdAt: 'desc' }, take: 60, include: { score: true } }));
  }));

  app.get('/api/positions', h(async (req, res) => {
    res.json(
      await prisma.position.findMany({
        where: req.query.includeArchived === '1' ? {} : { archived: false },
        orderBy: { openedAt: 'desc' },
        take: 60,
        include: { trades: true },
      })
    );
  }));

  app.get('/api/trades', h(async (req, res) => {
    const settings = await settingsService.getPublicSettings();
    const modeFilter = viewFilter(req, settings.paperTrading);
    res.json(await prisma.trade.findMany({ where: modeFilter, orderBy: { createdAt: 'desc' }, take: 60 }));
  }));

  app.get('/api/circuit-breaker', (_req, res) => res.json(circuitBreaker.getStatus()));

  app.post('/api/circuit-breaker/reset', (_req, res) => {
    circuitBreaker.reset();
    res.json({ success: true, status: circuitBreaker.getStatus() });
  });

  app.post('/api/circuit-breaker/trip', (req, res) => {
    circuitBreaker.trip(req.body?.reason || 'Manual halt from cockpit');
    res.json({ success: true, status: circuitBreaker.getStatus() });
  });

  app.post('/api/positions/:id/close', h(async (req, res) => {
    res.json(await tradeExecutor.executeSell(req.params.id as string, 'manual'));
  }));

  app.post('/api/signals/:id/approve', h(async (req, res) => {
    await telegramBot.handleApproveBuy(null, req.params.id as string);
    res.json({ success: true });
  }));

  app.post('/api/signals/:id/skip', h(async (req, res) => {
    await telegramBot.handleSkipBuy(null, req.params.id as string);
    res.json({ success: true });
  }));

  // Simulated signals always execute as paper, even in live mode
  app.post('/api/simulate-signal', h(async (req, res) => {
    const {
      wallet = 'SimulatedWha1e11111111111111111111111111111',
      chain = 'solana',
      tokenAddress = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
      tokenSymbol = 'BONK',
      tokenName = 'Bonk',
      amountUsd = 25000,
    } = req.body || {};
    const txHash = `sim_tx_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const result = await whaleWatcherService.processEvent({ wallet, chain, tokenAddress, tokenSymbol, tokenName, txHash, amountUsd, timestamp: Date.now() });
    res.json({ success: true, result });
  }));

  // ── Cockpit UI ──────────────────────────────────────────────────────────
  app.use(express.static(PUBLIC_DIR));
  app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'cockpit.html')));

  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error({ err: err?.message }, 'API error');
    res.status(500).json({ error: err?.message || 'internal error' });
  });

  return app;
}
