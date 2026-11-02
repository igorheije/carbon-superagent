const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

const attempts = new Map<string, readonly number[]>();

/** In-memory sliding window for login attempts (single local process). */
export function isRateLimited(key: string, now = Date.now()): boolean {
  const recent = (attempts.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  attempts.set(key, recent);
  return recent.length >= MAX_ATTEMPTS;
}

export function recordFailure(key: string, now = Date.now()): void {
  attempts.set(key, [...(attempts.get(key) ?? []).filter((t) => now - t < WINDOW_MS), now]);
}

export function clearFailures(key: string): void {
  attempts.delete(key);
}
