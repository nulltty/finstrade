import { connectDb, disconnectDb } from './db/prisma.js';
import { env } from './config/index.js';
import { logger } from './services/logger.js';
import { createServer } from './dashboard/server.js';
import { startWorkers } from './workers/index.js';
import { telegramBot } from './bot/telegram.js';
import { dummyQueue, createDummyWorker } from './workers/queue.js';

async function bootstrap() {
  logger.info('Initializing Whale-Signal Trading Bot...');

  // 1. Connect Database
  await connectDb();

  // Seed initial curated whale wallets
  const { whaleDiscovery } = await import('./services/discovery.js');
  await whaleDiscovery.seedCuratedWallets();

  // 2. Start BullMQ Workers
  const dummyWorker = createDummyWorker();
  const workers = startWorkers();

  // Test BullMQ dummy job (Batch 1 acceptance criteria)
  const dummyJob = await dummyQueue.add('test-batch-1', {
    message: 'Batch 1 Infrastructure Test Job',
    timestamp: new Date().toISOString(),
  });
  logger.info({ dummyJobId: dummyJob.id }, 'Dispatched Batch 1 dummy verification job');

  // 3. Start Telegram Bot
  telegramBot.start();

  // 4. Start HTTP Server & Dashboard
  const app = createServer();
  const server = app.listen(env.PORT, () => {
    logger.info(`Server & Dashboard live at http://localhost:${env.PORT}`);
    logger.info(`Mode: ${env.PAPER_TRADING ? 'PAPER TRADING (Simulation)' : 'LIVE TRADING'}`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down services...');
    server.close();
    await dummyWorker.close();
    await workers.signalWorker.close();
    await workers.timeoutWorker.close();
    await workers.monitorWorker.close();
    await workers.scannerWorker.close();
    await disconnectDb();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

bootstrap().catch((err) => {
  logger.fatal({ err }, 'Fatal error during startup');
  process.exit(1);
});
