import { prisma } from '../db/prisma.js';
import { env } from '../config/index.js';
import { getRecentWalletTxs, getSolPriceUsd, NormalizedTx } from './solana.js';
import { settingsService } from './settings.js';
import { audit } from './audit.js';
import { logger } from './logger.js';

export interface WalletProfile {
  address: string;
  tradesAnalyzed: number;
  closedTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  realizedPnlSol: number;
  avgBuySol: number;
  avgHoldMinutes: number | null;
  isLikelyBot: boolean;
  qualified: boolean;
  reason: string;
  whaleScore: number;
}

const MIN_QUOTE_SOL = 0.01; // ignore fee-only / dust movements
const MIN_AVG_BUY_SOL = 0.3; // below this it's not a whale
const MIN_COPYABLE_HOLD_MIN = 2; // faster than this = sniper/MEV bot we can't follow in time

interface MintBook {
  boughtTokens: number;
  costSol: number;
  soldTokens: number;
  proceedsSol: number;
  firstBuyAt: number;
  lastSellAt: number;
}

/**
 * Rebuild realised meme-coin PnL from a wallet's recent swap history (FIFO-free
 * average-cost approach: realised = proceeds − cost × sold/bought).
 */
export function computeProfile(address: string, txs: NormalizedTx[], solPriceUsd: number, minWinRate: number, minClosed: number): WalletProfile {
  const books = new Map<string, MintBook>();
  const ordered = [...txs].filter((t) => !t.failed).sort((a, b) => a.timestamp - b.timestamp);
  let buyCount = 0;
  let buySolTotal = 0;

  for (const tx of ordered) {
    const quoteSol = tx.solDelta + (solPriceUsd > 0 ? tx.stableDelta / solPriceUsd : 0);
    if (Math.abs(quoteSol) < MIN_QUOTE_SOL) continue;

    const mints = Object.entries(tx.tokenDeltas).filter(([, v]) => v.delta !== 0);
    if (mints.length === 0) continue;
    // Attribute the quote movement to the dominant token leg of the swap
    const [mint, { delta }] = mints.sort((a, b) => Math.abs(b[1].delta) - Math.abs(a[1].delta))[0];
    const book = books.get(mint) || { boughtTokens: 0, costSol: 0, soldTokens: 0, proceedsSol: 0, firstBuyAt: 0, lastSellAt: 0 };

    if (delta > 0 && quoteSol < 0) {
      book.boughtTokens += delta;
      book.costSol += -quoteSol;
      if (!book.firstBuyAt) book.firstBuyAt = tx.timestamp;
      buyCount++;
      buySolTotal += -quoteSol;
    } else if (delta < 0 && quoteSol > 0) {
      book.soldTokens += -delta;
      book.proceedsSol += quoteSol;
      book.lastSellAt = tx.timestamp;
    } else {
      continue;
    }
    books.set(mint, book);
  }

  let wins = 0;
  let losses = 0;
  let realized = 0;
  const holds: number[] = [];

  for (const b of books.values()) {
    if (b.boughtTokens <= 0 || b.soldTokens < b.boughtTokens * 0.5) continue; // still mostly open → unrealised
    const soldFraction = Math.min(1, b.soldTokens / b.boughtTokens);
    const pnl = b.proceedsSol - b.costSol * soldFraction;
    realized += pnl;
    if (pnl > 0) wins++;
    else losses++;
    if (b.firstBuyAt && b.lastSellAt) holds.push((b.lastSellAt - b.firstBuyAt) / 60000);
  }

  const closed = wins + losses;
  const winRate = closed > 0 ? (wins / closed) * 100 : 0;
  const avgHold = holds.length ? holds.reduce((a, c) => a + c, 0) / holds.length : null;
  const avgBuySol = buyCount ? buySolTotal / buyCount : 0;

  const spanMs = ordered.length > 1 ? ordered[ordered.length - 1].timestamp - ordered[0].timestamp : Infinity;
  // Dozens of txs inside an hour = trading bot, exchange or custody hot wallet
  const isLikelyBot = (txs.length >= 40 && spanMs < 3600 * 1000) || (avgHold !== null && avgHold < MIN_COPYABLE_HOLD_MIN);

  let reason = 'qualified';
  if (isLikelyBot) reason = `bot/exchange-like activity (${txs.length} tx in ${(spanMs / 3600000).toFixed(1)}h, avg hold ${avgHold?.toFixed(1) ?? '-'}m)`;
  else if (closed < minClosed) reason = `not enough closed trades (${closed} < ${minClosed})`;
  else if (winRate < minWinRate) reason = `win rate too low (${winRate.toFixed(0)}% < ${minWinRate}%)`;
  else if (realized <= 0) reason = `negative realised PnL (${realized.toFixed(2)} SOL)`;
  else if (avgBuySol < MIN_AVG_BUY_SOL) reason = `buy size too small (avg ${avgBuySol.toFixed(2)} SOL)`;

  const qualified = reason === 'qualified';
  // 0–100: win rate dominates, PnL and sample size add confidence
  const whaleScore = Math.round(
    Math.min(100, winRate * 0.6 + Math.min(25, Math.max(0, realized) * 0.5) + Math.min(15, closed * 1.5))
  );

  return {
    address,
    tradesAnalyzed: txs.length,
    closedTrades: closed,
    wins,
    losses,
    winRate,
    realizedPnlSol: realized,
    avgBuySol,
    avgHoldMinutes: avgHold,
    isLikelyBot,
    qualified,
    reason,
    whaleScore,
  };
}

export class WalletProfilerService {
  async profileWallet(address: string, historyLimit = 100): Promise<WalletProfile> {
    const settings = await settingsService.getSettings();
    // Plain RPC needs one request per tx; keep the window smaller there
    const { txs } = await getRecentWalletTxs(address, { limit: env.HELIUS_API_KEY ? historyLimit : Math.min(historyLimit, 50) });
    const solPrice = await getSolPriceUsd();
    return computeProfile(address, txs, solPrice, settings.minWhaleWinRate, settings.minWhaleClosedTrades);
  }

  /**
   * Profile a wallet and persist the result. Auto-discovered wallets are activated
   * only if they qualify; manually added wallets keep the user's on/off choice.
   */
  async profileAndSave(address: string): Promise<WalletProfile> {
    const profile = await this.profileWallet(address);
    const existing = await prisma.watchedWallet.findUnique({ where: { address } });
    const isManual = existing?.discoveredVia === 'manual_dashboard' || existing?.discoveredVia === 'env_config';

    const data = {
      profileStatus: profile.qualified ? 'qualified' : 'rejected',
      profileReason: profile.reason,
      tradesAnalyzed: profile.tradesAnalyzed,
      closedTrades: profile.closedTrades,
      wins: profile.wins,
      losses: profile.losses,
      winRate: profile.winRate,
      realizedPnlSol: profile.realizedPnlSol,
      avgHoldMinutes: profile.avgHoldMinutes,
      whaleScore: profile.whaleScore,
      lastProfiledAt: new Date(),
      ...(isManual ? {} : { isActive: profile.qualified }),
    };

    if (existing) {
      await prisma.watchedWallet.update({ where: { address }, data });
      if (existing.isActive && !isManual && !profile.qualified) {
        await audit('WHALE_DEMOTED', `Wallet no longer qualifies: ${profile.reason}`, { address });
      }
    }

    if (profile.qualified && existing?.profileStatus !== 'qualified') {
      await audit('WHALE_QUALIFIED', `WR ${profile.winRate.toFixed(0)}% over ${profile.closedTrades} trades, PnL ${profile.realizedPnlSol.toFixed(2)} SOL`, { address });
    }

    logger.info(
      { address, qualified: profile.qualified, winRate: profile.winRate.toFixed(1), pnlSol: profile.realizedPnlSol.toFixed(2), reason: profile.reason },
      'Wallet profiled'
    );
    return profile;
  }
}

export const walletProfiler = new WalletProfilerService();
