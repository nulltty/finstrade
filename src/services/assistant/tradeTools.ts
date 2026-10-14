import { prisma } from '../../db/prisma.js';
import { settingsService } from '../settings.js';
import { circuitBreaker } from '../circuitBreaker.js';
import { getApiHealthSummary } from '../apiHealth.js';
import { getTradingKeypair, getSolBalance, getSolPriceUsd, getUsdToIdrRate } from '../solana.js';
import { multiWalletScannerQueue, whaleDiscoveryQueue } from '../../workers/queue.js';

// Query/control tools exposed to the AI agent. Deliberately excludes anything that moves
// money directly (buy/sell/close position) — those stay on the existing Telegram
// approve/skip button + auto-trade flow, which is already live-tested and safe.

const idr = (n: number) => `Rp${Math.round(n).toLocaleString('id-ID')}`;
const usd = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: n < 1 ? 6 : 2 })}`;
const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export async function discoverWalletsNow(): Promise<string> {
  await whaleDiscoveryQueue.add('auto-discover-whales', {}, { jobId: `discover-agent-${Date.now()}` });
  return 'Oke, discovery whale baru sudah dijalankan di background. Hasilnya akan masuk ke daftar whale beberapa saat lagi.';
}

export async function scanWhalesNow(): Promise<string> {
  await multiWalletScannerQueue.add('scan-active-whales', {}, { jobId: `scan-agent-${Date.now()}` });
  return 'Oke, scan transaksi whale aktif sudah dijalankan di background.';
}

export async function listWhales(args: { activeOnly?: boolean; limit?: number } = {}): Promise<string> {
  const limit = Math.min(args.limit || 10, 30);
  const wallets = await prisma.watchedWallet.findMany({
    where: args.activeOnly === false ? {} : { isActive: true },
    orderBy: [{ whaleScore: 'desc' }, { createdAt: 'desc' }],
    take: limit,
  });
  if (!wallets.length) return 'Belum ada whale yang terdaftar/aktif saat ini.';
  return wallets
    .map((w, i) => {
      const wr = w.winRate != null ? `WR ${w.winRate.toFixed(0)}%` : 'WR -';
      const pnl = w.realizedPnlSol != null ? `PnL ${w.realizedPnlSol.toFixed(1)} SOL` : '';
      const status = w.isActive ? 'AKTIF' : w.profileStatus.toUpperCase();
      return `${i + 1}. ${shortAddr(w.address)} — ${status} · ${wr} ${pnl}`.trim();
    })
    .join('\n');
}

export async function getPositions(): Promise<string> {
  const open = await prisma.position.findMany({ where: { status: { in: ['open', 'closing'] } }, orderBy: { openedAt: 'desc' } });
  if (!open.length) return 'Tidak ada posisi terbuka saat ini.';
  return open
    .map((p) => {
      const pnlPct = p.entryPrice ? ((p.currentPrice - p.entryPrice) / p.entryPrice) * 100 : 0;
      return `${p.tokenSymbol}: entry ${usd(p.entryPrice)} → now ${usd(p.currentPrice)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)`;
    })
    .join('\n');
}

export async function getPnlSummary(): Promise<string> {
  const settings = await settingsService.getPublicSettings();
  const modeFilter = { isPaper: settings.paperTrading };
  const [open, closed] = await Promise.all([
    prisma.position.findMany({ where: { status: { in: ['open', 'closing'] }, ...modeFilter } }),
    prisma.position.findMany({ where: { status: 'closed', ...modeFilter } }),
  ]);
  const pnlUsdOf = (p: (typeof closed)[number]) =>
    (p.proceedsUsd ?? p.entryAmount * (p.exitPrice || 0)) - (p.costUsd || p.entryAmount * p.entryPrice);
  const realizedPnlUsd = closed.reduce((a, p) => a + pnlUsdOf(p), 0);
  const openValueUsd = open.reduce((a, p) => a + p.entryAmount * p.currentPrice, 0);
  const openCostUsd = open.reduce((a, p) => a + (p.costUsd || p.entryAmount * p.entryPrice), 0);
  const wins = closed.filter((p) => p.pnlPercent > 0).length;
  const winRate = closed.length ? (wins / closed.length) * 100 : 0;

  return (
    `Mode: ${settings.paperTrading ? 'PAPER' : 'LIVE'}\n` +
    `Realized PnL: ${usd(realizedPnlUsd)} (${closed.length} posisi closed, win rate ${winRate.toFixed(0)}%)\n` +
    `Unrealized PnL: ${usd(openValueUsd - openCostUsd)} (${open.length} posisi open)`
  );
}

export async function getBalance(): Promise<string> {
  const kp = await getTradingKeypair();
  if (!kp) return 'Wallet live belum di-setup (tidak ada private key). Saat ini mode paper trading.';
  const address = kp.publicKey.toBase58();
  const [sol, solPrice, idrRate] = await Promise.all([getSolBalance(address), getSolPriceUsd(), getUsdToIdrRate()]);
  if (sol === null) return 'Gagal baca saldo wallet dari RPC, coba lagi sebentar.';
  const usdValue = sol * solPrice;
  return `Wallet ${shortAddr(address)}: ${sol.toFixed(4)} SOL ≈ ${usd(usdValue)} ≈ ${idr(usdValue * idrRate)}`;
}

export async function getApiHealth(): Promise<string> {
  const summary = getApiHealthSummary();
  if (!summary.length) return 'Belum ada data 429/timeout tercatat — aman, belum ada tekanan ke API manapun.';
  const flagged = summary.filter((s) => s.upgradeSuggested);
  const lines = summary.map(
    (s) =>
      `${s.provider}: 429 ${s.rateLimited1h}/jam, timeout ${s.timeouts1h}/jam${s.upgradeSuggested ? ' ⚠️ SARAN UPGRADE' : ''}`
  );
  const verdict = flagged.length
    ? `\n\nSudah ada ${flagged.length} provider (${flagged.map((f) => f.provider).join(', ')}) yang kena tekanan — pertimbangkan upgrade plan untuk itu.`
    : '\n\nSemua provider masih aman, belum perlu upgrade.';
  return lines.join('\n') + verdict;
}

export async function haltBuys(args: { reason?: string } = {}): Promise<string> {
  circuitBreaker.trip(args.reason || 'Dihentikan manual via AI assistant');
  return '🛑 Buy baru dihentikan (circuit breaker tripped). Posisi yang sudah terbuka tetap dipantau seperti biasa.';
}

export async function resumeBuys(): Promise<string> {
  circuitBreaker.reset();
  return '✅ Buy baru diaktifkan lagi.';
}

export async function getBotSettings(): Promise<string> {
  const s = await settingsService.getPublicSettings();
  return (
    `Mode: ${s.paperTrading ? 'PAPER' : 'LIVE'} · ${s.autoTradeMode ? 'AUTO' : 'APPROVAL'}\n` +
    `Trade size: ${usd(s.tradeAmountUsd)} · Stop-loss: ${s.stopLossPercent}% · Take-profit: ${s.takeProfitPercent}% (step ${s.takeProfitStep}%)\n` +
    `Max open positions: ${s.maxOpenPositions} · Daily spend cap: ${usd(s.maxDailySpendUsd)}`
  );
}

export const TRADE_TOOL_SPECS = [
  {
    type: 'function' as const,
    function: {
      name: 'discover_wallets_now',
      description: 'Jalankan pencarian whale wallet baru sekarang (bukan menunggu jadwal otomatis)',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'scan_whales_now',
      description: 'Scan transaksi terbaru dari whale yang sudah aktif sekarang',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_whales',
      description: 'Lihat daftar whale wallet yang diikuti (aktif atau semua), beserta win rate & PnL',
      parameters: {
        type: 'object',
        properties: {
          activeOnly: { type: 'boolean', description: 'Default true — hanya whale yang sedang diikuti' },
          limit: { type: 'number' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_positions',
      description: 'Lihat posisi trading yang sedang terbuka saat ini',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_pnl_summary',
      description: 'Lihat ringkasan profit/loss trading (realized & unrealized)',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_balance',
      description: 'Lihat saldo wallet trading saat ini (SOL, USD, IDR)',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_api_health',
      description: 'Lihat status 429/timeout API provider dan apakah sudah waktunya upgrade plan',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'halt_buys',
      description: 'Hentikan sementara semua BUY baru (circuit breaker) — posisi yang sudah ada tetap dipantau',
      parameters: { type: 'object', properties: { reason: { type: 'string' } } },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'resume_buys',
      description: 'Aktifkan lagi BUY baru setelah dihentikan',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_bot_settings',
      description: 'Lihat setting bot trading saat ini (mode, trade size, stop-loss, take-profit, dll)',
      parameters: { type: 'object', properties: {} },
    },
  },
];

export const TRADE_TOOL_FUNCTIONS: Record<string, (args: any) => Promise<string>> = {
  discover_wallets_now: discoverWalletsNow,
  scan_whales_now: scanWhalesNow,
  list_whales: listWhales,
  get_positions: getPositions,
  get_pnl_summary: getPnlSummary,
  get_balance: getBalance,
  get_api_health: getApiHealth,
  halt_buys: haltBuys,
  resume_buys: resumeBuys,
  get_bot_settings: getBotSettings,
};
