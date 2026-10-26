export interface CacheItemStats {
  ticker: string;
  ageMs: number;
  fresh: boolean;
  timestamp: number;
}

export interface TelemetryData {
  status: "HEALTHY" | "DEGRADED" | "OFFLINE";
  uptimeSeconds: number;
  serverTimestamp: string;
  memory: {
    rssBytes: number;
    rssFormatted: string;
    heapUsedBytes: number;
    heapUsedFormatted: string;
    heapTotalBytes: number;
    heapTotalFormatted: string;
    externalBytes: number;
    externalFormatted: string;
  };
  upstream: {
    provider: string;
    latencyMs: number;
    lastSuccessfulFetch: string | null;
    lastAttemptTimestamp: string | null;
    lastError: string | null;
    consecutiveFailures: number;
  };
  cache: {
    totalEntries: number;
    freshnessTimestamp: string | null;
    cachedTickers: CacheItemStats[];
  };
  subscriptions: {
    activeTickers: string[];
    defaultPollIntervalMs: number;
  };
}

class TelemetryTracker {
  private lastLatencyMs: number = 0;
  private lastSuccessfulFetch: number | null = null;
  private lastAttemptTimestamp: number | null = null;
  private lastError: string | null = null;
  private consecutiveFailures: number = 0;
  private activeSubscriptions = new Set<string>([
    "SPY",
    "QQQ",
    "IWM",
    "NVDA",
    "AAPL",
    "MSFT",
    "TSLA",
  ]);

  recordAttempt(ticker: string) {
    this.lastAttemptTimestamp = Date.now();
    this.activeSubscriptions.add(ticker.toUpperCase());
  }

  recordSuccess(ticker: string, latencyMs: number) {
    this.lastLatencyMs = latencyMs;
    this.lastSuccessfulFetch = Date.now();
    this.lastAttemptTimestamp = Date.now();
    this.lastError = null;
    this.consecutiveFailures = 0;
    this.activeSubscriptions.add(ticker.toUpperCase());
  }

  recordFailure(ticker: string, error: string, latencyMs: number = 0) {
    if (latencyMs > 0) this.lastLatencyMs = latencyMs;
    this.lastAttemptTimestamp = Date.now();
    this.lastError = error;
    this.consecutiveFailures += 1;
    this.activeSubscriptions.add(ticker.toUpperCase());
  }

  getMetrics(cacheEntries?: { ticker: string; timestamp: number }[]): TelemetryData {
    const now = Date.now();
    const mem = process.memoryUsage();

    const cacheStats: CacheItemStats[] = (cacheEntries || []).map((e) => ({
      ticker: e.ticker,
      ageMs: now - e.timestamp,
      fresh: now - e.timestamp < 10_000,
      timestamp: e.timestamp,
    }));

    let newestTimestamp: number | null = null;
    for (const c of cacheStats) {
      if (newestTimestamp === null || c.timestamp > newestTimestamp) {
        newestTimestamp = c.timestamp;
      }
    }

    const status: "HEALTHY" | "DEGRADED" | "OFFLINE" =
      this.consecutiveFailures === 0
        ? "HEALTHY"
        : this.consecutiveFailures < 3
          ? "DEGRADED"
          : "OFFLINE";

    return {
      status,
      uptimeSeconds: Math.floor(process.uptime()),
      serverTimestamp: new Date(now).toISOString(),
      memory: {
        rssBytes: mem.rss,
        rssFormatted: `${(mem.rss / 1024 / 1024).toFixed(1)} MB`,
        heapUsedBytes: mem.heapUsed,
        heapUsedFormatted: `${(mem.heapUsed / 1024 / 1024).toFixed(1)} MB`,
        heapTotalBytes: mem.heapTotal,
        heapTotalFormatted: `${(mem.heapTotal / 1024 / 1024).toFixed(1)} MB`,
        externalBytes: mem.external,
        externalFormatted: `${(mem.external / 1024 / 1024).toFixed(1)} MB`,
      },
      upstream: {
        provider: "CBOE_MARKET_DATA",
        latencyMs: this.lastLatencyMs,
        lastSuccessfulFetch: this.lastSuccessfulFetch
          ? new Date(this.lastSuccessfulFetch).toISOString()
          : null,
        lastAttemptTimestamp: this.lastAttemptTimestamp
          ? new Date(this.lastAttemptTimestamp).toISOString()
          : null,
        lastError: this.lastError,
        consecutiveFailures: this.consecutiveFailures,
      },
      cache: {
        totalEntries: cacheStats.length,
        freshnessTimestamp: newestTimestamp
          ? new Date(newestTimestamp).toISOString()
          : null,
        cachedTickers: cacheStats,
      },
      subscriptions: {
        activeTickers: Array.from(this.activeSubscriptions),
        defaultPollIntervalMs: 15_000,
      },
    };
  }
}

export const globalTelemetry = new TelemetryTracker();
