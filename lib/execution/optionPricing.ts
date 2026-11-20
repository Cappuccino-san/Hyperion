import {
  NormalizedOptionContract,
  computeBlackScholesGreeks,
} from "@/lib/optionsExposure";
import {
  computeBarFlowGammaVwapSeries,
  StructuralFlowNodes,
} from "@/lib/flowGammaVwap";
import { getTodayEt, getSessionBoundsEt } from "@/lib/gaiaSessionGuards";
import { fetchLiveTickQuote } from "@/lib/liveTick";
import { isMarketOpen } from "@/lib/marketDataService";
import { computeLocalMtfDivergence } from "@/lib/divergenceDetector";
import {
  Candle5m,
  DivergenceDirection,
  MAX_ENGINE_CACHE_ENTRIES,
  SkewBlackScholesInput,
  SkewBlackScholesQuote,
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
  r = 0.0475,
  q = 0.0
): number {
  if (midPrice <= 0 || spot <= 0 || strike <= 0) return 0.22;
  const effectiveT = Math.max(1 / (252 * 390), tYears);
  const intrinsic = isCall ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
  if (midPrice <= intrinsic) return 0.08;

  let low = 0.02;
  let high = 3.5;
  let iv = 0.25;

  for (let i = 0; i < 22; i++) {
    iv = 0.5 * (low + high);
    const greeks = computeBlackScholesGreeks(spot, strike, effectiveT, iv, r, q);
    const price = isCall ? greeks.callPrice : greeks.putPrice;
    const diff = price - midPrice;
    if (Math.abs(diff) < 0.001) break;
    if (diff > 0) {
      high = iv;
    } else {
      low = iv;
    }
  }
  return Number(iv.toFixed(4));
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
  r = 0.0475,
  q = 0.0
): number {
  const effectiveT = Math.max(1 / (252 * 390), tYears); // 1-minute floor to prevent singularity
  const greeks = computeBlackScholesGreeks(spot, strike, effectiveT, Math.max(0.04, iv), r, q);
  const rawPrice = isCall ? greeks.callPrice : greeks.putPrice;
  return Number(Math.max(0.01, rawPrice).toFixed(2));
}

export function formatEtIsoDate(d: Date): string {
  try {
    return d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

export function formatTimeEt(dateOrTs: Date | number): string {
  const d = typeof dateOrTs === "number" ? new Date(dateOrTs * 1000) : dateOrTs;
  try {
    return d.toLocaleTimeString("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "2-digit",
    });
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

/**
 * Computes exact remaining time to expiration in years from bar.timestampMs
 * to either 0DTE session close (16:00 ET or 13:00 ET on early closes) or Next-Session close,
 * including fractional intraday trading minutes + overnight theta weight.
 */
export function computeRemainingYearsToExpiration(
  timestampMs: number,
  dteSessions: number = 1
): number {
  const dt = new Date(timestampMs);
  const etDate = formatEtIsoDate(dt);
  const sessionBounds = getSessionBoundsEt(etDate);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    hourCycle: "h23",
  });
  const parts = fmt.formatToParts(dt);
  const rawHour = Number(parts.find((p) => p.type === "hour")?.value ?? 9);
  const hour = rawHour % 24;
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 30);
  const second = Number(parts.find((p) => p.type === "second")?.value ?? 0);

  const etMinutes = hour * 60 + minute + second / 60;
  const remainingIntradayMins = Math.max(1, sessionBounds.rthCloseMins - etMinutes);
  const overnightEquivMins = 90; // Overnight theta variance weight
  const rthSessionMins = 390;

  const totalEffectiveMins =
    remainingIntradayMins + Math.max(0, dteSessions) * (overnightEquivMins + rthSessionMins);

  const tradingMinsPerYear = 252 * 390;
  return Math.max(1 / 525600, totalEffectiveMins / tradingMinsPerYear);
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
 * to sub-second live underlying `spotPrice` using each contract's solved or reported IV.
 */
export function reanchorDelayedContractsToSpot(params: {
  contracts: NormalizedOptionContract[];
  referenceSpot: number;
  liveSpot: number;
  nowMs?: number;
  fallbackIv?: number;
  forceReprice?: boolean;
}): NormalizedOptionContract[] {
  const {
    contracts,
    referenceSpot,
    liveSpot,
    nowMs = Date.now(),
    fallbackIv = 0.22,
    forceReprice = false,
  } = params;
  if (!Array.isArray(contracts) || contracts.length === 0 || !Number.isFinite(liveSpot) || liveSpot <= 0) {
    return contracts;
  }

  const todayIso = formatEtIsoDate(new Date(nowMs));
  const spotDelta = Number.isFinite(referenceSpot) && referenceSpot > 0 ? Math.abs(liveSpot - referenceSpot) : 0;
  const shouldShiftQuotes =
    forceReprice ||
    (Number.isFinite(referenceSpot) && referenceSpot > 0 && spotDelta > Math.max(0.01, referenceSpot * 0.0001));

  return contracts.map((c) => {
    if (!c || !Number.isFinite(c.strike) || c.strike <= 0) return c;
    const isCall = c.optionType === "C";
    const dte =
      typeof c.expiration === "string" && /^\d{4}-\d{2}-\d{2}$/.test(c.expiration)
        ? diffIsoDays(c.expiration, todayIso)
        : 0;
    if (dte < 0) return c;

    const remainingYears = computeRemainingYearsToExpiration(nowMs, Math.max(0, dte));
    const rawBid = typeof c.bid === "number" && Number.isFinite(c.bid) && c.bid > 0 ? c.bid : 0;
    const rawAsk = typeof c.ask === "number" && Number.isFinite(c.ask) && c.ask > 0 ? c.ask : 0;
    const rawMid = getContractMidPrice(c);

    const rawIv = typeof c.iv === "number" && Number.isFinite(c.iv) && c.iv > 0
      ? (c.iv > 4 ? c.iv / 100 : c.iv)
      : 0;
    const solvedIv =
      rawIv >= 0.04 && rawIv <= 2.5
        ? rawIv
        : rawMid > 0 && referenceSpot > 0
          ? solveImpliedVol(rawMid, referenceSpot, c.strike, remainingYears, isCall)
          : fallbackIv;
    const contractIv = Math.max(0.05, Math.min(2.5, solvedIv));

    const observedHalfSpreadPct =
      rawBid > 0 && rawAsk >= rawBid && rawMid > 0
        ? Math.max(0.005, Math.min(0.12, (rawAsk - rawBid) / (2 * rawMid)))
        : 0.02;

    const repriced = priceOptionWithSkew({
      spot: liveSpot,
      strike: c.strike,
      direction: isCall ? "LONG" : "SHORT",
      remainingYears,
      atmIv: contractIv,
      skewSlope: 0,
      smileConvexity: 0,
      halfSpreadPct: observedHalfSpreadPct,
    });

    const existingTheta = typeof c.theta === "number" && Number.isFinite(c.theta) ? c.theta : undefined;

    if (!shouldShiftQuotes) {
      return {
        ...c,
        iv: Number(contractIv.toFixed(4)),
        theta: existingTheta ?? repriced.thetaPerDay,
      };
    }

    return {
      ...c,
      bid: repriced.bid,
      ask: repriced.ask,
      last: repriced.mid,
      delta: Number(repriced.delta.toFixed(4)),
      gamma: Number(repriced.gamma.toFixed(5)),
      iv: Number(contractIv.toFixed(4)),
      theta: existingTheta ?? repriced.thetaPerDay,
    };
  });
}

/**
 * Physical Greek Envelope Clamp:
 * Prevents noisy delayed CBOE quotes or wide bid-ask jumps from violating options microstructure physics.
 * 1. Adverse spot excursion (dirSpotMove <= -0.02) MUST NEVER produce an option price above entry.
 * 2. Positive spot excursion is bounded by delta + gamma convexity.
 */
export function clampOptionPriceToGreekEnvelope(
  entrySpot: number,
  currentSpot: number,
  entryOptionPrice: number,
  rawCurrentOptionPrice: number,
  isCall: boolean,
  elapsedMinutes = 5
): number {
  const baseEntry = Math.max(0.05, entryOptionPrice);
  const dirSpotMove = (currentSpot - entrySpot) * (isCall ? 1 : -1);
  const effectiveDelta = Math.min(0.8, Math.max(0.25, baseEntry / 1.8));
  const minDelta = Math.min(0.2, effectiveDelta * 0.45);
  const maxThetaAllowance = Math.min(
    baseEntry * 0.65,
    Math.max(baseEntry * 0.15, Math.max(0, elapsedMinutes) * 0.0045)
  );
  const thetaDecay = Math.min(maxThetaAllowance, Math.max(0, elapsedMinutes) * 0.0045);
  const minMoveEps = Math.max(0.02, Math.max(1, entrySpot) * 0.00003);
  const gammaScale = 750 / Math.max(1, entrySpot);

  if (dirSpotMove <= -minMoveEps) {
    const maxLossDelta = Math.max(
      -0.95 * baseEntry,
      effectiveDelta * dirSpotMove - thetaDecay - 0.04
    );
    const minLossDelta = Math.min(-0.01, minDelta * dirSpotMove);
    const clampedDelta = Math.max(
      maxLossDelta,
      Math.min(minLossDelta, rawCurrentOptionPrice - baseEntry)
    );
    return Number(Math.max(0.05, baseEntry + clampedDelta).toFixed(2));
  }

  const posMove = Math.max(0, dirSpotMove);
  const maxGainDelta =
    effectiveDelta * posMove + 0.06 * gammaScale * posMove * posMove + 0.02;
  const minGainDelta = Math.max(
    -Math.max(0.08 * baseEntry, thetaDecay),
    minDelta * dirSpotMove - thetaDecay
  );
  const rawDeltaV = rawCurrentOptionPrice - baseEntry;
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
 * Cache for live CBOE delayed options chain (10s TTL) and live underlying spot prices
 */
const cboeChainCache = new Map<
  string,
  { ts: number; cboeSpot: number; effectiveSpot: number; contracts: NormalizedOptionContract[] }
>();
const spotPriceCache = new Map<string, number>();
const CBOE_CACHE_TTL_MS = 10_000;

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

  const cached = cboeChainCache.get(cboeSymbol);
  if (cached && Date.now() - cached.ts < CBOE_CACHE_TTL_MS) {
    return cached.contracts;
  }

  try {
    const res = await fetch(`https://cdn-api.cboe.com/api/global/delayed_quotes/options/${cboeSymbol}.json`, {
      headers: {
      Accept: "application/json, text/plain, */*",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      Referer: "https://www.cboe.com/",
      Origin: "https://www.cboe.com",
    },
      cache: "no-store",
      signal,
    });

    if (!res.ok) return cached?.contracts ?? [];
    const json = await res.json();
    const data = json?.data;
    if (!data) return cached?.contracts ?? [];

    const marketOpenNow = isMarketOpen().open;
    const cboeClose = Number(data.close ?? data.current_price ?? 0);
    const cboeSpot = marketOpenNow
      ? Number(data.current_price ?? data.close ?? 0)
      : cboeClose;
    const tickSym =
      sym === "SPX" || sym === "SPXW"
        ? "SPX"
        : sym === "NDX" || sym === "NDXP"
          ? "NDX"
          : sym;

    const liveQuote = marketOpenNow
      ? await fetchLiveTickQuote(tickSym).catch(() => null)
      : null;
    if (signal?.aborted) return cached?.contracts ?? [];

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
    if (!Array.isArray(rawOptions)) return cached?.contracts ?? [];

    const rawContracts: NormalizedOptionContract[] = [];
    for (const raw of rawOptions) {
      const occ = String(raw.option ?? "");
      const match = occ.match(/^([A-Z0-9_]+?)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
      if (!match) continue;

      const [, , yy, mm, dd, typeChar, strikeRaw] = match;
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
      });
    }

    const contracts =
      effectiveSpot > 0
        ? reanchorDelayedContractsToSpot({
            contracts: rawContracts,
            referenceSpot: cboeSpot,
            liveSpot: effectiveSpot,
          })
        : rawContracts;

    if (contracts.length > 0) {
      setBoundedMapEntry(cboeChainCache, cboeSymbol, {
        ts: Date.now(),
        cboeSpot,
        effectiveSpot,
        contracts,
      });
    }
    return contracts;
  } catch {
    return cached?.contracts ?? [];
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

          const startIdx = Math.max(0, closedBars.length - 34);
          let sum = 0;
          let count = 0;
          for (let k = startIdx; k < closedBars.length; k++) {
            sum += closedBars[k].close;
            count++;
          }
          const sma34 = Number((sum / Math.max(1, count)).toFixed(2));
          const sessionSlice = closedBars.slice(Math.max(0, closedBars.length - 78));
          const flowSeries = computeBarFlowGammaVwapSeries(
            sessionSlice,
            options?.contracts,
            options?.structuralNodes
          );
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
