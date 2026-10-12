import { prisma } from '../db/prisma.js';
import { env } from '../config/index.js';
import { tokenDataAggregator } from './aggregator.js';
import { tradeExecutor } from './executor.js';
import { telegramBot } from '../bot/telegram.js';
import { logger } from './logger.js';

export class PositionMonitorService {
  /**
   * Monitor all open positions and execute SL/TP logic
   */
  async checkOpenPositions() {
    const openPositions = await prisma.position.findMany({
      where: { status: 'open' },
    });

    if (openPositions.length === 0) {
      return;
    }

    logger.debug({ count: openPositions.length }, 'Monitoring open positions');

    for (const pos of openPositions) {
      try {
        await this.evaluatePosition(pos.id);
      } catch (err: any) {
        logger.error({ positionId: pos.id, err: err?.message }, 'Error checking position');
      }
    }
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

    // Update position metrics
    await prisma.position.update({
      where: { id: pos.id },
      data: {
        currentPrice,
        pnlPercent,
        highestPnlPercent: highestPnl,
      },
    });

    // 1. STOP-LOSS CHECK: pnl <= -20% -> Auto-Sell immediately without approval
    if (pnlPercent <= -env.STOP_LOSS_PERCENT) {
      logger.warn(
        { positionId: pos.id, pnlPercent, threshold: -env.STOP_LOSS_PERCENT },
        'STOP LOSS TRIGGERED: Executing immediate auto sell'
      );

      const sellResult = await tradeExecutor.executeSell(pos.id, 'stop_loss', currentPrice);
      if (sellResult.success) {
        await telegramBot.sendStopLossAlert(pos.id, currentPrice, pnlPercent);
      }
      return;
    }

    // 2. TAKE-PROFIT CHECK: pnl >= nextTpThreshold (e.g. +100%) -> send [Sell] [Hold] alert
    if (pnlPercent >= pos.nextTpThreshold) {
      // Check if alert was already sent recently for this position
      const existingAlert = await prisma.telegramInteraction.findFirst({
        where: {
          positionId: pos.id,
          alertType: 'take_profit_approval',
          actionTaken: null,
        },
      });

      if (!existingAlert) {
        logger.info(
          { positionId: pos.id, pnlPercent, threshold: pos.nextTpThreshold },
          'TAKE PROFIT TRIGGERED: Sending Telegram alert'
        );
        await telegramBot.sendTakeProfitAlert(pos.id, pnlPercent);
      }
    }
  }
}

export const positionMonitor = new PositionMonitorService();
