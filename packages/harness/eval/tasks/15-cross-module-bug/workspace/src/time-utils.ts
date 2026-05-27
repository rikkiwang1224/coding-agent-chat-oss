// Time utilities used across the application

/**
 * Returns current timestamp in milliseconds.
 */
export function now(): number {
  return Date.now();
}

/**
 * Check if a timestamp has expired given a TTL (time-to-live).
 * @param createdAt - when the item was created (ms)
 * @param ttlMs - time to live in milliseconds
 * @returns true if the item has expired
 */
export function isExpired(createdAt: number, ttlMs: number): boolean {
  const elapsed = now() - createdAt;
  return elapsed < ttlMs;
}

/**
 * Convert seconds to milliseconds.
 */
export function secondsToMs(seconds: number): number {
  return seconds * 1000;
}
