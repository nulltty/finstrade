/** In-memory heartbeat of the background engines, surfaced on the cockpit dashboard */
export interface EngineBeat {
  lastRunAt: number | null;
  lastDurationMs: number | null;
  runs: number;
  errors: number;
  lastError: string | null;
  lastResult: Record<string, any> | null;
}

const beat = (): EngineBeat => ({ lastRunAt: null, lastDurationMs: null, runs: 0, errors: 0, lastError: null, lastResult: null });

export const systemStatus = {
  startedAt: Date.now(),
  scanner: beat(),
  discovery: beat(),
  dipScanner: beat(),
  monitor: beat(),
  pipeline: beat(),
};

export type EngineName = 'scanner' | 'discovery' | 'dipScanner' | 'monitor' | 'pipeline';

export async function trackRun<T extends Record<string, any> | void>(engine: EngineName, fn: () => Promise<T>): Promise<T> {
  const b = systemStatus[engine];
  const started = Date.now();
  try {
    const result = await fn();
    b.lastResult = (result as Record<string, any>) || null;
    return result;
  } catch (err: any) {
    b.errors++;
    b.lastError = err?.message || String(err);
    throw err;
  } finally {
    b.runs++;
    b.lastRunAt = Date.now();
    b.lastDurationMs = Date.now() - started;
  }
}
