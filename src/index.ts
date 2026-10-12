import { connectDb, disconnectDb } from './db/prisma.js';
import { env } from './config/index.js';
import { logger } from './services/logger.js';
import { createServer } from './dashboard/server.js';
import { startWorkers } from './workers/index.js';
import { telegramBot } from './bot/telegram.js';
import { settingsService } from './services/settings.js';
import { ensureTradingWallet } from './services/solana.js';
import { whaleDiscovery } from './services/discovery.js';

async function bootstrap() {
  logger.info('Initializing Fins Trade...');

  const isLocalHost = ['127.0.0.1', 'localhost', '::1'].includes(env.HOST);
  if (!isLocalHost && !env.COCKPIT_PASSWORD && !env.COCKPIT_CONTAINER_BIND) {
    throw new Error(`HOST=${env.HOST} exposes the cockpit (which can move funds) — set COCKPIT_PASSWORD or use HOST=127.0.0.1`);
  }

  // 1. Database, settings, trading wallet, watchlist
  await connectDb();
  const settings = await settingsService.getSettings();
  const walletAddress = await ensureTradingWallet();
  await whaleDiscovery.seedEnvWallets();

  // 2. Telegram (re-inits itself when the token/chat changes in the dashboard)
  telegramBot.start();
  settingsService.onChange(() => {
    telegramBot.init().catch((err) => logger.error({ err: err?.message }, 'Telegram re-init failed'));
  });

  // 3. Background engines (scanner, discovery, pipeline, monitor)
  const workers = startWorkers();

  // 4. HTTP Server & Dashboard
  const app = createServer();
  const server = app.listen(env.PORT, env.HOST, () => {
    logger.info(`Cockpit live at http://${env.HOST}:${env.PORT}`);
    logger.info(`Trading wallet: ${walletAddress} — fund it with SOL`);
    logger.info(`Mode: ${settings.paperTrading ? 'PAPER TRADING (Simulation)' : 'LIVE TRADING'} · ${settings.autoTradeMode ? 'AUTO' : 'APPROVAL'}`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down services...');
    server.close();
    await telegramBot.stop();
    await Promise.all(Object.values(workers).map((w) => w.close()));
    await disconnectDb();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // Stay up 24/7: log and keep going on stray async errors instead of crashing
  process.on('unhandledRejection', (err: any) => logger.error({ err: err?.message || err }, 'Unhandled rejection'));
}

bootstrap().catch((err) => {
  logger.fatal({ err }, 'Fatal error during startup');
  process.exit(1);
});
