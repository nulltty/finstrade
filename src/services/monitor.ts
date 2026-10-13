import { prisma } from '../db/prisma.js';
import { tokenDataAggregator } from './aggregator.js';
import { tradeExecutor } from './executor.js';
import { telegramBot } from '../bot/telegram.js';
import { settingsService } from './settings.js';
import { audit } from './audit.js';
import { logger } from './logger.js';

export class PositionMonitorService {
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

    // 1. STOP-LOSS: always automatic, no approval; notify after execution
    if (pnlPercent <= -settings.stopLossPercent) {
      logger.warn({ positionId: pos.id, pnlPercent, threshold: -settings.stopLossPercent }, 'STOP LOSS TRIGGERED: Executing immediate auto sell');
      await audit('STOP_LOSS_TRIGGERED', `PnL ${pnlPercent.toFixed(1)}% <= -${settings.stopLossPercent}%`, { positionId: pos.id, currentPrice });
      const sellResult = await tradeExecutor.executeSell(pos.id, 'stop_loss', currentPrice);
      if (sellResult.success) {
        await telegramBot.sendStopLossAlert(pos.id, sellResult.exitPrice ?? currentPrice, sellResult.pnlPercent ?? pnlPercent);
      }
      return;
    }

    // 2. TRAILING ARM: once profit passes trailingArmPercent, arm the trailing stop early —
    // protects gains on a fast pump-then-dump that never reaches the full take-profit target.
    if (!pos.trailingActive && settings.autoTradeMode && settings.trailingStopPercent > 0 && settings.trailingArmPercent > 0 && pnlPercent >= settings.trailingArmPercent) {
      await prisma.position.update({ where: { id: pos.id }, data: { trailingActive: true } });
      await audit('TRAILING_ARMED_EARLY', `+${pnlPercent.toFixed(1)}% reached (arm threshold ${settings.trailingArmPercent}%); trailing stop ${settings.trailingStopPercent}% armed`, { positionId: pos.id });
      await telegramBot.sendTrailingArmedNotice(pos.id, pnlPercent, settings.trailingStopPercent);
      return;
    }

    // 3. TRAILING STOP: armed early above, or after hitting full take-profit below; locks in gains
    if (pos.trailingActive && settings.trailingStopPercent > 0) {
      const drawdown = ((peakPrice - currentPrice) / peakPrice) * 100;
      if (drawdown >= settings.trailingStopPercent) {
        await audit('TRAILING_STOP_TRIGGERED', `Price ${drawdown.toFixed(1)}% below peak (limit ${settings.trailingStopPercent}%)`, {
          positionId: pos.id,
          peakPrice,
          currentPrice,
        });
        await tradeExecutor.executeSell(pos.id, 'trailing_stop', currentPrice);
      }
      return;
    }

    // 4. TAKE-PROFIT
    if (pnlPercent >= pos.nextTpThreshold) {
      if (settings.autoTradeMode) {
        if (settings.trailingStopPercent > 0) {
          await prisma.position.update({ where: { id: pos.id }, data: { trailingActive: true } });
          await audit('TRAILING_ARMED', `+${pnlPercent.toFixed(1)}% reached; trailing stop ${settings.trailingStopPercent}% armed`, { positionId: pos.id });
          await telegramBot.sendTrailingArmedNotice(pos.id, pnlPercent, settings.trailingStopPercent);
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
}

export const positionMonitor = new PositionMonitorService();
