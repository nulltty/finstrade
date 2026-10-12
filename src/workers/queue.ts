import { Queue, Worker, QueueEvents, Job } from 'bullmq';
import { Redis } from 'ioredis';
import { env } from '../config/index.js';
import { logger } from '../services/logger.js';

export const redisConnection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

redisConnection.on('connect', () => {
  logger.info('Connected to Redis server');
});

redisConnection.on('error', (err) => {
  logger.error({ err }, 'Redis connection error');
});

// Queues
export const signalQueue = new Queue('signal-processing', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
    removeOnComplete: 100,
    removeOnFail: 200,
  },
});

export const approvalTimeoutQueue = new Queue('approval-timeout', {
  connection: redisConnection,
  defaultJobOptions: {
    removeOnComplete: 100,
    removeOnFail: 100,
  },
});

export const positionMonitorQueue = new Queue('position-monitor', {
  connection: redisConnection,
  defaultJobOptions: {
    removeOnComplete: 50,
    removeOnFail: 50,
  },
});

export const multiWalletScannerQueue = new Queue('multi-wallet-scanner', {
  connection: redisConnection,
  defaultJobOptions: {
    removeOnComplete: 50,
    removeOnFail: 50,
  },
});

export const dummyQueue = new Queue('dummy-test', {
  connection: redisConnection,
});

// Dummy worker to verify BullMQ in Batch 1
export function createDummyWorker() {
  const worker = new Worker(
    'dummy-test',
    async (job: Job) => {
      logger.info({ jobId: job.id, data: job.data }, 'BullMQ Dummy Worker executed job successfully');
      return { status: 'ok', timestamp: Date.now() };
    },
    { connection: redisConnection }
  );

  worker.on('completed', (job) => {
    logger.info({ jobId: job.id }, 'Dummy job marked completed');
  });

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'Dummy job failed');
  });

  return worker;
}
