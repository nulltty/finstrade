import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import type { Position } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { tokenDataAggregator } from './aggregator.js';
import { tradeExecutor, swapCostSol } from './executor.js';
import { telegramBot } from '../bot/telegram.js';
import { settingsService, BotSettingsData } from './settings.js';
import { getJupiterQuote, getSolPriceUsd } from './solana.js';
import { WSOL_MINT } from '../config/index.js';
import { audit } from './audit.js';
import { logger } from './logger.js';

const ROUTE_CHECK_INTERVAL_MS = 60_000;
const ROUTE_MISSES_BEFORE_EXIT = 2; // a single Jupiter blip must never liquidate the book

/**
 * Fraction of the USD target at which we stop trusting the mid price and start asking Jupiter
 * what the position would actually fetch. Below it the answer cannot change the decision.
 */
const TP_QUOTE_NEAR_FRACTION = 0.8;
/** Armed on the target, then faded this far back below it → bank what is left of the move */
const TP_GIVE_BACK_FRACTION = 0.85;

export class PositionMonitorService {
  /** Throttle + confirmation state for the exit-door watchdog, keyed by position id */
  private routeCheckedAt = new Map<string, number>();
  private routeMisses = new Map<string, number>();
  /**
   * Monitor all open positions and execute SL/TP logic
   */
  async checkOpenPositions() {
    const openPositions = await prisma.position.findMany({ where: { status: 'open' } });
    if (openPositions.length === 0) return { checked: 0 };

    const prices = await tokenDataAggregator.fetchPrices(
      [...new Set(openPositions.filter((p) => p.chain === 'solana').map((p) => p.tokenAddress))]
    );

    for (const pos of openPositions) {
      try {
        await this.evaluatePosition(pos.id, prices.get(pos.tokenAddress));
      } catch (err: any) {
        logger.error({ positionId: pos.id, err: err?.message }, 'Error checking position');
      }
    }
    return { checked: openPositions.length };
  }

  async evaluatePosition(positionId: string, customPrice?: number) {
    const pos = await prisma.position.findUnique({ where: { id: positionId } });
    if (!pos || pos.status !== 'open') return;

    let currentPrice = customPrice;
    if (!currentPrice) {
      const dexData = await tokenDataAggregator.fetchDexScreenerData(pos.tokenAddress, pos.chain);
      currentPrice = dexData.priceUsd > 0 ? dexData.priceUsd : pos.currentPrice;
    }

    const pnlPercent = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
    const highestPnl = Math.max(pos.highestPnlPercent, pnlPercent);
    const peakPrice = Math.max(pos.peakPrice || pos.entryPrice, currentPrice);

    await prisma.position.update({
      where: { id: pos.id },
      data: { currentPrice, pnlPercent, highestPnlPercent: highestPnl, peakPrice },
    });

    const settings = await settingsService.getSettings();
    // Each strategy carries its own exits; null means "use the global setting"
    const slPercent = pos.slPercentOverride ?? settings.stopLossPercent;
    const trailPercent = pos.trailPercentOverride ?? settings.trailingStopPercent;

    // 0. EXIT-DOOR WATCHDOG: a position we cannot sell is the real risk, not the price. Jupiter
    // quotes are free reads, so check periodically that a route still exists and act before the
    // stop loss fires into a door that already closed. Two consecutive misses are required so a
    // single API blip can never liquidate the book.
    if (pos.entryRawAmount && Date.now() - (this.routeCheckedAt.get(pos.id) ?? 0) > ROUTE_CHECK_INTERVAL_MS) {
      this.routeCheckedAt.set(pos.id, Date.now());
      const exitSlippage = Math.min(5000, settings.slippageBps * 2);
      const quote = await getJupiterQuote(pos.tokenAddress, WSOL_MINT, BigInt(pos.entryRawAmount), exitSlippage);
      if (quote) {
        this.routeMisses.delete(pos.id);
      } else {
        const misses = (this.routeMisses.get(pos.id) ?? 0) + 1;
        this.routeMisses.set(pos.id, misses);
        logger.warn({ positionId: pos.id, token: pos.tokenSymbol, misses, pnlPercent }, 'No sell route for open position');
        if (misses >= ROUTE_MISSES_BEFORE_EXIT) {
          this.routeMisses.delete(pos.id);
          await audit('LIQUIDITY_GONE', `No sell route after ${misses} checks — exiting while anything still fits`, {
            positionId: pos.id,
            pnlPercent,
          });
          await tradeExecutor.executeSell(pos.id, 'liquidity_gone', currentPrice);
          return;
        }
      }
    }

    // 1. STOP-LOSS: always automatic, no approval; notify after execution
    if (pnlPercent <= -slPercent) {
      logger.warn({ positionId: pos.id, pnlPercent, threshold: -slPercent }, 'STOP LOSS TRIGGERED: Executing immediate auto sell');
      await audit('STOP_LOSS_TRIGGERED', `PnL ${pnlPercent.toFixed(1)}% <= -${slPercent}%`, { positionId: pos.id, currentPrice });
      const sellResult = await tradeExecutor.executeSell(pos.id, 'stop_loss', currentPrice);
      if (sellResult.success) {
        await telegramBot.sendStopLossAlert(pos.id, sellResult.exitPrice ?? currentPrice, sellResult.pnlPercent ?? pnlPercent);
      }
      return;
    }

    // 2. ABSOLUTE-USD TAKE PROFIT: strategies that aim for a fixed few dollars per trade
    // (see EntryPlan.tpUsdTarget) are banked on money, not on a percentage ladder.
    if (pos.tpUsdTarget != null) {
      await this.evaluateUsdTakeProfit(pos, currentPrice, peakPrice, settings, trailPercent);
      return;
    }

    // 3. TRAILING ARM: once profit passes trailingArmPercent, arm the trailing stop early —
    // protects gains on a fast pump-then-dump that never reaches the full take-profit target.
    if (!pos.trailingActive && settings.autoTradeMode && trailPercent > 0 && settings.trailingArmPercent > 0 && pnlPercent >= settings.trailingArmPercent) {
      await prisma.position.update({ where: { id: pos.id }, data: { trailingActive: true } });
      await audit('TRAILING_ARMED_EARLY', `+${pnlPercent.toFixed(1)}% reached (arm threshold ${settings.trailingArmPercent}%); trailing stop ${trailPercent}% armed`, { positionId: pos.id });
      await telegramBot.sendTrailingArmedNotice(pos.id, pnlPercent, trailPercent);
      return;
    }

    // 4. TRAILING STOP: armed early above, or after hitting full take-profit below; locks in gains
    if (pos.trailingActive && trailPercent > 0) {
      const drawdown = ((peakPrice - currentPrice) / peakPrice) * 100;
      if (drawdown >= trailPercent) {
        await audit('TRAILING_STOP_TRIGGERED', `Price ${drawdown.toFixed(1)}% below peak (limit ${trailPercent}%)`, {
          positionId: pos.id,
          peakPrice,
          currentPrice,
        });
        await tradeExecutor.executeSell(pos.id, 'trailing_stop', currentPrice);
      }
      return;
    }

    // 5. TAKE-PROFIT
    if (pnlPercent >= pos.nextTpThreshold) {
      if (settings.autoTradeMode) {
        if (trailPercent > 0) {
          await prisma.position.update({ where: { id: pos.id }, data: { trailingActive: true } });
          await audit('TRAILING_ARMED', `+${pnlPercent.toFixed(1)}% reached; trailing stop ${trailPercent}% armed`, { positionId: pos.id });
          await telegramBot.sendTrailingArmedNotice(pos.id, pnlPercent, trailPercent);
        } else {
          await audit('TAKE_PROFIT_AUTO', `+${pnlPercent.toFixed(1)}% >= ${pos.nextTpThreshold}%`, { positionId: pos.id });
          await tradeExecutor.executeSell(pos.id, 'take_profit_auto', currentPrice);
        }
        return;
      }

      // Manual mode: blueprint flow — [Sell]/[Hold] alert, timeout → auto sell
      const existingAlert = await prisma.telegramInteraction.findFirst({
        where: { positionId: pos.id, alertType: 'take_profit_approval', actionTaken: null },
      });
      if (!existingAlert) {
        logger.info({ positionId: pos.id, pnlPercent, threshold: pos.nextTpThreshold }, 'TAKE PROFIT TRIGGERED: Sending Telegram alert');
        await telegramBot.sendTakeProfitAlert(pos.id, pnlPercent);
      }
    }
  }

  /**
   * Bank a fixed dollar amount per trade, consistently.
   *
   * The target is checked against what the position would *actually* fetch through Jupiter —
   * fees and price impact included — because on a ~$60 entry the difference between the mid
   * price and the realisable price is most of the $4 we are trying to keep. Once the target is
   * reached the position is sold the first tick it stops making new highs; it only keeps
   * riding while it is still climbing, and then only up to the stretch target. That is what
   * makes the result land in the band instead of round-tripping back to zero.
   */
  private async evaluateUsdTakeProfit(
    pos: Position,
    currentPrice: number,
    peakPrice: number,
    settings: BotSettingsData,
    trailPercent: number
  ) {
    const target = pos.tpUsdTarget!;
    const stretch = Math.max(pos.tpUsdStretch ?? target, target);
    const costUsd = pos.costUsd || pos.entryAmount * pos.entryPrice;

    // Far from the target a quote cannot change the decision, so don't spend one
    const indicativePnlUsd = pos.entryAmount * currentPrice - costUsd;
    if (!pos.trailingActive && indicativePnlUsd < target * TP_QUOTE_NEAR_FRACTION) return;

    const solPrice = await getSolPriceUsd();
    const realizableUsd = await this.realizableUsd(pos, settings, solPrice);
    const netPnlUsd = (realizableUsd ?? pos.entryAmount * currentPrice) - costUsd;
    const priced = realizableUsd != null ? 'jupiter quote' : 'dexscreener price';

    if (netPnlUsd >= stretch) {
      await audit('TAKE_PROFIT_USD', `Net profit $${netPnlUsd.toFixed(2)} >= stretch target $${stretch} (${priced})`, {
        positionId: pos.id,
        netPnlUsd,
        target,
        stretch,
      });
      await tradeExecutor.executeSell(pos.id, 'take_profit_usd', currentPrice);
      return;
    }

    if (netPnlUsd >= target) {
      const stillClimbing = currentPrice > pos.peakPrice;
      if (stillClimbing) {
        if (!pos.trailingActive) {
          await prisma.position.update({ where: { id: pos.id }, data: { trailingActive: true } });
          await audit('TAKE_PROFIT_USD_RIDING', `Net profit $${netPnlUsd.toFixed(2)} >= $${target}; still climbing, riding toward $${stretch}`, {
            positionId: pos.id,
            netPnlUsd,
          });
          await telegramBot.sendUsdTakeProfitRidingNotice(pos.id, netPnlUsd, target, stretch);
        }
        return;
      }
      await audit('TAKE_PROFIT_USD', `Net profit $${netPnlUsd.toFixed(2)} in the $${target}–$${stretch} band and no longer climbing (${priced})`, {
        positionId: pos.id,
        netPnlUsd,
        target,
        stretch,
      });
      await tradeExecutor.executeSell(pos.id, 'take_profit_usd', currentPrice);
      return;
    }

    if (!pos.trailingActive) return;

    // Armed on the target and then faded: take what is left rather than give the move back
    if (netPnlUsd < target * TP_GIVE_BACK_FRACTION) {
      await audit('TAKE_PROFIT_USD_FADED', `Net profit fell back to $${netPnlUsd.toFixed(2)} (target $${target}) — banking the remainder`, {
        positionId: pos.id,
        netPnlUsd,
      });
      await tradeExecutor.executeSell(pos.id, 'take_profit_usd', currentPrice);
      return;
    }

    if (trailPercent > 0) {
      const drawdown = ((peakPrice - currentPrice) / peakPrice) * 100;
      if (drawdown >= trailPercent) {
        await audit('TRAILING_STOP_TRIGGERED', `Price ${drawdown.toFixed(1)}% below peak (limit ${trailPercent}%)`, {
          positionId: pos.id,
          peakPrice,
          currentPrice,
        });
        await tradeExecutor.executeSell(pos.id, 'trailing_stop', currentPrice);
      }
    }
  }

  /** USD the whole position would fetch right now through Jupiter, net of the exit swap's fees */
  private async realizableUsd(pos: Position, settings: BotSettingsData, solPrice: number): Promise<number | null> {
    if (solPrice <= 0) return null;
    const raw = pos.entryRawAmount
      ? BigInt(pos.entryRawAmount)
      : pos.tokenDecimals != null
        ? BigInt(Math.floor(pos.entryAmount * 10 ** pos.tokenDecimals))
        : null;
    if (raw === null || raw <= 0n) return null;

    const quote = await getJupiterQuote(pos.tokenAddress, WSOL_MINT, raw, Math.min(5000, settings.slippageBps * 2));
    if (!quote) return null;
    const solOut = Number(quote.outAmount) / LAMPORTS_PER_SOL - swapCostSol(settings, false);
    return Math.max(0, solOut) * solPrice;
  }
}

export const positionMonitor = new PositionMonitorService();
