import { NextRequest, NextResponse } from "next/server";
import {
  computeCanonicalPdeSeries,
  FlowGammaVwapSnapshot,
  StructuralFlowNodes,
} from "@/lib/flowGammaVwap";
import {
  computeOptionsAnalytics,
  deriveTacticalStructuralLevels,
  globalContractsCache,
  NormalizedOptionContract,
  parseOccSymbol,
} from "@/lib/optionsExposure";
import { isMarketOpen } from "@/lib/marketDataService";
import { fetchLiveTickQuote } from "@/lib/liveTick";
import { fetchCboeDelayedChain } from "@/lib/cboeClient";
import {
  etMinutesOfDay,
  getSessionBoundsEt,
  getTodayEt,
} from "@/lib/gaiaSessionGuards";
import {
  optionsMemoryCache,
  sanitizeTickerSymbol,
  setBoundedMapEntry,
} from "@/lib/marketCache";

export const dynamic = "force-dynamic";

const FLOW_ET_DATE_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function formatBarDateEt(tsSec: number): string {
  const parts = FLOW_ET_DATE_FMT.formatToParts(new Date(tsSec * 1000));
  let y = "";
  let m = "";
  let d = "";
  for (const p of parts) {
    if (p.type === "year") y = p.value;
    else if (p.type === "month") m = p.value;
    else if (p.type === "day") d = p.value;
  }
  return `${y}-${m}-${d}`;
}

interface RawBar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const YAHOO_BROWSER_HEADERS: Record<string, string> = {
  Accept: "application/json",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
};

/**
 * Fetches intraday session candles from Yahoo Finance (query1 -> query2 failover)
 * and appends/updates the active forming bar through the current ET minute during RTH.
 */
async function fetchIntradayCandles(
  ticker: string,
  timeframe = "5m"
): Promise<RawBar[]> {
  const yahooSymbol =
    ticker === "SPX" || ticker === "SPXW"
      ? "^GSPC"
      : ticker === "NDX" || ticker === "NDXP"
      ? "^NDX"
      : ticker;

  const interval = timeframe === "1m" ? "1m" : "5m";
  const range = timeframe === "1m" ? "1d" : "2d";
  const bucketSec = interval === "1m" ? 60 : 300;

  try {
    let json: any = null;
    for (const host of ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]) {
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(
        yahooSymbol
      )}?interval=${interval}&range=${range}&includePrePost=true`;
      try {
        const res = await fetch(url, {
          headers: YAHOO_BROWSER_HEADERS,
          cache: "no-store",
          signal: AbortSignal.timeout(5500),
        });
        if (!res.ok) {
          console.warn(`[flow-vwap API] ${host} ${yahooSymbol} ${interval} returned HTTP ${res.status}`);
          continue;
        }
        json = await res.json();
        if (json?.chart?.result?.[0]) break;
      } catch (err) {
        console.warn(
          `[flow-vwap API] ${host} ${yahooSymbol} ${interval} fetch error:`,
          err instanceof Error ? err.message : String(err)
        );
      }
    }

    const result = json?.chart?.result?.[0];
    if (!result) return [];
    const timestamps: number[] = result?.timestamp ?? [];
    const quote = result?.indicators?.quote?.[0] ?? {};
    const opens: (number | null)[] = quote.open ?? [];
    const highs: (number | null)[] = quote.high ?? [];
    const lows: (number | null)[] = quote.low ?? [];
    const closes: (number | null)[] = quote.close ?? [];
    const volumes: (number | null)[] = quote.volume ?? [];

    const bars: RawBar[] = [];
    const todayEt = getTodayEt();

    for (let i = 0; i < timestamps.length; i++) {
      const c = closes[i];
      const o = opens[i];
      const h = highs[i];
      const l = lows[i];
      const v = volumes[i] ?? 100;
      if (c == null || o == null || h == null || l == null) continue;

      const ts = timestamps[i];
      const barDateEt = formatBarDateEt(ts);

      if (barDateEt === todayEt || timestamps.length < 50) {
        bars.push({
          timestamp: ts,
          open: Number(o),
          high: Number(h),
          low: Number(l),
          close: Number(c),
          volume: Number(v),
        });
      }
    }

    if (bars.length >= 2) {
      // Synchronize & append latest forming bar through the current ET minute strictly during active RTH
      if (isMarketOpen().open) {
        try {
          const sym = ticker.trim().toUpperCase();
          const tickSym =
            sym === "SPXW" ? "SPX" : sym === "NDXP" ? "NDX" : sym;
          const liveTick = await fetchLiveTickQuote(tickSym).catch(() => null);
          if (liveTick && liveTick.spot > 0 && Number.isFinite(liveTick.spot)) {
            const liveP = Number(liveTick.spot.toFixed(2));
            const nowSec = Math.floor(Date.now() / 1000);
            const etMins = etMinutesOfDay(nowSec);
            const bounds = getSessionBoundsEt(todayEt);
            const curBucketTs = Math.floor(nowSec / bucketSec) * bucketSec;
            const lastBar = bars[bars.length - 1];
            const lastBucketTs = Math.floor(lastBar.timestamp / bucketSec) * bucketSec;
            if (
              etMins >= bounds.rthOpenMins &&
              etMins < bounds.rthCloseMins &&
              curBucketTs > lastBucketTs
            ) {
              bars.push({
                timestamp: curBucketTs,
                open: liveP,
                high: liveP,
                low: liveP,
                close: liveP,
                volume: 100,
              });
            } else {
              lastBar.close = liveP;
              lastBar.high = Math.max(lastBar.high, liveP);
              lastBar.low = Math.min(lastBar.low, liveP);
            }
          }
        } catch {
          // Non-fatal
        }
      }
      return bars;
    }
  } catch (err) {
    console.warn(
      "[flow-vwap API] Failed to fetch Yahoo series:",
      err instanceof Error ? err.message : String(err)
    );
  }

  return [];
}

/**
 * Fetches or retrieves cached CBOE option contracts via the shared singleflight cache.
 */
async function getOrFetchOptionContracts(
  ticker: string
): Promise<NormalizedOptionContract[]> {
  const upper = ticker.toUpperCase();
  const cached = globalContractsCache.get(upper);
  if (cached && cached.rawContracts.length > 0 && Date.now() - cached.fetchedAtMs < 15_000) {
    return cached.rawContracts.map((c) => ({ ...c }));
  }

  try {
    const cboeResult = await fetchCboeDelayedChain(upper, {
      allowStaleFallback: true,
    });
    const data = cboeResult.data;
    if (data && Array.isArray(data.options)) {
      const contracts: NormalizedOptionContract[] = [];
      for (const raw of data.options) {
        const occSymbol = String(raw.option ?? "");
        const parsed = parseOccSymbol(occSymbol);
        if (!parsed) continue;

        const openInterest = Number(raw.open_interest ?? 0);
        const volume = Number(raw.volume ?? 0);
        if (openInterest <= 0 && volume <= 0) continue;

        contracts.push({
          symbol: occSymbol,
          expiration: parsed.expiration,
          optionType: parsed.optionType,
          strike: parsed.strike,
          openInterest,
          volume,
          iv: Number(raw.iv ?? 0.2),
          delta: Number(raw.delta ?? 0),
          gamma: Number(raw.gamma ?? 0),
          vega: Number(raw.vega ?? 0),
          percentChange: Number(raw.percent_change ?? 0),
          bid: Number(raw.bid ?? 0),
          ask: Number(raw.ask ?? 0),
          last: Number(raw.last_trade_price ?? 0),
          quoteSource: "DELAYED_CBOE",
        });
      }

      if (contracts.length > 0) {
        const cboeRefSpot = Number(data.current_price ?? data.close ?? 0);
        setBoundedMapEntry(
          globalContractsCache,
          upper,
          {
            rawContracts: contracts,
            referenceSpot: cboeRefSpot > 0 ? cboeRefSpot : 0,
            fetchedAtMs: cboeResult.fetchedAtMs,
            quoteSource: "DELAYED_CBOE",
          },
          64
        );
        return contracts;
      }
    }
  } catch (err) {
    console.warn(
      `[flow-vwap API] CBOE options fallback for ${upper}:`,
      err instanceof Error ? err.message : String(err)
    );
    if (cached && cached.rawContracts.length > 0) {
      return cached.rawContracts.map((c) => ({ ...c }));
    }
  }

  return [];
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const ticker = sanitizeTickerSymbol(searchParams.get("ticker"), "SPY");
    const timeframe = (searchParams.get("timeframe") || "5m").trim().toLowerCase();

    const latestOnly =
      searchParams.get("latest") === "1" ||
      searchParams.get("latest")?.toLowerCase() === "true";

    const [candles, contracts] = await Promise.all([
      fetchIntradayCandles(ticker, timeframe),
      getOrFetchOptionContracts(ticker),
    ]);

    if (candles.length === 0) {
      return NextResponse.json(
        { error: `Live session bars unavailable for ${ticker}` },
        { status: 502 }
      );
    }

    let structuralNodes: StructuralFlowNodes | undefined;
    const cachedAnalytics = optionsMemoryCache.get(ticker)?.payload;
    if (cachedAnalytics) {
      const tactical = deriveTacticalStructuralLevels(cachedAnalytics);
      structuralNodes = {
        ceilingNode:
          cachedAnalytics.gammaLevelsByFilter?.["0DTE"]?.callWall || tactical.callWall,
        floorNode:
          cachedAnalytics.gammaLevelsByFilter?.["0DTE"]?.putWall || tactical.putWall,
        zeroGamma:
          cachedAnalytics.gammaLevelsByFilter?.["0DTE"]?.zeroGamma || tactical.zeroGamma,
        netGex: tactical.netGexMillions,
      };
    } else if (contracts.length > 0) {
      try {
        const latestSpot = candles[candles.length - 1].close;
        const analytics = computeOptionsAnalytics({
          ticker: ticker as any,
          dataSource: "CBOE_MARKET_DATA",
          spotPrice: latestSpot,
          previousClose: candles[0].open || latestSpot,
          impliedVolatility: 0.22,
          contracts,
        });
        const tactical = deriveTacticalStructuralLevels(analytics);
        structuralNodes = {
          ceilingNode:
            analytics.gammaLevelsByFilter?.["0DTE"]?.callWall || tactical.callWall,
          floorNode:
            analytics.gammaLevelsByFilter?.["0DTE"]?.putWall || tactical.putWall,
          zeroGamma:
            analytics.gammaLevelsByFilter?.["0DTE"]?.zeroGamma || tactical.zeroGamma,
          netGex: tactical.netGexMillions,
        };
      } catch {
        // Non-fatal fallback to book-derived anchors
      }
    }

    const flowPoints: FlowGammaVwapSnapshot[] = computeCanonicalPdeSeries({
      candles,
      contracts,
      structuralNodes,
      windowLatestSession: true,
    });

    const responsePayload = latestOnly
      ? flowPoints.length > 0
        ? (() => {
            const p = flowPoints[flowPoints.length - 1];
            return [
              {
                timestamp: p.timestamp,
                spot: Number(p.spot.toFixed(2)),
                flowVwap: Number(p.flowVwap.toFixed(2)),
                upper1s: Number(p.upper1s.toFixed(2)),
                lower1s: Number(p.lower1s.toFixed(2)),
                upper2s: Number(p.upper2s.toFixed(2)),
                lower2s: Number(p.lower2s.toFixed(2)),
                sigma: Number(p.sigma.toFixed(3)),
                pecletNumber: p.pecletNumber,
                ceilingShareChi: p.ceilingShareChi,
                netFluxJ: p.netFluxJ,
                impulseChi: p.impulseChi,
                gammaRegime: p.gammaRegime,
              },
            ];
          })()
        : []
      : flowPoints;

    return NextResponse.json(responsePayload, {
      headers: {
        "Cache-Control": "no-store, max-age=0",
      },
    });
  } catch (err: any) {
    console.error("[flow-vwap API] Unexpected error:", err);
    return NextResponse.json(
      { error: "Internal error computing Flow VWAP", message: err?.message },
      { status: 500 }
    );
  }
}
