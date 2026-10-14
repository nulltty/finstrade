import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { prisma } from '../db/prisma.js';
import { WSOL_MINT } from '../config/index.js';
import { circuitBreaker } from './circuitBreaker.js';
import { settingsService, BotSettingsData } from './settings.js';
import {
  getTradingKeypair,
  getSolBalance,
  getSolPriceUsd,
  getTokenBalance,
  getJupiterQuote,
  executeJupiterSwap,
  fetchNormalizedTx,
} from './solana.js';
import { audit } from './audit.js';
import { logger } from './logger.js';
import crypto from 'crypto';

export interface BuyResult {
  success: boolean;
  positionId?: string;
  txHash?: string;
  error?: string;
  isPaper?: boolean;
  amountUsd?: number;
}

export interface SellResult {
  success: boolean;
  exitPrice?: number;
  pnlPercent?: number;
  pnlUsd?: number;
  txHash?: string;
  error?: string;
}

export type ExitReason =
  | 'stop_loss'
  | 'trailing_stop'
  | 'take_profit_auto'
  | 'take_profit_approved'
  | 'take_profit_timeout'
  | 'whale_exit'
  | 'manual';

const FEE_BUFFER_SOL = 0.01; // ATA rent + priority fee headroom per swap
const MAX_SWAP_ATTEMPTS = 3; // a blockhash-expired swap is provably dead — safe to retry with a fresh one

/** Pulls the signature out of an AMBIGUOUS_SWAP error raised by executeJupiterSwap, if any */
function extractAmbiguousSig(err: any): string | null {
  const m = /AMBIGUOUS_SWAP (\S+):/.exec(err?.message || '');
  return m ? m[1] : null;
}

export class TradeExecutor {
  /** Paper unless explicitly live AND a key exists. Simulated signals are always paper. */
  private async isPaperFor(settings: BotSettingsData, txHash?: string) {
    if (settings.paperTrading) return true;
    if (txHash?.startsWith('sim_tx_')) return true;
    return !(await getTradingKeypair());
  }

  /** Risk gates that apply before every BUY, auto or approved */
  async preBuyChecks(tokenAddress: string, settings: BotSettingsData): Promise<string | null> {
    const cb = await circuitBreaker.canExecuteBuy();
    if (!cb.allowed) return cb.reason || 'circuit breaker';

    const open = await prisma.position.count({ where: { status: { in: ['open', 'closing'] } } });
    if (open >= settings.maxOpenPositions) return `max open positions reached (${open}/${settings.maxOpenPositions})`;

    const dup = await prisma.position.findFirst({ where: { tokenAddress, status: { in: ['open', 'closing'] } } });
    if (dup) return 'already holding this token';

    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const spent = await prisma.trade.aggregate({ _sum: { totalUsd: true }, where: { side: 'BUY', createdAt: { gte: since } } });
    if ((spent._sum.totalUsd || 0) + settings.tradeAmountUsd > settings.maxDailySpendUsd) {
      return `daily spend cap reached ($${(spent._sum.totalUsd || 0).toFixed(0)} / $${settings.maxDailySpendUsd})`;
    }
    return null;
  }

  /** USD size for the next position, honouring balance and SOL reserve in live mode */
  async resolvePositionSizeUsd(settings: BotSettingsData, isPaper: boolean): Promise<{ usd: number; error?: string }> {
    if (isPaper && settings.positionSizeMode !== 'percent_balance') return { usd: settings.tradeAmountUsd };

    const kp = await getTradingKeypair();
    const solPrice = await getSolPriceUsd();
    const balance = kp ? await getSolBalance(kp.publicKey.toBase58()) : null;
    if (balance === null || solPrice <= 0) {
      return isPaper ? { usd: settings.tradeAmountUsd } : { usd: 0, error: 'cannot read wallet balance / SOL price' };
    }

    const spendableSol = Math.max(0, balance - settings.solReserve - FEE_BUFFER_SOL);
    let usd = settings.positionSizeMode === 'percent_balance'
      ? (balance * solPrice * settings.positionSizePercent) / 100
      : settings.tradeAmountUsd;
    usd = Math.min(usd, spendableSol * solPrice);

    if (!isPaper && usd < 1) {
      return { usd: 0, error: `insufficient balance (${balance.toFixed(4)} SOL, reserve ${settings.solReserve} SOL)` };
    }
    return { usd: usd > 0 ? usd : settings.tradeAmountUsd };
  }

  /**
   * Execute BUY swap for an approved signal
   */
  async executeBuy(signalId: string): Promise<BuyResult> {
    const signal = await prisma.signal.findUnique({ where: { id: signalId } });
    if (!signal) {
      return { success: false, error: `Signal ${signalId} not found` };
    }

    const settings = await settingsService.getSettings();
    const blocked = await this.preBuyChecks(signal.tokenAddress, settings);
    if (blocked) {
      logger.warn({ signalId, reason: blocked }, 'BUY blocked by risk gate');
      await prisma.signal.update({ where: { id: signalId }, data: { status: 'failed', decision: `rejected:${blocked}` } });
      await audit('BUY_BLOCKED', blocked, { signalId, token: signal.tokenAddress });
      return { success: false, error: blocked };
    }

    await prisma.signal.update({
      where: { id: signalId },
      data: { status: 'executing_buy' },
    });

    try {
      const isPaper = await this.isPaperFor(settings, signal.txHash);
      const size = await this.resolvePositionSizeUsd(settings, isPaper);
      if (size.error) throw new Error(size.error);

      const rawMetrics = (signal.rawMetrics as any) || {};
      const solPrice = await getSolPriceUsd();
      let entryPrice: number;
      let tokenAmount: number;
      let rawAmount: string | null = null;
      let decimals: number | null = null;
      let costSol = solPrice > 0 ? size.usd / solPrice : 0;
      let costUsd = size.usd;
      let txHash: string;

      if (isPaper) {
        entryPrice = rawMetrics.priceUsd > 0 ? rawMetrics.priceUsd : 0.001;
        tokenAmount = size.usd / entryPrice;
        txHash = `paper_buy_${crypto.randomBytes(16).toString('hex')}`;
      } else {
        const live = await this.liveBuy(signal.tokenAddress, size.usd, settings);
        ({ txHash, tokenAmount, rawAmount, decimals, costSol } = live);
        costUsd = costSol * solPrice;
        entryPrice = costUsd / tokenAmount;
      }

      const position = await prisma.position.create({
        data: {
          signalId: signal.id,
          chain: signal.chain,
          tokenAddress: signal.tokenAddress,
          tokenSymbol: signal.tokenSymbol || 'TOKEN',
          entryPrice,
          entryAmount: tokenAmount,
          entryRawAmount: rawAmount,
          tokenDecimals: decimals,
          costUsd,
          costSol,
          currentPrice: entryPrice,
          peakPrice: entryPrice,
          pnlPercent: 0,
          highestPnlPercent: 0,
          nextTpThreshold: settings.takeProfitPercent,
          whaleWallet: signal.wallet,
          isPaper,
          status: 'open',
        },
      });

      await prisma.trade.create({
        data: {
          positionId: position.id,
          signalId: signal.id,
          side: 'BUY',
          chain: signal.chain,
          tokenAddress: signal.tokenAddress,
          price: entryPrice,
          amount: tokenAmount,
          totalUsd: costUsd,
          solAmount: costSol,
          txHash,
          status: 'confirmed',
          slippageBps: settings.slippageBps,
          priorityFee: settings.maxPriorityFee,
          isPaper,
        },
      });

      await prisma.signal.update({ where: { id: signalId }, data: { status: 'bought' } });

      await audit('BUY_FILLED', `Position opened via ${isPaper ? 'Paper' : 'Live'} order`, {
        positionId: position.id,
        signalId,
        txHash,
        costUsd,
        costSol,
        price: entryPrice,
      });

      return { success: true, positionId: position.id, txHash, isPaper, amountUsd: costUsd };
    } catch (err: any) {
      logger.error({ signalId, err: err?.message }, 'Failed to execute BUY');
      await prisma.signal.update({ where: { id: signalId }, data: { status: 'failed', decision: `rejected:${err?.message}` } });
      await audit('BUY_FAILED', err?.message || 'unknown error', { signalId });
      return { success: false, error: err?.message };
    }
  }

  /**
   * Execute SELL swap for an open position. Claims the position first ('closing')
   * so concurrent triggers (SL, TP timeout, whale exit) can never double-sell.
   */
  async executeSell(positionId: string, reason: ExitReason, customExitPrice?: number): Promise<SellResult> {
    const claim = await prisma.position.updateMany({
      where: { id: positionId, status: 'open' },
      data: { status: 'closing' },
    });
    if (claim.count === 0) {
      return { success: false, error: `Position ${positionId} not found or not open` };
    }
    const position = (await prisma.position.findUnique({ where: { id: positionId } }))!;
    const settings = await settingsService.getSettings();

    try {
      let exitPrice = customExitPrice || position.currentPrice;
      let proceedsUsd = position.entryAmount * exitPrice;
      let solAmount: number | null = null;
      let txHash: string;

      if (position.isPaper) {
        txHash = `paper_sell_${crypto.randomBytes(16).toString('hex')}`;
      } else {
        const live = await this.liveSell(position.tokenAddress, settings);
        txHash = live.txHash;
        solAmount = live.solReceived;
        proceedsUsd = live.solReceived * (await getSolPriceUsd());
        if (live.tokensSold > 0) exitPrice = proceedsUsd / live.tokensSold;
      }

      const pnlPercent = position.costUsd > 0
        ? ((proceedsUsd - position.costUsd) / position.costUsd) * 100
        : ((exitPrice - position.entryPrice) / position.entryPrice) * 100;
      const pnlUsd = proceedsUsd - (position.costUsd || position.entryAmount * position.entryPrice);

      await prisma.trade.create({
        data: {
          positionId: position.id,
          signalId: position.signalId,
          side: 'SELL',
          chain: position.chain,
          tokenAddress: position.tokenAddress,
          price: exitPrice,
          amount: position.entryAmount,
          totalUsd: proceedsUsd,
          solAmount,
          txHash,
          status: 'confirmed',
          slippageBps: settings.slippageBps,
          priorityFee: settings.maxPriorityFee,
          isPaper: position.isPaper,
        },
      });

      await prisma.position.update({
        where: { id: positionId },
        data: {
          status: 'closed',
          exitPrice,
          currentPrice: exitPrice,
          pnlPercent,
          proceedsUsd,
          exitReason: reason,
          closedAt: new Date(),
        },
      });

      logger.info({ positionId, reason, exitPrice, pnlPercent: `${pnlPercent.toFixed(2)}%`, txHash }, 'Position closed via SELL');
      await audit('SELL_FILLED', `Position closed: ${reason}`, { positionId, exitPrice, pnlPercent, pnlUsd, txHash, proceedsUsd });

      const { telegramBot } = await import('../bot/telegram.js');
      await telegramBot.sendSellNotice(positionId, reason, pnlPercent, pnlUsd, txHash);

      return { success: true, exitPrice, pnlPercent, pnlUsd, txHash };
    } catch (err: any) {
      // Release the claim so the monitor retries on the next tick
      const updated = await prisma.position.update({
        where: { id: positionId },
        data: { status: 'open', sellFailCount: { increment: 1 } },
      });
      logger.error({ positionId, reason, err: err?.message, sellFailCount: updated.sellFailCount }, 'SELL failed — position re-opened for retry');
      await audit('SELL_FAILED', `${reason}: ${err?.message}`, { positionId });

      if (updated.sellFailCount === 3 || updated.sellFailCount % 10 === 0) {
        const { telegramBot } = await import('../bot/telegram.js');
        await telegramBot.sendSellStuckAlert(positionId, updated.sellFailCount, err?.message || 'unknown error');
      }

      return { success: false, error: err?.message };
    }
  }

  private async liveBuy(mint: string, amountUsd: number, settings: BotSettingsData) {
    const kp = await getTradingKeypair();
    if (!kp) throw new Error('No trading wallet key');
    const solPrice = await getSolPriceUsd();
    if (solPrice <= 0) throw new Error('SOL price unavailable');

    const owner = kp.publicKey.toBase58();
    const lamports = BigInt(Math.floor((amountUsd / solPrice) * LAMPORTS_PER_SOL));

    let lastErr: any;
    for (let attempt = 1; attempt <= MAX_SWAP_ATTEMPTS; attempt++) {
      const quote = await getJupiterQuote(WSOL_MINT, mint, lamports, settings.slippageBps);
      if (!quote) throw new Error('No Jupiter route for buy');
      const impact = Number(quote.priceImpactPct || 0) * 100;
      if (impact > settings.maxPriceImpactPct) throw new Error(`Price impact ${impact.toFixed(1)}% exceeds limit`);

      logger.info({ mint, attempt, lamports: lamports.toString(), outAmount: quote.outAmount }, 'Sending live Jupiter BUY');
      try {
        const txHash = await executeJupiterSwap(quote, kp, settings.maxPriorityFee);
        // Use the confirmed on-chain deltas rather than the quote
        const parsed = await fetchNormalizedTx(txHash, owner);
        const received = parsed?.tokenDeltas[mint];
        const balance = await getTokenBalance(owner, mint);
        const decimals = received?.decimals ?? balance.decimals;
        const tokenAmount = received?.delta && received.delta > 0 ? received.delta : Number(quote.outAmount) / 10 ** decimals;
        const costSol = parsed ? Math.max(0, -parsed.solDelta) : Number(lamports) / LAMPORTS_PER_SOL;
        return { txHash, tokenAmount, rawAmount: balance.raw.toString(), decimals, costSol };
      } catch (err: any) {
        const sig = extractAmbiguousSig(err);
        if (sig) {
          // Confirmation was ambiguous — check the wallet directly before deciding.
          const balance = await getTokenBalance(owner, mint);
          if (balance.raw > 0n) {
            // Tokens actually arrived — recover the position instead of discarding it.
            logger.warn({ mint, sig }, 'BUY landed on-chain despite confirmation timeout — recovering position from wallet balance');
            const parsed = await fetchNormalizedTx(sig, owner).catch(() => null);
            const costSol = parsed ? Math.max(0, -parsed.solDelta) : Number(lamports) / LAMPORTS_PER_SOL;
            return { txHash: sig, tokenAmount: balance.ui, rawAmount: balance.raw.toString(), decimals: balance.decimals, costSol };
          }
          // Nothing arrived. The original tx referenced a now-expired blockhash, which
          // Solana guarantees can never be processed later — it is provably dead, so a
          // fresh attempt carries zero risk of double-spending the same buy.
          logger.warn({ mint, sig, attempt }, 'BUY confirmed dead on-chain (blockhash expired, no tokens received) — retrying with a fresh quote');
        } else if (/failed on-chain/i.test(err?.message || '')) {
          // Definite on-chain rejection before any funds moved — also safe to retry.
          logger.warn({ mint, attempt, err: err.message }, 'BUY failed on-chain — retrying with a fresh quote');
        } else {
          throw err; // no key, no route, price impact, RPC down, etc. — don't retry
        }
        lastErr = err;
      }
    }
    throw lastErr;
  }

  private async liveSell(mint: string, settings: BotSettingsData) {
    const kp = await getTradingKeypair();
    if (!kp) throw new Error('No trading wallet key');
    const owner = kp.publicKey.toBase58();

    const balance = await getTokenBalance(owner, mint);
    if (balance.raw <= 0n) throw new Error('Token balance is zero — nothing to sell');

    // Slippage widens on exits: getting out matters more than the last few %
    const slippage = Math.min(5000, settings.slippageBps * 2);

    let lastErr: any;
    for (let attempt = 1; attempt <= MAX_SWAP_ATTEMPTS; attempt++) {
      const quote = await getJupiterQuote(mint, WSOL_MINT, balance.raw, slippage);
      if (!quote) throw new Error('No Jupiter route for sell');

      logger.info({ mint, attempt, amount: balance.raw.toString(), outLamports: quote.outAmount }, 'Sending live Jupiter SELL');
      try {
        const txHash = await executeJupiterSwap(quote, kp, settings.maxPriorityFee);
        const parsed = await fetchNormalizedTx(txHash, owner);
        const solReceived = parsed ? Math.max(0, parsed.solDelta) : Number(quote.outAmount) / LAMPORTS_PER_SOL;
        return { txHash, solReceived, tokensSold: balance.ui };
      } catch (err: any) {
        const sig = extractAmbiguousSig(err);
        if (sig) {
          // Confirmation was ambiguous — check the wallet directly before deciding.
          const after = await getTokenBalance(owner, mint);
          if (after.raw <= 0n) {
            // Tokens are gone — the sell actually landed. Recover the proceeds instead
            // of treating it as a failure (which would risk firing a second sell).
            logger.warn({ mint, sig }, 'SELL landed on-chain despite confirmation timeout — recovering proceeds from wallet balance');
            const parsed = await fetchNormalizedTx(sig, owner);
            const solReceived = parsed ? Math.max(0, parsed.solDelta) : Number(quote.outAmount) / LAMPORTS_PER_SOL;
            return { txHash: sig, solReceived, tokensSold: balance.ui };
          }
          // Tokens are still here. The original tx referenced a now-expired blockhash,
          // which Solana guarantees can never be processed later — it's provably dead,
          // so retrying can't double-sell the same tokens.
          logger.warn({ mint, sig, attempt }, 'SELL confirmed dead on-chain (blockhash expired, tokens still held) — retrying with a fresh quote');
        } else if (/failed on-chain/i.test(err?.message || '')) {
          logger.warn({ mint, attempt, err: err.message }, 'SELL failed on-chain — retrying with a fresh quote');
        } else {
          throw err;
        }
        lastErr = err;
      }
    }
    throw lastErr;
  }
}

export const tradeExecutor = new TradeExecutor();
