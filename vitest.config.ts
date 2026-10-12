import { defineConfig } from 'vitest/config';
import dotenv from 'dotenv';

// Tests write paper trades & stop-losses; keep them out of the bot's live schema
// (otherwise they trip the real circuit breaker and pollute cockpit stats).
const base = process.env.DATABASE_URL || dotenv.config({ quiet: true }).parsed?.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/whalebot?schema=public';
const testDbUrl = base.replace(/schema=[^&]+/, 'schema=test');

export default defineConfig({
  test: {
    // Separate Redis DB too, so the running bot never picks up jobs enqueued by tests
    env: { DATABASE_URL: testDbUrl, REDIS_URL: 'redis://localhost:6379/1', LOG_LEVEL: 'warn' },
    globalSetup: './src/__tests__/setup.ts',
    fileParallelism: false,
  },
});
