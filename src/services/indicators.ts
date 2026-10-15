import { env } from '../config/index.js';
import { recordApiEvent, providerFromUrl, isTimeoutError } from './apiHealth.js';
import { logger } from './logger.js';

export interface Candle {
  /** Bar open time, ms */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export type Timeframe = '5m' | '15m' | '1h' | '4h';

/** GeckoTerminal splits a timeframe into a base unit + aggregation; Birdeye uses one label */
const TIMEFRAME_MAP: Record<Timeframe, { gtUnit: 'minute' | 'hour'; gtAggregate: number; birdeye: string; minutes: number }> = {
  '5m': { gtUnit: 'minute', gtAggregate: 5, birdeye: '5m', minutes: 5 },
  '15m': { gtUnit: 'minute', gtAggregate: 15, birdeye: '15m', minutes: 15 },
  '1h': { gtUnit: 'hour', gtAggregate: 1, birdeye: '1H', minutes: 60 },
  '4h': { gtUnit: 'hour', gtAggregate: 4, birdeye: '4H', minutes: 240 },
};

export function isTimeframe(v: string): v is Timeframe {
  return v in TIMEFRAME_MAP;
}

async function getJson(url: string, timeoutMs = 8000, headers?: Record<string, string>): Promise<any | null> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 429) recordApiEvent(providerFromUrl(url), '429', url.split('?')[0]);
    if (!res.ok) {
      logger.warn({ status: res.status, url: url.split('?')[0] }, 'Candle source returned non-200');
      return null;
    }
    return await res.json();
  } catch (err: any) {
    if (isTimeoutError(err)) recordApiEvent(providerFromUrl(url), 'timeout', url.split('?')[0]);
    logger.warn({ url: url.split('?')[0], err: err?.message }, 'Candle source request failed');
    return null;
  }
}

/**
 * OHLCV for a Solana token. GeckoTerminal is free and needs no key but is keyed by *pool*
 * (DexScreener's pairAddress); Birdeye is keyed by mint and needs a key. Try both so a token
 * whose main pool GeckoTerminal does not index can still be evaluated.
 */
export async function fetchCandles(opts: {
  mint: string;
  poolAddress?: string | null;
  timeframe: Timeframe;
  limit?: number;
}): Promise<{ candles: Candle[]; source: 'geckoterminal' | 'birdeye' } | null> {
  const tf = TIMEFRAME_MAP[opts.timeframe];
  const limit = Math.min(1000, Math.max(30, opts.limit ?? 120));

  if (opts.poolAddress) {
    const url =
      `${env.GECKOTERMINAL_API_BASE}/networks/solana/pools/${opts.poolAddress}/ohlcv/${tf.gtUnit}` +
      `?aggregate=${tf.gtAggregate}&limit=${limit}&currency=usd&token=base`;
    const json = await getJson(url, 10000, { accept: 'application/json' });
    const list = json?.data?.attributes?.ohlcv_list;
    if (Array.isArray(list) && list.length > 0) {
      const candles = list
        .map((row: any[]) => ({
          t: Number(row[0]) * 1000,
          o: Number(row[1]),
          h: Number(row[2]),
          l: Number(row[3]),
          c: Number(row[4]),
          v: Number(row[5]) || 0,
        }))
        .filter((c: Candle) => c.c > 0 && Number.isFinite(c.t))
        .sort((a: Candle, b: Candle) => a.t - b.t);
      if (candles.length > 0) return { candles, source: 'geckoterminal' };
    }
  }

  if (env.BIRDEYE_API_KEY) {
    const now = Math.floor(Date.now() / 1000);
    const from = now - limit * tf.minutes * 60;
    const url = `${env.BIRDEYE_API_BASE}/defi/ohlcv?address=${opts.mint}&type=${tf.birdeye}&time_from=${from}&time_to=${now}`;
    const json = await getJson(url, 10000, {
      accept: 'application/json',
      'x-chain': 'solana',
      'X-API-KEY': env.BIRDEYE_API_KEY,
    });
    const items = json?.data?.items;
    if (Array.isArray(items) && items.length > 0) {
      const candles = items
        .map((i: any) => ({
          t: Number(i.unixTime) * 1000,
          o: Number(i.o),
          h: Number(i.h),
          l: Number(i.l),
          c: Number(i.c),
          v: Number(i.v) || 0,
        }))
        .filter((c: Candle) => c.c > 0 && Number.isFinite(c.t))
        .sort((a: Candle, b: Candle) => a.t - b.t);
      if (candles.length > 0) return { candles, source: 'birdeye' };
    }
  }

  return null;
}

/**
 * Wilder's RSI, the definition every charting tool uses. Index i holds the RSI of close i;
 * the first `period` entries are NaN because the average has no history to run on yet.
 */
export function rsiSeries(closes: number[], period = 14): number[] {
  const out = new Array<number>(closes.length).fill(NaN);
  if (closes.length <= period || period < 2) return out;

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  const rsiFrom = (g: number, l: number) => (l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l));
  out[period] = rsiFrom(avgGain, avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
    out[i] = rsiFrom(avgGain, avgLoss);
  }
  return out;
}

/** Exponential moving average, seeded with the SMA of the first `period` values */
export function emaSeries(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length < period || period < 1) return out;
  const k = 2 / (period + 1);
  let sma = 0;
  for (let i = 0; i < period; i++) sma += values[i];
  let prev = sma / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export interface ReversalOptions {
  rsiPeriod?: number;
  /** RSI must have dipped to at least this low inside the lookback window */
  oversold?: number;
  /** …and must still be at or below this, or the bounce already happened without us */
  rsiMax?: number;
  /** Bars the oversold low and the price low are measured over */
  lookback?: number;
  /** RSI points above the window low that count as "turning up" */
  minTurnUp?: number;
  /** Price must be at least this far above the window low */
  minBounceFromLowPct?: number;
}

export interface IndicatorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ReversalResult {
  ok: boolean;
  checks: IndicatorCheck[];
  /** Why it was rejected — empty when ok */
  reasons: string[];
  summary: string;
  bars: number;
  rsi: number | null;
  rsiPrev: number | null;
  rsiLow: number | null;
  ema21: number | null;
  ema50: number | null;
  lastClose: number | null;
  bounceFromLowPct: number | null;
  drawdownFromHighPct: number | null;
  volumeVsBasePct: number | null;
  /** EMA21 relative to EMA50, in % — negative during a pullback */
  trendGapPct: number | null;
}

/**
 * How far the fast average may sit under the slow one before the pullback stops being a
 * pullback. A normal dip pushes EMA21 below EMA50; a structural downtrend drags it far below.
 */
const MAX_SHORT_TREND_GAP_PCT = 15;
const TREND_MIN_BARS = 55; // below this there is no EMA50 to judge a trend by
const VOL_RECENT_BARS = 3;
const VOL_BASE_BARS = 12;
const MIN_VOLUME_VS_BASE_PCT = 15; // recent volume this far under the baseline = the pool is dying

/**
 * The entry condition: a token that sold off into oversold territory and has just started to
 * turn back up, while its longer trend is still intact and the pool is still being traded.
 *
 * Deliberately *not* "RSI < 30, buy": an oversold reading alone is what a token in free fall
 * prints all the way down. The turn-up, the bounce off the low, the trend filter and the volume
 * floor are what separate a pullback inside an uptrend from a knife.
 */
export function evaluateReversal(candles: Candle[], opts: ReversalOptions = {}): ReversalResult {
  const rsiPeriod = opts.rsiPeriod ?? 14;
  const oversold = opts.oversold ?? 35;
  const rsiMax = opts.rsiMax ?? 50;
  const lookback = opts.lookback ?? 8;
  const minTurnUp = opts.minTurnUp ?? 2;
  const minBounce = opts.minBounceFromLowPct ?? 0.5;

  const checks: IndicatorCheck[] = [];
  const empty: ReversalResult = {
    ok: false,
    checks,
    reasons: [],
    summary: '',
    bars: candles.length,
    rsi: null,
    rsiPrev: null,
    rsiLow: null,
    ema21: null,
    ema50: null,
    lastClose: null,
    bounceFromLowPct: null,
    drawdownFromHighPct: null,
    volumeVsBasePct: null,
    trendGapPct: null,
  };

  const minBars = rsiPeriod + lookback + 2;
  if (candles.length < minBars) {
    checks.push({ name: 'history', ok: false, detail: `${candles.length} bar < ${minBars} minimum` });
    return { ...empty, reasons: [`not enough candles (${candles.length}/${minBars})`], summary: 'riwayat candle terlalu pendek' };
  }
  checks.push({ name: 'history', ok: true, detail: `${candles.length} bar` });

  const closes = candles.map((c) => c.c);
  const rsis = rsiSeries(closes, rsiPeriod);
  const last = closes.length - 1;
  const rsi = rsis[last];
  const rsiPrev = rsis[last - 1];
  if (!Number.isFinite(rsi) || !Number.isFinite(rsiPrev)) {
    return { ...empty, reasons: ['RSI could not be computed'], summary: 'RSI tidak bisa dihitung' };
  }

  const window = rsis.slice(Math.max(0, last - lookback + 1)).filter(Number.isFinite);
  const rsiLow = Math.min(...window);
  const priceWindow = candles.slice(Math.max(0, last - lookback + 1));
  const windowLow = Math.min(...priceWindow.map((c) => c.l));
  const windowHigh = Math.max(...priceWindow.map((c) => c.h));
  const lastClose = closes[last];
  const bounceFromLowPct = windowLow > 0 ? ((lastClose - windowLow) / windowLow) * 100 : 0;
  const drawdownFromHighPct = windowHigh > 0 ? ((windowHigh - lastClose) / windowHigh) * 100 : 0;

  const ema21Arr = emaSeries(closes, 21);
  const ema50Arr = emaSeries(closes, 50);
  const ema21 = Number.isFinite(ema21Arr[last]) ? ema21Arr[last] : null;
  const ema50 = Number.isFinite(ema50Arr[last]) ? ema50Arr[last] : null;

  const recentVol = candles.slice(-VOL_RECENT_BARS).reduce((a, c) => a + c.v, 0) / VOL_RECENT_BARS;
  const baseSlice = candles.slice(-(VOL_RECENT_BARS + VOL_BASE_BARS), -VOL_RECENT_BARS);
  const baseVol = baseSlice.length ? baseSlice.reduce((a, c) => a + c.v, 0) / baseSlice.length : 0;
  const volumeVsBasePct = baseVol > 0 ? (recentVol / baseVol) * 100 : recentVol > 0 ? 100 : 0;

  const add = (name: string, ok: boolean, detail: string) => {
    checks.push({ name, ok, detail });
    return ok;
  };

  const wasOversold = add('oversold', rsiLow <= oversold, `RSI low ${rsiLow.toFixed(1)} (≤ ${oversold})`);
  const turningUp = add(
    'turning_up',
    rsi >= rsiLow + minTurnUp && rsi > rsiPrev,
    `RSI ${rsiPrev.toFixed(1)} → ${rsi.toFixed(1)} (butuh ≥ ${(rsiLow + minTurnUp).toFixed(1)} dan naik)`
  );
  const stillLow = add('not_recovered', rsi <= rsiMax, `RSI ${rsi.toFixed(1)} (≤ ${rsiMax})`);
  const offLows = add('off_the_lows', bounceFromLowPct >= minBounce, `+${bounceFromLowPct.toFixed(2)}% dari low (≥ ${minBounce}%)`);
  const trendGapPct = ema21 != null && ema50 != null && ema50 > 0 ? (ema21 / ema50 - 1) * 100 : null;
  const trendIntact =
    candles.length < TREND_MIN_BARS || trendGapPct == null
      ? add('trend_intact', true, 'dilewati — riwayat belum cukup untuk EMA50')
      : add(
          'trend_intact',
          trendGapPct >= -MAX_SHORT_TREND_GAP_PCT,
          `EMA21 ${trendGapPct >= 0 ? '+' : ''}${trendGapPct.toFixed(1)}% vs EMA50 (batas −${MAX_SHORT_TREND_GAP_PCT}%)`
        );
  const volumeAlive = add(
    'volume_alive',
    recentVol > 0 && volumeVsBasePct >= MIN_VOLUME_VS_BASE_PCT,
    `volume ${volumeVsBasePct.toFixed(0)}% dari baseline (≥ ${MIN_VOLUME_VS_BASE_PCT}%)`
  );

  const ok = wasOversold && turningUp && stillLow && offLows && trendIntact && volumeAlive;
  const reasons = checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);

  return {
    ok,
    checks,
    reasons,
    summary: `RSI ${rsi.toFixed(1)} (low ${rsiLow.toFixed(1)}) · +${bounceFromLowPct.toFixed(2)}% dari low · volume ${volumeVsBasePct.toFixed(0)}% baseline`,
    bars: candles.length,
    rsi,
    rsiPrev,
    rsiLow,
    ema21,
    ema50,
    lastClose,
    bounceFromLowPct,
    drawdownFromHighPct,
    volumeVsBasePct,
    trendGapPct,
  };
}
