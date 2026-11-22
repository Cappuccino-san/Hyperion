import { NextRequest, NextResponse } from "next/server";
import {
  computeOptionsAnalytics,
  deriveTacticalStructuralLevels,
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
  loadTradeStore,
  reanchorDelayedContractsToSpot,
} from "@/lib/tradeSignalEngine";
import { fetchLiveTickQuote } from "@/lib/liveTick";
import { isMarketOpen } from "@/lib/marketDataService";
import {
  ensureLiveBotRunning,
  acquireBarEvaluationLock,
  releaseBarEvaluationLock,
  ensureMocCutoffForRemainingPositions,
  getEtClockNow,
} from "@/lib/liveBotDaemon";
import {
  getSessionBoundsEt,
  getTodayEt,
} from "@/lib/gaiaSessionGuards";
import {
  BoundedMap,
  optionsMemoryCache as memoryCache,
  sanitizeTickerSymbol,
  setBoundedMapEntry,
} from "@/lib/marketCache";

export const dynamic = "force-dynamic";

const contractsCache = globalContractsCache;
const CACHE_TTL_MS = 10_000;

const NO_EXT_SET = new Set(["SPX", "^SPX", "NDX", "^NDX", "SPXW", "NDXP"]);

async function fetchRealtimeSpotQuote(
  ticker: string
): Promise<{ spotPrice: number; previousClose?: number } | null> {
  const sym = ticker.toUpperCase();
  const mapped =
    sym === "SPXW" ? "SPX" : sym === "NDXP" ? "NDX" : sym;
  const tick = await fetchLiveTickQuote(mapped).catch(() => null);
  if (tick && tick.spot > 0 && Number.isFinite(tick.spot)) {
    return {
      spotPrice: Number(tick.spot.toFixed(2)),
      previousClose: tick.prevClose > 0 ? Number(tick.prevClose.toFixed(2)) : undefined,
    };
  }
  return null;
}

async function fetchExtendedQuote(
  ticker: string,
  spotPrice: number
): Promise<ExtendedQuoteInfo | null> {
  if (NO_EXT_SET.has(ticker.toUpperCase())) return null;
  try {
    const { isWeekday, etMins: mins, etDate } = getEtClockNow();
    const bounds = getSessionBoundsEt(etDate);
    // During regular market hours (9:30 AM - 4:00 PM / 1:00 PM early close ET), no extended quote badge is shown
    if (isWeekday && mins >= bounds.rthOpenMins && mins < bounds.rthCloseMins) {
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
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const result = json?.chart?.result?.[0];
    const meta = result?.meta;
    if (!meta) return null;

    const sessionType: "pre" | "after" =
      isWeekday && mins >= 240 && mins < bounds.rthOpenMins ? "pre" : "after";

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
    { headers, cache: "no-store", signal: AbortSignal.timeout(5000) }
  );
  if (!quoteRes.ok) return null;
  const quoteJson = await quoteRes.json();
  const quoteObj = quoteJson?.quotes?.quote;
  const spotPrice = Number(quoteObj?.last ?? quoteObj?.bid ?? 0);
  const previousClose = Number(quoteObj?.prevclose ?? spotPrice);
  if (!spotPrice || spotPrice <= 0) return null;

  const expRes = await fetch(
    `https://api.tradier.com/v1/markets/options/expirations?symbol=${ticker}&includeAllRoots=true`,
    { headers, cache: "no-store", signal: AbortSignal.timeout(5000) }
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
          { headers, cache: "no-store", signal: AbortSignal.timeout(5000) }
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

  setBoundedMapEntry(contractsCache, ticker, contracts, 64);
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
  const url = `https://cdn-api.cboe.com/api/global/delayed_quotes/options/${cboeSymbol}.json`;

  const backoffDelays = [1000, 2000, 4000]; // 1s, 2s, 4s exponential backoff
  const maxAttempts = 3;

  const fetchWithTimeout = async (attempt = 1): Promise<Response | null> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    let res: Response;
    try {
      res = await fetch(url, {
        signal: controller.signal,
        headers: {
      Accept: "application/json, text/plain, */*",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      Referer: "https://www.cboe.com/",
      Origin: "https://www.cboe.com",
    },
        cache: "no-store",
      });
    } catch {
      if (attempt <= maxAttempts) {
        const delay = backoffDelays[attempt - 1] ?? 4000;
        await new Promise((r) => setTimeout(r, delay));
        return fetchWithTimeout(attempt + 1);
      }
      return null;
    } finally {
      clearTimeout(timeout);
    }

    if (res.ok) return res;
    if (attempt <= maxAttempts) {
      const delay = backoffDelays[attempt - 1] ?? 4000;
      await new Promise((r) => setTimeout(r, delay));
      return fetchWithTimeout(attempt + 1);
    }
    return null;
  };

  const response = await fetchWithTimeout();
  if (!response) return null;

  const json = await response.json();
  const data = json?.data;
  if (!data || !Array.isArray(data.options)) return null;

  const marketOpenNow = isMarketOpen().open;
  // Outside RTH, CBOE options quotes are frozen at official 4:00 PM RTH close (data.close), while
  // data.current_price reflects thin after-hours equity prints. Anchor strictly to data.close when closed.
  const cboeClosePrice = Number(data.close ?? data.current_price ?? 0);
  const cboeSpotPrice = marketOpenNow
    ? Number(data.current_price ?? data.close ?? 0)
    : cboeClosePrice;
  const cboePrevClose = Number(data.prev_day_close ?? data.close ?? cboeSpotPrice);
  if (!cboeSpotPrice || cboeSpotPrice <= 0) return null;

  const rtQuote = marketOpenNow ? await fetchRealtimeSpotQuote(ticker) : null;

  const spotPrice = marketOpenNow ? (rtQuote?.spotPrice ?? cboeSpotPrice) : cboeClosePrice;
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

  const anchoredContracts = reanchorDelayedContractsToSpot({
    contracts,
    referenceSpot: cboeSpotPrice,
    liveSpot: spotPrice,
    fallbackIv: impliedVolatility,
  });

  setBoundedMapEntry(contractsCache, ticker, anchoredContracts, 64);
  const extendedQuote = await fetchExtendedQuote(ticker, spotPrice);

  const analytics = computeOptionsAnalytics({
    ticker,
    dataSource: "CBOE_MARKET_DATA",
    spotPrice,
    previousClose,
    impliedVolatility,
    contracts: anchoredContracts,
    extendedQuote,
  });

  return {
    ...analytics,
    cboeSpotPrice: Number(cboeSpotPrice.toFixed(2)),
    spotLagDollars: Number((spotPrice - cboeSpotPrice).toFixed(2)),
  };
}

async function attachIntraday(
  payload: OptionsAnalyticsPayload
): Promise<OptionsAnalyticsPayload> {
  try {
    const { history, alerts } = await recordIntradaySnapshot({
      ticker: payload.ticker,
      spotPrice: payload.spotPrice,
      callWall: payload.gammaLevels.callWall,
      putWall: payload.gammaLevels.putWall,
      zeroGamma: payload.gammaLevels.zeroGamma,
      allExpKing: payload.kingNode.allExpKing,
    });

    // Single source of truth: preserve Hyperion's computed gammaLevels (never overwrite from external scrapers)
    const gammaLevels = payload.gammaLevels;
    const gammaLevelsByFilter = payload.gammaLevelsByFilter;

    // Evaluate stateful BTO / STC long-only options signals
    let mergedAlerts = alerts;
    const hasLock = acquireBarEvaluationLock();
    if (!hasLock) {
      try {
        const cachedStore = loadTradeStore();
        const tickerAlerts = (cachedStore.alerts ?? []).filter(
          (ta: any) =>
            ta.ticker === payload.ticker ||
            (payload.ticker === "SPX" && ta.ticker === "SPXW")
        );
        if (tickerAlerts.length > 0) {
          const tradeAlertItems = tickerAlerts.map((ta: any) => ({
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
    } else {
    const evalController = new AbortController();
    const evalTimeout = setTimeout(() => evalController.abort(), 12_000);
    try {
      // Guard and evaluate all active positions across all tickers first
      await evaluateAllActivePositions({ signal: evalController.signal });

      const contracts = contractsCache.get(payload.ticker);
      const tacticalLevels = deriveTacticalStructuralLevels(payload);

      const spotLagPct =
        payload.spotPrice > 0 && typeof payload.spotLagDollars === "number"
          ? Math.abs(payload.spotLagDollars) / payload.spotPrice
          : 0;
      const isQuoteFreshForEntry = !payload.isStale && spotLagPct <= 0.015;

      const tradeRes = isQuoteFreshForEntry
        ? await evaluateTradeSignals({
        ticker: payload.ticker,
        spotPrice: payload.spotPrice,
        callWall: tacticalLevels.callWall,
        putWall: tacticalLevels.putWall,
        zeroGamma: tacticalLevels.zeroGamma,
        zeroDteCallWall: tacticalLevels.callWall,
        zeroDtePutWall: tacticalLevels.putWall,
        zeroDteZeroGamma: tacticalLevels.zeroGamma,
        dailyExpectedMove: tacticalLevels.dailyExpectedMove,
        kingNode: payload.kingNode,
        filteredKing: tacticalLevels.tacticalKing,
        allExpKing: payload.kingNode?.allExpKing ?? payload.kingByFilter?.ALL?.strike,
        bookCenter: tacticalLevels.bookCenter,
        netGex: tacticalLevels.netGexMillions,
        contracts,
        contractsAlreadyAnchored: true,
        dataSource: payload.dataSource,
        referenceSpotPrice: payload.spotPrice,
        signal: evalController.signal,
      })
        : { allAlerts: loadTradeStore().alerts ?? [] };

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
    } finally {
      const clock = getEtClockNow();
      const bounds = getSessionBoundsEt(clock.etDate);
      if (clock.etMins >= bounds.eodFlatMins) {
        await ensureMocCutoffForRemainingPositions(process.env.DISCORD_WEBHOOK_URL, clock).catch(() => {});
      }
      clearTimeout(evalTimeout);
      releaseBarEvaluationLock(hasLock);
    }
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
  const ticker = sanitizeTickerSymbol(searchParams.get("ticker"), "SPY");
  const forceRefresh = searchParams.get("force") === "true";

  if (!forceRefresh) {
    const cached = memoryCache.get(ticker);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      const cacheAgeSec = Math.max(0, Math.round((Date.now() - cached.timestamp) / 1000));
      const enriched = await attachIntraday({
        ...cached.payload,
        isStale: cached.payload.isStale ?? false,
        connectionStatus: cached.payload.connectionStatus ?? "LIVE",
        cacheAgeSec,
      });
      return NextResponse.json(enriched);
    }
  }

  // Tier 1: Tradier Real-Time API (if TRADIER_API_KEY is configured)
  const tradierKey = process.env.TRADIER_API_KEY?.trim();
  if (tradierKey) {
    try {
      const tradierPayload = await fetchTradierOptions(ticker, tradierKey);
      if (tradierPayload) {
        const taggedTradier: OptionsAnalyticsPayload = {
          ...tradierPayload,
          isStale: false,
          connectionStatus: "LIVE",
          cacheAgeSec: 0,
        };
        memoryCache.set(ticker, {
          timestamp: Date.now(),
          payload: taggedTradier,
        });
        const enriched = await attachIntraday(taggedTradier);
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
      const taggedCboe: OptionsAnalyticsPayload = {
        ...cboePayload,
        isStale: false,
        connectionStatus: "LIVE",
        cacheAgeSec: 0,
      };
      memoryCache.set(ticker, {
        timestamp: Date.now(),
        payload: taggedCboe,
      });
      const enriched = await attachIntraday(taggedCboe);
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
