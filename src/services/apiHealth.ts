import { logger } from './logger.js';

export type ApiEventKind = '429' | 'timeout';

interface ApiHealthEvent {
  provider: string;
  kind: ApiEventKind;
  at: number;
  detail?: string;
}

const WINDOW_MS = 24 * 3600 * 1000;
const events: ApiHealthEvent[] = [];

function prune() {
  const cutoff = Date.now() - WINDOW_MS;
  while (events.length && events[0].at < cutoff) events.shift();
}

/**
 * Record a 429 (rate-limited) or timeout from any outbound provider call. This is the
 * evidence trail behind the "sudah waktunya upgrade?" question — plan upgrades should
 * follow real pressure on a provider, not guesswork.
 */
export function recordApiEvent(provider: string, kind: ApiEventKind, detail?: string) {
  prune();
  events.push({ provider, kind, at: Date.now(), detail });
  logger.warn({ provider, kind, detail }, `API health: ${kind} on ${provider}`);
}

/** Best-effort provider name from a request URL, for the shared getJson() helpers */
export function providerFromUrl(url: string): string {
  if (url.includes('helius')) return 'helius';
  if (url.includes('dexscreener')) return 'dexscreener';
  if (url.includes('gopluslabs')) return 'goplus';
  if (url.includes('rugcheck')) return 'rugcheck';
  if (url.includes('birdeye')) return 'birdeye';
  if (url.includes('jup-ag') || url.includes('jupiter')) return 'jupiter';
  return 'other';
}

export function isTimeoutError(err: any): boolean {
  return err?.name === 'TimeoutError' || err?.name === 'AbortError';
}

// 1h thresholds past which a provider is plausibly the bottleneck, not just a blip
const UPGRADE_429_THRESHOLD_1H = 3;
const UPGRADE_TIMEOUT_THRESHOLD_1H = 5;

export interface ProviderHealth {
  provider: string;
  count1h: number;
  count24h: number;
  rateLimited1h: number;
  timeouts1h: number;
  upgradeSuggested: boolean;
  lastAt?: number;
  lastDetail?: string;
}

export function getApiHealthSummary(): ProviderHealth[] {
  prune();
  const now = Date.now();
  const providers = [...new Set(events.map((e) => e.provider))].sort();
  return providers.map((provider) => {
    const own = events.filter((e) => e.provider === provider);
    const last1h = own.filter((e) => now - e.at < 3600_000);
    const rateLimited1h = last1h.filter((e) => e.kind === '429').length;
    const timeouts1h = last1h.filter((e) => e.kind === 'timeout').length;
    const last = own[own.length - 1];
    return {
      provider,
      count1h: last1h.length,
      count24h: own.length,
      rateLimited1h,
      timeouts1h,
      upgradeSuggested: rateLimited1h >= UPGRADE_429_THRESHOLD_1H || timeouts1h >= UPGRADE_TIMEOUT_THRESHOLD_1H,
      lastAt: last?.at,
      lastDetail: last?.detail,
    };
  });
}
