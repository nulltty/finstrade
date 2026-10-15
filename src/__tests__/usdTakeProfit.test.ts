import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// The $-target exit decides on what the position would actually fetch, so the Jupiter quote is
// the input under test here. `sell.outLamports` is what each case puts in the pool.
const mocks = vi.hoisted(() => ({ sell: { outLamports: '360000000' } }));

vi.mock('../services/solana.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/solana.js')>();
  const WSOL = 'So11111111111111111111111111111111111111112';
  return {
    ...actual,
    getSolPriceUsd: async () => 100,
    getMintDecimals: async () => 6,
    getTradingKeypair: async () => null,
    getJupiterQuote: async (inputMint: string) =>
      (inputMint === WSOL
        ? { outAmount: '1000000000', priceImpactPct: '0.002' }
        : { outAmount: mocks.sell.outLamports, priceImpactPct: '0.002' }) as any,
  };
});

import { positionMonitor } from '../services/monitor.js';
import { prisma, connectDb, disconnectDb } from '../db/prisma.js';
import { settingsService } from '../services/settings.js';

const TOKEN = 'DipTestMint1111111111111111111111111111111';
const ENTRY_PRICE = 0.03;
const ENTRY_AMOUNT = 1000; // 1000 tokens at 6 decimals
const COST_USD = 30; // 0.3 SOL at a mocked SOL price of $100

/**
 * Net profit a case is aiming for, in USD: the quote's SOL out, minus the exit swap's fees,
 * priced at the mocked $100 SOL, minus the cost basis.
 */
function outLamportsForNetProfit(usd: number) {
  const settings = { maxPriorityFee: 0.001 };
  const exitFeeSol = settings.maxPriorityFee + 0.000005;
  const solNeeded = (COST_USD + usd) / 100 + exitFeeSol;
  return String(Math.round(solNeeded * 1e9));
}

async function openDipPosition(overrides: Record<string, any> = {}) {
  return prisma.position.create({
    data: {
      strategy: 'dip_reversal',
      chain: 'solana',
      tokenAddress: TOKEN,
      tokenSymbol: 'DIPTEST',
      entryPrice: ENTRY_PRICE,
      entryAmount: ENTRY_AMOUNT,
      entryRawAmount: String(ENTRY_AMOUNT * 1e6),
      tokenDecimals: 6,
      costUsd: COST_USD,
      costSol: 0.3,
      currentPrice: ENTRY_PRICE,
      peakPrice: ENTRY_PRICE,
      tpUsdTarget: 4,
      tpUsdStretch: 5,
      slPercentOverride: 30,
      trailPercentOverride: 0,
      isPaper: true,
      status: 'open',
      ...overrides,
    },
  });
}

describe('Absolute-USD take profit ($4–$5 per trade)', () => {
  beforeAll(async () => {
    await connectDb();
    // Autopilot, so exits execute instead of asking for approval
    await settingsService.updateSettings({ autoTradeMode: true, paperTrading: true, slippageBps: 500, maxPriorityFee: 0.001 });
  });

  afterAll(async () => {
    await prisma.position.deleteMany({ where: { tokenAddress: TOKEN } });
    await disconnectDb();
  });

  beforeEach(async () => {
    await prisma.trade.deleteMany({ where: { tokenAddress: TOKEN } });
    await prisma.position.deleteMany({ where: { tokenAddress: TOKEN } });
  });

  it('holds while the realisable profit is still below the target', async () => {
    mocks.sell.outLamports = outLamportsForNetProfit(2.5);
    const pos = await openDipPosition();

    await positionMonitor.evaluatePosition(pos.id, ENTRY_PRICE * 1.1);

    const after = await prisma.position.findUnique({ where: { id: pos.id } });
    expect(after?.status).toBe('open');
    expect(after?.trailingActive).toBe(false);
  });

  it('banks the position once the target is reached and the price stops climbing', async () => {
    mocks.sell.outLamports = outLamportsForNetProfit(4.2);
    // Peak already above the price we are about to see: the move is over
    const pos = await openDipPosition({ peakPrice: ENTRY_PRICE * 1.3 });

    await positionMonitor.evaluatePosition(pos.id, ENTRY_PRICE * 1.2);

    const after = await prisma.position.findUnique({ where: { id: pos.id } });
    expect(after?.status).toBe('closed');
    expect(after?.exitReason).toBe('take_profit_usd');
    const pnlUsd = (after!.proceedsUsd || 0) - after!.costUsd;
    expect(pnlUsd).toBeGreaterThanOrEqual(4);
    expect(pnlUsd).toBeLessThanOrEqual(5);
  });

  it('keeps riding toward the stretch target while the price is still making highs', async () => {
    mocks.sell.outLamports = outLamportsForNetProfit(4.2);
    const pos = await openDipPosition({ peakPrice: ENTRY_PRICE * 1.1 });

    await positionMonitor.evaluatePosition(pos.id, ENTRY_PRICE * 1.2);

    const after = await prisma.position.findUnique({ where: { id: pos.id } });
    expect(after?.status).toBe('open');
    expect(after?.trailingActive).toBe(true);
  });

  it('sells immediately at the stretch target, climbing or not', async () => {
    mocks.sell.outLamports = outLamportsForNetProfit(6);
    const pos = await openDipPosition({ peakPrice: ENTRY_PRICE });

    await positionMonitor.evaluatePosition(pos.id, ENTRY_PRICE * 1.5);

    const after = await prisma.position.findUnique({ where: { id: pos.id } });
    expect(after?.status).toBe('closed');
    expect(after?.exitReason).toBe('take_profit_usd');
  });

  it('banks what is left when a position that reached the target fades back', async () => {
    mocks.sell.outLamports = outLamportsForNetProfit(3.2);
    const pos = await openDipPosition({ trailingActive: true, peakPrice: ENTRY_PRICE * 1.4 });

    await positionMonitor.evaluatePosition(pos.id, ENTRY_PRICE * 1.1);

    const after = await prisma.position.findUnique({ where: { id: pos.id } });
    expect(after?.status).toBe('closed');
    expect(after?.exitReason).toBe('take_profit_usd');
  });

  it('uses the per-position stop-loss, not the global one', async () => {
    mocks.sell.outLamports = outLamportsForNetProfit(-10);
    const pos = await openDipPosition();

    // −25% would already be a stop-loss on the global 20% setting; this position allows 30%
    await positionMonitor.evaluatePosition(pos.id, ENTRY_PRICE * 0.75);
    expect((await prisma.position.findUnique({ where: { id: pos.id } }))?.status).toBe('open');

    await positionMonitor.evaluatePosition(pos.id, ENTRY_PRICE * 0.69);
    const after = await prisma.position.findUnique({ where: { id: pos.id } });
    expect(after?.status).toBe('closed');
    expect(after?.exitReason).toBe('stop_loss');
  });
});
