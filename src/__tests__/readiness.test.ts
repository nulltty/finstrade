import { describe, it, expect } from 'vitest';
import { summarize, ReadinessTrade } from '../services/readiness.js';

const t = (pnlPct: number, haircut = 6, cost = 10): ReadinessTrade => ({
  symbol: 'T', token: 'x', strategy: 'whale_copy', isPaper: true, openedAt: '', closedAt: '', holdMinutes: 30,
  costUsd: cost, pnlUsd: (cost * pnlPct) / 100, pnlPct,
  adjPnlUsd: (cost * (pnlPct - haircut)) / 100, adjPnlPct: pnlPct - haircut,
  exitReason: 'trailing_stop', score: 85, roundTripLossPct: null, buyPriceImpactPct: null, whale: 'w', whaleWinRate: 70,
});

describe('Live readiness summary', () => {
  it('applies the cost haircut: small paper wins become losses', () => {
    const s = summarize([t(4), t(5), t(3)]);
    expect(s.rawTotalPnlUsd).toBeGreaterThan(0);
    expect(s.adjTotalPnlUsd).toBeLessThan(0);
    expect(s.expectancyAdjPct).toBeLessThan(0);
  });

  it('detects a record carried by one lucky trade', () => {
    const s = summarize([t(-20), t(-20), t(-20), t(400)]);
    expect(s.adjTotalPnlUsd).toBeGreaterThan(0);
    expect(s.adjTotalWithoutBestUsd).toBeLessThan(0);
  });

  it('measures max drawdown on the cost-adjusted equity curve', () => {
    // +94%, −26%, −26%, +44% of $10 → peak 9.4, trough 4.2 → drawdown 5.2
    const s = summarize([t(100), t(-20), t(-20), t(50)]);
    expect(s.maxDrawdownUsd).toBeCloseTo(5.2, 5);
    expect(s.profitFactor).toBeCloseTo((9.4 + 4.4) / 5.2, 2);
  });
});
