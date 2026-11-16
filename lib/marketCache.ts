import type { OptionsAnalyticsPayload } from "@/lib/optionsExposure";

export interface CacheEntry {
  timestamp: number;
  payload: OptionsAnalyticsPayload;
}

export const MAX_MARKET_CACHE_ENTRIES = 64;
export const VALID_TICKER_REGEX = /^[A-Z0-9._^-]{1,10}$/;

export function sanitizeTickerSymbol(raw?: string | null, fallback = "SPY"): string {
  const cleaned = (raw ?? "").trim().toUpperCase();
  return VALID_TICKER_REGEX.test(cleaned) ? cleaned : fallback;
}

export function setBoundedMapEntry<K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
  maxEntries: number = MAX_MARKET_CACHE_ENTRIES
): void {
  if (map.has(key)) {
    map.delete(key);
  }
  map.set(key, value);
  while (map.size > maxEntries) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) break;
    map.delete(oldestKey);
  }
}

export class BoundedMap<K, V> extends Map<K, V> {
  private readonly maxEntries: number;

  constructor(
    maxEntries: number = MAX_MARKET_CACHE_ENTRIES,
    entries?: readonly (readonly [K, V])[] | null
  ) {
    super(entries);
    this.maxEntries = Math.max(1, maxEntries);
    while (this.size > this.maxEntries) {
      const oldestKey = this.keys().next().value;
      if (oldestKey === undefined) break;
      this.delete(oldestKey);
    }
  }

  override set(key: K, value: V): this {
    if (this.has(key)) {
      this.delete(key);
    }
    super.set(key, value);
    while (this.size > this.maxEntries) {
      const oldestKey = this.keys().next().value;
      if (oldestKey === undefined) break;
      this.delete(oldestKey);
    }
    return this;
  }
}

const globalForMarketCache = globalThis as unknown as {
  __hyperionOptionsMemoryCache?: Map<string, CacheEntry>;
};

const existingCache = globalForMarketCache.__hyperionOptionsMemoryCache;
export const optionsMemoryCache: Map<string, CacheEntry> =
  existingCache instanceof BoundedMap
    ? existingCache
    : (globalForMarketCache.__hyperionOptionsMemoryCache = new BoundedMap<
        string,
        CacheEntry
      >(MAX_MARKET_CACHE_ENTRIES, existingCache ? Array.from(existingCache.entries()) : null));
