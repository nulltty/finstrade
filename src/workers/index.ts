import { Worker, Job } from 'bullmq';
import { redisConnection, positionMonitorQueue, multiWalletScannerQueue, whaleDiscoveryQueue, dipScannerQueue } from './queue.js';
import { tokenDataAggregator } from '../services/aggregator.js';
import { scoringEngine } from '../services/scoring.js';
import { telegramBot } from '../bot/telegram.js';
import { tradeExecutor } from '../services/executor.js';
import { positionMonitor } from '../services/monitor.js';
import { settingsService, BotSettingsData } from '../services/settings.js';
import { trackRun } from '../services/status.js';
import { audit } from '../services/audit.js';
import { prisma } from '../db/prisma.js';
import { logger } from '../services/logger.js';

/**
 * Signal pipeline: aggregate → score → (auto mode) buy + notify, or (approval mode)
 * Telegram [Approve]/[Skip].
 */
export async function processSignal(signalId: string) {
  const metrics = await tokenDataAggregator.aggregate(signalId);
  const settings = await settingsService.getSettings();
  const scoreResult = scoringEngine.calculateScore(metrics, settings.scoringThreshold, {
    minLiquidityUsd: settings.minLiquidityUsd,
    hardFailMinLiquidity: settings.hardFailMinLiquidity,
    maxPriceImpactPct: settings.maxPriceImpactPct,
  });
  await scoringEngine.saveScore(signalId, scoreResult);

  const signal = (await prisma.signal.findUnique({ where: { id: signalId } }))!;

  if (!scoreResult.passedThreshold) {
    const why = scoreResult.isHardFail ? scoreResult.hardFailReasons.join('; ') : `score ${scoreResult.totalScore} < ${settings.scoringThreshold}`;
    await prisma.signal.update({ where: { id: signalId }, data: { decision: `rejected:${why}` } });
    await audit('SIGNAL_REJECTED', `${signal.tokenSymbol}: ${why}`, { signalId, score: scoreResult.totalScore });
    return { signalId, score: scoreResult.totalScore, passed: false };
  }

  await audit('SIGNAL_PASSED', `${signal.tokenSymbol} scored ${scoreResult.totalScore}/100`, { signalId });

  if (!settings.autoTradeMode) {
    await prisma.signal.update({ where: { id: signalId }, data: { decision: 'approval_requested' } });
    await telegramBot.sendBuyAlert(signalId);
    return { signalId, score: scoreResult.totalScore, passed: true, action: 'approval' };
  }

  // Auto mode: don't chase a pump that's already minutes old
  const ageSec = signal.whaleTxAt ? (Date.now() - signal.whaleTxAt.getTime()) / 1000 : 0;
  if (ageSec > settings.maxSignalAgeSec) {
    const why = `signal stale (${Math.round(ageSec)}s > ${settings.maxSignalAgeSec}s)`;
    await prisma.signal.update({ where: { id: signalId }, data: { status: 'skipped', decision: `rejected:${why}` } });
    await audit('AUTO_BUY_SKIPPED', why, { signalId });
    await telegramBot.sendAutoBuyNotice(signalId, { success: false, error: why });
    return { signalId, score: scoreResult.totalScore, passed: true, action: 'stale' };
  }

  await prisma.signal.update({ where: { id: signalId }, data: { status: 'approved', decision: 'auto_buy' } });
  await audit('AUTO_BUY_DECISION', `${signal.tokenSymbol} passed all checks (score ${scoreResult.totalScore})`, { signalId });
  const result = await tradeExecutor.executeBuy(signalId);
  await telegramBot.sendAutoBuyNotice(signalId, result);
  return { signalId, score: scoreResult.totalScore, passed: true, action: 'auto_buy', bought: result.success };
}

/** (Re)apply repeatable job intervals from settings */
export async function scheduleJobs(settings?: BotSettingsData) {
  const s = settings || (await settingsService.getSettings());
  await positionMonitorQueue.upsertJobScheduler('poll-positions', { every: 15000 });
  await multiWalletScannerQueue.upsertJobScheduler('scan-active-whales', { every: Math.max(10, s.autoScanIntervalSec) * 1000 });
  await multiWalletScannerQueue.removeJobScheduler('auto-discover-whales'); // legacy location
  if (s.autoDiscoveryEnabled) {
    await whaleDiscoveryQueue.upsertJobScheduler('auto-discover-whales', { every: Math.max(5, s.autoDiscoveryIntervalMin) * 60 * 1000 });
  } else {
    await whaleDiscoveryQueue.removeJobScheduler('auto-discover-whales');
  }
  if (s.dipStrategyEnabled) {
    await dipScannerQueue.upsertJobScheduler('scan-dips', { every: Math.max(2, s.dipScanIntervalMin) * 60 * 1000 });
  } else {
    await dipScannerQueue.removeJobScheduler('scan-dips');
  }
  logger.info(
    {
      scanSec: s.autoScanIntervalSec,
      discoveryMin: s.autoDiscoveryEnabled ? s.autoDiscoveryIntervalMin : 'off',
      dipScanMin: s.dipStrategyEnabled ? s.dipScanIntervalMin : 'off',
    },
    'Job schedules applied'
  );
}

export function startWorkers() {
  logger.info('Starting BullMQ workers...');

  // 1. Signal Processing Worker (Aggregator -> Scoring -> Auto-buy / Alert)
  const signalWorker = new Worker(
    'signal-processing',
    async (job: Job) => trackRun('pipeline', () => processSignal(job.data.signalId)),
    { connection: redisConnection, concurrency: 3 }
  );

  // 2. Approval & Take-Profit Timeout Worker
  const timeoutWorker = new Worker(
    'approval-timeout',
    async (job: Job) => {
      logger.info({ jobName: job.name, data: job.data }, 'Processing timeout job');
      const settings = await settingsService.getSettings();

      if (job.name === 'buy-timeout') {
        const { signalId } = job.data;
        const signal = await prisma.signal.findUnique({ where: { id: signalId } });
        if (!signal || signal.status !== 'pending_approval') return;

        await prisma.telegramInteraction.updateMany({
          where: { signalId, alertType: 'buy_approval', actionTaken: null },
          data: { actionTaken: 'timeout', respondedAt: new Date() },
        });

        if (settings.buyTimeoutAction === 'auto_buy') {
          await audit('BUY_TIMEOUT_AUTO_BUY', 'No response within approval window; auto-buy configured', { signalId });
          await prisma.signal.update({ where: { id: signalId }, data: { status: 'approved' } });
          const result = await tradeExecutor.executeBuy(signalId);
          await telegramBot.sendAutoBuyNotice(signalId, result);
        } else {
          await audit('BUY_TIMEOUT_EXPIRED', 'No response within approval window; signal archived', { signalId });
          await prisma.signal.update({ where: { id: signalId }, data: { status: 'timeout_expired' } });
        }
      } else if (job.name === 'take-profit-timeout') {
        const { positionId } = job.data;
        const pendingAlert = await prisma.telegramInteraction.findFirst({
          where: { positionId, alertType: 'take_profit_approval', actionTaken: null },
        });
        if (!pendingAlert) return;

        await prisma.telegramInteraction.updateMany({
          where: { positionId, alertType: 'take_profit_approval', actionTaken: null },
          data: { actionTaken: 'timeout', respondedAt: new Date() },
        });
        await audit('TAKE_PROFIT_TIMEOUT', 'No response within approval window; executing safe auto-sell', { positionId });
        await tradeExecutor.executeSell(positionId, 'take_profit_timeout');
      }
    },
    { connection: redisConnection }
  );

  // 3. Position Monitor Worker
  const monitorWorker = new Worker(
    'position-monitor',
    async () => trackRun('monitor', () => positionMonitor.checkOpenPositions()),
    { connection: redisConnection }
  );

  // 4. Multi-Wallet On-Chain Scanner
  const scannerWorker = new Worker(
    'multi-wallet-scanner',
    async () => {
      const { multiWalletScanner } = await import('../services/scanner.js');
      return trackRun('scanner', () => multiWalletScanner.scanAllActiveWallets());
    },
    { connection: redisConnection }
  );

  // 5. Whale Discovery & Profiling Worker (slow; long lock so it isn't marked stalled)
  const discoveryWorker = new Worker(
    'whale-discovery',
    async () => {
      const { whaleDiscovery } = await import('../services/discovery.js');
      return trackRun('discovery', () => whaleDiscovery.runDiscoveryCycle() as any);
    },
    { connection: redisConnection, lockDuration: 15 * 60 * 1000 }
  );

  // 6. RSI Dip Reversal Scanner (strategy 2; candle fetches make a cycle slow, hence its own queue)
  const dipScannerWorker = new Worker(
    'dip-scanner',
    async () => {
      const { dipReversalScanner } = await import('../services/dipScanner.js');
      return trackRun('dipScanner', () => dipReversalScanner.runScanCycle() as any);
    },
    { connection: redisConnection, lockDuration: 10 * 60 * 1000 }
  );

  scheduleJobs().catch((err) => logger.error({ err }, 'Failed to schedule repeatable jobs'));
  settingsService.onChange((s) => {
    scheduleJobs(s).catch((err) => logger.error({ err }, 'Failed to reschedule jobs'));
  });

  // Kick off discovery right away so a fresh install finds whales without waiting an hour
  whaleDiscoveryQueue.add('auto-discover-whales', {}, { jobId: `discover-boot-${Date.now()}` }).catch(() => {});

  signalWorker.on('failed', (job, err) => logger.error({ jobId: job?.id, err: err?.message }, 'Signal worker failed'));
  timeoutWorker.on('failed', (job, err) => logger.error({ jobId: job?.id, err: err?.message }, 'Timeout worker failed'));
  monitorWorker.on('failed', (job, err) => logger.error({ jobId: job?.id, err: err?.message }, 'Monitor worker failed'));
  scannerWorker.on('failed', (job, err) => logger.error({ jobId: job?.id, err: err?.message }, 'Scanner worker failed'));
  discoveryWorker.on('failed', (job, err) => logger.error({ jobId: job?.id, err: err?.message }, 'Discovery worker failed'));
  dipScannerWorker.on('failed', (job, err) => logger.error({ jobId: job?.id, err: err?.message }, 'Dip scanner worker failed'));

  return { signalWorker, timeoutWorker, monitorWorker, scannerWorker, discoveryWorker, dipScannerWorker };
}
