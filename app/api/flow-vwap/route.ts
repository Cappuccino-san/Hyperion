import { NextRequest, NextResponse } from "next/server";
import {
  computeBarFlowGammaVwapSeries,
  FlowGammaVwapSnapshot,
} from "@/lib/flowGammaVwap";
import {
  globalContractsCache,
  NormalizedOptionContract,
  parseOccSymbol,
} from "@/lib/optionsExposure";
import { sanitizeTickerSymbol, setBoundedMapEntry } from "@/lib/marketCache";

export const dynamic = "force-dynamic";

interface RawBar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Fetches intraday session candles from Yahoo Finance.
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

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      yahooSymbol
    )}?interval=${interval}&range=${range}&includePrePost=true`;

    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (compatible; HyperionAnalytics/1.0)",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      return [];
    }

    const json = await res.json();
    const result = json?.chart?.result?.[0];
    const timestamps: number[] = result?.timestamp ?? [];
    const quote = result?.indicators?.quote?.[0] ?? {};
    const opens: (number | null)[] = quote.open ?? [];
    const highs: (number | null)[] = quote.high ?? [];
    const lows: (number | null)[] = quote.low ?? [];
    const closes: (number | null)[] = quote.close ?? [];
    const volumes: (number | null)[] = quote.volume ?? [];

    const bars: RawBar[] = [];

    // Filter to current session (starting from 9:30 AM ET today or full today)
    const todayEt = new Date().toLocaleDateString("en-CA", {
      timeZone: "America/New_York",
    });

    for (let i = 0; i < timestamps.length; i++) {
      const c = closes[i];
      const o = opens[i];
      const h = highs[i];
      const l = lows[i];
      const v = volumes[i] ?? 100;
      if (c == null || o == null || h == null || l == null) continue;

      const ts = timestamps[i];
      const barDateEt = new Date(ts * 1000).toLocaleDateString("en-CA", {
        timeZone: "America/New_York",
      });

      // Include points from today's session
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
      // Synchronize latest bar close with sub-second Robinhood live tick
      try {
        const sym = ticker.trim().toUpperCase();
        const rhSym = sym === "SPX" || sym === "SPXW" ? "SPY" : sym === "NDX" || sym === "NDXP" ? "QQQ" : sym;
        const rhRes = await fetch(`https://api.robinhood.com/quotes/?symbols=${encodeURIComponent(rhSym)}`, {
          headers: { "User-Agent": "Mozilla/5.0" },
          cache: "no-store",
          signal: AbortSignal.timeout(2500),
        });
        if (rhRes.ok) {
          const rhJson = await rhRes.json();
          const p = Number(rhJson?.results?.[0]?.last_trade_price ?? rhJson?.results?.[0]?.bid_price ?? 0);
          if (p > 0 && Number.isFinite(p)) {
            const mult = sym === "SPX" || sym === "SPXW" ? 10 : sym === "NDX" || sym === "NDXP" ? 40 : 1;
            const liveP = Number((p * mult).toFixed(2));
            const lastBar = bars[bars.length - 1];
            lastBar.close = liveP;
            lastBar.high = Math.max(lastBar.high, liveP);
            lastBar.low = Math.min(lastBar.low, liveP);
          }
        }
      } catch {
        // Non-fatal
      }
      return bars;
    }
  } catch (err) {
    console.error("[flow-vwap API] Failed to fetch Yahoo series:", err);
  }

  return [];
}

/**
 * Fetches or retrieves cached CBOE option contracts.
 */
async function getOrFetchOptionContracts(
  ticker: string
): Promise<NormalizedOptionContract[]> {
  const cached = globalContractsCache.get(ticker.toUpperCase());
  if (cached && cached.length > 0) {
    return cached;
  }

  const cboeSymbol =
    ticker === "SPX" || ticker === "SPXW"
      ? "_SPX"
      : ticker === "NDX" || ticker === "NDXP"
      ? "_NDX"
      : ticker.toUpperCase();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const url = `https://cdn.cboe.com/api/global/delayed_quotes/options/${cboeSymbol}.json`;

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      },
      cache: "no-store",
    });

    if (res.ok) {
      const json = await res.json();
      const data = json?.data;
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
          });
        }

        if (contracts.length > 0) {
          setBoundedMapEntry(globalContractsCache, ticker.toUpperCase(), contracts, 64);
          return contracts;
        }
      }
    }
  } catch {
    // Non-fatal, fallback to empty/simulated
  } finally {
    clearTimeout(timeout);
  }

  return [];
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const ticker = sanitizeTickerSymbol(searchParams.get("ticker"), "SPY");
    const timeframe = (searchParams.get("timeframe") || "5m").trim().toLowerCase();

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

    const flowPoints: FlowGammaVwapSnapshot[] = computeBarFlowGammaVwapSeries(
      candles,
      contracts
    );

    // Return the session's 5m/1m aggregated flow-gamma points Array<{ timestamp, spot, flowVwap, upper1Sigma, lower1Sigma, upper2Sigma, lower2Sigma, cumGammaWeight }>
    return NextResponse.json(flowPoints, {
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
