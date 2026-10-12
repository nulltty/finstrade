import { prisma } from '../db/prisma.js';
import { env } from '../config/index.js';
import { whaleWatcherService, WhaleSwapEvent } from './watcher.js';
import { logger } from './logger.js';

export class MultiWalletScanner {
  private isScanning = false;

  /**
   * Scan all active watched wallets in database for new transactions
   */
  async scanAllActiveWallets(): Promise<{ scannedCount: number; signalsFound: number }> {
    if (this.isScanning) {
      logger.warn('Scan already in progress, skipping overlapping run');
      return { scannedCount: 0, signalsFound: 0 };
    }

    this.isScanning = true;
    let scannedCount = 0;
    let signalsFound = 0;

    try {
      const wallets = await prisma.watchedWallet.findMany({
        where: { isActive: true },
        orderBy: { lastScannedAt: 'asc' }, // scan least recently scanned first
        take: 30, // scan in batches to avoid RPC rate limits
      });

      logger.info({ count: wallets.length }, 'Starting multi-wallet on-chain scanner pass');

      for (const wallet of wallets) {
        try {
          const events = await this.scanWallet(wallet.address, wallet.chain, wallet.lastTxHash || undefined);
          scannedCount++;

          for (const ev of events) {
            const res = await whaleWatcherService.processEvent(ev);
            if (!res.skipped) {
              signalsFound++;
              logger.info({ wallet: wallet.address, token: ev.tokenAddress }, 'New whale trade detected via multi-scanner');
            }
          }

          // Update lastScannedAt and lastTxHash
          const latestTxHash = events.length > 0 ? events[0].txHash : wallet.lastTxHash;
          await prisma.watchedWallet.update({
            where: { id: wallet.id },
            data: {
              lastScannedAt: new Date(),
              lastTxHash: latestTxHash,
            },
          });
        } catch (walletErr: any) {
          logger.warn({ address: wallet.address, err: walletErr?.message }, 'Failed to scan wallet');
        }
      }
    } finally {
      this.isScanning = false;
    }

    logger.info({ scannedCount, signalsFound }, 'Multi-wallet scanner pass completed');
    return { scannedCount, signalsFound };
  }

  /**
   * Scan an individual wallet on Solana or EVM
   */
  async scanWallet(address: string, chain: string, lastKnownTxHash?: string): Promise<WhaleSwapEvent[]> {
    if (chain === 'solana') {
      return this.scanSolanaWallet(address, lastKnownTxHash);
    } else {
      return this.scanEvmWallet(address, lastKnownTxHash);
    }
  }

  /**
   * Query recent Solana transactions via RPC
   */
  private async scanSolanaWallet(address: string, lastKnownTxHash?: string): Promise<WhaleSwapEvent[]> {
    try {
      // Use standard JSON-RPC getSignaturesForAddress
      const body = {
        jsonrpc: '2.0',
        id: 1,
        method: 'getSignaturesForAddress',
        params: [
          address,
          {
            limit: 5,
            ...(lastKnownTxHash ? { until: lastKnownTxHash } : {}),
          },
        ],
      };

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const res = await fetch(env.SOLANA_RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) return [];
      const json = await res.json() as any;
      const signatures = json.result;

      if (!signatures || !Array.isArray(signatures) || signatures.length === 0) {
        return [];
      }

      const events: WhaleSwapEvent[] = [];

      // If we see new signatures, parse the first one (most recent)
      for (const sigInfo of signatures.slice(0, 2)) {
        if (sigInfo.err) continue; // skip failed tx

        // Fetch parsed transaction
        const txBody = {
          jsonrpc: '2.0',
          id: 1,
          method: 'getParsedTransaction',
          params: [
            sigInfo.signature,
            { maxSupportedTransactionVersion: 0, encoding: 'jsonParsed' },
          ],
        };

        const txRes = await fetch(env.SOLANA_RPC_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(txBody),
        });

        if (!txRes.ok) continue;
        const txJson = await txRes.json() as any;
        const tx = txJson.result;

        if (!tx || !tx.meta) continue;

        // Check preTokenBalances vs postTokenBalances for incoming meme tokens
        const preTokens = tx.meta.preTokenBalances || [];
        const postTokens = tx.meta.postTokenBalances || [];

        for (const post of postTokens) {
          if (post.owner === address && post.mint) {
            const pre = preTokens.find((p: any) => p.accountIndex === post.accountIndex);
            const preAmt = pre?.uiTokenAmount?.uiAmount || 0;
            const postAmt = post.uiTokenAmount?.uiAmount || 0;

            if (postAmt > preAmt) {
              // Wallet received more of this token -> likely a BUY swap
              events.push({
                wallet: address,
                chain: 'solana',
                tokenAddress: post.mint,
                txHash: sigInfo.signature,
                amountUsd: 5000, // estimated swap amount
                timestamp: (sigInfo.blockTime ? sigInfo.blockTime * 1000 : Date.now()),
                rawTx: tx,
              });
            }
          }
        }
      }

      return events;
    } catch (err: any) {
      logger.debug({ address, err: err?.message }, 'Solana RPC scan returned error, bypassing');
      return [];
    }
  }

  private async scanEvmWallet(address: string, lastKnownTxHash?: string): Promise<WhaleSwapEvent[]> {
    // Basic EVM scan placeholder
    return [];
  }
}

export const multiWalletScanner = new MultiWalletScanner();
