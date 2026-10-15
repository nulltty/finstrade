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
  getMintDecimals,
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
  /** Only a slice of the position could be sold; the remainder is still held and tracked */
  partial?: boolean;
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
  | 'take_profit_usd'
  | 'take_profit_approved'
  | 'take_profit_timeout'
  | 'whale_exit'
  | 'liquidity_gone'
  | 'manual';

/**
 * How one strategy's entry differs from another's: size, exit targets and its own slot cap.
 * Derived from the signal's `source`, so every path into executeBuy (autopilot, Telegram
 * approval, cockpit approval) applies the same plan without having to pass it around.
 */
export interface EntryPlan {
  strategy: string;
  /** Fixed SOL per entry; null = use the global USD / %-of-balance sizing settings */
  sizeSol: number | null;
  /** Absolute-USD take profit (and the stretch target it may ride to) instead of a % ladder */
  tpUsdTarget: number | null;
  tpUsdStretch: number | null;
  slPercentOverride: number | null;
  trailPercentOverride: number | null;
  /** Slot cap counted against this strategy alone, on top of the global maxOpenPositions */
  maxOpenForStrategy: number | null;
  maxPriceImpactPct: number;
}

export function entryPlanFor(source: string | null | undefined, settings: BotSettingsData): EntryPlan {
  if (source === 'dip_reversal') {
    return {
      strategy: 'dip_reversal',
      sizeSol: settings.dipEntrySol,
      tpUsdTarget: settings.dipTakeProfitUsd,
      tpUsdStretch: Math.max(settings.dipTakeProfitMaxUsd, settings.dipTakeProfitUsd),
      slPercentOverride: settings.dipStopLossPercent,
      trailPercentOverride: settings.dipTrailingStopPercent,
      maxOpenForStrategy: settings.dipMaxOpenPositions,
      maxPriceImpactPct: settings.dipMaxPriceImpactPct,
    };
  }
  return {
    strategy: 'whale_copy',
    sizeSol: null,
    tpUsdTarget: null,
    tpUsdStretch: null,
    slPercentOverride: null,
    trailPercentOverride: null,
    maxOpenForStrategy: null,
    maxPriceImpactPct: settings.maxPriceImpactPct,
  };
}

const FEE_BUFFER_SOL = 0.01; // ATA rent + priority fee headroom per swap
const MAX_SWAP_ATTEMPTS = 3; // a blockhash-expired swap is provably dead — safe to retry with a fresh one

/**
 * A thin pool often cannot absorb a whole position at once. Walking the size down gets us
 * partially out instead of trapped at 100% while the price keeps falling.
 */
const SELL_SIZE_FALLBACKS = [1, 0.5, 0.25, 0.1];

const BASE_FEE_SOL = 0.000005; // signature fee
const ATA_RENT_SOL = 0.00203928; // rent for the token account a first buy has to create

/** Per-swap cost a paper fill must carry so its PnL is comparable to a live one */
export function swapCostSol(settings: BotSettingsData, opensAta: boolean) {
  return settings.maxPriorityFee + BASE_FEE_SOL + (opensAta ? ATA_RENT_SOL : 0);
}

/**
 * Live buys are serialised. Each one sizes itself against the wallet's SOL balance, so two
 * running concurrently would both claim the same lamports and the loser's transfer fails
 * on-chain with "insufficient lamports". The lock makes every buy see the balance the
 * previous one actually left behind.
 */
let liveBuyLock: Promise<unknown> = Promise.resolve();
function withLiveBuyLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = liveBuyLock.then(fn, fn);
  liveBuyLock = run.catch(() => undefined);
  return run;
}

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
  async preBuyChecks(tokenAddress: string, settings: BotSettingsData, plan?: EntryPlan): Promise<string | null> {
    const entry = plan || entryPlanFor('whale_copy', settings);
    const cb = await circuitBreaker.canExecuteBuy();
    if (!cb.allowed) return cb.reason || 'circuit breaker';

    const open = await prisma.position.count({ where: { status: { in: ['open', 'closing'] } } });
    if (open >= settings.maxOpenPositions) return `max open positions reached (${open}/${settings.maxOpenPositions})`;

    // A second strategy must not be able to fill every slot the first one needs, so each one
    // also carries its own cap.
    if (entry.maxOpenForStrategy != null) {
      const openForStrategy = await prisma.position.count({
        where: { status: { in: ['open', 'closing'] }, strategy: entry.strategy },
      });
      if (openForStrategy >= entry.maxOpenForStrategy) {
        return `max ${entry.strategy} positions reached (${openForStrategy}/${entry.maxOpenForStrategy})`;
      }
    }

    const dup = await prisma.position.findFirst({ where: { tokenAddress, status: { in: ['open', 'closing'] } } });
    if (dup) return 'already holding this token';

    const since = new Date(Date.now() - 24 * 3600 * 1000);
    // Paper fills spend nothing, so they must not consume a cap that exists to bound real money
    const spent = await prisma.trade.aggregate({
      _sum: { totalUsd: true },
      where: { side: 'BUY', isPaper: false, createdAt: { gte: since } },
    });
    const plannedUsd = await this.plannedSpendUsd(settings, entry);
    if ((spent._sum.totalUsd || 0) + plannedUsd > settings.maxDailySpendUsd) {
      return `daily spend cap reached ($${(spent._sum.totalUsd || 0).toFixed(0)} / $${settings.maxDailySpendUsd})`;
    }
    return null;
  }

  /** What this entry is expected to cost in USD, for the 24h spend cap */
  private async plannedSpendUsd(settings: BotSettingsData, plan: EntryPlan): Promise<number> {
    if (plan.sizeSol == null) return settings.tradeAmountUsd;
    const solPrice = await getSolPriceUsd();
    return solPrice > 0 ? plan.sizeSol * solPrice : settings.tradeAmountUsd;
  }

  /**
   * Size for the next position, in lamports (what the swap actually sends) and USD (what the
   * caps and the record are denominated in), honouring balance and SOL reserve in live mode.
   */
  async resolveEntrySize(
    settings: BotSettingsData,
    isPaper: boolean,
    plan: EntryPlan
  ): Promise<{ lamports: bigint; usd: number; error?: string }> {
    const solPrice = await getSolPriceUsd();
    if (solPrice <= 0) return { lamports: 0n, usd: 0, error: 'SOL price unavailable' };
    const fail = (error: string) => ({ lamports: 0n, usd: 0, error });
    const sized = (sol: number) => ({ lamports: BigInt(Math.floor(sol * LAMPORTS_PER_SOL)), usd: sol * solPrice });
    const walletBalance = async () => {
      const kp = await getTradingKeypair();
      return kp ? getSolBalance(kp.publicKey.toBase58()) : null;
    };

    // A fixed-SOL entry is never silently shrunk: its USD profit target is sized against the
    // full entry, so a smaller fill would be chasing a target it can no longer reach.
    if (plan.sizeSol != null) {
      if (!(plan.sizeSol > 0)) return fail('entry size must be greater than 0 SOL');
      if (isPaper) return sized(plan.sizeSol);
      const balance = await walletBalance();
      if (balance === null) return fail('cannot read wallet balance');
      const spendable = balance - settings.solReserve - FEE_BUFFER_SOL;
      if (spendable < plan.sizeSol) {
        return fail(
          `insufficient balance for a ${plan.sizeSol} SOL entry (${balance.toFixed(4)} SOL, reserve ${settings.solReserve} SOL)`
        );
      }
      return sized(plan.sizeSol);
    }

    if (isPaper && settings.positionSizeMode !== 'percent_balance') return sized(settings.tradeAmountUsd / solPrice);

    const balance = await walletBalance();
    if (balance === null) {
      return isPaper ? sized(settings.tradeAmountUsd / solPrice) : fail('cannot read wallet balance / SOL price');
    }

    const spendableSol = Math.max(0, balance - settings.solReserve - FEE_BUFFER_SOL);
    let sol = settings.positionSizeMode === 'percent_balance'
      ? (balance * settings.positionSizePercent) / 100
      : settings.tradeAmountUsd / solPrice;
    sol = Math.min(sol, spendableSol);

    if (!isPaper && sol * solPrice < 1) {
      return fail(`insufficient balance (${balance.toFixed(4)} SOL, reserve ${settings.solReserve} SOL)`);
    }
    return sized(sol > 0 ? sol : settings.tradeAmountUsd / solPrice);
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
    const plan = entryPlanFor(signal.source, settings);
    const blocked = await this.preBuyChecks(signal.tokenAddress, settings, plan);
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
      const solPrice = await getSolPriceUsd();
      let entryPrice: number;
      let tokenAmount: number;
      let rawAmount: string | null = null;
      let decimals: number | null = null;
      let costSol: number;
      let costUsd: number;
      let txHash: string;

      if (isPaper) {
        const size = await this.resolveEntrySize(settings, true, plan);
        if (size.error) throw new Error(size.error);
        if (solPrice <= 0) throw new Error('SOL price unavailable');
        const paper = await this.paperBuy(signal.tokenAddress, size.lamports, settings, solPrice, plan);
        ({ txHash, tokenAmount, rawAmount, decimals, costSol, costUsd, entryPrice } = paper);
      } else {
        // Size and swap under one lock so the balance read can't go stale in between
        const live = await withLiveBuyLock(async () => {
          const size = await this.resolveEntrySize(settings, false, plan);
          if (size.error) throw new Error(size.error);
          return this.liveBuy(signal.tokenAddress, size.lamports, settings, plan);
        });
        ({ txHash, tokenAmount, rawAmount, decimals, costSol } = live);
        costUsd = costSol * solPrice;
        entryPrice = costUsd / tokenAmount;
      }

      const position = await prisma.position.create({
        data: {
          signalId: signal.id,
          strategy: plan.strategy,
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
          tpUsdTarget: plan.tpUsdTarget,
          tpUsdStretch: plan.tpUsdStretch,
          slPercentOverride: plan.slPercentOverride,
          trailPercentOverride: plan.trailPercentOverride,
          // Only a copy-trade has a whale behind it; for a scanner signal the field would
          // otherwise point at a pseudo-wallet that no profiler can ever explain.
          whaleWallet: plan.strategy === 'whale_copy' ? signal.wallet : null,
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

      await audit('BUY_FILLED', `Position opened via ${isPaper ? 'Paper' : 'Live'} order (${plan.strategy})`, {
        positionId: position.id,
        signalId,
        strategy: plan.strategy,
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
      let tokensSold = position.entryAmount;
      let remainingRaw = 0n;

      // Paper and live take the same quote-driven path; only the signed swap differs
      const fill = position.isPaper
        ? await this.paperSell(position, settings)
        : await this.liveSell(position.tokenAddress, settings);

      txHash = fill.txHash;
      solAmount = fill.solReceived;
      proceedsUsd = fill.solReceived * (await getSolPriceUsd());
      tokensSold = fill.tokensSold;
      remainingRaw = fill.remainingRaw;
      if (fill.tokensSold > 0) exitPrice = proceedsUsd / fill.tokensSold;

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
          amount: tokensSold,
          totalUsd: proceedsUsd,
          solAmount,
          txHash,
          status: 'confirmed',
          slippageBps: settings.slippageBps,
          priorityFee: settings.maxPriorityFee,
          isPaper: position.isPaper,
        },
      });

      if (remainingRaw > 0n) {
        // Only a slice fit through the pool. Keep the position open for the remainder so the
        // tokens stay tracked and the next trigger tries again, with the cost basis reduced
        // by the fraction we did get out of.
        const soldFraction = position.entryAmount > 0 ? Math.min(1, tokensSold / position.entryAmount) : 0;
        const updated = await prisma.position.update({
          where: { id: positionId },
          data: {
            status: 'open',
            entryAmount: Math.max(0, position.entryAmount - tokensSold),
            entryRawAmount: remainingRaw.toString(),
            costUsd: position.costUsd * (1 - soldFraction),
            proceedsUsd: (position.proceedsUsd || 0) + proceedsUsd,
            sellFailCount: { increment: 1 },
          },
        });
        const pct = (soldFraction * 100).toFixed(0);
        logger.warn({ positionId, reason, soldPct: pct, remaining: remainingRaw.toString() }, 'Partial exit — remainder still held, retrying on next trigger');
        await audit('SELL_PARTIAL', `${reason}: sold ${pct}%, remainder still held`, { positionId, proceedsUsd, txHash });

        if (updated.sellFailCount === 3 || updated.sellFailCount % 10 === 0) {
          const { telegramBot } = await import('../bot/telegram.js');
          await telegramBot.sendSellStuckAlert(positionId, updated.sellFailCount, `pool hanya menyerap ${pct}% per percobaan`);
        }
        return { success: false, partial: true, error: `partial exit: ${pct}% sold, remainder still held`, txHash };
      }

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

  /**
   * A paper buy priced off a real Jupiter quote: the route, the price impact and the fees are
   * the ones a live order would have met, and it refuses on the same gates. Only the signed
   * transaction is skipped, so paper results stay comparable to live instead of flattering it.
   */
  private async paperBuy(mint: string, lamports: bigint, settings: BotSettingsData, solPrice: number, plan: EntryPlan) {
    const quote = await getJupiterQuote(WSOL_MINT, mint, lamports, settings.slippageBps);
    if (!quote) throw new Error('No Jupiter route for buy');
    const impact = Number(quote.priceImpactPct || 0) * 100;
    if (impact > plan.maxPriceImpactPct) throw new Error(`Price impact ${impact.toFixed(1)}% exceeds limit`);

    const decimals = await getMintDecimals(mint);
    if (decimals === null) throw new Error('Cannot read token decimals');
    const tokenAmount = Number(quote.outAmount) / 10 ** decimals;
    if (!(tokenAmount > 0)) throw new Error('Quote returned no tokens');

    const costSol = Number(lamports) / LAMPORTS_PER_SOL + swapCostSol(settings, true);
    const costUsd = costSol * solPrice;
    return {
      txHash: `paper_buy_${crypto.randomBytes(16).toString('hex')}`,
      tokenAmount,
      rawAmount: String(quote.outAmount),
      decimals,
      costSol,
      costUsd,
      entryPrice: costUsd / tokenAmount,
    };
  }

  /** Paper exit priced off a real quote, thin-pool size fallback and fees included */
  private async paperSell(
    position: { tokenAddress: string; entryAmount: number; entryRawAmount: string | null; tokenDecimals: number | null },
    settings: BotSettingsData
  ) {
    const mint = position.tokenAddress;
    const decimals = position.tokenDecimals ?? (await getMintDecimals(mint));
    if (decimals === null) throw new Error('Cannot read token decimals');

    const raw = position.entryRawAmount
      ? BigInt(position.entryRawAmount)
      : BigInt(Math.floor(position.entryAmount * 10 ** decimals));
    if (raw <= 0n) throw new Error('Token balance is zero — nothing to sell');

    const sized = await this.quoteSell(mint, raw, Math.min(5000, settings.slippageBps * 2));
    if (!sized) {
      throw new Error(`No Jupiter route for sell (tried ${SELL_SIZE_FALLBACKS.map((f) => f * 100 + '%').join('/')})`);
    }
    const { quote, amount } = sized;
    const solReceived = Math.max(0, Number(quote.outAmount) / LAMPORTS_PER_SOL - swapCostSol(settings, false));
    return {
      txHash: `paper_sell_${crypto.randomBytes(16).toString('hex')}`,
      solReceived,
      tokensSold: Number(amount) / 10 ** decimals,
      remainingRaw: raw - amount,
    };
  }

  private async liveBuy(mint: string, lamports: bigint, settings: BotSettingsData, plan: EntryPlan) {
    const kp = await getTradingKeypair();
    if (!kp) throw new Error('No trading wallet key');
    const owner = kp.publicKey.toBase58();

    let lastErr: any;
    for (let attempt = 1; attempt <= MAX_SWAP_ATTEMPTS; attempt++) {
      const quote = await getJupiterQuote(WSOL_MINT, mint, lamports, settings.slippageBps);
      if (!quote) throw new Error('No Jupiter route for buy');
      const impact = Number(quote.priceImpactPct || 0) * 100;
      if (impact > plan.maxPriceImpactPct) throw new Error(`Price impact ${impact.toFixed(1)}% exceeds limit`);

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

  /** First sellable slice of `raw`, trying progressively smaller fractions */
  private async quoteSell(mint: string, raw: bigint, slippage: number) {
    for (const frac of SELL_SIZE_FALLBACKS) {
      const amount = frac === 1 ? raw : (raw * BigInt(Math.round(frac * 100))) / 100n;
      if (amount <= 0n) continue;
      const quote = await getJupiterQuote(mint, WSOL_MINT, amount, slippage);
      if (quote) return { quote, amount, frac };
    }
    return null;
  }

  private async liveSell(mint: string, settings: BotSettingsData) {
    const kp = await getTradingKeypair();
    if (!kp) throw new Error('No trading wallet key');
    const owner = kp.publicKey.toBase58();

    const balance = await getTokenBalance(owner, mint);
    if (balance.raw <= 0n) throw new Error('Token balance is zero — nothing to sell');

    // Slippage widens on exits: getting out matters more than the last few %
    const slippage = Math.min(5000, settings.slippageBps * 2);
    const toUi = (raw: bigint) => Number(raw) / 10 ** balance.decimals;

    let lastErr: any;
    for (let attempt = 1; attempt <= MAX_SWAP_ATTEMPTS; attempt++) {
      const sized = await this.quoteSell(mint, balance.raw, slippage);
      if (!sized) {
        throw new Error(`No Jupiter route for sell (tried ${SELL_SIZE_FALLBACKS.map((f) => f * 100 + '%').join('/')})`);
      }
      const { quote, amount, frac } = sized;
      if (frac < 1) {
        logger.warn({ mint, frac, amount: amount.toString() }, 'Pool cannot absorb the whole position — selling a slice');
      }

      logger.info({ mint, attempt, amount: amount.toString(), frac, outLamports: quote.outAmount }, 'Sending live Jupiter SELL');
      try {
        const txHash = await executeJupiterSwap(quote, kp, settings.maxPriorityFee);
        const parsed = await fetchNormalizedTx(txHash, owner);
        const solReceived = parsed ? Math.max(0, parsed.solDelta) : Number(quote.outAmount) / LAMPORTS_PER_SOL;
        return { txHash, solReceived, tokensSold: toUi(amount), remainingRaw: balance.raw - amount };
      } catch (err: any) {
        const sig = extractAmbiguousSig(err);
        if (sig) {
          // Confirmation was ambiguous — check the wallet directly before deciding.
          const after = await getTokenBalance(owner, mint);
          if (after.raw < balance.raw) {
            // Balance dropped — the sell landed (possibly only a slice). Recover the proceeds
            // instead of treating it as a failure, which would risk firing a second sell.
            const sold = balance.raw - after.raw;
            logger.warn({ mint, sig, sold: sold.toString() }, 'SELL landed on-chain despite confirmation timeout — recovering proceeds from wallet balance');
            const parsed = await fetchNormalizedTx(sig, owner);
            const solReceived = parsed ? Math.max(0, parsed.solDelta) : Number(quote.outAmount) / LAMPORTS_PER_SOL;
            return { txHash: sig, solReceived, tokensSold: toUi(sold), remainingRaw: after.raw };
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
