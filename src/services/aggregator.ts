import { prisma } from '../db/prisma.js';
import { env, WSOL_MINT } from '../config/index.js';
import { getJupiterQuote, getSolPriceUsd } from './solana.js';
import { settingsService } from './settings.js';
import { logger } from './logger.js';
import { recordApiEvent, providerFromUrl, isTimeoutError } from './apiHealth.js';

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

  // Extended safety telemetry (optional so older stored metrics still parse)
  hasFreezeAuthority?: boolean;
  rugged?: boolean;
  sellRouteOk?: boolean | null;
  roundTripLossPct?: number | null;
  buyPriceImpactPct?: number | null;
  transferFeePct?: number;
  rugcheckScore?: number | null;
  riskFlags?: string[];
  honeypotReasons?: string[];
  insidersDetected?: number;
  pairAddress?: string;
  dexId?: string;
  priceChange?: { m5?: number; h1?: number; h6?: number; h24?: number };
  txns1h?: { buys: number; sells: number };
  launchpad?: string | null;
  dataSources?: { dexscreener: boolean; goplus: boolean; rugcheck: boolean; jupiter: boolean };
}

const LOCKED_LP_PCT = 80;

async function getJson(url: string, timeoutMs = 8000): Promise<any | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 429) recordApiEvent(providerFromUrl(url), '429', url.split('?')[0]);
    if (!res.ok) {
      logger.warn({ status: res.status, url: url.split('?')[0] }, 'Data source returned non-200');
      return null;
    }
    return await res.json();
  } catch (err: any) {
    if (isTimeoutError(err)) recordApiEvent(providerFromUrl(url), 'timeout', url.split('?')[0]);
    logger.warn({ url: url.split('?')[0], err: err?.message }, 'Data source request failed');
    return null;
  }
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
    const metrics = await this.collect(signal.tokenAddress, signal.chain);
    if (metrics.symbol === 'UNKNOWN' && signal.tokenSymbol) metrics.symbol = signal.tokenSymbol;
    if (metrics.name === 'Unknown' && signal.tokenName) metrics.name = signal.tokenName;

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

  async collect(tokenAddress: string, chain: string): Promise<AggregatedTokenMetrics> {
    const isSolana = chain === 'solana';
    const [dex, goplus, rug, route] = await Promise.all([
      this.fetchDexScreenerData(tokenAddress, chain),
      this.fetchGoPlusSecurity(tokenAddress, chain),
      isSolana ? this.fetchRugCheck(tokenAddress) : Promise.resolve(null),
      isSolana ? this.checkSellability(tokenAddress) : Promise.resolve(null),
    ]);

    const riskFlags: string[] = [...(goplus?.riskFlags || []), ...(rug?.riskFlags || [])];
    const honeypotReasons: string[] = [...(goplus?.honeypotReasons || [])];
    if (rug?.freezeAuthority) honeypotReasons.push('Freeze authority active (holders can be frozen)');
    if (rug?.rugged) honeypotReasons.push('RugCheck marks token as rugged');
    if (route && route.sellRouteOk === false) honeypotReasons.push('No sell route on Jupiter (cannot exit)');

    const settings = await settingsService.getSettings();
    if (route?.roundTripLossPct != null && route.roundTripLossPct > settings.maxRoundTripLossPct) {
      honeypotReasons.push(`Round-trip swap loses ${route.roundTripLossPct.toFixed(1)}% (hidden tax / thin pool)`);
    }

    const hasMint = !!(goplus?.hasMintFunction || rug?.mintAuthority);
    const hasFreeze = !!(goplus?.hasFreezeAuthority || rug?.freezeAuthority);

    const liquidityUsd = dex.liquidityUsd || rug?.liquidityUsd || 0;
    const lockedPct = rug?.lpLockedPct ?? 0;
    const marketCap = dex.marketCap;

    return {
      liquidityUsd,
      isLiquidityLocked: lockedPct >= LOCKED_LP_PCT,
      lockedPercentage: Math.round(lockedPct),
      top10HoldersPercent: rug?.top10Pct ?? goplus?.top10HoldersPercent ?? 100,
      isHoneypot: honeypotReasons.length > 0,
      hasMintFunction: hasMint,
      isOwnershipRenounced: isSolana ? !hasMint && !hasFreeze : !!goplus?.isOwnershipRenounced,
      // "verified" = we could actually inspect the contract from at least one security source
      contractVerified: !!(goplus || rug),
      volume24h: dex.volume24h,
      marketCap,
      volumeMcRatio: marketCap > 0 ? dex.volume24h / marketCap : 0,
      tokenAgeHours: dex.tokenAgeHours,
      holderCount: rug?.holderCount || goplus?.holderCount || 0,
      symbol: dex.symbol || 'UNKNOWN',
      name: dex.name || 'Unknown',
      priceUsd: dex.priceUsd,
      hasFreezeAuthority: hasFreeze,
      rugged: !!rug?.rugged,
      sellRouteOk: route?.sellRouteOk ?? null,
      roundTripLossPct: route?.roundTripLossPct ?? null,
      buyPriceImpactPct: route?.buyPriceImpactPct ?? null,
      transferFeePct: goplus?.transferFeePct ?? 0,
      rugcheckScore: rug?.score ?? null,
      riskFlags,
      honeypotReasons,
      insidersDetected: rug?.insiders ?? 0,
      pairAddress: dex.pairAddress,
      dexId: dex.dexId,
      priceChange: dex.priceChange,
      txns1h: dex.txns1h,
      launchpad: rug?.launchpad ?? null,
      dataSources: { dexscreener: dex.ok, goplus: !!goplus, rugcheck: !!rug, jupiter: route?.ok ?? false },
    };
  }

  /**
   * Fetch liquidity, volume, market cap, and pair age from DexScreener
   */
  async fetchDexScreenerData(tokenAddress: string, chain: string) {
    const json = await getJson(`${env.DEXSCREENER_API_BASE}/latest/dex/tokens/${tokenAddress}`, 6000);
    const pairs = (json?.pairs || []).filter((p: any) => p.baseToken?.address === tokenAddress || chain !== 'solana');
    if (pairs.length === 0) return this.getDefaultDexData();

    // Pick pair with highest liquidity
    const pair = pairs.sort((a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    const createdAt = pair.pairCreatedAt ? Number(pair.pairCreatedAt) : Date.now();

    return {
      ok: true,
      liquidityUsd: pair.liquidity?.usd || 0,
      volume24h: pair.volume?.h24 || 0,
      marketCap: pair.marketCap || pair.fdv || 0,
      tokenAgeHours: Math.max(0.01, (Date.now() - createdAt) / 3600000),
      symbol: pair.baseToken?.symbol || '',
      name: pair.baseToken?.name || '',
      priceUsd: Number(pair.priceUsd) || 0,
      pairAddress: pair.pairAddress as string,
      dexId: pair.dexId as string,
      priceChange: pair.priceChange || {},
      txns1h: { buys: pair.txns?.h1?.buys || 0, sells: pair.txns?.h1?.sells || 0 },
    };
  }

  /** Batch USD prices for up to 30 Solana mints in one DexScreener call */
  async fetchPrices(mints: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (let i = 0; i < mints.length; i += 30) {
      const pairs = await getJson(`${env.DEXSCREENER_API_BASE}/tokens/v1/solana/${mints.slice(i, i + 30).join(',')}`, 6000);
      const bestLiq = new Map<string, number>();
      for (const p of Array.isArray(pairs) ? pairs : []) {
        const mint = p.baseToken?.address;
        const liq = p.liquidity?.usd || 0;
        if (mint && Number(p.priceUsd) > 0 && liq >= (bestLiq.get(mint) ?? -1)) {
          bestLiq.set(mint, liq);
          out.set(mint, Number(p.priceUsd));
        }
      }
    }
    return out;
  }

  /**
   * Fetch contract safety info from GoPlus Security
   */
  async fetchGoPlusSecurity(tokenAddress: string, chain: string) {
    const isSolana = chain === 'solana';
    const endpoint = isSolana
      ? `${env.GOPLUS_API_BASE}/api/v1/solana/token_security?contract_addresses=${tokenAddress}`
      : `${env.GOPLUS_API_BASE}/api/v1/token_security/1?contract_addresses=${tokenAddress}`;
    const json = await getJson(endpoint, 6000);
    const result = json?.result?.[tokenAddress] || json?.result?.[tokenAddress.toLowerCase()];
    if (!result) return null;

    const flag = (v: any) => v === '1' || v === 1 || v === true || v?.status === '1' || v?.status === 1;
    const riskFlags: string[] = [];
    const honeypotReasons: string[] = [];

    let top10HoldersPercent: number | undefined;
    if (Array.isArray(result.holders)) {
      top10HoldersPercent = result.holders.slice(0, 10).reduce((acc: number, h: any) => acc + parseFloat(h.percent || '0') * 100, 0);
    }

    if (isSolana) {
      const hasMintFunction = flag(result.mintable);
      const hasFreezeAuthority = flag(result.freezable);
      if (flag(result.balance_mutable_authority)) honeypotReasons.push('Balance can be changed by an authority');
      if (flag(result.non_transferable)) honeypotReasons.push('Token is non-transferable');
      if (Array.isArray(result.transfer_hook) && result.transfer_hook.length > 0) riskFlags.push('Transfer hook present');
      if (flag(result.closable)) riskFlags.push('Token accounts closable by authority');
      if (flag(result.metadata_mutable)) riskFlags.push('Mutable metadata');
      const feeRate = Number(result.transfer_fee?.current_fee_rate?.fee_rate ?? result.transfer_fee?.fee_rate ?? 0);
      const transferFeePct = feeRate > 1 ? feeRate / 100 : feeRate * 100;
      if (transferFeePct >= 10) honeypotReasons.push(`Transfer fee ${transferFeePct.toFixed(1)}%`);
      else if (transferFeePct > 0) riskFlags.push(`Transfer fee ${transferFeePct.toFixed(1)}%`);

      return {
        top10HoldersPercent,
        hasMintFunction,
        hasFreezeAuthority,
        isOwnershipRenounced: !hasMintFunction && !hasFreezeAuthority,
        holderCount: result.holder_count ? parseInt(result.holder_count) : 0,
        transferFeePct,
        riskFlags,
        honeypotReasons,
      };
    }

    if (flag(result.is_honeypot)) honeypotReasons.push('Honeypot detected by GoPlus Security API');
    if (flag(result.cannot_sell_all)) honeypotReasons.push('Cannot sell all tokens');
    const sellTax = Number(result.sell_tax || 0) * 100;
    if (sellTax >= 10) honeypotReasons.push(`Sell tax ${sellTax.toFixed(0)}%`);
    return {
      top10HoldersPercent,
      hasMintFunction: flag(result.is_mintable),
      hasFreezeAuthority: false,
      isOwnershipRenounced: !result.owner_address || /^0x0+$/.test(result.owner_address),
      holderCount: result.holder_count ? parseInt(result.holder_count) : 0,
      transferFeePct: sellTax,
      riskFlags,
      honeypotReasons,
    };
  }

  /** RugCheck: LP lock %, authorities, real holder distribution (pools/lockers excluded) */
  async fetchRugCheck(mint: string) {
    const r = await getJson(`${env.RUGCHECK_API_BASE}/v1/tokens/${mint}/report`, 12000);
    if (!r) return null;

    const nonHolders = new Set<string>(Object.keys(r.knownAccounts || {}));
    for (const l of Object.values<any>(r.lockers || {})) if (l?.tokenAccount) nonHolders.add(l.tokenAccount);

    let mainMarket: any = null;
    for (const m of r.markets || []) {
      for (const k of [m.pubkey, m.liquidityA, m.liquidityB, m.liquidityAAccount?.owner]) if (k) nonHolders.add(k);
      const liq = (m.lp?.quoteUSD || 0) + (m.lp?.baseUSD || 0);
      if (!mainMarket || liq > (mainMarket.lp?.quoteUSD || 0) + (mainMarket.lp?.baseUSD || 0)) mainMarket = m;
    }

    // Pump.fun bonding-curve liquidity cannot be withdrawn by the creator
    let lpLockedPct: number = mainMarket?.lp?.lpLockedPct ?? 0;
    if (mainMarket?.marketType === 'pump_fun') lpLockedPct = 100;

    const holders = (r.topHolders || []).filter((h: any) => !nonHolders.has(h.owner) && !nonHolders.has(h.address));
    const top10Pct = holders.slice(0, 10).reduce((a: number, h: any) => a + (h.pct || 0), 0);

    const riskFlags: string[] = (r.risks || [])
      .filter((x: any) => x.level === 'danger' || x.level === 'warn')
      .map((x: any) => `${x.level === 'danger' ? '⛔' : '⚠'} ${x.name}`);

    return {
      mintAuthority: !!r.mintAuthority,
      freezeAuthority: !!r.freezeAuthority,
      rugged: !!r.rugged,
      lpLockedPct,
      top10Pct,
      holderCount: r.totalHolders || 0,
      liquidityUsd: r.totalMarketLiquidity || 0,
      score: typeof r.score_normalised === 'number' ? r.score_normalised : null,
      insiders: r.graphInsidersDetected || 0,
      launchpad: r.launchpad?.name || null,
      riskFlags,
    };
  }

  /**
   * Simulate the trade on Jupiter: buy with our position size, then quote selling
   * the received tokens back. No sell route or a big round-trip loss = honeypot / tax.
   */
  async checkSellability(mint: string) {
    const settings = await settingsService.getSettings();
    const solPrice = await getSolPriceUsd();
    if (solPrice <= 0) return { ok: false, sellRouteOk: null, roundTripLossPct: null, buyPriceImpactPct: null };

    const lamports = BigInt(Math.max(1_000_000, Math.round((settings.tradeAmountUsd / solPrice) * 1e9)));
    const buy = await getJupiterQuote(WSOL_MINT, mint, lamports, settings.slippageBps);
    if (!buy) return { ok: false, sellRouteOk: null, roundTripLossPct: null, buyPriceImpactPct: null };

    const sell = await getJupiterQuote(mint, WSOL_MINT, buy.outAmount, settings.slippageBps);
    const buyImpact = Number(buy.priceImpactPct || 0) * 100;
    if (!sell) return { ok: true, sellRouteOk: false, roundTripLossPct: null, buyPriceImpactPct: buyImpact };

    const back = Number(sell.outAmount);
    const roundTripLossPct = (1 - back / Number(lamports)) * 100;
    return { ok: true, sellRouteOk: true, roundTripLossPct, buyPriceImpactPct: buyImpact };
  }

  private getDefaultDexData() {
    return {
      ok: false,
      liquidityUsd: 0,
      volume24h: 0,
      marketCap: 0,
      tokenAgeHours: 0.5,
      symbol: '',
      name: '',
      priceUsd: 0,
      pairAddress: undefined as string | undefined,
      dexId: undefined as string | undefined,
      priceChange: {},
      txns1h: { buys: 0, sells: 0 },
    };
  }
}

export const tokenDataAggregator = new TokenDataAggregator();
