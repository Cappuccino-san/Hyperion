import { NextRequest, NextResponse } from "next/server";
import {
  computeOptionsAnalytics,
  ExtendedQuoteInfo,
  globalContractsCache,
  NormalizedOptionContract,
  OptionsAnalyticsPayload,
  parseOccSymbol,
} from "@/lib/optionsExposure";
import { TickerSymbol } from "@/store/useDashboardStore";
import { recordIntradaySnapshot } from "@/lib/intradayHistory";
import {
  evaluateTradeSignals,
  evaluateAllActivePositions,
  getDailyTradeAlerts,
} from "@/lib/tradeSignalEngine";
import { ensureLiveBotRunning } from "@/lib/liveBotDaemon";
import { globalTelemetry } from "@/lib/telemetry";

import { optionsMemoryCache as memoryCache } from "@/lib/marketCache";

export const dynamic = "force-dynamic";

const contractsCache = globalContractsCache;
const CACHE_TTL_MS = 10_000;

const NO_EXT_SET = new Set(["SPX", "^SPX", "NDX", "^NDX", "SPXW", "NDXP"]);

const openGexCache = new Map<
  string,
  { day: string; map: Map<string, number> }
>();

async function fetchOpenGexMap(
  ticker: string
): Promise<Map<string, number> | null> {
  const sym = ticker.toUpperCase();
  const todayEt = new Date().toLocaleDateString("en-CA", {
    timeZone: "America/New_York",
  });
  const cached = openGexCache.get(sym);
  if (cached && cached.day === todayEt && cached.map.size > 0) {
    return cached.map;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);
    const res = await fetch(
      `https://terrashade.onrender.com/api/gexhist?symbol=${encodeURIComponent(
        sym
      )}&part=open`,
      {
        signal: controller.signal,
        headers: { Accept: "application/json" },
        cache: "no-store",
      }
    );
    clearTimeout(timeout);
    if (!res.ok) return null;
    const j = await res.json();
    const openObj = j?.open;
    if (
      !openObj ||
      !Array.isArray(openObj.strikes) ||
      !Array.isArray(openObj.expirations) ||
      !Array.isArray(openObj.gex)
    ) {
      return null;
    }

    const map = new Map<string, number>();
    openObj.strikes.forEach((s: number, si: number) => {
      const row = openObj.gex[si];
      if (!Array.isArray(row)) return;
      openObj.expirations.forEach((exp: string, ei: number) => {
        const valDollars = Number(row[ei] ?? 0);
        if (Number.isFinite(valDollars) && Math.abs(valDollars) >= 1) {
          map.set(`${Number(s.toFixed(2))}|${exp}`, valDollars / 1e6);
        }
      });
    });

    if (map.size > 0) {
      openGexCache.set(sym, { day: todayEt, map });
      return map;
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchRealtimeSpotQuote(
  ticker: string
): Promise<{ spotPrice: number; previousClose?: number } | null> {
  const sym = ticker.toUpperCase();

  // 1. Primary: Sub-second live exchange quote via Robinhood public feed
  const rhSym =
    sym === "SPXW" || sym === "SPX"
      ? "SPY"
      : sym === "NDXP" || sym === "NDX"
        ? "QQQ"
        : sym;

  try {
    const rhRes = await fetch(
      `https://api.robinhood.com/quotes/?symbols=${encodeURIComponent(rhSym)}`,
      {
        headers: {
          Accept: "application/json",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) HyperionTerminal/1.0",
        },
        cache: "no-store",
      }
    );
    if (rhRes.ok) {
      const rhJson = await rhRes.json();
      const q = rhJson?.results?.[0];
      const p = Number(q?.last_trade_price ?? q?.bid_price ?? 0);
      const prevClose = Number(q?.previous_close ?? 0);
      if (p > 0 && Number.isFinite(p)) {
        const mult = sym === "SPXW" || sym === "SPX" ? 10 : sym === "NDXP" || sym === "NDX" ? 40 : 1;
        return {
          spotPrice: Number((p * mult).toFixed(2)),
          previousClose: prevClose > 0 ? Number((prevClose * mult).toFixed(2)) : undefined,
        };
      }
    }
  } catch {
    // Non-fatal fallback to Yahoo
  }

  // 2. Secondary: Yahoo Finance fallback
  const yahooSym =
    sym === "SPXW" || sym === "SPX"
      ? "^GSPC"
      : sym === "NDXP" || sym === "NDX"
        ? "^NDX"
        : sym;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2200);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      yahooSym
    )}?range=1d&interval=1m`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (compatible; HyperionAnalytics/1.0)",
      },
      cache: "no-store",
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const json = await res.json();
    const meta = json?.chart?.result?.[0]?.meta;
    const regularPrice = Number(meta?.regularMarketPrice ?? 0);
    const prevClose = Number(
      meta?.chartPreviousClose ?? meta?.previousClose ?? 0
    );
    if (regularPrice > 0 && Number.isFinite(regularPrice)) {
      return {
        spotPrice: Number(regularPrice.toFixed(2)),
        previousClose: prevClose > 0 ? Number(prevClose.toFixed(2)) : undefined,
      };
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchExtendedQuote(
  ticker: string,
  spotPrice: number
): Promise<ExtendedQuoteInfo | null> {
  if (NO_EXT_SET.has(ticker.toUpperCase())) return null;
  try {
    const nowEt = new Date(
      new Date().toLocaleString("en-US", { timeZone: "America/New_York" })
    );
    const mins = nowEt.getHours() * 60 + nowEt.getMinutes();
    const wd = nowEt.getDay();
    // During regular market hours (Mon-Fri 9:30 AM - 4:00 PM ET), no extended quote badge is shown
    if (wd >= 1 && wd <= 5 && mins >= 570 && mins < 960) {
      return null;
    }

    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      ticker
    )}?range=2d&interval=1m&includePrePost=true`;
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (compatible; HyperionAnalytics/1.0)",
      },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const json = await res.json();
    const result = json?.chart?.result?.[0];
    const meta = result?.meta;
    if (!meta) return null;

    const sessionType: "pre" | "after" =
      wd >= 1 && wd <= 5 && mins >= 240 && mins < 570 ? "pre" : "after";

    let extPrice = Number(
      sessionType === "pre"
        ? meta.preMarketPrice ?? 0
        : meta.postMarketPrice ?? 0
    );

    if (!extPrice || extPrice <= 0) {
      const closes: (number | null)[] =
        result?.indicators?.quote?.[0]?.close ?? [];
      for (let i = closes.length - 1; i >= 0; i--) {
        const c = closes[i];
        if (typeof c === "number" && Number.isFinite(c) && c > 0) {
          extPrice = c;
          break;
        }
      }
    }

    if (!extPrice || extPrice <= 0 || Math.abs(extPrice - spotPrice) < 0.005) {
      return null;
    }

    const change = Number((extPrice - spotPrice).toFixed(2));
    const changePct = Number(((change / spotPrice) * 100).toFixed(2));
    return {
      type: sessionType,
      price: Number(extPrice.toFixed(2)),
      change,
      changePct,
    };
  } catch {
    return null;
  }
}

async function fetchTradierOptions(
  ticker: TickerSymbol,
  apiKey: string
): Promise<OptionsAnalyticsPayload | null> {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
  };

  const quoteRes = await fetch(
    `https://api.tradier.com/v1/markets/quotes?symbols=${ticker}`,
    { headers, cache: "no-store" }
  );
  if (!quoteRes.ok) return null;
  const quoteJson = await quoteRes.json();
  const quoteObj = quoteJson?.quotes?.quote;
  const spotPrice = Number(quoteObj?.last ?? quoteObj?.bid ?? 0);
  const previousClose = Number(quoteObj?.prevclose ?? spotPrice);
  if (!spotPrice || spotPrice <= 0) return null;

  const expRes = await fetch(
    `https://api.tradier.com/v1/markets/options/expirations?symbol=${ticker}&includeAllRoots=true`,
    { headers, cache: "no-store" }
  );
  if (!expRes.ok) return null;
  const expJson = await expRes.json();
  const rawDates: string[] = expJson?.expirations?.date ?? [];
  if (rawDates.length === 0) return null;

  const [chainResponses, extendedQuote] = await Promise.all([
    Promise.all(
      rawDates.map((exp) =>
        fetch(
          `https://api.tradier.com/v1/markets/options/chains?symbol=${ticker}&expiration=${exp}&greeks=true`,
          { headers, cache: "no-store" }
        ).then((r) => (r.ok ? r.json() : null))
      )
    ),
    fetchExtendedQuote(ticker, spotPrice),
  ]);

  const contracts: NormalizedOptionContract[] = [];
  let ivSum = 0;
  let ivCount = 0;

  for (const chainJson of chainResponses) {
    const list = chainJson?.options?.option;
    if (!Array.isArray(list)) continue;

    for (const item of list) {
      const strike = Number(item.strike);
      const optionType = item.option_type === "call" ? "C" : "P";
      const expiration = String(item.expiration_date ?? "");
      if (!strike || !expiration) continue;

      const iv = Number(item.greeks?.mid_iv ?? item.greeks?.smv_vol ?? 0);
      if (iv > 0.03 && iv < 3 && Math.abs(strike - spotPrice) / spotPrice < 0.03) {
        ivSum += iv;
        ivCount += 1;
      }

      contracts.push({
        symbol: String(item.symbol ?? ""),
        expiration,
        optionType,
        strike,
        openInterest: Number(item.open_interest ?? 0),
        volume: Number(item.volume ?? 0),
        iv: iv > 0 ? iv : 0.18,
        delta: Number(item.greeks?.delta ?? 0),
        gamma: Number(item.greeks?.gamma ?? 0),
        vega: Number(item.greeks?.vega ?? 0),
        percentChange: Number(item.change_percentage ?? 0),
        bid: Number(item.bid ?? 0),
        ask: Number(item.ask ?? 0),
        last: Number(item.last ?? 0),
      });
    }
  }

  if (contracts.length === 0) return null;

  contractsCache.set(ticker, contracts);
  const impliedVolatility = ivCount > 0 ? ivSum / ivCount : 0.18;

  return computeOptionsAnalytics({
    ticker,
    dataSource: "TRADIER_LIVE",
    spotPrice,
    previousClose,
    impliedVolatility,
    contracts,
    extendedQuote,
  });
}

async function fetchCboeOptions(
  ticker: TickerSymbol
): Promise<OptionsAnalyticsPayload | null> {
  const cboeSymbol =
    ticker === "SPX" || ticker === "SPXW"
      ? "_SPX"
      : ticker === "NDX" || ticker === "NDXP"
        ? "_NDX"
        : ticker;
  const url = `https://cdn.cboe.com/api/global/delayed_quotes/options/${cboeSymbol}.json`;

  const backoffDelays = [1000, 2000, 4000]; // 1s, 2s, 4s exponential backoff
  const maxAttempts = 3;

  globalTelemetry.recordAttempt(ticker);
  const startFetchTime = performance.now();

  const fetchWithTimeout = async (attempt = 1): Promise<Response | null> => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        },
        cache: "no-store",
      });
      clearTimeout(timeout);
      if (res.ok) return res;
      if (attempt <= maxAttempts) {
        const delay = backoffDelays[attempt - 1] ?? 4000;
        await new Promise((r) => setTimeout(r, delay));
        return fetchWithTimeout(attempt + 1);
      }
      return null;
    } catch {
      if (attempt <= maxAttempts) {
        const delay = backoffDelays[attempt - 1] ?? 4000;
        await new Promise((r) => setTimeout(r, delay));
        return fetchWithTimeout(attempt + 1);
      }
      return null;
    }
  };

  const response = await fetchWithTimeout();
  if (!response) {
    const latencyMs = Math.round(performance.now() - startFetchTime);
    globalTelemetry.recordFailure(ticker, "CBOE upstream unreachable or timeout", latencyMs);
    return null;
  }

  const latencyMs = Math.round(performance.now() - startFetchTime);
  globalTelemetry.recordSuccess(ticker, latencyMs);

  const json = await response.json();
  const data = json?.data;
  if (!data || !Array.isArray(data.options)) return null;

  const cboeSpotPrice = Number(data.current_price ?? data.close ?? 0);
  const cboePrevClose = Number(data.prev_day_close ?? data.close ?? cboeSpotPrice);
  if (!cboeSpotPrice || cboeSpotPrice <= 0) return null;

  const [rtQuote, openGexMap] = await Promise.all([
    fetchRealtimeSpotQuote(ticker),
    fetchOpenGexMap(ticker),
  ]);

  const spotPrice = rtQuote?.spotPrice ?? cboeSpotPrice;
  const previousClose = rtQuote?.previousClose ?? cboePrevClose;

  const rawIv30 = Number(data.iv30 ?? 0);
  const impliedVolatility =
    rawIv30 > 0 ? (rawIv30 > 2 ? rawIv30 / 100 : rawIv30) : 0.18;

  const contracts: NormalizedOptionContract[] = [];

  for (const rawOpt of data.options) {
    const occSymbol = String(rawOpt.option ?? "");
    const parsed = parseOccSymbol(occSymbol);
    if (!parsed) continue;

    const openInterest = Number(rawOpt.open_interest ?? 0);
    const volume = Number(rawOpt.volume ?? 0);
    if (openInterest <= 0 && volume <= 0) continue;

    contracts.push({
      symbol: occSymbol,
      expiration: parsed.expiration,
      optionType: parsed.optionType,
      strike: parsed.strike,
      openInterest,
      volume,
      iv: Number(rawOpt.iv ?? 0),
      delta: Number(rawOpt.delta ?? 0),
      gamma: Number(rawOpt.gamma ?? 0),
      vega: Number(rawOpt.vega ?? 0),
      percentChange: Number(rawOpt.percent_change ?? 0),
      bid: Number(rawOpt.bid ?? 0),
      ask: Number(rawOpt.ask ?? 0),
      last: Number(rawOpt.last_trade_price ?? 0),
    });
  }

  if (contracts.length === 0) return null;

  contractsCache.set(ticker, contracts);
  const extendedQuote = await fetchExtendedQuote(ticker, spotPrice);

  return computeOptionsAnalytics({
    ticker,
    dataSource: "CBOE_MARKET_DATA",
    spotPrice,
    previousClose,
    impliedVolatility,
    contracts,
    extendedQuote,
    openGexMap,
  });
}

async function attachIntraday(
  payload: OptionsAnalyticsPayload
): Promise<OptionsAnalyticsPayload> {
  try {
    const { history, alerts, officialLevels } = await recordIntradaySnapshot({
      ticker: payload.ticker,
      spotPrice: payload.spotPrice,
      callWall: payload.gammaLevels.callWall,
      putWall: payload.gammaLevels.putWall,
      zeroGamma: payload.gammaLevels.zeroGamma,
      allExpKing: payload.kingNode.allExpKing,
    });

    let gammaLevels = payload.gammaLevels;
    let gammaLevelsByFilter = payload.gammaLevelsByFilter;
    if (
      officialLevels &&
      officialLevels.callWall > 0
    ) {
      gammaLevels = {
        ...payload.gammaLevels,
        ...officialLevels,
      };
      if (gammaLevelsByFilter) {
        gammaLevelsByFilter = {
          ...gammaLevelsByFilter,
          ALL: gammaLevels,
        };
      }
    }

    // Evaluate stateful BTO / STC long-only options signals
    let mergedAlerts = alerts;
    try {
      // Guard and evaluate all active positions across all tickers first
      await evaluateAllActivePositions();

      const contracts = contractsCache.get(payload.ticker);

      const tacticalKing =
        payload.kingNode?.zeroDteKing ??
        payload.kingByFilter?.["0DTE"]?.strike ??
        payload.kingNode?.weeklyKing ??
        payload.kingByFilter?.ALL?.strike;

      // Tactical 0DTE / Next-Exp walls are the true intraday resistance and support
      const zeroDteLevels = gammaLevelsByFilter?.["0DTE"] ?? gammaLevelsByFilter?.["THIS_WEEK"];
      const baseTacticalCallWall =
        zeroDteLevels?.callWall && zeroDteLevels.callWall > 0
          ? zeroDteLevels.callWall
          : (gammaLevels.callWall > 0 && Math.abs(gammaLevels.callWall - payload.spotPrice) / payload.spotPrice < 0.025)
            ? gammaLevels.callWall
            : Math.round(payload.spotPrice * 1.008);
      const tacticalCallWall =
        tacticalKing &&
        tacticalKing > baseTacticalCallWall &&
        (tacticalKing - payload.spotPrice) / payload.spotPrice <= 0.015
          ? tacticalKing
          : baseTacticalCallWall;

      const rawTacticalPutWall =
        zeroDteLevels?.putWall && zeroDteLevels.putWall > 0
          ? zeroDteLevels.putWall
          : (gammaLevels.putWall > 0 && Math.abs(payload.spotPrice - gammaLevels.putWall) / payload.spotPrice < 0.025)
            ? gammaLevels.putWall
            : Math.round(payload.spotPrice * 0.992);

      // If rawTacticalPutWall is a distant multi-day tail strike (> 0.95% below spot, e.g. $755 when SPY is $766),
      // find the strongest local negative-gamma support strike within 0.95% below spot (e.g. $762) or Daily EM low
      let tacticalPutWall = rawTacticalPutWall;
      if (
        rawTacticalPutWall > 0 &&
        (payload.spotPrice - rawTacticalPutWall) / payload.spotPrice > 0.0095 &&
        Array.isArray(payload.strikes) &&
        payload.expirations.length > 0
      ) {
        const nearExpId = payload.expirations[0].id;
        let bestNearPutStrike = 0;
        let minNearPutGex = 0;
        for (const row of payload.strikes) {
          if (
            row.strike < payload.spotPrice - 0.5 &&
            (payload.spotPrice - row.strike) / payload.spotPrice <= 0.0095
          ) {
            const g = row.gex[nearExpId] ?? 0;
            if (g < minNearPutGex) {
              minNearPutGex = g;
              bestNearPutStrike = row.strike;
            }
          }
        }
        if (bestNearPutStrike > 0) {
          tacticalPutWall = bestNearPutStrike;
        } else if (payload.expectedMoves?.daily?.low && payload.expectedMoves.daily.low > rawTacticalPutWall) {
          tacticalPutWall = Math.round(payload.expectedMoves.daily.low);
        }
      }

      const tacticalZeroGamma =
        zeroDteLevels?.zeroGamma && zeroDteLevels.zeroGamma > 0
          ? zeroDteLevels.zeroGamma
          : gammaLevels.zeroGamma;

      const tradeRes = await evaluateTradeSignals({
        ticker: payload.ticker,
        spotPrice: payload.spotPrice,
        callWall: tacticalCallWall,
        putWall: tacticalPutWall,
        zeroGamma: tacticalZeroGamma,
        zeroDteCallWall: tacticalCallWall,
        zeroDtePutWall: tacticalPutWall,
        zeroDteZeroGamma: tacticalZeroGamma,
        dailyExpectedMove: payload.expectedMoves?.daily
          ? {
              low: payload.expectedMoves.daily.low,
              high: payload.expectedMoves.daily.high,
            }
          : null,
        kingNode: payload.kingNode,
        filteredKing: tacticalKing,
        bookCenter: tacticalZeroGamma,
        contracts,
      });

      const tickerAlerts = tradeRes.allAlerts.filter(
        (ta) =>
          ta.ticker === payload.ticker ||
          (payload.ticker === "SPX" && ta.ticker === "SPXW")
      );

      if (tickerAlerts.length > 0) {
        const tradeAlertItems = tickerAlerts.map((ta) => ({
          id: ta.id,
          ts: ta.ts,
          symbol: ta.ticker,
          timestamp: ta.timestamp,
          time: ta.timestamp,
          message: ta.message,
          msg: ta.message,
          type: (ta.action === "BUY_TO_OPEN"
            ? ta.contractType === "CALL"
              ? "call"
              : "put"
            : "zero") as "call" | "put" | "zero" | "king",
        }));
        mergedAlerts = [...alerts, ...tradeAlertItems];
      }
    } catch {
      // Non-fatal
    }

    return {
      ...payload,
      gammaLevels,
      gammaLevelsByFilter,
      intradayData: history,
      alerts: mergedAlerts,
    };
  } catch {
    return payload;
  }
}

export async function GET(request: NextRequest) {
  ensureLiveBotRunning();
  const { searchParams } = new URL(request.url);
  const rawTicker = (searchParams.get("ticker") ?? "SPY").trim().toUpperCase();
  const forceRefresh = searchParams.get("force") === "true";

  const ticker = /^[A-Z0-9._-]{1,10}$/.test(rawTicker) ? rawTicker : "SPY";

  if (!forceRefresh) {
    const cached = memoryCache.get(ticker);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      const enriched = await attachIntraday(cached.payload);
      return NextResponse.json(enriched);
    }
  }

  // Tier 1: Tradier Real-Time API (if TRADIER_API_KEY is configured)
  const tradierKey = process.env.TRADIER_API_KEY?.trim();
  if (tradierKey) {
    try {
      const tradierPayload = await fetchTradierOptions(ticker, tradierKey);
      if (tradierPayload) {
        memoryCache.set(ticker, {
          timestamp: Date.now(),
          payload: tradierPayload,
        });
        const enriched = await attachIntraday(tradierPayload);
        return NextResponse.json(enriched);
      }
    } catch {
      // Fall through to Tier 2 (CBOE Market Data)
    }
  }

  // Tier 2: CBOE Live Market Data Feed
  try {
    const cboePayload = await fetchCboeOptions(ticker);
    if (cboePayload) {
      memoryCache.set(ticker, {
        timestamp: Date.now(),
        payload: cboePayload,
      });
      const enriched = await attachIntraday({
        ...cboePayload,
        isStale: false,
        connectionStatus: "LIVE",
      });
      return NextResponse.json(enriched);
    }
  } catch {
    // Live feed error - fall through to Tier 2b/3
  }

  // Tier 2b: Serve last verified valid snapshot from memory cache if available (non-blocking reconnecting/syncing state)
  const staleEntry = memoryCache.get(ticker);
  if (staleEntry) {
    const enriched = await attachIntraday({
      ...staleEntry.payload,
      isStale: true,
      connectionStatus: "SYNCING",
    });
    return NextResponse.json(enriched, {
      headers: {
        "X-Hyperion-Data-Status": "STALE_SYNCING",
        "Cache-Control": "no-store, max-age=0",
      },
    });
  }

  // Certified Live-Only: No synthetic or simulated fallbacks.
  // Return honest 502 with reconnecting state when upstream feeds are unreachable.
  return NextResponse.json(
    {
      error: `Live options feed currently unavailable for ${ticker}. Syncing live market data...`,
      ticker,
      connectionStatus: "SYNCING",
      isLiveOnly: true,
    },
    {
      status: 502,
      headers: {
        "Cache-Control": "no-store, max-age=0",
      },
    }
  );
}
