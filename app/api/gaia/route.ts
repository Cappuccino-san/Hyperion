import { NextRequest, NextResponse } from "next/server";
import {
  computeBlackScholesGreeks,
  computeExpirationExpectedMove,
  computeIntradayExpiryYears,
  getActiveExpirationSelection,
  NormalizedOptionContract,
  parseOccSymbol,
  resolveEffectiveOpenInterest,
} from "@/lib/optionsExposure";
import { fetchLiveTickQuote, LiveTickResponse } from "@/lib/liveTick";
import { fetchCboeDelayedChain } from "@/lib/cboeClient";
import { isMarketOpen } from "@/lib/marketDataService";
import { getSessionBoundsEt, getTodayEt } from "@/lib/gaiaSessionGuards";
import { reanchorDelayedContractsToSpot } from "@/lib/execution/optionPricing";
import {
  detectGlobalPivotSignals,
  enrichBarsWithRsiAndMacd,
  evaluateTfStatusAtTimestamp,
} from "@/lib/divergenceDetector";
import { getMergedIntradayHistory, getEtMinutesFromTs } from "@/lib/intradayHistory";
import { BoundedMap, sanitizeTickerSymbol } from "@/lib/marketCache";

export const dynamic = "force-dynamic";

type GaiaCoalescedResult =
  | { ok: true; payload: GaiaLivePayload }
  | { ok: false; error: string; status: number };

const gaiaInFlight = new Map<string, Promise<GaiaCoalescedResult>>();
const gaiaShortCache = new BoundedMap<string, { tsMs: number; payload: GaiaLivePayload }>(32);
const GAIA_SHORT_CACHE_MS = 3_000;

export type DivergenceStatus = "BULL" | "BEAR" | "NO";

export interface GaiaSessionOption {
  isoDate: string;
  bookLabel: string;
}

export interface GaiaIntradayCandle {
  index: number;
  timestamp: number;
  timeLabel: string;
  open: number;
  high: number;
  low: number;
  close: number;
  sma34: number;
  sma5d: number;
  ema21d: number;
  sma55d: number;
  rsi14: number;
  macdHist: number;
}

export interface GaiaPivotSignal {
  type: "BULL" | "BEAR";
  p1Index: number; // may be < 0 if P1 occurred in the prior session
  p1Price: number;
  p2Index: number; // 0 .. candles.length - 1
  p2Price: number;
  confirmedAtIndex: number;
}

export interface GaiaMtfRow {
  tf5m: DivergenceStatus;
  tf30m: DivergenceStatus;
  tf2h: DivergenceStatus;
  tfDaily: DivergenceStatus;
  tfWeekly: DivergenceStatus;
}

export interface GaiaStrikeExpBucket {
  strike: number;
  expiration: string; // YYYY-MM-DD
  dateLabel: string; // MM-DD
  dteDays: number;
  callOI: number;
  putOI: number;
  callIv: number;
  putIv: number;
  callGamma: number;
  putGamma: number;
  callDelta: number;
  putDelta: number;
}

export interface GaiaExpirationInfo {
  isoDate: string;
  dateLabel: string;
  dteDays: number;
  isNextExp: boolean;
  isThisWeek: boolean;
}

export interface GaiaLivePayload {
  ticker: string;
  dataSource: "TRADIER_LIVE" | "CBOE_MARKET_DATA";
  sessionDate: string;
  bookLabel: string;
  sessions: GaiaSessionOption[];
  expirations: GaiaExpirationInfo[];
  has0DteActive: boolean;
  priorClose: number;
  spotPrice: number;
  impliedVolatility: number;
  sigma1Move: number;
  sigma2Move: number;
  strikeStep: number;
  candles: GaiaIntradayCandle[];
  pivotSignals5m: GaiaPivotSignal[];
  mtfByBar: GaiaMtfRow[];
  optionBuckets: GaiaStrikeExpBucket[];
  isStale?: boolean;
  marketOpen?: boolean;
  lastUpdated?: string;
}

interface RawYahooBar {
  ts: number;
  etDate: string;
  etTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface EnrichedBar extends RawYahooBar {
  rsi14: number;
  macdHist: number;
}

interface DetectedGlobalSignal {
  type: "BULL" | "BEAR";
  p1GlobalIdx: number;
  p1Price: number;
  p2GlobalIdx: number;
  p2Price: number;
  confirmedGlobalIdx: number;
  p2Timestamp: number;
  confirmedTimestamp: number;
}

const DIVERGENCE_SUPPORTED_TICKERS = new Set([
  "SPY",
  "QQQ",
  "SPX",
  "SPXW",
  "IWM",
]);

function mapYahooSymbol(ticker: string): string {
  if (ticker === "SPX" || ticker === "SPXW") return "^GSPC";
  if (ticker === "NDX" || ticker === "NDXP") return "^NDX";
  if (ticker === "VIX") return "^VIX";
  return ticker;
}

function mapCboeSymbol(ticker: string): string {
  if (ticker === "SPX" || ticker === "SPXW") return "_SPX";
  if (ticker === "NDX" || ticker === "NDXP") return "_NDX";
  if (ticker === "VIX") return "_VIX";
  return ticker;
}

const GAIA_ET_DATE_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const GAIA_ET_TIME_12_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

const GAIA_ET_HM_24_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  hourCycle: "h23",
});

function formatEtDate(tsSeconds: number): string {
  const parts = GAIA_ET_DATE_FMT.formatToParts(new Date(tsSeconds * 1000));
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

function formatEtTime(tsSeconds: number): string {
  return GAIA_ET_TIME_12_FMT.format(new Date(tsSeconds * 1000));
}

function getEtHourMinute24(tsSeconds: number): { hNum: number; mNum: number } {
  const parts = GAIA_ET_HM_24_FMT.formatToParts(new Date(tsSeconds * 1000));
  let h = 0;
  let m = 0;
  for (const p of parts) {
    if (p.type === "hour") h = Number(p.value) % 24;
    else if (p.type === "minute") m = Number(p.value);
  }
  return { hNum: h, mNum: m };
}

function formatBookLabel(isoDate: string): string {
  const d = new Date(`${isoDate}T16:00:00Z`);
  const monthDay = d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  return `book ${monthDay}, 4:00 PM ET`;
}

const YAHOO_GAIA_HEADERS: Record<string, string> = {
  Accept: "application/json",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
};

const mtfSeriesCache = new BoundedMap<string, { tsMs: number; bars: RawYahooBar[] }>(128);

async function fetchYahooSeries(
  yahooSymbol: string,
  interval: string,
  range: string,
  includePrePost: boolean = false,
  startHour: number = 0,
  signal?: AbortSignal
): Promise<RawYahooBar[]> {
  let json: any = null;
  let lastStatus = 0;
  let lastErrMsg = "";

  for (const host of ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]) {
    if (signal?.aborted) break;
    const url = `https://${host}/v8/finance/chart/${encodeURIComponent(
      yahooSymbol
    )}?interval=${interval}&range=${range}&includePrePost=${includePrePost}`;

    try {
      const res = await fetch(url, {
        headers: YAHOO_GAIA_HEADERS,
        cache: "no-store",
        signal,
      });

      if (!res.ok) {
        lastStatus = res.status;
        console.warn(`[/api/gaia] Yahoo ${host} ${yahooSymbol} ${interval} HTTP ${res.status}`);
        continue;
      }

      json = await res.json();
      if (json?.chart?.result?.[0]) {
        break;
      }
    } catch (err) {
      lastErrMsg = err instanceof Error ? err.message : String(err);
      if (signal?.aborted) throw err;
      console.warn(`[/api/gaia] Yahoo ${host} ${yahooSymbol} ${interval} fetch error: ${lastErrMsg}`);
    }
  }

  if (!json?.chart?.result?.[0]) {
    throw new Error(
      lastStatus > 0
        ? `Yahoo Finance ${interval} HTTP ${lastStatus}`
        : `Yahoo Finance ${interval} unavailable (${lastErrMsg || "empty response"})`
    );
  }

  const result = json?.chart?.result?.[0];
  const timestamps: number[] = result?.timestamp ?? [];
  const quote = result?.indicators?.quote?.[0] ?? {};
  const opens: (number | null)[] = quote.open ?? [];
  const highs: (number | null)[] = quote.high ?? [];
  const lows: (number | null)[] = quote.low ?? [];
  const closes: (number | null)[] = quote.close ?? [];

  const bars: RawYahooBar[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    let c = closes[i];
    let o = opens[i];
    let h = highs[i];
    let l = lows[i];
    // Preserve active forming 5m bar if Yahoo quotes regularMarketPrice while trailing slot is still null
    if (
      interval === "5m" &&
      i === timestamps.length - 1 &&
      (c === null || c === undefined) &&
      typeof result?.meta?.regularMarketPrice === "number" &&
      result.meta.regularMarketPrice > 0
    ) {
      const rmp = Number(result.meta.regularMarketPrice);
      c = rmp;
      o = o ?? rmp;
      h = h != null ? Math.max(h, rmp) : rmp;
      l = l != null ? Math.min(l, rmp) : rmp;
    }
    if (
      c === null ||
      c === undefined ||
      o === null ||
      o === undefined ||
      h === null ||
      h === undefined ||
      l === null ||
      l === undefined
    ) {
      continue;
    }
    const ts = timestamps[i];
    if (interval === "5m") {
      const { hNum, mNum } = getEtHourMinute24(ts);
      if (startHour === 0) {
        // 24-hour ET window (00:00 – 23:59 ET): keep all extended-hours + RTH 5m bars
      } else if (startHour === 9) {
        if (hNum < 9 || (hNum === 9 && mNum < 30) || hNum > 16 || (hNum === 16 && mNum > 0)) {
          continue;
        }
        if (hNum === 16 && mNum === 0) {
          // Skip 4:00 PM settlement cross bar to preserve true 3:55 PM regular session close
          continue;
        }
      } else {
        if (hNum < startHour || hNum > 16 || (hNum === 16 && mNum > 0)) {
          continue;
        }
        if (hNum === 16 && mNum === 0) {
          // Skip 4:00 PM settlement cross bar to preserve true 3:55 PM regular session close
          continue;
        }
      }
    }
    bars.push({
      ts,
      etDate: formatEtDate(ts),
      etTime: formatEtTime(ts),
      open: Number(o),
      high: Number(h),
      low: Number(l),
      close: Number(c),
    });
  }

  return bars;
}

async function fetchCachedMtfSeries(
  yahooSymbol: string,
  interval: string,
  range: string,
  ttlMs: number,
  required: boolean,
  signal?: AbortSignal
): Promise<RawYahooBar[]> {
  const key = `${yahooSymbol}:${interval}:${range}`;
  const cached = mtfSeriesCache.get(key);
  if (cached && Date.now() - cached.tsMs < ttlMs) {
    return cached.bars;
  }
  try {
    const bars = await fetchYahooSeries(yahooSymbol, interval, range, false, 0, signal);
    if (bars.length > 0) {
      mtfSeriesCache.set(key, { tsMs: Date.now(), bars });
      return bars;
    }
    if (cached) return cached.bars;
    return [];
  } catch (err) {
    if (cached) {
      console.warn(
        `[/api/gaia] Using cached ${interval} bars for ${yahooSymbol} after transient error:`,
        err instanceof Error ? err.message : String(err)
      );
      return cached.bars;
    }
    if (required) throw err;
    console.warn(
      `[/api/gaia] Non-fatal ${interval} MTF fetch error for ${yahooSymbol}:`,
      err instanceof Error ? err.message : String(err)
    );
    return [];
  }
}

function pairHourlyInto2Hr(bars60m: RawYahooBar[]): RawYahooBar[] {
  const paired: RawYahooBar[] = [];
  for (let i = 0; i < bars60m.length; i += 2) {
    const b1 = bars60m[i];
    const b2 = bars60m[i + 1] ?? b1;
    paired.push({
      ts: b2.ts,
      etDate: b2.etDate,
      etTime: b2.etTime,
      open: b1.open,
      high: Math.max(b1.high, b2.high),
      low: Math.min(b1.low, b2.low),
      close: b2.close,
    });
  }
  return paired;
}

async function fetchLiveOptionsBuckets(
  ticker: string,
  referenceSpot: number,
  priorClose: number,
  latestSessionDate: string,
  signal?: AbortSignal,
  preFetchedTick?: LiveTickResponse | null
): Promise<{
  dataSource: "TRADIER_LIVE" | "CBOE_MARKET_DATA";
  spotPrice: number;
  impliedVolatility: number;
  sigma1Move: number;
  sigma2Move: number;
  strikeStep: number;
  has0DteActive: boolean;
  expirations: GaiaExpirationInfo[];
  buckets: GaiaStrikeExpBucket[];
  isStaleFallback: boolean;
}> {
  const cboeResult = await fetchCboeDelayedChain(ticker, {
    signal,
    allowStaleFallback: true,
  });
  const data = cboeResult.data;

  const marketOpenNow = isMarketOpen().open;
  // Match /api/options identically: outside RTH, anchor frozen 4:00 PM option chain to official RTH close (data.close)
  const cboeClosePrice = Number(data.close ?? data.current_price ?? referenceSpot);
  const cboeSpotPrice = marketOpenNow
    ? Number(data.current_price ?? data.close ?? referenceSpot)
    : cboeClosePrice;
  let liveSpot = cboeSpotPrice;

  // During RTH, synchronize live spot identically to /api/options via fetchLiveTickQuote (zero SPY*10 SPXW basis drift)
  if (marketOpenNow) {
    try {
      const sym = ticker.trim().toUpperCase();
      const mapped = sym === "SPXW" ? "SPX" : sym === "NDXP" ? "NDX" : sym;
      const tick =
        preFetchedTick !== undefined
          ? preFetchedTick
          : await fetchLiveTickQuote(mapped).catch(() => null);
      if (tick && tick.spot > 0 && Number.isFinite(tick.spot)) {
        liveSpot = Number(tick.spot.toFixed(2));
      }
    } catch {
      // Non-fatal; retains exact CBOE current_price
    }
  }

  const rawIv30 = Number(data.iv30 ?? 0);
  const iv30Decimal = rawIv30 > 0 ? (rawIv30 > 2 ? rawIv30 / 100 : rawIv30) : 0.18;

  const rawContracts: NormalizedOptionContract[] = [];
  for (const rawOpt of data.options) {
    const occSymbol = String(rawOpt.option ?? "");
    const parsed = parseOccSymbol(occSymbol);
    if (!parsed) continue;

    const openInterest = Number(rawOpt.open_interest ?? 0);
    const volume = Number(rawOpt.volume ?? 0);
    // Match lib/optionsExposure.ts: keep all strikes with positive OI or positive intraday volume
    if (resolveEffectiveOpenInterest(openInterest, volume) <= 0) {
      continue;
    }

    const rawIv = Number(rawOpt.iv ?? 0);
    const iv = rawIv > 0.02 ? (rawIv > 4 ? rawIv / 100 : rawIv) : iv30Decimal;
    const gamma = Number(rawOpt.gamma ?? 0);
    const delta = Number(rawOpt.delta ?? 0);
    const bid = Number(rawOpt.bid ?? 0);
    const ask = Number(rawOpt.ask ?? 0);
    const lastPrice = Number(rawOpt.last_trade_price ?? rawOpt.last ?? 0);

    rawContracts.push({
      symbol: occSymbol,
      expiration: parsed.expiration,
      optionType: parsed.optionType,
      strike: Number(parsed.strike.toFixed(2)),
      openInterest,
      volume,
      iv,
      gamma: Number.isFinite(gamma) && gamma > 0 ? gamma : 0,
      delta: Number.isFinite(delta) ? delta : 0,
      vega: Number(rawOpt.vega ?? 0),
      percentChange: Number(rawOpt.percent_change ?? 0),
      bid: Number.isFinite(bid) && bid > 0 ? bid : 0,
      ask: Number.isFinite(ask) && ask > 0 ? ask : 0,
      last: Number.isFinite(lastPrice) && lastPrice > 0 ? lastPrice : 0,
    });
  }

  if (rawContracts.length === 0) {
    throw new Error("No active option contracts found in live CBOE feed");
  }

  // Re-anchor delayed CBOE contract quotes identically to /api/options so Expected Move & strikes match 100%
  const anchoredContracts = reanchorDelayedContractsToSpot({
    contracts: rawContracts,
    referenceSpot: cboeSpotPrice,
    liveSpot,
    fallbackIv: iv30Decimal,
  });

  // Include all valid non-expired expirations from the live CBOE option chain
  const rawExpirations = Array.from(
    new Set(anchoredContracts.map((o) => o.expiration))
  ).sort();

  const {
    referenceDate,
    hasZeroDte,
    activeExpirations: allExpirations,
  } = getActiveExpirationSelection(rawExpirations);

  const selectedIsoDates = allExpirations;
  const selectedIsoSet = new Set(selectedIsoDates);
  const parsedOptions = anchoredContracts.filter((o) =>
    selectedIsoSet.has(o.expiration)
  );
  const sortedExpirations = selectedIsoDates;
  const nextExpIso = sortedExpirations[0] ?? referenceDate;
  const refTimeMs = new Date(`${referenceDate}T00:00:00Z`).getTime();

  // Compute the Friday closing out the Monday-Friday trading week of nextExpIso
  const parsedNextExp = new Date(`${nextExpIso}T12:00:00Z`);
  const nextExpDateObj = Number.isFinite(parsedNextExp.getTime())
    ? parsedNextExp
    : new Date(`${referenceDate}T12:00:00Z`);
  const nextExpDow = nextExpDateObj.getUTCDay(); // 1 = Monday .. 5 = Friday
  const daysToWeekFriday = nextExpDow <= 5 ? 5 - nextExpDow : 6;
  const weekFridayIso = new Date(
    nextExpDateObj.getTime() + daysToWeekFriday * 86400 * 1000
  )
    .toISOString()
    .slice(0, 10);

  // Exact shared Expected Move (0.85 * ATM Straddle on nearest strike to liveSpot), 100% parity with /api/options
  const nextExpContracts = parsedOptions.filter((o) => o.expiration === nextExpIso);
  const nextExpTimeMs = new Date(`${nextExpIso}T00:00:00Z`).getTime();
  const nextExpDteDays =
    Number.isFinite(nextExpTimeMs) && Number.isFinite(refTimeMs)
      ? Math.max(0, (nextExpTimeMs - refTimeMs) / (1000 * 86400))
      : 1;
  const sharedDailyEm = computeExpirationExpectedMove(
    nextExpIso,
    liveSpot,
    iv30Decimal,
    nextExpDteDays,
    nextExpContracts
  );

  const sigmaFloor1d = Number(((priorClose || liveSpot || 757) * 0.0068).toFixed(2));
  const resolvedSigma1 =
    sharedDailyEm && sharedDailyEm.em > 0
      ? sharedDailyEm.em
      : Math.max(Number((priorClose * iv30Decimal * Math.sqrt(1 / 252)).toFixed(2)), sigmaFloor1d);
  const sigma2Move = Number((resolvedSigma1 * 2).toFixed(2));

  // Determine strike step near spot
  const atmStrikes = Array.from(
    new Set(
      parsedOptions
        .filter((o) => Math.abs(o.strike - liveSpot) <= liveSpot * 0.025)
        .map((o) => o.strike)
    )
  ).sort((a, b) => a - b);

  let strikeStep = 1;
  if (atmStrikes.length >= 3) {
    const diffs: number[] = [];
    for (let i = 1; i < atmStrikes.length; i++) {
      const d = Number((atmStrikes[i] - atmStrikes[i - 1]).toFixed(2));
      if (d >= 0.5) diffs.push(d);
    }
    if (diffs.length > 0) {
      diffs.sort((a, b) => a - b);
      strikeStep = diffs[Math.floor(diffs.length / 2)];
    }
  }

  // Build expiration metadata list across all active expirations
  const expirations: GaiaExpirationInfo[] = sortedExpirations.map(
    (iso, idx) => {
      const expTimeMs = new Date(`${iso}T00:00:00Z`).getTime();
      const dteDays = Math.max(
        0,
        Math.round((expTimeMs - refTimeMs) / (1000 * 86400))
      );
      return {
        isoDate: iso,
        dateLabel: iso.slice(5),
        dteDays,
        isNextExp: idx === 0,
        isThisWeek: iso >= nextExpIso && iso <= weekFridayIso,
      };
    }
  );

  // Aggregate contracts into (strike, expiration) buckets using pure open_interest & native CBOE gamma
  const bucketMap = new Map<
    string,
    {
      strike: number;
      expiration: string;
      dateLabel: string;
      dteDays: number;
      callOI: number;
      putOI: number;
      callIvWeighted: number;
      putIvWeighted: number;
      callGammaWeighted: number;
      putGammaWeighted: number;
      callDeltaWeighted: number;
      putDeltaWeighted: number;
    }
  >();

  for (const opt of parsedOptions) {
    const oi = resolveEffectiveOpenInterest(opt.openInterest, opt.volume);
    if (oi <= 0) continue;

    const key = `${opt.strike}_${opt.expiration}`;
    let b = bucketMap.get(key);
    if (!b) {
      const expTimeMs = new Date(`${opt.expiration}T00:00:00Z`).getTime();
      const dteDays = Math.max(
        0,
        (expTimeMs - refTimeMs) / (1000 * 86400)
      );
      b = {
        strike: opt.strike,
        expiration: opt.expiration,
        dateLabel: opt.expiration.slice(5),
        dteDays,
        callOI: 0,
        putOI: 0,
        callIvWeighted: 0,
        putIvWeighted: 0,
        callGammaWeighted: 0,
        putGammaWeighted: 0,
        callDeltaWeighted: 0,
        putDeltaWeighted: 0,
      };
      bucketMap.set(key, b);
    }

    const days = b.dteDays;
    const T = computeIntradayExpiryYears(days);
    const contractIv =
      opt.iv > 0.02
        ? opt.iv > 4
          ? opt.iv / 100
          : opt.iv
        : iv30Decimal;

    // Harmonized calibrated Black-Scholes Greeks (matching lib/optionsExposure.ts exactly)
    const bs = computeBlackScholesGreeks(
      liveSpot,
      opt.strike,
      T,
      contractIv,
      0.046,
      0.0
    );

    const contractGamma = bs.gamma;
    const contractDelta =
      opt.optionType === "C" ? bs.deltaCall : bs.deltaPut;

    if (opt.optionType === "C") {
      b.callOI += oi;
      b.callIvWeighted += oi * contractIv;
      b.callGammaWeighted += oi * contractGamma;
      b.callDeltaWeighted += oi * contractDelta;
    } else {
      b.putOI += oi;
      b.putIvWeighted += oi * contractIv;
      b.putGammaWeighted += oi * contractGamma;
      b.putDeltaWeighted += oi * contractDelta;
    }
  }

  const maxBucketReach = Math.max(resolvedSigma1 * 3.5, liveSpot * 0.08);
  let peakGammaStrike = liveSpot;
  let peakGammaScore = -1;
  for (const b of Array.from(bucketMap.values())) {
    const score = b.callGammaWeighted + b.putGammaWeighted;
    if (score > peakGammaScore) {
      peakGammaScore = score;
      peakGammaStrike = b.strike;
    }
  }
  const buckets: GaiaStrikeExpBucket[] = [];
  for (const b of Array.from(bucketMap.values())) {
    if (
      liveSpot > 0 &&
      b.strike !== peakGammaStrike &&
      (Math.abs(b.strike - liveSpot) > maxBucketReach ||
        (b.dteDays > 45 && b.callOI + b.putOI < 250))
    ) {
      continue;
    }
    buckets.push({
      strike: b.strike,
      expiration: b.expiration,
      dateLabel: b.dateLabel,
      dteDays: Number(b.dteDays.toFixed(2)),
      callOI: b.callOI,
      putOI: b.putOI,
      callIv:
        b.callOI > 0
          ? Number((b.callIvWeighted / b.callOI).toFixed(4))
          : iv30Decimal,
      putIv:
        b.putOI > 0
          ? Number((b.putIvWeighted / b.putOI).toFixed(4))
          : iv30Decimal,
      callGamma:
        b.callOI > 0 ? Number((b.callGammaWeighted / b.callOI).toFixed(6)) : 0,
      putGamma:
        b.putOI > 0 ? Number((b.putGammaWeighted / b.putOI).toFixed(6)) : 0,
      callDelta:
        b.callOI > 0
          ? Number((b.callDeltaWeighted / b.callOI).toFixed(4))
          : 0,
      putDelta:
        b.putOI > 0
          ? Number((b.putDeltaWeighted / b.putOI).toFixed(4))
          : 0,
    });
  }

  return {
    dataSource: "CBOE_MARKET_DATA",
    spotPrice: liveSpot,
    impliedVolatility: Number(iv30Decimal.toFixed(4)),
    sigma1Move: resolvedSigma1,
    sigma2Move,
    strikeStep,
    has0DteActive: hasZeroDte,
    expirations,
    buckets,
    isStaleFallback: cboeResult.isStaleFallback,
  };
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const rawRequestedSession = (searchParams.get("session") ?? "").trim();
  const todayEt = getTodayEt();
  const requestedSession =
    rawRequestedSession === todayEt ? "" : rawRequestedSession;
  const rawStart = (searchParams.get("start") ?? searchParams.get("startHour") ?? "0").trim().toLowerCase();
  const startHour =
    rawStart === "9:30" || rawStart === "9.5" || rawStart === "9"
      ? 9
      : rawStart === "8"
        ? 8
        : rawStart === "7"
          ? 7
          : 0;

  const ticker = sanitizeTickerSymbol(searchParams.get("ticker"), "SPY");
  const yahooSymbol = mapYahooSymbol(ticker);
  const cacheKey = `${ticker}:${requestedSession || "latest"}:${startHour}`;

  const cached = gaiaShortCache.get(cacheKey);
  if (cached && Date.now() - cached.tsMs < GAIA_SHORT_CACHE_MS) {
    return NextResponse.json(cached.payload, {
      headers: { "Cache-Control": "no-store, max-age=0" },
    });
  }

  let pending = gaiaInFlight.get(cacheKey);
  if (!pending) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15_000);
    let createdPromise: Promise<GaiaCoalescedResult> | undefined;
    createdPromise = (async (): Promise<GaiaCoalescedResult> => {
      try {
        const marketOpenNow = isMarketOpen().open;
        const tickSym =
          ticker === "SPXW" ? "SPX" : ticker === "NDXP" ? "NDX" : ticker;

        // Fetch live 5m series + cached higher-timeframe MTF series + live RTH tick in parallel
        const [bars5mRaw, bars30mRaw, bars60mRaw, bars1dRaw, bars1wkRaw, liveTick] =
          await Promise.all([
            fetchYahooSeries(yahooSymbol, "5m", "1mo", true, startHour, controller.signal),
            fetchCachedMtfSeries(yahooSymbol, "30m", "1mo", 45_000, false, controller.signal),
            fetchCachedMtfSeries(yahooSymbol, "60m", "3mo", 60_000, false, controller.signal),
            fetchCachedMtfSeries(yahooSymbol, "1d", "6mo", 120_000, true, controller.signal),
            fetchCachedMtfSeries(yahooSymbol, "1wk", "2y", 300_000, false, controller.signal),
            marketOpenNow && !requestedSession
              ? fetchLiveTickQuote(tickSym).catch(() => null)
              : Promise.resolve(null),
          ]);

        if (bars5mRaw.length === 0 || bars1dRaw.length === 0) {
          return { ok: false, error: `No live market bars returned for ${ticker}`, status: 502 };
        }

    // Group 5m bars by ET trading session date
    const sessionDatesDesc = Array.from(
      new Set(bars5mRaw.map((b) => b.etDate))
    )
      .sort()
      .reverse()
      .slice(0, 10);

    // Ensure today's active RTH session is represented even right at the 09:30 AM ET bell
    if (marketOpenNow && !sessionDatesDesc.includes(todayEt)) {
      sessionDatesDesc.unshift(todayEt);
      if (sessionDatesDesc.length > 10) sessionDatesDesc.length = 10;
    }

    const sessions: GaiaSessionOption[] = sessionDatesDesc.map((iso) => ({
      isoDate: iso,
      bookLabel: formatBookLabel(iso),
    }));

    const activeSessionDate =
      requestedSession && sessionDatesDesc.includes(requestedSession)
        ? requestedSession
        : sessionDatesDesc[0];

    const activeSessionObj =
      sessions.find((s) => s.isoDate === activeSessionDate) ?? sessions[0];

    // Backfill missing 5m extended-hours / RTH buckets from recorded intraday history
    const extPoints = getMergedIntradayHistory(ticker, activeSessionDate);
    let bars5mWithExt = bars5mRaw;
    if (extPoints.length > 0) {
      const existingBuckets = new Set<number>();
      for (const b of bars5mRaw) {
        if (b.etDate === activeSessionDate) {
          existingBuckets.add(Math.floor(b.ts / 300) * 300);
        }
      }
      const startMin = startHour === 9 ? 570 : startHour >= 7 ? startHour * 60 : 0;
      const endMin = startHour === 0 ? 1440 : 960;
      const bucketMap = new Map<number, { open: number; high: number; low: number; close: number }>();
      for (const pt of extPoints) {
        const mins = getEtMinutesFromTs(pt.ts);
        if (mins < startMin || mins >= endMin) continue;
        const bTs = Math.floor(pt.ts / 300) * 300;
        if (existingBuckets.has(bTs)) continue;
        const prev = bucketMap.get(bTs);
        if (!prev) {
          bucketMap.set(bTs, { open: pt.spot, high: pt.spot, low: pt.spot, close: pt.spot });
        } else {
          prev.high = Math.max(prev.high, pt.spot);
          prev.low = Math.min(prev.low, pt.spot);
          prev.close = pt.spot;
        }
      }
      if (bucketMap.size > 0) {
        const backfilledBars: RawYahooBar[] = Array.from(bucketMap.entries()).map(([bTs, ohlc]) => ({
          ts: bTs,
          etDate: activeSessionDate,
          etTime: formatEtTime(bTs),
          open: Number(ohlc.open.toFixed(2)),
          high: Number(ohlc.high.toFixed(2)),
          low: Number(ohlc.low.toFixed(2)),
          close: Number(ohlc.close.toFixed(2)),
        }));
        bars5mWithExt = [...bars5mRaw, ...backfilledBars].sort((a, b) => a.ts - b.ts);
      }
    }

    // Append or update the active forming 5m bar through the current ET minute strictly during RTH
    if (
      marketOpenNow &&
      activeSessionDate === todayEt &&
      liveTick &&
      liveTick.spot > 0 &&
      Number.isFinite(liveTick.spot)
    ) {
      const nowSec = Math.floor(Date.now() / 1000);
      const nowMinsEt = getEtMinutesFromTs(nowSec);
      const bounds = getSessionBoundsEt(todayEt);
      const minAllowed = startHour === 9 ? bounds.rthOpenMins : startHour >= 7 ? startHour * 60 : 0;
      const maxAllowed = startHour === 0 ? 1440 : bounds.rthCloseMins;
      if (nowMinsEt >= minAllowed && nowMinsEt < maxAllowed) {
        const curBucketTs = Math.floor(nowSec / 300) * 300;
        const liveP = Number(liveTick.spot.toFixed(2));
        const cloned = [...bars5mWithExt];
        let matchedIdx = -1;
        for (let i = cloned.length - 1; i >= 0; i--) {
          if (cloned[i].etDate !== activeSessionDate) break;
          if (Math.floor(cloned[i].ts / 300) * 300 === curBucketTs) {
            matchedIdx = i;
            break;
          }
        }
        if (matchedIdx >= 0) {
          const cur = cloned[matchedIdx];
          cloned[matchedIdx] = {
            ...cur,
            high: Number(Math.max(cur.high, liveP).toFixed(2)),
            low: Number(Math.min(cur.low, liveP).toFixed(2)),
            close: liveP,
          };
          bars5mWithExt = cloned;
        } else {
          const lastToday = [...cloned].reverse().find((b) => b.etDate === activeSessionDate);
          if (!lastToday || curBucketTs > lastToday.ts) {
            cloned.push({
              ts: curBucketTs,
              etDate: todayEt,
              etTime: formatEtTime(curBucketTs),
              open: liveP,
              high: liveP,
              low: liveP,
              close: liveP,
            });
            cloned.sort((a, b) => a.ts - b.ts);
            bars5mWithExt = cloned;
          }
        }
      }
    }

    // Enrich 5m bars with Wilder RSI(14) and MACD(12,26,9) across the full continuous series
    const enriched5m = enrichBarsWithRsiAndMacd(bars5mWithExt);

    // Locate indices belonging to activeSessionDate
    const sessionGlobalIndices: number[] = [];
    for (let i = 0; i < enriched5m.length; i++) {
      if (enriched5m[i].etDate === activeSessionDate) {
        sessionGlobalIndices.push(i);
      }
    }

    if (sessionGlobalIndices.length === 0) {
      return { ok: false, error: `No 5m session bars found for ${ticker} on ${activeSessionDate}`, status: 502 };
    }

    const firstSessionGlobalIdx = sessionGlobalIndices[0];

    // Daily closes strictly prior to activeSessionDate for priorClose and Daily MAs
    const priorDailyBars = bars1dRaw.filter(
      (b) => b.etDate < activeSessionDate
    );
    const priorDailyCloses = priorDailyBars.map((b) => b.close);
    const priorClose =
      priorDailyCloses.length > 0
        ? priorDailyCloses[priorDailyCloses.length - 1]
        : enriched5m[firstSessionGlobalIdx].open;

    const prior4Sum = priorDailyCloses
      .slice(-4)
      .reduce((acc, c) => acc + c, 0);
    const prior4Count = Math.min(4, priorDailyCloses.length);

    const prior54Sum = priorDailyCloses
      .slice(-54)
      .reduce((acc, c) => acc + c, 0);
    const prior54Count = Math.min(54, priorDailyCloses.length);

    const kEma21 = 2 / 22;
    let priorEma21 = priorDailyCloses[0] ?? priorClose;
    for (let i = 1; i < priorDailyCloses.length; i++) {
      priorEma21 =
        priorDailyCloses[i] * kEma21 + priorEma21 * (1 - kEma21);
    }

    // Build session 5-minute candles with exact SMA 34 (5m) and stepped Daily MAs
    const candles: GaiaIntradayCandle[] = sessionGlobalIndices.map(
      (gIdx, localIdx) => {
        const b = enriched5m[gIdx];
        const close = b.close;

        // 34-bar 5-minute SMA across continuous 5m closes
        const start34 = Math.max(0, gIdx - 33);
        let sum34 = 0;
        let count34 = 0;
        for (let k = start34; k <= gIdx; k++) {
          sum34 += enriched5m[k].close;
          count34++;
        }
        const sma34 = Number((sum34 / Math.max(1, count34)).toFixed(2));

        const sma5d = Number(
          ((prior4Sum + close) / (prior4Count + 1)).toFixed(2)
        );
        const ema21d = Number(
          (close * kEma21 + priorEma21 * (1 - kEma21)).toFixed(2)
        );
        const sma55d = Number(
          ((prior54Sum + close) / (prior54Count + 1)).toFixed(2)
        );

        return {
          index: localIdx,
          timestamp: b.ts,
          timeLabel: b.etTime,
          open: Number(b.open.toFixed(2)),
          high: Number(b.high.toFixed(2)),
          low: Number(b.low.toFixed(2)),
          close: Number(b.close.toFixed(2)),
          sma34,
          sma5d,
          ema21d,
          sma55d,
          rsi14: Number(b.rsi14.toFixed(2)),
          macdHist: Number(b.macdHist.toFixed(4)),
        };
      }
    );

    // Multi-Timeframe Divergence Detection (SPY, QQQ, SPX, SPXW, IWM)
    const isDivergenceSupported = DIVERGENCE_SUPPORTED_TICKERS.has(ticker);
    let pivotSignals5m: GaiaPivotSignal[] = [];
    let mtfByBar: GaiaMtfRow[] = candles.map(() => ({
      tf5m: "NO",
      tf30m: "NO",
      tf2h: "NO",
      tfDaily: "NO",
      tfWeekly: "NO",
    }));

    if (isDivergenceSupported) {
      const signals5mGlobal = detectGlobalPivotSignals(enriched5m);

      const enriched30m = enrichBarsWithRsiAndMacd(bars30mRaw);
      const signals30mGlobal = detectGlobalPivotSignals(enriched30m);

      const enriched2h = enrichBarsWithRsiAndMacd(pairHourlyInto2Hr(bars60mRaw));
      const signals2hGlobal = detectGlobalPivotSignals(enriched2h);

      const enriched1d = enrichBarsWithRsiAndMacd(bars1dRaw);
      const signals1dGlobal = detectGlobalPivotSignals(enriched1d);

      const enriched1wk = enrichBarsWithRsiAndMacd(bars1wkRaw);
      const signals1wkGlobal = detectGlobalPivotSignals(enriched1wk);

      // Map 5m signals whose P2 falls inside the active session
      pivotSignals5m = signals5mGlobal
        .filter(
          (s) =>
            s.p2GlobalIdx >= firstSessionGlobalIdx &&
            s.p2GlobalIdx < firstSessionGlobalIdx + candles.length
        )
        .map((s) => ({
          type: s.type,
          p1Index: s.p1GlobalIdx - firstSessionGlobalIdx,
          p1Price: s.p1Price,
          p2Index: s.p2GlobalIdx - firstSessionGlobalIdx,
          p2Price: s.p2Price,
          confirmedAtIndex: Math.min(
            candles.length - 1,
            s.confirmedGlobalIdx - firstSessionGlobalIdx
          ),
        }));

      mtfByBar = candles.map((c, localIdx) => {
        const gIdx5m = firstSessionGlobalIdx + localIdx;
        let tf5m: DivergenceStatus = "NO";
        for (const sig of signals5mGlobal) {
          if (
            gIdx5m >= sig.confirmedGlobalIdx &&
            gIdx5m - sig.p2GlobalIdx <= 30
          ) {
            tf5m = sig.type;
          }
        }

        return {
          tf5m,
          tf30m: evaluateTfStatusAtTimestamp(
            enriched30m,
            signals30mGlobal,
            c.timestamp
          ),
          tf2h: evaluateTfStatusAtTimestamp(
            enriched2h,
            signals2hGlobal,
            c.timestamp
          ),
          tfDaily: evaluateTfStatusAtTimestamp(
            enriched1d,
            signals1dGlobal,
            c.timestamp
          ),
          tfWeekly: evaluateTfStatusAtTimestamp(
            enriched1wk,
            signals1wkGlobal,
            c.timestamp
          ),
        };
      });
    }

    // Fetch live options chain book from CBOE (falling back to cached book if CBOE transiently hiccups so candles never freeze)
    const lastSessionClose = candles[candles.length - 1].close;
    let liveBook: Awaited<ReturnType<typeof fetchLiveOptionsBuckets>>;
    try {
      liveBook = await fetchLiveOptionsBuckets(
        ticker,
        lastSessionClose,
        priorClose,
        sessionDatesDesc[0],
        controller.signal,
        liveTick
      );
    } catch (cboeErr) {
      const prevGaia = gaiaShortCache.get(cacheKey)?.payload;
      if (prevGaia && prevGaia.optionBuckets.length > 0) {
        console.warn(
          `[/api/gaia] Keeping fresh candles for ${ticker} with cached option book after transient CBOE error:`,
          cboeErr instanceof Error ? cboeErr.message : String(cboeErr)
        );
        liveBook = {
          dataSource: prevGaia.dataSource,
          spotPrice: liveTick?.spot && liveTick.spot > 0 ? Number(liveTick.spot.toFixed(2)) : lastSessionClose,
          impliedVolatility: prevGaia.impliedVolatility,
          sigma1Move: prevGaia.sigma1Move,
          sigma2Move: prevGaia.sigma2Move,
          strikeStep: prevGaia.strikeStep,
          has0DteActive: prevGaia.has0DteActive,
          expirations: prevGaia.expirations,
          buckets: prevGaia.optionBuckets,
          isStaleFallback: true,
        };
      } else {
        throw cboeErr;
      }
    }

    const payload: GaiaLivePayload = {
      ticker,
      dataSource: liveBook.dataSource,
      sessionDate: activeSessionDate,
      bookLabel: activeSessionObj.bookLabel,
      sessions,
      expirations: liveBook.expirations,
      has0DteActive: liveBook.has0DteActive,
      priorClose: Number(priorClose.toFixed(2)),
      spotPrice: liveBook.spotPrice,
      impliedVolatility: liveBook.impliedVolatility,
      sigma1Move: liveBook.sigma1Move,
      sigma2Move: liveBook.sigma2Move,
      strikeStep: liveBook.strikeStep,
      candles,
      pivotSignals5m,
      mtfByBar,
      optionBuckets: liveBook.buckets,
      isStale: Boolean(liveBook.isStaleFallback),
      marketOpen: marketOpenNow,
      lastUpdated: new Date().toISOString(),
    };

      return { ok: true, payload };
      } finally {
        clearTimeout(timeoutId);
        if (gaiaInFlight.get(cacheKey) === createdPromise) {
          gaiaInFlight.delete(cacheKey);
        }
      }
    })();
    pending = createdPromise;
    gaiaInFlight.set(cacheKey, pending);
  }

  try {
    const result = await pending;
    if (!result.ok) {
      const staleFallback = gaiaShortCache.get(cacheKey);
      if (staleFallback) {
        return NextResponse.json(
          { ...staleFallback.payload, isStale: true, marketOpen: isMarketOpen().open },
          {
            headers: {
              "X-Hyperion-Data-Status": "STALE_SYNCING",
              "Cache-Control": "no-store, max-age=0",
            },
          }
        );
      }
      return NextResponse.json(
        { error: result.error },
        { status: result.status, headers: { "Cache-Control": "no-store, max-age=0" } }
      );
    }
    gaiaShortCache.set(cacheKey, { tsMs: Date.now(), payload: result.payload });
    return NextResponse.json(result.payload, {
      headers: { "Cache-Control": "no-store, max-age=0" },
    });
  } catch (err) {
    const staleFallback = gaiaShortCache.get(cacheKey);
    if (staleFallback) {
      return NextResponse.json(
        { ...staleFallback.payload, isStale: true, marketOpen: isMarketOpen().open },
        {
          headers: {
            "X-Hyperion-Data-Status": "STALE_SYNCING",
            "Cache-Control": "no-store, max-age=0",
          },
        }
      );
    }
    const message =
      err instanceof Error ? err.message : "Live market feed error";
    return NextResponse.json(
      { error: `Live Gaia feed unavailable for ${ticker}: ${message}` },
      { status: 502, headers: { "Cache-Control": "no-store, max-age=0" } }
    );
  } finally {
    if (gaiaInFlight.get(cacheKey) === pending) {
      gaiaInFlight.delete(cacheKey);
    }
  }
}
