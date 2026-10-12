import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { whaleDiscovery } from '../services/discovery.js';
import { multiWalletScanner } from '../services/scanner.js';
import { prisma, connectDb, disconnectDb } from '../db/prisma.js';

describe('Multi-Wallet Discovery & Scanner Tests', () => {
  beforeAll(async () => {
    await connectDb();
  });

  afterAll(async () => {
    await disconnectDb();
  });

  it('should seed curated whale wallets into database', async () => {
    const seeded = await whaleDiscovery.seedCuratedWallets();
    const count = await prisma.watchedWallet.count();
    expect(count).toBeGreaterThanOrEqual(5);

    const solanaWhales = await whaleDiscovery.getActiveWallets('solana');
    expect(solanaWhales.length).toBeGreaterThanOrEqual(4);
    expect(solanaWhales[0].address).toBeDefined();
  });

  it('should allow adding, toggling, and removing a custom whale wallet', async () => {
    const testAddress = 'CustomWhaleTest1111111111111111111111111111';
    const created = await whaleDiscovery.addWallet({
      address: testAddress,
      chain: 'solana',
      label: 'Alpha Whale Test',
      tags: ['test', 'insider'],
    });

    expect(created.address).toBe(testAddress);
    expect(created.isActive).toBe(true);

    // Toggle to paused
    const toggled = await whaleDiscovery.toggleWallet(created.id);
    expect(toggled.isActive).toBe(false);

    // Delete
    await whaleDiscovery.deleteWallet(created.id);
    const found = await prisma.watchedWallet.findUnique({ where: { id: created.id } });
    expect(found).toBeNull();
  });

  it('should run scanner without throwing errors', async () => {
    const result = await multiWalletScanner.scanAllActiveWallets();
    expect(result.scannedCount).toBeGreaterThanOrEqual(0);
    expect(result.signalsFound).toBeGreaterThanOrEqual(0);
  });
});
