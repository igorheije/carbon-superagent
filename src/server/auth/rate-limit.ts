/**
 * In-memory sliding-window failure counters (single panel process).
 *
 * Bounded: keys with no recent failure are dropped by a periodic sweep, and past `maxKeys` the
 * least recently touched keys are evicted first (Map insertion order, refreshed on every write).
 * An attacker cycling keys can at most evict old counters; memory stays capped.
 */

export interface LimiterOptions {
  readonly windowMs: number;
  readonly maxAttempts: number;
  readonly maxKeys: number;
  /** Minimum interval between full sweeps of expired keys. */
  readonly sweepEveryMs?: number;
}

export interface Limiter {
  isLimited(key: string, now?: number): boolean;
  recordFailure(key: string, now?: number): void;
  clear(key: string): void;
  size(): number;
}

const DEFAULT_SWEEP_MS = 60_000;

export function createLimiter(options: LimiterOptions): Limiter {
  const attempts = new Map<string, readonly number[]>();
  const sweepEvery = options.sweepEveryMs ?? DEFAULT_SWEEP_MS;
  let lastSweep = 0;

  const recentOf = (key: string, now: number): readonly number[] => (attempts.get(key) ?? []).filter((t) => now - t < options.windowMs);

  function sweep(now: number): void {
    if (now - lastSweep < sweepEvery) return;
    lastSweep = now;
    for (const [key, times] of attempts) {
      if (!times.some((t) => now - t < options.windowMs)) attempts.delete(key);
    }
  }

  function evictOverflow(): void {
    for (const key of attempts.keys()) {
      if (attempts.size <= options.maxKeys) return;
      attempts.delete(key);
    }
  }

  return {
    isLimited(key, now = Date.now()) {
      sweep(now);
      const recent = recentOf(key, now);
      if (recent.length === 0) attempts.delete(key);
      return recent.length >= options.maxAttempts;
    },
    recordFailure(key, now = Date.now()) {
      sweep(now);
      const next = [...recentOf(key, now), now].slice(-options.maxAttempts);
      attempts.delete(key);
      attempts.set(key, next);
      evictOverflow();
    },
    clear(key) {
      attempts.delete(key);
    },
    size: () => attempts.size,
  };
}

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;
export const MAX_TRACKED_KEYS = 10_000;

const defaultLimiter = createLimiter({ windowMs: WINDOW_MS, maxAttempts: MAX_ATTEMPTS, maxKeys: MAX_TRACKED_KEYS });

/** Login attempts and per-token worker failures. */
export function isRateLimited(key: string, now = Date.now()): boolean {
  return defaultLimiter.isLimited(key, now);
}

export function recordFailure(key: string, now = Date.now()): void {
  defaultLimiter.recordFailure(key, now);
}

export function clearFailures(key: string): void {
  defaultLimiter.clear(key);
}
