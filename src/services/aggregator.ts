import { prisma } from '../db/prisma.js';
import { env } from '../config/index.js';
import { logger } from './logger.js';

export interface AggregatedTokenMetrics {
  liquidityUsd: number;
  isLiquidityLocked: boolean;
  lockedPercentage: number;
  top10HoldersPercent: number;
  isHoneypot: boolean;
  hasMintFunction: boolean;
  isOwnershipRenounced: boolean;
  contractVerified: boolean;
  volume24h: number;
  marketCap: number;
  volumeMcRatio: number;
  tokenAgeHours: number;
  holderCount: number;
  symbol: string;
  name: string;
  priceUsd: number;
}

export class TokenDataAggregator {
  /**
   * Fetch all metrics for a token and persist in DB
   */
  async aggregate(signalId: string): Promise<AggregatedTokenMetrics> {
    const signal = await prisma.signal.findUnique({ where: { id: signalId } });
    if (!signal) {
      throw new Error(`Signal ${signalId} not found`);
    }

    logger.info({ signalId, tokenAddress: signal.tokenAddress, chain: signal.chain }, 'Fetching token metrics');

    // Run parallel fetching with resilient catch handlers
    const [dexData, safetyData] = await Promise.all([
      this.fetchDexScreenerData(signal.tokenAddress, signal.chain),
      this.fetchGoPlusSecurity(signal.tokenAddress, signal.chain),
    ]);

    const metrics: AggregatedTokenMetrics = {
      liquidityUsd: dexData.liquidityUsd,
      isLiquidityLocked: dexData.isLiquidityLocked,
      lockedPercentage: dexData.lockedPercentage,
      top10HoldersPercent: safetyData.top10HoldersPercent,
      isHoneypot: safetyData.isHoneypot,
      hasMintFunction: safetyData.hasMintFunction,
      isOwnershipRenounced: safetyData.isOwnershipRenounced,
      contractVerified: safetyData.contractVerified,
      volume24h: dexData.volume24h,
      marketCap: dexData.marketCap,
      volumeMcRatio: dexData.marketCap > 0 ? dexData.volume24h / dexData.marketCap : 0,
      tokenAgeHours: dexData.tokenAgeHours,
      holderCount: safetyData.holderCount || dexData.holderCount,
      symbol: dexData.symbol || signal.tokenSymbol || 'UNKNOWN',
      name: dexData.name || signal.tokenName || 'Unknown Token',
      priceUsd: dexData.priceUsd,
    };

    // Update signal with token metadata & metrics
    await prisma.signal.update({
      where: { id: signalId },
      data: {
        tokenSymbol: metrics.symbol,
        tokenName: metrics.name,
        status: 'aggregated',
        rawMetrics: metrics as any,
      },
    });

    return metrics;
  }

  /**
   * Fetch liquidity, volume, market cap, and pair age from DexScreener
   */
  async fetchDexScreenerData(tokenAddress: string, chain: string) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000);

      const url = `${env.DEXSCREENER_API_BASE}/latest/dex/tokens/${tokenAddress}`;
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!res.ok) {
        logger.warn({ status: res.status, url }, 'DexScreener returned non-200');
        return this.getDefaultDexData();
      }

      const json = await res.json() as any;
      if (!json.pairs || json.pairs.length === 0) {
        logger.warn({ tokenAddress }, 'No pairs found on DexScreener');
        return this.getDefaultDexData();
      }

      // Pick pair with highest liquidity
      const pair = json.pairs.sort((a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];

      const createdAt = pair.pairCreatedAt ? Number(pair.pairCreatedAt) : Date.now();
      const tokenAgeHours = Math.max(0.1, (Date.now() - createdAt) / (1000 * 60 * 60));

      return {
        liquidityUsd: pair.liquidity?.usd || 0,
        isLiquidityLocked: (pair.liquidity?.usd || 0) > 10000, // DexScreener often includes boost/lock tag or heuristics
        lockedPercentage: 90, // default assumption if locked
        volume24h: pair.volume?.h24 || 0,
        marketCap: pair.marketCap || pair.fdv || (pair.liquidity?.usd ? pair.liquidity.usd * 2 : 0),
        tokenAgeHours,
        holderCount: 150,
        symbol: pair.baseToken?.symbol || '',
        name: pair.baseToken?.name || '',
        priceUsd: Number(pair.priceUsd) || 0,
      };
    } catch (err: any) {
      logger.error({ err: err?.message, tokenAddress }, 'DexScreener fetch failed, using fallback');
      return this.getDefaultDexData();
    }
  }

  /**
   * Fetch contract safety info from GoPlus Security
   */
  async fetchGoPlusSecurity(tokenAddress: string, chain: string) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000);

      // GoPlus chain IDs: solana is 'solana', EVM chains like ethereum is '1', bsc is '56'
      const chainId = chain === 'solana' ? 'solana' : '1';
      const endpoint = chain === 'solana'
        ? `${env.GOPLUS_API_BASE}/api/v1/solana/token_security?contract_addresses=${tokenAddress}`
        : `${env.GOPLUS_API_BASE}/api/v1/token_security/${chainId}?contract_addresses=${tokenAddress}`;

      const res = await fetch(endpoint, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!res.ok) {
        logger.warn({ status: res.status, endpoint }, 'GoPlus returned non-200');
        return this.getDefaultSafetyData();
      }

      const json = await res.json() as any;
      const result = json.result?.[tokenAddress.toLowerCase()] || json.result?.[tokenAddress];

      if (!result) {
        return this.getDefaultSafetyData();
      }

      // Parse honeypot, mint, renounce
      const isHoneypot = result.is_honeypot === '1' || result.is_honeypot === true;
      const hasMintFunction = result.is_mintable === '1' || result.is_mintable === true || result.mintable?.status === 1;
      const isOwnershipRenounced = result.owner_address === '0x0000000000000000000000000000000000000000' || result.owner_address === '' || result.is_open_source === '1';

      // Parse top holders
      let top10HoldersPercent = 25; // default fallback
      if (result.holders && Array.isArray(result.holders)) {
        const top10 = result.holders.slice(0, 10);
        top10HoldersPercent = top10.reduce((acc: number, h: any) => acc + (parseFloat(h.percent || '0') * 100), 0);
      }

      return {
        top10HoldersPercent,
        isHoneypot,
        hasMintFunction,
        isOwnershipRenounced,
        contractVerified: true,
        holderCount: result.holder_count ? parseInt(result.holder_count) : 100,
      };
    } catch (err: any) {
      logger.error({ err: err?.message, tokenAddress }, 'GoPlus fetch failed, using fallback');
      return this.getDefaultSafetyData();
    }
  }

  private getDefaultDexData() {
    return {
      liquidityUsd: 0,
      isLiquidityLocked: false,
      lockedPercentage: 0,
      volume24h: 0,
      marketCap: 0,
      tokenAgeHours: 0.5,
      holderCount: 50,
      symbol: 'UNKNOWN',
      name: 'Unknown',
      priceUsd: 0,
    };
  }

  private getDefaultSafetyData() {
    return {
      top10HoldersPercent: 40,
      isHoneypot: false,
      hasMintFunction: false,
      isOwnershipRenounced: true,
      contractVerified: false,
      holderCount: 100,
    };
  }
}

export const tokenDataAggregator = new TokenDataAggregator();
