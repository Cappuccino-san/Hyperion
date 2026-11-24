import {
  getTickerPreset,
  KingNodeMetrics,
  TickerSymbol,
  GammaLevels,
} from "@/lib/tickerPresets";
import { getSessionBoundsEt } from "@/lib/gaiaSessionGuards";
import { computeDealerFlowSummary } from "@/lib/dealerFlowMetrics";

export type DataSourceType = "TRADIER_LIVE" | "CBOE_MARKET_DATA" | "ROBINHOOD_LIVE";

export type OptionContractQuoteSource = "TRADIER_LIVE" | "DELAYED_CBOE";

export function resolveTradierAccessToken(
  env: Record<string, string | undefined> = process.env
): string {
  return (env.TRADIER_API_KEY || env.TRADIER_ACCESS_TOKEN || "").trim();
}

export function resolveOptionsQuoteProvider(
  env: Record<string, string | undefined> = process.env
): OptionContractQuoteSource {
  return resolveTradierAccessToken(env).length > 0 ? "TRADIER_LIVE" : "DELAYED_CBOE";
}

export interface NormalizedOptionContract {
  symbol: string;
  expiration: string; // YYYY-MM-DD
  optionType: "C" | "P";
  strike: number;
  openInterest: number;
  volume: number;
  iv: number; // decimal, e.g. 0.22
  delta: number;
  gamma: number;
  vega: number;
  theta?: number;
  percentChange: number;
  bid?: number;
  ask?: number;
  last?: number;
  quoteSource?: OptionContractQuoteSource;
}

export interface CachedRawChainEntry {
  rawContracts: ReadonlyArray<NormalizedOptionContract>;
  referenceSpot: number;
  fetchedAtMs: number;
  quoteSource: OptionContractQuoteSource;
}

const globalForOptionsExposure = globalThis as unknown as {
  __hyperionGlobalRawContractsCache?: Map<string, CachedRawChainEntry>;
};

export const globalContractsCache: Map<string, CachedRawChainEntry> =
  globalForOptionsExposure.__hyperionGlobalRawContractsCache ??
  (globalForOptionsExposure.__hyperionGlobalRawContractsCache = new Map<
    string,
    CachedRawChainEntry
  >());

export interface ExpirationColumnSpec {
  id: string;
  isoDate: string;
  tag: string;
  filterGroup: "0DTE" | "THIS_WEEK" | "OPEX";
  inThisWeek: boolean;
  dateLabel: string;
  dteDays: number;
}

export interface ComputedStrikeRow {
  strike: number;
  totalNetGex: number;
  totalAbsGex: number;
  totalCallGamma: number;
  totalPutGamma: number;
  kingPeakColId: string;
  gex: Record<string, number>;
  callGex?: Record<string, number>;
  putGex?: Record<string, number>;
  vex: Record<string, number>;
  dex: Record<string, number>;
  charm: Record<string, number>;
  openPctChange: Record<string, number>;
}

export interface ExpectedMoveHorizon {
  exp: string;
  em: number;
  pct: number;
  low: number;
  high: number;
  fixed?: boolean;
}

export interface ExpectedMovesPayload {
  daily: ExpectedMoveHorizon | null;
  weekly: ExpectedMoveHorizon | null;
  monthly: ExpectedMoveHorizon | null;
  annual: ExpectedMoveHorizon | null;
}

export interface ExtendedQuoteInfo {
  type: "pre" | "after";
  price: number;
  change: number;
  changePct: number;
}

export interface OptionsAnalyticsPayload {
  ticker: TickerSymbol;
  dataSource: DataSourceType;
  lastUpdated: string;
  bookTimestamp?: string;
  spotPrice: number;
  previousClose: number;
  impliedVolatility: number;
  strikeStep: number;
  extendedQuote?: ExtendedQuoteInfo | null;
  expectedMoves?: ExpectedMovesPayload;
  netMetrics: {
    netGex: number; // $B
    netVex: number; // $M
    netDex?: number; // $M
    netCharm?: number; // $M
  };
  gammaLevels: {
    callWall: number;
    callWallGex?: number; // $M
    putWall: number;
    putWallGex?: number; // $M (negative)
    zeroGamma: number;
    hasZeroGammaFlip?: boolean;
  };
  gammaLevelsByFilter?: Record<string, {
    callWall: number;
    callWallGex?: number;
    putWall: number;
    putWallGex?: number;
    zeroGamma: number;
    hasZeroGammaFlip?: boolean;
  }>;
  kingNode: KingNodeMetrics;
  kingByFilter: {
    ALL: { strike: number; label: string; exp?: string };
    "0DTE": { strike: number; label: string; exp?: string };
    THIS_WEEK: { strike: number; label: string; exp?: string };
    OPEX: { strike: number; label: string; exp?: string };
  };
  expirations: ExpirationColumnSpec[];
  strikes: ComputedStrikeRow[];
  intradayData?: Array<{
    time: string;
    spot: number;
    callWall: number;
    putWall: number;
    zeroGamma: number;
    t?: string;
    ts?: number;
    cw?: number;
    pw?: number;
    zg?: number;
  }>;
  alerts?: Array<{
    id: string;
    timestamp: string;
    time?: string;
    message: string;
    msg?: string;
    type: "call" | "put" | "zero" | "king" | "bto" | "stc";
  }>;
  isStale?: boolean;
  connectionStatus?: "LIVE" | "SYNCING" | "RECONNECTING" | "OFFLINE";
  cacheAgeSec?: number;
  cboeSpotPrice?: number;
  spotLagDollars?: number;
}

export const normPDF = (x: number): number =>
  Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

const normCDF = (x: number): number => {
  const a1 = 0.254829592,
    a2 = -0.284496736,
    a3 = 1.421413741,
    a4 = -1.453152027,
    a5 = 1.061405429,
    p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x) / Math.sqrt(2);
  const t = 1.0 / (1.0 + p * absX);
  const y =
    1.0 -
    ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);
  return 0.5 * (1.0 + sign * y);
};

/**
 * Shared helper to auto-scale exposure numbers in $B, $M, or $K
 */
export function formatExposure(
  valInMillions: number,
  options?: { includeSign?: boolean; showPlus?: boolean }
): string {
  const { includeSign = true, showPlus = true } = options ?? {};
  const absVal = Math.abs(valInMillions);
  const sign = valInMillions < 0 ? "-" : showPlus ? "+" : "";

  let numStr = "";
  if (absVal >= 1000) {
    numStr = `$${(absVal / 1000).toFixed(2)}B`;
  } else if (absVal >= 1) {
    numStr = `$${absVal.toFixed(1)}M`;
  } else {
    numStr = `$${(absVal * 1000).toFixed(0)}K`;
  }

  return includeSign ? `${sign}${numStr}` : numStr;
}

/**
 * Exact Black-Scholes Greeks & Theoretical Prices (Gamma, Vanna, Charm, Delta, Call/Put Price)
 * r = 0.0475, q = 0.0
 */
function resolveSafeIv(
  rawIv: number | null | undefined,
  fallbackIv = 0.25
): number {
  const safeFallback =
    Number.isFinite(fallbackIv) && fallbackIv > 0.02
      ? Math.max(0.02, Math.min(3.5, fallbackIv > 4 ? fallbackIv / 100 : fallbackIv))
      : 0.25;
  if (rawIv == null || !Number.isFinite(rawIv) || rawIv <= 0) {
    return safeFallback;
  }
  const normalized = rawIv > 4 ? rawIv / 100 : rawIv;
  if (!Number.isFinite(normalized) || normalized <= 0.02) {
    return safeFallback;
  }
  return Math.max(0.02, Math.min(3.5, normalized));
}

function isValidIsoDate(iso: string | null | undefined): iso is string {
  if (typeof iso !== "string") return false;
  const s = iso.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  return Number.isFinite(Date.parse(`${s}T12:00:00Z`));
}

function getEtClockParts(now: Date = new Date()): {
  nowEtIso: string;
  isWeekday: boolean;
  mins: number;
} {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = fmt.formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const year = get("year") || "1970";
  const month = get("month") || "01";
  const day = get("day") || "01";
  const weekday = get("weekday");
  const hour = Number(get("hour") || 0) % 24;
  const minute = Number(get("minute") || 0);
  return {
    nowEtIso: `${year}-${month}-${day}`,
    isWeekday: weekday !== "Sat" && weekday !== "Sun",
    mins: hour * 60 + minute,
  };
}

export function computeBlackScholesGreeks(
  S: number,
  K: number,
  T: number,
  sigma: number,
  r = 0.0475,
  q = 0.0
) {
  if (!Number.isFinite(S) || !Number.isFinite(K) || S <= 0 || K <= 0) {
    return {
      gamma: 0,
      vanna: 0,
      charmCall: 0,
      charmPut: 0,
      deltaCall: 0,
      deltaPut: 0,
      callPrice: 0,
      putPrice: 0,
    };
  }
  const safeR = Number.isFinite(r) ? r : 0.0475;
  const safeQ = Number.isFinite(q) ? q : 0.0;
  const finiteT = Number.isFinite(T) ? T : 5 / (252 * 390);
  const finiteSigma = Number.isFinite(sigma) && sigma > 0 ? sigma : 0.25;
  const effectiveT = Math.max(5 / (252 * 390), finiteT);
  const effectiveSigma = Math.max(0.02, Math.min(3.5, finiteSigma));
  const sqrtT = Math.sqrt(effectiveT);

  const d1 =
    (Math.log(Math.max(1e-4, S / K)) +
      (safeR - safeQ + 0.5 * effectiveSigma * effectiveSigma) * effectiveT) /
    (effectiveSigma * sqrtT);
  const d2 = d1 - effectiveSigma * sqrtT;

  const pdfD1 = normPDF(d1);
  const discountQ = Math.exp(-safeQ * effectiveT);
  const discountR = Math.exp(-safeR * effectiveT);

  const gamma = (discountQ * pdfD1) / (S * effectiveSigma * sqrtT);
  const vanna = -discountQ * pdfD1 * (d2 / effectiveSigma); // dDelta / dVol

  const charmCall =
    safeQ * discountQ * normCDF(d1) -
    discountQ *
      pdfD1 *
      ((2 * (safeR - safeQ) * effectiveT - d2 * effectiveSigma * sqrtT) /
        (2 * effectiveT * effectiveSigma * sqrtT));
  const charmPut = charmCall - safeQ * discountQ;

  const deltaCall = discountQ * normCDF(d1);
  const deltaPut = -discountQ * normCDF(-d1);

  const callPrice = Math.max(
    0,
    S * discountQ * normCDF(d1) - K * discountR * normCDF(d2)
  );
  const putPrice = Math.max(
    0,
    K * discountR * normCDF(-d2) - S * discountQ * normCDF(-d1)
  );

  return {
    gamma,
    vanna,
    charmCall,
    charmPut,
    deltaCall,
    deltaPut,
    callPrice,
    putPrice,
  };
}

/**
 * Parses OCC Option Symbol, e.g. "QQQ261016C00485000" or "SPXW261016P05850000"
 */
export function parseOccSymbol(occ: string): {
  root: string;
  expiration: string;
  optionType: "C" | "P";
  strike: number;
} | null {
  const cleaned = occ.trim().toUpperCase();
  const match = cleaned.match(/^([A-Z0-9_]+?)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
  if (!match) return null;

  const [, root, yy, mm, dd, typeChar, strikeRaw] = match;
  // Reject non-standard / corporate-action adjusted option roots (e.g., SPY1, SMCI1)
  if (/\d/.test(root)) return null;
  const expiration = `20${yy}-${mm}-${dd}`;
  const optionType = typeChar as "C" | "P";
  const strike = parseInt(strikeRaw, 10) / 1000;

  if (!Number.isFinite(strike) || strike <= 0) return null;
  return { root, expiration, optionType, strike };
}

export function getActiveExpirationSelection(allRawExpirations: string[]): {
  referenceDate: string;
  hasZeroDte: boolean;
  activeExpirations: string[];
} {
  const { nowEtIso, isWeekday, mins } = getEtClockParts();
  const sessionBounds = getSessionBoundsEt(nowEtIso);
  const sorted = Array.from(
    new Set(
      allRawExpirations
        .map((s) => s?.trim())
        .filter((s): s is string => isValidIsoDate(s))
    )
  ).sort();
  if (sorted.length === 0) {
    return {
      referenceDate: nowEtIso,
      hasZeroDte: false,
      activeExpirations: [],
    };
  }

  const isRegularSession =
    isWeekday &&
    sessionBounds.isTradingDay &&
    mins >= sessionBounds.rthOpenMins &&
    mins < sessionBounds.rthCloseMins;

  // Strict Expired-Contract Firewall: always purge exp < todayEt (and exp === todayEt post-close/weekend)
  if (isWeekday && sessionBounds.isTradingDay && mins < sessionBounds.rthCloseMins) {
    const active = sorted.filter((exp) => exp >= nowEtIso);
    return {
      referenceDate: nowEtIso,
      hasZeroDte: isRegularSession && active[0] === nowEtIso,
      activeExpirations: active,
    };
  }

  const postCloseActive = sorted.filter((exp) => exp > nowEtIso);
  return {
    referenceDate: nowEtIso,
    hasZeroDte: false,
    activeExpirations: postCloseActive,
  };
}

function getThisWeekIsoSet(allExpirations: string[]): Set<string> {
  if (allExpirations.length === 0) return new Set();
  const d0 = new Date(`${allExpirations[0]}T12:00:00Z`);
  const wd = d0.getUTCDay();
  const toFri = (5 - wd + 7) % 7;
  const fri = new Date(d0.getTime() + toFri * 86400000);
  const out = new Set<string>();
  for (const exp of allExpirations) {
    if (new Date(`${exp}T12:00:00Z`) <= fri) {
      out.add(exp);
    }
  }
  if (out.size === 0) out.add(allExpirations[0]);
  return out;
}

function formatExpirationColumn(
  isoDate: string,
  index: number,
  referenceDateStr: string,
  hasZeroDte: boolean,
  inThisWeek: boolean
): ExpirationColumnSpec {
  const refTime = new Date(`${referenceDateStr}T00:00:00Z`).getTime();
  const expTime = new Date(`${isoDate}T00:00:00Z`).getTime();
  const rawDiff =
    Number.isFinite(expTime) && Number.isFinite(refTime)
      ? Math.round((expTime - refTime) / (1000 * 60 * 60 * 24))
      : 0;
  const diffDays = Math.max(0, rawDiff);

  const dateObj = new Date(`${isoDate}T12:00:00Z`);
  const dayNum = dateObj.getUTCDate();
  const dayOfWeek = dateObj.getUTCDay(); // 5 = Friday
  const isThirdFriday = dayOfWeek === 5 && dayNum >= 15 && dayNum <= 21;
  const mmdd = isoDate.slice(5);

  let tag = "WKLY";
  let filterGroup: "0DTE" | "THIS_WEEK" | "OPEX" = "THIS_WEEK";

  if (diffDays === 0 && hasZeroDte) {
    tag = "0DTE";
    filterGroup = "0DTE";
  } else if (index === 0) {
    tag = diffDays <= 7 ? `${diffDays}D` : "NEXT";
    filterGroup = "0DTE";
  } else if (inThisWeek || diffDays <= 7) {
    tag = `${diffDays}D`;
    filterGroup = "THIS_WEEK";
  } else if (isThirdFriday || diffDays >= 25) {
    tag = "OPEX";
    filterGroup = "OPEX";
  } else {
    tag = "WKLY";
    filterGroup = "THIS_WEEK";
  }

  return {
    id: `exp_${index}`,
    isoDate,
    tag,
    filterGroup,
    inThisWeek,
    dateLabel: mmdd,
    dteDays: diffDays,
  };
}

/**
 * Canonical intraday Black-Scholes time-to-expiry T (in years).
 * Decays 0DTE intraday by remaining RTH minutes down to a 5-minute singularity floor,
 * ensuring 100% gamma parity across Heatmap, Gaia, and Option Pricer.
 */
export function computeIntradayExpiryYears(
  dteDays: number,
  todayEtIso?: string,
  currentEtMinutes?: number
): number {
  const safeDays = Number.isFinite(dteDays) ? Math.max(0, dteDays) : 0;
  if (safeDays <= 0) {
    const clock =
      todayEtIso !== undefined && currentEtMinutes !== undefined
        ? { nowEtIso: todayEtIso, mins: currentEtMinutes }
        : getEtClockParts();
    const { rthCloseMins } = getSessionBoundsEt(clock.nowEtIso);
    const remainingRthMin = Math.max(5, Math.min(390, rthCloseMins - clock.mins));
    return Math.max(5 / (252 * 390), remainingRthMin / (252 * 390));
  }
  return Math.max(1 / 365, safeDays / 365);
}

/**
 * Canonical effective Open Interest weighting: uses OI when positive,
 * otherwise weights intraday volume at 0.35x so newly listed 0DTE strikes contribute accurately.
 */
export function resolveEffectiveOpenInterest(
  openInterest: number,
  volume: number
): number {
  if (Number.isFinite(openInterest) && openInterest > 0) {
    return openInterest;
  }
  if (Number.isFinite(volume) && volume > 0) {
    return Math.round(volume * 0.35);
  }
  return 0;
}

/**
 * Computes Expected Move (0.85 × ATM Straddle) for a specific expiration date.
 */
export function computeExpirationExpectedMove(
  expIso: string,
  spotPrice: number,
  impliedVolatility: number,
  dteDays: number,
  contractsForExp: NormalizedOptionContract[]
): ExpectedMoveHorizon | null {
  if (!expIso || !Number.isFinite(spotPrice) || spotPrice <= 0) return null;
  const safeBaseIv = resolveSafeIv(impliedVolatility, 0.25);

  // Find ATM strike closest to spotPrice
  let atmStrike = spotPrice;
  let bestDist = Infinity;
  for (const c of contractsForExp) {
    if (!Number.isFinite(c.strike) || c.strike <= 0) continue;
    const d = Math.abs(c.strike - spotPrice);
    if (d < bestDist) {
      bestDist = d;
      atmStrike = c.strike;
    }
  }

  let callMid = 0;
  let putMid = 0;
  let callIv = safeBaseIv;
  let putIv = safeBaseIv;

  for (const c of contractsForExp) {
    if (Math.abs(c.strike - atmStrike) > 1e-3) continue;
    const rawIv = resolveSafeIv(c.iv, safeBaseIv);
    const mid =
      c.bid !== undefined && c.ask !== undefined && c.bid > 0 && c.ask > 0
        ? (c.bid + c.ask) / 2
        : c.last !== undefined && c.last > 0
          ? c.last
          : 0;
    if (c.optionType === "C") {
      if (mid > 0) callMid = mid;
      callIv = rawIv;
    } else {
      if (mid > 0) putMid = mid;
      putIv = rawIv;
    }
  }

  const safeDte = Number.isFinite(dteDays) ? Math.max(0, dteDays) : 0;
  const T = Math.max(1 / 365, (safeDte + 0.5) / 365);
  if (callMid <= 0) {
    callMid = computeBlackScholesGreeks(spotPrice, atmStrike, T, callIv).callPrice;
  }
  if (putMid <= 0) {
    putMid = computeBlackScholesGreeks(spotPrice, atmStrike, T, putIv).putPrice;
  }

  const straddle = callMid + putMid;
  const em = Number((0.85 * straddle).toFixed(2));
  const pct = Number(((em / Math.max(1, spotPrice)) * 100).toFixed(2));
  const low = Number((spotPrice - em).toFixed(2));
  const high = Number((spotPrice + em).toFixed(2));

  return {
    exp: expIso,
    em,
    pct,
    low,
    high,
  };
}

/**
 * Evaluates dealer exposure & structural walls across the FULL options chain (all non-expired expirations & all strikes).
 */
export function computeOptionsAnalytics(params: {
  ticker: TickerSymbol;
  dataSource: DataSourceType;
  spotPrice: number;
  previousClose: number;
  impliedVolatility?: number; // decimal
  contracts: NormalizedOptionContract[];
  activeExpirationFilter?: string;
  extendedQuote?: ExtendedQuoteInfo | null;
  bookTimestamp?: string;
  officialLevels?: GammaLevels | null;
}): OptionsAnalyticsPayload {
  const {
    ticker,
    dataSource,
    spotPrice,
    previousClose,
    impliedVolatility,
    contracts,
    activeExpirationFilter = "0DTE",
    extendedQuote = null,
    bookTimestamp,
  } = params;

  const safeSpot = Number.isFinite(spotPrice) && spotPrice > 0 ? spotPrice : 0;
  const safePrevClose =
    Number.isFinite(previousClose) && previousClose > 0 ? previousClose : safeSpot;
  const { nowEtIso: todayEtIso, mins: currentEtMinutes } = getEtClockParts();
  const preset = getTickerPreset(ticker, safeSpot > 0 ? safeSpot : undefined);
  const presetIv = resolveSafeIv(preset?.impliedVolatility, 0.25);
  const safeIv = resolveSafeIv(impliedVolatility, presetIv);

  // Full book aggregation: keep all valid positive non-expired strikes with finite OI or volume
  const validContracts = contracts.filter(
    (c) =>
      c.strike > 0 &&
      Number.isFinite(c.strike) &&
      isValidIsoDate(c.expiration) &&
      c.expiration >= todayEtIso &&
      ((Number.isFinite(c.openInterest) && c.openInterest > 0) ||
        (Number.isFinite(c.volume) && c.volume > 0))
  );

  // Collect all active (unsettled) expirations using unified ET market-hours check
  const rawExpirations = Array.from(
    new Set(validContracts.map((c) => c.expiration))
  ).sort();

  const { referenceDate, hasZeroDte, activeExpirations: allExpirations } =
    getActiveExpirationSelection(rawExpirations);

  // Keep ALL active non-expired expirations (no 13-expiration truncation)
  const selectedIsoDates = allExpirations;
  const thisWeekIsoSet = getThisWeekIsoSet(selectedIsoDates);

  const expirations: ExpirationColumnSpec[] = selectedIsoDates.map((iso, idx) =>
    formatExpirationColumn(
      iso,
      idx,
      referenceDate,
      hasZeroDte,
      thisWeekIsoSet.has(iso)
    )
  );

  const isoToColId = new Map<string, string>();
  const isoToDays = new Map<string, number>();
  const refTime = new Date(`${referenceDate}T00:00:00Z`).getTime();

  expirations.forEach((exp) => {
    isoToColId.set(exp.isoDate, exp.id);
    const expTime = new Date(`${exp.isoDate}T00:00:00Z`).getTime();
    const days =
      Number.isFinite(expTime) && Number.isFinite(refTime)
        ? Math.max(0, (expTime - refTime) / (1000 * 60 * 60 * 24))
        : 0;
    isoToDays.set(exp.isoDate, days);
  });

  // Group contracts across all active expirations
  const selectedContracts = validContracts.filter((c) =>
    isoToColId.has(c.expiration)
  );

  // Determine strike step from available strikes near spot
  const uniqueStrikesAsc = Array.from(
    new Set(selectedContracts.map((c) => Number(c.strike.toFixed(2))))
  ).sort((a, b) => a - b);

  let detectedStep = preset.strikeStep;
  const atmStrikes = uniqueStrikesAsc.filter(
    (s) => Math.abs(s - safeSpot) <= Math.max(1, safeSpot) * 0.03
  );
  if (atmStrikes.length >= 3) {
    const diffs: number[] = [];
    for (let i = 1; i < atmStrikes.length; i++) {
      const d = Number((atmStrikes[i] - atmStrikes[i - 1]).toFixed(2));
      if (d >= 0.5) diffs.push(d);
    }
    if (diffs.length > 0) {
      diffs.sort((a, b) => a - b);
      detectedStep = diffs[Math.floor(diffs.length / 2)];
    }
  }

  // Accumulate per-strike, per-expiration metrics
  interface BucketCell {
    callOI: number;
    putOI: number;
    callGammaOI: number;
    putGammaOI: number;
    callDeltaOI: number;
    putDeltaOI: number;
    callVannaOI: number;
    putVannaOI: number;
    callCharmOI: number;
    putCharmOI: number;
    weightedPctChange: number;
    totalWeight: number;
  }

  const strikeMap = new Map<number, Map<string, BucketCell>>();
  const contractsByExp = new Map<string, NormalizedOptionContract[]>();

  for (const contract of selectedContracts) {
    const strikeKey = Number(contract.strike.toFixed(2));
    const colId = isoToColId.get(contract.expiration);
    if (!colId) continue;

    let expList = contractsByExp.get(contract.expiration);
    if (!expList) {
      expList = [];
      contractsByExp.set(contract.expiration, expList);
    }
    expList.push(contract);

    let expMap = strikeMap.get(strikeKey);
    if (!expMap) {
      expMap = new Map<string, BucketCell>();
      strikeMap.set(strikeKey, expMap);
    }
    let cell = expMap.get(colId);
    if (!cell) {
      cell = {
        callOI: 0,
        putOI: 0,
        callGammaOI: 0,
        putGammaOI: 0,
        callDeltaOI: 0,
        putDeltaOI: 0,
        callVannaOI: 0,
        putVannaOI: 0,
        callCharmOI: 0,
        putCharmOI: 0,
        weightedPctChange: 0,
        totalWeight: 0,
      };
      expMap.set(colId, cell);
    }

    const days = isoToDays.get(contract.expiration) ?? 0;
    const T = computeIntradayExpiryYears(days, todayEtIso, currentEtMinutes);
    const contractIv = resolveSafeIv(contract.iv, safeIv);

    // Calibrated Gamma Greeks (r = 0.0460, q = 0.0, calendar T = days / 365)
    const bs = computeBlackScholesGreeks(
      safeSpot,
      strikeKey,
      T,
      contractIv,
      0.046,
      0.0
    );

    // Untouched VEX (Vanna) calculation preserving exact $5.99B match
    const T_vex = Math.max(1 / 365, (days + 0.5) / 365);
    const bsVex = computeBlackScholesGreeks(
      safeSpot,
      strikeKey,
      T_vex,
      contractIv,
      0.045,
      0.012
    );

    const oi = resolveEffectiveOpenInterest(contract.openInterest, contract.volume);
    if (oi <= 0) continue;

    if (contract.optionType === "C") {
      cell.callOI += oi;
      cell.callGammaOI += oi * bs.gamma;
      cell.callDeltaOI += oi * bs.deltaCall;
      cell.callVannaOI += oi * bsVex.vanna;
      cell.callCharmOI += oi * bs.charmCall;
    } else {
      cell.putOI += oi;
      cell.putGammaOI += oi * bs.gamma;
      cell.putDeltaOI += oi * bs.deltaPut;
      cell.putVannaOI += oi * bsVex.vanna;
      cell.putCharmOI += oi * bs.charmPut;
    }

    if (oi > 0 && Number.isFinite(contract.percentChange)) {
      cell.weightedPctChange += oi * contract.percentChange;
      cell.totalWeight += oi;
    }
  }

  let totalNetGexMillions = 0;
  let totalNetVexMillions = 0;
  let totalNetDexMillions = 0;
  let totalNetCharmMillions = 0;

  const computedRowsAsc: ComputedStrikeRow[] = [];

  for (const strike of uniqueStrikesAsc) {
    const expMap = strikeMap.get(strike);
    const gex: Record<string, number> = {};
    const callGex: Record<string, number> = {};
    const putGex: Record<string, number> = {};
    const vex: Record<string, number> = {};
    const dex: Record<string, number> = {};
    const charm: Record<string, number> = {};
    const openPctChange: Record<string, number> = {};

    let rowNetGex = 0;
    let rowAbsGex = 0;
    let rowCallGamma = 0;
    let rowPutGamma = 0;
    let kingPeakColId = expirations[0]?.id ?? "exp_0";
    let maxColAbsGex = -1;

    for (const exp of expirations) {
      const cell = expMap?.get(exp.id);
      if (!cell) {
        gex[exp.id] = 0;
        callGex[exp.id] = 0;
        putGex[exp.id] = 0;
        vex[exp.id] = 0;
        dex[exp.id] = 0;
        charm[exp.id] = 0;
        openPctChange[exp.id] = 0;
        continue;
      }

      // GEX ($M per 1% Spot Move): ((callOI * callGamma) - (putOI * putGamma)) * 100 * (S * S) * 0.01 / 1e6
      const callGexM =
        (cell.callGammaOI * 100 * (safeSpot * safeSpot) * 0.01) / 1e6;
      const putGexM =
        (cell.putGammaOI * 100 * (safeSpot * safeSpot) * 0.01) / 1e6;
      const cellGexM = callGexM - putGexM;

      // VEX ($M per 1% IV Point Move): ((callOI * callVanna) - (putOI * putVanna)) * 100 * S * 0.01 / 1e6
      const cellVexM =
        ((cell.callVannaOI - cell.putVannaOI) * 100 * safeSpot * 0.01) / 1e6;

      // DEX ($M Delta Notional): ((callOI * callDelta) + (putOI * putDelta)) * 100 * S / 1e6
      const cellDexM =
        ((cell.callDeltaOI + cell.putDeltaOI) * 100 * safeSpot) / 1e6;

      // Charm ($M Daily Delta Decay): ((callOI * charmCall) - (putOI * charmPut)) * 100 * S * (1 / 252) / 1e6
      const cellCharmM =
        ((cell.callCharmOI - cell.putCharmOI) * 100 * safeSpot * (1 / 252)) / 1e6;

      gex[exp.id] = Number(cellGexM.toFixed(4));
      callGex[exp.id] = Number(callGexM.toFixed(4));
      putGex[exp.id] = Number(putGexM.toFixed(4));
      vex[exp.id] = Number(cellVexM.toFixed(4));
      dex[exp.id] = Number(cellDexM.toFixed(4));
      charm[exp.id] = Number(cellCharmM.toFixed(4));

      let avgPct = 0;
      if (
        (exp.id === "exp_0" || exp.id === "exp_1") &&
        cell.totalWeight > 0
      ) {
        avgPct = Math.max(
          -99,
          Math.min(199, Math.round(cell.weightedPctChange / cell.totalWeight))
        );
      }
      openPctChange[exp.id] = avgPct;

      rowNetGex += cellGexM;
      rowAbsGex += Math.abs(cellGexM);
      rowCallGamma += callGexM;
      rowPutGamma += putGexM;

      totalNetGexMillions += cellGexM;
      totalNetVexMillions += cellVexM;
      totalNetDexMillions += cellDexM;
      totalNetCharmMillions += cellCharmM;

      if (Math.abs(cellGexM) > maxColAbsGex) {
        maxColAbsGex = Math.abs(cellGexM);
        kingPeakColId = exp.id;
      }
    }

    computedRowsAsc.push({
      strike,
      totalNetGex: Number(rowNetGex.toFixed(2)),
      totalAbsGex: Number(rowAbsGex.toFixed(2)),
      totalCallGamma: Number(rowCallGamma.toFixed(2)),
      totalPutGamma: Number(rowPutGamma.toFixed(2)),
      kingPeakColId,
      gex,
      callGex,
      putGex,
      vex,
      dex,
      charm,
      openPctChange,
    });
  }

  // 1. All-Exp King: largest absolute net GEX across all expiration columns
  let totalBoardGamma = 0;
  for (const row of computedRowsAsc) {
    totalBoardGamma += Math.abs(row.totalNetGex);
  }

  const sortedByAllExpGex = [...computedRowsAsc].sort(
    (a, b) => Math.abs(b.totalNetGex) - Math.abs(a.totalNetGex)
  );
  const kingRow = sortedByAllExpGex[0];
  const secondRow = sortedByAllExpGex[1] ?? sortedByAllExpGex[0];

  const allExpKing = kingRow ? kingRow.strike : preset.kingPreset.allExpKing;
  const rawKingAbsGex = kingRow ? Math.abs(kingRow.totalNetGex) : 0;
  const kingValue = kingRow
    ? Math.max(0.1, rawKingAbsGex)
    : Math.max(0, preset.kingPreset.kingValue);
  const secondLargestStrike = secondRow
    ? secondRow.strike
    : preset.kingPreset.secondLargestStrike;
  const secondLargestValue = secondRow
    ? Math.abs(secondRow.totalNetGex)
    : preset.kingPreset.secondLargestValue;

  // 2. 0DTE / Next-Exp King: nearest active session column (expirations[0])
  const zeroDteCol = expirations[0];
  const zeroDteDate = zeroDteCol?.dateLabel ?? referenceDate.slice(5);
  const zeroDteIso = zeroDteCol?.isoDate ?? referenceDate;

  let best0DteStrike = allExpKing;
  let best0DteAbsVal = -1;
  if (zeroDteCol) {
    for (const row of computedRowsAsc) {
      const val = Math.abs(row.gex[zeroDteCol.id] ?? 0);
      if (val > best0DteAbsVal) {
        best0DteAbsVal = val;
        best0DteStrike = row.strike;
      }
    }
  }

  // 3. Week King: All expiration columns in `inThisWeek` (nearest exp through that week's Friday)
  const weekColsToUse = expirations.filter((c) => c.inThisWeek);
  const effectiveWeekCols =
    weekColsToUse.length > 0
      ? weekColsToUse
      : expirations.slice(0, Math.min(5, expirations.length));

  let bestWeekStrike = allExpKing;
  let bestWeekAbsSum = -1;
  let bestWeekPeakColDate = effectiveWeekCols[0]?.dateLabel ?? zeroDteDate;
  let bestWeekPeakIso = effectiveWeekCols[0]?.isoDate ?? zeroDteIso;

  for (const row of computedRowsAsc) {
    let weekSum = 0;
    let rowPeakAbs = -1;
    let rowPeakDate = effectiveWeekCols[0]?.dateLabel ?? zeroDteDate;
    let rowPeakIso = effectiveWeekCols[0]?.isoDate ?? zeroDteIso;

    for (const col of effectiveWeekCols) {
      const g = row.gex[col.id] ?? 0;
      weekSum += g;
      if (Math.abs(g) > rowPeakAbs) {
        rowPeakAbs = Math.abs(g);
        rowPeakDate = col.dateLabel;
        rowPeakIso = col.isoDate;
      }
    }

    if (Math.abs(weekSum) > bestWeekAbsSum) {
      bestWeekAbsSum = Math.abs(weekSum);
      bestWeekStrike = row.strike;
      bestWeekPeakColDate = rowPeakDate;
      bestWeekPeakIso = rowPeakIso;
    }
  }

  // 4. OPEX King: monthly expiration columns
  const opexCols = expirations.filter((c) => c.filterGroup === "OPEX");
  const opexColsToUse = opexCols.length > 0 ? opexCols : expirations.slice(-3);
  let bestOpexStrike = allExpKing;
  let bestOpexAbsSum = -1;
  let bestOpexPeakDate = opexColsToUse[0]?.dateLabel ?? "11-20";
  let bestOpexPeakIso = opexColsToUse[0]?.isoDate ?? zeroDteIso;
  for (const row of computedRowsAsc) {
    let sum = 0;
    let rowPeak = -1;
    let peakD = opexColsToUse[0]?.dateLabel ?? "11-20";
    let peakIso = opexColsToUse[0]?.isoDate ?? zeroDteIso;
    for (const col of opexColsToUse) {
      const g = row.gex[col.id] ?? 0;
      sum += g;
      if (Math.abs(g) > rowPeak) {
        rowPeak = Math.abs(g);
        peakD = col.dateLabel;
        peakIso = col.isoDate;
      }
    }
    if (Math.abs(sum) > bestOpexAbsSum) {
      bestOpexAbsSum = Math.abs(sum);
      bestOpexStrike = row.strike;
      bestOpexPeakDate = peakD;
      bestOpexPeakIso = peakIso;
    }
  }

  const zeroDteLabelPrefix = hasZeroDte ? "0DTE King" : "Next exp King";
  const zeroDteKingObj = {
    strike: best0DteStrike,
    label: `${zeroDteLabelPrefix} (${zeroDteDate})`,
    exp: zeroDteIso,
  };
  const thisWeekKingObj = {
    strike: bestWeekStrike,
    label: `Week King (${bestWeekPeakColDate})`,
    exp: bestWeekPeakIso,
  };
  const opexKingObj = {
    strike: bestOpexStrike,
    label: `OPEX King (${bestOpexPeakDate})`,
    exp: bestOpexPeakIso,
  };

  const kingByFilter = {
    ALL: { strike: allExpKing, label: "All-exp King" },
    "0DTE": zeroDteKingObj,
    THIS_WEEK: thisWeekKingObj,
    OPEX: opexKingObj,
  };

  const activeFilterObj =
    activeExpirationFilter === "THIS_WEEK"
      ? thisWeekKingObj
      : activeExpirationFilter === "OPEX"
        ? opexKingObj
        : zeroDteKingObj;

  const weeklyDate = bestWeekPeakColDate;

  // 5. King Strength (0–100) & Contested flag (second-largest within 10% of King)
  const hasLiveGamma =
    Boolean(kingRow) && totalBoardGamma > 1e-6 && rawKingAbsGex > 0 && kingValue > 0;
  const leadScore = hasLiveGamma ? (1 - secondLargestValue / kingValue) * 50 : 0;
  const shareScore = hasLiveGamma
    ? Math.min(1, (kingValue / Math.max(0.1, totalBoardGamma)) / 0.25) * 50
    : 0;
  const kingStrength = Math.round(
    Math.min(100, Math.max(0, leadScore + shareScore))
  );
  const isContested =
    hasLiveGamma && kingValue >= 1 && secondLargestValue >= kingValue * 0.9;

  // 6. True Interpolated Zero γ (Gamma Flip) Solver across ±15% around spot
  interface ZgContractItem {
    strike: number;
    T: number;
    iv: number;
    oi: number;
    isCall: boolean;
    expiration: string;
  }
  const zgContracts: ZgContractItem[] = [];
  for (const c of selectedContracts) {
    if (!Number.isFinite(c.strike) || c.strike <= 0 || c.expiration < todayEtIso) continue;
    const oi =
      Number.isFinite(c.openInterest) && c.openInterest > 0
        ? c.openInterest
        : Number.isFinite(c.volume) && c.volume > 0
          ? Math.round(c.volume * 0.35)
          : 0;
    if (oi <= 0) continue;
    const days = isoToDays.get(c.expiration) ?? 0;
    let T: number;
    if (days === 0) {
      const closeEtMinutes = getSessionBoundsEt(todayEtIso).rthCloseMins;
      const remainingMin = Math.max(5, Math.min(390, closeEtMinutes - currentEtMinutes));
      T = Math.max(5 / (252 * 390), remainingMin / (252 * 390));
    } else {
      T = Math.max(1 / 365, days / 365);
    }
    const iv = resolveSafeIv(c.iv, safeIv);
    zgContracts.push({
      strike: c.strike,
      T,
      iv,
      oi,
      isCall: c.optionType === "C",
      expiration: c.expiration,
    });
  }

  // Test hypothetical spot prices from 0.85 * spotPrice to 1.15 * spotPrice on a 41-point grid
  // plus strike-dense interior nodes so narrow 0DTE gamma peaks are never aliased
  const testSpotCount = 41;
  const minSpot = 0.85 * safeSpot;
  const maxSpot = 1.15 * safeSpot;
  const spotStepSize = (maxSpot - minSpot) / (testSpotCount - 1);
  const zgRate = 0.046;
  const zgDividend = 0.0;

  const solveZeroGamma = (contractsToSolve: ZgContractItem[]) => {
    if (safeSpot <= 0) {
      return { zeroGamma: 0, hasZeroGammaFlip: false };
    }
    if (contractsToSolve.length === 0) {
      return { zeroGamma: Number(safeSpot.toFixed(2)), hasZeroGammaFlip: false };
    }
    const gridSet = new Set<number>();
    for (let i = 0; i < testSpotCount; i++) {
      gridSet.add(Number((minSpot + i * spotStepSize).toFixed(4)));
    }
    for (const item of contractsToSolve) {
      if (item.strike >= minSpot && item.strike <= maxSpot) {
        gridSet.add(Number(item.strike.toFixed(4)));
      }
    }
    // Precompute per-contract constants outside the spot grid loop (100% exact algebraic identity:
    // gamma * 100 * s^2 * 0.01 / 1e6 = (discountQ * pdfD1 * s) / (safeContractIv * sqrtT * 1e6))
    const INV_SQRT_2PI = 0.3989422804014327;
    const preparedZg: Array<{
      logK: number;
      driftT: number;
      invIvSqrtT: number;
      coeff: number;
    }> = [];
    for (const item of contractsToSolve) {
      if (!Number.isFinite(item.strike) || item.strike <= 0 || item.oi <= 0) continue;
      const safeT = Math.max(5 / (252 * 390), Number.isFinite(item.T) ? item.T : 1 / 365);
      const safeContractIv = resolveSafeIv(item.iv, safeIv);
      const ivSqrtT = safeContractIv * Math.sqrt(safeT);
      const discountQ = Math.exp(-zgDividend * safeT);
      const sign = item.isCall ? 1 : -1;
      preparedZg.push({
        logK: Math.log(item.strike),
        driftT: (zgRate - zgDividend + 0.5 * safeContractIv * safeContractIv) * safeT,
        invIvSqrtT: 1 / ivSqrtT,
        coeff: (sign * item.oi * discountQ * INV_SQRT_2PI) / (ivSqrtT * 1e6),
      });
    }

    const testSpots = Array.from(gridSet).sort((a, b) => a - b);
    const curve: { s: number; netGex: number }[] = [];
    const nPrepared = preparedZg.length;
    for (const s of testSpots) {
      if (!Number.isFinite(s) || s <= 0) continue;
      const logS = Math.log(s);
      let totalGexAtS = 0;
      for (let j = 0; j < nPrepared; j++) {
        const p = preparedZg[j];
        const d1 = (logS - p.logK + p.driftT) * p.invIvSqrtT;
        if (d1 > 7.5 || d1 < -7.5) continue;
        totalGexAtS += p.coeff * s * Math.exp(-0.5 * d1 * d1);
      }
      curve.push({ s, netGex: totalGexAtS });
    }

    interface ZeroCrossing {
      zeroPrice: number;
      distToSpot: number;
    }
    const crossings: ZeroCrossing[] = [];
    for (let i = 0; i < curve.length - 1; i++) {
      const p1 = curve[i];
      const p2 = curve[i + 1];
      if (
        (p1.netGex < 0 && p2.netGex >= 0) ||
        (p1.netGex >= 0 && p2.netGex < 0)
      ) {
        const denom = p2.netGex - p1.netGex;
        const zeroPrice =
          Math.abs(denom) > 1e-12
            ? p1.s - p1.netGex * ((p2.s - p1.s) / denom)
            : (p1.s + p2.s) / 2;
        crossings.push({
          zeroPrice,
          distToSpot: Math.abs(zeroPrice - safeSpot),
        });
      }
    }

    let zgPrice = safeSpot;
    let flip = false;
    if (crossings.length > 0) {
      crossings.sort((a, b) => a.distToSpot - b.distToSpot);
      zgPrice = Number(crossings[0].zeroPrice.toFixed(2));
      flip = true;
    } else {
      // When Net GEX is strictly one-signed across the grid, never collapse to the ±15% tail boundary where Gamma -> 0
      zgPrice = Number(safeSpot.toFixed(2));
      flip = false;
    }
    return { zeroGamma: zgPrice, hasZeroGammaFlip: flip };
  };

  const computeLevelsForCols = (
    targetCols: ExpirationColumnSpec[],
    options?: {
      skipZeroGamma?: boolean;
      fallbackZeroGamma?: { zeroGamma: number; hasZeroGammaFlip?: boolean };
    }
  ) => {
    const targetIsoSet = new Set(targetCols.map((c) => c.isoDate));

    let bestCwStrike = safeSpot + detectedStep * 5;
    let bestCwGamma = 0;
    let bestPwStrike = safeSpot - detectedStep * 5;
    let bestPwGamma = 0;

    for (const row of computedRowsAsc) {
      let callSum = 0;
      let putSum = 0;
      for (const col of targetCols) {
        callSum += row.callGex?.[col.id] ?? 0;
        putSum += row.putGex?.[col.id] ?? 0;
      }
      if (row.strike >= safeSpot && callSum > bestCwGamma) {
        bestCwGamma = callSum;
        bestCwStrike = row.strike;
      }
      if (row.strike <= safeSpot && putSum > bestPwGamma) {
        bestPwGamma = putSum;
        bestPwStrike = row.strike;
      }
    }

    let zeroGamma: number;
    let flip: boolean;
    if (options?.skipZeroGamma && options.fallbackZeroGamma) {
      zeroGamma = options.fallbackZeroGamma.zeroGamma;
      flip = Boolean(options.fallbackZeroGamma.hasZeroGammaFlip);
    } else {
      const subZg = zgContracts.filter((c) => targetIsoSet.has(c.expiration));
      const contractsToSolve = subZg.length > 0 ? subZg : zgContracts;
      const solved = solveZeroGamma(contractsToSolve);
      zeroGamma = solved.zeroGamma;
      flip = solved.hasZeroGammaFlip;
    }

    return {
      callWall: bestCwStrike,
      callWallGex: Number(Math.max(0, bestCwGamma).toFixed(2)),
      putWall: bestPwStrike,
      putWallGex: Number((-Math.max(0, bestPwGamma)).toFixed(2)),
      zeroGamma,
      hasZeroGammaFlip: flip,
    };
  };

  // Primary aggregate levels (ALL, THIS_WEEK, 0DTE, OPEX) always compute exact Zero-Gamma
  const allLevels =
    params.officialLevels && params.officialLevels.callWall > 0
      ? params.officialLevels
      : computeLevelsForCols(expirations);

  const weekLevels = computeLevelsForCols(effectiveWeekCols);

  const zeroDteLevels = computeLevelsForCols(
    zeroDteCol ? [zeroDteCol] : expirations.slice(0, 1)
  );
  const opexLevels = computeLevelsForCols(opexColsToUse);

  const gammaLevelsByFilter: Record<string, {
    callWall: number;
    callWallGex?: number;
    putWall: number;
    putWallGex?: number;
    zeroGamma: number;
    hasZeroGammaFlip?: boolean;
  }> = {
    ALL: allLevels,
    THIS_WEEK: weekLevels,
    "0DTE": zeroDteLevels,
    OPEX: opexLevels,
  };

  // Run exact per-expiration Zero-Gamma for front 6 expirations (preserving <1.5s SPXW latency);
  // distant back-month expirations still compute exact Call/Put Walls and inherit aggregate Zero-Gamma.
  const MAX_EXACT_PER_EXP_ZG = 6;
  for (let idx = 0; idx < expirations.length; idx++) {
    const exp = expirations[idx];
    const expLevel =
      idx < MAX_EXACT_PER_EXP_ZG
        ? computeLevelsForCols([exp])
        : computeLevelsForCols([exp], {
            skipZeroGamma: true,
            fallbackZeroGamma: exp.filterGroup === "OPEX" ? opexLevels : allLevels,
          });
    gammaLevelsByFilter[exp.dateLabel] = expLevel;
    gammaLevelsByFilter[exp.isoDate] = expLevel;
  }

  // 7. Expected Moves: 0.85 × ATM Straddle for Daily (D), Weekly (W), Monthly (M), and Annual (A)
  const dailyExpIso = selectedIsoDates[0] ?? "";
  const weeklyExpIso =
    effectiveWeekCols[effectiveWeekCols.length - 1]?.isoDate ??
    selectedIsoDates[Math.min(4, selectedIsoDates.length - 1)] ??
    dailyExpIso;

  // Monthly: target standard 3rd Friday monthly OPEX that is at least 20+ calendar days out
  // (e.g. for Oct 18, 2026, targeting November 3rd Friday: 2026-11-20)
  const opexFridays = selectedIsoDates.filter((d) => {
    const [y, m, day] = d.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, day));
    return dt.getUTCDay() === 5 && day >= 15 && day <= 21;
  });
  const monthlyExpIso =
    opexFridays.find((d) => (isoToDays.get(d) ?? 0) >= 20) ??
    opexFridays[0] ??
    selectedIsoDates[Math.min(8, selectedIsoDates.length - 1)] ??
    weeklyExpIso;

  const dailyEm = dailyExpIso
    ? computeExpirationExpectedMove(
        dailyExpIso,
        safeSpot,
        safeIv,
        isoToDays.get(dailyExpIso) ?? 1,
        contractsByExp.get(dailyExpIso) ?? []
      )
    : null;

  const weeklyEm = weeklyExpIso
    ? computeExpirationExpectedMove(
        weeklyExpIso,
        safeSpot,
        safeIv,
        isoToDays.get(weeklyExpIso) ?? 5,
        contractsByExp.get(weeklyExpIso) ?? []
      )
    : null;

  const monthlyEm = monthlyExpIso
    ? computeExpirationExpectedMove(
        monthlyExpIso,
        safeSpot,
        safeIv,
        isoToDays.get(monthlyExpIso) ?? 21,
        contractsByExp.get(monthlyExpIso) ?? []
      )
    : null;

  // Annual (A): Fixed 2026 start-of-year levels for SPY, SPX/SPXW, and QQQ (matching TerraShade)
  let annualEm: ExpectedMoveHorizon | null = null;
  if (ticker === "SPY") {
    annualEm = {
      exp: "2026",
      em: 114.18,
      pct: 16.75,
      low: 567.74,
      high: 796.1,
      fixed: true,
    };
  } else if (ticker === "SPXW" || ticker === "SPX") {
    annualEm = {
      exp: "2026",
      em: 1141.8,
      pct: 16.75,
      low: 5677.4,
      high: 7961.0,
      fixed: true,
    };
  } else if (ticker === "QQQ") {
    annualEm = {
      exp: "2026",
      em: 108.45,
      pct: 18.2,
      low: 487.45,
      high: 704.35,
      fixed: true,
    };
  }

  // Sort strikes descending (highest strike at top of heatmap)
  const strikesDesc = [...computedRowsAsc].sort((a, b) => b.strike - a.strike);

  return {
    ticker,
    dataSource,
    lastUpdated: new Date().toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }),
    bookTimestamp:
      bookTimestamp ??
      new Date().toLocaleString("en-US", {
        timeZone: "America/New_York",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }) + " ET",
    spotPrice: Number(safeSpot.toFixed(2)),
    previousClose: Number(safePrevClose.toFixed(2)),
    impliedVolatility: Number(safeIv.toFixed(4)),
    strikeStep: detectedStep,
    extendedQuote,
    expectedMoves: {
      daily: dailyEm,
      weekly: weeklyEm,
      monthly: monthlyEm,
      annual: annualEm,
    },
    netMetrics: {
      netGex: Number((totalNetGexMillions / 1000).toFixed(2)),
      netVex: Number(totalNetVexMillions.toFixed(1)),
      netDex: Number(totalNetDexMillions.toFixed(1)),
      netCharm: Number(totalNetCharmMillions.toFixed(1)),
    },
    gammaLevels: allLevels,
    gammaLevelsByFilter,
    kingNode: {
      allExpKing,
      filteredKing: activeFilterObj.strike,
      filteredLabel: activeFilterObj.label,
      zeroDteKing: zeroDteKingObj.strike,
      zeroDteDate,
      hasZeroDte,
      weeklyKing: thisWeekKingObj.strike,
      weeklyDate,
      kingValue: Number(kingValue.toFixed(1)),
      secondLargestStrike,
      secondLargestValue: Number(secondLargestValue.toFixed(1)),
      totalBoardGamma: Number(totalBoardGamma.toFixed(1)),
      kingStrength,
      isContested,
    },
    kingByFilter,
    expirations,
    strikes: strikesDesc,
  };
}

export interface TacticalStructuralLevels {
  callWall: number;
  putWall: number;
  zeroGamma: number;
  tacticalKing: number;
  bookCenter: number;
  dailyExpectedMove: { low: number; high: number } | null;
  netGexMillions: number;
  netVexMillions: number;
}

/**
 * Shared tactical dealer-wall extractor used by both UI analytics and the live daemon
 * so multi-ticker execution evaluates against exact live GEX/VEX walls and Expected Move.
 */
export function deriveTacticalStructuralLevels(
  payload: OptionsAnalyticsPayload
): TacticalStructuralLevels {
  const { gammaLevels, gammaLevelsByFilter } = payload;
  const tacticalKing =
    payload.kingNode?.zeroDteKing ??
    payload.kingByFilter?.["0DTE"]?.strike ??
    payload.kingNode?.weeklyKing ??
    payload.kingByFilter?.ALL?.strike ??
    payload.spotPrice;

  const zeroDteLevels = gammaLevelsByFilter?.["0DTE"] ?? gammaLevelsByFilter?.["THIS_WEEK"];
  const baseCallWall =
    zeroDteLevels?.callWall && zeroDteLevels.callWall > 0
      ? zeroDteLevels.callWall
      : gammaLevels.callWall > 0 &&
          Math.abs(gammaLevels.callWall - payload.spotPrice) / Math.max(1, payload.spotPrice) < 0.025
        ? gammaLevels.callWall
        : Number((payload.spotPrice * 1.008).toFixed(2));
  const callWall =
    tacticalKing > baseCallWall &&
    (tacticalKing - payload.spotPrice) / Math.max(1, payload.spotPrice) <= 0.015
      ? tacticalKing
      : baseCallWall;

  const rawPutWall =
    zeroDteLevels?.putWall && zeroDteLevels.putWall > 0
      ? zeroDteLevels.putWall
      : gammaLevels.putWall > 0 &&
          Math.abs(payload.spotPrice - gammaLevels.putWall) / Math.max(1, payload.spotPrice) < 0.025
        ? gammaLevels.putWall
        : Number((payload.spotPrice * 0.992).toFixed(2));

  let putWall = rawPutWall;
  const minStepOffset = Math.min(0.5, Math.max(0.05, payload.spotPrice * 0.001));
  const emPct =
    payload.expectedMoves?.daily?.em && payload.spotPrice > 0
      ? payload.expectedMoves.daily.em / payload.spotPrice
      : 0;
  const maxPutWallDistPct = Math.max(0.0095, emPct * 1.1);
  if (
    rawPutWall > 0 &&
    (payload.spotPrice - rawPutWall) / Math.max(1, payload.spotPrice) > maxPutWallDistPct &&
    Array.isArray(payload.strikes) &&
    payload.expirations.length > 0
  ) {
    const nearExpId = payload.expirations[0].id;
    let bestNearPutStrike = 0;
    let minNearPutGex = 0;
    for (const row of payload.strikes) {
      if (
        row.strike < payload.spotPrice - minStepOffset &&
        (payload.spotPrice - row.strike) / Math.max(1, payload.spotPrice) <= maxPutWallDistPct
      ) {
        const g = row.gex[nearExpId] ?? 0;
        if (g < minNearPutGex) {
          minNearPutGex = g;
          bestNearPutStrike = row.strike;
        }
      }
    }
    if (bestNearPutStrike > 0) {
      putWall = bestNearPutStrike;
    } else if (payload.expectedMoves?.daily?.low && payload.expectedMoves.daily.low > rawPutWall) {
      putWall = Number(payload.expectedMoves.daily.low.toFixed(2));
    }
  }

  const zeroGamma =
    zeroDteLevels?.hasZeroGammaFlip && zeroDteLevels.zeroGamma > 0
      ? zeroDteLevels.zeroGamma
      : gammaLevels.zeroGamma;

  const netGexMillions = Number(((payload.netMetrics?.netGex ?? 0) * 1000).toFixed(2));
  const dealerFlow = computeDealerFlowSummary({
    spot: payload.spotPrice,
    netGexM: netGexMillions,
    zeroGammaFlip: zeroGamma > 0 ? zeroGamma : null,
    kingStrike: tacticalKing > 0 ? tacticalKing : null,
    allExpKingStrike: payload.kingNode?.allExpKing ?? null,
    callWall: callWall > 0 ? callWall : null,
    putWall: putWall > 0 ? putWall : null,
    strikes: (payload.strikes ?? []).map((row) => ({
      strike: row.strike,
      netGex: row.totalNetGex,
    })),
  });
  const bookCenter =
    Number.isFinite(dealerFlow.centerOfGammaMass) && dealerFlow.centerOfGammaMass > 0
      ? Number(dealerFlow.centerOfGammaMass.toFixed(2))
      : zeroGamma;

  return {
    callWall,
    putWall,
    zeroGamma,
    tacticalKing,
    bookCenter,
    dailyExpectedMove: payload.expectedMoves?.daily
      ? { low: payload.expectedMoves.daily.low, high: payload.expectedMoves.daily.high }
      : null,
    netGexMillions,
    netVexMillions: Number((payload.netMetrics?.netVex ?? 0).toFixed(2)),
  };
}

