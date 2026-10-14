import { prisma } from '../db/prisma.js';
import { whaleWatcherService, WhaleSwapEvent } from './watcher.js';
import { getRecentWalletTxs, getLatestSignature, getSolPriceUsd, NormalizedTx } from './solana.js';
import { settingsService, BotSettingsData } from './settings.js';
import { audit } from './audit.js';
import { logger } from './logger.js';

const WALLETS_PER_PASS = 30;
const TXS_PER_WALLET = 15;

export class MultiWalletScanner {
  private isScanning = false;

  /**
   * Scan all active watched wallets for new swaps since their last seen signature.
   * Buys become signals; sells of a token we copied trigger a copy-sell.
   */
  async scanAllActiveWallets(): Promise<{ scannedCount: number; signalsFound: number; whaleExits: number }> {
    if (this.isScanning) {
      logger.debug('Scan already in progress, skipping overlapping run');
      return { scannedCount: 0, signalsFound: 0, whaleExits: 0 };
    }

    this.isScanning = true;
    let scannedCount = 0;
    let signalsFound = 0;
    let whaleExits = 0;

    try {
      const wallets = await prisma.watchedWallet.findMany({
        where: { isActive: true, chain: 'solana' },
        orderBy: { lastScannedAt: { sort: 'asc', nulls: 'first' } }, // least recently scanned first
        take: WALLETS_PER_PASS,
      });
      const solPrice = await getSolPriceUsd();
      const settings = await settingsService.getSettings();

      for (const wallet of wallets) {
        try {
          // First sighting: only record a baseline so we never trade on stale history
          if (!wallet.lastTxHash) {
            const latest = await getLatestSignature(wallet.address);
            await prisma.watchedWallet.update({
              where: { id: wallet.id },
              data: { lastScannedAt: new Date(), lastTxHash: latest ?? null },
            });
            scannedCount++;
            continue;
          }

          const { txs, newestSignature } = await getRecentWalletTxs(wallet.address, {
            limit: TXS_PER_WALLET,
            until: wallet.lastTxHash,
          });
          scannedCount++;

          // Oldest first so buy → sell sequences are handled in order
          for (const tx of [...txs].reverse()) {
            const r = await this.handleWhaleTx(wallet.address, tx, solPrice, settings);
            signalsFound += r.signals;
            whaleExits += r.exits;
          }

          await prisma.watchedWallet.update({
            where: { id: wallet.id },
            data: { lastScannedAt: new Date(), lastTxHash: newestSignature || wallet.lastTxHash },
          });
        } catch (walletErr: any) {
          logger.warn({ address: wallet.address, err: walletErr?.message }, 'Failed to scan wallet');
        }
      }
    } finally {
      this.isScanning = false;
    }

    logger.info({ scannedCount, signalsFound, whaleExits }, 'Multi-wallet scanner pass completed');
    return { scannedCount, signalsFound, whaleExits };
  }

  /**
   * Process one parsed whale tx: buys become signals, sells of a token we copied trigger a
   * copy-sell. Shared by the polling scanner and the Helius webhook push so a pushed tx and
   * a polled tx behave identically — the webhook is just the faster way to arrive here.
   */
  async handleWhaleTx(
    wallet: string,
    tx: NormalizedTx,
    solPrice: number,
    settings: BotSettingsData,
    rawTx?: Record<string, any>
  ): Promise<{ signals: number; exits: number }> {
    if (tx.failed) return { signals: 0, exits: 0 };

    let signals = 0;
    for (const ev of this.extractBuys(wallet, tx, solPrice)) {
      if ((ev.amountUsd || 0) < settings.minWhaleBuyUsd) continue;
      if (rawTx) ev.rawTx = rawTx;
      const res = await whaleWatcherService.processEvent(ev);
      if (!res.skipped) signals++;
    }
    if (signals > 0) {
      await prisma.watchedWallet.updateMany({
        where: { address: wallet, chain: 'solana' },
        data: { signalsTriggered: { increment: signals } },
      });
    }

    const exits = settings.copySellEnabled ? await this.handleWhaleSells(wallet, tx) : 0;
    return { signals, exits };
  }

  /** A buy = wallet received a non-base token while spending SOL/stables */
  extractBuys(wallet: string, tx: NormalizedTx, solPrice: number): WhaleSwapEvent[] {
    const quoteSol = tx.solDelta + (solPrice > 0 ? tx.stableDelta / solPrice : 0);
    if (quoteSol >= -0.01) return [];

    const received = Object.entries(tx.tokenDeltas).filter(([, v]) => v.delta > 0);
    if (received.length === 0) return [];
    const [mint, info] = received.sort((a, b) => b[1].delta - a[1].delta)[0];

    const amountUsd = -quoteSol * solPrice;
    const whaleEntryAmount = info.delta;
    const whaleEntryPrice = whaleEntryAmount > 0 ? amountUsd / whaleEntryAmount : undefined;

    return [
      {
        wallet,
        chain: 'solana',
        tokenAddress: mint,
        txHash: tx.signature,
        amountUsd,
        whaleSolSpent: -quoteSol,
        whaleEntryAmount,
        whaleEntryPrice,
        timestamp: tx.timestamp,
      },
    ];
  }

  /** Copy-sell: the whale that gave us the entry is dumping the same token */
  private async handleWhaleSells(wallet: string, tx: NormalizedTx): Promise<number> {
    const sold = Object.entries(tx.tokenDeltas).filter(([, v]) => v.delta < 0).map(([mint]) => mint);
    if (sold.length === 0) return 0;

    const positions = await prisma.position.findMany({
      where: { status: 'open', whaleWallet: wallet, tokenAddress: { in: sold } },
    });
    for (const pos of positions) {
      logger.warn({ positionId: pos.id, wallet, token: pos.tokenAddress }, 'Whale exited token — copy-selling');
      await audit('WHALE_EXIT_DETECTED', `Source whale sold ${pos.tokenSymbol}; copy-selling`, { positionId: pos.id, wallet, tx: tx.signature });
      const { tradeExecutor } = await import('./executor.js');
      await tradeExecutor.executeSell(pos.id, 'whale_exit');
    }
    return positions.length;
  }
}

export const multiWalletScanner = new MultiWalletScanner();
