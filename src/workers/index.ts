import { Worker, Job } from 'bullmq';
import { redisConnection, positionMonitorQueue, multiWalletScannerQueue } from './queue.js';
import { tokenDataAggregator } from '../services/aggregator.js';
import { scoringEngine } from '../services/scoring.js';
import { telegramBot } from '../bot/telegram.js';
import { tradeExecutor } from '../services/executor.js';
import { positionMonitor } from '../services/monitor.js';
import { prisma } from '../db/prisma.js';
import { env } from '../config/index.js';
import { logger } from '../services/logger.js';

export function startWorkers() {
  logger.info('Starting BullMQ workers...');

  // 1. Signal Processing Worker (Aggregator -> Scoring -> Alert)
  const signalWorker = new Worker(
    'signal-processing',
    async (job: Job) => {
      const { signalId } = job.data;
      logger.info({ jobId: job.id, signalId }, 'Processing signal job');

      // Fetch & aggregate metrics
      const metrics = await tokenDataAggregator.aggregate(signalId);

      // Score
      const scoreResult = scoringEngine.calculateScore(metrics);
      await scoringEngine.saveScore(signalId, scoreResult);

      // Trigger Telegram Alert if score passes threshold
      if (scoreResult.passedThreshold) {
        logger.info({ signalId, score: scoreResult.totalScore }, 'Signal passed score threshold, sending Telegram alert');
        await telegramBot.sendBuyAlert(signalId);
      } else {
        logger.info(
          { signalId, score: scoreResult.totalScore, hardFail: scoreResult.isHardFail },
          'Signal did not pass threshold, archived as scored'
        );
      }

      return { signalId, score: scoreResult.totalScore, passed: scoreResult.passedThreshold };
    },
    { connection: redisConnection }
  );

  // 2. Approval & Take-Profit Timeout Worker (2-minute window)
  const timeoutWorker = new Worker(
    'approval-timeout',
    async (job: Job) => {
      logger.info({ jobName: job.name, data: job.data }, 'Processing timeout job');

      if (job.name === 'buy-timeout') {
        const { signalId } = job.data;
        const signal = await prisma.signal.findUnique({ where: { id: signalId } });

        if (signal && signal.status === 'pending_approval') {
          if (env.BUY_TIMEOUT_ACTION === 'auto_buy') {
            logger.info({ signalId }, 'Buy approval timed out: auto-buying configured');
            await prisma.signal.update({ where: { id: signalId }, data: { status: 'approved' } });
            await tradeExecutor.executeBuy(signalId);
          } else {
            logger.info({ signalId }, 'Buy approval timed out: archiving as timeout_expired');
            await prisma.signal.update({
              where: { id: signalId },
              data: { status: 'timeout_expired' },
            });
            await prisma.telegramInteraction.updateMany({
              where: { signalId, alertType: 'buy_approval', actionTaken: null },
              data: { actionTaken: 'timeout', respondedAt: new Date() },
            });
          }
        }
      } else if (job.name === 'take-profit-timeout') {
        const { positionId } = job.data;
        const position = await prisma.position.findUnique({ where: { id: positionId } });

        if (position && position.status === 'open') {
          const pendingAlert = await prisma.telegramInteraction.findFirst({
            where: { positionId, alertType: 'take_profit_approval', actionTaken: null },
          });

          if (pendingAlert) {
            logger.warn({ positionId }, 'Take-profit approval timed out: executing SAFE AUTO-SELL');
            await prisma.telegramInteraction.updateMany({
              where: { positionId, alertType: 'take_profit_approval', actionTaken: null },
              data: { actionTaken: 'timeout', respondedAt: new Date() },
            });
            await tradeExecutor.executeSell(positionId, 'take_profit_timeout');
          }
        }
      }
    },
    { connection: redisConnection }
  );

  // 3. Position Monitor Worker
  const monitorWorker = new Worker(
    'position-monitor',
    async () => {
      await positionMonitor.checkOpenPositions();
      return { checkedAt: Date.now() };
    },
    { connection: redisConnection }
  );

  // 4. Multi-Wallet On-Chain Scanner Worker (Scans dozens/hundreds of whales periodically)
  const scannerWorker = new Worker(
    'multi-wallet-scanner',
    async (job: Job) => {
      const { multiWalletScanner } = await import('../services/scanner.js');
      const result = await multiWalletScanner.scanAllActiveWallets();
      return result;
    },
    { connection: redisConnection }
  );

  // Schedule repeatable position monitoring every 15 seconds
  positionMonitorQueue.upsertJobScheduler('poll-positions', {
    every: 15000,
  }).catch((err) => {
    logger.error({ err }, 'Failed to schedule position monitor repeatable job');
  });

  // Schedule repeatable multi-wallet scanning every 30 seconds
  multiWalletScannerQueue.upsertJobScheduler('scan-active-whales', {
    every: 30000,
  }).catch((err) => {
    logger.error({ err }, 'Failed to schedule multi-wallet scanner repeatable job');
  });

  signalWorker.on('failed', (job, err) => logger.error({ jobId: job?.id, err }, 'Signal worker failed'));
  timeoutWorker.on('failed', (job, err) => logger.error({ jobId: job?.id, err }, 'Timeout worker failed'));
  monitorWorker.on('failed', (job, err) => logger.error({ jobId: job?.id, err }, 'Monitor worker failed'));
  scannerWorker.on('failed', (job, err) => logger.error({ jobId: job?.id, err }, 'Scanner worker failed'));

  return { signalWorker, timeoutWorker, monitorWorker, scannerWorker };
}
