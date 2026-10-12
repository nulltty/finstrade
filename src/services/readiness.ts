import { prisma } from '../db/prisma.js';
import { settingsService } from './settings.js';
import { systemStatus } from './status.js';
import { solanaRpcUrl } from '../config/index.js';

/**
 * LIVE readiness: is the paper-trading record strong enough to risk real money?
 * Paper fills are optimistic (no slippage, fees, latency, failed txs), so every
 * trade is "haircut" by the measured round-trip cost before judging it.
 */

export type CheckStatus = 'pass' | 'fail' | 'pending' | 'manual';

export interface ReadinessCheck {
  id: string;
  group: 'data' | 'edge' | 'risk' | 'ops';
  label: string;
  status: CheckStatus;
  value: string;
  target: string;
  help: string;
}

export interface ReadinessTrade {
  symbol: string;
  token: string;
  isPaper: boolean;
  openedAt: string;
  closedAt: string;
  holdMinutes: number;
  costUsd: number;
  pnlUsd: number;
  pnlPct: number;
  adjPnlUsd: number;
  adjPnlPct: number;
  exitReason: string;
  score: number | null;
  roundTripLossPct: number | null;
  buyPriceImpactPct: number | null;
  whale: string;
  whaleWinRate: number | null;
}

// Thresholds — kept here so the cockpit, CLI and the AI prompt all agree
export const READINESS_RULES = {
  minTrades: 30,
  minDays: 14,
  minHaircutPct: 5,
  latencyBufferPct: 2, // price drift between whale tx and our fill
  defaultHaircutPct: 6,
  maxDrawdownPositions: 1.5, // max drawdown ≤ 1.5 × average position size
  minProfitFactor: 1.2,
  maxBreakerDays: 2,
  minUptimeDays: 7,
  minQualifiedWhales: 3,
  minTradesForScoreCheck: 10,
};

const isTestTx = (tx?: string | null) => !!tx && (tx.startsWith('sim_tx_') || tx.startsWith('tx_'));
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, c) => a + c, 0) / xs.length : 0);
const r2 = (n: number) => Math.round(n * 100) / 100;

export async function loadClosedTrades(): Promise<{ trades: ReadinessTrade[]; haircutPct: number; haircutSource: string }> {
  const positions = await prisma.position.findMany({
    where: { status: 'closed' },
    include: { signal: { include: { score: true } } },
    orderBy: { closedAt: 'asc' },
  });
  const real = positions.filter((p) => !isTestTx(p.signal?.txHash));

  const measured = real
    .map((p) => (p.signal?.rawMetrics as any)?.roundTripLossPct)
    .filter((v): v is number => typeof v === 'number' && isFinite(v) && v >= 0);
  const haircutPct = measured.length
    ? Math.max(READINESS_RULES.minHaircutPct, mean(measured) + READINESS_RULES.latencyBufferPct)
    : READINESS_RULES.defaultHaircutPct;
  const haircutSource = measured.length
    ? `avg measured Jupiter round-trip ${mean(measured).toFixed(1)}% + ${READINESS_RULES.latencyBufferPct}% latency (min ${READINESS_RULES.minHaircutPct}%)`
    : `default ${READINESS_RULES.defaultHaircutPct}% (no round-trip measurements yet)`;

  const whales = new Map(
    (await prisma.watchedWallet.findMany({ where: { address: { in: real.map((p) => p.whaleWallet || '').filter(Boolean) } } })).map((w) => [w.address, w])
  );

  const trades = real.map((p) => {
    const cost = p.costUsd || p.entryAmount * p.entryPrice;
    const proceeds = p.proceedsUsd ?? p.entryAmount * (p.exitPrice || 0);
    const pnlUsd = proceeds - cost;
    const pnlPct = cost > 0 ? (pnlUsd / cost) * 100 : p.pnlPercent;
    // Live trades already contain real costs; only paper gets the haircut
    const hc = p.isPaper ? haircutPct : 0;
    const m = (p.signal?.rawMetrics as any) || {};
    return {
      symbol: p.tokenSymbol || '?',
      token: p.tokenAddress,
      isPaper: p.isPaper,
      openedAt: p.openedAt.toISOString(),
      closedAt: (p.closedAt || p.updatedAt).toISOString(),
      holdMinutes: r2(((p.closedAt || p.updatedAt).getTime() - p.openedAt.getTime()) / 60000),
      costUsd: r2(cost),
      pnlUsd: r2(pnlUsd),
      pnlPct: r2(pnlPct),
      adjPnlUsd: r2(pnlUsd - (cost * hc) / 100),
      adjPnlPct: r2(pnlPct - hc),
      exitReason: p.exitReason || 'unknown',
      score: p.signal?.score?.totalScore ?? null,
      roundTripLossPct: typeof m.roundTripLossPct === 'number' ? r2(m.roundTripLossPct) : null,
      buyPriceImpactPct: typeof m.buyPriceImpactPct === 'number' ? r2(m.buyPriceImpactPct) : null,
      whale: p.whaleWallet ? `${p.whaleWallet.slice(0, 4)}…${p.whaleWallet.slice(-4)}` : '?',
      whaleWinRate: p.whaleWallet ? whales.get(p.whaleWallet)?.winRate ?? null : null,
    };
  });

  return { trades, haircutPct: r2(haircutPct), haircutSource };
}

export function summarize(trades: ReadinessTrade[]) {
  const n = trades.length;
  const adj = trades.map((t) => t.adjPnlUsd);
  const wins = adj.filter((x) => x > 0);
  const losses = adj.filter((x) => x <= 0);
  let cum = 0;
  let peak = 0;
  let maxDd = 0;
  for (const x of adj) {
    cum += x;
    peak = Math.max(peak, cum);
    maxDd = Math.max(maxDd, peak - cum);
  }
  const best = n ? Math.max(...adj) : 0;
  const total = adj.reduce((a, c) => a + c, 0);
  const grossLoss = Math.abs(losses.reduce((a, c) => a + c, 0));
  return {
    trades: n,
    winRatePct: n ? r2((wins.length / n) * 100) : 0,
    rawTotalPnlUsd: r2(trades.reduce((a, t) => a + t.pnlUsd, 0)),
    adjTotalPnlUsd: r2(total),
    adjTotalWithoutBestUsd: r2(total - best),
    expectancyRawPct: r2(mean(trades.map((t) => t.pnlPct))),
    expectancyAdjPct: r2(mean(trades.map((t) => t.adjPnlPct))),
    profitFactor: grossLoss > 0 ? r2(wins.reduce((a, c) => a + c, 0) / grossLoss) : wins.length ? 99 : 0,
    maxDrawdownUsd: r2(maxDd),
    avgPositionUsd: r2(mean(trades.map((t) => t.costUsd))),
    avgHoldMinutes: r2(mean(trades.map((t) => t.holdMinutes))),
    bestTradeUsd: r2(best),
    worstTradeUsd: r2(n ? Math.min(...adj) : 0),
  };
}

export async function computeReadiness(opts: { uptimeSec?: number | null } = {}) {
  const R = READINESS_RULES;
  const settings = await settingsService.getSettings();
  const { trades, haircutPct, haircutSource } = await loadClosedTrades();
  const paper = trades.filter((t) => t.isPaper);
  const live = trades.filter((t) => !t.isPaper);
  const s = summarize(paper);
  const enough = s.trades >= R.minTrades;

  const firstAt = paper[0] ? new Date(paper[0].openedAt).getTime() : null;
  const days = firstAt ? (Date.now() - firstAt) / 86400000 : 0;

  const since7 = new Date(Date.now() - 7 * 86400000);
  const since14 = new Date(Date.now() - 14 * 86400000);
  const [sellFailures, breakerLogs, qualifiedWhales] = await Promise.all([
    prisma.auditLog.count({ where: { action: 'SELL_FAILED', createdAt: { gte: since7 } } }),
    prisma.auditLog.findMany({ where: { action: 'CIRCUIT_BREAKER_TRIPPED', createdAt: { gte: since14 } }, select: { createdAt: true } }),
    prisma.watchedWallet.count({ where: { profileStatus: 'qualified', isActive: true } }),
  ]);
  const breakerDays = new Set(breakerLogs.map((l) => l.createdAt.toISOString().slice(0, 10))).size;

  const stopLosses = paper.filter((t) => t.exitReason === 'stop_loss').length;
  const profitExits = paper.filter((t) => t.adjPnlUsd > 0 && t.exitReason !== 'manual').length;

  // Higher score should mean better outcome
  let scoreCheck: { status: CheckStatus; value: string } = { status: 'pending', value: `${paper.filter((t) => t.score != null).length}/${R.minTradesForScoreCheck} scored trades` };
  const scored = paper.filter((t) => t.score != null).sort((a, b) => a.score! - b.score!);
  if (scored.length >= R.minTradesForScoreCheck) {
    const half = Math.floor(scored.length / 2);
    const lo = mean(scored.slice(0, half).map((t) => t.adjPnlPct));
    const hi = mean(scored.slice(half).map((t) => t.adjPnlPct));
    scoreCheck = { status: hi >= lo ? 'pass' : 'fail', value: `top half ${hi.toFixed(1)}% vs bottom half ${lo.toFixed(1)}%` };
  }

  const tgOk = /^\d+:[\w-]{20,}$/.test((settings.telegramBotToken || process.env.TELEGRAM_BOT_TOKEN || '').trim()) &&
    /^-?\d+$|^@\w+$/.test((settings.telegramChatId || process.env.TELEGRAM_CHAT_ID || '').trim());
  // CLI runs in its own process: it passes the service's uptime (null = bot not running)
  const uptimeDays = opts.uptimeSec !== undefined ? (opts.uptimeSec ?? 0) / 86400 : (Date.now() - systemStatus.startedAt) / 86400000;
  const botDown = opts.uptimeSec === null;
  const ddLimit = s.avgPositionUsd * R.maxDrawdownPositions;
  const sample = (ok: boolean): CheckStatus => (enough ? (ok ? 'pass' : 'fail') : 'pending');

  const checks: ReadinessCheck[] = [
    { id: 'trades', group: 'data', label: 'Closed paper trades', status: enough ? 'pass' : 'pending',
      value: String(s.trades), target: `≥ ${R.minTrades}`, help: 'Below ~30 trades, results are mostly luck.' },
    { id: 'days', group: 'data', label: 'Observation period', status: days >= R.minDays ? 'pass' : 'pending',
      value: `${days.toFixed(1)} days`, target: `≥ ${R.minDays} days`, help: 'Covers more than one kind of market (pump, quiet, dump).' },
    { id: 'whales', group: 'data', label: 'Qualified whales active', status: qualifiedWhales >= R.minQualifiedWhales ? 'pass' : 'pending',
      value: String(qualifiedWhales), target: `≥ ${R.minQualifiedWhales}`, help: 'More sources = less dependence on one wallet.' },
    { id: 'expectancy', group: 'edge', label: 'Avg PnL per trade after costs', status: sample(s.expectancyAdjPct > 0),
      value: `${s.expectancyAdjPct.toFixed(2)}% (raw ${s.expectancyRawPct.toFixed(2)}%)`, target: '> 0%', help: `Paper haircut ${haircutPct}%: ${haircutSource}.` },
    { id: 'without_best', group: 'edge', label: 'Profit without the best trade', status: sample(s.adjTotalWithoutBestUsd > 0),
      value: `$${s.adjTotalWithoutBestUsd.toFixed(2)}`, target: '> $0', help: 'If one lucky trade carries everything, the edge is not real.' },
    { id: 'profit_factor', group: 'edge', label: 'Profit factor (after costs)', status: sample(s.profitFactor >= R.minProfitFactor),
      value: s.profitFactor.toFixed(2), target: `≥ ${R.minProfitFactor}`, help: 'Gross wins ÷ gross losses. Thin margins disappear in live trading.' },
    { id: 'score', group: 'edge', label: 'Score predicts outcome', status: scoreCheck.status,
      value: scoreCheck.value, target: 'top half ≥ bottom half', help: 'If high scores do no better, the filter is not working.' },
    { id: 'drawdown', group: 'risk', label: 'Max drawdown', status: sample(s.maxDrawdownUsd <= ddLimit),
      value: `$${s.maxDrawdownUsd.toFixed(2)}`, target: `≤ $${ddLimit.toFixed(2)} (${R.maxDrawdownPositions}× position)`, help: 'Worst peak-to-trough on the cost-adjusted equity curve.' },
    { id: 'breaker', group: 'risk', label: 'Circuit-breaker days (14d)', status: breakerDays <= R.maxBreakerDays ? 'pass' : 'fail',
      value: String(breakerDays), target: `≤ ${R.maxBreakerDays}`, help: 'Frequent trips = signals or stop-loss need tuning.' },
    { id: 'exits', group: 'risk', label: 'Exit paths exercised', status: stopLosses > 0 && profitExits > 0 ? 'pass' : 'pending',
      value: `${stopLosses} stop-loss · ${profitExits} profitable exits`, target: '≥ 1 each', help: 'Both the loss and profit exits must have run for real.' },
    { id: 'sell_failures', group: 'ops', label: 'Failed sells (7d)', status: sellFailures === 0 ? 'pass' : 'fail',
      value: String(sellFailures), target: '0', help: 'A failed sell means a position could not be exited.' },
    { id: 'uptime', group: 'ops', label: 'Continuous uptime', status: botDown ? 'fail' : uptimeDays >= R.minUptimeDays ? 'pass' : 'pending',
      value: botDown ? 'bot not running' : `${uptimeDays.toFixed(1)} days`, target: `≥ ${R.minUptimeDays} days`, help: 'Process uptime since last restart.' },
    { id: 'telegram', group: 'ops', label: 'Telegram notifications', status: tgOk ? 'pass' : 'fail',
      value: tgOk ? 'configured' : 'not configured', target: 'configured', help: 'You must hear about every automatic buy/sell.' },
    { id: 'backup', group: 'ops', label: 'master.key backed up & wallet export tested', status: 'manual',
      value: 'confirm yourself', target: 'done', help: 'Without .secrets/master.key the trading wallet cannot be recovered.' },
  ];

  const auto = checks.filter((c) => c.status !== 'manual');
  const verdict = auto.some((c) => c.status === 'fail') ? 'not_ready' : auto.some((c) => c.status === 'pending') ? 'collecting' : 'ready_small';
  const tradeUsd = Math.min(10, settings.tradeAmountUsd);

  return {
    verdict,
    passed: auto.filter((c) => c.status === 'pass').length,
    total: auto.length,
    checks,
    haircutPct,
    haircutSource,
    paper: s,
    live: summarize(live),
    firstTradeAt: paper[0]?.openedAt ?? null,
    recommendedFirstLive: { tradeAmountUsd: tradeUsd, maxOpenPositions: 2, maxDailySpendUsd: tradeUsd * 3, durationDays: 14 },
    trades,
    uptimeDays,
    rpc: solanaRpcUrl.includes('helius') ? 'helius' : 'public',
  };
}

/** Self-contained snapshot for an external AI reviewer — no secrets, no wallet keys */
export async function buildReadinessReport(opts: { uptimeSec?: number | null } = {}) {
  const r = await computeReadiness(opts);
  const { mySolanaPrivateKey: _k, telegramBotToken: _t, telegramChatId: _c, mySolanaWallet: _w, ...settings } = await settingsService.getSettings();
  const since30 = new Date(Date.now() - 30 * 86400000);
  const [auditCounts, whales, signals30d] = await Promise.all([
    prisma.auditLog.groupBy({ by: ['action'], _count: { _all: true }, where: { createdAt: { gte: since30 } } }),
    prisma.watchedWallet.findMany({ where: { profileStatus: 'qualified' }, orderBy: { whaleScore: 'desc' }, take: 30 }),
    prisma.signal.groupBy({ by: ['status'], _count: { _all: true }, where: { createdAt: { gte: since30 } } }),
  ]);
  const exitReasons: Record<string, { count: number; avgAdjPnlPct: number }> = {};
  for (const t of r.trades.filter((x) => x.isPaper)) {
    const e = (exitReasons[t.exitReason] ||= { count: 0, avgAdjPnlPct: 0 });
    e.avgAdjPnlPct = (e.avgAdjPnlPct * e.count + t.adjPnlPct) / (e.count + 1);
    e.count++;
  }

  return {
    app: 'Fins Trade',
    reportVersion: 1,
    generatedAt: new Date().toISOString(),
    howPaperFillsWork:
      'Paper BUY fills at the DexScreener USD price captured when the signal was scored; paper SELL fills at the DexScreener price seen by the 15s monitor. ' +
      'No slippage, swap fees, priority fees, failed transactions or latency are simulated. adj* fields subtract a haircut per trade to approximate those costs.',
    rules: READINESS_RULES,
    verdict: r.verdict,
    checks: r.checks,
    haircut: { pct: r.haircutPct, source: r.haircutSource },
    paperSummary: r.paper,
    liveSummary: r.live,
    exitReasons,
    settings,
    signalFunnel30d: Object.fromEntries(signals30d.map((g) => [g.status, g._count._all])),
    auditActions30d: Object.fromEntries(auditCounts.map((g) => [g.action, g._count._all])),
    qualifiedWhales: whales.map((w) => ({
      wallet: `${w.address.slice(0, 4)}…${w.address.slice(-4)}`,
      winRatePct: w.winRate,
      closedTrades: w.closedTrades,
      realizedPnlSol: w.realizedPnlSol,
      avgHoldMinutes: w.avgHoldMinutes,
      signalsTriggered: w.signalsTriggered,
    })),
    engines: {
      uptimeDays: r2(r.uptimeDays),
      rpc: r.rpc,
      scanner: { runs: systemStatus.scanner.runs, errors: systemStatus.scanner.errors },
      discovery: { runs: systemStatus.discovery.runs, errors: systemStatus.discovery.errors },
      monitor: { runs: systemStatus.monitor.runs, errors: systemStatus.monitor.errors },
    },
    recommendedFirstLive: r.recommendedFirstLive,
    trades: r.trades.slice(-500),
  };
}
