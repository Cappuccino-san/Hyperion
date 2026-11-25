import { BoundedMap } from "@/lib/marketCache";

export interface CboeRawOptionRow {
  option?: string;
  open_interest?: number;
  volume?: number;
  iv?: number;
  gamma?: number;
  delta?: number;
  vega?: number;
  theta?: number;
  percent_change?: number;
  bid?: number;
  ask?: number;
  last_trade_price?: number;
  last?: number;
}

export interface CboeDelayedChainData {
  current_price?: number;
  close?: number;
  prev_day_close?: number;
  iv30?: number;
  options: CboeRawOptionRow[];
}

export interface CboeChainFetchResult {
  cboeSymbol: string;
  data: CboeDelayedChainData;
  fetchedAtMs: number;
  isStaleFallback: boolean;
}

export const CBOE_SHARED_CACHE_TTL_MS = 12_000;
const CBOE_MAX_STALE_FALLBACK_MS = 5 * 60_000;

export const CBOE_BROWSER_HEADERS: Readonly<Record<string, string>> = {
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Referer: "https://www.cboe.com/",
  Origin: "https://www.cboe.com",
};

export function mapTickerToCboeSymbol(ticker: string): string {
  const sym = ticker.trim().toUpperCase();
  if (sym === "SPX" || sym === "SPXW") return "_SPX";
  if (sym === "NDX" || sym === "NDXP") return "_NDX";
  if (sym === "VIX") return "_VIX";
  return sym;
}

interface CboeGlobalCacheState {
  cache: BoundedMap<string, { data: CboeDelayedChainData; fetchedAtMs: number }>;
  inFlight: Map<string, Promise<{ data: CboeDelayedChainData; fetchedAtMs: number }>>;
}

const globalForCboe = globalThis as unknown as {
  __hyperionSharedCboeState?: CboeGlobalCacheState;
};

function getSharedCboeState(): CboeGlobalCacheState {
  if (!globalForCboe.__hyperionSharedCboeState) {
    globalForCboe.__hyperionSharedCboeState = {
      cache: new BoundedMap<string, { data: CboeDelayedChainData; fetchedAtMs: number }>(64),
      inFlight: new Map(),
    };
  }
  return globalForCboe.__hyperionSharedCboeState;
}

function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (val) => {
        signal.removeEventListener("abort", onAbort);
        resolve(val);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      }
    );
  });
}

/**
 * Shared process-wide singleflight + 12s TTL server cache for CBOE delayed option chains.
 * Hits `https://cdn-api.cboe.com/api/global/delayed_quotes/options/{SYMBOL}.json` directly
 * with full Chrome browser headers (`User-Agent`, `Accept`, `Referer`, `Origin`) so concurrent
 * polls across `/api/gaia`, `/api/options`, `/api/flow-vwap`, and `liveBotDaemon` never trigger Cloudflare 403s.
 */
export async function fetchCboeDelayedChain(
  ticker: string,
  options?: {
    signal?: AbortSignal;
    forceRefresh?: boolean;
    allowStaleFallback?: boolean;
  }
): Promise<CboeChainFetchResult> {
  const cboeSymbol = mapTickerToCboeSymbol(ticker);
  const { cache, inFlight } = getSharedCboeState();
  const now = Date.now();

  if (!options?.forceRefresh) {
    const cached = cache.get(cboeSymbol);
    if (cached && now - cached.fetchedAtMs < CBOE_SHARED_CACHE_TTL_MS) {
      return {
        cboeSymbol,
        data: cached.data,
        fetchedAtMs: cached.fetchedAtMs,
        isStaleFallback: false,
      };
    }
  }

  let pending = inFlight.get(cboeSymbol);
  if (!pending) {
    const url = `https://cdn-api.cboe.com/api/global/delayed_quotes/options/${encodeURIComponent(cboeSymbol)}.json`;
    let created: Promise<{ data: CboeDelayedChainData; fetchedAtMs: number }> | undefined;
    created = (async () => {
      try {
        const res = await fetch(url, {
          headers: CBOE_BROWSER_HEADERS,
          cache: "no-store",
          signal: AbortSignal.timeout(8_500),
        });
        if (!res.ok) {
          console.warn(`[CBOE Feed] ${cboeSymbol} upstream returned HTTP ${res.status}`);
          throw new Error(`Live CBOE options feed HTTP ${res.status}`);
        }
        const json = await res.json();
        const data = json?.data as CboeDelayedChainData | undefined;
        if (!data || !Array.isArray(data.options) || data.options.length === 0) {
          console.warn(`[CBOE Feed] ${cboeSymbol} upstream returned empty options array`);
          throw new Error("Live CBOE options feed returned empty option chain");
        }
        const entry = { data, fetchedAtMs: Date.now() };
        cache.set(cboeSymbol, entry);
        return entry;
      } finally {
        if (inFlight.get(cboeSymbol) === created) {
          inFlight.delete(cboeSymbol);
        }
      }
    })();
    pending = created;
    inFlight.set(cboeSymbol, pending);
  }

  try {
    const fresh = await raceWithAbort(pending, options?.signal);
    return {
      cboeSymbol,
      data: fresh.data,
      fetchedAtMs: fresh.fetchedAtMs,
      isStaleFallback: false,
    };
  } catch (err) {
    if (options?.allowStaleFallback && !options?.signal?.aborted) {
      const stale = cache.get(cboeSymbol);
      if (stale && Date.now() - stale.fetchedAtMs < CBOE_MAX_STALE_FALLBACK_MS) {
        console.warn(
          `[CBOE Feed] ${cboeSymbol} serving cached snapshot (${Math.round((Date.now() - stale.fetchedAtMs) / 1000)}s old) after transient error:`,
          err instanceof Error ? err.message : String(err)
        );
        return {
          cboeSymbol,
          data: stale.data,
          fetchedAtMs: stale.fetchedAtMs,
          isStaleFallback: true,
        };
      }
    }
    throw err;
  }
}
