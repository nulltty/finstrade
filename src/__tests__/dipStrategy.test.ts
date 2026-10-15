import { describe, it, expect } from 'vitest';
import { rsiSeries, emaSeries, evaluateReversal, Candle } from '../services/indicators.js';
import { scoreNarrative } from '../services/narrative.js';
import { entryPlanFor } from '../services/executor.js';
import type { BotSettingsData } from '../services/settings.js';

const last = (xs: number[]) => xs[xs.length - 1];

/** Candle builder: only close/volume matter for RSI, highs/lows are derived from the close */
const candle = (i: number, close: number, volume = 1000): Candle => ({
  t: Date.UTC(2026, 0, 1) + i * 15 * 60000,
  o: close,
  h: close * 1.01,
  l: close * 0.99,
  c: close,
  v: volume,
});

const series = (closes: number[], volumes?: number[]) => closes.map((c, i) => candle(i, c, volumes?.[i] ?? 1000));

describe('RSI / EMA', () => {
  it('reads 100 on an uninterrupted rise and 0 on an uninterrupted fall', () => {
    const up = Array.from({ length: 40 }, (_, i) => 1 + i * 0.1);
    const down = [...up].reverse();
    expect(last(rsiSeries(up, 14))).toBeCloseTo(100, 6);
    expect(last(rsiSeries(down, 14))).toBeCloseTo(0, 6);
  });

  it('sits near 50 when gains and losses are symmetric', () => {
    const flip = Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? 100 : 101));
    expect(last(rsiSeries(flip, 14))).toBeGreaterThan(40);
    expect(last(rsiSeries(flip, 14))).toBeLessThan(60);
  });

  it('leaves the first `period` entries undefined rather than guessing them', () => {
    const r = rsiSeries(Array.from({ length: 20 }, (_, i) => 100 + i), 14);
    expect(r.slice(0, 14).every(Number.isNaN)).toBe(true);
    expect(Number.isFinite(r[14])).toBe(true);
  });

  it('turns back up as soon as price does, while still reading low', () => {
    const closes = [...Array.from({ length: 30 }, (_, i) => 100 - i * 1.5), 56, 58];
    const rsi = rsiSeries(closes, 14);
    expect(last(rsi)).toBeGreaterThan(rsi[rsi.length - 3]);
    expect(last(rsi)).toBeLessThan(50);
  });

  it('computes an EMA seeded on the SMA of the first window', () => {
    const flat = new Array(30).fill(50);
    expect(last(emaSeries(flat, 21))).toBeCloseTo(50, 6);
    expect(emaSeries(flat, 21).slice(0, 20).every(Number.isNaN)).toBe(true);
  });
});

describe('Dip reversal setup', () => {
  // A healthy uptrend, a sell-off into oversold, then two bars turning back up
  const uptrend = Array.from({ length: 50 }, (_, i) => 60 + i * 0.8); // 60 → ~99
  const selloff = Array.from({ length: 10 }, (_, i) => 99 - (i + 1) * 3.2); // ~99 → ~67
  const turnUp = [68.5, 70.5];

  it('accepts an oversold pullback that is turning up inside an intact trend', () => {
    const r = evaluateReversal(series([...uptrend, ...selloff, ...turnUp]), { oversold: 40, rsiMax: 55 });
    expect(r.reasons).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.rsi!).toBeLessThan(55);
    expect(r.rsi!).toBeGreaterThan(r.rsiLow!);
    expect(r.bounceFromLowPct!).toBeGreaterThan(0.5);
  });

  it('rejects a token still in free fall — oversold alone is not a signal', () => {
    const r = evaluateReversal(series([...uptrend, ...selloff]), { oversold: 40, rsiMax: 55 });
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toContain('turning_up');
  });

  it('rejects a bounce that already happened without us', () => {
    const recovered = [...uptrend, ...selloff, ...Array.from({ length: 8 }, (_, i) => 68 + (i + 1) * 4)];
    const r = evaluateReversal(series(recovered), { oversold: 40, rsiMax: 50 });
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toContain('not_recovered');
  });

  it('rejects a setup whose pool has gone quiet', () => {
    const closes = [...uptrend, ...selloff, ...turnUp];
    const volumes = closes.map((_, i) => (i >= closes.length - 3 ? 10 : 5000));
    const r = evaluateReversal(series(closes, volumes), { oversold: 40, rsiMax: 55 });
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toContain('volume_alive');
  });

  it('rejects a chart that is too short to judge', () => {
    const r = evaluateReversal(series([100, 99, 98, 97, 96]));
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toContain('not enough candles');
  });
});

describe('Narrative check', () => {
  it('scores a recognisable narrative with socials above a nameless clone', () => {
    const strong = scoreNarrative({
      symbol: 'AIDOGE',
      name: 'AI Agent Doge',
      description: 'An autonomous AI agent dog that trades on Solana for its holders.',
      socials: ['twitter', 'telegram'],
      websites: 1,
      boosts: 1,
    });
    const weak = scoreNarrative({ symbol: 'ZXQW', name: 'Zxqw' });
    expect(strong.score).toBeGreaterThan(weak.score);
    expect(strong.narrative).toBe('ai');
    expect(strong.tags).toContain('animal');
    expect(weak.score).toBeLessThan(45);
  });

  it('penalises clone and scam wording', () => {
    const clone = scoreNarrative({ symbol: 'PEPE2.0', name: 'Pepe V2 test', socials: ['twitter'] });
    const original = scoreNarrative({ symbol: 'PEPE', name: 'Pepe', socials: ['twitter'] });
    expect(clone.score).toBeLessThan(original.score);
    expect(clone.tags).toContain('red-flag');
  });

  it('counts the keywords the user tracks', () => {
    const base = { symbol: 'QQQ', name: 'Triple Q' };
    expect(scoreNarrative({ ...base, extraKeywords: ['triple'] }).score).toBeGreaterThan(scoreNarrative(base).score);
  });
});

describe('Entry plan per strategy', () => {
  const settings = {
    tradeAmountUsd: 25,
    maxPriceImpactPct: 5,
    positionSizeMode: 'fixed_usd',
    dipEntrySol: 0.3,
    dipTakeProfitUsd: 4,
    dipTakeProfitMaxUsd: 5,
    dipStopLossPercent: 30,
    dipTrailingStopPercent: 0,
    dipMaxOpenPositions: 3,
    dipMaxPriceImpactPct: 1.5,
  } as unknown as BotSettingsData;

  it('sizes the dip strategy in SOL with its own $ exits and tighter impact limit', () => {
    const plan = entryPlanFor('dip_reversal', settings);
    expect(plan).toMatchObject({
      strategy: 'dip_reversal',
      sizeSol: 0.3,
      tpUsdTarget: 4,
      tpUsdStretch: 5,
      slPercentOverride: 30,
      maxOpenForStrategy: 3,
      maxPriceImpactPct: 1.5,
    });
  });

  it('leaves whale copy-trades on the global settings', () => {
    const plan = entryPlanFor('whale_copy', settings);
    expect(plan.sizeSol).toBeNull();
    expect(plan.tpUsdTarget).toBeNull();
    expect(plan.slPercentOverride).toBeNull();
    expect(plan.maxPriceImpactPct).toBe(5);
  });

  it('never lets the stretch target sit below the minimum target', () => {
    const plan = entryPlanFor('dip_reversal', { ...settings, dipTakeProfitMaxUsd: 2 } as BotSettingsData);
    expect(plan.tpUsdStretch).toBe(4);
  });
});
