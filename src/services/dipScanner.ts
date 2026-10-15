import { prisma } from '../db/prisma.js';
import { blueChipTokens } from '../config/index.js';
import { tokenDataAggregator } from './aggregator.js';
import { scoringEngine } from './scoring.js';
import { tradeExecutor, entryPlanFor } from './executor.js';
import { settingsService, BotSettingsData } from './settings.js';
import { fetchCandles, evaluateReversal, isTimeframe, Timeframe } from './indicators.js';
import { scoreNarrative, parseKeywords } from './narrative.js';
import { telegramBot } from '../bot/telegram.js';
import { getSolPriceUsd } from './solana.js';
import { audit } from './audit.js';
import { logger } from './logger.js';

/**
 * Strategy 2 — RSI dip reversal.
 *
 * The whale pipeline follows someone else's conviction into a coin that is already moving. This
 * one does the opposite: it looks for coins that are *healthy* (deep liquidity, real volume, a
 * narrative, all the blueprint's safety checks) and are currently oversold but just starting to
 * turn back up. It enters a fixed amount of SOL and banks a fixed few dollars per trade.
 *
 *   universe (trending/boosted)  →  market filter (liquidity, volume, age, not bleeding out)
 *     →  RSI reversal on candles →  narrative check  →  the same safety scoring as whale signals
 *     →  signal  →  autopilot buy (or Telegram approval)
 *
 * Nothing here predicts price. It is a filter: it only decides which oversold coins are worth
 * risking a small, fixed stake on, and the exits (see PositionMonitorService) decide the rest.
 */

/** Signals have no whale behind them, so this stands in as the origin in the record */
export const DIP_SCANNER_SOURCE = 'rsi-dip-scanner';
export const DIP_STRATEGY = 'dip_reversal';

const MAX_UNIVERSE_MINTS = 90;
/** Candle calls are the expensive part of a cycle (GeckoTerminal allows ~30 requests/minute) */
const MAX_TECHNICAL_CHECKS = 12;
/** Even with slots free, never open more than this in one cycle — one bad market minute is enough */
const MAX_ENTRIES_PER_CYCLE = 2;
const CANDLE_LIMIT = 120;

export interface DipScanResult {
  /** Mints inspected from the trending universe */
  scanned: number;
  /** …that passed the market filter (liquidity / volume / age / not in free fall) */
  candidates: number;
  technicalPass: number;
  narrativePass: number;
  safetyPass: number;
  entered: number;
  /** Candidates whose candles could not be fetched — all of them means no candle source */
  candleMisses: number;
  /** Set when the cycle deliberately did nothing */
  skipped?: string;
}

interface DipCandidate {
  mint: string;
  symbol: string;
  name: string;
  pairAddress: string | null;
  priceUsd: number;
  liquidityUsd: number;
  volume24h: number;
  ageHours: number;
  change: { m5: number; h1: number; h6: number; h24: number };
  buys1h: number;
  sells1h: number;
  socials: string[];
  websites: number;
  boosts: number;
  /** Strong over a day, weak over the last hour = the pullback we are looking for */
  dipRank: number;
}

const num = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : 0);

export class DipReversalScanner {
  private running = false;

  async runScanCycle(): Promise<DipScanResult> {
    const result: DipScanResult = { scanned: 0, candidates: 0, technicalPass: 0, narrativePass: 0, safetyPass: 0, entered: 0, candleMisses: 0 };
    if (this.running) return { ...result, skipped: 'previous cycle still running' };
    this.running = true;
    try {
      const settings = await settingsService.getSettings();
      if (!settings.dipStrategyEnabled) return { ...result, skipped: 'strategy disabled' };
      return await this.scan(settings, result);
    } finally {
      this.running = false;
    }
  }

  private async scan(settings: BotSettingsData, result: DipScanResult): Promise<DipScanResult> {
    const timeframe: Timeframe = isTimeframe(settings.dipRsiTimeframe) ? settings.dipRsiTimeframe : '15m';
    const plan = entryPlanFor(DIP_STRATEGY, settings);
    const keywords = parseKeywords(settings.dipNarrativeKeywords);

    // Free slots first: the whole cycle costs API calls it makes no sense to spend with
    // nowhere to put a position.
    const [openTotal, openForStrategy] = await Promise.all([
      prisma.position.count({ where: { status: { in: ['open', 'closing'] } } }),
      prisma.position.count({ where: { status: { in: ['open', 'closing'] }, strategy: DIP_STRATEGY } }),
    ]);
    const slots = Math.min(
      settings.maxOpenPositions - openTotal,
      settings.dipMaxOpenPositions - openForStrategy,
      MAX_ENTRIES_PER_CYCLE
    );
    if (slots <= 0) {
      return { ...result, skipped: `no slot free (${openForStrategy}/${settings.dipMaxOpenPositions} dip, ${openTotal}/${settings.maxOpenPositions} total)` };
    }

    const solPrice = await getSolPriceUsd();
    if (solPrice <= 0) return { ...result, skipped: 'SOL price unavailable' };
    const entryUsd = settings.dipEntrySol * solPrice;

    const { mints, descriptions } = await tokenDataAggregator.fetchTrendingMints(MAX_UNIVERSE_MINTS);
    const pairs = await tokenDataAggregator.fetchPairsForMints(mints);
    result.scanned = pairs.size;
    if (pairs.size === 0) return { ...result, skipped: 'no market data from DexScreener' };

    const candidates = await this.filterCandidates(pairs, settings);
    result.candidates = candidates.length;
    logger.info(
      { scanned: result.scanned, candidates: result.candidates, slots, timeframe },
      'Dip scanner: market filter done, checking candles'
    );

    let entered = 0;
    for (const c of candidates.slice(0, MAX_TECHNICAL_CHECKS)) {
      if (entered >= slots) break;

      const ohlcv = await fetchCandles({ mint: c.mint, poolAddress: c.pairAddress, timeframe, limit: CANDLE_LIMIT });
      if (!ohlcv) {
        result.candleMisses++;
        logger.debug({ mint: c.mint, symbol: c.symbol }, 'Dip scanner: no candles available, skipping');
        continue;
      }

      const rev = evaluateReversal(ohlcv.candles, {
        rsiPeriod: settings.dipRsiPeriod,
        oversold: settings.dipRsiOversold,
        rsiMax: settings.dipRsiMax,
      });
      if (!rev.ok) {
        logger.debug({ symbol: c.symbol, reasons: rev.reasons }, 'Dip scanner: no reversal setup');
        continue;
      }
      result.technicalPass++;

      const narrative = scoreNarrative({
        symbol: c.symbol,
        name: c.name,
        description: descriptions.get(c.mint),
        socials: c.socials,
        websites: c.websites,
        boosts: c.boosts,
        extraKeywords: keywords,
      });
      if (narrative.score < settings.dipMinNarrativeScore) {
        logger.info(
          { symbol: c.symbol, narrativeScore: narrative.score, min: settings.dipMinNarrativeScore, notes: narrative.notes },
          'Dip scanner: reversal setup rejected on narrative'
        );
        continue;
      }
      result.narrativePass++;

      // Same safety engine as the whale pipeline, but the sell simulation and the price-impact
      // limit are measured for *our* entry size, which is what we are actually about to send.
      const metrics = await tokenDataAggregator.collect(c.mint, 'solana', { tradeSizeUsd: entryUsd });
      const score = scoringEngine.calculateScore(metrics, settings.dipScoringThreshold, {
        minLiquidityUsd: settings.dipMinLiquidityUsd,
        hardFailMinLiquidity: settings.hardFailMinLiquidity,
        maxPriceImpactPct: plan.maxPriceImpactPct,
      });

      const signal = await prisma.signal.create({
        data: {
          wallet: DIP_SCANNER_SOURCE,
          source: DIP_STRATEGY,
          chain: 'solana',
          tokenAddress: c.mint,
          tokenSymbol: metrics.symbol !== 'UNKNOWN' ? metrics.symbol : c.symbol,
          tokenName: metrics.name !== 'Unknown' ? metrics.name : c.name,
          txHash: `dip_${c.mint.slice(0, 8)}_${Date.now()}`,
          amountUsd: entryUsd,
          whaleTxAt: new Date(),
          status: 'detected',
          rawMetrics: metrics as any,
          strategyMeta: {
            timeframe,
            candleSource: ohlcv.source,
            bars: rev.bars,
            rsi: rev.rsi,
            rsiPrev: rev.rsiPrev,
            rsiLow: rev.rsiLow,
            ema21: rev.ema21,
            ema50: rev.ema50,
            bounceFromLowPct: rev.bounceFromLowPct,
            drawdownFromHighPct: rev.drawdownFromHighPct,
            volumeVsBasePct: rev.volumeVsBasePct,
            summary: rev.summary,
            checks: rev.checks,
            narrativeScore: narrative.score,
            narrative: narrative.narrative,
            narrativeTags: narrative.tags,
            narrativeNotes: narrative.notes,
            priceChange: c.change,
            buys1h: c.buys1h,
            sells1h: c.sells1h,
            entrySol: settings.dipEntrySol,
            entryUsd,
            tpUsd: plan.tpUsdTarget,
            tpUsdMax: plan.tpUsdStretch,
            slPercent: plan.slPercentOverride,
          } as any,
        },
      });

      await scoringEngine.saveScore(signal.id, score);

      if (!score.passedThreshold) {
        const why = score.isHardFail ? score.hardFailReasons.join('; ') : `score ${score.totalScore} < ${settings.dipScoringThreshold}`;
        await prisma.signal.update({ where: { id: signal.id }, data: { decision: `rejected:${why}` } });
        await audit('DIP_SIGNAL_REJECTED', `${signal.tokenSymbol}: ${why}`, { signalId: signal.id, score: score.totalScore });
        continue;
      }
      result.safetyPass++;

      await audit(
        'DIP_SIGNAL_PASSED',
        `${signal.tokenSymbol}: ${rev.summary} · narasi ${narrative.narrative || '—'} ${narrative.score}/100 · score ${score.totalScore}/100`,
        { signalId: signal.id, rsi: rev.rsi, narrativeScore: narrative.score, score: score.totalScore }
      );

      if (!settings.autoTradeMode) {
        await prisma.signal.update({ where: { id: signal.id }, data: { decision: 'approval_requested' } });
        await telegramBot.sendBuyAlert(signal.id);
        // The pending approval may still take the slot, so count it as used this cycle
        entered++;
        continue;
      }

      await prisma.signal.update({ where: { id: signal.id }, data: { status: 'approved', decision: 'auto_buy' } });
      const buy = await tradeExecutor.executeBuy(signal.id);
      await telegramBot.sendAutoBuyNotice(signal.id, buy);
      if (buy.success) {
        result.entered++;
        entered++;
      }
    }

    // Every single candidate failing to produce candles is not a market condition, it is a
    // broken candle source — say so instead of reporting a quiet market forever.
    if (result.candleMisses > 0 && result.technicalPass === 0 && result.candleMisses === Math.min(result.candidates, MAX_TECHNICAL_CHECKS)) {
      logger.warn(
        { candleMisses: result.candleMisses },
        'Dip scanner: no candles for any candidate — check GECKOTERMINAL_API_BASE / BIRDEYE_API_KEY connectivity'
      );
    }

    await audit(
      'DIP_SCAN_CYCLE',
      `${result.scanned} token dicek, ${result.candidates} lolos filter pasar, ${result.technicalPass} setup RSI, ${result.narrativePass} lolos narasi, ${result.entered} dibeli`,
      result as any
    );
    logger.info(result, 'Dip reversal scan cycle completed');
    return result;
  }

  /**
   * Market filter: only coins that are liquid, actually traded, old enough to have a chart,
   * still being bought more than sold, and not simply collapsing. A dip is only worth buying
   * in something that was healthy before the dip.
   */
  private async filterCandidates(pairs: Map<string, any>, settings: BotSettingsData): Promise<DipCandidate[]> {
    const mints = [...pairs.keys()];
    const cooldownSince = new Date(Date.now() - settings.dipCooldownMinutes * 60000);

    // Don't re-enter a token we already hold, already signalled, or just exited: without this
    // the scanner would buy the same fading coin every cycle.
    const [recentSignals, busyPositions] = await Promise.all([
      prisma.signal.findMany({
        where: { source: DIP_STRATEGY, tokenAddress: { in: mints }, createdAt: { gte: cooldownSince } },
        select: { tokenAddress: true },
      }),
      prisma.position.findMany({
        where: {
          tokenAddress: { in: mints },
          OR: [{ status: { in: ['open', 'closing'] } }, { closedAt: { gte: cooldownSince } }],
        },
        select: { tokenAddress: true },
      }),
    ]);
    const blocked = new Set([...recentSignals, ...busyPositions].map((r) => r.tokenAddress));

    const out: DipCandidate[] = [];
    for (const [mint, p] of pairs) {
      if (blocked.has(mint) || blueChipTokens.has(mint)) continue;

      const liquidityUsd = num(p.liquidity?.usd);
      const volume24h = num(p.volume?.h24);
      const ageHours = p.pairCreatedAt ? (Date.now() - Number(p.pairCreatedAt)) / 3600000 : 0;
      const change = {
        m5: num(p.priceChange?.m5),
        h1: num(p.priceChange?.h1),
        h6: num(p.priceChange?.h6),
        h24: num(p.priceChange?.h24),
      };
      const buys1h = num(p.txns?.h1?.buys);
      const sells1h = num(p.txns?.h1?.sells);

      if (liquidityUsd < settings.dipMinLiquidityUsd) continue;
      if (volume24h < settings.dipMinVolume24hUsd) continue;
      if (ageHours < settings.dipMinTokenAgeHours) continue;
      if (change.h24 < -settings.dipMaxDrawdown24hPct) continue;

      // Buy/sell flow over the last hour: in a healthy pullback buyers keep showing up
      const buySellRatio = sells1h > 0 ? buys1h / sells1h : buys1h > 0 ? 2 : 0;
      if (buySellRatio < settings.dipMinBuySellRatio) continue;

      out.push({
        mint,
        symbol: p.baseToken?.symbol || '?',
        name: p.baseToken?.name || '',
        pairAddress: p.pairAddress || null,
        priceUsd: num(p.priceUsd),
        liquidityUsd,
        volume24h,
        ageHours,
        change,
        buys1h,
        sells1h,
        socials: ((p.info?.socials || []) as any[]).map((x) => String(x?.type || '')).filter(Boolean),
        websites: ((p.info?.websites || []) as any[]).length,
        boosts: num(p.boosts?.active),
        dipRank: change.h24 - 2 * change.h1,
      });
    }

    return out.sort((a, b) => b.dipRank - a.dipRank);
  }
}

export const dipReversalScanner = new DipReversalScanner();
