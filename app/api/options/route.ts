import { NextRequest, NextResponse } from "next/server";
import {
  computeOptionsAnalytics,
  NormalizedOptionContract,
  OptionsAnalyticsPayload,
  parseOccSymbol,
} from "@/lib/optionsExposure";
import { TickerSymbol } from "@/store/useDashboardStore";

export const dynamic = "force-dynamic";

interface CacheEntry {
  timestamp: number;
  payload: OptionsAnalyticsPayload;
}

const memoryCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 10_000;

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
  const nearestDates = rawDates.slice(0, 12);
  if (nearestDates.length === 0) return null;

  const chainResponses = await Promise.all(
    nearestDates.map((exp) =>
      fetch(
        `https://api.tradier.com/v1/markets/options/chains?symbol=${ticker}&expiration=${exp}&greeks=true`,
        { headers, cache: "no-store" }
      ).then((r) => (r.ok ? r.json() : null))
    )
  );

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
      });
    }
  }

  if (contracts.length === 0) return null;

  const impliedVolatility = ivCount > 0 ? ivSum / ivCount : 0.18;

  return computeOptionsAnalytics({
    ticker,
    dataSource: "TRADIER_LIVE",
    spotPrice,
    previousClose,
    impliedVolatility,
    contracts,
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

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (compatible; HyperionAnalytics/1.0)",
    },
    cache: "no-store",
  });

  if (!response.ok) return null;

  const json = await response.json();
  const data = json?.data;
  if (!data || !Array.isArray(data.options)) return null;

  const spotPrice = Number(data.current_price ?? data.close ?? 0);
  const previousClose = Number(data.prev_day_close ?? data.close ?? spotPrice);
  if (!spotPrice || spotPrice <= 0) return null;

  const rawIv30 = Number(data.iv30 ?? 0);
  const impliedVolatility =
    rawIv30 > 0 ? (rawIv30 > 2 ? rawIv30 / 100 : rawIv30) : 0.18;

  const minStrike = spotPrice * 0.85;
  const maxStrike = spotPrice * 1.15;

  const contracts: NormalizedOptionContract[] = [];

  for (const rawOpt of data.options) {
    const occSymbol = String(rawOpt.option ?? "");
    const parsed = parseOccSymbol(occSymbol);
    if (!parsed) continue;

    if (parsed.strike < minStrike || parsed.strike > maxStrike) {
      continue;
    }

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
    });
  }

  if (contracts.length === 0) return null;

  return computeOptionsAnalytics({
    ticker,
    dataSource: "CBOE_MARKET_DATA",
    spotPrice,
    previousClose,
    impliedVolatility,
    contracts,
  });
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const rawTicker = (searchParams.get("ticker") ?? "SPY").trim().toUpperCase();
  const forceRefresh = searchParams.get("force") === "true";

  const ticker = /^[A-Z0-9._-]{1,10}$/.test(rawTicker) ? rawTicker : "SPY";

  if (!forceRefresh) {
    const cached = memoryCache.get(ticker);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return NextResponse.json(cached.payload);
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
        return NextResponse.json(tradierPayload);
      }
    } catch {
      // Fall through to Tier 2 (CBOE Market Data)
    }
  }

  // Tier 2: CBOE Live Market Data Feed (No simulation fallback)
  try {
    const cboePayload = await fetchCboeOptions(ticker);
    if (cboePayload) {
      memoryCache.set(ticker, {
        timestamp: Date.now(),
        payload: cboePayload,
      });
      return NextResponse.json(cboePayload);
    }
  } catch {
    // Live feed error
  }

  return NextResponse.json(
    { error: `Live options feed unavailable for ${ticker}` },
    { status: 502 }
  );
}
