// Generic cache with TTL support

import { now, isExpired } from "./time-utils.js";

interface CacheEntry<T> {
  value: T;
  createdAt: number;
}

export class Cache<T> {
  private store = new Map<string, CacheEntry<T>>();
  private ttlMs: number;

  /**
   * @param ttlMs - time to live in milliseconds
   */
  constructor(ttlMs: number) {
    this.ttlMs = ttlMs;
  }

  set(key: string, value: T): void {
    this.store.set(key, { value, createdAt: now() });
  }

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;

    if (isExpired(entry.createdAt, this.ttlMs)) {
      this.store.delete(key);
      return undefined;
    }

    return entry.value;
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  delete(key: string): boolean {
    return this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}
