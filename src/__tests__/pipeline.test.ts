import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// Paper fills are priced from a real Jupiter quote in production. Stub the quote here so this
// test asserts the fill accounting rather than whether one memecoin still has liquidity today.
vi.mock('../services/solana.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/solana.js')>();
  const WSOL = 'So11111111111111111111111111111111111111112';
  return {
    ...actual,
    getSolPriceUsd: async () => 100,
    getMintDecimals: async () => 9,
    getJupiterQuote: async (inputMint: string) =>
      (inputMint === WSOL
        ? { outAmount: '11764705882', priceImpactPct: '0.004' } // 0.1 SOL buys ~11.76 tokens
        : { outAmount: '76000000', priceImpactPct: '0.004' }) as any, // exit at a loss: 0.076 SOL
  };
});

import { whaleWatcherService } from '../services/watcher.js';
import { circuitBreaker } from '../services/circuitBreaker.js';
import { tradeExecutor } from '../services/executor.js';
import { prisma, connectDb, disconnectDb } from '../db/prisma.js';
import crypto from 'crypto';

describe('Trading Pipeline & Safety Integration Tests', () => {
  beforeAll(async () => {
    await connectDb();
  });

  afterAll(async () => {
    await disconnectDb();
  });

  it('should ignore blue-chip tokens like SOL or USDC', async () => {
    const solEvent = {
      wallet: '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1',
      chain: 'solana' as const,
      tokenAddress: 'So11111111111111111111111111111111111111112',
      tokenSymbol: 'SOL',
      txHash: `tx_${Date.now()}_sol`,
      amountUsd: 50000,
    };

    const result = await whaleWatcherService.processEvent(solEvent);
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('blue_chip_or_stable');
  });

  it('should deduplicate events with the same txHash', async () => {
    const uniqueTx = `tx_test_dedupe_${crypto.randomBytes(8).toString('hex')}`;
    const memeEvent = {
      wallet: '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1',
      chain: 'solana' as const,
      tokenAddress: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
      tokenSymbol: 'BONK',
      txHash: uniqueTx,
      amountUsd: 15000,
    };

    const first = await whaleWatcherService.processEvent(memeEvent);
    expect(first.skipped).toBe(false);

    // Second with identical txHash
    const second = await whaleWatcherService.processEvent(memeEvent);
    expect(second.skipped).toBe(true);
    expect(second.reason).toBe('duplicate_tx_hash');
  });

  it('should execute paper buy trade and record position', async () => {
    // Create a dummy signal first
    const txHash = `tx_buy_test_${crypto.randomBytes(8).toString('hex')}`;
    const signal = await prisma.signal.create({
      data: {
        wallet: '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1',
        chain: 'solana',
        tokenAddress: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr',
        tokenSymbol: 'POPCAT',
        txHash,
        amountUsd: 10000,
        status: 'approved',
        rawMetrics: { priceUsd: 0.85 } as any,
      },
    });

    circuitBreaker.reset();
    const buyResult = await tradeExecutor.executeBuy(signal.id);
    expect(buyResult.success).toBe(true);
    expect(buyResult.positionId).toBeDefined();

    // Verify position exists
    const position = await prisma.position.findUnique({
      where: { id: buyResult.positionId },
    });
    expect(position).toBeDefined();
    expect(position?.status).toBe('open');
    expect(position?.tokenSymbol).toBe('POPCAT');

    // Test Sell execution (stop-loss scenario)
    const sellResult = await tradeExecutor.executeSell(position!.id, 'stop_loss', 0.65);
    expect(sellResult.success).toBe(true);
    expect(sellResult.pnlPercent).toBeLessThan(0);

    const closedPos = await prisma.position.findUnique({ where: { id: position!.id } });
    expect(closedPos?.status).toBe('closed');
    expect(closedPos?.exitReason).toBe('stop_loss');
  });

  it('should enforce circuit breaker when manually tripped', async () => {
    circuitBreaker.trip('Emergency manual test halt');
    const check = await circuitBreaker.canExecuteBuy();
    expect(check.allowed).toBe(false);

    circuitBreaker.reset();
    const checkAfterReset = await circuitBreaker.canExecuteBuy();
    expect(checkAfterReset.allowed).toBe(true);
  });
});
