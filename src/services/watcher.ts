import { prisma } from '../db/prisma.js';
import { blueChipTokens, env } from '../config/index.js';
import { signalQueue } from '../workers/queue.js';
import { logger } from './logger.js';

export interface WhaleSwapEvent {
  wallet: string;
  chain: 'solana' | 'evm';
  tokenAddress: string;
  tokenSymbol?: string;
  tokenName?: string;
  txHash: string;
  amountUsd?: number;
  whaleSolSpent?: number;
  timestamp?: number;
  rawTx?: Record<string, any>;
}

export class WhaleWatcherService {
  /**
   * Filter and process a whale swap event
   */
  async processEvent(event: WhaleSwapEvent) {
    const { wallet, chain, tokenAddress, tokenSymbol, tokenName, txHash, amountUsd, whaleSolSpent, timestamp, rawTx } = event;

    // Check if token is blue chip or stablecoin
    if (this.isBlueChipOrStable(tokenAddress, tokenSymbol)) {
      logger.info({ tokenAddress, tokenSymbol }, 'Ignored blue-chip or stablecoin token');
      return { skipped: true, reason: 'blue_chip_or_stable' };
    }

    // Check watched wallets in DB or env
    const watchedWalletCount = await prisma.watchedWallet.count({ where: { isActive: true } });
    if (watchedWalletCount > 0 || env.WATCHED_WALLETS) {
      const inEnv = env.WATCHED_WALLETS
        ? env.WATCHED_WALLETS.split(',').map((w) => w.trim().toLowerCase()).includes(wallet.toLowerCase())
        : false;

      const inDb = await prisma.watchedWallet.findFirst({
        where: {
          address: { equals: wallet, mode: 'insensitive' },
          isActive: true,
        },
      });

      if (!inEnv && !inDb && !txHash.startsWith('sim_tx_')) {
        logger.info({ wallet }, 'Ignored transaction: wallet not in active watchlist');
        return { skipped: true, reason: 'wallet_not_watched' };
      }
    }

    // Deduplication by txHash
    const existing = await prisma.signal.findUnique({
      where: { txHash },
    });

    if (existing) {
      logger.warn({ txHash }, 'Duplicate signal ignored (already processed)');
      return { skipped: true, reason: 'duplicate_tx_hash', signalId: existing.id };
    }

    // Save raw signal with status 'detected'
    const signal = await prisma.signal.create({
      data: {
        wallet,
        chain,
        tokenAddress,
        tokenSymbol,
        tokenName,
        txHash,
        amountUsd: amountUsd || 0,
        whaleSolSpent: whaleSolSpent ?? null,
        whaleTxAt: new Date(timestamp || Date.now()),
        status: 'detected',
        rawTx: rawTx || {},
      },
    });

    logger.info({ signalId: signal.id, tokenAddress, wallet, chain }, 'New whale signal recorded');

    // Add to BullMQ queue for aggregator & scoring
    await signalQueue.add('aggregate-and-score', { signalId: signal.id });

    return { skipped: false, signal };
  }

  isBlueChipOrStable(address: string, symbol?: string): boolean {
    if (blueChipTokens.has(address)) return true;
    if (symbol && blueChipTokens.has(symbol.toUpperCase())) return true;
    return false;
  }

  /**
   * Parse Helius enhanced transaction webhook payload
   */
  parseHeliusWebhook(payload: any[]): WhaleSwapEvent[] {
    const events: WhaleSwapEvent[] = [];

    for (const tx of payload) {
      if (!tx || tx.type !== 'SWAP') continue;
      const txHash = tx.signature;
      const wallet = tx.feePayer;

      // Extract swap token outputs
      if (tx.tokenTransfers && Array.isArray(tx.tokenTransfers)) {
        for (const transfer of tx.tokenTransfers) {
          if (transfer.toUserAccount === wallet && transfer.mint) {
            events.push({
              wallet,
              chain: 'solana',
              tokenAddress: transfer.mint,
              txHash,
              amountUsd: transfer.tokenAmount || 0,
              timestamp: tx.timestamp ? tx.timestamp * 1000 : Date.now(),
              rawTx: tx,
            });
          }
        }
      }
    }

    return events;
  }
}

export const whaleWatcherService = new WhaleWatcherService();
