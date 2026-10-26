import type { OptionsAnalyticsPayload } from "@/lib/optionsExposure";

export interface CacheEntry {
  timestamp: number;
  payload: OptionsAnalyticsPayload;
}

const globalForMarketCache = globalThis as unknown as {
  __hyperionOptionsMemoryCache?: Map<string, CacheEntry>;
};

export const optionsMemoryCache: Map<string, CacheEntry> =
  globalForMarketCache.__hyperionOptionsMemoryCache ??
  (globalForMarketCache.__hyperionOptionsMemoryCache = new Map<
    string,
    CacheEntry
  >());

export function getMemoryCacheEntries(): { ticker: string; timestamp: number }[] {
  const result: { ticker: string; timestamp: number }[] = [];
  optionsMemoryCache.forEach((entry, ticker) => {
    result.push({ ticker, timestamp: entry.timestamp });
  });
  return result;
}
