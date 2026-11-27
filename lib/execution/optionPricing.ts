import {
  CachedRawChainEntry,
  NormalizedOptionContract,
  OptionContractQuoteSource,
  computeBlackScholesGreeks,
  globalContractsCache,
  resolveTradierAccessToken,
} from "@/lib/optionsExposure";
import {
  computeCanonicalPdeSeries,
  StructuralFlowNodes,
} from "@/lib/flowGammaVwap";
import { getTodayEt, getSessionBoundsEt } from "@/lib/gaiaSessionGuards";
import { fetchLiveTickQuote } from "@/lib/liveTick";
import { fetchCboeDelayedChain } from "@/lib/cboeClient";
import { isMarketOpen } from "@/lib/marketDataService";
import { computeLocalMtfDivergence } from "@/lib/divergenceDetector";
import {
  Candle5m,
  DivergenceDirection,
  MAX_ENGINE_CACHE_ENTRIES,
  SkewBlackScholesInput,
  SkewBlackScholesQuote,
  createLinkedTimeoutSignal,
  setBoundedMapEntry,
} from "@/lib/execution/types";

export { getTodayEt };

/**
 * Inverts Black-Scholes to solve for exact contract Implied Volatility from market mid price.
 */
export function solveImpliedVol(
  midPrice: number,
  spot: number,
  strike: number,
  tYears: number,
  isCall: boolean,
  r = 0.045,
  q = 0.012
): number {
  if (midPrice <= 0 || spot <= 0 || strike <= 0) return 0.22;
  const effectiveT = Math.max(1 / (252 * 390), tYears);
  const discountedForwardIntrinsic = isCall
    ? Math.max(0, spot * Math.exp(-q * effectiveT) - strike * Math.exp(-r * effectiveT))
    : Math.max(0, strike * Math.exp(-r * effectiveT) - spot * Math.exp(-q * effectiveT));
  if (midPrice <= discountedForwardIntrinsic + 1e-4) return 0.04;

  let low = 0.02;
  let high = 4.0;
  let iv = 0.25;

  for (let i = 0; i < 28; i++) {
    iv = 0.5 * (low + high);
    const greeks = computeBlackScholesGreeks(spot, strike, effectiveT, iv, r, q);
    const price = isCall ? greeks.callPrice : greeks.putPrice;
    const diff = price - midPrice;
    if (Math.abs(diff) < 0.0001) break;
    if (diff > 0) {
      high = iv;
    } else {
      low = iv;
    }
  }
  return Number(iv.toFixed(6));
}

/**
 * Unrounded Black-Scholes valuation for exact differential quote shifts (zero cent-rounding drift).
 */
export function repriceOptionBSExact(
  spot: number,
  strike: number,
  tYears: number,
  iv: number,
  isCall: boolean,
  r = 0.045,
  q = 0.012
): number {
  const effectiveT = Math.max(1 / (252 * 390), tYears);
  const greeks = computeBlackScholesGreeks(spot, strike, effectiveT, Math.max(0.04, iv), r, q);
  return Math.max(0.001, isCall ? greeks.callPrice : greeks.putPrice);
}

/**
 * Reprices option contract under updated spot and fractional year T with Delta/Gamma/Theta dynamics.
 */
export function repriceOptionBS(
  spot: number,
  strike: number,
  tYears: number,
  iv: number,
  isCall: boolean,
  r = 0.045,
  q = 0.012
): number {
  const rawPrice = repriceOptionBSExact(spot, strike, tYears, iv, isCall, r, q);
  return Number(Math.max(0.01, rawPrice).toFixed(2));
}

const ET_ISO_DATE_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const ET_TIME_SHORT_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "numeric",
  minute: "2-digit",
});

const ET_HMS_PARTS_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  hourCycle: "h23",
});

export function formatEtIsoDate(d: Date): string {
  try {
    const parts = ET_ISO_DATE_FMT.formatToParts(d);
    let y = "";
    let m = "";
    let day = "";
    for (const p of parts) {
      if (p.type === "year") y = p.value;
      else if (p.type === "month") m = p.value;
      else if (p.type === "day") day = p.value;
    }
    if (y && m && day) return `${y}-${m}-${day}`;
  } catch {
    // Fallback below
  }
  return d.toISOString().slice(0, 10);
}

export function formatTimeEt(dateOrTs: Date | number): string {
  const d = typeof dateOrTs === "number" ? new Date(dateOrTs * 1000) : dateOrTs;
  try {
    return ET_TIME_SHORT_FMT.format(d);
  } catch {
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
}

const ET_NOW_PARTS_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  hourCycle: "h23",
});

export function getNowEtTime(date?: Date): { hours: number; minutes: number; totalMinutes: number } {
  const d = date ?? new Date();
  try {
    const parts = ET_NOW_PARTS_FMT.formatToParts(d);
    const hours = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
    const minutes = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
    if (Number.isFinite(hours) && Number.isFinite(minutes)) {
      return { hours, minutes, totalMinutes: hours * 60 + minutes };
    }
  } catch {
    // Fallback to local clock if Intl fails
  }
  const hours = d.getHours();
  const minutes = d.getMinutes();
  return { hours, minutes, totalMinutes: hours * 60 + minutes };
}

/**
 * Contract Mid-Price Helper
 */
export function getContractMidPrice(c: NormalizedOptionContract): number {
  if (c.bid && c.ask && c.bid > 0 && c.ask > 0) {
    return Number(((c.bid + c.ask) / 2).toFixed(2));
  }
  if (c.last && c.last > 0) {
    return Number(c.last.toFixed(2));
  }
  return 0;
}

function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function normCdf(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x) / Math.sqrt(2);
  const t = 1.0 / (1.0 + p * absX);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);
  return 0.5 * (1.0 + sign * y);
}

function computeBaseRemainingIntradayMins(timestampMs: number): {
  etDate: string;
  remainingIntradayMins: number;
} {
  const dt = new Date(timestampMs);
  const etDate = formatEtIsoDate(dt);
  const sessionBounds = getSessionBoundsEt(etDate);
  const parts = ET_HMS_PARTS_FMT.formatToParts(dt);
  let rawHour = 9;
  let minute = 30;
  let second = 0;
  for (const p of parts) {
    if (p.type === "hour") rawHour = Number(p.value);
    else if (p.type === "minute") minute = Number(p.value);
    else if (p.type === "second") second = Number(p.value);
  }
  const hour = (Number.isFinite(rawHour) ? rawHour : 9) % 24;
  const safeMin = Number.isFinite(minute) ? minute : 30;
  const safeSec = Number.isFinite(second) ? second : 0;
  const etMinutes = hour * 60 + safeMin + safeSec / 60;
  return {
    etDate,
    remainingIntradayMins: Math.max(1, sessionBounds.rthCloseMins - etMinutes),
  };
}

function remainingYearsFromBaseMins(remainingIntradayMins: number, dteSessions: number): number {
  const overnightEquivMins = 90; // Overnight theta variance weight
  const rthSessionMins = 390;
  const totalEffectiveMins =
    remainingIntradayMins + Math.max(0, dteSessions) * (overnightEquivMins + rthSessionMins);
  const tradingMinsPerYear = 252 * 390;
  return Math.max(1 / 525600, totalEffectiveMins / tradingMinsPerYear);
}

/**
 * Computes exact remaining time to expiration in years from bar.timestampMs
 * to either 0DTE session close (16:00 ET or 13:00 ET on early closes) or Next-Session close,
 * including fractional intraday trading minutes + overnight theta weight.
 */
export function computeRemainingYearsToExpiration(
  timestampMs: number,
  dteSessions: number = 1
): number {
  const { remainingIntradayMins } = computeBaseRemainingIntradayMins(timestampMs);
  return remainingYearsFromBaseMins(remainingIntradayMins, dteSessions);
}

/**
 * Dynamically estimates ATM Implied Volatility from intraday realized bar returns
 * scaled by the Variance Risk Premium (VRP).
 */
export function estimateDynamicAtmIv(
  bars: Array<{ close: number; high?: number; low?: number; timestamp?: number; timestampMs?: number }>,
  idx: number,
  baseIvFloor: number = 0.085,
  referenceChainIv?: number
): number {
  const hasChainIv =
    typeof referenceChainIv === "number" &&
    Number.isFinite(referenceChainIv) &&
    referenceChainIv > 0;
  const normalizedChainIv = hasChainIv
    ? (referenceChainIv > 4 ? referenceChainIv / 100 : referenceChainIv)
    : undefined;
  const validChainIv =
    typeof normalizedChainIv === "number" &&
    Number.isFinite(normalizedChainIv) &&
    normalizedChainIv >= 0.04 &&
    normalizedChainIv <= 2.50
      ? normalizedChainIv
      : undefined;

  const start = Math.max(1, idx - 20);
  const sqReturns: number[] = [];
  for (let i = start; i <= idx; i++) {
    const prevBar = bars[i - 1];
    const currBar = bars[i];
    const prevTsMs =
      typeof prevBar?.timestampMs === "number"
        ? prevBar.timestampMs
        : typeof prevBar?.timestamp === "number"
          ? (prevBar.timestamp > 1e11 ? prevBar.timestamp : prevBar.timestamp * 1000)
          : 0;
    const currTsMs =
      typeof currBar?.timestampMs === "number"
        ? currBar.timestampMs
        : typeof currBar?.timestamp === "number"
          ? (currBar.timestamp > 1e11 ? currBar.timestamp : currBar.timestamp * 1000)
          : 0;
    if (prevTsMs > 0 && currTsMs > prevTsMs && currTsMs - prevTsMs > 15 * 60 * 1000) {
      continue;
    }
    const prev = prevBar?.close || 0;
    const curr = currBar?.close || 0;
    if (prev > 0 && curr > 0) {
      const r = Math.log(curr / prev);
      sqReturns.push(r * r);
    }
  }
  if (sqReturns.length < 2) {
    return Math.max(baseIvFloor, Math.min(0.85, validChainIv ?? 0.095));
  }
  sqReturns.sort((a, b) => a - b);
  const capIdx = Math.min(sqReturns.length - 1, Math.floor(sqReturns.length * 0.85));
  const capVal = sqReturns[capIdx];
  const trimmedMean = sqReturns.reduce((acc, v) => acc + Math.min(v, capVal), 0) / sqReturns.length;
  const realizedAnnualVol = Math.sqrt(trimmedMean * 78 * 252);
  const anchorIv = validChainIv ?? (realizedAnnualVol > 0.22 ? realizedAnnualVol : 0.092);
  const vrpAdjusted =
    validChainIv !== undefined
      ? 0.35 * (realizedAnnualVol * 1.02) + 0.65 * validChainIv
      : (0.45 * realizedAnnualVol + 0.55 * anchorIv) * 1.02;
  return Math.max(baseIvFloor, Math.min(0.85, vrpAdjusted));
}

/**
 * Exact Black-Scholes option pricing with strike skew and bid-ask spread crossing:
 *   C(S, K, T, sigma) = S * e^(-qT) * N(d1) - K * e^(-rT) * N(d2)
 *   P(S, K, T, sigma) = K * e^(-rT) * N(-d2) - S * e^(-qT) * N(-d1)
 *   sigma(K) = sigma_ATM * (1 + beta * (K - S) / S + gamma * ((K - S) / S)^2)
 */
export function priceOptionWithSkew(input: SkewBlackScholesInput): SkewBlackScholesQuote {
  const S = Math.max(0.01, input.spot);
  const K = Math.max(0.01, input.strike);
  const T = Math.max(1 / 525600, input.remainingYears);
  const r = input.riskFreeRate ?? 0.045;
  const q = input.dividendYield ?? 0.012;
  const beta = input.skewSlope ?? -3.5; // Negative slope in (K - S)/S gives positive Put wing skew
  const smile = input.smileConvexity ?? 12.0;
  const halfSpreadPct = input.halfSpreadPct ?? 0.012;

  const moneyness = (K - S) / S;
  const skewFactor = 1 + beta * moneyness + smile * moneyness * moneyness;
  const sigma = Math.max(0.06, Math.min(2.5, input.atmIv * skewFactor));

  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;

  const discS = S * Math.exp(-q * T);
  const discK = K * Math.exp(-r * T);

  const isCall = input.direction === "LONG";
  const rawMid = isCall
    ? discS * normCdf(d1) - discK * normCdf(d2)
    : discK * normCdf(-d2) - discS * normCdf(-d1);

  const mid = Math.max(0.02, rawMid);
  const halfSpread = Math.max(0.01, Math.min(Math.max(0.12, mid * 0.025), mid * halfSpreadPct));

  const bid = Math.max(0.01, Math.round((mid - halfSpread) * 100) / 100);
  const ask = Math.max(bid + 0.01, Math.round((mid + halfSpread) * 100) / 100);

  const delta = isCall ? Math.exp(-q * T) * normCdf(d1) : -Math.exp(-q * T) * normCdf(-d1);
  const gamma = (Math.exp(-q * T) * normPdf(d1)) / (S * sigma * sqrtT);
  const thetaAnnual =
    -(discS * normPdf(d1) * sigma) / (2 * sqrtT) -
    (isCall
      ? r * discK * normCdf(d2) - q * discS * normCdf(d1)
      : -r * discK * normCdf(-d2) + q * discS * normCdf(-d1));

  return {
    mid: Math.round(mid * 100) / 100,
    bid,
    ask,
    iv: sigma,
    delta,
    gamma,
    thetaPerDay: thetaAnnual / 252,
  };
}

function diffIsoDays(expIso: string, todayIso: string): number {
  try {
    const [ey, em, ed] = expIso.split("-").map(Number);
    const [ty, tm, td] = todayIso.split("-").map(Number);
    const expDate = new Date(Date.UTC(ey, em - 1, ed, 16, 0, 0));
    const todayDate = new Date(Date.UTC(ty, tm - 1, td, 16, 0, 0));
    return Math.round((expDate.getTime() - todayDate.getTime()) / (1000 * 60 * 60 * 24));
  } catch {
    return 0;
  }
}

/**
 * Re-anchors delayed CBOE option chain quotes (`mid`, `bid`, `ask`, `delta`, `gamma`, `theta`)
 * onto fresh clones using a differential Black-Scholes shift:
 *   `bsDelta = BS(liveSpot, anchorIv, tNow) - BS(referenceSpot, anchorIv, tRef)`
 * where `anchorIv` is solved strictly from `(rawMid, referenceSpot, strike, tRef)` so
 * `BS(referenceSpot, anchorIv, tRef) === rawMid` within < $0.005 (never trusting unvalidated `raw.iv`).
 * Live Tradier quotes (`quoteSource === "TRADIER_LIVE"`) bypass re-anchoring cleanly.
 */
export function reanchorDelayedContractsToSpot(params: {
  contracts: ReadonlyArray<NormalizedOptionContract>;
  referenceSpot: number;
  liveSpot: number;
  nowMs?: number;
  fetchedAtMs?: number;
  fallbackIv?: number;
  forceReprice?: boolean;
}): NormalizedOptionContract[] {
  const {
    contracts,
    referenceSpot,
    liveSpot,
    nowMs = Date.now(),
    fetchedAtMs,
    fallbackIv = 0.22,
    forceReprice = false,
  } = params;
  if (!Array.isArray(contracts) || contracts.length === 0 || !Number.isFinite(liveSpot) || liveSpot <= 0) {
    return Array.isArray(contracts) ? contracts.map((c) => ({ ...c })) : [];
  }

  const refTimeMs =
    typeof fetchedAtMs === "number" && Number.isFinite(fetchedAtMs) && fetchedAtMs > 0
      ? fetchedAtMs
      : nowMs;
  const nowBase = computeBaseRemainingIntradayMins(nowMs);
  const refBase = computeBaseRemainingIntradayMins(refTimeMs);
  const todayIso = nowBase.etDate;
  const refIso = refBase.etDate;
  const spotDelta = Number.isFinite(referenceSpot) && referenceSpot > 0 ? Math.abs(liveSpot - referenceSpot) : 0;
  const timeDeltaMs = Math.abs(nowMs - refTimeMs);
  const shouldShiftQuotes =
    forceReprice ||
    timeDeltaMs >= 15_000 ||
    (Number.isFinite(referenceSpot) && referenceSpot > 0 && spotDelta > Math.max(0.01, referenceSpot * 0.0001));

  const expMetaCache = new Map<string, { dteNow: number; tNow: number; tRef: number }>();
  const resolveExpMeta = (exp: string) => {
    const hit = expMetaCache.get(exp);
    if (hit) return hit;
    const isIso = typeof exp === "string" && /^\d{4}-\d{2}-\d{2}$/.test(exp);
    const dteNow = isIso ? diffIsoDays(exp, todayIso) : 0;
    const dteRef = isIso ? Math.max(0, diffIsoDays(exp, refIso)) : Math.max(0, dteNow);
    const meta = {
      dteNow,
      tNow: remainingYearsFromBaseMins(nowBase.remainingIntradayMins, Math.max(0, dteNow)),
      tRef: remainingYearsFromBaseMins(refBase.remainingIntradayMins, Math.max(0, dteRef)),
    };
    expMetaCache.set(exp, meta);
    return meta;
  };

  return contracts.map((c) => {
    if (!c || !Number.isFinite(c.strike) || c.strike <= 0) return { ...c };
    if (c.quoteSource === "TRADIER_LIVE") {
      return { ...c, quoteSource: "TRADIER_LIVE" };
    }
    const isCall = c.optionType === "C";
    const { dteNow, tNow, tRef } = resolveExpMeta(c.expiration);
    if (dteNow < 0) return { ...c, quoteSource: c.quoteSource ?? "DELAYED_CBOE" };
    const rawBid = typeof c.bid === "number" && Number.isFinite(c.bid) && c.bid > 0 ? c.bid : 0;
    const rawAsk = typeof c.ask === "number" && Number.isFinite(c.ask) && c.ask > 0 ? c.ask : 0;
    const rawMid = getContractMidPrice(c);

    const rawIv =
      typeof c.iv === "number" && Number.isFinite(c.iv) && c.iv > 0
        ? c.iv > 4
          ? c.iv / 100
          : c.iv
        : 0;
    const quoteSource: OptionContractQuoteSource = c.quoteSource ?? "DELAYED_CBOE";
    // Far-dated LEAPS (> 45 DTE) or deep far-wing strikes (> 18% from spot) skip 28-step bisection
    const isFarWing =
      referenceSpot > 0 && Math.abs(c.strike - referenceSpot) > referenceSpot * 0.18;
    if (dteNow > 45 || isFarWing) {
      const leapsIv = rawIv >= 0.04 && rawIv <= 1.8 ? rawIv : fallbackIv;
      return {
        ...c,
        iv: Number(leapsIv.toFixed(4)),
        quoteSource,
      };
    }

    const anchorIv =
      rawMid > 0 && referenceSpot > 0
        ? solveImpliedVol(rawMid, referenceSpot, c.strike, tRef, isCall)
        : rawIv >= 0.04 && rawIv <= 1.8
          ? rawIv
          : fallbackIv;
    const contractIv = Math.max(0.04, Math.min(3.5, anchorIv));

    const liveGreeks = computeBlackScholesGreeks(liveSpot, c.strike, tNow, contractIv);
    const liveDelta = isCall ? liveGreeks.deltaCall : liveGreeks.deltaPut;
    const bsNowExact = repriceOptionBSExact(liveSpot, c.strike, tNow, contractIv, isCall);
    const bsNextDay = repriceOptionBSExact(
      liveSpot,
      c.strike,
      Math.max(1 / (252 * 390), tNow - 1 / 252),
      contractIv,
      isCall
    );
    const liveTheta = Math.min(0, bsNextDay - bsNowExact);
    const existingTheta = typeof c.theta === "number" && Number.isFinite(c.theta) ? c.theta : undefined;

    if (!shouldShiftQuotes || !(referenceSpot > 0) || !(rawMid > 0)) {
      return {
        ...c,
        iv: Number(contractIv.toFixed(4)),
        delta: Number(liveDelta.toFixed(4)),
        gamma: Number(liveGreeks.gamma.toFixed(5)),
        theta: existingTheta ?? Number(liveTheta.toFixed(4)),
        quoteSource,
      };
    }

    const bsRef = repriceOptionBSExact(referenceSpot, c.strike, tRef, contractIv, isCall);
    const bsDelta = bsNowExact - bsRef;

    const shiftedMid = Number(Math.max(0.01, rawMid + bsDelta).toFixed(2));
    const shiftedBid =
      rawBid > 0
        ? Number(Math.max(0.01, rawBid + bsDelta).toFixed(2))
        : 0;
    const shiftedAsk =
      rawAsk > 0
        ? Number(
            Math.max(
              shiftedBid > 0 ? shiftedBid + (rawAsk > rawBid ? 0.01 : 0) : 0.01,
              rawAsk + bsDelta
            ).toFixed(2)
          )
        : 0;

    return {
      ...c,
      bid: shiftedBid,
      ask: shiftedAsk,
      last: shiftedMid,
      delta: Number(liveDelta.toFixed(4)),
      gamma: Number(liveGreeks.gamma.toFixed(5)),
      iv: Number(contractIv.toFixed(4)),
      theta: Number(liveTheta.toFixed(4)),
      quoteSource,
    };
  });
}

const derivedShiftMemo = new WeakMap<
  CachedRawChainEntry,
  {
    liveSpot: number;
    bucketMs: number;
    fallbackIv: number;
    shifted: ReadonlyArray<NormalizedOptionContract>;
  }
>();

/**
 * Materializes fresh option contract clones from an immutable `CachedRawChainEntry`.
 * - `TRADIER_LIVE`: returns fresh clones without re-anchoring.
 * - `DELAYED_CBOE`: applies single-pass differential BS shift from `(referenceSpot, fetchedAtMs)` to `(liveSpot, nowMs)`.
 */
export function resolveContractsFromRawCacheEntry(
  entry: CachedRawChainEntry | undefined | null,
  liveSpot: number,
  nowMs = Date.now(),
  fallbackIv = 0.22
): NormalizedOptionContract[] {
  if (!entry || !Array.isArray(entry.rawContracts) || entry.rawContracts.length === 0) {
    return [];
  }
  if (entry.quoteSource === "TRADIER_LIVE") {
    return entry.rawContracts.map((c) => ({ ...c, quoteSource: "TRADIER_LIVE" }));
  }
  const effectiveLiveSpot =
    Number.isFinite(liveSpot) && liveSpot > 0
      ? liveSpot
      : entry.referenceSpot;
  const bucketMs = Math.floor(nowMs / 5000);
  const memo = derivedShiftMemo.get(entry);
  if (
    memo &&
    memo.bucketMs === bucketMs &&
    memo.fallbackIv === fallbackIv &&
    Math.abs(memo.liveSpot - effectiveLiveSpot) < 0.005
  ) {
    return memo.shifted.map((c) => ({ ...c }));
  }
  const shifted = reanchorDelayedContractsToSpot({
    contracts: entry.rawContracts,
    referenceSpot: entry.referenceSpot,
    liveSpot: effectiveLiveSpot,
    fetchedAtMs: entry.fetchedAtMs,
    nowMs,
    fallbackIv,
  });
  derivedShiftMemo.set(entry, {
    liveSpot: effectiveLiveSpot,
    bucketMs,
    fallbackIv,
    shifted,
  });
  return shifted.map((c) => ({ ...c }));
}

export interface GreekEnvelopeOptions {
  strike?: number;
  tEntryYears?: number;
  tRemainingYears?: number;
  /**
   * When false (mandatory on matched `LIVE_CHAIN_BID` and `DELAYED_CBOE_BID` quotes),
   * `clampOptionPriceToGreekEnvelope` acts strictly as an upper outlier ceiling (`<= rawCurrentOptionPrice`)
   * and NEVER inflates `exitFillPrice` above `rawCurrentOptionPrice`.
   */
  allowFloor?: boolean;
}

/**
 * Physical Greek Envelope Clamp:
 * Prevents noisy delayed CBOE quotes or wide bid-ask jumps from violating options microstructure physics.
 * 1. Adverse spot excursion (dirSpotMove <= -0.02) MUST NEVER produce an option price above entry.
 * 2. Positive spot excursion is bounded by strike-accurate Black-Scholes (or delta + gamma convexity).
 * 3. When `options.allowFloor === false` (matched chain bid), NEVER raises `rawCurrentOptionPrice` upward.
 */
export function clampOptionPriceToGreekEnvelope(
  entrySpot: number,
  currentSpot: number,
  entryOptionPrice: number,
  rawCurrentOptionPrice: number,
  isCall: boolean,
  elapsedMinutes = 5,
  options?: GreekEnvelopeOptions
): number {
  const baseEntry = Math.max(0.05, entryOptionPrice);
  const rawPrice = Math.max(0.01, rawCurrentOptionPrice);
  const allowFloor = options?.allowFloor ?? true;
  const dirSpotMove = (currentSpot - entrySpot) * (isCall ? 1 : -1);
  const minMoveEps = Math.max(0.02, Math.max(1, entrySpot) * 0.00003);

  if (
    options?.strike &&
    Number.isFinite(options.strike) &&
    options.strike > 0 &&
    entrySpot > 0 &&
    currentSpot > 0
  ) {
    const defaultEntryYears = Math.max(1 / (252 * 390), 3.5 / (252 * 6.5));
    const tEntry =
      typeof options.tEntryYears === "number" && options.tEntryYears > 0
        ? options.tEntryYears
        : defaultEntryYears;
    const elapsedYears = Math.max(0, elapsedMinutes) / (252 * 390);
    const tRem =
      typeof options.tRemainingYears === "number" && options.tRemainingYears > 0
        ? options.tRemainingYears
        : Math.max(1 / (252 * 390), tEntry - elapsedYears);
    const entryIv = solveImpliedVol(baseEntry, entrySpot, options.strike, tEntry, isCall);

    if (dirSpotMove <= -minMoveEps) {
      const bsAdverse = repriceOptionBSExact(currentSpot, options.strike, tRem, entryIv, isCall);
      const upperAdverseCap = Math.max(0.01, Math.min(baseEntry - 0.01, bsAdverse + 0.02));
      if (!allowFloor) {
        return Number(Math.max(0.01, Math.min(rawPrice, upperAdverseCap)).toFixed(2));
      }
      const lowerAdverseFloor = Math.max(0.01, bsAdverse * 0.7 - 0.03);
      return Number(Math.max(lowerAdverseFloor, Math.min(upperAdverseCap, rawPrice)).toFixed(2));
    }

    const maxPlausibleIv = Math.min(3.5, entryIv * (isCall ? 1.05 : 1.12));
    const bsUpper = repriceOptionBSExact(currentSpot, options.strike, tRem, maxPlausibleIv, isCall);
    const upperFavorableCap =
      dirSpotMove >= 0 ? Math.max(baseEntry, bsUpper + 0.02) : baseEntry + 0.01;
    if (!allowFloor) {
      return Number(Math.max(0.01, Math.min(rawPrice, upperFavorableCap)).toFixed(2));
    }
    const bsLower = repriceOptionBSExact(
      currentSpot,
      options.strike,
      tRem,
      Math.max(0.04, entryIv * 0.85),
      isCall
    );
    const lowerFloor = Math.max(0.01, bsLower - 0.03);
    return Number(Math.max(lowerFloor, Math.min(upperFavorableCap, rawPrice)).toFixed(2));
  }

  const effectiveDelta = Math.min(0.8, Math.max(0.25, baseEntry / 1.8));
  const minDelta = Math.min(0.2, effectiveDelta * 0.45);
  const maxThetaAllowance = Math.min(
    baseEntry * 0.65,
    Math.max(baseEntry * 0.15, Math.max(0, elapsedMinutes) * 0.0045)
  );
  const thetaDecay = Math.min(maxThetaAllowance, Math.max(0, elapsedMinutes) * 0.0045);
  const gammaScale = 750 / Math.max(1, entrySpot);

  if (dirSpotMove <= -minMoveEps) {
    const maxLossDelta = Math.max(
      -0.95 * baseEntry,
      effectiveDelta * dirSpotMove - thetaDecay - 0.04
    );
    const minLossDelta = Math.min(-0.01, minDelta * dirSpotMove);
    const upperAdverse = Math.max(0.01, baseEntry + minLossDelta);
    if (!allowFloor) {
      return Number(Math.max(0.01, Math.min(rawPrice, upperAdverse)).toFixed(2));
    }
    const clampedDelta = Math.max(
      maxLossDelta,
      Math.min(minLossDelta, rawPrice - baseEntry)
    );
    return Number(Math.max(0.05, baseEntry + clampedDelta).toFixed(2));
  }

  const posMove = Math.max(0, dirSpotMove);
  const maxGainDelta =
    effectiveDelta * posMove + 0.06 * gammaScale * posMove * posMove + 0.02;
  const upperFavorable = Math.max(0.01, baseEntry + maxGainDelta);
  if (!allowFloor) {
    return Number(Math.max(0.01, Math.min(rawPrice, upperFavorable)).toFixed(2));
  }
  const minGainDelta = Math.max(
    -Math.max(0.08 * baseEntry, thetaDecay),
    minDelta * dirSpotMove - thetaDecay
  );
  const rawDeltaV = rawPrice - baseEntry;
  const clampedDelta = Math.max(minGainDelta, Math.min(maxGainDelta, rawDeltaV));
  return Number(Math.max(0.05, baseEntry + clampedDelta).toFixed(2));
}

export function clampToCandleRange(price: number, candle?: { low?: number; high?: number } | null): number {
  if (!candle || typeof candle.low !== "number" || typeof candle.high !== "number" || candle.low <= 0 || candle.high <= 0) {
    return price;
  }
  return Number(Math.max(candle.low, Math.min(candle.high, price)).toFixed(2));
}

/**
 * Immutable raw cache for CBOE delayed options chain (10s TTL) and live underlying spot prices.
 * Stores raw CBOE snapshots and shifts onto fresh clones per call (zero double-shift, zero frozen quotes).
 */
const cboeChainCache = new Map<string, CachedRawChainEntry>();
const cboeFailureCooldownUntil = new Map<string, number>();
const spotPriceCache = new Map<string, number>();
const CBOE_CACHE_TTL_MS = 10_000;
const CBOE_FAILURE_BACKOFF_MS = 3_000;

export function getCachedSpotPrice(ticker: string): number | null {
  const sym = ticker.trim().toUpperCase();
  const cboeSymbol =
    sym === "SPX" || sym === "SPXW" ? "_SPX" : sym === "NDX" || sym === "NDXP" ? "_NDX" : sym;
  return spotPriceCache.get(cboeSymbol) ?? spotPriceCache.get(sym) ?? null;
}

export async function fetchLiveCboeOptions(
  ticker: string,
  signal?: AbortSignal
): Promise<NormalizedOptionContract[]> {
  const sym = ticker.trim().toUpperCase();
  if (signal?.aborted) return [];
  const cboeSymbol =
    sym === "SPX" || sym === "SPXW" ? "_SPX" : sym === "NDX" || sym === "NDXP" ? "_NDX" : sym;
  const tickSym =
    sym === "SPX" || sym === "SPXW"
      ? "SPX"
      : sym === "NDX" || sym === "NDXP"
        ? "NDX"
        : sym;

  const globalCached = globalContractsCache.get(sym);
  if (
    globalCached &&
    globalCached.quoteSource === "TRADIER_LIVE" &&
    Date.now() - globalCached.fetchedAtMs < CBOE_CACHE_TTL_MS
  ) {
    if (globalCached.referenceSpot > 0) {
      setBoundedMapEntry(spotPriceCache, cboeSymbol, globalCached.referenceSpot);
    }
    return resolveContractsFromRawCacheEntry(globalCached, globalCached.referenceSpot, Date.now());
  }

  const tradierToken = resolveTradierAccessToken();
  if (tradierToken) {
    try {
      const headers = {
        Authorization: `Bearer ${tradierToken}`,
        Accept: "application/json",
      };
      const [quoteRes, expRes] = await Promise.all([
        fetch(`https://api.tradier.com/v1/markets/quotes?symbols=${encodeURIComponent(tickSym)}`, {
          headers,
          cache: "no-store",
          signal: signal ?? AbortSignal.timeout(5000),
        }),
        fetch(
          `https://api.tradier.com/v1/markets/options/expirations?symbol=${encodeURIComponent(sym)}&includeAllRoots=true`,
          {
            headers,
            cache: "no-store",
            signal: signal ?? AbortSignal.timeout(5000),
          }
        ),
      ]);
      if (quoteRes.ok && expRes.ok) {
        const quoteJson = await quoteRes.json();
        const expJson = await expRes.json();
        const quoteObj = quoteJson?.quotes?.quote;
        const tSpot = Number(quoteObj?.last ?? quoteObj?.bid ?? 0);
        const rawDates: string[] = (expJson?.expirations?.date ?? []).slice(0, 4);
        if (tSpot > 0 && rawDates.length > 0) {
          const chainResponses = await Promise.all(
            rawDates.map((exp) =>
              fetch(
                `https://api.tradier.com/v1/markets/options/chains?symbol=${encodeURIComponent(sym)}&expiration=${exp}&greeks=true`,
                {
                  headers,
                  cache: "no-store",
                  signal: signal ?? AbortSignal.timeout(5000),
                }
              ).then((r) => (r.ok ? r.json() : null))
            )
          );
          const tradierContracts: NormalizedOptionContract[] = [];
          for (const chainJson of chainResponses) {
            const list = chainJson?.options?.option;
            if (!Array.isArray(list)) continue;
            for (const item of list) {
              const strike = Number(item.strike);
              const expiration = String(item.expiration_date ?? "");
              if (!strike || !expiration) continue;
              const iv = Number(item.greeks?.mid_iv ?? item.greeks?.smv_vol ?? 0);
              tradierContracts.push({
                symbol: String(item.symbol ?? ""),
                expiration,
                optionType: item.option_type === "call" ? "C" : "P",
                strike,
                openInterest: Number(item.open_interest ?? 0),
                volume: Number(item.volume ?? 0),
                iv: iv > 0 ? iv : 0.18,
                delta: Number(item.greeks?.delta ?? 0),
                gamma: Number(item.greeks?.gamma ?? 0),
                vega: Number(item.greeks?.vega ?? 0),
                theta: typeof item.greeks?.theta === "number" ? Number(item.greeks.theta) : undefined,
                percentChange: Number(item.change_percentage ?? 0),
                bid: Number(item.bid ?? 0),
                ask: Number(item.ask ?? 0),
                last: Number(item.last ?? 0),
                quoteSource: "TRADIER_LIVE",
              });
            }
          }
          if (tradierContracts.length > 0) {
            const fetchedAtMs = Date.now();
            setBoundedMapEntry(spotPriceCache, cboeSymbol, tSpot);
            setBoundedMapEntry(spotPriceCache, sym, tSpot);
            const tEntry: CachedRawChainEntry = {
              rawContracts: tradierContracts,
              referenceSpot: tSpot,
              fetchedAtMs,
              quoteSource: "TRADIER_LIVE",
            };
            setBoundedMapEntry(globalContractsCache, sym, tEntry);
            return resolveContractsFromRawCacheEntry(tEntry, tSpot, fetchedAtMs);
          }
        }
      }
    } catch {
      // Fall through cleanly to Tier-2 CBOE delayed chain
    }
  }

  const cached = cboeChainCache.get(cboeSymbol);
  if (cached && Date.now() - cached.fetchedAtMs < CBOE_CACHE_TTL_MS) {
    const latestSpot = getCachedSpotPrice(cboeSymbol) || cached.referenceSpot;
    return resolveContractsFromRawCacheEntry(cached, latestSpot, Date.now());
  }

  const fallbackFromCached = () =>
    cached
      ? resolveContractsFromRawCacheEntry(
          cached,
          getCachedSpotPrice(cboeSymbol) ?? cached.referenceSpot,
          Date.now()
        )
      : [];

  const cooldownUntil = cboeFailureCooldownUntil.get(cboeSymbol) ?? 0;
  if (Date.now() < cooldownUntil) {
    return fallbackFromCached();
  }

  const linkedTimeout = createLinkedTimeoutSignal(signal, 7500);
  try {
    const cboeResult = await fetchCboeDelayedChain(cboeSymbol, {
      signal: linkedTimeout.signal,
      allowStaleFallback: true,
    });
    const data = cboeResult.data;
    const fetchedAtMs = cboeResult.fetchedAtMs;

    const marketOpenNow = isMarketOpen().open;
    const cboeClose = Number(data.close ?? data.current_price ?? 0);
    const cboeSpot = marketOpenNow
      ? Number(data.current_price ?? data.close ?? 0)
      : cboeClose;

    const liveQuote = marketOpenNow
      ? await fetchLiveTickQuote(tickSym).catch(() => null)
      : null;
    if (signal?.aborted) return fallbackFromCached();

    const effectiveSpot =
      marketOpenNow && liveQuote && liveQuote.spot > 0 ? liveQuote.spot : cboeSpot;
    if (effectiveSpot > 0) {
      setBoundedMapEntry(spotPriceCache, cboeSymbol, effectiveSpot);
      if (cboeSymbol === "_SPX") {
        setBoundedMapEntry(spotPriceCache, "SPX", effectiveSpot);
        setBoundedMapEntry(spotPriceCache, "SPXW", effectiveSpot);
      } else if (cboeSymbol === "_NDX") {
        setBoundedMapEntry(spotPriceCache, "NDX", effectiveSpot);
        setBoundedMapEntry(spotPriceCache, "NDXP", effectiveSpot);
      }
    }

    const rawOptions = data.options;
    if (!Array.isArray(rawOptions)) return fallbackFromCached();

    const rawContracts: NormalizedOptionContract[] = [];
    for (const raw of rawOptions) {
      const occ = String(raw.option ?? "");
      const match = occ.match(/^([A-Z0-9_]+?)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
      if (!match) continue;

      const [, occRoot, yy, mm, dd, typeChar, strikeRaw] = match;
      if (/\d/.test(occRoot)) continue;
      const expiration = `20${yy}-${mm}-${dd}`;
      const strike = parseInt(strikeRaw, 10) / 1000;
      if (!Number.isFinite(strike) || strike <= 0) continue;

      const openInterest = Number(raw.open_interest ?? 0);
      const volume = Number(raw.volume ?? 0);
      const bid = Number(raw.bid ?? 0);
      const ask = Number(raw.ask ?? 0);
      const last = Number(raw.last_trade_price ?? 0);

      if (bid <= 0 && ask <= 0 && last <= 0 && openInterest <= 0 && volume <= 0) continue;

      rawContracts.push({
        symbol: occ,
        expiration,
        optionType: typeChar as "C" | "P",
        strike,
        openInterest,
        volume,
        iv: Number(raw.iv ?? 0),
        delta: Number(raw.delta ?? 0),
        gamma: Number(raw.gamma ?? 0),
        vega: Number(raw.vega ?? 0),
        theta: typeof raw.theta === "number" ? raw.theta : undefined,
        percentChange: Number(raw.percent_change ?? 0),
        bid,
        ask,
        last,
        quoteSource: "DELAYED_CBOE",
      });
    }

    const rawEntry: CachedRawChainEntry = {
      rawContracts,
      referenceSpot: cboeSpot,
      fetchedAtMs,
      quoteSource: "DELAYED_CBOE",
    };
    if (rawContracts.length > 0 && cboeSpot > 0) {
      setBoundedMapEntry(cboeChainCache, cboeSymbol, rawEntry);
      setBoundedMapEntry(globalContractsCache, sym, rawEntry);
      if (cboeSymbol === "_SPX") {
        setBoundedMapEntry(globalContractsCache, "SPX", rawEntry);
        setBoundedMapEntry(globalContractsCache, "SPXW", rawEntry);
      } else if (cboeSymbol === "_NDX") {
        setBoundedMapEntry(globalContractsCache, "NDX", rawEntry);
        setBoundedMapEntry(globalContractsCache, "NDXP", rawEntry);
      }
    }

    cboeFailureCooldownUntil.delete(cboeSymbol);
    return effectiveSpot > 0
      ? resolveContractsFromRawCacheEntry(rawEntry, effectiveSpot, Date.now())
      : rawContracts.map((c) => ({ ...c }));
  } catch {
    setBoundedMapEntry(cboeFailureCooldownUntil, cboeSymbol, Date.now() + CBOE_FAILURE_BACKOFF_MS);
    return fallbackFromCached();
  } finally {
    linkedTimeout.cleanup();
  }
}

interface CandleCacheEntry {
  ts: number;
  candle: Candle5m;
  divergence5m: DivergenceDirection;
  divergence30m: DivergenceDirection;
  hasStructuralNodes?: boolean;
}
const candleCache = new Map<string, CandleCacheEntry>();

export async function fetchLive5mCandleAndDivergence(
  ticker: string,
  signal?: AbortSignal,
  options?: {
    contracts?: NormalizedOptionContract[];
    structuralNodes?: StructuralFlowNodes;
  }
): Promise<{ candle: Candle5m | null; divergence5m: DivergenceDirection; divergence30m: DivergenceDirection }> {
  const sym = ticker.trim().toUpperCase();
  if (signal?.aborted) {
    return { candle: null, divergence5m: "NO", divergence30m: "NO" };
  }
  const wantsStructural = Boolean(
    options?.structuralNodes || (options?.contracts && options.contracts.length > 0)
  );
  const cached = candleCache.get(sym);
  if (cached && Date.now() - cached.ts < 20_000 && (!wantsStructural || cached.hasStructuralNodes)) {
    return {
      candle: cached.candle,
      divergence5m: cached.divergence5m,
      divergence30m: cached.divergence30m,
    };
  }

  let candle: Candle5m | null = null;
  let divergence5m: DivergenceDirection = "NO";
  let divergence30m: DivergenceDirection = "NO";

  const yahooSym = sym === "SPX" || sym === "SPXW" ? "^GSPC" : sym === "NDX" || sym === "NDXP" ? "^NDX" : sym;
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}?interval=5m&range=2d&includePrePost=true`,
      {
        headers: {
          Accept: "application/json",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) HyperionTerminal/1.0",
        },
        cache: "no-store",
        signal,
      }
    );
    if (res.ok) {
      const json = await res.json();
      const result = json?.chart?.result?.[0];
      const timestamps: number[] = result?.timestamp ?? [];
      const quote = result?.indicators?.quote?.[0];
      if (quote) {
        const opens: (number | null)[] = quote.open ?? [];
        const highs: (number | null)[] = quote.high ?? [];
        const lows: (number | null)[] = quote.low ?? [];
        const closes: (number | null)[] = quote.close ?? [];
        const volumes: (number | null)[] = quote.volume ?? [];

        const validBars: { timestamp: number; open: number; high: number; low: number; close: number; volume: number }[] = [];
        for (let i = 0; i < closes.length; i++) {
          const c = closes[i];
          const o = opens[i];
          const h = highs[i];
          const l = lows[i];
          const v = volumes[i] ?? 1000;
          const ts = timestamps[i] ?? Math.floor(Date.now() / 1000);
          if (
            typeof c === "number" &&
            typeof o === "number" &&
            typeof h === "number" &&
            typeof l === "number" &&
            c > 0
          ) {
            validBars.push({ timestamp: ts, open: o, high: h, low: l, close: c, volume: typeof v === "number" ? v : 1000 });
          }
        }

        // Strict causal bar hygiene: drop any currently forming 5m candle so BTO signals,
        // Flow VWAP, SMA34, and 5m/30m divergences evaluate exclusively on closed bars (zero mid-bar leakage).
        const nowSec = Math.floor(Date.now() / 1000);
        const closedBars =
          validBars.length >= 3 && nowSec < validBars[validBars.length - 1].timestamp + 300
            ? validBars.slice(0, -1)
            : validBars;

        if (closedBars.length >= 2) {
          const latest = closedBars[closedBars.length - 1];
          const prevClosedBar = closedBars[closedBars.length - 2];
          const latestEtDate = formatEtIsoDate(new Date(latest.timestamp * 1000));
          const latestBounds = getSessionBoundsEt(latestEtDate);
          const firstSessionRthBar = closedBars.find((b) => {
            const dt = new Date(b.timestamp * 1000);
            return (
              formatEtIsoDate(dt) === latestEtDate &&
              getNowEtTime(dt).totalMinutes >= latestBounds.rthOpenMins
            );
          });

          const startIdx = Math.max(0, closedBars.length - 34);
          let sum = 0;
          let count = 0;
          for (let k = startIdx; k < closedBars.length; k++) {
            sum += closedBars[k].close;
            count++;
          }
          const sma34 = Number((sum / Math.max(1, count)).toFixed(2));
          const flowSeries = computeCanonicalPdeSeries({
            candles: closedBars,
            contracts: options?.contracts,
            structuralNodes: options?.structuralNodes,
            windowLatestSession: true,
          });
          const flowSnapshot = flowSeries.length > 0 ? flowSeries[flowSeries.length - 1] : null;
          candle = {
            open: Number(latest.open.toFixed(2)),
            high: Number(latest.high.toFixed(2)),
            low: Number(latest.low.toFixed(2)),
            close: Number(latest.close.toFixed(2)),
            sma34,
            timestamp: latest.timestamp,
            prevLow: Number(prevClosedBar.low.toFixed(2)),
            prevHigh: Number(prevClosedBar.high.toFixed(2)),
            sessionOpen:
              firstSessionRthBar && firstSessionRthBar.open > 0
                ? Number(firstSessionRthBar.open.toFixed(2))
                : undefined,
            flowSnapshot,
          };

          // Local non-repainting 3L/3R RSI+MACD divergence (zero terrashade.onrender.com dependency)
          const localDiv = computeLocalMtfDivergence(
            closedBars.map((b) => ({
              ts: b.timestamp,
              open: b.open,
              high: b.high,
              low: b.low,
              close: b.close,
              volume: b.volume,
            })),
            latest.timestamp
          );
          divergence5m = localDiv.divergence5m;
          divergence30m = localDiv.divergence30m;
        }
      }
    }
  } catch {
    // Non-fatal
  }

  if (signal?.aborted) {
    return { candle: null, divergence5m: "NO", divergence30m: "NO" };
  }

  if (candle) {
    setBoundedMapEntry(
      candleCache,
      sym,
      {
        ts: Date.now(),
        candle,
        divergence5m,
        divergence30m,
        hasStructuralNodes: wantsStructural,
      },
      MAX_ENGINE_CACHE_ENTRIES
    );
  }

  return { candle, divergence5m, divergence30m };
}
