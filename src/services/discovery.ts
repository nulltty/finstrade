import { prisma } from '../db/prisma.js';
import { env } from '../config/index.js';
import { walletProfiler } from './walletProfiler.js';
import { rpc } from './solana.js';
import { audit } from './audit.js';
import { logger } from './logger.js';

export interface DiscoveryResult {
  winnersScanned: number;
  candidatesFound: number;
  profiled: number;
  qualified: number;
  reprofiled: number;
}

// Known DEX, AMM, program, exchange and burn addresses to exclude
const SYSTEM_EXCLUDED_ADDRESSES = new Set([
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM
  'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX', // OpenBook
  '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', // Raydium Authority
  '11111111111111111111111111111111', // System Program
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // Token Program
  'Ce6AM6TmWy5QjS8pnSmkgZ61HsF7Nzm84y8PNJJEQBDr', // Pump.fun Fee / Authority
  '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf', // Pump.fun Raydium Migration
  '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', // Binance hot wallet
  '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9', // Binance
  '0x0000000000000000000000000000000000000000', // Burn address EVM
  '0x000000000000000000000000000000000000dead', // Dead address EVM
]);

const MAX_PROFILES_PER_RUN = 20;
const PAIR_TRADER_SAMPLE = 25;
const MAX_WINNERS_PER_RUN = 8;
const REPROFILE_ACTIVE_AFTER_MS = 12 * 3600 * 1000;
const REPROFILE_REJECTED_AFTER_MS = 3 * 24 * 3600 * 1000;

const PROFILE_TIMEOUT_MS = 120_000;

/** One slow/huge wallet must not stall the whole discovery cycle */
function profileWithTimeout(address: string) {
  return Promise.race([
    walletProfiler.profileAndSave(address),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('profiling timed out')), PROFILE_TIMEOUT_MS)),
  ]);
}

async function getJson(url: string, timeoutMs = 8000): Promise<any | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export class WhaleDiscoveryService {
  private running = false;

  /**
   * Import wallets listed in WATCHED_WALLETS env. There is no hardcoded whale list:
   * every whale must earn its place through on-chain profiling.
   */
  async seedEnvWallets(): Promise<number> {
    let addedCount = 0;
    const envWallets = env.WATCHED_WALLETS.split(',').map((s) => s.trim()).filter((s) => s && !s.startsWith('wallet'));
    for (const address of envWallets) {
      if (SYSTEM_EXCLUDED_ADDRESSES.has(address)) continue;
      const exists = await prisma.watchedWallet.findUnique({ where: { address } });
      if (!exists) {
        await prisma.watchedWallet.create({
          data: {
            address,
            chain: env.CHAIN,
            label: 'Env Config Wallet',
            tags: ['custom_env', env.CHAIN],
            discoveredVia: 'env_config',
            isActive: true,
          },
        });
        addedCount++;
      }
    }

    // Wallets added by earlier versions (hand-written "curated" list, raw top-holder
    // scrape) were never verified: pause them until the profiler proves them profitable.
    await prisma.watchedWallet.updateMany({
      where: { lastProfiledAt: null, discoveredVia: { notIn: ['manual_dashboard', 'env_config'] }, isActive: true },
      data: { isActive: false, profileStatus: 'candidate', profileReason: 'unverified — awaiting profiling' },
    });

    if (addedCount) logger.info({ addedCount }, 'Imported env whale wallets');
    return addedCount;
  }

  /**
   * Tokens that are pumping right now on Solana (DexScreener boosts + fresh profiles),
   * filtered to real winners with liquidity and volume.
   */
  async findWinningTokens(): Promise<Array<{ mint: string; symbol: string; pairAddress: string; change24h: number }>> {
    const sources = await Promise.all([
      getJson(`${env.DEXSCREENER_API_BASE}/token-boosts/top/v1`),
      getJson(`${env.DEXSCREENER_API_BASE}/token-boosts/latest/v1`),
      getJson(`${env.DEXSCREENER_API_BASE}/token-profiles/latest/v1`),
    ]);
    const mints = [
      ...new Set(
        sources
          .flatMap((s) => (Array.isArray(s) ? s : []))
          .filter((t: any) => t.chainId === 'solana' && t.tokenAddress)
          .map((t: any) => t.tokenAddress as string)
      ),
    ].slice(0, 60);

    const winners: Array<{ mint: string; symbol: string; pairAddress: string; change24h: number }> = [];
    for (let i = 0; i < mints.length; i += 30) {
      const pairs = await getJson(`${env.DEXSCREENER_API_BASE}/tokens/v1/solana/${mints.slice(i, i + 30).join(',')}`);
      if (!Array.isArray(pairs)) continue;
      const best = new Map<string, any>();
      for (const p of pairs) {
        const mint = p.baseToken?.address;
        if (!mint) continue;
        if (!best.has(mint) || (p.liquidity?.usd || 0) > (best.get(mint).liquidity?.usd || 0)) best.set(mint, p);
      }
      for (const [mint, p] of best) {
        const change = Number(p.priceChange?.h24 ?? 0);
        if (change >= 30 && (p.liquidity?.usd || 0) >= 20000 && (p.volume?.h24 || 0) >= 50000) {
          winners.push({ mint, symbol: p.baseToken?.symbol || '?', pairAddress: p.pairAddress, change24h: change });
        }
      }
    }
    return winners.sort((a, b) => b.change24h - a.change24h).slice(0, MAX_WINNERS_PER_RUN);
  }

  /** Real wallets holding / trading a winner — excludes pools, lockers, exchanges and insiders */
  async extractCandidates(winner: { mint: string; pairAddress: string }): Promise<string[]> {
    const holders = new Set<string>();
    const traders = new Set<string>();

    const report = await getJson(`${env.RUGCHECK_API_BASE}/v1/tokens/${winner.mint}/report`, 12000);
    if (report) {
      const known = new Set(Object.keys(report.knownAccounts || {}));
      for (const m of report.markets || []) {
        if (m.pubkey) known.add(m.pubkey);
        if (m.liquidityA) known.add(m.liquidityA);
        if (m.liquidityB) known.add(m.liquidityB);
      }
      for (const h of report.topHolders || []) {
        const owner = h.owner || h.address;
        if (!owner || h.insider || known.has(owner) || known.has(h.address)) continue;
        holders.add(owner);
      }
    }

    // Recent traders on the main pair: these are people actually trading, not just holding
    if (winner.pairAddress) {
      if (env.HELIUS_API_KEY) {
        const txs = await getJson(
          `https://api.helius.xyz/v0/addresses/${winner.pairAddress}/transactions?api-key=${env.HELIUS_API_KEY}&limit=100`,
          15000
        );
        for (const tx of Array.isArray(txs) ? txs : []) {
          if (tx.type === 'SWAP' && tx.feePayer) traders.add(tx.feePayer);
        }
      } else {
        const sigs = await rpc<any[]>('getSignaturesForAddress', [winner.pairAddress, { limit: PAIR_TRADER_SAMPLE }]);
        for (const s of sigs || []) {
          if (s.err) continue;
          const tx = await rpc<any>('getTransaction', [s.signature, { maxSupportedTransactionVersion: 0, encoding: 'jsonParsed' }]);
          const signer = tx?.transaction?.message?.accountKeys?.find((k: any) => k.signer)?.pubkey;
          if (signer) traders.add(signer);
        }
      }
    }

    // Active traders first: holders of a pumping token are often exchanges or passive bags
    return [...new Set([...traders, ...holders])].filter((a) => !SYSTEM_EXCLUDED_ADDRESSES.has(a));
  }

  /**
   * Full discovery cycle: re-check stale whales, find winners, harvest candidate
   * wallets and profile them. Only wallets with proven realised profit get activated.
   */
  async runDiscoveryCycle(): Promise<DiscoveryResult> {
    const result: DiscoveryResult = { winnersScanned: 0, candidatesFound: 0, profiled: 0, qualified: 0, reprofiled: 0 };
    if (this.running) return result;
    this.running = true;
    try {
      return await this.discover(result);
    } finally {
      this.running = false;
    }
  }

  private async discover(result: DiscoveryResult): Promise<DiscoveryResult> {
    let budget = MAX_PROFILES_PER_RUN;

    // 1. Pending candidates and stale profiles first
    const stale = await prisma.watchedWallet.findMany({
      where: {
        OR: [
          { lastProfiledAt: null },
          { isActive: true, lastProfiledAt: { lt: new Date(Date.now() - REPROFILE_ACTIVE_AFTER_MS) } },
          { profileStatus: 'rejected', lastProfiledAt: { lt: new Date(Date.now() - REPROFILE_REJECTED_AFTER_MS) } },
        ],
      },
      orderBy: { lastProfiledAt: { sort: 'asc', nulls: 'first' } },
      take: Math.floor(budget / 2),
    });
    logger.info({ stale: stale.length }, 'Discovery: re-checking unprofiled / stale wallets');
    for (const w of stale) {
      if (w.chain !== 'solana') continue;
      try {
        const p = await profileWithTimeout(w.address);
        result.reprofiled++;
        if (p.qualified) result.qualified++;
      } catch (err: any) {
        logger.warn({ address: w.address, err: err?.message }, 'Re-profile failed');
      }
      budget--;
    }

    // 2. New candidates from current winners
    const winners = await this.findWinningTokens();
    result.winnersScanned = winners.length;
    logger.info({ winners: winners.map((w) => `${w.symbol} +${w.change24h.toFixed(0)}%`) }, 'Discovery: harvesting traders from winning tokens');

    for (const winner of winners) {
      if (budget <= 0) break;
      const candidates = await this.extractCandidates(winner);
      for (const address of candidates) {
        if (budget <= 0) break;
        const exists = await prisma.watchedWallet.findUnique({ where: { address } });
        if (exists) continue;
        result.candidatesFound++;

        await prisma.watchedWallet.create({
          data: {
            address,
            chain: 'solana',
            label: `Early in ${winner.symbol} (+${winner.change24h.toFixed(0)}%)`,
            tags: ['auto_discovered', 'solana'],
            discoveredVia: `winner:${winner.symbol}:${winner.mint.slice(0, 8)}`,
            isActive: false,
          },
        });

        try {
          const p = await profileWithTimeout(address);
          result.profiled++;
          if (p.qualified) result.qualified++;
        } catch (err: any) {
          logger.warn({ address, err: err?.message }, 'Profiling candidate failed');
        }
        budget--;
      }
    }

    await audit(
      'DISCOVERY_CYCLE',
      `${result.winnersScanned} winners, ${result.profiled} new wallets profiled, ${result.qualified} qualified`,
      result as any
    );
    logger.info(result, 'Whale discovery cycle completed');
    return result;
  }

  async getActiveWallets(chain?: string) {
    return prisma.watchedWallet.findMany({
      where: { isActive: true, ...(chain ? { chain } : {}) },
      orderBy: { createdAt: 'desc' },
    });
  }

  async addWallet(data: { address: string; chain: string; label?: string; tags?: string[] }) {
    return prisma.watchedWallet.upsert({
      where: { address: data.address },
      create: {
        address: data.address,
        chain: data.chain,
        label: data.label || 'Custom Whale Wallet',
        tags: data.tags || ['custom'],
        discoveredVia: 'manual_dashboard',
        isActive: true,
      },
      update: {
        isActive: true,
        label: data.label,
        tags: data.tags,
        discoveredVia: 'manual_dashboard',
      },
    });
  }

  async toggleWallet(id: string) {
    const wallet = await prisma.watchedWallet.findUnique({ where: { id } });
    if (!wallet) throw new Error('Wallet not found');
    return prisma.watchedWallet.update({ where: { id }, data: { isActive: !wallet.isActive } });
  }

  async deleteWallet(id: string) {
    return prisma.watchedWallet.delete({ where: { id } });
  }
}

export const whaleDiscovery = new WhaleDiscoveryService();
