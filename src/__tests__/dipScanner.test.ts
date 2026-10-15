import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const MINT = 'DipScanMint11111111111111111111111111111111';

// Chain and market data are stubbed; what is under test is the scanner's own pipeline —
// market filter → reversal → narrative → safety → signal → paper fill.
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
        ? { outAmount: '1000000000', priceImpactPct: '0.004' } // 0.3 SOL buys 1000 tokens
        : { outAmount: '300000000', priceImpactPct: '0.004' }) as any,
  };
});

vi.mock('../services/indicators.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/indicators.js')>();
  // Uptrend → sell-off into oversold → two bars turning back up
  const closes = [
    ...Array.from({ length: 50 }, (_, i) => 60 + i * 0.8),
    ...Array.from({ length: 10 }, (_, i) => 99 - (i + 1) * 3.2),
    68.5,
    70.5,
  ];
  const candles = closes.map((c, i) => ({
    t: Date.UTC(2026, 0, 1) + i * 900000,
    o: c,
    h: c * 1.01,
    l: c * 0.99,
    c,
    v: 1000,
  }));
  return { ...actual, fetchCandles: async () => ({ candles, source: 'geckoterminal' as const }) };
});

import { dipReversalScanner } from '../services/dipScanner.js';
import { tokenDataAggregator } from '../services/aggregator.js';
import { circuitBreaker } from '../services/circuitBreaker.js';
import { settingsService } from '../services/settings.js';
import { prisma, connectDb, disconnectDb } from '../db/prisma.js';

const pair = {
  baseToken: { address: MINT, symbol: 'AIDOGE', name: 'AI Agent Doge' },
  pairAddress: 'DipScanPair1111111111111111111111111111111',
  priceUsd: '0.03',
  liquidity: { usd: 120000 },
  volume: { h24: 400000 },
  pairCreatedAt: Date.now() - 72 * 3600 * 1000,
  priceChange: { m5: 0.4, h1: -3.5, h6: -8, h24: 12 },
  txns: { h1: { buys: 120, sells: 90 } },
  info: { socials: [{ type: 'twitter' }, { type: 'telegram' }], websites: [{ url: 'https://example.com' }] },
  boosts: { active: 1 },
};

const metrics = {
  liquidityUsd: 120000,
  isLiquidityLocked: true,
  lockedPercentage: 100,
  top10HoldersPercent: 18,
  isHoneypot: false,
  hasMintFunction: false,
  isOwnershipRenounced: true,
  contractVerified: true,
  volume24h: 400000,
  marketCap: 1500000,
  volumeMcRatio: 400000 / 1500000,
  tokenAgeHours: 72,
  holderCount: 4200,
  symbol: 'AIDOGE',
  name: 'AI Agent Doge',
  priceUsd: 0.03,
  hasFreezeAuthority: false,
  rugged: false,
  sellRouteOk: true,
  roundTripLossPct: 2,
  buyPriceImpactPct: 0.4,
  transferFeePct: 0,
  honeypotReasons: [],
  riskFlags: [],
  insidersDetected: 0,
  socials: ['twitter', 'telegram'],
  websites: 1,
  boosts: 1,
  dataSources: { dexscreener: true, goplus: true, rugcheck: true, jupiter: true },
};

describe('Dip reversal scanner (end to end, stubbed market data)', () => {
  beforeAll(async () => {
    await connectDb();
    await prisma.position.deleteMany({ where: { tokenAddress: MINT } });
    await prisma.signal.deleteMany({ where: { tokenAddress: MINT } });
    await settingsService.updateSettings({
      paperTrading: true,
      autoTradeMode: true,
      dipStrategyEnabled: true,
      dipEntrySol: 0.3,
      dipTakeProfitUsd: 4,
      dipTakeProfitMaxUsd: 5,
      dipStopLossPercent: 30,
      dipMaxOpenPositions: 3,
      dipRsiOversold: 40,
      dipRsiMax: 55,
      dipMinNarrativeScore: 45,
      dipScoringThreshold: 70,
      maxOpenPositions: 5,
      maxDailySpendUsd: 200,
    });
    circuitBreaker.reset();

    vi.spyOn(tokenDataAggregator, 'fetchTrendingMints').mockResolvedValue({
      mints: [MINT],
      descriptions: new Map([[MINT, 'An autonomous AI agent dog trading on Solana for its holders.']]),
    });
    vi.spyOn(tokenDataAggregator, 'fetchPairsForMints').mockResolvedValue(new Map([[MINT, pair]]));
    vi.spyOn(tokenDataAggregator, 'collect').mockResolvedValue(metrics as any);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await prisma.position.deleteMany({ where: { tokenAddress: MINT } });
    await prisma.signal.deleteMany({ where: { tokenAddress: MINT } });
    await disconnectDb();
  });

  it('turns an oversold healthy coin into a 0.3 SOL paper position with a $4–$5 exit plan', async () => {
    const result = await dipReversalScanner.runScanCycle();
    expect(result.skipped).toBeUndefined();
    expect(result).toMatchObject({ candidates: 1, technicalPass: 1, narrativePass: 1, safetyPass: 1, entered: 1 });

    const signal = await prisma.signal.findFirst({ where: { tokenAddress: MINT }, include: { score: true } });
    expect(signal?.source).toBe('dip_reversal');
    expect(signal?.status).toBe('bought');
    expect(signal?.decision).toBe('auto_buy');
    expect(signal?.score?.totalScore).toBeGreaterThanOrEqual(70);
    const meta = signal!.strategyMeta as any;
    expect(meta.rsi).toBeLessThan(55);
    expect(meta.narrativeScore).toBeGreaterThanOrEqual(45);
    expect(meta.narrative).toBe('ai');

    const position = await prisma.position.findFirst({ where: { tokenAddress: MINT } });
    expect(position).toMatchObject({
      strategy: 'dip_reversal',
      tpUsdTarget: 4,
      tpUsdStretch: 5,
      slPercentOverride: 30,
      isPaper: true,
      status: 'open',
    });
    // 0.3 SOL plus the swap's own costs — never a silently shrunk position
    expect(position!.costSol).toBeGreaterThanOrEqual(0.3);
    expect(position!.costSol).toBeLessThan(0.31);
    // A scanner signal has no whale behind it
    expect(position!.whaleWallet).toBeNull();
  });

  it('does not touch the same token again while it is held', async () => {
    const result = await dipReversalScanner.runScanCycle();
    expect(result.candidates).toBe(0);
    expect(result.entered).toBe(0);
    expect(await prisma.position.count({ where: { tokenAddress: MINT } })).toBe(1);
  });

  it('does nothing at all while the strategy is switched off', async () => {
    await settingsService.updateSettings({ dipStrategyEnabled: false });
    const result = await dipReversalScanner.runScanCycle();
    expect(result.skipped).toBe('strategy disabled');
    await settingsService.updateSettings({ dipStrategyEnabled: true });
  });
});
