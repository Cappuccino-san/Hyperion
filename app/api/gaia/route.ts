import { NextRequest, NextResponse } from "next/server";
import {
  computeBlackScholesGreeks,
  getActiveExpirationSelection,
  parseOccSymbol,
} from "@/lib/optionsExposure";

export const dynamic = "force-dynamic";

export type DivergenceStatus = "BULL" | "BEAR" | "NO";

export interface GaiaSessionOption {
  isoDate: string;
  bookLabel: string;
}
export type AntaeusSessionOption = GaiaSessionOption;

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
export type AntaeusIntradayCandle = GaiaIntradayCandle;

export interface GaiaPivotSignal {
  type: "BULL" | "BEAR";
  p1Index: number; // may be < 0 if P1 occurred in the prior session
  p1Price: number;
  p2Index: number; // 0 .. candles.length - 1
  p2Price: number;
  confirmedAtIndex: number;
}
export type AntaeusPivotSignal = GaiaPivotSignal;

export interface GaiaMtfRow {
  tf5m: DivergenceStatus;
  tf30m: DivergenceStatus;
  tf2h: DivergenceStatus;
  tfDaily: DivergenceStatus;
  tfWeekly: DivergenceStatus;
}
export type AntaeusMtfRow = GaiaMtfRow;

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
export type AntaeusStrikeExpBucket = GaiaStrikeExpBucket;

export interface GaiaExpirationInfo {
  isoDate: string;
  dateLabel: string;
  dteDays: number;
  isNextExp: boolean;
  isThisWeek: boolean;
}
export type AntaeusExpirationInfo = GaiaExpirationInfo;

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
}
export type AntaeusLivePayload = GaiaLivePayload;

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

function formatEtDate(tsSeconds: number): string {
  return new Date(tsSeconds * 1000).toLocaleDateString("en-CA", {
    timeZone: "America/New_York",
  });
}

function formatEtTime(tsSeconds: number): string {
  return new Date(tsSeconds * 1000).toLocaleTimeString("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
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

async function fetchYahooSeries(
  yahooSymbol: string,
  interval: string,
  range: string
): Promise<RawYahooBar[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    yahooSymbol
  )}?interval=${interval}&range=${range}&includePrePost=false`;

  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (compatible; HyperionAnalytics/1.0)",
    },
    cache: "no-store",
  });

  if (!res.ok) {
    throw new Error(`Yahoo Finance ${interval} HTTP ${res.status}`);
  }

  const json = await res.json();
  const result = json?.chart?.result?.[0];
  const timestamps: number[] = result?.timestamp ?? [];
  const quote = result?.indicators?.quote?.[0] ?? {};
  const opens: (number | null)[] = quote.open ?? [];
  const highs: (number | null)[] = quote.high ?? [];
  const lows: (number | null)[] = quote.low ?? [];
  const closes: (number | null)[] = quote.close ?? [];

  const bars: RawYahooBar[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const c = closes[i];
    const o = opens[i];
    const h = highs[i];
    const l = lows[i];
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
    const etTime = formatEtTime(ts);
    if (interval === "5m" && etTime === "4:00 PM") {
      continue;
    }
    bars.push({
      ts,
      etDate: formatEtDate(ts),
      etTime,
      open: Number(o),
      high: Number(h),
      low: Number(l),
      close: Number(c),
    });
  }

  return bars;
}

function enrichBarsWithRsiAndMacd(bars: RawYahooBar[]): EnrichedBar[] {
  const n = bars.length;
  const rsi14 = new Array<number>(n).fill(50);
  const period = 14;

  if (n > period) {
    let avgGain = 0;
    let avgLoss = 0;
    for (let i = 1; i <= period; i++) {
      const diff = bars[i].close - bars[i - 1].close;
      if (diff > 0) avgGain += diff;
      else avgLoss -= diff;
    }
    avgGain /= period;
    avgLoss /= period;
    rsi14[period] =
      avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

    for (let i = period + 1; i < n; i++) {
      const diff = bars[i].close - bars[i - 1].close;
      const gain = diff > 0 ? diff : 0;
      const loss = diff < 0 ? -diff : 0;
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      rsi14[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
  }

  const k12 = 2 / 13;
  const k26 = 2 / 27;
  const k9 = 2 / 10;
  let ema12 = bars[0]?.close ?? 0;
  let ema26 = bars[0]?.close ?? 0;
  let signal = 0;

  return bars.map((b, i) => {
    ema12 = b.close * k12 + ema12 * (1 - k12);
    ema26 = b.close * k26 + ema26 * (1 - k26);
    const macd = ema12 - ema26;
    signal = i === 0 ? macd : macd * k9 + signal * (1 - k9);
    const macdHist = macd - signal;
    return {
      ...b,
      rsi14: rsi14[i],
      macdHist,
    };
  });
}

/**
 * Non-repainting 3-Left / 3-Right Pivot Divergence Detector.
 * Each pivot requires 3 finished bars on each side; forming bars are never used.
 * A timeframe stays BULL or BEAR for 30 bars after the second pivot.
 */
function detectGlobalPivotSignals(bars: EnrichedBar[]): DetectedGlobalSignal[] {
  const n = bars.length;
  const pivotLows: number[] = [];
  const pivotHighs: number[] = [];

  for (let i = 3; i <= n - 4; i++) {
    const l = bars[i].low;
    const isLow =
      l <= bars[i - 3].low &&
      l <= bars[i - 2].low &&
      l <= bars[i - 1].low &&
      l <= bars[i + 1].low &&
      l <= bars[i + 2].low &&
      l <= bars[i + 3].low &&
      (l < bars[i - 1].low || l < bars[i + 1].low);

    if (isLow) pivotLows.push(i);

    const h = bars[i].high;
    const isHigh =
      h >= bars[i - 3].high &&
      h >= bars[i - 2].high &&
      h >= bars[i - 1].high &&
      h >= bars[i + 1].high &&
      h >= bars[i + 2].high &&
      h >= bars[i + 3].high &&
      (h > bars[i - 1].high || h > bars[i + 1].high);

    if (isHigh) pivotHighs.push(i);
  }

  const signals: DetectedGlobalSignal[] = [];

  // Consecutive Pivot Lows -> BULL Divergence
  for (let k = 1; k < pivotLows.length; k++) {
    const p1 = pivotLows[k - 1];
    const p2 = pivotLows[k];
    if (
      bars[p2].low < bars[p1].low &&
      bars[p2].rsi14 > bars[p1].rsi14 &&
      bars[p2].macdHist > bars[p1].macdHist
    ) {
      const confIdx = p2 + 3;
      signals.push({
        type: "BULL",
        p1GlobalIdx: p1,
        p1Price: bars[p1].low,
        p2GlobalIdx: p2,
        p2Price: bars[p2].low,
        confirmedGlobalIdx: confIdx,
        p2Timestamp: bars[p2].ts,
        confirmedTimestamp: bars[confIdx].ts,
      });
    }
  }

  // Consecutive Pivot Highs -> BEAR Divergence
  for (let k = 1; k < pivotHighs.length; k++) {
    const p1 = pivotHighs[k - 1];
    const p2 = pivotHighs[k];
    if (
      bars[p2].high > bars[p1].high &&
      bars[p2].rsi14 < bars[p1].rsi14 &&
      bars[p2].macdHist < bars[p1].macdHist
    ) {
      const confIdx = p2 + 3;
      signals.push({
        type: "BEAR",
        p1GlobalIdx: p1,
        p1Price: bars[p1].high,
        p2GlobalIdx: p2,
        p2Price: bars[p2].high,
        confirmedGlobalIdx: confIdx,
        p2Timestamp: bars[p2].ts,
        confirmedTimestamp: bars[confIdx].ts,
      });
    }
  }

  return signals;
}

function evaluateTfStatusAtTimestamp(
  bars: EnrichedBar[],
  signals: DetectedGlobalSignal[],
  targetTs: number
): DivergenceStatus {
  if (bars.length === 0 || signals.length === 0) return "NO";

  // Find the latest bar index at or before targetTs
  let currentIdx = -1;
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].ts <= targetTs) {
      currentIdx = i;
    } else {
      break;
    }
  }
  if (currentIdx < 3) return "NO";

  // Find most recent confirmed signal where currentIdx >= confirmedGlobalIdx
  // and (currentIdx - p2GlobalIdx) <= 30
  let activeSignal: DetectedGlobalSignal | null = null;
  for (const sig of signals) {
    if (
      currentIdx >= sig.confirmedGlobalIdx &&
      currentIdx - sig.p2GlobalIdx <= 30
    ) {
      if (!activeSignal || sig.p2GlobalIdx >= activeSignal.p2GlobalIdx) {
        activeSignal = sig;
      }
    }
  }

  return activeSignal ? activeSignal.type : "NO";
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
  latestSessionDate: string
): Promise<{
  dataSource: "TRADIER_LIVE" | "CBOE_MARKET_DATA";
  spotPrice: number;
  impliedVolatility: number;
  sigma1Move: number;
  sigma2Move: number;
  strikeStep: number;
  has0DteActive: boolean;
  expirations: AntaeusExpirationInfo[];
  buckets: AntaeusStrikeExpBucket[];
}> {
  const cboeSymbol = mapCboeSymbol(ticker);
  const url = `https://cdn.cboe.com/api/global/delayed_quotes/options/${cboeSymbol}.json`;

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (compatible; HyperionAnalytics/1.0)",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Live CBOE options feed HTTP ${response.status}`);
  }

  const json = await response.json();
  const data = json?.data;
  if (!data || !Array.isArray(data.options) || data.options.length === 0) {
    throw new Error("Live CBOE options feed returned empty option chain");
  }

  const liveSpot = Number(data.current_price ?? data.close ?? referenceSpot);
  const rawIv30 = Number(data.iv30 ?? 15);
  const iv30Decimal = rawIv30 > 2 ? rawIv30 / 100 : rawIv30;

  interface RawParsedOpt {
    expiration: string;
    optionType: "C" | "P";
    strike: number;
    openInterest: number;
    volume: number;
    iv: number;
    gamma: number;
    delta: number;
    bid: number;
    ask: number;
    lastPrice: number;
  }

  const hasChainOpenInterest = data.options.some(
    (rawOpt: Record<string, unknown>) => Number(rawOpt?.open_interest ?? 0) > 0
  );

  const allValidRaw: RawParsedOpt[] = [];
  for (const rawOpt of data.options) {
    const occSymbol = String(rawOpt.option ?? "");
    const parsed = parseOccSymbol(occSymbol);
    if (!parsed) continue;

    const openInterest = Number(rawOpt.open_interest ?? 0);
    const volume = Number(rawOpt.volume ?? 0);
    if (hasChainOpenInterest ? openInterest <= 0 : openInterest <= 0 && volume <= 0) {
      continue;
    }

    const rawIv = Number(rawOpt.iv ?? 0);
    const iv =
      rawIv > 0.02 ? (rawIv > 4 ? rawIv / 100 : rawIv) : iv30Decimal;
    const gamma = Number(rawOpt.gamma ?? 0);
    const delta = Number(rawOpt.delta ?? 0);
    const bid = Number(rawOpt.bid ?? 0);
    const ask = Number(rawOpt.ask ?? 0);
    const lastPrice = Number(rawOpt.last_trade_price ?? rawOpt.last ?? 0);

    allValidRaw.push({
      expiration: parsed.expiration,
      optionType: parsed.optionType,
      strike: Number(parsed.strike.toFixed(2)),
      openInterest,
      volume,
      iv,
      gamma: Number.isFinite(gamma) && gamma > 0 ? gamma : 0,
      delta: Number.isFinite(delta) ? delta : 0,
      bid: Number.isFinite(bid) && bid > 0 ? bid : 0,
      ask: Number.isFinite(ask) && ask > 0 ? ask : 0,
      lastPrice: Number.isFinite(lastPrice) && lastPrice > 0 ? lastPrice : 0,
    });
  }

  if (allValidRaw.length === 0) {
    throw new Error("No active option contracts found in live CBOE feed");
  }

  // Include all valid non-expired expirations from the live CBOE option chain
  const rawExpirations = Array.from(
    new Set(allValidRaw.map((o) => o.expiration))
  ).sort();

  const {
    referenceDate,
    hasZeroDte,
    activeExpirations: allExpirations,
  } = getActiveExpirationSelection(rawExpirations);

  const selectedIsoDates = allExpirations;
  const selectedIsoSet = new Set(selectedIsoDates);
  const parsedOptions = allValidRaw.filter((o) =>
    selectedIsoSet.has(o.expiration)
  );
  const sortedExpirations = selectedIsoDates;
  const nextExpIso = sortedExpirations[0];
  const refTimeMs = new Date(`${referenceDate}T00:00:00Z`).getTime();

  // Compute the Friday closing out the Monday-Friday trading week of nextExpIso
  const nextExpDateObj = new Date(`${nextExpIso}T12:00:00Z`);
  const nextExpDow = nextExpDateObj.getUTCDay(); // 1 = Monday .. 5 = Friday
  const daysToWeekFriday = nextExpDow <= 5 ? 5 - nextExpDow : 6;
  const weekFridayIso = new Date(
    nextExpDateObj.getTime() + daysToWeekFriday * 86400 * 1000
  )
    .toISOString()
    .slice(0, 10);

  // Compute expected-move 1σ and 2σ cone from 0.85 × ATM Straddle or ATM IV on the nearest active expiration
  const midRefPrice = liveSpot * 0.65 + priorClose * 0.35;
  const atmContracts = parsedOptions.filter(
    (o) =>
      o.expiration === nextExpIso &&
      Math.abs(o.strike - midRefPrice) / midRefPrice <= 0.012 &&
      o.iv > 0.02
  );
  const atmIv =
    atmContracts.length > 0
      ? atmContracts.reduce((sum, o) => sum + o.iv, 0) / atmContracts.length
      : iv30Decimal;

  // Exact TerraShade Expected Move: 0.85 × (ATM Call Mid + ATM Put Mid)
  const atmCall = parsedOptions.find(
    (o) =>
      o.expiration === nextExpIso &&
      o.optionType === "C" &&
      Math.abs(o.strike - liveSpot) / liveSpot <= 0.015
  );
  const atmPut = parsedOptions.find(
    (o) =>
      o.expiration === nextExpIso &&
      o.optionType === "P" &&
      Math.abs(o.strike - liveSpot) / liveSpot <= 0.015
  );

  let calculatedMove = 0;
  if (atmCall && atmPut) {
    const cMid =
      atmCall.bid > 0 && atmCall.ask > 0
        ? (atmCall.bid + atmCall.ask) / 2
        : atmCall.lastPrice;
    const pMid =
      atmPut.bid > 0 && atmPut.ask > 0
        ? (atmPut.bid + atmPut.ask) / 2
        : atmPut.lastPrice;
    if (cMid > 0 && pMid > 0) {
      calculatedMove = Number((0.85 * (cMid + pMid)).toFixed(2));
    }
  }

  const sigma1Move =
    calculatedMove > 0
      ? calculatedMove
      : Number((priorClose * atmIv * Math.sqrt(1 / 252)).toFixed(2));
  const sigma2Move = Number((sigma1Move * 2).toFixed(2));

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
  const expirations: AntaeusExpirationInfo[] = sortedExpirations.map(
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
    const oi = hasChainOpenInterest ? opt.openInterest : opt.volume;
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

    const T = Math.max(1 / 365, (b.dteDays + 0.5) / 365);
    const bsFallback =
      opt.gamma > 0 && opt.delta !== 0
        ? null
        : computeBlackScholesGreeks(liveSpot, opt.strike, T, opt.iv);

    const contractGamma =
      opt.gamma > 0 ? opt.gamma : (bsFallback?.gamma ?? 0);
    const contractDelta =
      opt.delta !== 0
        ? opt.delta
        : opt.optionType === "C"
          ? (bsFallback?.deltaCall ?? 0)
          : (bsFallback?.deltaPut ?? 0);

    if (opt.optionType === "C") {
      b.callOI += oi;
      b.callIvWeighted += oi * opt.iv;
      b.callGammaWeighted += oi * contractGamma;
      b.callDeltaWeighted += oi * contractDelta;
    } else {
      b.putOI += oi;
      b.putIvWeighted += oi * opt.iv;
      b.putGammaWeighted += oi * contractGamma;
      b.putDeltaWeighted += oi * contractDelta;
    }
  }

  const buckets: AntaeusStrikeExpBucket[] = [];
  for (const b of Array.from(bucketMap.values())) {
    buckets.push({
      strike: b.strike,
      expiration: b.expiration,
      dateLabel: b.dateLabel,
      dteDays: b.dteDays,
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
        b.callOI > 0 ? b.callGammaWeighted / b.callOI : 0,
      putGamma:
        b.putOI > 0 ? b.putGammaWeighted / b.putOI : 0,
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
    sigma1Move,
    sigma2Move,
    strikeStep,
    has0DteActive: hasZeroDte,
    expirations,
    buckets,
  };
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const rawTicker = (searchParams.get("ticker") ?? "SPY").trim().toUpperCase();
  const requestedSession = (searchParams.get("session") ?? "").trim();

  const ticker = /^[A-Z0-9._-]{1,10}$/.test(rawTicker) ? rawTicker : "SPY";
  const yahooSymbol = mapYahooSymbol(ticker);

  try {
    // Fetch live multi-timeframe candle series from Yahoo Finance in parallel
    const [bars5mRaw, bars30mRaw, bars60mRaw, bars1dRaw, bars1wkRaw] =
      await Promise.all([
        fetchYahooSeries(yahooSymbol, "5m", "1mo"),
        fetchYahooSeries(yahooSymbol, "30m", "1mo"),
        fetchYahooSeries(yahooSymbol, "60m", "3mo"),
        fetchYahooSeries(yahooSymbol, "1d", "6mo"),
        fetchYahooSeries(yahooSymbol, "1wk", "2y"),
      ]);

    if (bars5mRaw.length === 0 || bars1dRaw.length === 0) {
      return NextResponse.json(
        { error: `No live market bars returned for ${ticker}` },
        { status: 502 }
      );
    }

    // Group 5m bars by ET trading session date
    const sessionDatesDesc = Array.from(
      new Set(bars5mRaw.map((b) => b.etDate))
    )
      .sort()
      .reverse()
      .slice(0, 10);

    const sessions: AntaeusSessionOption[] = sessionDatesDesc.map((iso) => ({
      isoDate: iso,
      bookLabel: formatBookLabel(iso),
    }));

    const activeSessionDate =
      requestedSession && sessionDatesDesc.includes(requestedSession)
        ? requestedSession
        : sessionDatesDesc[0];

    const activeSessionObj =
      sessions.find((s) => s.isoDate === activeSessionDate) ?? sessions[0];

    // Enrich 5m bars with Wilder RSI(14) and MACD(12,26,9) across the full continuous series
    const enriched5m = enrichBarsWithRsiAndMacd(bars5mRaw);

    // Locate indices belonging to activeSessionDate
    const sessionGlobalIndices: number[] = [];
    for (let i = 0; i < enriched5m.length; i++) {
      if (enriched5m[i].etDate === activeSessionDate) {
        sessionGlobalIndices.push(i);
      }
    }

    if (sessionGlobalIndices.length === 0) {
      return NextResponse.json(
        { error: `No 5m session bars found for ${ticker} on ${activeSessionDate}` },
        { status: 502 }
      );
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
    const candles: AntaeusIntradayCandle[] = sessionGlobalIndices.map(
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
    let pivotSignals5m: AntaeusPivotSignal[] = [];
    let mtfByBar: AntaeusMtfRow[] = candles.map(() => ({
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

    // Fetch live options chain book from CBOE
    const lastSessionClose = candles[candles.length - 1].close;
    const liveBook = await fetchLiveOptionsBuckets(
      ticker,
      lastSessionClose,
      priorClose,
      sessionDatesDesc[0]
    );

    const payload: AntaeusLivePayload = {
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
    };

    return NextResponse.json(payload);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Live market feed error";
    return NextResponse.json(
      { error: `Live Antaeus feed unavailable for ${ticker}: ${message}` },
      { status: 502 }
    );
  }
}
