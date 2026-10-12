import { describe, it, expect } from 'vitest';
import { scoringEngine } from '../services/scoring.js';
import { AggregatedTokenMetrics } from '../services/aggregator.js';

describe('Scoring Engine (Blueprint Section 2.3)', () => {
  it('should trigger hard fail when token is a honeypot', () => {
    const honeypotToken: AggregatedTokenMetrics = {
      liquidityUsd: 50000,
      isLiquidityLocked: true,
      lockedPercentage: 100,
      top10HoldersPercent: 15,
      isHoneypot: true, // HONEYPOT!
      hasMintFunction: false,
      isOwnershipRenounced: true,
      contractVerified: true,
      volume24h: 30000,
      marketCap: 100000,
      volumeMcRatio: 0.3,
      tokenAgeHours: 24,
      holderCount: 500,
      symbol: 'SCAM',
      name: 'Scam Token',
      priceUsd: 0.01,
    };

    const result = scoringEngine.calculateScore(honeypotToken);

    expect(result.isHardFail).toBe(true);
    expect(result.passedThreshold).toBe(false);
    expect(result.totalScore).toBeLessThanOrEqual(15);
    expect(result.hardFailReasons).toContain('Honeypot detected by GoPlus Security API');
  });

  it('should trigger hard fail when liquidity is unlocked and under $5K', () => {
    const lowLiquidityToken: AggregatedTokenMetrics = {
      liquidityUsd: 3000, // < $5k
      isLiquidityLocked: false, // Not locked!
      lockedPercentage: 0,
      top10HoldersPercent: 20,
      isHoneypot: false,
      hasMintFunction: false,
      isOwnershipRenounced: true,
      contractVerified: true,
      volume24h: 1000,
      marketCap: 10000,
      volumeMcRatio: 0.1,
      tokenAgeHours: 5,
      holderCount: 200,
      symbol: 'RISK',
      name: 'Risk Token',
      priceUsd: 0.005,
    };

    const result = scoringEngine.calculateScore(lowLiquidityToken);

    expect(result.isHardFail).toBe(true);
    expect(result.passedThreshold).toBe(false);
  });

  it('should give score >= 80 to high quality meme token', () => {
    const solidToken: AggregatedTokenMetrics = {
      liquidityUsd: 120000,
      isLiquidityLocked: true,
      lockedPercentage: 99,
      top10HoldersPercent: 18, // well distributed
      isHoneypot: false,
      hasMintFunction: false,
      isOwnershipRenounced: true,
      contractVerified: true,
      volume24h: 80000,
      marketCap: 250000,
      volumeMcRatio: 0.32,
      tokenAgeHours: 48,
      holderCount: 1200,
      symbol: 'CHILL',
      name: 'Chill Guy',
      priceUsd: 0.05,
    };

    const result = scoringEngine.calculateScore(solidToken);

    expect(result.isHardFail).toBe(false);
    expect(result.totalScore).toBeGreaterThanOrEqual(80);
    expect(result.passedThreshold).toBe(true);
    expect(result.breakdown.liquidity.score).toBeGreaterThanOrEqual(90);
    expect(result.breakdown.holderConcentration.score).toBe(100);
  });

  it('should penalize tokens less than 1 hour old and concentrated holders', () => {
    const brandNewConcentratedToken: AggregatedTokenMetrics = {
      liquidityUsd: 20000,
      isLiquidityLocked: true,
      lockedPercentage: 80,
      top10HoldersPercent: 65, // concentrated
      isHoneypot: false,
      hasMintFunction: false,
      isOwnershipRenounced: true,
      contractVerified: true,
      volume24h: 5000,
      marketCap: 50000,
      volumeMcRatio: 0.1,
      tokenAgeHours: 0.3, // 18 minutes old!
      holderCount: 40,
      symbol: 'NEW',
      name: 'Brand New',
      priceUsd: 0.001,
    };

    const result = scoringEngine.calculateScore(brandNewConcentratedToken);

    expect(result.passedThreshold).toBe(false);
    expect(result.totalScore).toBeLessThan(80);
  });
});
