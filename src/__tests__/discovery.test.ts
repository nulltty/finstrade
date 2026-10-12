import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { whaleDiscovery } from '../services/discovery.js';
import { multiWalletScanner } from '../services/scanner.js';
import { computeProfile } from '../services/walletProfiler.js';
import { NormalizedTx } from '../services/solana.js';
import { prisma, connectDb, disconnectDb } from '../db/prisma.js';

const T0 = Date.UTC(2026, 0, 1);
let n = 0;
const tx = (minutes: number, solDelta: number, mint: string, delta: number): NormalizedTx => ({
  signature: `sig${n++}`,
  timestamp: T0 + minutes * 60000,
  failed: false,
  solDelta,
  stableDelta: 0,
  tokenDeltas: { [mint]: { delta, decimals: 6 } },
});

describe('Whale profiler (realised PnL from swap history)', () => {
  it('qualifies a wallet with consistent profitable round trips', () => {
    const txs: NormalizedTx[] = [];
    for (let i = 0; i < 6; i++) {
      const mint = `MINT${i}`;
      txs.push(tx(i * 100, -2, mint, 1000));
      txs.push(tx(i * 100 + 30, i === 5 ? 1.5 : 3, mint, -1000)); // 5 wins, 1 loss
    }
    const p = computeProfile('W1', txs, 150, 60, 5);
    expect(p.closedTrades).toBe(6);
    expect(p.wins).toBe(5);
    expect(p.realizedPnlSol).toBeCloseTo(4.5, 5);
    expect(p.qualified).toBe(true);
  });

  it('rejects a losing wallet', () => {
    const txs: NormalizedTx[] = [];
    for (let i = 0; i < 6; i++) {
      txs.push(tx(i * 100, -2, `L${i}`, 1000));
      txs.push(tx(i * 100 + 30, 1, `L${i}`, -1000));
    }
    const p = computeProfile('W2', txs, 150, 60, 5);
    expect(p.qualified).toBe(false);
    expect(p.winRate).toBe(0);
  });

  it('rejects sniper bots that flip within seconds', () => {
    const txs: NormalizedTx[] = [];
    for (let i = 0; i < 8; i++) {
      txs.push(tx(i * 10, -2, `B${i}`, 1000));
      txs.push(tx(i * 10 + 0.3, 2.5, `B${i}`, -1000));
    }
    const p = computeProfile('W3', txs, 150, 60, 5);
    expect(p.isLikelyBot).toBe(true);
    expect(p.qualified).toBe(false);
  });

  it('ignores positions that are still open (unrealised)', () => {
    const p = computeProfile('W4', [tx(0, -5, 'OPEN', 1000)], 150, 60, 1);
    expect(p.closedTrades).toBe(0);
  });
});

describe('Watchlist management', () => {
  beforeAll(async () => {
    await connectDb();
  });

  afterAll(async () => {
    await disconnectDb();
  });

  it('should allow adding, toggling, and removing a custom whale wallet', async () => {
    const testAddress = 'CustomWhaleTest1111111111111111111111111111';
    const created = await whaleDiscovery.addWallet({ address: testAddress, chain: 'solana', label: 'Alpha Whale Test', tags: ['test'] });
    expect(created.address).toBe(testAddress);
    expect(created.isActive).toBe(true);

    const toggled = await whaleDiscovery.toggleWallet(created.id);
    expect(toggled.isActive).toBe(false);

    await whaleDiscovery.deleteWallet(created.id);
    const found = await prisma.watchedWallet.findUnique({ where: { id: created.id } });
    expect(found).toBeNull();
  });

  it('should run scanner without throwing errors', async () => {
    const result = await multiWalletScanner.scanAllActiveWallets();
    expect(result.scannedCount).toBeGreaterThanOrEqual(0);
  }, 60000);
});
