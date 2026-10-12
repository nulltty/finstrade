import { prisma } from '../db/prisma.js';
import { env } from '../config/index.js';
import { circuitBreaker } from './circuitBreaker.js';
import { logger } from './logger.js';
import crypto from 'crypto';

export interface BuyResult {
  success: boolean;
  positionId?: string;
  txHash?: string;
  error?: string;
}

export interface SellResult {
  success: boolean;
  exitPrice?: number;
  pnlPercent?: number;
  txHash?: string;
  error?: string;
}

export class TradeExecutor {
  /**
   * Execute BUY swap for an approved signal
   */
  async executeBuy(signalId: string): Promise<BuyResult> {
    const signal = await prisma.signal.findUnique({ where: { id: signalId } });
    if (!signal) {
      return { success: false, error: `Signal ${signalId} not found` };
    }

    // Safety: Circuit breaker check
    const cbCheck = await circuitBreaker.canExecuteBuy();
    if (!cbCheck.allowed) {
      logger.warn({ signalId, reason: cbCheck.reason }, 'BUY blocked by circuit breaker');
      await prisma.signal.update({
        where: { id: signalId },
        data: { status: 'failed' },
      });
      return { success: false, error: cbCheck.reason };
    }

    await prisma.signal.update({
      where: { id: signalId },
      data: { status: 'executing_buy' },
    });

    try {
      const rawMetrics = (signal.rawMetrics as any) || {};
      const currentPrice = rawMetrics.priceUsd && rawMetrics.priceUsd > 0 ? rawMetrics.priceUsd : 0.001;
      const tradeUsd = env.TRADE_AMOUNT_USD;
      const tokenAmount = tradeUsd / currentPrice;

      let txHash = '';
      const isPaper = env.PAPER_TRADING || !env.SOLANA_PRIVATE_KEY;

      if (isPaper) {
        txHash = `paper_buy_${crypto.randomBytes(16).toString('hex')}`;
        logger.info(
          { signalId, token: signal.tokenAddress, amountUsd: tradeUsd, tokenAmount, txHash },
          'Paper BUY trade executed'
        );
      } else {
        // Live trade execution placeholder (e.g. Jupiter Swap API)
        txHash = await this.executeLiveJupiterBuy(signal.tokenAddress, tradeUsd);
      }

      // Record Trade in DB
      const trade = await prisma.trade.create({
        data: {
          signalId: signal.id,
          side: 'BUY',
          chain: signal.chain,
          tokenAddress: signal.tokenAddress,
          price: currentPrice,
          amount: tokenAmount,
          totalUsd: tradeUsd,
          txHash,
          status: 'confirmed',
          slippageBps: env.SLIPPAGE_BPS,
          priorityFee: env.MAX_PRIORITY_FEE,
          isPaper,
        },
      });

      // Create Open Position
      const position = await prisma.position.create({
        data: {
          signalId: signal.id,
          chain: signal.chain,
          tokenAddress: signal.tokenAddress,
          tokenSymbol: signal.tokenSymbol || 'TOKEN',
          entryPrice: currentPrice,
          entryAmount: tokenAmount,
          currentPrice,
          pnlPercent: 0,
          highestPnlPercent: 0,
          nextTpThreshold: env.TAKE_PROFIT_PERCENT,
          status: 'open',
        },
      });

      // Update trade with positionId
      await prisma.trade.update({
        where: { id: trade.id },
        data: { positionId: position.id },
      });

      await prisma.signal.update({
        where: { id: signalId },
        data: { status: 'bought' },
      });

      // Audit Log
      await prisma.auditLog.create({
        data: {
          action: 'BUY_FILLED',
          reason: `Position opened via ${isPaper ? 'Paper' : 'Live'} order`,
          payload: { positionId: position.id, signalId, txHash, tradeUsd, price: currentPrice },
        },
      });

      return { success: true, positionId: position.id, txHash };
    } catch (err: any) {
      logger.error({ signalId, err: err?.message }, 'Failed to execute BUY');
      await prisma.signal.update({
        where: { id: signalId },
        data: { status: 'failed' },
      });
      return { success: false, error: err?.message };
    }
  }

  /**
   * Execute SELL swap for an open position
   */
  async executeSell(
    positionId: string,
    reason: 'stop_loss' | 'take_profit_approved' | 'take_profit_timeout' | 'manual',
    customExitPrice?: number
  ): Promise<SellResult> {
    const position = await prisma.position.findUnique({ where: { id: positionId } });
    if (!position || position.status !== 'open') {
      return { success: false, error: `Position ${positionId} not found or not open` };
    }

    const exitPrice = customExitPrice || position.currentPrice;
    const pnlPercent = ((exitPrice - position.entryPrice) / position.entryPrice) * 100;
    const totalUsd = position.entryAmount * exitPrice;

    const isPaper = env.PAPER_TRADING || !env.SOLANA_PRIVATE_KEY;
    let txHash = '';

    if (isPaper) {
      txHash = `paper_sell_${crypto.randomBytes(16).toString('hex')}`;
    } else {
      txHash = await this.executeLiveJupiterSell(position.tokenAddress, position.entryAmount);
    }

    // Record Sell Trade
    await prisma.trade.create({
      data: {
        positionId: position.id,
        signalId: position.signalId,
        side: 'SELL',
        chain: position.chain,
        tokenAddress: position.tokenAddress,
        price: exitPrice,
        amount: position.entryAmount,
        totalUsd,
        txHash,
        status: 'confirmed',
        slippageBps: env.SLIPPAGE_BPS,
        priorityFee: env.MAX_PRIORITY_FEE,
        isPaper,
      },
    });

    // Close Position
    await prisma.position.update({
      where: { id: positionId },
      data: {
        status: 'closed',
        exitPrice,
        pnlPercent,
        exitReason: reason,
        closedAt: new Date(),
      },
    });

    logger.info(
      { positionId, reason, exitPrice, pnlPercent: `${pnlPercent.toFixed(2)}%`, txHash },
      'Position closed via SELL'
    );

    // Audit log
    await prisma.auditLog.create({
      data: {
        action: 'SELL_FILLED',
        reason: `Position closed: ${reason}`,
        payload: { positionId, exitPrice, pnlPercent, txHash, totalUsd },
      },
    });

    return { success: true, exitPrice, pnlPercent, txHash };
  }

  private async executeLiveJupiterBuy(tokenMint: string, amountUsd: number): Promise<string> {
    // In production, query Jupiter Quote API: https://quote-api.jup.ag/v6/quote
    // then /swap, sign with keypair and send
    logger.info({ tokenMint, amountUsd }, 'Triggering Jupiter API live buy swap');
    return `sol_tx_${crypto.randomBytes(16).toString('hex')}`;
  }

  private async executeLiveJupiterSell(tokenMint: string, amount: number): Promise<string> {
    logger.info({ tokenMint, amount }, 'Triggering Jupiter API live sell swap');
    return `sol_tx_${crypto.randomBytes(16).toString('hex')}`;
  }
}

export const tradeExecutor = new TradeExecutor();
