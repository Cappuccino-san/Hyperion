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
