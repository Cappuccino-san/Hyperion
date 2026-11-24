import { NextResponse } from "next/server";
import {
  generateDailyPlaybook,
  LiveTickerTelemetry,
  PLAYBOOK_TICKER_UNIVERSE,
} from "@/lib/playbookEngine";

type PlaybookPayload = ReturnType<typeof generateDailyPlaybook>;
import { optionsMemoryCache, setBoundedMapEntry } from "@/lib/marketCache";
import {
  fetchLiveCboeOptions,
  getCachedSpotPrice,
  reanchorDelayedContractsToSpot,
} from "@/lib/tradeSignalEngine";
import {
  computeOptionsAnalytics,
  deriveTacticalStructuralLevels,
  globalContractsCache,
} from "@/lib/optionsExposure";
import { isMarketOpen } from "@/lib/marketDataService";

export const dynamic = "force-dynamic";

const PLAYBOOK_CONCURRENCY = 4;
const PLAYBOOK_TTL_RTH_MS = 30_000;
const PLAYBOOK_TTL_OFF_HOURS_MS = 300_000;
const TICKER_CHAIN_TIMEOUT_MS = 850;
const COLD_HYDRATION_BUDGET_MS = 1_550;

interface PlaybookCacheEntry {
  tsMs: number;
  payload: PlaybookPayload;
}

const globalForPlaybook = globalThis as typeof globalThis & {
  __hyperionPlaybookRouteCache?: PlaybookCacheEntry | null;
  __hyperionPlaybookInFlight?: Promise<PlaybookPayload> | null;
};

async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let cursor = 0;
  const poolSize = Math.max(1, Math.min(concurrency, items.length));
  const runners = Array.from({ length: poolSize }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      await worker(items[idx]);
    }
  });
  await Promise.all(runners);
}

async function computeFreshPlaybook(): Promise<PlaybookPayload> {
  const telemetryOverrides: Record<string, Partial<LiveTickerTelemetry>> = {};
  const rawChainsByTicker = new Map<string, Awaited<ReturnType<typeof fetchLiveCboeOptions>>>();

  // Run spot quote batch & bounded-concurrency (4) CBOE chain fetches in parallel within strict <2.1s cold budget
  const quoteBatchPromise = (async () => {
    try {
      const symbolsParam = PLAYBOOK_TICKER_UNIVERSE.join(",");
      const rhRes = await fetch(
        `https://api.robinhood.com/quotes/?symbols=${symbolsParam}`,
        {
          headers: {
            Accept: "application/json",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) HyperionTerminal/1.0",
          },
          cache: "no-store",
          signal: AbortSignal.timeout(1_100),
        }
      );
      if (rhRes.ok) {
        const rhData = await rhRes.json();
        for (const item of rhData?.results || []) {
          const s = String(item?.symbol || "").toUpperCase();
          const p = Number(item?.last_trade_price ?? item?.bid_price ?? 0);
          const prev = Number(item?.previous_close ?? 0);
          if (s && p > 0) {
            telemetryOverrides[s] = {
              spotPrice: Number(p.toFixed(2)),
              previousClose: prev > 0 ? Number(prev.toFixed(2)) : undefined,
            };
          }
        }
      }
    } catch {
      // Non-fatal quote pre-fetch error
    }
  })();

  const chainPoolPromise = runWithConcurrency(
    PLAYBOOK_TICKER_UNIVERSE,
    PLAYBOOK_CONCURRENCY,
    async (ticker) => {
      const sUpper = ticker.toUpperCase();
      const cached = optionsMemoryCache.get(sUpper);
      if (cached && cached.payload.strikes.length > 0 && Date.now() - cached.timestamp < 120_000) {
        return;
      }
      try {
        const contracts = await fetchLiveCboeOptions(
          sUpper,
          AbortSignal.timeout(TICKER_CHAIN_TIMEOUT_MS)
        );
        if (contracts.length > 0) {
          rawChainsByTicker.set(sUpper, contracts);
        }
      } catch {
        // Non-fatal per-ticker timeout; warm cache asynchronously if needed
      }
    }
  );

  await Promise.race([
    Promise.allSettled([quoteBatchPromise, chainPoolPromise]),
    new Promise<void>((resolve) => setTimeout(resolve, COLD_HYDRATION_BUDGET_MS)),
  ]);

  for (const ticker of PLAYBOOK_TICKER_UNIVERSE) {
    const sUpper = ticker.toUpperCase();
    const cached = optionsMemoryCache.get(sUpper);
    const cacheFresh =
      cached &&
      cached.payload.strikes.length > 0 &&
      Date.now() - cached.timestamp < 120_000;
    let payload = cacheFresh ? cached.payload : undefined;

    if (!payload) {
      const contracts = rawChainsByTicker.get(sUpper);
      const cboeRefSpot = getCachedSpotPrice(sUpper) ?? 0;
      const liveSpot = telemetryOverrides[sUpper]?.spotPrice ?? cboeRefSpot;
      const prevClose = telemetryOverrides[sUpper]?.previousClose ?? liveSpot;
      if (contracts && contracts.length > 0 && liveSpot && liveSpot > 0) {
        try {
          const rawEntry = globalContractsCache.get(sUpper);
          const sourceContracts =
            rawEntry && rawEntry.rawContracts.length > 0
              ? rawEntry.rawContracts
              : contracts;
          const refSpot =
            rawEntry && rawEntry.referenceSpot > 0
              ? rawEntry.referenceSpot
              : cboeRefSpot > 0
                ? cboeRefSpot
                : liveSpot;
          const fetchedAtMs = rawEntry?.fetchedAtMs ?? Date.now();
          // Restrict on-demand 0DTE Playbook hydration to front 5 expirations + +/-8% spot corridor
          // (avoids 1M+ Newton-Raphson BS iterations across 30+ LEAPS expirations on cold boot)
          const activeExps = Array.from(new Set(sourceContracts.map((c) => c.expiration)))
            .sort()
            .slice(0, 5);
          const expSet = new Set(activeExps);
          const nearContracts = sourceContracts.filter(
            (c) => expSet.has(c.expiration) && Math.abs(c.strike - liveSpot) <= liveSpot * 0.08
          );
          const workingSet = nearContracts.length > 0 ? nearContracts : sourceContracts.slice(0, 600);
          const anchored = reanchorDelayedContractsToSpot({
            contracts: workingSet,
            referenceSpot: refSpot,
            liveSpot,
            fetchedAtMs,
            fallbackIv: 0.22,
          });
          payload = computeOptionsAnalytics({
            ticker: sUpper,
            dataSource: "CBOE_MARKET_DATA",
            spotPrice: liveSpot,
            previousClose: prevClose ?? liveSpot,
            contracts: anchored,
          });
        } catch {
          payload = cached?.payload;
        }
      } else if (cached?.payload && cached.payload.strikes.length > 0) {
        payload = cached.payload;
      }
    }

    if (payload && payload.strikes.length > 0) {
      const tactical = deriveTacticalStructuralLevels(payload);
      let vexKing = payload.kingNode.zeroDteKing ?? payload.kingNode.allExpKing;
      let maxVexAbs = -1;
      for (const row of payload.strikes) {
        let sumVex = 0;
        for (const col of payload.expirations) {
          sumVex += row.vex[col.id] ?? 0;
        }
        if (Math.abs(sumVex) > maxVexAbs) {
          maxVexAbs = Math.abs(sumVex);
          vexKing = row.strike;
        }
      }

      telemetryOverrides[sUpper] = {
        ...(telemetryOverrides[sUpper] || {}),
        spotPrice: payload.spotPrice,
        previousClose: payload.previousClose,
        expectedMoveDaily: payload.expectedMoves?.daily?.em,
        netGex: payload.netMetrics.netGex,
        netVex: payload.netMetrics.netVex,
        gexKing: payload.kingNode.zeroDteKing ?? payload.kingNode.allExpKing,
        vexKing,
        kingStrength: payload.kingNode.kingStrength,
        strikeStep: payload.strikeStep,
        callWall: tactical.callWall,
        putWall: tactical.putWall,
        zeroGamma: tactical.zeroGamma,
      };
    }
  }

  return generateDailyPlaybook(undefined, telemetryOverrides);
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const force = url.searchParams.get("force") === "true";
    const ttlMs = isMarketOpen().open
      ? PLAYBOOK_TTL_RTH_MS
      : PLAYBOOK_TTL_OFF_HOURS_MS;

    const cached = globalForPlaybook.__hyperionPlaybookRouteCache;
    if (!force && cached && Date.now() - cached.tsMs < ttlMs) {
      return NextResponse.json(cached.payload, {
        headers: {
          "Cache-Control": "no-store, max-age=0",
          "X-Hyperion-Playbook-Cache": "HIT",
        },
      });
    }

    let pending = globalForPlaybook.__hyperionPlaybookInFlight;
    if (!pending) {
      const created = computeFreshPlaybook().finally(() => {
        if (globalForPlaybook.__hyperionPlaybookInFlight === created) {
          globalForPlaybook.__hyperionPlaybookInFlight = null;
        }
      });
      pending = created;
      globalForPlaybook.__hyperionPlaybookInFlight = created;
    }

    const playbook = await pending;
    globalForPlaybook.__hyperionPlaybookRouteCache = {
      tsMs: Date.now(),
      payload: playbook,
    };

    return NextResponse.json(playbook, {
      headers: {
        "Cache-Control": "no-store, max-age=0",
        "X-Hyperion-Playbook-Cache": "MISS",
      },
    });
  } catch {
    const stale = globalForPlaybook.__hyperionPlaybookRouteCache;
    if (stale) {
      return NextResponse.json(stale.payload, {
        headers: {
          "Cache-Control": "no-store, max-age=0",
          "X-Hyperion-Playbook-Cache": "STALE",
        },
      });
    }
    return NextResponse.json(
      { error: "Failed to generate dynamic 0DTE playbook" },
      { status: 500 }
    );
  }
}
