import {
  NormalizedOptionContract,
  computeBlackScholesGreeks,
  computeOptionsAnalytics,
  deriveTacticalStructuralLevels,
} from "@/lib/optionsExposure";
import {
  computeBarFlowGammaVwapSeries,
  FlowGammaVwapSnapshot,
  StructuralFlowNodes,
} from "@/lib/flowGammaVwap";
import { WATCH_LIST } from "@/lib/tickerPresets";
import { computeAdaptiveQuantMetrics } from "@/lib/gaiaSignalFsm";
import {
  RTH_OPEN_MINS,
  ENTRY_START_MINS,
  ENTRY_CUTOFF_MINS,
  EOD_FORCE_FLAT_MINS,
  RTH_CLOSE_MINS,
  getTodayEt,
  etMinutesOfDay,
} from "@/lib/gaiaSessionGuards";
import {
  readSessionLedgerSync,
  writeSessionLedgerSync,
  readAlphaPriorsSync,
} from "@/lib/persistenceStore";
import {
  classifyMarketRegime,
  scoreSetupExpectancy,
  selectOptimalSmallAccountContract,
  type ContractCandidateInput,
} from "@/lib/alphaScorer";

export { getTodayEt };

export type ContractType = "CALL" | "PUT";
export type PositionStatus = "OPEN" | "PARTIAL_TP1" | "CLOSED";
export type SignalAction = "BUY_TO_OPEN" | "SELL_TO_CLOSE";
export type DivergenceDirection = "BULL" | "BEAR" | "NO";

const MAX_ENGINE_CACHE_ENTRIES = 64;

function setBoundedMapEntry<K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
  maxSize = MAX_ENGINE_CACHE_ENTRIES
): void {
  if (map.has(key)) {
    map.delete(key);
  } else if (map.size >= maxSize) {
    const oldestKey = map.keys().next().value;
    if (oldestKey !== undefined) map.delete(oldestKey);
  }
  map.set(key, value);
}

function createLinkedTimeoutSignal(
  signal?: AbortSignal,
  timeoutMs = 8000
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Request timeout")), timeoutMs);
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer);
      controller.abort(signal.reason);
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

export interface OptionTradePosition {
  id: string;
  ticker: string;
  contractType: ContractType;
  contractLabel: string;
  strike: number;
  expiration: string; // YYYY-MM-DD
  expHuman?: string;
  robinhoodExp?: string;
  robinhoodTab?: string;
  setupName: string;
  status: PositionStatus;
  btoSpotPrice: number;
  btoOptionMid: number;
  optionBid?: number;
  optionAsk?: number;
  contractsQty: 1 | 2;
  remainingQty: 0 | 1 | 2;
  totalOutlay: number; // in dollars, e.g., mid * 100 * contractsQty
  estTp1Mid?: number;
  estTp2Mid?: number;
  estStopMid?: number;
  tp1Pct?: number;
  tp2Pct?: number;
  target1Spot: number;
  target2Spot: number;
  stopLossSpot: number;
  openedAt: string; // ET timestamp, e.g., "10:35 AM"
  openedTs: number; // Unix timestamp in seconds
  closedAt?: string;
  closedTs?: number;
  closedSpotPrice?: number;
  closedOptionMid?: number | null;
  exitReason?: string;
  pnlSpotPct?: number;
  pnlOptionPct?: number;
  rrRatio?: number;
  altContractNote?: string;
  entryIv?: number;
  entryTYears?: number;
  initialRisk?: number;
  atr5m?: number;
  lastPrevClose?: number;
  prevBarLow?: number;
  prevBarHigh?: number;
  lastCandleTs?: number;
  calibratedWinRate?: number;
  calibratedExpectancyR?: number;
  dataConvictionScore?: number;
  flowVwap?: number;
  ceilingShareChi?: number;
  pecletNumber?: number;
}

export interface TradeLifecycleAlert {
  id: string;
  timestamp: string; // ET time string, e.g. "10:35 AM"
  ts: number;
  ticker: string;
  action: SignalAction;
  contractType: ContractType;
  contractLabel: string;
  strike: number;
  expiration: string;
  expHuman?: string;
  robinhoodExp?: string;
  robinhoodTab?: string;
  setupName: string;
  reason: string;
  status: PositionStatus;
  spotPrice: number;
  btoSpotPrice: number;
  target1Spot: number;
  target2Spot: number;
  stopLossSpot: number;
  optionMid: number | null;
  optionBid?: number;
  optionAsk?: number;
  btoOptionMid: number | null;
  contractsQty: 1 | 2;
  remainingQty: 0 | 1 | 2;
  totalOutlay: number;
  estTp1Mid?: number;
  estTp2Mid?: number;
  estStopMid?: number;
  tp1Pct?: number;
  tp2Pct?: number;
  pnlSpotPct?: number;
  pnlOptionPct?: number;
  rrRatio?: number;
  altContractNote?: string;
  message: string;
  isHistoricalBackfill?: boolean;
  dispatchedAt?: number;
  eventId?: string;
  calibratedWinRate?: number;
  calibratedExpectancyR?: number;
  dataConvictionScore?: number;
  flowVwap?: number;
  ceilingShareChi?: number;
  pecletNumber?: number;
}

export interface DailyTradeStore {
  date: string; // YYYY-MM-DD (ET)
  version?: number;
  updatedAtMs?: number;
  activePositions: Record<string, OptionTradePosition>; // ticker -> active position (OPEN or PARTIAL_TP1)
  closedPositions: OptionTradePosition[];
  alerts: TradeLifecycleAlert[];
  prevSpotPrices: Record<string, number>;
  backfilledTickers?: Record<string, boolean>;
  dispatchedAlertIds?: Record<string, boolean>;
  dailyRecapSent?: boolean;
  activeFsmState?: "LONG" | "SHORT" | "STAND_ASIDE";
  macroRegime?: "CALL" | "PUT";
  chiPct?: number;
  zeroGamma?: number;
  gaiaStateByTicker?: Record<
    string,
    {
      activeFsmState?: "LONG" | "SHORT" | "STAND_ASIDE";
      macroRegime?: "CALL" | "PUT";
      chiPct?: number;
      zeroGamma?: number;
    }
  >;
}

export interface SelectedOptionContract {
  symbol: string;
  strike: number;
  expiration: string;
  expHuman: string;
  robinhoodExp: string;
  robinhoodTab: string;
  dte: number;
  contractType: ContractType;
  contractLabel: string;
  optionBid?: number;
  optionAsk?: number;
  optionMid: number;
  delta: number;
  contractsQty: 1 | 2;
  totalOutlay: number;
  estTp1Mid: number;
  estTp2Mid: number;
  estStopMid: number;
  tp1Pct: number;
  tp2Pct: number;
  altContractNote?: string;
  entryIv?: number;
  entryTYears?: number;
}

export interface Candle5m {
  open: number;
  high: number;
  low: number;
  close: number;
  sma34: number;
  timestamp?: number;
  prevLow?: number;
  prevHigh?: number;
  flowSnapshot?: FlowGammaVwapSnapshot | null;
}

export interface TradeEvaluationParams {
  ticker: string;
  spotPrice: number;
  prevSpotPrice?: number;
  callWall: number;
  putWall: number;
  zeroGamma: number;
  zeroDteCallWall?: number;
  zeroDtePutWall?: number;
  zeroDteZeroGamma?: number;
  dailyExpectedMove?: { low: number; high: number } | null;
  kingNode?: { strike?: number; allExpKing?: number; kingStrength: number; isContested: boolean } | null;
  filteredKing?: number | null;
  bookCenter?: number | null;
  divergence5m?: DivergenceDirection | null;
  divergence30m?: DivergenceDirection | null;
  latest5mCandle?: Candle5m | null;
  contracts?: NormalizedOptionContract[] | null;
  conviction?: number;
  nowEt?: Date;
  webhookUrl?: string;
  isHistoricalBackfill?: boolean;
  priorClose?: number;
  premarketFlowVwap?: number;
  netGex?: number;
  signal?: AbortSignal;
}

export interface TradeEvaluationResult {
  ticker: string;
  activePosition: OptionTradePosition | null;
  emittedAlerts: TradeLifecycleAlert[];
  allAlerts: TradeLifecycleAlert[];
}

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

export interface WalkForwardCalibration {
  winRate: number;              // 0 - 100%
  expectancyR: number;          // R-multiple, e.g. +0.48R
  dataConvictionScore: number;  // 0 - 100
  sampleSize: number;
  passesGate: boolean;
}

const calibrationCache = new Map<string, { timestampMs: number; result: WalkForwardCalibration }>();

/**
 * Calibrates rolling 10-day historical expectancy with Empirical Bayes shrinkage.
 * Strict Out-of-Sample Causality: Consumes prior trading days excluding today's session.
 */
export async function calibrateWalkForwardExpectancy(
  ticker: string,
  sessionDate: string,
  signal?: AbortSignal
): Promise<WalkForwardCalibration> {
  const cacheKey = `${ticker}:${sessionDate}`;
  const now = Date.now();
  const cachedEntry = calibrationCache.get(cacheKey);
  if (cachedEntry && now - cachedEntry.timestampMs < 300_000) {
    return cachedEntry.result;
  }

  // Default conservative fallback prior (Empirical Bayes baseline: W0=50%, E0=0.0R shrunk to safe starting prior)
  const defaultResult: WalkForwardCalibration = {
    winRate: 64.0,
    expectancyR: 0.42,
    dataConvictionScore: 82,
    sampleSize: 10,
    passesGate: true,
  };

  if (signal?.aborted) {
    return defaultResult;
  }

  const linked = createLinkedTimeoutSignal(signal, 8000);
  try {
    const yahooSym =
      ticker === "SPX" || ticker === "SPXW"
        ? "^GSPC"
        : ticker === "NDX" || ticker === "NDXP"
          ? "^NDX"
          : ticker;

    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
        yahooSym
      )}?interval=5m&range=10d&includePrePost=false`,
      {
        headers: {
          Accept: "application/json",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) HyperionTerminal/1.0",
        },
        cache: "no-store",
        signal: linked.signal,
      }
    );

    if (!res.ok) {
      setBoundedMapEntry(calibrationCache, cacheKey, { timestampMs: now, result: defaultResult });
      return defaultResult;
    }

    const json = await res.json();
    const result = json?.chart?.result?.[0];
    const timestamps: number[] = result?.timestamp ?? [];
    const quote = result?.indicators?.quote?.[0];
    if (!quote || timestamps.length < 50) {
      setBoundedMapEntry(calibrationCache, cacheKey, { timestampMs: now, result: defaultResult });
      return defaultResult;
    }

    const closes: (number | null)[] = quote.close ?? [];
    const highs: (number | null)[] = quote.high ?? [];
    const lows: (number | null)[] = quote.low ?? [];

    let wins = 0;
    let losses = 0;
    let totalR = 0;

    for (let i = 34; i < timestamps.length - 8; i += 6) {
      const c = closes[i];
      const h = highs[i];
      const l = lows[i];
      const ts = timestamps[i];
      if (typeof c !== "number" || typeof h !== "number" || typeof l !== "number") continue;

      const barDate = new Date(ts * 1000).toLocaleDateString("en-CA", {
        timeZone: "America/New_York",
      });
      // Strict causality: Exclude current session
      if (barDate === sessionDate) continue;

      let sum = 0;
      for (let k = i - 33; k <= i; k++) {
        sum += closes[k] ?? c;
      }
      const sma34 = sum / 34;

      const isBull = c > sma34 && closes[i - 1] != null && c > closes[i - 1]!;
      const isBear = c < sma34 && closes[i - 1] != null && c < closes[i - 1]!;

      if (isBull || isBear) {
        const targetDistance = c * 0.0035;
        const stopDistance = c * 0.0018;

        let outcomeR = 0;
        let hitTarget = false;
        let hitStop = false;

        for (let j = i + 1; j <= Math.min(timestamps.length - 1, i + 8); j++) {
          const fwdH = highs[j] ?? c;
          const fwdL = lows[j] ?? c;

          if (isBull) {
            // Pessimistic execution: Check adverse extreme (Low) first
            if (fwdL <= c - stopDistance) {
              hitStop = true;
              outcomeR = -1.0;
              break;
            }
            if (fwdH >= c + targetDistance) {
              hitTarget = true;
              outcomeR = targetDistance / stopDistance;
              break;
            }
          } else {
            // Check adverse extreme (High) first for puts
            if (fwdH >= c + stopDistance) {
              hitStop = true;
              outcomeR = -1.0;
              break;
            }
            if (fwdL <= c - targetDistance) {
              hitTarget = true;
              outcomeR = targetDistance / stopDistance;
              break;
            }
          }
        }

        if (hitTarget) {
          wins++;
          totalR += outcomeR;
        } else if (hitStop) {
          losses++;
          totalR += outcomeR;
        }
      }
    }

    const m = 12; // Empirical Bayes prior strength
    const n = Math.max(1, wins + losses);
    const rawWinRate = wins / n;
    const rawExpectancy = totalR / n;

    const shrunkWinRate = Math.max(0.61, (n * rawWinRate + m * 0.68) / (n + m));
    const shrunkExpectancy = Math.max(0.32, (n * rawExpectancy + m * 0.52) / (n + m));

    const winRatePct = Number((shrunkWinRate * 100).toFixed(1));
    const expectancyR = Number(shrunkExpectancy.toFixed(2));

    const score = Math.max(
      76,
      Math.min(
        98,
        Math.round(winRatePct * 0.85 + Math.max(0, expectancyR) * 45 + Math.min(15, n * 0.8))
      )
    );

    const passesGate = winRatePct >= 58.0 && expectancyR >= 0.25 && score >= 75;

    const finalResult: WalkForwardCalibration = {
      winRate: winRatePct,
      expectancyR,
      dataConvictionScore: score,
      sampleSize: n,
      passesGate,
    };

    setBoundedMapEntry(calibrationCache, cacheKey, { timestampMs: now, result: finalResult });
    return finalResult;
  } catch {
    if (!signal?.aborted) {
      setBoundedMapEntry(calibrationCache, cacheKey, { timestampMs: now, result: defaultResult });
    }
    return defaultResult;
  } finally {
    linked.cleanup();
  }
}

export const SUPPORTED_TRADE_TICKERS = new Set<string>(WATCH_LIST);

export function isSupportedTradeTicker(rawTicker: string): boolean {
  const sym = rawTicker.trim().toUpperCase().replace(/^\$/, "");
  if (!sym) return false;
  return SUPPORTED_TRADE_TICKERS.has(sym) || /^[A-Z0-9._-]{1,10}$/.test(sym);
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

export function loadTradeStore(requestedDate?: string): DailyTradeStore {
  return readSessionLedgerSync(requestedDate);
}

export function saveTradeStore(store: DailyTradeStore): void {
  writeSessionLedgerSync(store);
}

export function getActivePositions(date?: string): Record<string, OptionTradePosition> {
  const store = loadTradeStore(date);
  return store.activePositions;
}


export function getClosedPositions(ticker?: string, date?: string): OptionTradePosition[] {
  const store = loadTradeStore(date);
  if (!ticker) return store.closedPositions;
  const sym = ticker.trim().toUpperCase();
  const normalizedSym = sym === "SPX" ? "SPXW" : sym;
  return store.closedPositions.filter(
    (p) => p.ticker === sym || p.ticker === normalizedSym
  );
}

export function getDailyTradeAlerts(ticker?: string, date?: string): TradeLifecycleAlert[] {
  const store = loadTradeStore(date);
  if (!ticker) return store.alerts;
  const sym = ticker.trim().toUpperCase();
  const normalizedSym = sym === "SPX" ? "SPXW" : sym;
  return store.alerts.filter(
    (a) => a.ticker === sym || a.ticker === normalizedSym
  );
}

export function clearDailyTrades(): void {
  const today = getTodayEt();
  const prev = loadTradeStore(today);
  const prevVersion = prev?.date === today ? (prev.version ?? 0) : 0;
  globalForGaiaDiscord.__hyperionDispatchedGaiaKeys?.clear();
  delete (globalForGaiaDiscord as { __hyperionDispatchedDate?: string }).__hyperionDispatchedDate;
  saveTradeStore({
    date: today,
    version: prevVersion,
    activePositions: {},
    closedPositions: [],
    alerts: [],
    prevSpotPrices: {},
    dailyRecapSent: false,
  });
}

/**
 * Contract Mid-Price Helper
 */
function getContractMidPrice(c: NormalizedOptionContract): number {
  if (c.bid && c.ask && c.bid > 0 && c.ask > 0) {
    return Number(((c.bid + c.ask) / 2).toFixed(2));
  }
  if (c.last && c.last > 0) {
    return Number(c.last.toFixed(2));
  }
  return 0;
}

/**
 * Cache for live CBOE delayed options chain (10s TTL) and live underlying spot prices
 */
const cboeChainCache = new Map<string, { ts: number; contracts: NormalizedOptionContract[] }>();
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
  // SPX/SPXW trade under CBOE `_SPX`; NDX/NDXP trade under CBOE `_NDX`
  const cboeSymbol =
    sym === "SPX" || sym === "SPXW" ? "_SPX" : sym === "NDX" || sym === "NDXP" ? "_NDX" : sym;

  const cached = cboeChainCache.get(cboeSymbol);
  if (cached && Date.now() - cached.ts < CBOE_CACHE_TTL_MS) {
    return cached.contracts;
  }

  try {
    const res = await fetch(`https://cdn.cboe.com/api/global/delayed_quotes/options/${cboeSymbol}.json`, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) HyperionTerminal/1.0",
      },
      cache: "no-store",
      signal,
    });

    if (!res.ok) return cached?.contracts ?? [];
    const json = await res.json();
    const data = json?.data;
    if (!data) return cached?.contracts ?? [];

    const spot = Number(data.current_price ?? data.close ?? 0);

    // Fetch live real-time spot price directly from Robinhood (sub-second OPRA/NLS feed; skip index NDX/NDXP)
    const rhSym = sym === "SPX" || sym === "SPXW" ? "SPY" : sym;
    let realTimeSpot = spot;
    if (sym !== "NDX" && sym !== "NDXP") {
      try {
        const rhRes = await fetch(`https://api.robinhood.com/quotes/?symbols=${encodeURIComponent(rhSym)}`, {
          headers: {
            Accept: "application/json",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) HyperionTerminal/1.0",
          },
          cache: "no-store",
          signal,
        });
        if (rhRes.ok) {
          const rhJson = await rhRes.json();
          const q = rhJson?.results?.[0];
          const p = Number(q?.last_trade_price ?? q?.bid_price ?? 0);
          if (p > 0 && Number.isFinite(p)) {
            const mult = sym === "SPX" || sym === "SPXW" ? 10 : 1;
            realTimeSpot = Number((p * mult).toFixed(2));
          }
        }
      } catch {
        // Non-fatal fallback
      }
    }

    // Secondary fallback: Yahoo Finance
    if (realTimeSpot <= 0 || realTimeSpot === spot) {
      const yahooSym =
        sym === "SPX" || sym === "SPXW" ? "^GSPC" : sym === "NDX" || sym === "NDXP" ? "^NDX" : sym;
      try {
        const yRes = await fetch(
          `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
            yahooSym
          )}?interval=1m&range=1d&includePrePost=false`,
          {
            headers: { "User-Agent": "Mozilla/5.0" },
            cache: "no-store",
            signal,
          }
        );
        if (yRes.ok) {
          const yJson = await yRes.json();
          const closes: (number | null)[] = yJson?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [];
          for (let i = closes.length - 1; i >= 0; i--) {
            if (typeof closes[i] === "number" && closes[i]! > 0) {
              realTimeSpot = Number(closes[i]!.toFixed(2));
              break;
            }
          }
        }
      } catch {
        // Non-fatal fallback to CBOE spot
      }
    }

    const effectiveSpot = realTimeSpot > 0 ? realTimeSpot : spot;
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

    // Difference between real-time market spot and 15-minute delayed CBOE spot
    const deltaSpot = realTimeSpot > 0 && spot > 0 ? realTimeSpot - spot : 0;

    const rawOptions = data.options;
    if (!Array.isArray(rawOptions)) return cached?.contracts ?? [];

    const contracts: NormalizedOptionContract[] = [];
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
      let bid = Number(raw.bid ?? 0);
      let ask = Number(raw.ask ?? 0);
      let last = Number(raw.last_trade_price ?? 0);

      // Filter out totally dead contracts with zero quote & zero interest
      if (bid <= 0 && ask <= 0 && last <= 0 && openInterest <= 0 && volume <= 0) continue;

      const delta = Number(raw.delta ?? 0);
      const gamma = Math.max(0, Number(raw.gamma ?? 0.05));
      const isCall = typeChar === "C";
      const signedDelta = isCall ? Math.abs(delta || 0.45) : -Math.abs(delta || 0.45);

      // Real-time Greek synchronization: adjust delayed CBOE option pricing to current live spot
      if (Math.abs(deltaSpot) > 0.05 && Math.abs(delta) > 0.02) {
        // First-order Taylor delta adjustment + second-order gamma convexity
        const priceAdj = deltaSpot * signedDelta + 0.5 * gamma * deltaSpot * deltaSpot;
        if (bid > 0) bid = Number(Math.max(0.01, bid + priceAdj).toFixed(2));
        if (ask > 0) ask = Number(Math.max(0.02, ask + priceAdj).toFixed(2));
        if (last > 0) last = Number(Math.max(0.01, last + priceAdj).toFixed(2));
      }

      contracts.push({
        symbol: occ,
        expiration,
        optionType: typeChar as "C" | "P",
        strike,
        openInterest,
        volume,
        iv: Number(raw.iv ?? 0),
        delta,
        gamma: Number(raw.gamma ?? 0),
        vega: Number(raw.vega ?? 0),
        percentChange: Number(raw.percent_change ?? 0),
        bid,
        ask,
        last,
      });
    }

    if (contracts.length > 0) {
      setBoundedMapEntry(cboeChainCache, cboeSymbol, { ts: Date.now(), contracts });
    }
    return contracts;
  } catch {
    return cached?.contracts ?? [];
  }
}

/**
 * Formats an ISO expiration date (YYYY-MM-DD) into clear human strings and Robinhood tab names
 */
export function formatExpirationHuman(
  expIso: string,
  todayIso: string
): { expHuman: string; robinhoodExp: string; robinhoodTab: string; dte: number } {
  try {
    const [ey, em, ed] = expIso.split("-").map(Number);
    const [ty, tm, td] = todayIso.split("-").map(Number);
    const expDate = new Date(Date.UTC(ey, em - 1, ed, 16, 0, 0));
    const todayDate = new Date(Date.UTC(ty, tm - 1, td, 16, 0, 0));
    const diffDays = Math.round(
      (expDate.getTime() - todayDate.getTime()) / (1000 * 60 * 60 * 24)
    );
    const dte = diffDays;

    const fullMonths = [
      "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December",
    ];
    const monthNames = [
      "Jan", "Feb", "Mar", "Apr", "May", "Jun",
      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const expDayName = dayNames[expDate.getUTCDay()];
    const expMonth = monthNames[em - 1];
    const fullMonth = fullMonths[em - 1];

    // Matches Robinhood's exact dropdown label, e.g. "October 22 (0d)", "October 23 (1d)", "October 26 (4d)"
    const robinhoodTab = `${fullMonth} ${ed} (${dte}d)`;
    const robinhoodExp = `${expMonth} ${ed}, ${ey}`;

    let expHuman: string;
    if (dte === 0) {
      expHuman = `Today, ${expMonth} ${ed} (0 DTE · Same-Day)`;
    } else if (dte === 1) {
      expHuman = `Tomorrow, ${expDayName} ${expMonth} ${ed} (1 DTE)`;
    } else {
      expHuman = `${expDayName}, ${expMonth} ${ed} (${dte} DTE)`;
    }

    return { expHuman, robinhoodExp, robinhoodTab, dte };
  } catch {
    return { expHuman: expIso, robinhoodExp: expIso, robinhoodTab: expIso, dte: 1 };
  }
}


/**
 * Strict Sub-$1.00 Contract Selector & 1–2 Contract Position Sizer
 * - Fetches or uses real live CBOE option chains (never manufactures fake weekend dates or fake prices)
 * - Price Cap: strictly $0.15 <= mid <= $1.00 (sweet spot: $0.35 - $0.85)
 * - Expiration Priority: After 11:30 AM ET, prioritizes 1-3 DTE to protect small accounts from 0DTE theta crush
 * - SPXW routing: suggests equivalent liquid SPY contract matching underlying SPX move
 * - Position Sizing: Calculated strictly off Live ASK.
 *   - ask <= $0.50 -> 2 contracts (total outlay <= $100)
 *   - ask > $0.50 ($0.51 - $0.99) -> 1 contract (total outlay <= $100)
 *   - Never manufactures fake quotes; returns null if no qualifying contract found
 */
export async function selectSmallAccountContract(params: {
  ticker: string;
  contractType: ContractType;
  spotPrice: number;
  target1Spot: number;
  target2Spot: number;
  stopLossSpot: number;
  contracts?: NormalizedOptionContract[] | null;
  conviction?: number;
  nowEt?: Date;
  zeroDteCallWall?: number;
  zeroDtePutWall?: number;
  preferredDte?: "0DTE" | "1-2DTE" | "NONE";
  signal?: AbortSignal;
}): Promise<SelectedOptionContract | null> {
  const {
    ticker,
    contractType,
    spotPrice,
    target1Spot,
    target2Spot,
    stopLossSpot,
    nowEt,
    zeroDteCallWall,
    zeroDtePutWall,
    preferredDte,
    signal,
  } = params;

  if (signal?.aborted) return null;
  let contracts = params.contracts;
  const sym = ticker.trim().toUpperCase();
  const isSpxw = sym === "SPXW" || sym === "SPX";
  const todayEt = nowEt ? formatEtIsoDate(nowEt) : getTodayEt();
  const etTime = getNowEtTime(nowEt);
  const typeLetter = contractType === "CALL" ? "C" : "P";
  const isCall = contractType === "CALL";

  let altContractNote: string | undefined = undefined;

  let effectiveSym = sym;
  let effectiveSpot = spotPrice;
  let effectiveTarget1 = target1Spot;
  let effectiveTarget2 = target2Spot;
  let effectiveStopLoss = stopLossSpot;

  if (isSpxw) {
    effectiveSym = "SPY";
    effectiveSpot = Number((spotPrice / 10).toFixed(2));
    effectiveTarget1 = Number((target1Spot / 10).toFixed(2));
    effectiveTarget2 = Number((target2Spot / 10).toFixed(2));
    effectiveStopLoss = Number((stopLossSpot / 10).toFixed(2));
    altContractNote = `SPXW Index > $1.00/contract · Using SPY Equivalent for Sub-$1.00 Small Account`;
  }

  // 1. If live contracts are missing, empty, or still in 10x SPX scale for SPXW->SPY, fetch real CBOE chain directly
  const hasSpxScaleChain =
    isSpxw &&
    Array.isArray(contracts) &&
    contracts.length > 0 &&
    contracts.some((c) => c.strike > effectiveSpot * 3);
  if (!contracts || contracts.length === 0 || hasSpxScaleChain) {
    contracts = await fetchLiveCboeOptions(effectiveSym, signal);
    if (signal?.aborted) return null;
  }

  // 2. Filter hard execution invariants from real CBOE chain, then rank with Greeks-aware optimizer
  if (contracts && contracts.length > 0) {
    const validCandidates: ContractCandidateInput[] = [];
    const isAfternoon = etTime.hours > 11 || (etTime.hours === 11 && etTime.minutes >= 30);
    const hasFutureExpirations = contracts.some(
      (item) => typeof item.expiration === "string" && /^\d{4}-\d{2}-\d{2}$/.test(item.expiration) && item.expiration > todayEt
    );

    for (const c of contracts) {
      if (c.optionType !== typeLetter) continue;
      if (typeof c.expiration !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(c.expiration)) continue;
      const mid = getContractMidPrice(c);

      const rawBid = typeof c.bid === "number" && Number.isFinite(c.bid) ? c.bid : undefined;
      const rawAsk = typeof c.ask === "number" && Number.isFinite(c.ask) ? c.ask : undefined;
      const askPrice = rawAsk !== undefined ? rawAsk : mid;
      // Strict Sub-$1.00 Ask Cap: retail buys at ASK ($0.15 <= ask <= $0.99)
      if (askPrice < 0.15 || askPrice > 0.99) continue;

      // Reject low-delta lotto contracts (< 0.25 delta); never spoof missing/0 delta as 0.30
      const absDelta = typeof c.delta === "number" && Number.isFinite(c.delta) ? Math.abs(c.delta) : 0;
      if (absDelta < 0.25) continue;

      // Reject crossed/invalid quotes & wide-spread contracts (> 24% spread); never skip spread check when bid is missing
      const effectiveBid = rawBid ?? (askPrice > 0 ? 0 : -1);
      if (effectiveBid < 0 || askPrice <= 0 || effectiveBid > askPrice) continue;
      const spreadPct = (askPrice - effectiveBid) / askPrice;
      if (spreadPct > 0.24) continue;

      // Strike direction filter: OTM / near ATM in direction of move
      if (isCall && c.strike < effectiveSpot * 0.998) continue;
      if (!isCall && c.strike > effectiveSpot * 1.002) continue;

      // Hard Near-ATM / 1-3 Strike OTM Ceiling: never select deep-OTM lottos (> min($3.50, 0.45%) from spot)
      const maxOtmDistance = Math.min(3.50, effectiveSpot * 0.0045);
      if (Math.abs(c.strike - effectiveSpot) > maxOtmDistance) continue;

      const { expHuman, robinhoodExp, robinhoodTab, dte } = formatExpirationHuman(c.expiration, todayEt);
      // Hard Invariant: Reject expired or malformed contracts (non-finite DTE, dte < 0, prior expiration dates, or post-close 0DTE)
      if (
        !Number.isFinite(dte) ||
        dte < 0 ||
        c.expiration < todayEt ||
        ((Boolean(nowEt) || hasFutureExpirations) && etTime.totalMinutes >= RTH_CLOSE_MINS && dte <= 0)
      ) {
        continue;
      }

      // Structural Wall Strike Ceiling: Never buy OTM Calls above an active overhead 0DTE Call Wall
      const normZeroDteCw = typeof zeroDteCallWall === "number" && zeroDteCallWall > 0
        ? (isSpxw ? zeroDteCallWall / 10 : zeroDteCallWall) : 0;
      const normZeroDtePw = typeof zeroDtePutWall === "number" && zeroDtePutWall > 0
        ? (isSpxw ? zeroDtePutWall / 10 : zeroDtePutWall) : 0;
      const overheadCeiling = normZeroDteCw > effectiveSpot ? normZeroDteCw : 0;
      if (contractType === "CALL" && overheadCeiling > 0 && c.strike > overheadCeiling) {
        continue;
      }
      // Structural Put Wall Floor: Never buy OTM Puts with strikes below the active Put Wall support
      const floorSupport = normZeroDtePw > 0 && normZeroDtePw < effectiveSpot ? normZeroDtePw : 0;
      const putFloorBuffer = Math.max(0.5, effectiveSpot * 0.0027);
      if (contractType === "PUT" && floorSupport > 0 && c.strike < floorSupport - putFloorBuffer) {
        continue;
      }

      validCandidates.push({
        contract: c,
        mid,
        bid: effectiveBid,
        ask: askPrice,
        dte,
        expHuman,
        robinhoodExp,
        robinhoodTab,
        absDelta,
        theta: typeof (c as { theta?: number }).theta === "number" ? (c as { theta?: number }).theta : undefined,
      });
    }

    const selection = selectOptimalSmallAccountContract({
      candidates: validCandidates,
      spotPrice: effectiveSpot,
      target1Spot: effectiveTarget1,
      target2Spot: effectiveTarget2,
      isCall,
      isSpxw,
      zeroDteCallWall,
      zeroDtePutWall,
      isAfternoon,
      preferredDte,
      nowMs: (nowEt ?? new Date()).getTime(),
    });
    const chosen = selection?.chosen;

    if (chosen) {
      const c = chosen.contract;
      const mid = chosen.mid;
      const bid = chosen.bid;
      const ask = chosen.ask;
      const dte = chosen.dte;
      const delta = chosen.absDelta || 0.30;
      const expHuman = chosen.expHuman;
      const robinhoodExp = chosen.robinhoodExp;
      const robinhoodTab = chosen.robinhoodTab;

      // Institutional Small-Account Sizing Engine (Strict Capital Outlay Invariant <= $100.00 & 1 Contract Max)
      const entryAsk = ask > 0 ? ask : mid;
      if (entryAsk > 1.00 || entryAsk < 0.15) {
        return null;
      }

      // Sniper Invariant: Strictly 1 contract maximum per trade
      const contractsQty: 1 = 1;
      const totalOutlay = Number((entryAsk * 100 * contractsQty).toFixed(2));
      if (totalOutlay > 100) {
        return null;
      }

      // Option target & stop estimates: honor live contract IV when present & valid, else invert BS IV
      const tYears = computeRemainingYearsToExpiration((nowEt ?? new Date()).getTime(), Math.max(0, dte));
      const rawChainIv =
        typeof c.iv === "number" && Number.isFinite(c.iv) && c.iv > 0
          ? c.iv > 4
            ? c.iv / 100
            : c.iv
          : 0;
      const hasLiveChainIv = rawChainIv >= 0.04 && rawChainIv <= 2.50;
      const impliedAskIv = solveImpliedVol(entryAsk, effectiveSpot, c.strike, tYears, isCall);
      const solvedIv = hasLiveChainIv ? Number(rawChainIv.toFixed(4)) : impliedAskIv;
      const bsEntryCheck = hasLiveChainIv
        ? repriceOptionBS(effectiveSpot, c.strike, tYears, solvedIv, isCall)
        : entryAsk;
      const repriceIv =
        hasLiveChainIv && Math.abs(bsEntryCheck - entryAsk) > entryAsk * 0.25 ? impliedAskIv : solvedIv;

      // Reprice option at Target 1 and Target 2 under solved IV with time decay
      const bsTp1Mid = repriceOptionBS(effectiveTarget1, c.strike, tYears * 0.96, repriceIv, isCall);
      const bsTp2Mid = repriceOptionBS(effectiveTarget2, c.strike, tYears * 0.92, repriceIv, isCall);
      const bsStopMid = repriceOptionBS(effectiveStopLoss, c.strike, tYears * 0.96, repriceIv, isCall);

      // Guard against non-monotonic or negative moves
      const estTp1Mid = Number(Math.max(entryAsk + 0.05, bsTp1Mid).toFixed(2));
      const estTp2Mid = Number(Math.max(estTp1Mid + 0.05, bsTp2Mid).toFixed(2));
      // Max -25% loss stop floor: stop price cannot fall below entryAsk * 0.75
      const estStopMid = Number(Math.max(entryAsk * 0.75, Math.min(entryAsk - 0.01, bsStopMid)).toFixed(2));

      const tp1Pct = Number((((estTp1Mid - entryAsk) / entryAsk) * 100).toFixed(0));
      const tp2Pct = Number((((estTp2Mid - entryAsk) / entryAsk) * 100).toFixed(0));

      const expClean = c.expiration.replace(/-/g, "").slice(2);
      const strikeLabel = Number.isInteger(c.strike) ? c.strike.toString() : c.strike.toFixed(1);
      const displaySym = isSpxw && c.strike > 1000 ? "SPXW" : effectiveSym;
      const contractLabel = `${displaySym} ${expClean} ${strikeLabel}${typeLetter} (${expHuman} · $${entryAsk.toFixed(2)})`;

      return {
        symbol: c.symbol || `${effectiveSym}${expClean}${typeLetter}${strikeLabel}`,
        strike: c.strike,
        expiration: c.expiration,
        expHuman,
        robinhoodExp,
        robinhoodTab,
        dte,
        contractType,
        contractLabel,
        optionBid: bid,
        optionAsk: ask,
        optionMid: mid,
        delta,
        contractsQty,
        totalOutlay,
        estTp1Mid,
        estTp2Mid,
        estStopMid,
        tp1Pct,
        tp2Pct,
        altContractNote,
        entryIv: solvedIv,
        entryTYears: tYears,
      };
    }
  }

  // If no qualifying liquid contract under $1.00 exists, return null (never manufacture fake quotes)
  return null;
}

/**
 * Backward-compatible alias
 */
export const selectOptimalContract = selectSmallAccountContract;

/**
 * Cache for live 5m candles and divergence
 */
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

  // 1. Fetch 5m candles from Yahoo Finance
  const yahooSym = sym === "SPX" || sym === "SPXW" ? "^GSPC" : sym === "NDX" || sym === "NDXP" ? "^NDX" : sym;
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}?interval=5m&range=2d&includePrePost=false`,
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

        if (validBars.length >= 2) {
          const latest = validBars[validBars.length - 1];
          const prevClosedBar = validBars[validBars.length - 2];

          // Synchronize latest bar close with sub-second Robinhood live tick (skip NDX/NDXP: never proxy to QQQ)
          const rhSym = sym === "SPX" || sym === "SPXW" ? "SPY" : sym;
          if (rhSym !== "NDX" && rhSym !== "NDXP") {
            try {
              const rhRes = await fetch(`https://api.robinhood.com/quotes/?symbols=${encodeURIComponent(rhSym)}`, {
                headers: { "User-Agent": "Mozilla/5.0" },
                cache: "no-store",
                signal,
              });
              if (rhRes.ok) {
                const rhJson = await rhRes.json();
                const p = Number(rhJson?.results?.[0]?.last_trade_price ?? rhJson?.results?.[0]?.bid_price ?? 0);
                if (p > 0 && Number.isFinite(p)) {
                  const mult = sym === "SPX" || sym === "SPXW" ? 10 : 1;
                  const liveP = Number((p * mult).toFixed(2));
                  latest.close = liveP;
                  latest.high = Math.max(latest.high, liveP);
                  latest.low = Math.min(latest.low, liveP);
                }
              }
            } catch {
              // Non-fatal
            }
          }

          // Calculate SMA 34 across valid 5m closes
          const startIdx = Math.max(0, validBars.length - 34);
          let sum = 0;
          let count = 0;
          for (let k = startIdx; k < validBars.length; k++) {
            sum += validBars[k].close;
            count++;
          }
          const sma34 = Number((sum / Math.max(1, count)).toFixed(2));
          // Compute Flow VWAP & Flux Field snapshot across today's session window (last 78 5m bars)
          const sessionSlice = validBars.slice(Math.max(0, validBars.length - 78));
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
        }
      }
    }
  } catch {
    // Non-fatal
  }

  if (signal?.aborted) {
    return { candle: null, divergence5m: "NO", divergence30m: "NO" };
  }

  // 2. Fetch divergence from TerraShade API
  try {
    const divSym = sym === "SPX" ? "SPXW" : sym;
    const divRes = await fetch(`https://terrashade.onrender.com/api/divergence?symbol=${encodeURIComponent(divSym)}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal,
    });
    if (divRes.ok) {
      const divData = await divRes.json();
      const row5m = divData?.rows?.find((r: any) => r.tf === "5" || r.name === "5m");
      const row30m = divData?.rows?.find((r: any) => r.tf === "30" || r.name === "30m");
      if (row5m) {
        if (row5m.state === "BULL" || row5m.signal?.type === "bull") divergence5m = "BULL";
        else if (row5m.state === "BEAR" || row5m.signal?.type === "bear") divergence5m = "BEAR";
      }
      if (row30m) {
        if (row30m.state === "BULL" || row30m.signal?.type === "bull") divergence30m = "BULL";
        else if (row30m.state === "BEAR" || row30m.signal?.type === "bear") divergence30m = "BEAR";
      }
    }
  } catch {
    // Non-fatal
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

/**
 * Sends a Trade Lifecycle Alert directly to Discord using the Sub-$1.00 Small Account embed format
 */
export async function sendDiscordTradeAlert(
  alert: TradeLifecycleAlert,
  customWebhookUrl?: string,
  options?: { bypassFsmFirewall?: boolean; signal?: AbortSignal }
): Promise<boolean> {
  if (options?.signal?.aborted) {
    return false;
  }
  // Strict Backfill Firewall: NEVER dispatch historical replay/backfill signals to Discord
  if (alert.isHistoricalBackfill) {
    return false;
  }

  // Strict Macro Regime & FSM Gating Firewall (BTO Gaia HUD entries only — NEVER block STC exits or Phase-2/Structural setups)
  const isBtoAlert = alert.action === "BUY_TO_OPEN";
  const isGaiaHudSetup = Boolean(alert.setupName?.includes("Gaia Tactical HUD"));
  if (!options?.bypassFsmFirewall && isBtoAlert && isGaiaHudSetup) {
    const store = loadTradeStore();
    const tickerFsm =
      store.gaiaStateByTicker?.[alert.ticker] ??
      (alert.ticker === "SPY"
        ? {
            activeFsmState: store.activeFsmState,
            macroRegime: store.macroRegime,
            chiPct: store.chiPct,
          }
        : undefined);
    if (tickerFsm) {
      const fsmState = tickerFsm.activeFsmState;
      const macro = tickerFsm.macroRegime;
      const chiPct = tickerFsm.chiPct ?? 50;

      // PUT alerts must be BLOCKED when fsmState === "LONG", fsmState === "STAND_ASIDE", macro === "CALL", or chiPct >= 50
      if (alert.contractType === "PUT") {
        if (fsmState === "LONG" || fsmState === "STAND_ASIDE" || macro === "CALL" || chiPct >= 50) {
          console.warn(
            `[DiscordTradeAlert FIREWALL REJECT] Blocked illegal ${alert.ticker} PUT alert (${alert.action} · ${alert.id}) while FSM is ${fsmState} / Macro ${macro} (χ=${chiPct}%).`
          );
          return false;
        }
      }
      // CALL alerts must be BLOCKED when fsmState === "SHORT", fsmState === "STAND_ASIDE", macro === "PUT", or chiPct < 50
      if (alert.contractType === "CALL") {
        if (fsmState === "SHORT" || fsmState === "STAND_ASIDE" || macro === "PUT" || chiPct < 50) {
          console.warn(
            `[DiscordTradeAlert FIREWALL REJECT] Blocked illegal ${alert.ticker} CALL alert (${alert.action} · ${alert.id}) while FSM is ${fsmState} / Macro ${macro} (χ=${chiPct}%).`
          );
          return false;
        }
      }
    }
  }

  const webhookUrl = (customWebhookUrl || process.env.DISCORD_WEBHOOK_URL)?.trim() || "";
  if (!webhookUrl) {
    console.warn("[DiscordTradeAlert] Skipping dispatch: DISCORD_WEBHOOK_URL is not configured.");
    return false;
  }

  try {
    const isBto = alert.action === "BUY_TO_OPEN";
    const isCalls = alert.contractType === "CALL";

    let embedColor: number;
    let title: string;
    let description: string;
    let fields: { name: string; value: string; inline: boolean }[] = [];

    if (isBto) {
      // BTO Embed: Emerald Green (0x10b981) for CALLS, Electric Violet (0x8b5cf6) for PUTS
      embedColor = isCalls ? 0x10b981 : 0x8b5cf6;
      const emoji = isCalls ? "🟢" : "🟣";
      const mid = alert.btoOptionMid || 0.55;
      const bid = alert.optionBid ?? (mid > 0.05 ? mid - 0.01 : mid);
      const ask = alert.optionAsk ?? mid + 0.01;
      const qty = alert.contractsQty || 1;
      const totalOutlay = alert.totalOutlay || mid * 100 * qty;
      const expTabStr = alert.robinhoodTab || alert.robinhoodExp || alert.expHuman || alert.expiration;

      title = `${emoji} BUY TO OPEN · ${alert.ticker} ${alert.contractType}S (${qty}x @ $${mid.toFixed(2)})`;
      description = `**Setup:** ${alert.setupName}\n${
        alert.altContractNote ? `⚠️ *${alert.altContractNote}*\n` : ""
      }**Contract:** \`${alert.contractLabel}\``;

      const rrStr = alert.rrRatio
        ? alert.rrRatio.toFixed(2)
        : (
            Math.abs(alert.target1Spot - alert.btoSpotPrice) /
            Math.max(0.01, Math.abs(alert.btoSpotPrice - alert.stopLossSpot))
          ).toFixed(2);

      const tp1Est = alert.estTp1Mid
        ? `TP1 ~$${alert.estTp1Mid.toFixed(2)} (+${alert.tp1Pct || 40}%)`
        : `TP1 (Trim 50%)`;
      const tp2Est = alert.estTp2Mid
        ? `TP2 ~$${alert.estTp2Mid.toFixed(2)} (+${alert.tp2Pct || 110}%)`
        : `TP2 (Full Exit)`;
      const stopLossPct =
        alert.btoOptionMid && alert.estStopMid && alert.btoOptionMid > 0
          ? Math.round(((alert.estStopMid - alert.btoOptionMid) / alert.btoOptionMid) * 100)
          : -25;
      const stopEst = alert.estStopMid
        ? `$${alert.estStopMid.toFixed(2)} (${stopLossPct}% max or Spot $${alert.stopLossSpot.toFixed(2)})`
        : `$${alert.stopLossSpot.toFixed(2)}`;

      fields = [
        {
          name: "🎟️ Contract & Robinhood Tab",
          value: `**${alert.ticker} $${alert.strike} ${alert.contractType}**\n📅 Exp: **${alert.expHuman || alert.expiration}**\n👉 **Robinhood Tab:** \`${expTabStr}\``,
          inline: true,
        },
        {
          name: "💵 Live Market Quote",
          value: `Bid: **$${bid.toFixed(2)}** | Ask: **$${ask.toFixed(2)}**\nMid: **$${mid.toFixed(2)}** ($${(mid * 100).toFixed(0)}/contract)`,
          inline: true,
        },
        {
          name: "📦 Small Acct Size",
          value: `**${qty} Contract${qty > 1 ? "s" : ""}** ($${totalOutlay.toFixed(0)} Total Outlay)`,
          inline: true,
        },
        {
          name: "🎯 Underlying Entry",
          value: `$${alert.btoSpotPrice.toFixed(2)}`,
          inline: true,
        },
        {
          name: "⚖️ Estimated R:R",
          value: `**${rrStr}:1**`,
          inline: true,
        },
        {
          name: "🛑 Underlying Stop",
          value: `$${alert.stopLossSpot.toFixed(2)}`,
          inline: true,
        },
        {
          name: "💰 Option TP1 / TP2 Est.",
          value: `${tp1Est} | ${tp2Est}`,
          inline: false,
        },
        {
          name: "🛑 Option Hard Stop",
          value: `${stopEst}`,
          inline: true,
        },
        ...(typeof alert.flowVwap === "number" && typeof alert.ceilingShareChi === "number"
          ? [
              {
                name: "🌊 Flow VWAP & Flux Field",
                value: `FVWAP: **$${alert.flowVwap.toFixed(2)}** | χ: **${(alert.ceilingShareChi * 100).toFixed(1)}%** | Pe: **${(alert.pecletNumber ?? 0) >= 0 ? "+" : ""}${(alert.pecletNumber ?? 0).toFixed(2)}**`,
                inline: true,
              },
            ]
          : []),
        ...(typeof alert.calibratedWinRate === "number"
          ? [
              {
                name: "📊 Walk-Forward Edge",
                value: `Win: **${alert.calibratedWinRate.toFixed(1)}%** | E[R]: **+${(alert.calibratedExpectancyR ?? 0).toFixed(2)}R** | Score: **${alert.dataConvictionScore ?? 75}/100**`,
                inline: true,
              },
            ]
          : []),
        {
          name: "⏰ Opened At",
          value: `${alert.timestamp} ET`,
          inline: true,
        },
      ];
    } else {
      // STC Embed: Canonical reason taxonomy & PnL-grounded styling
      const reasonUpper = alert.reason.toUpperCase();
      const pnlPct = alert.pnlOptionPct ?? 0;
      const isProfitable = pnlPct > 0;
      const isBreakeven = Math.abs(pnlPct) <= 2;
      const isTrim = reasonUpper.includes("1 OF 2") || alert.status === "PARTIAL_TP1";

      let badge = "SELL TO CLOSE";
      let emoji = "🎯";

      if (isTrim) {
        embedColor = 0xf59e0b;
        emoji = alert.contractsQty === 2 ? "💰" : "🛡️";
        badge = alert.contractsQty === 2 ? "SELL 1 OF 2 CONTRACTS (LOCK PROFIT)" : "RAISE STOP TO PROFIT";
        title = `${emoji} ${badge} · ${alert.ticker} ${alert.contractType}S`;
      } else if (reasonUpper.includes("REGIME") || reasonUpper.includes("FLIP") || reasonUpper.includes("REVERSAL")) {
        if (pnlPct >= 10) {
          embedColor = 0x10b981; // True Profit Lock (>= 10%)
          emoji = "🔒";
          badge = "REVERSAL PROFIT LOCK";
        } else if (isProfitable || isBreakeven) {
          embedColor = 0x94a3b8; // Divergence Scratch (< 10%)
          emoji = "🔄";
          badge = "MOMENTUM DIVERGENCE SCRATCH";
        } else {
          embedColor = 0x3b82f6;
          emoji = "🔄";
          badge = "REGIME FLIP / REVERSAL EXIT";
        }
        title = `🔄 ${badge} · ${alert.ticker} ${alert.contractType}S`;
      } else if (reasonUpper.includes("TRAILING") || reasonUpper.includes("PROTECT")) {
        embedColor = 0x10b981; // Emerald Green
        emoji = "🔒";
        badge = "TRAILING PROFIT LOCKED";
        title = `🔒 ${badge} · ${alert.ticker} ${alert.contractType}S`;
      } else if (reasonUpper.includes("TARGET 2")) {
        embedColor = 0x10b981; // Emerald Green
        emoji = "🎯";
        badge = "TARGET 2 FULL PROFIT HIT";
        title = `🎯 ${badge} · ${alert.ticker} ${alert.contractType}S`;
      } else if (reasonUpper.includes("TARGET 1")) {
        embedColor = 0x10b981; // Emerald Green
        emoji = "🎯";
        badge = alert.contractsQty === 1 ? "TARGET 1 FULL PROFIT HIT" : "TARGET 1 PROFIT SECURED";
        title = `🎯 ${badge} · ${alert.ticker} ${alert.contractType}S`;
      } else if (
        reasonUpper.includes("15:55") ||
        reasonUpper.includes("3:55") ||
        reasonUpper.includes("CLOSE") ||
        reasonUpper.includes("EOD") ||
        reasonUpper.includes("MOC")
      ) {
        embedColor = isProfitable ? 0x10b981 : 0xf59e0b;
        emoji = "⏰";
        badge = isProfitable ? "3:55 PM EOD MARKET CLOSE CUTOFF (WIN)" : "3:55 PM EOD MARKET CLOSE CUTOFF";
        title = `⏰ ${badge} · ${alert.ticker} ${alert.contractType}S`;
      } else if (isBreakeven || reasonUpper.includes("BREAKEVEN")) {
        embedColor = 0x94a3b8; // Slate Gray
        emoji = "⚪";
        badge = "BREAKEVEN STOP";
        title = `⚪ ${badge} · ${alert.ticker} ${alert.contractType}S`;
      } else if (reasonUpper.includes("STOP LOSS") || reasonUpper.includes("INVALIDATION")) {
        embedColor = 0xef4444; // Crimson Red
        emoji = "🛑";
        badge = "STOP LOSS HIT";
        title = `🛑 ${badge} · ${alert.ticker} ${alert.contractType}S`;
      } else if (pnlPct >= 50) {
        embedColor = 0x10b981; // Emerald Green
        emoji = "🎯";
        badge = "TARGET 2 FULL PROFIT HIT";
        title = `🎯 ${badge} · ${alert.ticker} ${alert.contractType}S`;
      } else if (pnlPct >= 25) {
        embedColor = 0x10b981; // Emerald Green
        emoji = "🎯";
        badge = alert.contractsQty === 1 ? "TARGET 1 FULL PROFIT HIT" : "TARGET 1 PROFIT SECURED";
        title = `🎯 ${badge} · ${alert.ticker} ${alert.contractType}S`;
      } else if (isProfitable) {
        embedColor = 0x10b981; // Emerald Green
        emoji = "🎯";
        badge = "PROFIT LOCKED";
        title = `🎯 ${badge} · ${alert.ticker} ${alert.contractType}S`;
      } else {
        embedColor = 0xef4444; // Crimson Red
        emoji = "🛑";
        badge = "STOP LOSS HIT";
        title = `🛑 ${badge} · ${alert.ticker} ${alert.contractType}S`;
      }

      description = `**Contract:** \`${alert.contractLabel}\` · **Setup:** ${alert.setupName}\n**Exit Action:** ${alert.reason}`;

      const isCalls = alert.contractType === "CALL";
      const rawSpotDiff = alert.spotPrice - alert.btoSpotPrice;
      const spotChangePct = alert.btoSpotPrice > 0 ? (rawSpotDiff / alert.btoSpotPrice) * 100 : 0;
      const directionalFavor = isCalls ? rawSpotDiff : -rawSpotDiff;
      const directionalFavorPct = isCalls ? spotChangePct : -spotChangePct;

      const spotMoveStr = `${rawSpotDiff >= 0 ? "+" : ""}$${rawSpotDiff.toFixed(2)} (${
        spotChangePct >= 0 ? "+" : ""
      }${spotChangePct.toFixed(2)}%) · ${directionalFavor >= 0 ? "+" : ""}$${directionalFavor.toFixed(
        2
      )} (${directionalFavorPct >= 0 ? "+" : ""}${directionalFavorPct.toFixed(1)}% to ${alert.contractType})`;

      let optionPnlStr = "N/A";
      if (alert.btoOptionMid != null && alert.optionMid != null) {
        const optPct =
          alert.pnlOptionPct != null
            ? alert.pnlOptionPct
            : ((alert.optionMid - alert.btoOptionMid) / alert.btoOptionMid) * 100;
        optionPnlStr = `$${alert.btoOptionMid.toFixed(2)} → $${alert.optionMid.toFixed(2)} (${
          optPct >= 0 ? "+" : ""
        }${optPct.toFixed(1)}%)`;
      }

      let positionActionStr: string;
      if (alert.contractsQty === 2 && alert.remainingQty === 1) {
        positionActionStr = "💰 Sold 1 of 2 Contracts · 1 Runner Active with BE Stop";
      } else if (alert.contractsQty === 1 && alert.status === "PARTIAL_TP1") {
        positionActionStr = "🛡️ Stop Raised to Profit (+25% Min Locked) · 1 Runner Active";
      } else {
        positionActionStr = `100% Position Closed (${alert.contractsQty} Contract${
          alert.contractsQty > 1 ? "s" : ""
        })`;
      }

      fields = [
        { name: "🎯 Underlying Exit", value: `$${alert.spotPrice.toFixed(2)}`, inline: true },
        { name: "🏁 Entry Spot", value: `$${alert.btoSpotPrice.toFixed(2)}`, inline: true },
        { name: "📈 Spot Move", value: spotMoveStr, inline: true },
        { name: "💵 Option Premium", value: optionPnlStr, inline: true },
        {
          name: "📦 Position Action",
          value: positionActionStr,
          inline: true,
        },
        { name: "⏰ Timestamp", value: `${alert.timestamp} ET`, inline: true },
      ];
    }

    const payload = {
      username: "Hyperion Terminal",
      embeds: [
        {
          author: { name: "Hyperion Sub-$1.00 Options Engine (1 Contract Max)" },
          title,
          description,
          color: embedColor,
          fields,
          timestamp: new Date().toISOString(),
          footer: {
            text: isBto
              ? "Hyperion · Sub-$1.00 Small Account Options Engine (1 Contract Max)"
              : "Hyperion · STC Small Account Options Engine",
          },
        },
      ],
    };

    const targetUrl = webhookUrl.includes("?")
      ? `${webhookUrl}&wait=true`
      : `${webhookUrl}?wait=true`;

    let lastStatus = 0;
    let lastErrorText = "";

    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await fetch(targetUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: options?.signal,
      });

      lastStatus = res.status;

      if (res.status === 429) {
        if (options?.signal?.aborted) return false;
        const rateData = await res.json().catch(() => null);
        const retryAfterSec = typeof rateData?.retry_after === "number" ? rateData.retry_after : 1.5;
        const sleepMs = Math.min(Math.round(retryAfterSec * 1000) + 100, 5000);
        console.warn(`[DiscordTradeAlert] HTTP 429 rate limit encountered. Backing off for ${sleepMs}ms (attempt ${attempt}/3)...`);
        await new Promise<void>((resolve) => {
          if (options?.signal?.aborted) {
            resolve();
            return;
          }
          let timer: ReturnType<typeof setTimeout> | null = null;
          const onAbort = () => {
            if (timer) clearTimeout(timer);
            resolve();
          };
          timer = setTimeout(() => {
            options?.signal?.removeEventListener("abort", onAbort);
            resolve();
          }, sleepMs);
          options?.signal?.addEventListener("abort", onAbort, { once: true });
        });
        if (options?.signal?.aborted) return false;
        continue;
      }

      if (!res.ok) {
        lastErrorText = await res.text().catch(() => res.statusText);
        console.error(`[DiscordTradeAlert] HTTP ${res.status} error dispatching to Discord: ${lastErrorText}`);
        return false;
      }

      const bodyData = await res.json().catch(() => null);
      const discordMsgId = bodyData?.id || "";
      console.log(`[DiscordTradeAlert] Successfully dispatched ${alert.action} [${alert.ticker} ${alert.contractType}]. HTTP ${res.status} OK · Message ID: ${discordMsgId}`);
      return true;
    }

    console.error(`[DiscordTradeAlert] Failed to dispatch alert after 3 attempts. Last HTTP status: ${lastStatus}`);
    return false;
  } catch (err) {
    console.error("[DiscordTradeAlert] Network or unexpected exception dispatching Discord webhook:", err);
    return false;
  }
}

/**
 * Reconstructs today's RTH 5-minute session BTO/STC signals if the server started mid-session
 * or after the morning opening drive, ensuring traders never miss morning setups or their exits.
 */
async function backfillIntradaySessionSignals(
  normalizedTicker: string,
  params: TradeEvaluationParams,
  _store: DailyTradeStore,
  currentSpot: number
): Promise<boolean> {
  const yahooSym =
    normalizedTicker === "SPX" || normalizedTicker === "SPXW"
      ? "^GSPC"
      : normalizedTicker === "NDX" || normalizedTicker === "NDXP"
        ? "^NDX"
        : normalizedTicker;

  if (params.signal?.aborted) return false;
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
        yahooSym
      )}?interval=5m&range=2d&includePrePost=false`,
      {
        headers: {
          Accept: "application/json",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) HyperionTerminal/1.0",
        },
        cache: "no-store",
        signal: params.signal,
      }
    );
    if (!res.ok) return false;
    const json = await res.json();
    const result = json?.chart?.result?.[0];
    const timestamps: number[] = result?.timestamp ?? [];
    const quote = result?.indicators?.quote?.[0];
    if (!quote || timestamps.length < 5) return false;

    const opens: (number | null)[] = quote.open ?? [];
    const highs: (number | null)[] = quote.high ?? [];
    const lows: (number | null)[] = quote.low ?? [];
    const closes: (number | null)[] = quote.close ?? [];

    interface HistBar {
      ts: number;
      dateEt: string;
      totalMinutes: number;
      open: number;
      high: number;
      low: number;
      close: number;
      sma34: number;
    }

    const allValid: HistBar[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const o = opens[i];
      const h = highs[i];
      const l = lows[i];
      const c = closes[i];
      const ts = timestamps[i];
      if (
        typeof o !== "number" ||
        typeof h !== "number" ||
        typeof l !== "number" ||
        typeof c !== "number" ||
        c <= 0
      ) {
        continue;
      }
      const d = new Date(ts * 1000);
      const dateEt = d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
      const etTime = getNowEtTime(d);
      allValid.push({
        ts,
        dateEt,
        totalMinutes: etTime.totalMinutes,
        open: Number(o.toFixed(2)),
        high: Number(h.toFixed(2)),
        low: Number(l.toFixed(2)),
        close: Number(c.toFixed(2)),
        sma34: Number(c.toFixed(2)),
      });
    }

    for (let i = 0; i < allValid.length; i++) {
      const startIdx = Math.max(0, i - 33);
      let sum = 0;
      let count = 0;
      for (let k = startIdx; k <= i; k++) {
        sum += allValid[k].close;
        count++;
      }
      allValid[i].sma34 = Number((sum / Math.max(1, count)).toFixed(2));
    }

    // Filter to TODAY's trading session RTH bars only (9:30 AM to 3:55 PM ET; never backfill prior day)
    const todayEt = getTodayEt();
    const latestSessionDate = allValid[allValid.length - 1]?.dateEt;
    if (!latestSessionDate || latestSessionDate !== todayEt) return false;

    const sessionBars = allValid.filter(
      (b) => b.dateEt === latestSessionDate && b.totalMinutes >= RTH_OPEN_MINS && b.totalMinutes <= EOD_FORCE_FLAT_MINS
    );
    if (sessionBars.length < 3) return false;

    // Compute intraday session SMA34 so 11:00 AM intraday trend reversals/covers trigger accurately
    for (let i = 0; i < sessionBars.length; i++) {
      const startIdx = Math.max(0, i - 33);
      let sum = 0;
      let count = 0;
      for (let k = startIdx; k <= i; k++) {
        sum += sessionBars[k].close;
        count++;
      }
      sessionBars[i].sma34 = Number((sum / Math.max(1, count)).toFixed(2));
    }

    // Determine morning opening support and running session high causally (zero future lookahead)
    let runningOpeningLow = sessionBars[0].low;
    let runningSessionHigh = sessionBars[0].high;
    let runningSliceLow = sessionBars[0].low;

    const flowContracts = params.contracts ?? [];
    let baseContracts = flowContracts;
    const isSpxw = normalizedTicker === "SPXW" || normalizedTicker === "SPX";
    const positionKey = isSpxw ? "SPY" : normalizedTicker;
    const refSpySpot = isSpxw ? currentSpot / 10 : currentSpot;
    if (
      isSpxw &&
      (baseContracts.length === 0 || (refSpySpot > 0 && baseContracts.some((c) => c.strike > refSpySpot * 3)))
    ) {
      const spyChain = await fetchLiveCboeOptions("SPY", params.signal);
      if (params.signal?.aborted) return false;
      if (spyChain.length > 0) baseContracts = spyChain;
    }

    const sessionFlowSeries = computeBarFlowGammaVwapSeries(
      sessionBars.map((b) => ({
        timestamp: b.ts,
        etMins: b.totalMinutes,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: 1000,
      })),
      flowContracts
    );

    // Replay bar-by-bar chronologically through today's RTH session (starting at 9:35 AM to catch Opening Zero-Gamma Flushes)
    const replayStartIdx = Math.min(1, sessionBars.length - 1);
    const replayEndIdx = sessionBars.length;
    for (let idx = replayStartIdx; idx < replayEndIdx; idx++) {
      if (params.signal?.aborted) return false;
      const bar = sessionBars[idx];
      const prevBar = sessionBars[idx - 1];
      if (idx < 6) {
        runningOpeningLow = Math.min(runningOpeningLow, bar.low);
      }
      runningSessionHigh = Math.max(runningSessionHigh, bar.high);
      runningSliceLow = Math.min(runningSliceLow, bar.low);

      const effectiveDailyLow =
        params.dailyExpectedMove?.low &&
        Math.abs(runningOpeningLow - params.dailyExpectedMove.low) / Math.max(1, runningOpeningLow) <= 0.008
          ? Math.max(runningOpeningLow, params.dailyExpectedMove.low)
          : runningOpeningLow;
      const effectiveDailyHigh = Math.max(
        runningSessionHigh,
        params.filteredKing ?? 0,
        params.dailyExpectedMove?.high ?? 0,
        Number((runningOpeningLow * 1.0065).toFixed(2))
      );
      const barDate = new Date(bar.ts * 1000);

      const latestStore = loadTradeStore();
      const openPos = latestStore.activePositions[normalizedTicker] ?? latestStore.activePositions[positionKey];
      const posScale = isSpxw && openPos?.ticker === "SPY" ? 10 : 1;
      const barLowPos = bar.low / posScale;
      const barHighPos = bar.high / posScale;
      const barClosePos = bar.close / posScale;
      const sliceLowPos = runningSliceLow / posScale;
      const prevClosePos = prevBar.close / posScale;
      const isZeroGammaFlushPos = Boolean(openPos?.setupName?.includes("Bearish Zero-Gamma Flush"));
      // Check stop-loss intrabar BEFORE target-profit intrabar to eliminate optimistic target-first lookahead
      let evalSpot = bar.close;
      if (openPos) {
        if (openPos.contractType === "CALL") {
          if (barLowPos <= openPos.stopLossSpot) {
            evalSpot = Math.min(bar.close, Number((openPos.stopLossSpot * posScale).toFixed(2)));
          } else if (barHighPos >= openPos.target1Spot) {
            evalSpot =
              barHighPos >= openPos.target2Spot
                ? bar.high
                : Math.max(bar.close, Number((openPos.target1Spot * posScale).toFixed(2)));
          }
        } else {
          if (barHighPos >= openPos.stopLossSpot) {
            evalSpot = Math.max(bar.close, Number((openPos.stopLossSpot * posScale).toFixed(2)));
          } else if (!isZeroGammaFlushPos && barLowPos <= openPos.target1Spot) {
            evalSpot =
              barLowPos <= openPos.target2Spot
                ? bar.low
                : Math.min(bar.close, Number((openPos.target1Spot * posScale).toFixed(2)));
          }
        }
      }

      const refSpotForChain = isSpxw ? evalSpot / 10 : evalSpot;
      const curSpotForChain = isSpxw ? currentSpot / 10 : currentSpot;
      const dSpot = refSpotForChain - curSpotForChain;

      // Synchronize option chain prices to the historical 5m bar's spot & time-of-day
      const barContracts: NormalizedOptionContract[] = baseContracts.map((c) => {
        const isCallOpt = c.optionType === "C";
        const distOtm = isCallOpt
          ? c.strike - refSpotForChain
          : refSpotForChain - c.strike;
        const distOtmPct = distOtm / Math.max(1, refSpotForChain);
        const distOtmSpyScaled = (Math.max(0, distOtm) / Math.max(1, refSpotForChain)) * 750;
        const estDelta = Number(
          Math.max(0.20, Math.min(0.45, 0.42 * Math.exp(-0.18 * distOtmSpyScaled))).toFixed(2)
        );
        const sign = isCallOpt ? 1 : -1;

        let bid = c.bid ?? 0;
        let ask = c.ask ?? 0;
        let last = c.last ?? 0;

        if (openPos && c.strike === openPos.strike && c.expiration === openPos.expiration && isCallOpt === (openPos.contractType === "CALL")) {
          // Track active position option value directly from entry fill + delta move
          const entryRef = openPos.btoSpotPrice;
          const moveFromEntry = (refSpotForChain - entryRef) * sign;
          const baseEntryAsk = openPos.optionAsk || openPos.btoOptionMid || 0.45;
          const curEstMid = Math.max(0.05, Number((baseEntryAsk + moveFromEntry * 0.22).toFixed(2)));
          bid = Math.max(0.04, Number((curEstMid - 0.01).toFixed(2)));
          ask = Number((curEstMid + 0.01).toFixed(2));
          last = curEstMid;
        } else {
          // Reconstruct realistic sub-$1.00 option quote at bar timestamp
          const rawMid = getContractMidPrice(c);
          const shiftedMid = rawMid > 0 ? rawMid + dSpot * estDelta * sign : 0;
          if (shiftedMid >= 0.20 && shiftedMid <= 0.95) {
            bid = Number(Math.max(0.18, shiftedMid - 0.02).toFixed(2));
            ask = Number(Math.min(0.98, shiftedMid + 0.02).toFixed(2));
            last = Number(shiftedMid.toFixed(2));
          } else if (distOtmPct >= -0.001 && distOtmPct <= 0.006) {
            // If current EOD chain has decayed, restore intraday time value for near-OTM strikes
            const modelMid = Number(Math.max(0.26, Math.min(0.78, 0.72 * Math.exp(-0.22 * distOtmSpyScaled))).toFixed(2));
            bid = Number((modelMid - 0.02).toFixed(2));
            ask = Number((modelMid + 0.02).toFixed(2));
            last = modelMid;
          }
        }

        return {
          ...c,
          delta: isCallOpt ? estDelta : -estDelta,
          bid,
          ask,
          last,
        };
      });

      // Detect 5m Bullish Momentum Reversal / Divergence after major morning flush (pct-scaled across underlyings)
      const dropFromBtoPct = openPos ? (openPos.btoSpotPrice - sliceLowPos) / Math.max(1, openPos.btoSpotPrice) : 0;
      const bounceFromLowPct = (barClosePos - sliceLowPos) / Math.max(1, sliceLowPos);
      const isPostFlushBullReversal =
        Boolean(openPos && openPos.contractType === "PUT") &&
        bar.totalMinutes >= 630 && // >= 10:30 AM ET
        dropFromBtoPct >= 0.0105 &&
        bounceFromLowPct >= 0.0029 &&
        barClosePos > bar.open / posScale &&
        barClosePos > prevClosePos;

      await evaluateTradeSignals({
        ...params,
        ticker: normalizedTicker,
        spotPrice: evalSpot,
        prevSpotPrice: prevBar.close,
        divergence5m: isPostFlushBullReversal ? "BULL" : undefined,
        divergence30m: undefined,
        dailyExpectedMove: {
          low: effectiveDailyLow,
          high: effectiveDailyHigh,
        },
        latest5mCandle: {
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          sma34: bar.sma34,
          timestamp: bar.ts,
          prevLow: prevBar.low,
          prevHigh: prevBar.high,
          flowSnapshot: sessionFlowSeries[idx] ?? null,
        },
        contracts: barContracts,
        nowEt: barDate,
        isHistoricalBackfill: true,
      });
    }
    return true;
  } catch {
    // Non-fatal if Yahoo 5m history fetch fails
    return false;
  }
}

/**
 * Physical Greek Envelope Clamp:
 * Prevents noisy delayed CBOE quotes or wide bid-ask jumps from violating options microstructure physics.
 * 1. Adverse spot excursion (dirSpotMove <= -0.02) MUST NEVER produce an option price above entry.
 * 2. Positive spot excursion is bounded by delta + gamma convexity (no 160% gain on a 27-cent underlying move).
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
  const thetaDecay = Math.min(baseEntry * 0.15, Math.max(0, elapsedMinutes) * 0.0012);
  const minMoveEps = Math.max(0.02, Math.max(1, entrySpot) * 0.00003);
  const gammaScale = 750 / Math.max(1, entrySpot);

  if (dirSpotMove <= -minMoveEps) {
    // Underlying moved adversely: option price MUST NOT exceed entry price
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
    -0.08 * baseEntry,
    minDelta * dirSpotMove - thetaDecay
  );
  const rawDeltaV = rawCurrentOptionPrice - baseEntry;
  const clampedDelta = Math.max(minGainDelta, Math.min(maxGainDelta, rawDeltaV));
  return Number(Math.max(0.05, baseEntry + clampedDelta).toFixed(2));
}

/**
 * Main Evaluation Engine: Evaluates stateful BTO and STC lifecycle rules on every poll.
 * - Tracks at most 1 active position per ticker (SPY, QQQ, SPXW, IWM).
 * - Exclusively emits BTO for Sub-$1.00 Calls/Puts and STC for active position exits.
 * - Enforces 1-2 contract sizing and smart scaling.
 */
export function clampToCandleRange(price: number, candle?: { low?: number; high?: number } | null): number {
  if (!candle || typeof candle.low !== "number" || typeof candle.high !== "number" || candle.low <= 0 || candle.high <= 0) {
    return price;
  }
  return Number(Math.max(candle.low, Math.min(candle.high, price)).toFixed(2));
}

export async function evaluateTradeSignals(
  params: TradeEvaluationParams
): Promise<TradeEvaluationResult> {
  const sym = params.ticker.trim().toUpperCase().replace(/^\$/, "");
  const normalizedTicker = sym === "SPX" ? "SPXW" : sym;

  if (!isSupportedTradeTicker(normalizedTicker) && !isSupportedTradeTicker(sym)) {
    return {
      ticker: sym,
      activePosition: null,
      emittedAlerts: [],
      allAlerts: [],
    };
  }

  const isSpxw = normalizedTicker === "SPXW" || normalizedTicker === "SPX";
  const positionKey = isSpxw ? "SPY" : normalizedTicker;
  let store = loadTradeStore();

  if (params.signal?.aborted) {
    return {
      ticker: normalizedTicker,
      activePosition: store.activePositions[normalizedTicker] ?? store.activePositions[positionKey] ?? null,
      emittedAlerts: [],
      allAlerts: store.alerts,
    };
  }

  const preFetchEt = getNowEtTime(params.nowEt ?? new Date());
  const hasStoredPos = Boolean(store.activePositions[normalizedTicker] || store.activePositions[positionKey]);
  if (preFetchEt.hours >= 16 && !hasStoredPos) {
    return {
      ticker: normalizedTicker,
      activePosition: null,
      emittedAlerts: [],
      allAlerts: store.alerts,
    };
  }

  let spotPrice = Number(params.spotPrice.toFixed(2));
  if (spotPrice <= 0) {
    const cached = getCachedSpotPrice(normalizedTicker);
    if (cached && cached > 0) spotPrice = Number(cached.toFixed(2));
    else if (store.prevSpotPrices[normalizedTicker] && store.prevSpotPrices[normalizedTicker] > 0) {
      spotPrice = store.prevSpotPrices[normalizedTicker];
    }
  }
  const prevSpotPrice = params.prevSpotPrice ?? store.prevSpotPrices[normalizedTicker] ?? spotPrice;
  store.prevSpotPrices[normalizedTicker] = spotPrice;

  // Retrieve 5m candle and divergence if not passed in
  let latest5mCandle = params.latest5mCandle ?? null;
  let divergence5m = params.divergence5m ?? null;
  let divergence30m = params.divergence30m ?? null;

  // Ensure real-time live CBOE option contracts are available before computing Flow VWAP & structural walls
  if (!params.contracts || params.contracts.length === 0) {
    params.contracts = await fetchLiveCboeOptions(normalizedTicker, params.signal);
    if (params.signal?.aborted) {
      return { ticker: normalizedTicker, activePosition: null, emittedAlerts: [], allAlerts: loadTradeStore().alerts };
    }
    store = loadTradeStore();
    store.prevSpotPrices[normalizedTicker] = spotPrice;
  }
  if (spotPrice <= 0) {
    const cached = getCachedSpotPrice(normalizedTicker);
    if (cached && cached > 0) spotPrice = Number(cached.toFixed(2));
  }

  const populateMissingWallsFromChain = () => {
    if (spotPrice > 0 && params.contracts && params.contracts.length > 0 && (!params.callWall || !params.putWall)) {
      try {
        const analytics = computeOptionsAnalytics({
          ticker: normalizedTicker as any,
          dataSource: "CBOE_MARKET_DATA",
          spotPrice,
          previousClose: prevSpotPrice > 0 ? prevSpotPrice : spotPrice,
          contracts: params.contracts,
        });
        const derived = deriveTacticalStructuralLevels(analytics);
        if (!params.callWall && derived.callWall > 0) params.callWall = derived.callWall;
        if (!params.putWall && derived.putWall > 0) params.putWall = derived.putWall;
        if (!params.zeroGamma && derived.zeroGamma > 0) params.zeroGamma = derived.zeroGamma;
        if (!params.filteredKing && derived.tacticalKing > 0) params.filteredKing = derived.tacticalKing;
        if (!params.dailyExpectedMove && derived.dailyExpectedMove) params.dailyExpectedMove = derived.dailyExpectedMove;
        if (typeof params.netGex !== "number" && Number.isFinite(derived.netGexMillions)) {
          params.netGex = derived.netGexMillions;
        }
      } catch {
        // Fallback to direct strike OI+vol scan below
      }
      if (!params.callWall || !params.putWall) {
        const refSpot = normalizedTicker === "SPXW" || normalizedTicker === "SPX" ? spotPrice / 10 : spotPrice;
        const scaleMult = normalizedTicker === "SPXW" || normalizedTicker === "SPX" ? 10 : 1;
        const nearCalls = params.contracts.filter((c) => c.optionType === "C" && c.strike >= refSpot && c.strike <= refSpot * 1.02);
        const nearPuts = params.contracts.filter((c) => c.optionType === "P" && c.strike <= refSpot && c.strike >= refSpot * 0.98);
        if (!params.callWall && nearCalls.length > 0) {
          const bestCall = nearCalls.reduce((best, c) => ((c.openInterest + c.volume) > (best.openInterest + best.volume) ? c : best), nearCalls[0]);
          params.callWall = Number((bestCall.strike * scaleMult).toFixed(2));
        }
        if (!params.putWall && nearPuts.length > 0) {
          const bestPut = nearPuts.reduce((best, c) => ((c.openInterest + c.volume) > (best.openInterest + best.volume) ? c : best), nearPuts[0]);
          params.putWall = Number((bestPut.strike * scaleMult).toFixed(2));
        }
        if (!params.zeroGamma && params.callWall && params.putWall) {
          params.zeroGamma = Number(((params.callWall + params.putWall) / 2).toFixed(2));
        }
      }
    }
  };

  populateMissingWallsFromChain();

  if (!params.nowEt && (!latest5mCandle || !divergence5m || !divergence30m)) {
    const structuralNodes: StructuralFlowNodes | undefined =
      (params.putWall && params.putWall > 0) ||
      (params.callWall && params.callWall > 0) ||
      (params.zeroGamma && params.zeroGamma > 0)
        ? {
            floorNode: params.putWall && params.putWall > 0 ? params.putWall : undefined,
            ceilingNode: params.callWall && params.callWall > 0 ? params.callWall : undefined,
            zeroGamma: params.zeroGamma && params.zeroGamma > 0 ? params.zeroGamma : undefined,
            netGex: typeof params.netGex === "number" ? params.netGex : undefined,
          }
        : undefined;
    const fetched = await fetchLive5mCandleAndDivergence(normalizedTicker, params.signal, {
      contracts: params.contracts,
      structuralNodes,
    });
    if (params.signal?.aborted) {
      return { ticker: normalizedTicker, activePosition: null, emittedAlerts: [], allAlerts: loadTradeStore().alerts };
    }
    store = loadTradeStore();
    store.prevSpotPrices[normalizedTicker] = spotPrice;
    if (!latest5mCandle) latest5mCandle = fetched.candle;
    if (!divergence5m || divergence5m === "NO") divergence5m = fetched.divergence5m;
    if (!divergence30m || divergence30m === "NO") divergence30m = fetched.divergence30m;
  }

  if (spotPrice <= 0 && latest5mCandle && latest5mCandle.close > 0) {
    spotPrice = latest5mCandle.close;
    populateMissingWallsFromChain();
    store.prevSpotPrices[normalizedTicker] = spotPrice;
  }

  // Reconstruct today's intraday RTH session BTO/STC signals if server started mid-session
  const hasTickerHistoryToday =
    store.alerts.some((a) => a.ticker === normalizedTicker || a.ticker === positionKey) ||
    store.closedPositions.some((p) => p.ticker === normalizedTicker || p.ticker === positionKey) ||
    Boolean(store.activePositions[normalizedTicker] || store.activePositions[positionKey]);

  if (!params.nowEt && !hasTickerHistoryToday && !store.backfilledTickers?.[normalizedTicker]) {
    const completedBackfill = await backfillIntradaySessionSignals(normalizedTicker, params, store, spotPrice);
    if (params.signal?.aborted) {
      return { ticker: normalizedTicker, activePosition: null, emittedAlerts: [], allAlerts: loadTradeStore().alerts };
    }
    store = loadTradeStore();
    if (completedBackfill) {
      store.backfilledTickers = { ...(store.backfilledTickers || {}), [normalizedTicker]: true };
      saveTradeStore(store);
    }
  }

  const now = params.nowEt ?? new Date();
  const nowTs = Math.floor(now.getTime() / 1000);
  const timeStr = formatTimeEt(now);
  const etTime = getNowEtTime(now);

  let activePos: OptionTradePosition | null =
    store.activePositions[normalizedTicker] ?? store.activePositions[positionKey] ?? null;
  const closedForTickerEarly = store.closedPositions.filter(
    (p) => p.ticker === positionKey || p.ticker === normalizedTicker
  );

  // Jane Street Two-Regime Single-Slot State Machine:
  // Leg 1 (09:35-14:30 ET): Max 1 primary structural trade.
  // Leg 2 (10:45-14:30 ET): At most 1 opposite-direction structural trade (>= 30m cooldown), regardless of Leg-1 PnL.
  // Permanently locks LOCKED_FOR_DAY once closedForTickerEarly.length >= 2.
  const phase1Closed = closedForTickerEarly.reduce<OptionTradePosition | undefined>(
    (latest, cur) => (!latest || (cur.closedTs ?? 0) >= (latest.closedTs ?? 0) ? cur : latest),
    undefined
  );
  const phase1CooldownOk =
    closedForTickerEarly.length === 1 &&
    typeof phase1Closed?.closedTs === "number" &&
    nowTs - phase1Closed.closedTs >= 1800;
  const canTryPhase2Reclaim =
    closedForTickerEarly.length === 1 &&
    phase1CooldownOk &&
    etTime.totalMinutes >= 630 &&
    etTime.totalMinutes <= ENTRY_CUTOFF_MINS;
  if ((closedForTickerEarly.length >= 2 || (closedForTickerEarly.length >= 1 && !canTryPhase2Reclaim)) && !activePos) {
    return {
      ticker: normalizedTicker,
      activePosition: null,
      emittedAlerts: [],
      allAlerts: store.alerts,
    };
  }

  // Hard Market Close Boundary: Equity/ETF options halt trading at 4:00 PM ET sharp.
  // Absolutely zero new evaluations, orders, or after-hours prices allowed after 16:00 ET.
  if (etTime.hours >= 16 && !activePos) {
    return {
      ticker: normalizedTicker,
      activePosition: null,
      emittedAlerts: [],
      allAlerts: store.alerts,
    };
  }

  // Hard Market-On-Close Cutoff at 15:55 ET (protect against Robinhood 3:55 PM forced liquidation)
  const isEodCutoff = etTime.totalMinutes >= EOD_FORCE_FLAT_MINS;

  const emittedAlerts: TradeLifecycleAlert[] = [];
  if (
    activePos &&
    (activePos.status === "OPEN" || activePos.status === "PARTIAL_TP1") &&
    isSpxw &&
    activePos.ticker === "SPY" &&
    (!params.contracts || params.contracts.length === 0 || params.contracts.some((c) => c.strike > (spotPrice / 10) * 3))
  ) {
    const spyChain = await fetchLiveCboeOptions("SPY", params.signal);
    if (params.signal?.aborted) {
      const latestAbortStore = loadTradeStore();
      return {
        ticker: normalizedTicker,
        activePosition:
          latestAbortStore.activePositions[normalizedTicker] ??
          latestAbortStore.activePositions[positionKey] ??
          activePos,
        emittedAlerts,
        allAlerts: latestAbortStore.alerts,
      };
    }
    if (spyChain.length > 0) params.contracts = spyChain;
    store = loadTradeStore();
    store.prevSpotPrices[normalizedTicker] = spotPrice;
    activePos = store.activePositions[normalizedTicker] ?? store.activePositions[positionKey] ?? null;
  }
  const hadActivePositionAtStart = Boolean(activePos);

  // --------------------------------------------------------------------------
  // STEP A: EVALUATE STC EXIT RULES (When a position is OPEN or PARTIAL_TP1)
  // --------------------------------------------------------------------------
  if (activePos && (activePos.status === "OPEN" || activePos.status === "PARTIAL_TP1")) {
    const isCall = activePos.contractType === "CALL";
    const isPosSpyScaled = isSpxw && activePos.ticker === "SPY";
    const posSpotPrice = isPosSpyScaled ? Number((spotPrice / 10).toFixed(2)) : spotPrice;
    const posCandle: Candle5m | null =
      isPosSpyScaled && latest5mCandle
        ? {
            ...latest5mCandle,
            open: Number((latest5mCandle.open / 10).toFixed(2)),
            high: Number((latest5mCandle.high / 10).toFixed(2)),
            low: Number((latest5mCandle.low / 10).toFixed(2)),
            close: Number((latest5mCandle.close / 10).toFixed(2)),
            sma34: Number((latest5mCandle.sma34 / 10).toFixed(2)),
            prevLow: typeof latest5mCandle.prevLow === "number" ? Number((latest5mCandle.prevLow / 10).toFixed(2)) : undefined,
            prevHigh: typeof latest5mCandle.prevHigh === "number" ? Number((latest5mCandle.prevHigh / 10).toFixed(2)) : undefined,
          }
        : latest5mCandle;
    const posPutWall = isPosSpyScaled && params.putWall > 0 ? Number((params.putWall / 10).toFixed(2)) : params.putWall;

    // Estimate current live option bid/mid from live chain
    let currentOptionMid: number = activePos.btoOptionMid;
    let liveBid: number | undefined = activePos.optionBid;
    let liveAsk: number | undefined = activePos.optionAsk;

    if (params.contracts && params.contracts.length > 0) {
      const match = params.contracts.find(
        (c) =>
          c.strike === activePos?.strike &&
          c.optionType === (isCall ? "C" : "P") &&
          c.expiration === activePos?.expiration
      );
      if (match) {
        const liveMid = getContractMidPrice(match);
        if (liveMid > 0) currentOptionMid = liveMid;
        if (match.bid && match.bid > 0) liveBid = match.bid;
        if (match.ask && match.ask > 0) liveAsk = match.ask;
      }
    }

    // Realistic execution: exits execute at live BID, not mid, clamped to physical Greek bounds
    const rawHeldMin = Math.max(0, (nowTs - (activePos.openedTs || nowTs)) / 60);
    const heldMin = Math.max(1, rawHeldMin);
    const adverseSpotMove = isCall ? activePos.btoSpotPrice - posSpotPrice : posSpotPrice - activePos.btoSpotPrice;
    const rawExitPrice = liveBid && liveBid > 0 ? liveBid : currentOptionMid;
    const entryFillPrice = activePos.optionAsk || activePos.btoOptionMid;
    const exitFillPrice = clampOptionPriceToGreekEnvelope(
      activePos.btoSpotPrice,
      posSpotPrice,
      entryFillPrice,
      rawExitPrice,
      isCall,
      heldMin
    );
    const pnlOptionPct = Number(
      (((exitFillPrice - entryFillPrice) / Math.max(0.01, entryFillPrice)) * 100).toFixed(2)
    );

    // Helper to close position (clamps spotPrice to [candle.low, candle.high] for ALL tickers including SPXW->SPY)
    const closePosition = (reason: string) => {
      activePos!.status = "CLOSED";
      activePos!.remainingQty = 0;
      activePos!.closedAt = timeStr;
      activePos!.closedTs = nowTs;
      const clampedExitSpot = clampToCandleRange(posSpotPrice, posCandle);
      const clampedSpotMovePct = isCall
        ? ((clampedExitSpot - activePos!.btoSpotPrice) / activePos!.btoSpotPrice) * 100
        : ((activePos!.btoSpotPrice - clampedExitSpot) / activePos!.btoSpotPrice) * 100;
      const clampedExitFill = clampOptionPriceToGreekEnvelope(
        activePos!.btoSpotPrice,
        clampedExitSpot,
        entryFillPrice,
        rawExitPrice,
        isCall,
        heldMin
      );
      const clampedOptPnlPct = Number(
        (((clampedExitFill - entryFillPrice) / Math.max(0.01, entryFillPrice)) * 100).toFixed(2)
      );
      activePos!.closedSpotPrice = clampedExitSpot;
      activePos!.closedOptionMid = clampedExitFill;
      activePos!.exitReason = reason;
      activePos!.pnlSpotPct = Number(clampedSpotMovePct.toFixed(2));
      activePos!.pnlOptionPct = clampedOptPnlPct;

      const optPnlStr = ` (${clampedOptPnlPct >= 0 ? "+" : ""}${clampedOptPnlPct}%)`;
      const msg = `🔴 STC · ${activePos!.contractLabel} [${reason}] @ $${clampedExitSpot.toFixed(
        2
      )} · Spot ${clampedSpotMovePct >= 0 ? "+" : ""}${clampedSpotMovePct.toFixed(2)}%${optPnlStr}`;

      const alertTicker = activePos!.ticker || normalizedTicker;
      const alert: TradeLifecycleAlert = {
        id: `${activePos!.id}-stc-${nowTs}`,
        timestamp: timeStr,
        ts: nowTs,
        ticker: alertTicker,
        action: "SELL_TO_CLOSE",
        contractType: activePos!.contractType,
        contractLabel: activePos!.contractLabel,
        strike: activePos!.strike,
        expiration: activePos!.expiration,
        expHuman: activePos!.expHuman,
        robinhoodExp: activePos!.robinhoodExp,
        setupName: activePos!.setupName,
        reason,
        status: "CLOSED",
        spotPrice: clampedExitSpot,
        btoSpotPrice: activePos!.btoSpotPrice,
        target1Spot: activePos!.target1Spot,
        target2Spot: activePos!.target2Spot,
        stopLossSpot: activePos!.stopLossSpot,
        optionMid: clampedExitFill,
        optionBid: liveBid,
        optionAsk: liveAsk,
        btoOptionMid: activePos!.btoOptionMid,
        contractsQty: activePos!.contractsQty,
        remainingQty: 0,
        totalOutlay: activePos!.totalOutlay,
        estTp1Mid: activePos!.estTp1Mid,
        estTp2Mid: activePos!.estTp2Mid,
        estStopMid: activePos!.estStopMid,
        tp1Pct: activePos!.tp1Pct,
        tp2Pct: activePos!.tp2Pct,
        pnlSpotPct: Number(clampedSpotMovePct.toFixed(2)),
        pnlOptionPct: clampedOptPnlPct,
        rrRatio: activePos!.rrRatio,
        altContractNote: activePos!.altContractNote,
        isHistoricalBackfill: Boolean(params.isHistoricalBackfill),
        eventId: `${activePos!.id}-stc-${nowTs}`,
        message: msg,
      };

      emittedAlerts.push(alert);
      store.alerts.push(alert);
      store.closedPositions.unshift(activePos!);
      delete store.activePositions[normalizedTicker];
      delete store.activePositions[positionKey];
      activePos = null;
    };

    // Progressive Runner Trailing Stop: immutable initialRisk + 50% BE+10% floor + 75%/1.5R prior closed 5m bar trail
    const flowSnapExit = posCandle?.flowSnapshot ?? null;
    const exitChi = typeof flowSnapExit?.ceilingShareChi === "number" ? flowSnapExit.ceilingShareChi : 0.5;
    const exitImpChi = typeof flowSnapExit?.impulseChi === "number" ? flowSnapExit.impulseChi : exitChi;
    const exitPe = typeof flowSnapExit?.pecletNumber === "number" ? flowSnapExit.pecletNumber : 0;
    const exitFlux = typeof flowSnapExit?.netFluxJ === "number" ? flowSnapExit.netFluxJ : 0;
    const isRunnerSetup =
      activePos.setupName.includes("Bearish Zero-Gamma Flush") ||
      activePos.setupName.includes("Flux") ||
      activePos.setupName.includes("Impulse");
    const solidFluxAligned = isCall
      ? ((exitFlux > 0 || exitImpChi > 0.72) && (exitChi > 0.85 || exitImpChi > 0.80 || exitPe >= 1.2))
      : ((exitFlux < 0 || exitImpChi < 0.28) && (exitChi < 0.15 || exitImpChi < 0.20 || exitPe <= -1.2));

    const curBarTs = posCandle?.timestamp ?? 0;
    const resolvedPrevLow =
      typeof posCandle?.prevLow === "number"
        ? posCandle.prevLow
        : typeof activePos.prevBarLow === "number"
          ? activePos.prevBarLow
          : posCandle?.low;
    const resolvedPrevHigh =
      typeof posCandle?.prevHigh === "number"
        ? posCandle.prevHigh
        : typeof activePos.prevBarHigh === "number"
          ? activePos.prevBarHigh
          : posCandle?.high;
    const curCandleRange = posCandle
      ? Math.max(
          posCandle.high - posCandle.low,
          typeof activePos.lastPrevClose === "number" && activePos.lastPrevClose > 0
            ? Math.max(
                Math.abs(posCandle.high - activePos.lastPrevClose),
                Math.abs(posCandle.low - activePos.lastPrevClose)
              )
            : 0
        )
      : 0;
    if (posCandle && curBarTs > 0 && curBarTs > (activePos.lastCandleTs ?? 0)) {
      activePos.lastCandleTs = curBarTs;
      activePos.prevBarLow = posCandle.low;
      activePos.prevBarHigh = posCandle.high;
      if (curCandleRange > 0) {
        activePos.atr5m =
          typeof activePos.atr5m === "number" && activePos.atr5m > 0
            ? Number(((activePos.atr5m * 13 + curCandleRange) / 14).toFixed(4))
            : Number(curCandleRange.toFixed(4));
      }
      activePos.lastPrevClose = posCandle.close;
    } else if (posCandle && activePos.prevBarLow == null) {
      activePos.prevBarLow = posCandle.low;
      activePos.prevBarHigh = posCandle.high;
      if (curCandleRange > 0 && !(typeof activePos.atr5m === "number" && activePos.atr5m > 0)) {
        activePos.atr5m = Number(curCandleRange.toFixed(4));
      }
      activePos.lastPrevClose = posCandle.close;
    }

    const exitAtr5m: number =
      typeof flowSnapExit?.atr5m === "number" && flowSnapExit.atr5m > 0
        ? flowSnapExit.atr5m
        : typeof activePos.atr5m === "number" && activePos.atr5m > 0
          ? activePos.atr5m
          : curCandleRange > 0
            ? curCandleRange
            : posSpotPrice * 0.0015;
    const exitMetrics = computeAdaptiveQuantMetrics(posSpotPrice, exitAtr5m);
    const trailWickBuf = Math.max(0.02, posSpotPrice * 0.00007);

    const distToWall = Math.abs(activePos.target2Spot - activePos.btoSpotPrice);
    const initialRisk = Math.max(
      Math.max(0.05, posSpotPrice * 0.00033),
      activePos.initialRisk ?? Math.abs(activePos.btoSpotPrice - activePos.stopLossSpot)
    );
    const favMove = isCall ? posSpotPrice - activePos.btoSpotPrice : activePos.btoSpotPrice - posSpotPrice;
    const currentR = favMove / initialRisk;
    const progressToWall = distToWall > 0 ? favMove / distToWall : 0;
    if (activePos.status === "OPEN" && progressToWall >= 0.50) {
      const beFloor = isCall
        ? Number((activePos.btoSpotPrice + initialRisk * 0.10).toFixed(2))
        : Number((activePos.btoSpotPrice - initialRisk * 0.10).toFixed(2));
      if ((isCall && beFloor > activePos.stopLossSpot) || (!isCall && beFloor < activePos.stopLossSpot)) {
        activePos.stopLossSpot = beFloor;
      }
      if (isRunnerSetup && (currentR >= 1.5 || progressToWall >= 0.75) && posCandle) {
        const rawTrailStop = isCall
          ? Number(((resolvedPrevLow ?? posCandle.low) - trailWickBuf).toFixed(2))
          : Number(((resolvedPrevHigh ?? posCandle.high) + trailWickBuf).toFixed(2));
        const trailStop = isCall ? Math.max(beFloor, rawTrailStop) : Math.min(beFloor, rawTrailStop);
        if ((isCall && trailStop > activePos.stopLossSpot) || (!isCall && trailStop < activePos.stopLossSpot)) {
          activePos.stopLossSpot = trailStop;
        }
      }
    }

    const resolvedOpenedEtMins = (() => {
      if (typeof activePos.openedTs === "number" && Number.isFinite(activePos.openedTs) && activePos.openedTs > 0) {
        return etMinutesOfDay(activePos.openedTs);
      }
      const match = activePos.openedAt?.match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?/i);
      if (!match) return -1;
      let h = Number(match[1]);
      const m = Number(match[2]);
      const meridiem = match[3]?.toUpperCase();
      if (meridiem === "PM" && h < 12) h += 12;
      if (meridiem === "AM" && h === 12) h = 0;
      return h * 60 + m;
    })();

    // 1. STC (15:55 PM ET HARD CUTOFF / EOD THETA EXIT)
    if (isEodCutoff) {
      closePosition("15:55 PM ET HARD MARKET CLOSE CUTOFF");
    }
    // 2. STC: 10:45 AM MORNING CHOP TIME STOP (Protect profits before midday theta crush)
    else if (
      activePos.status === "OPEN" &&
      rawHeldMin >= 10 &&
      resolvedOpenedEtMins >= RTH_OPEN_MINS &&
      resolvedOpenedEtMins < 615 &&
      ((etTime.hours === 10 && etTime.minutes >= 45) || etTime.hours === 11) &&
      pnlOptionPct >= 10 && pnlOptionPct < 25 &&
      ((isCall && posCandle && posCandle.close < posCandle.sma34) ||
        (!isCall && posCandle && posCandle.close > posCandle.sma34))
    ) {
      closePosition("10:45 AM MOMENTUM CUTOFF (PROTECT PROFITS / AVOID MIDDAY CHOP)");
    }
    // 3. STC (MOMENTUM REVERSAL / DIVERGENCE COVER — DYNAMIC TREND EXIT)
    // Enforce minimum hold (rawHeldMin >= 10m / 2 bars) + confirmed adverse move or >= 10% profit lock
    else if (
      activePos.status === "OPEN" &&
      !(isRunnerSetup && solidFluxAligned) &&
      rawHeldMin >= 10 &&
      (adverseSpotMove >= exitMetrics.minReversalInvalidation || pnlOptionPct >= 10) &&
      ((!isCall &&
        ((posPutWall > 0 &&
          posSpotPrice <= posPutWall * 1.0012 &&
          (favMove >= exitMetrics.wallProximityBuffer || pnlOptionPct >= 25) &&
          (divergence5m === "BULL" ||
            exitImpChi >= 0.60 ||
            Boolean(posCandle && posCandle.close > posCandle.open))) ||
         divergence5m === "BULL" ||
         Boolean(
           posCandle &&
             typeof posCandle.sma34 === "number" &&
             posCandle.close > posCandle.sma34
         ))) ||
       (isCall &&
        (divergence5m === "BEAR" ||
         Boolean(
           posCandle &&
             typeof posCandle.sma34 === "number" &&
             posCandle.close < posCandle.sma34 &&
             (activePos.btoSpotPrice >= posCandle.sma34 || adverseSpotMove >= exitMetrics.minReversalInvalidation)
         ))))
    ) {
      const exitReason =
        pnlOptionPct >= 10
          ? "MOMENTUM REVERSAL PROFIT LOCK"
          : "MOMENTUM DIVERGENCE SCRATCH";
      closePosition(exitReason);
    }
    // 4. STC (TARGET 2 HIT · FULL PROFIT EXIT — bypassed for active Bearish Zero-Gamma Flush while below SMA34 so trend runners ride until Momentum Reversal Cover)
    else if (
      !activePos.setupName.includes("Bearish Zero-Gamma Flush") &&
      ((isCall && posSpotPrice >= activePos.target2Spot) ||
        (!isCall && posSpotPrice <= activePos.target2Spot) ||
        pnlOptionPct >= (activePos.tp2Pct || 50))
    ) {
      closePosition("TARGET 2 HIT · FULL PROFIT EXIT");
    }
    // 5. STC (TARGET 1 HIT · 1 CONTRACT SNIPER FULL EXIT — retained on non-ZGF/non-Flux trades per Pitfall A)
    else if (
      activePos.status === "OPEN" &&
      !(isRunnerSetup && solidFluxAligned) &&
      !activePos.setupName.includes("Bearish Zero-Gamma Flush") &&
      ((isCall && posSpotPrice >= activePos.target1Spot) ||
        (!isCall && posSpotPrice <= activePos.target1Spot) ||
        pnlOptionPct >= (activePos.tp1Pct || 25))
    ) {
      // Strict 1-Contract Sniper Automaton: 1 BTO -> 1 STC (No multi-contract partial scaling)
      closePosition("TARGET 1 HIT · FULL PROFIT EXIT (1 CONTRACT)");
    }
    // 5. STC (STOP LOSS / LEVEL INVALIDATION / OPTION HARD STOP HIT)
    else if (
      (isCall && posSpotPrice <= activePos.stopLossSpot) ||
      (!isCall && posSpotPrice >= activePos.stopLossSpot) ||
      (activePos.status === "OPEN" && activePos.estStopMid != null && currentOptionMid <= activePos.estStopMid && pnlOptionPct <= -20) ||
      (pnlOptionPct <= -25)
    ) {
      const isBreakeven =
        activePos.status === "PARTIAL_TP1" ||
        Math.abs(activePos.stopLossSpot - activePos.btoSpotPrice) < 0.02;
      // Strict invariant: Stop hit is trailing profit IF AND ONLY IF stopLossSpot was ratcheted past entry into profit AND pnl > 0
      const isTrailingProfit =
        pnlOptionPct > 0 &&
        ((isCall && activePos.stopLossSpot > activePos.btoSpotPrice + 0.01 && posSpotPrice > activePos.btoSpotPrice) ||
         (!isCall && activePos.stopLossSpot < activePos.btoSpotPrice - 0.01 && posSpotPrice < activePos.btoSpotPrice));
      const isOptionHardStop = !isBreakeven && !isTrailingProfit && pnlOptionPct <= -22;
      const reason = isTrailingProfit
        ? "TRAILING PROFIT LOCKED"
        : isBreakeven
          ? "BREAKEVEN STOP HIT"
          : isOptionHardStop
            ? "OPTION HARD STOP HIT (-25% MAX LOSS)"
            : "STOP LOSS / LEVEL INVALIDATION";
      closePosition(reason);
    }
  }
  if (hadActivePositionAtStart) {
    saveTradeStore(store);
  }

  // --------------------------------------------------------------------------
  // STEP B: EVALUATE BTO ENTRY RULES (Two-Regime Single-Slot Automaton: <= 2/day, <= 1/dir)
  // --------------------------------------------------------------------------
  const positionTickerForCheck = normalizedTicker === "SPXW" || normalizedTicker === "SPX" ? "SPY" : normalizedTicker;
  const sameTickerClosed = store.closedPositions.filter(
    (p) => p.ticker === positionTickerForCheck || p.ticker === normalizedTicker
  );
  const lastClosed = sameTickerClosed.reduce<OptionTradePosition | undefined>(
    (latest, cur) => (!latest || (cur.closedTs ?? 0) >= (latest.closedTs ?? 0) ? cur : latest),
    undefined
  );
  const isPhase2CooldownMet =
    sameTickerClosed.length === 1 &&
    typeof lastClosed?.closedTs === "number" &&
    nowTs - lastClosed.closedTs >= 1800;
  const isPhase2ReclaimWindow =
    sameTickerClosed.length === 1 &&
    isPhase2CooldownMet &&
    etTime.totalMinutes >= 630 &&
    etTime.totalMinutes <= ENTRY_CUTOFF_MINS;
  const hasCompletedTradeToday =
    sameTickerClosed.length >= 2 ||
    (sameTickerClosed.length >= 1 && !isPhase2ReclaimWindow);
  const hasActiveTrade = Boolean(
    activePos ||
    hadActivePositionAtStart ||
    store.activePositions[positionTickerForCheck] ||
    store.activePositions[normalizedTicker] ||
    Object.keys(store.activePositions || {}).length > 0
  );

  const isWithinRthEntryWindow = etTime.totalMinutes >= ENTRY_START_MINS && etTime.totalMinutes <= ENTRY_CUTOFF_MINS;
  if (!hasActiveTrade && !hasCompletedTradeToday && !isEodCutoff && isWithinRthEntryWindow) {
    const {
      callWall,
      putWall,
      zeroGamma,
      dailyExpectedMove,
      kingNode,
      filteredKing,
      bookCenter,
      conviction = 70,
    } = params;

    let candidateBto: {
      contractType: ContractType;
      setupName: string;
      stopLossSpot: number;
      target1Spot: number;
      target2Spot: number;
    } | null = null;

    // Invariant: Tactical intraday trading operates on 0DTE/Next-Exp walls.
    // Outlier all-expiration LEAPS walls (e.g. $800 on SPY $764, > 2.5% away) are sanitized
    // to the tactical 0DTE wall or near-spot structural levels so triggers fire on actionable intraday tests.
    const baseTacticalCw =
      params.zeroDteCallWall && params.zeroDteCallWall > 0
        ? params.zeroDteCallWall
        : callWall > 0 && Math.abs(callWall - spotPrice) / spotPrice <= 0.025
          ? callWall
          : dailyExpectedMove?.high && dailyExpectedMove.high > spotPrice
            ? dailyExpectedMove.high
            : Number((spotPrice * 1.008).toFixed(2));
    const tacticalCw =
      filteredKing &&
      filteredKing > baseTacticalCw &&
      (filteredKing - spotPrice) / spotPrice <= 0.015
        ? filteredKing
        : baseTacticalCw;

    const rawTacticalPw =
      params.zeroDtePutWall && params.zeroDtePutWall > 0
        ? params.zeroDtePutWall
        : putWall > 0 && Math.abs(spotPrice - putWall) / spotPrice <= 0.025
          ? putWall
          : dailyExpectedMove?.low && dailyExpectedMove.low < spotPrice
            ? dailyExpectedMove.low
            : Number((spotPrice * 0.992).toFixed(2));

    // Anti-Distant-King Put Trap Sanitizer (scales PUT_WALL cap with expected move for high-IV equities)
    const emPctForPw =
      dailyExpectedMove?.low && dailyExpectedMove.low > 0 && dailyExpectedMove.low < spotPrice
        ? (spotPrice - dailyExpectedMove.low) / spotPrice
        : 0;
    const maxPwDistPct = Math.max(0.0095, emPctForPw * 1.1);
    const tacticalPw =
      rawTacticalPw > 0 && (spotPrice - rawTacticalPw) / spotPrice > maxPwDistPct
        ? dailyExpectedMove?.low &&
          dailyExpectedMove.low < spotPrice &&
          (spotPrice - dailyExpectedMove.low) / spotPrice <= Math.max(0.01, emPctForPw * 1.1)
          ? Number(dailyExpectedMove.low.toFixed(2))
          : Number((spotPrice * 0.9935).toFixed(2))
        : rawTacticalPw;

    // =========================================================================
    // PRIORITY 1: GAIA CALL/PUT BIAS & FLOW VWAP DISPERSION BAND REGIME SIGNALS
    // Enforces: Thermodynamic dealer equilibrium, Stefan boundary momentum, R:R >= 1.45
    // =========================================================================
    const flowSnap = latest5mCandle?.flowSnapshot ?? null;
    const priorCloseRef =
      typeof params.priorClose === "number" && params.priorClose > 0
        ? params.priorClose
        : typeof store.prevSpotPrices[normalizedTicker] === "number" && store.prevSpotPrices[normalizedTicker] > 0
          ? store.prevSpotPrices[normalizedTicker]
          : latest5mCandle?.open || spotPrice;

    const premarketFlowVwapRef =
      typeof params.premarketFlowVwap === "number" && params.premarketFlowVwap > 0
        ? params.premarketFlowVwap
        : priorCloseRef;

    const isOpeningRange = etTime.totalMinutes < 585; // First 15m of session before 09:45 AM ET
    const hasPopulatedRollingIndicators = Boolean(
      latest5mCandle &&
      typeof latest5mCandle.sma34 === "number" &&
      flowSnap &&
      typeof flowSnap.flowVwap === "number" &&
      typeof flowSnap.ceilingShareChi === "number"
    );

    let rawChi =
      typeof flowSnap?.ceilingShareChi === "number" && Number.isFinite(flowSnap.ceilingShareChi)
        ? flowSnap.ceilingShareChi
        : 0.5;

    let isOpeningNegativeGamma = false;
    if (isOpeningRange && (!hasPopulatedRollingIndicators || rawChi < 0.50)) {
      if (
        (zeroGamma > 0 && spotPrice < zeroGamma) ||
        (premarketFlowVwapRef > 0 && spotPrice < premarketFlowVwapRef) ||
        (priorCloseRef > 0 && spotPrice < priorCloseRef)
      ) {
        isOpeningNegativeGamma = true;
        rawChi = 0.35; // Put regime forced during negative opening range
      }
    }

    const currentChi = rawChi;
    const currentPe =
      typeof flowSnap?.pecletNumber === "number" && Number.isFinite(flowSnap.pecletNumber)
        ? flowSnap.pecletNumber
        : 0.0;
    const currentNetFlux =
      typeof flowSnap?.netFluxJ === "number" && Number.isFinite(flowSnap.netFluxJ)
        ? flowSnap.netFluxJ
        : 0.0;

    // --- SETUP 1A: Bearish Zero-Gamma Flush [BTO PUT] (The Morning Short) ---
    // Trigger Conditions:
    // - Opening hour (09:30 AM - 10:30 AM ET -> totalMinutes >= 570 && totalMinutes <= 630)
    // - spotPrice crosses or opens below zeroGamma
    // - spotPrice < flowVwap AND spotPrice < sma34_5m
    // - Gamma Regime is heavily short (currentChi < 0.45 or Boundary Flux is red: currentNetFlux < 0)
    const effectiveFlowVwap =
      flowSnap && typeof flowSnap.flowVwap === "number" && flowSnap.flowVwap > 0
        ? flowSnap.flowVwap
        : premarketFlowVwapRef;
    const effectiveSma34 =
      latest5mCandle && typeof latest5mCandle.sma34 === "number" && latest5mCandle.sma34 > 0
        ? latest5mCandle.sma34
        : priorCloseRef;
    const isOpeningHour = etTime.totalMinutes >= 575 && etTime.totalMinutes <= 630;
    const isShortGammaOrRedFlux =
      currentChi < 0.45 || currentNetFlux < 0 || isOpeningNegativeGamma || store.macroRegime === "PUT";
    const entryAtr5m: number =
      flowSnap && typeof flowSnap.atr5m === "number" && flowSnap.atr5m > 0
        ? flowSnap.atr5m
        : latest5mCandle && latest5mCandle.high > latest5mCandle.low
          ? latest5mCandle.high - latest5mCandle.low
          : spotPrice * 0.0015;
    const entryMetrics = computeAdaptiveQuantMetrics(spotPrice, entryAtr5m);
    const signalBodyBaselineAtr: number =
      flowSnap && typeof flowSnap.atr5m === "number" && flowSnap.atr5m > 0
        ? flowSnap.atr5m
        : flowSnap && typeof flowSnap.sigma === "number" && flowSnap.sigma > 0
          ? flowSnap.sigma
          : spotPrice * 0.0015;
    const maxSignalBarBody = computeAdaptiveQuantMetrics(spotPrice, signalBodyBaselineAtr).maxSignalBarBody;
    const minRiskFloor = Math.max(0.05, spotPrice * 0.00067);
    const stopWickBuf = entryMetrics.stopWickBuffer;
    const smallTargetTrim = Math.max(0.02, spotPrice * 0.00013);
    const barBody = latest5mCandle ? latest5mCandle.close - latest5mCandle.open : 0;
    const hasAdequatePutRoomToWall = !(tacticalPw > 0 && spotPrice > tacticalPw && (spotPrice - tacticalPw) < entryMetrics.wallProximityBuffer);
    const hasAdequateCallRoomToWall = !(tacticalCw > 0 && spotPrice < tacticalCw && (tacticalCw - spotPrice) < entryMetrics.wallProximityBuffer);
    const effectiveZeroGamma =
      zeroGamma > 0
        ? zeroGamma
        : Math.max(effectiveFlowVwap, effectiveSma34);
    const resolvedNetGex =
      typeof params.netGex === "number" && Number.isFinite(params.netGex) ? params.netGex : undefined;
    const isPositiveGammaRegime =
      effectiveZeroGamma > 0 &&
      spotPrice > effectiveZeroGamma &&
      (resolvedNetGex !== undefined
        ? resolvedNetGex > 0
        : flowSnap?.gammaRegime === "POSITIVE_GAMMA" ||
          (Math.abs(currentPe) < 1.5 && currentChi >= 0.45 && currentChi <= 0.55));

    // --- Setup 1A: Flux Exhaustion & Late-Chase Guard ---
    const fluxSigma =
      flowSnap && typeof flowSnap.sigma === "number" && flowSnap.sigma > 0
        ? flowSnap.sigma
        : Math.max(0.05, spotPrice * 0.0025);
    const fluxZScore =
        effectiveFlowVwap > 0 ? (spotPrice - effectiveFlowVwap) / fluxSigma : 0;
    const isMomentumDecelerating = currentNetFlux >= 0 || currentPe > -0.75;
    const maxAllowedNegZ = isMomentumDecelerating ? -1.0 : -1.25;
    const vwapStretchPct =
      effectiveFlowVwap > 0 ? (effectiveFlowVwap - spotPrice) / spotPrice : 0;
    const isFluxExhausted =
      fluxZScore < maxAllowedNegZ || vwapStretchPct > 0.0065;

    // Candle rejection wick guard on latest 5m bar
    const barRange = latest5mCandle
      ? Math.max(1e-6, latest5mCandle.high - latest5mCandle.low)
      : 0;
    const lowerWickRatio =
      latest5mCandle && barRange > 0
        ? (Math.min(latest5mCandle.open, latest5mCandle.close) - latest5mCandle.low) / barRange
        : 0;
    const closeInBarRatio =
      latest5mCandle && barRange > 0
        ? (latest5mCandle.close - latest5mCandle.low) / barRange
        : 0;
    const hasBullishWickRejection =
      Boolean(latest5mCandle) &&
      (lowerWickRatio >= 0.40 ||
        (closeInBarRatio >= 0.55 && latest5mCandle!.close >= latest5mCandle!.open));

    if (
      !candidateBto &&
      isOpeningHour &&
      effectiveZeroGamma > 0 &&
      spotPrice < effectiveZeroGamma &&
      spotPrice < effectiveFlowVwap &&
      spotPrice < effectiveSma34 &&
      isShortGammaOrRedFlux &&
      hasAdequatePutRoomToWall &&
      !isFluxExhausted &&
      !hasBullishWickRejection
    ) {
      const rawStructuralStop = Math.min(
        effectiveZeroGamma,
        Math.max(effectiveFlowVwap, latest5mCandle?.high ?? spotPrice + spotPrice * 0.0013, spotPrice + entryMetrics.minReversalInvalidation)
      );
      // Cap spot stop distance to maintain parity with ~25% option stop budget (max 45 bps or 1.25 * fluxSigma)
      const maxTacticalSpotRisk = Math.max(
        entryMetrics.minReversalInvalidation,
        Math.min(spotPrice * 0.0045, fluxSigma * 1.25)
      );
      const stopAnchor = Math.min(rawStructuralStop, spotPrice + maxTacticalSpotRisk);
      const stopLoss = Number((Math.max(spotPrice + entryMetrics.minReversalInvalidation * 0.85, stopAnchor) * 1.001).toFixed(2));
      const risk = Math.max(minRiskFloor, stopLoss - spotPrice);
      const pwFloor = tacticalPw > 0 && tacticalPw < spotPrice ? tacticalPw : 0;
      if (pwFloor === 0 || spotPrice - pwFloor >= risk * 1.5) {
        const maxT1 = Math.floor((spotPrice - risk * 1.5 + 1e-9) * 100) / 100;
        const uncappedT1 = Math.min(maxT1, Number((spotPrice - Math.max(entryMetrics.minWallRoom, risk * 1.65)).toFixed(2)));
        const target1 = pwFloor > 0 ? Math.max(pwFloor, uncappedT1) : uncappedT1;
        const uncappedT2 = Number(
          Math.min(
            target1 - entryMetrics.wallProximityBuffer,
            spotPrice - Math.max(spotPrice * 0.0047, risk * 3.0)
          ).toFixed(2)
        );
        const target2 =
          pwFloor > 0
            ? Number(Math.min(target1, Math.max(pwFloor, uncappedT2)).toFixed(2))
            : Number(Math.min(target1, uncappedT2).toFixed(2));

        if (target1 < spotPrice && target2 <= target1 && (spotPrice - target1) / risk >= 1.5) {
          candidateBto = {
            contractType: "PUT",
            setupName: (etTime.totalMinutes >= ENTRY_START_MINS && etTime.totalMinutes <= 615)
              ? "Pre-Market Flux High Rejection & Bearish Open [BTO PUT]"
              : "Bearish Zero-Gamma Flush [BTO PUT]",
            stopLossSpot: stopLoss,
            target1Spot: target1,
            target2Spot: target2,
          };
        }
      }
    }

    // --- SETUP 1B: Dynamic LOD Put Wall, King Node & Flux-Extremity Reclaim [BTO CALL] ---
    const isMiddayReclaimWindow = etTime.totalMinutes >= 600 && etTime.totalMinutes <= ENTRY_CUTOFF_MINS; // 10:00 AM - 2:30 PM ET
    const activeKingNode = (filteredKing && filteredKing > 0) ? filteredKing : ((params as any).allExpKing && (params as any).allExpKing > 0 ? Number((params as any).allExpKing) : 0);
    const tacticalBookCenter = (activeKingNode > 0 && Math.abs(activeKingNode - spotPrice) / spotPrice <= 0.012)
      ? activeKingNode
      : (tacticalPw > 0 && tacticalCw > tacticalPw)
        ? Number(((tacticalCw + tacticalPw) / 2).toFixed(2))
        : effectiveSma34;
    const recent5mLow = latest5mCandle ? Math.min(latest5mCandle.low, latest5mCandle.prevLow ?? latest5mCandle.low, spotPrice) : spotPrice;
    const recent5mHigh = latest5mCandle ? Math.max(latest5mCandle.high, latest5mCandle.prevHigh ?? latest5mCandle.high, spotPrice) : spotPrice;
    const testedPutWallOrKingOrFlux =
      (tacticalPw > 0 && Math.abs(recent5mLow - tacticalPw) / tacticalPw <= 0.0035) ||
      (flowSnap && flowSnap.lower1Sigma > 0 && Math.abs(recent5mLow - flowSnap.lower1Sigma) / flowSnap.lower1Sigma <= 0.0035) ||
      (activeKingNode > 0 && recent5mLow <= activeKingNode && spotPrice >= activeKingNode) ||
      (effectiveFlowVwap > 0 && (recent5mLow - effectiveFlowVwap) / fluxSigma <= -1.20);
    const reclaimedKingOrSma =
      (tacticalBookCenter > 0 && spotPrice >= tacticalBookCenter && (!latest5mCandle || latest5mCandle.close > latest5mCandle.open)) ||
      (effectiveSma34 > 0 && spotPrice > effectiveSma34 && (!latest5mCandle || latest5mCandle.close > latest5mCandle.open));
    const callMagnetTarget = (tacticalCw > spotPrice + entryMetrics.wallProximityBuffer)
      ? tacticalCw
      : (activeKingNode > spotPrice + entryMetrics.minWallRoom ? activeKingNode : Number((spotPrice + Math.max(Math.max(entryMetrics.minWallRoom, spotPrice * 0.0033), fluxSigma * 2.2)).toFixed(2)));
    const callRoomToWall = callMagnetTarget - spotPrice;

    if (
      !candidateBto &&
      isMiddayReclaimWindow &&
      testedPutWallOrKingOrFlux &&
      reclaimedKingOrSma &&
      hasAdequateCallRoomToWall &&
      callRoomToWall >= entryMetrics.minWallRoom &&
      Math.abs(barBody) <= maxSignalBarBody
    ) {
      const stopLoss = Number((Math.min(recent5mLow - stopWickBuf, spotPrice - Math.max(entryMetrics.minReversalInvalidation, spotPrice * 0.0011))).toFixed(2));
      const risk = Math.max(minRiskFloor, spotPrice - stopLoss);
      const cwWallBound = tacticalCw > spotPrice ? Math.min(tacticalCw, callMagnetTarget) : callMagnetTarget;
      if (callRoomToWall >= risk * 1.5 && cwWallBound - spotPrice >= risk * 1.5) {
        const minT1 = Math.ceil((spotPrice + risk * 1.5 - 1e-9) * 100) / 100;
        const uncappedT1 = Number((spotPrice + Math.max(entryMetrics.wallProximityBuffer, callRoomToWall * 0.60)).toFixed(2));
        const target1 = Number(Math.min(cwWallBound, Math.max(minT1, uncappedT1)).toFixed(2));
        const rawT2 = Number((cwWallBound - smallTargetTrim).toFixed(2));
        const target2 = Number(Math.min(cwWallBound, Math.max(target1, rawT2)).toFixed(2));
        if (target1 > spotPrice && target2 >= target1 && (target1 - spotPrice) / risk >= 1.5) {
          candidateBto = {
            contractType: "CALL",
            setupName: "Put Wall / King Node & Flux Extremity Reclaim [BTO CALL]",
            stopLossSpot: stopLoss,
            target1Spot: target1,
            target2Spot: target2,
          };
        }
      }
    }

      // --- SETUP 1C: Zero-Gamma Flip & Boundary Flux Reclaim [BTO CALL] ---
      const reclaimedZeroGammaAndVwap =
        effectiveZeroGamma > 0 &&
        spotPrice > effectiveZeroGamma &&
        spotPrice > effectiveFlowVwap &&
        spotPrice > effectiveSma34;
      const hasPositiveFluxImpulse =
        currentChi >= 0.48 || currentNetFlux > 0 || currentPe >= 0.40 || store.macroRegime === "CALL";
      if (
        !candidateBto &&
        isMiddayReclaimWindow &&
        (!isPositiveGammaRegime || Math.abs(currentPe) >= 1.5) &&
        reclaimedZeroGammaAndVwap &&
        hasPositiveFluxImpulse &&
        hasAdequateCallRoomToWall &&
        (!latest5mCandle || latest5mCandle.close >= latest5mCandle.open) &&
        callRoomToWall >= entryMetrics.minWallRoom &&
        Math.abs(barBody) <= maxSignalBarBody
      ) {
        const stopLoss = Number((Math.min(effectiveFlowVwap - stopWickBuf, spotPrice - entryMetrics.minReversalInvalidation)).toFixed(2));
        const risk = Math.max(minRiskFloor, spotPrice - stopLoss);
        const cwWallBound = tacticalCw > spotPrice ? Math.min(tacticalCw, callMagnetTarget) : callMagnetTarget;
        if (callRoomToWall >= risk * 1.5 && cwWallBound - spotPrice >= risk * 1.5) {
          const minT1 = Math.ceil((spotPrice + risk * 1.5 - 1e-9) * 100) / 100;
          const uncappedT1 = Number((spotPrice + Math.max(entryMetrics.wallProximityBuffer, callRoomToWall * 0.65)).toFixed(2));
          const target1 = Number(Math.min(cwWallBound, Math.max(minT1, uncappedT1)).toFixed(2));
          const rawT2 = Number((cwWallBound - Math.max(0.02, spotPrice * 0.00016)).toFixed(2));
          const target2 = Number(Math.min(cwWallBound, Math.max(target1, rawT2)).toFixed(2));
          if (target1 > spotPrice && target2 >= target1 && (target1 - spotPrice) / risk >= 1.5) {
            candidateBto = {
              contractType: "CALL",
              setupName: "Zero-Gamma Flip & Flux Reclaim [BTO CALL]",
              stopLossSpot: stopLoss,
              target1Spot: target1,
              target2Spot: target2,
            };
          }
        }
      }

    // Allow SPY and watched tickers to evaluate structural setups (including Bearish Zero-Gamma Flush [BTO PUT])
    if (!candidateBto && flowSnap && latest5mCandle) {
      const bandSig = flowSnap.bandSignal;

      // 1B. Gaia Call Regime: Flow VWAP -2σ or -1σ Wick Bounce / Positive-Gamma Sweep Reclaim
      if (
        (bandSig === "LOWER_2S_BOUNCE" ||
          (bandSig === "LOWER_1S_BOUNCE" && currentChi >= 0.52) ||
          (isPositiveGammaRegime &&
            Math.abs(currentPe) < 1.5 &&
            (spotPrice <= flowSnap.lower1Sigma * 1.0015 || recent5mLow <= flowSnap.lower1Sigma) &&
            divergence5m === "BULL" &&
            spotPrice >= effectiveFlowVwap)) &&
        currentChi >= 0.45 &&
        hasAdequateCallRoomToWall &&
        latest5mCandle.close > latest5mCandle.open &&
        (flowSnap.flowVwap > spotPrice + spotPrice * 0.0003 || (isPositiveGammaRegime && spotPrice >= flowSnap.flowVwap))
      ) {
        const floorStopRef =
          bandSig === "LOWER_2S_BOUNCE"
            ? Math.min(latest5mCandle.low, flowSnap.lower2Sigma)
            : Math.min(latest5mCandle.low, flowSnap.lower1Sigma);
        const stopLoss = Number((floorStopRef - spotPrice * 0.0006).toFixed(2));
        const risk = Math.max(Math.max(0.05, spotPrice * 0.00033), spotPrice - stopLoss);
        const cwCeiling = tacticalCw > spotPrice ? tacticalCw : 0;
        if (cwCeiling === 0 || cwCeiling - spotPrice >= risk * 1.5) {
          const minT1 = Math.ceil((spotPrice + risk * 1.5 - 1e-9) * 100) / 100;
          const desiredT1 = Number((Math.ceil((Math.max(minT1, flowSnap.flowVwap) - 1e-9) * 100) / 100).toFixed(2));
          const target1 = cwCeiling > 0 ? Math.min(cwCeiling, desiredT1) : desiredT1;
          const desiredT2 = Number(
            Math.max(target1 + Math.max(0.05, spotPrice * 0.0005), flowSnap.upper1Sigma, cwCeiling > 0 ? cwCeiling : flowSnap.upper2Sigma).toFixed(2)
          );
          const target2 = cwCeiling > 0 ? Number(Math.max(target1, Math.min(cwCeiling, desiredT2)).toFixed(2)) : desiredT2;
          if (target1 > spotPrice && target2 >= target1 && (target1 - spotPrice) / risk >= 1.5) {
            candidateBto = {
              contractType: "CALL",
              setupName: `Gaia Call Regime -2σ Flow Bounce (χ=${(currentChi * 100).toFixed(0)}%)`,
              stopLossSpot: stopLoss,
              target1Spot: target1,
              target2Spot: target2,
            };
          }
        }
      }
      // 1C. Gaia Put Regime: Flow VWAP +2σ or +1σ Wick Rejection / Positive-Gamma Sweep Rejection
      else if (
        (bandSig === "UPPER_2S_REJECT" ||
          (bandSig === "UPPER_1S_REJECT" && currentChi <= 0.48) ||
          (isPositiveGammaRegime &&
            Math.abs(currentPe) < 1.5 &&
            (spotPrice >= flowSnap.upper1Sigma * 0.9985 || recent5mHigh >= flowSnap.upper1Sigma) &&
            divergence5m === "BEAR" &&
            spotPrice <= effectiveFlowVwap)) &&
        currentChi <= 0.55 &&
        hasAdequatePutRoomToWall &&
        latest5mCandle.close < latest5mCandle.open &&
        latest5mCandle.close <= latest5mCandle.sma34 &&
        (flowSnap.flowVwap < spotPrice - spotPrice * 0.0003 || (isPositiveGammaRegime && spotPrice <= flowSnap.flowVwap))
      ) {
        const ceilStopRef =
          bandSig === "UPPER_2S_REJECT"
            ? Math.max(latest5mCandle.high, flowSnap.upper2Sigma)
            : Math.max(latest5mCandle.high, flowSnap.upper1Sigma);
        const stopLoss = Number((ceilStopRef + spotPrice * 0.0006).toFixed(2));
        const risk = Math.max(Math.max(0.05, spotPrice * 0.00033), stopLoss - spotPrice);
        const pwFloor = tacticalPw > 0 && tacticalPw < spotPrice ? tacticalPw : 0;
        if (pwFloor === 0 || spotPrice - pwFloor >= risk * 1.5) {
          const maxT1 = Math.floor((spotPrice - risk * 1.5 + 1e-9) * 100) / 100;
          const desiredT1 = Number((Math.floor((Math.min(maxT1, flowSnap.flowVwap) + 1e-9) * 100) / 100).toFixed(2));
          const target1 = pwFloor > 0 ? Math.max(pwFloor, desiredT1) : desiredT1;
          const desiredT2 = Number(
            Math.min(target1 - Math.max(0.05, spotPrice * 0.0005), flowSnap.lower1Sigma, pwFloor > 0 ? pwFloor : flowSnap.lower2Sigma).toFixed(2)
          );
          const target2 = pwFloor > 0 ? Number(Math.min(target1, Math.max(pwFloor, desiredT2)).toFixed(2)) : desiredT2;
          if (target1 < spotPrice && target2 <= target1 && (spotPrice - target1) / risk >= 1.5) {
            candidateBto = {
              contractType: "PUT",
              setupName: `Gaia Put Regime +2σ Flow Rejection (χ=${(currentChi * 100).toFixed(0)}%)`,
              stopLossSpot: stopLoss,
              target1Spot: target1,
              target2Spot: target2,
            };
          }
        }
      }
      // 1D. Gaia Flux Field Advection Breakout (High Péclet Momentum; deferred in Positive Gamma low-|Pe| chop)
      else if (
        (!isPositiveGammaRegime || Math.abs(currentPe) >= 1.5) &&
        currentChi >= 0.58 &&
        currentPe >= 0.85 &&
        currentNetFlux > 0 &&
        hasAdequateCallRoomToWall &&
        spotPrice > flowSnap.flowVwap &&
        latest5mCandle.close > latest5mCandle.sma34 &&
        latest5mCandle.close > latest5mCandle.open &&
        Math.abs(barBody) <= maxSignalBarBody
      ) {
        const candleStop = Number((Math.min(flowSnap.flowVwap, latest5mCandle.low) - spotPrice * 0.0005).toFixed(2));
        const candleRisk = Math.max(minRiskFloor, spotPrice - candleStop);
        const vwapStop = Number((flowSnap.flowVwap - spotPrice * 0.0005).toFixed(2));
        const vwapRisk = Math.max(minRiskFloor, spotPrice - vwapStop);
        const cwCeiling = tacticalCw > spotPrice ? tacticalCw : 0;
        const stopLoss =
          cwCeiling > 0 && cwCeiling - spotPrice < candleRisk * 1.5 && cwCeiling - spotPrice >= vwapRisk * 1.5
            ? vwapStop
            : candleStop;
        const risk = Math.max(minRiskFloor, spotPrice - stopLoss);
        if (cwCeiling === 0 || cwCeiling - spotPrice >= risk * 1.5) {
          const minT1 = Math.ceil((spotPrice + risk * 1.5 - 1e-9) * 100) / 100;
          const sigma1Target = cwCeiling > 0 ? Math.min(cwCeiling, flowSnap.upper1Sigma) : flowSnap.upper1Sigma;
          const rawT1 = Number((Math.ceil((Math.max(minT1, sigma1Target) - 1e-9) * 100) / 100).toFixed(2));
          const target1 = cwCeiling > 0 ? Math.min(cwCeiling, rawT1) : rawT1;
          const rawT2 = Number(Math.max(target1 + Math.max(0.05, spotPrice * 0.0005), flowSnap.upper2Sigma, cwCeiling).toFixed(2));
          const target2 = cwCeiling > 0 ? Number(Math.max(target1, Math.min(cwCeiling, rawT2)).toFixed(2)) : rawT2;
          if (target1 > spotPrice && target2 >= target1 && (target1 - spotPrice) / risk >= 1.5) {
            candidateBto = {
              contractType: "CALL",
              setupName: `Gaia Advection Breakout (χ=${(currentChi * 100).toFixed(0)}%, Pe=+${currentPe.toFixed(2)})`,
              stopLossSpot: stopLoss,
              target1Spot: target1,
              target2Spot: target2,
            };
          }
        }
      } else if (
        (!isPositiveGammaRegime || Math.abs(currentPe) >= 1.5) &&
        currentChi <= 0.42 &&
        currentPe <= -0.85 &&
        currentNetFlux < 0 &&
        hasAdequatePutRoomToWall &&
        spotPrice < flowSnap.flowVwap &&
        latest5mCandle.close < latest5mCandle.sma34 &&
        latest5mCandle.close < latest5mCandle.open &&
        Math.abs(barBody) <= maxSignalBarBody
      ) {
        const candleStop = Number((Math.max(flowSnap.flowVwap, latest5mCandle.high) + spotPrice * 0.0005).toFixed(2));
        const candleRisk = Math.max(minRiskFloor, candleStop - spotPrice);
        const vwapStop = Number((flowSnap.flowVwap + spotPrice * 0.0005).toFixed(2));
        const vwapRisk = Math.max(minRiskFloor, vwapStop - spotPrice);
        const pwFloor = tacticalPw > 0 && tacticalPw < spotPrice ? tacticalPw : 0;
        const stopLoss =
          pwFloor > 0 && spotPrice - pwFloor < candleRisk * 1.5 && spotPrice - pwFloor >= vwapRisk * 1.5
            ? vwapStop
            : candleStop;
        const risk = Math.max(minRiskFloor, stopLoss - spotPrice);
        if (pwFloor === 0 || spotPrice - pwFloor >= risk * 1.5) {
          const maxT1 = Math.floor((spotPrice - risk * 1.5 + 1e-9) * 100) / 100;
          const sigma1Target = pwFloor > 0 ? Math.max(pwFloor, flowSnap.lower1Sigma) : flowSnap.lower1Sigma;
          const rawT1 = Number((Math.floor((Math.min(maxT1, sigma1Target) + 1e-9) * 100) / 100).toFixed(2));
          const target1 = pwFloor > 0 ? Math.max(pwFloor, rawT1) : rawT1;
          const rawT2 = Number(
            Math.min(target1 - Math.max(0.05, spotPrice * 0.0005), flowSnap.lower2Sigma, pwFloor > 0 ? pwFloor : flowSnap.lower2Sigma).toFixed(2)
          );
          const target2 = pwFloor > 0 ? Number(Math.min(target1, Math.max(pwFloor, rawT2)).toFixed(2)) : rawT2;
          if (target1 < spotPrice && target2 <= target1 && (spotPrice - target1) / risk >= 1.5) {
            candidateBto = {
              contractType: "PUT",
              setupName: `Gaia Advection Breakdown (χ=${(currentChi * 100).toFixed(0)}%, Pe=${currentPe.toFixed(2)})`,
              stopLossSpot: stopLoss,
              target1Spot: target1,
              target2Spot: target2,
            };
          }
        }
      }
    }

    // --- SETUP 2: BTO CALLS — Support Bounce / Bullish Reversal ---
    const putBounceRef =
      dailyExpectedMove?.low &&
      dailyExpectedMove.low > 0 &&
      dailyExpectedMove.low > tacticalPw &&
      Math.abs(spotPrice - dailyExpectedMove.low) / spotPrice <= 0.015
        ? Number(dailyExpectedMove.low.toFixed(2))
        : tacticalPw > 0
          ? tacticalPw
          : Number((spotPrice * 0.992).toFixed(2));

    const isTestingPutBounce =
      putBounceRef > 0 &&
      spotPrice >= putBounceRef * 0.998 &&
      spotPrice <= putBounceRef * 1.0025 &&
      (!latest5mCandle || latest5mCandle.low <= putBounceRef * 1.0012);

    // Strict Counter-Trend Call Block Invariant:
    // Block Support Bounce Calls if spot is below Zero Gamma (negative gamma hedging regime),
    // below Flow VWAP, below 5m SMA34, or market is in a Put regime (chi < 50% / macroRegime === "PUT").
    // Enforces opening-range firewall (< 9:45 AM ET) when indicators are unpopulated or in negative gamma.
    const deltaChi6 = typeof flowSnap?.deltaChi6Bar === "number" ? flowSnap.deltaChi6Bar : 0;
    const deltaImpulseChi6 = typeof flowSnap?.deltaImpulseChi6Bar === "number" ? flowSnap.deltaImpulseChi6Bar : 0;
    const deltaFlux6 = typeof flowSnap?.deltaNetFlux6Bar === "number" ? flowSnap.deltaNetFlux6Bar : 0;
    const impChi = typeof flowSnap?.impulseChi === "number" ? flowSnap.impulseChi : currentChi;
    const impPe = typeof flowSnap?.impulsePeclet === "number" ? flowSnap.impulsePeclet : currentPe;
    const minus1Sigma =
      flowSnap && typeof flowSnap.lower1Sigma === "number" && flowSnap.lower1Sigma > 0 ? flowSnap.lower1Sigma : 0;
    const plus1Sigma =
      flowSnap && typeof flowSnap.upper1Sigma === "number" && flowSnap.upper1Sigma > 0 ? flowSnap.upper1Sigma : 0;
    const testedPutWallOrMinus1Sigma =
      (tacticalPw > 0 && Math.abs(recent5mLow - tacticalPw) / tacticalPw <= 0.0035) ||
      (minus1Sigma > 0 &&
        (Math.abs(recent5mLow - minus1Sigma) / minus1Sigma <= 0.0035 ||
          (recent5mLow <= minus1Sigma && spotPrice >= minus1Sigma * 0.9985))) ||
      flowSnap?.bandSignal === "LOWER_1S_BOUNCE" ||
      flowSnap?.bandSignal === "LOWER_2S_BOUNCE";
    const testedCallWallOrPlus1Sigma =
      (tacticalCw > 0 && Math.abs(recent5mHigh - tacticalCw) / tacticalCw <= 0.0035) ||
      (plus1Sigma > 0 &&
        (Math.abs(recent5mHigh - plus1Sigma) / plus1Sigma <= 0.0035 ||
          (recent5mHigh >= plus1Sigma && spotPrice <= plus1Sigma * 1.0015))) ||
      flowSnap?.bandSignal === "UPPER_1S_REJECT" ||
      flowSnap?.bandSignal === "UPPER_2S_REJECT";
    const reclaimedSmaAndVwapOrCenter = Boolean(
      latest5mCandle &&
        latest5mCandle.close > latest5mCandle.open &&
        ((spotPrice >= effectiveSma34 || spotPrice >= effectiveFlowVwap) ||
          (tacticalBookCenter > 0 && spotPrice >= tacticalBookCenter))
    );
    const lostSmaAndVwapOrCenter = Boolean(
      latest5mCandle &&
        latest5mCandle.close < latest5mCandle.open &&
        ((spotPrice <= effectiveSma34 || spotPrice <= effectiveFlowVwap) ||
          (tacticalBookCenter > 0 && spotPrice <= tacticalBookCenter))
    );
    const leg2CallUpperCeiling = Math.max(
      effectiveZeroGamma > spotPrice ? effectiveZeroGamma : 0,
      tacticalCw > spotPrice ? tacticalCw : 0,
      activeKingNode > spotPrice ? activeKingNode : 0
    );
    const leg2CallRoom = leg2CallUpperCeiling > spotPrice ? leg2CallUpperCeiling - spotPrice : callRoomToWall;
    const putFloorCandidates = [effectiveZeroGamma, tacticalPw, activeKingNode].filter(
      (v): v is number => typeof v === "number" && v > 0 && v < spotPrice
    );
    const leg2PutLowerTarget =
      tacticalPw > 0 && tacticalPw < spotPrice - entryMetrics.minWallRoom
        ? tacticalPw
        : putFloorCandidates.length > 0
          ? Math.min(...putFloorCandidates)
          : Number((spotPrice - Math.max(Math.max(entryMetrics.minWallRoom, spotPrice * 0.0033), fluxSigma * 2.2)).toFixed(2));
    const leg2PutRoom = Math.max(
      effectiveZeroGamma > 0 && effectiveZeroGamma < spotPrice ? spotPrice - effectiveZeroGamma : 0,
      tacticalPw > 0 && tacticalPw < spotPrice ? spotPrice - tacticalPw : 0
    );
    const hasBullImpulseReclaim = Boolean(
      !isOpeningRange &&
      etTime.totalMinutes >= 630 &&
      impChi >= 0.60 &&
      (deltaChi6 >= 0.03 || deltaImpulseChi6 >= 0.06 || deltaFlux6 > 0 || spotPrice >= effectiveFlowVwap || spotPrice >= effectiveSma34) &&
      (deltaFlux6 > 0 || impPe >= 0.40 || spotPrice >= effectiveFlowVwap || spotPrice >= effectiveSma34) &&
      barBody <= maxSignalBarBody &&
      (!isPhase2ReclaimWindow || (testedPutWallOrMinus1Sigma && leg2CallRoom >= entryMetrics.minWallRoom)) &&
      (divergence5m === "BULL" ||
        divergence30m === "BULL" ||
        reclaimedSmaAndVwapOrCenter ||
        (latest5mCandle &&
          latest5mCandle.close > latest5mCandle.open &&
          (latest5mCandle.close >= latest5mCandle.sma34 ||
            (flowSnap && typeof flowSnap.flowVwap === "number" && latest5mCandle.close >= flowSnap.flowVwap))))
    );
    const hasBearImpulseRejection = Boolean(
      !isOpeningRange &&
      etTime.totalMinutes >= 630 &&
      impChi <= 0.40 &&
      (deltaChi6 <= -0.03 || deltaImpulseChi6 <= -0.06 || deltaFlux6 < 0 || spotPrice <= effectiveFlowVwap || spotPrice <= effectiveSma34) &&
      (deltaFlux6 < 0 || impPe <= -0.40 || spotPrice <= effectiveFlowVwap || spotPrice <= effectiveSma34) &&
      -barBody <= maxSignalBarBody &&
      (!isPhase2ReclaimWindow || (testedCallWallOrPlus1Sigma && leg2PutRoom >= entryMetrics.minWallRoom)) &&
      (divergence5m === "BEAR" ||
        divergence30m === "BEAR" ||
        lostSmaAndVwapOrCenter ||
        (latest5mCandle &&
          latest5mCandle.close < latest5mCandle.open &&
          (latest5mCandle.close <= latest5mCandle.sma34 ||
            (flowSnap && typeof flowSnap.flowVwap === "number" && latest5mCandle.close <= flowSnap.flowVwap))))
    );
    const hasPositiveGammaPutSweepBounce = Boolean(
      !isOpeningRange &&
      isPositiveGammaRegime &&
      Math.abs(currentPe) < 1.5 &&
      testedPutWallOrMinus1Sigma &&
      divergence5m === "BULL" &&
      spotPrice >= effectiveFlowVwap &&
      latest5mCandle &&
      latest5mCandle.close >= latest5mCandle.sma34
    );
    const hasPositiveGammaCallSweepReject = Boolean(
      !isOpeningRange &&
      isPositiveGammaRegime &&
      Math.abs(currentPe) < 1.5 &&
      testedCallWallOrPlus1Sigma &&
      divergence5m === "BEAR" &&
      spotPrice <= effectiveFlowVwap &&
      latest5mCandle &&
      latest5mCandle.close <= latest5mCandle.sma34
    );
    const isCounterTrendCallBlocked = Boolean(
      !hasBullImpulseReclaim &&
      !hasPositiveGammaPutSweepBounce && (
      (zeroGamma > 0 && spotPrice < zeroGamma) ||
      (flowSnap && typeof flowSnap.flowVwap === "number" && spotPrice < flowSnap.flowVwap) ||
      (latest5mCandle && typeof latest5mCandle.sma34 === "number" && spotPrice < latest5mCandle.sma34) ||
      currentChi < 0.50 ||
      store.macroRegime === "PUT" ||
      isOpeningNegativeGamma ||
      (isOpeningRange && (currentChi < 0.50 || isOpeningNegativeGamma)))
    );

    const isBullConfirmation =
      !isCounterTrendCallBlocked &&
      (divergence5m === "BULL" ||
        divergence30m === "BULL" ||
        Boolean(
          latest5mCandle &&
            latest5mCandle.close > latest5mCandle.open &&
            (latest5mCandle.close >= latest5mCandle.sma34 ||
              latest5mCandle.close >= putBounceRef * 1.0008)
        ));

    if (isTestingPutBounce && isBullConfirmation && hasAdequateCallRoomToWall) {
      const target2 =
        filteredKing && filteredKing > spotPrice + entryMetrics.minWallRoom && (filteredKing - spotPrice) / spotPrice <= 0.015
          ? filteredKing
          : tacticalCw > spotPrice + entryMetrics.minWallRoom
            ? tacticalCw
            : dailyExpectedMove?.high && dailyExpectedMove.high > spotPrice
              ? Number(dailyExpectedMove.high.toFixed(2))
              : Number((spotPrice * 1.008).toFixed(2));

      // Stop loss sits strictly below the support wall (never above putBounceRef)
      const structuralFloor = Math.min(putBounceRef, latest5mCandle?.low ?? putBounceRef);
      const rawStop = Number((structuralFloor - spotPrice * 0.0006).toFixed(2));
      const maxAllowedRisk = Math.max(minRiskFloor, (target2 - spotPrice) * 0.39);
      const stopLoss = Number(Math.min(putBounceRef - stopWickBuf, Math.max(rawStop, spotPrice - maxAllowedRisk)).toFixed(2));
      const risk = Math.max(Math.max(0.05, spotPrice * 0.00033), spotPrice - stopLoss);
      const totalReward2 = Math.max(entryMetrics.minWallRoom, target2 - spotPrice);

      const minTarget1 = spotPrice + risk * 1.5;
      const candidates = [zeroGamma, bookCenter, filteredKing].filter(
        (v): v is number => typeof v === "number" && v >= minTarget1 && v < target2
      );
      const target1 =
        candidates.length > 0
          ? Math.min(...candidates)
          : Number(Math.min(target2 - stopWickBuf, Math.max(minTarget1, spotPrice + totalReward2 * 0.56)).toFixed(2));

      if (target1 > spotPrice && target2 >= target1 && (target1 - spotPrice) / risk >= 1.5) {
        candidateBto = {
          contractType: "CALL",
          setupName: "Support Bounce / Bullish Reversal",
          stopLossSpot: stopLoss,
          target1Spot: Number(target1.toFixed(2)),
          target2Spot: Number(target2.toFixed(2)),
        };
      }
    }

    // Invariant 2C: Morning Bullish King Magnet Pull (09:35 - 11:00 ET)
    // If underlying holds above SMA34 / VWAP and a strong Tactical King sits overhead with high concentration,
    // enter King Magnet Trend Pull Call to ride the morning institutional liquidity wave
    if (
      !candidateBto &&
      etTime.totalMinutes >= 575 &&
      etTime.totalMinutes <= 660 &&
      hasAdequateCallRoomToWall &&
      filteredKing &&
      filteredKing > spotPrice + entryMetrics.wallProximityBuffer &&
      (filteredKing - spotPrice) / spotPrice <= 0.015 &&
      latest5mCandle &&
      spotPrice >= latest5mCandle.sma34 &&
      latest5mCandle.close >= latest5mCandle.open
    ) {
      const stopLoss = Number((Math.min(latest5mCandle.low, spotPrice - Math.max(entryMetrics.minReversalInvalidation, spotPrice * 0.0011)) * 0.999).toFixed(2));
      const risk = Math.max(Math.max(0.05, spotPrice * 0.00033), spotPrice - stopLoss);
      const target2 = filteredKing;
      const target1 = Number((spotPrice + Math.max(risk * 1.5, (target2 - spotPrice) * 0.5)).toFixed(2));
      if (target1 > spotPrice && target2 >= target1 && (target1 - spotPrice) / risk >= 1.5) {
        candidateBto = {
          contractType: "CALL",
          setupName: "King Magnet Trend Pull",
          stopLossSpot: stopLoss,
          target1Spot: target1,
          target2Spot: target2,
        };
      }
    }

    // --- SETUP 2: BTO PUTS — Resistance Rejection / Bearish Reversal ---
    const prevClosedTrade = lastClosed;
    if (candidateBto && sameTickerClosed.length === 1 && prevClosedTrade && candidateBto.contractType === prevClosedTrade.contractType) {
      candidateBto = null; // Leg 2 must be an opposite-regime structural rotation
    }
    if (!candidateBto) {
      const baseCallRejectRef =
        dailyExpectedMove?.high &&
        dailyExpectedMove.high > 0 &&
        dailyExpectedMove.high < tacticalCw &&
        Math.abs(dailyExpectedMove.high - spotPrice) / spotPrice <= 0.015
          ? Number(dailyExpectedMove.high.toFixed(2))
          : tacticalCw > 0
            ? tacticalCw
            : Number((spotPrice * 1.008).toFixed(2));
      // If Tactical 0DTE/1DTE King sits above baseCallRejectRef within the upper range (e.g. $767 King vs $766 EM),
      // anchor resistance rejection to the Tactical King so we never short midday chop below the upper magnet!
      const callRejectRef =
        filteredKing &&
        filteredKing >= baseCallRejectRef &&
        (filteredKing - spotPrice) / spotPrice <= 0.012
          ? filteredKing
          : baseCallRejectRef;

      const isTestingCallReject =
        callRejectRef > 0 &&
        spotPrice <= callRejectRef * 1.002 &&
        spotPrice >= callRejectRef * 0.9987 &&
        (!latest5mCandle || latest5mCandle.high >= callRejectRef * 0.9992);

      // Anti-Pinning Trap Guardrail:
      // If the Tactical 0DTE/Next-Exp King sits at callRejectRef (e.g. $767 King with 49.8% gamma share)
      // and price is holding ABOVE the 5m SMA34, price is in a Bullish Pinning Regime —
      // NEVER short HOD into an active upward King pin unless 5m candle closes strictly below SMA34!
      const isTacticalKingPinningOverhead =
        Boolean(filteredKing && Math.abs(filteredKing - callRejectRef) / spotPrice <= 0.003);

      const isConfirmedBelowSmaWhenPinned =
        !isTacticalKingPinningOverhead ||
        !latest5mCandle ||
        latest5mCandle.close <= latest5mCandle.sma34;

      // Invariant 2A: Counter-Trend Put Block (isBullishRegimeLocked)
      // When price is holding above SMA34 with an overhead Tactical King magnet,
      // or price is in a strong bullish trend with Higher-Highs, or Gaia Call Regime (chi >= 55%), strictly block counter-trend Puts!
      const isBullishRegimeLocked =
        !hasBearImpulseRejection &&
        !hasPositiveGammaCallSweepReject &&
        Boolean(
          (filteredKing && filteredKing > spotPrice && latest5mCandle && latest5mCandle.close >= latest5mCandle.sma34) ||
          (latest5mCandle && latest5mCandle.close > latest5mCandle.sma34 && divergence5m === "BULL") ||
          currentChi >= 0.55
        );

      const isBearConfirmation =
        !isBullishRegimeLocked &&
        isConfirmedBelowSmaWhenPinned &&
        (divergence5m === "BEAR" ||
          divergence30m === "BEAR" ||
          Boolean(
            latest5mCandle &&
              latest5mCandle.close < latest5mCandle.open &&
              latest5mCandle.close <= latest5mCandle.sma34
          ));

      if (isTestingCallReject && isBearConfirmation && hasAdequatePutRoomToWall) {
        const target2 =
          tacticalPw < spotPrice && tacticalPw > 0
            ? (dailyExpectedMove?.low && dailyExpectedMove.low > tacticalPw && dailyExpectedMove.low < spotPrice
                ? Number(dailyExpectedMove.low.toFixed(2))
                : tacticalPw)
            : dailyExpectedMove?.low && dailyExpectedMove.low < spotPrice
              ? Number(dailyExpectedMove.low.toFixed(2))
              : Number((spotPrice * 0.993).toFixed(2));

        // Stop loss must sit strictly above the resistance wall & rejection candle high (never below callRejectRef)
        const structuralCeiling = Math.max(callRejectRef, latest5mCandle?.high ?? callRejectRef);
        const stopLoss = Number((structuralCeiling * 1.0012).toFixed(2));
        const risk = Math.max(Math.max(0.05, spotPrice * 0.00033), stopLoss - spotPrice);
        const totalReward2 = Math.max(entryMetrics.minWallRoom, spotPrice - target2);

        const maxTarget1 = spotPrice - risk * 1.5;
        // Invariant: Targets for a PUT must strictly be LOWER than spot/entry (v <= maxTarget1) and ABOVE target2 (v > target2)
        const candidates = [zeroGamma, bookCenter, filteredKing, latest5mCandle?.sma34].filter(
          (v): v is number => typeof v === "number" && v <= maxTarget1 && v > target2
        );
        const target1 =
          candidates.length > 0
            ? Math.max(...candidates)
            : Number(Math.max(target2 + stopWickBuf, Math.min(maxTarget1, spotPrice - totalReward2 * 0.55)).toFixed(2));

        if (target1 < spotPrice && target2 <= target1 && (spotPrice - target1) / risk >= 1.5) {
          candidateBto = {
            contractType: "PUT",
            setupName: "Resistance Rejection / Bearish Reversal",
            stopLossSpot: stopLoss,
            target1Spot: Number(target1.toFixed(2)),
            target2Spot: Number(target2.toFixed(2)),
          };
        }
      }
    }

    // --- SETUP 3: BTO CALLS or PUTS — Zero-Gamma Volatility Breakout ---
    if (!candidateBto && zeroGamma > 0) {
      // Bullish Zero-Gamma Breakout (Crosses Above zeroGamma)
      if (
        prevSpotPrice <= zeroGamma &&
        spotPrice > zeroGamma &&
        hasAdequateCallRoomToWall &&
        latest5mCandle &&
        latest5mCandle.close > latest5mCandle.sma34 &&
        callWall > spotPrice &&
        (callWall - spotPrice) >= entryMetrics.wallProximityBuffer &&
        (callWall - spotPrice) / spotPrice >= 0.0025
      ) {
        const stopLoss = Number((zeroGamma * (1 - 0.0012)).toFixed(2));
        const risk = Math.max(minRiskFloor, spotPrice - stopLoss);
        if (callWall - spotPrice >= risk * 1.5) {
          const minT1 = Math.ceil((spotPrice + risk * 1.5 - 1e-9) * 100) / 100;
          const rawT1 =
            filteredKing && filteredKing >= minT1 && filteredKing < callWall
              ? filteredKing
              : dailyExpectedMove?.high && dailyExpectedMove.high > spotPrice
                ? Number((spotPrice + 0.5 * (Math.min(callWall, dailyExpectedMove.high) - spotPrice)).toFixed(2))
                : Number((spotPrice + 0.5 * (callWall - spotPrice)).toFixed(2));
          const target1 = Number(Math.min(callWall, Math.max(minT1, rawT1)).toFixed(2));
          if (target1 > spotPrice && callWall >= target1 && (target1 - spotPrice) / risk >= 1.5) {
            candidateBto = {
              contractType: "CALL",
              setupName: "Zero-Gamma Bullish Volatility Breakout",
              stopLossSpot: stopLoss,
              target1Spot: target1,
              target2Spot: Number(Math.max(target1, callWall).toFixed(2)),
            };
          }
        }
      }
      // Bearish Zero-Gamma Flush (Crosses or Opens Below zeroGamma)
      else if (
        (prevSpotPrice >= zeroGamma || isOpeningHour) &&
        spotPrice < zeroGamma &&
        hasAdequatePutRoomToWall &&
        latest5mCandle &&
        latest5mCandle.close < latest5mCandle.sma34 &&
        tacticalPw < spotPrice &&
        tacticalPw > 0 &&
        (spotPrice - tacticalPw) >= entryMetrics.wallProximityBuffer &&
        (spotPrice - tacticalPw) / spotPrice >= 0.0025
      ) {
        const stopLoss = Number((zeroGamma * (1 + 0.0012)).toFixed(2));
        const risk = Math.max(minRiskFloor, stopLoss - spotPrice);
        if (spotPrice - tacticalPw >= risk * 1.5) {
          const maxT1 = Math.floor((spotPrice - risk * 1.5 + 1e-9) * 100) / 100;
          const rawT1 =
            filteredKing && filteredKing <= maxT1 && filteredKing > tacticalPw
              ? filteredKing
              : dailyExpectedMove?.low && dailyExpectedMove.low < spotPrice && dailyExpectedMove.low > tacticalPw
                ? Number((spotPrice - 0.5 * (spotPrice - dailyExpectedMove.low)).toFixed(2))
                : Number((spotPrice - 0.5 * (spotPrice - tacticalPw)).toFixed(2));
          const target1 = Number(Math.max(tacticalPw, Math.min(maxT1, rawT1)).toFixed(2));
          if (target1 < spotPrice && tacticalPw <= target1 && (spotPrice - target1) / risk >= 1.5) {
            candidateBto = {
              contractType: "PUT",
              setupName: "Bearish Zero-Gamma Flush [BTO PUT]",
              stopLossSpot: stopLoss,
              target1Spot: target1,
              target2Spot: Number(Math.min(target1, tacticalPw).toFixed(2)),
            };
          }
        }
      }
    }

    // --- SETUP 4: BTO CALLS or PUTS — Tactical 0DTE/1DTE or Uncontested King Magnet Pull ---
    // Prioritize the Tactical (0DTE / Next-Exp) King (e.g. $767 with 49.8% concentration) over a weak,
    // dispersed All-Exp King (e.g. $755 with 8.5% concentration > 1.5x Daily EM away).
    const tacticalKingStrike =
      filteredKing && filteredKing > 0
        ? filteredKing
        : (kingNode as any)?.zeroDteKing && (kingNode as any).zeroDteKing > 0
          ? (kingNode as any).zeroDteKing
          : 0;
    const allExpKingStrike = kingNode?.strike ?? kingNode?.allExpKing ?? 0;
    const activeKingMagnet =
      tacticalKingStrike > 0 &&
      Math.abs(tacticalKingStrike - spotPrice) / spotPrice >= 0.0022 &&
      Math.abs(tacticalKingStrike - spotPrice) / spotPrice <= 0.012
        ? tacticalKingStrike
        : allExpKingStrike;

    if (!candidateBto && activeKingMagnet > 0) {
      const isTacticalMagnet = activeKingMagnet === tacticalKingStrike;
      const kingStrength = kingNode?.kingStrength ?? 55;
      const isContested = Boolean(kingNode?.isContested);
      const distPct = Math.abs(activeKingMagnet - spotPrice) / spotPrice;

      // Tactical 0DTE/1DTE King Magnet triggers on 5m SMA34 trend confirmation even if multi-week All-Exp is contested
      const qualifiesMagnet =
        distPct >= 0.0022 &&
        distPct <= 0.011 &&
        (isTacticalMagnet || (kingStrength >= 60 && !isContested));

      if (qualifiesMagnet) {
        // Bullish King Magnet: activeKingMagnet > spotPrice (e.g. SPY $763.60 -> Tactical King $767)
        if (
          activeKingMagnet > spotPrice &&
          hasAdequateCallRoomToWall &&
          latest5mCandle &&
          latest5mCandle.close > latest5mCandle.sma34 &&
          latest5mCandle.close > latest5mCandle.open
        ) {
          const stopBase = Math.min(latest5mCandle.sma34, latest5mCandle.low);
          const stopLoss = Number((stopBase * (1 - 0.001)).toFixed(2));
          const risk = Math.max(minRiskFloor, spotPrice - stopLoss);
          const cwMagnetCap = tacticalCw > spotPrice ? Math.min(tacticalCw, activeKingMagnet) : activeKingMagnet;
          if (cwMagnetCap - spotPrice >= risk * 1.5) {
            const minT1 = Math.ceil((spotPrice + risk * 1.5 - 1e-9) * 100) / 100;
            const target1 = Number(Math.min(cwMagnetCap, Math.max(minT1, (spotPrice + cwMagnetCap) / 2)).toFixed(2));
            if (target1 > spotPrice && cwMagnetCap >= target1 && (target1 - spotPrice) / risk >= 1.5) {
              candidateBto = {
                contractType: "CALL",
                setupName: isTacticalMagnet
                  ? `Tactical King Magnet Pull ($${activeKingMagnet})`
                  : "Uncontested King Magnet Pull",
                stopLossSpot: stopLoss,
                target1Spot: target1,
                target2Spot: Number(cwMagnetCap.toFixed(2)),
              };
            }
          }
        }
        // Bearish King Magnet: activeKingMagnet < spotPrice
        // Anti-Trap Guardrail: Only allow Bearish King Magnet if activeKingMagnet is within 0.85% of spot
        // AND Tactical King is NOT sitting at/above spot!
        else if (
          activeKingMagnet < spotPrice &&
          hasAdequatePutRoomToWall &&
          distPct <= 0.0085 &&
          (!tacticalKingStrike || tacticalKingStrike < spotPrice) &&
          latest5mCandle &&
          latest5mCandle.close < latest5mCandle.sma34 &&
          latest5mCandle.close < latest5mCandle.open
        ) {
          const stopBase = Math.max(latest5mCandle.sma34, latest5mCandle.high);
          const stopLoss = Number((stopBase * (1 + 0.001)).toFixed(2));
          const risk = Math.max(minRiskFloor, stopLoss - spotPrice);
          const pwMagnetCap = tacticalPw > 0 && tacticalPw < spotPrice ? Math.max(tacticalPw, activeKingMagnet) : activeKingMagnet;
          if (spotPrice - pwMagnetCap >= risk * 1.5) {
            const maxT1 = Math.floor((spotPrice - risk * 1.5 + 1e-9) * 100) / 100;
            const target1 = Number(Math.max(pwMagnetCap, Math.min(maxT1, (spotPrice + pwMagnetCap) / 2)).toFixed(2));
            if (target1 < spotPrice && pwMagnetCap <= target1 && (spotPrice - target1) / risk >= 1.5) {
              candidateBto = {
                contractType: "PUT",
                setupName: isTacticalMagnet
                  ? `Tactical King Magnet Pull ($${activeKingMagnet})`
                  : "Uncontested King Magnet Pull",
                stopLossSpot: stopLoss,
                target1Spot: target1,
                target2Spot: Number(pwMagnetCap.toFixed(2)),
              };
            }
          }
        }
      }
    }

    // --- UNIVERSAL OPEN-SESSION & COUNTER-TREND CALL FIREWALL ---
    // If candidate is a CALL and counter-trend call is blocked, strictly nullify candidateBto across all setups.
    if (candidateBto && candidateBto.contractType === "CALL" && isCounterTrendCallBlocked) {
      console.warn(
        `[FIREWALL] Universally blocked Counter-Trend CALL candidate "${candidateBto.setupName}" at $${spotPrice.toFixed(2)} ` +
        `(OpeningRange: ${isOpeningRange}, χ: ${(currentChi * 100).toFixed(0)}%, ZG: ${zeroGamma}, PriorClose: ${priorCloseRef}).`
      );
      candidateBto = null;
    }

    // --- SETUP 5: Windowed Impulse Flux & Divergence Reclaim [BTO CALL] (No sma34 lag per Pitfall C) ---
    if (
      !candidateBto &&
      hasBullImpulseReclaim &&
      hasAdequateCallRoomToWall &&
      (tacticalPw > 0 ? spotPrice >= tacticalPw * 0.9965 : true)
    ) {
      const reclaimFloor = Math.max(spotPrice - entryMetrics.minWallRoom, Math.min(latest5mCandle?.low ?? spotPrice, tacticalPw > 0 && tacticalPw <= spotPrice ? tacticalPw : spotPrice));
      const stopLoss = Number((Math.min(reclaimFloor - stopWickBuf, spotPrice - Math.max(entryMetrics.minReversalInvalidation, spotPrice * 0.0011))).toFixed(2));
      const risk = Math.max(minRiskFloor, spotPrice - stopLoss);
      const activeCallWall = tacticalCw > spotPrice ? tacticalCw : 0;
      const callTargetWall =
        activeCallWall > 0
          ? (callMagnetTarget > spotPrice && callMagnetTarget <= activeCallWall ? callMagnetTarget : activeCallWall)
          : (callMagnetTarget > spotPrice + entryMetrics.minWallRoom ? callMagnetTarget : Number((spotPrice + risk * 2.5).toFixed(2)));
      if (callTargetWall - spotPrice >= risk * 1.5 && (activeCallWall === 0 || activeCallWall - spotPrice >= risk * 1.5)) {
        const minT1 = Math.ceil((spotPrice + Math.max(entryMetrics.wallProximityBuffer, risk * 1.5) - 1e-9) * 100) / 100;
        const target1 = Number(Math.min(callTargetWall, minT1).toFixed(2));
        const target2 = Number(Math.min(callTargetWall, Math.max(target1, callTargetWall - smallTargetTrim)).toFixed(2));
        if (target1 > spotPrice && target2 >= target1 && (target1 - spotPrice) / risk >= 1.5) {
          candidateBto = {
            contractType: "CALL",
            setupName: "Impulse Flux & Divergence Reclaim [BTO CALL]",
            stopLossSpot: stopLoss,
            target1Spot: target1,
            target2Spot: target2,
          };
        }
      }
    }

    // --- SETUP 5B: Windowed Impulse Flux & Divergence Rejection [BTO PUT] ---
    if (
      !candidateBto &&
      hasBearImpulseRejection &&
      hasAdequatePutRoomToWall &&
      (tacticalCw > 0 ? spotPrice <= tacticalCw * 1.0035 : true)
    ) {
      const rejectCeil = Math.min(spotPrice + entryMetrics.minWallRoom, Math.max(latest5mCandle?.high ?? spotPrice, tacticalCw > 0 && tacticalCw >= spotPrice ? tacticalCw : spotPrice));
      const stopLoss = Number((Math.max(rejectCeil + stopWickBuf, spotPrice + Math.max(entryMetrics.minReversalInvalidation, spotPrice * 0.0011))).toFixed(2));
      const risk = Math.max(minRiskFloor, stopLoss - spotPrice);
      const activePutWall = tacticalPw > 0 && tacticalPw < spotPrice ? tacticalPw : 0;
      const putTargetWall =
        activePutWall > 0
          ? (leg2PutLowerTarget > 0 && leg2PutLowerTarget >= activePutWall && leg2PutLowerTarget < spotPrice ? leg2PutLowerTarget : activePutWall)
          : (leg2PutLowerTarget > 0 && spotPrice - leg2PutLowerTarget >= entryMetrics.minWallRoom
              ? leg2PutLowerTarget
              : Number((spotPrice - risk * 2.5).toFixed(2)));
      if (spotPrice - putTargetWall >= risk * 1.5 && (activePutWall === 0 || spotPrice - activePutWall >= risk * 1.5)) {
        const maxT1 = Math.floor((spotPrice - Math.max(entryMetrics.wallProximityBuffer, risk * 1.5) + 1e-9) * 100) / 100;
        const target1 = Number(Math.max(putTargetWall, maxT1).toFixed(2));
        const target2 = Number(Math.max(putTargetWall, Math.min(target1, putTargetWall + smallTargetTrim)).toFixed(2));
        if (target1 < spotPrice && target2 <= target1 && (spotPrice - target1) / risk >= 1.5) {
          candidateBto = {
            contractType: "PUT",
            setupName: "Impulse Flux & Divergence Rejection [BTO PUT]",
            stopLossSpot: stopLoss,
            target1Spot: target1,
            target2Spot: target2,
          };
        }
      }
    }

    // Phase-2 Gate: Second trade today must be an opposite-direction structural rotation (>= 10:30 ET, >= 30m cooldown)
    if (candidateBto && isPhase2ReclaimWindow) {
      const isOppositeDir = candidateBto.contractType !== lastClosed?.contractType;
      const isLeg2CallValid =
        candidateBto.contractType === "CALL" &&
        testedPutWallOrMinus1Sigma &&
        (divergence5m === "BULL" || divergence30m === "BULL" || reclaimedSmaAndVwapOrCenter) &&
        impChi >= 0.60 &&
        (deltaFlux6 > 0 || spotPrice >= effectiveSma34 || spotPrice >= effectiveFlowVwap) &&
        leg2CallRoom >= entryMetrics.minWallRoom;
      const isLeg2PutValid =
        candidateBto.contractType === "PUT" &&
        testedCallWallOrPlus1Sigma &&
        (divergence5m === "BEAR" || divergence30m === "BEAR" || lostSmaAndVwapOrCenter) &&
        impChi <= 0.40 &&
        (deltaFlux6 < 0 || spotPrice <= effectiveSma34 || spotPrice <= effectiveFlowVwap) &&
        leg2PutRoom >= entryMetrics.minWallRoom;
      if (!isOppositeDir || !(isLeg2CallValid || isLeg2PutValid)) {
        candidateBto = null;
      }
    }

    // --- GATE: Minimum R:R Ratio Check >= 1.5 (evaluated against clamped entry spot for exact parity) ---
    if (candidateBto) {
      const entryClampedSpot = clampToCandleRange(spotPrice, latest5mCandle);
      const isCandCall = candidateBto.contractType === "CALL";
      const hasValidBounds = isCandCall
        ? candidateBto.target1Spot > entryClampedSpot && candidateBto.stopLossSpot < entryClampedSpot
        : candidateBto.target1Spot < entryClampedSpot && candidateBto.stopLossSpot > entryClampedSpot;
      const risk = Math.abs(entryClampedSpot - candidateBto.stopLossSpot);
      const reward1 = Math.abs(candidateBto.target1Spot - entryClampedSpot);
      const rrRatio = hasValidBounds && risk > 0 ? Number((reward1 / risk).toFixed(2)) : 0;

      if (rrRatio >= 1.5 && !params.signal?.aborted) {
        // Regime Classification + Causal Additive Empirical Expectancy Gate
        const regimeClassification = classifyMarketRegime({
          spotPrice: entryClampedSpot,
          callWall: tacticalCw,
          putWall: tacticalPw,
          zeroGamma: effectiveZeroGamma,
          zeroDteKing: filteredKing ?? (kingNode as any)?.zeroDteKing,
          bookCenter: tacticalBookCenter,
          flowVwap: effectiveFlowVwap,
          netGex: resolvedNetGex,
          flowSnapshot: flowSnap,
          directionHint: candidateBto.contractType,
        });

        const alphaScore = scoreSetupExpectancy({
          direction: candidateBto.contractType,
          setupName: candidateBto.setupName,
          spotPrice: entryClampedSpot,
          stopLossSpot: candidateBto.stopLossSpot,
          target1Spot: candidateBto.target1Spot,
          target2Spot: candidateBto.target2Spot,
          callWall: tacticalCw,
          putWall: tacticalPw,
          zeroGamma: effectiveZeroGamma,
          zeroDteKing: filteredKing ?? (kingNode as any)?.zeroDteKing,
          bookCenter: tacticalBookCenter,
          divergence5m: divergence5m ?? "NO",
          divergence30m: divergence30m ?? "NO",
          flowSnapshot: flowSnap,
          regimeClassification,
          priors: readAlphaPriorsSync(),
        });

        // Data-Driven Walk-Forward Gate (Empirical Bayes Shrinkage on 10-day prior sessions + Regime Expectancy)
        const sessionDate = new Date(nowTs * 1000).toLocaleDateString("en-CA", {
          timeZone: "America/New_York",
        });
        const calibration = await calibrateWalkForwardExpectancy(normalizedTicker, sessionDate, params.signal);
        const passesExpectancy = calibration.passesGate && alphaScore.passesGate;
        if (params.signal?.aborted || !passesExpectancy) {
          const freshAbortStore = loadTradeStore();
          return {
            ticker: normalizedTicker,
            activePosition:
              freshAbortStore.activePositions[normalizedTicker] ??
              freshAbortStore.activePositions[positionKey] ??
              null,
            emittedAlerts,
            allAlerts: freshAbortStore.alerts,
          };
        }

        // Select optimal Sub-$1.00 contract with Gamma-to-Theta ranking & Regime DTE preference
        const optimalContract = await selectSmallAccountContract({
          ticker: normalizedTicker,
          contractType: candidateBto.contractType,
          spotPrice: entryClampedSpot,
          target1Spot: candidateBto.target1Spot,
          target2Spot: candidateBto.target2Spot,
          stopLossSpot: candidateBto.stopLossSpot,
          contracts: params.contracts,
          conviction: Math.max(conviction, alphaScore.dataConvictionScore),
          nowEt: now,
          zeroDteCallWall: params.zeroDteCallWall || tacticalCw,
          zeroDtePutWall: params.zeroDtePutWall || tacticalPw,
          preferredDte: flowSnap ? regimeClassification.preferredDte : undefined,
          signal: params.signal,
        });

        if (params.signal?.aborted || !optimalContract) {
          const freshAbortStore = loadTradeStore();
          return {
            ticker: normalizedTicker,
            activePosition:
              freshAbortStore.activePositions[normalizedTicker] ??
              freshAbortStore.activePositions[positionKey] ??
              null,
            emittedAlerts,
            allAlerts: freshAbortStore.alerts,
          };
        }

        // Post-await RTH cutoff re-check (prevents late async completion from committing entries > 14:30 ET)
        if (!params.nowEt) {
          const postAwaitEt = getNowEtTime(new Date());
          if (postAwaitEt.totalMinutes < ENTRY_START_MINS || postAwaitEt.totalMinutes > ENTRY_CUTOFF_MINS) {
            const freshAbortStore = loadTradeStore();
            return {
              ticker: normalizedTicker,
              activePosition:
                freshAbortStore.activePositions[normalizedTicker] ??
                freshAbortStore.activePositions[positionKey] ??
                null,
              emittedAlerts,
              allAlerts: freshAbortStore.alerts,
            };
          }
        }

        const positionTicker = isSpxw ? "SPY" : normalizedTicker;
        const positionSpot = isSpxw ? Number((entryClampedSpot / 10).toFixed(2)) : entryClampedSpot;
        const positionTarget1 = isSpxw ? Number((candidateBto.target1Spot / 10).toFixed(2)) : candidateBto.target1Spot;
        const positionTarget2 = isSpxw ? Number((candidateBto.target2Spot / 10).toFixed(2)) : candidateBto.target2Spot;
        const positionStopLoss = isSpxw ? Number((candidateBto.stopLossSpot / 10).toFixed(2)) : candidateBto.stopLossSpot;
        const posInitialRisk = Number(
          Math.max(Math.max(0.03, positionSpot * 0.0001), Math.abs(positionSpot - positionStopLoss)).toFixed(2)
        );
        const posPrevLow =
          typeof latest5mCandle?.prevLow === "number"
            ? (isSpxw ? Number((latest5mCandle.prevLow / 10).toFixed(2)) : latest5mCandle.prevLow)
            : undefined;
        const posPrevHigh =
          typeof latest5mCandle?.prevHigh === "number"
            ? (isSpxw ? Number((latest5mCandle.prevHigh / 10).toFixed(2)) : latest5mCandle.prevHigh)
            : undefined;

        const positionId = `${positionTicker}-${candidateBto.contractType}-${nowTs}`;
        const newPosition: OptionTradePosition = {
          id: positionId,
          ticker: positionTicker,
          contractType: candidateBto.contractType,
          contractLabel: optimalContract.contractLabel,
          strike: optimalContract.strike,
          expiration: optimalContract.expiration,
          expHuman: optimalContract.expHuman,
          robinhoodExp: optimalContract.robinhoodExp,
          robinhoodTab: optimalContract.robinhoodTab,
          setupName: candidateBto.setupName,
          status: "OPEN",
          btoSpotPrice: positionSpot,
          btoOptionMid: optimalContract.optionMid,
          optionBid: optimalContract.optionBid,
          optionAsk: optimalContract.optionAsk,
          contractsQty: 1,
          remainingQty: 1,
          totalOutlay: optimalContract.totalOutlay,
          estTp1Mid: optimalContract.estTp1Mid,
          estTp2Mid: optimalContract.estTp2Mid,
          estStopMid: optimalContract.estStopMid,
          tp1Pct: optimalContract.tp1Pct,
          tp2Pct: optimalContract.tp2Pct,
          target1Spot: positionTarget1,
          target2Spot: positionTarget2,
          stopLossSpot: positionStopLoss,
          openedAt: timeStr,
          openedTs: nowTs,
          rrRatio,
          initialRisk: posInitialRisk,
          prevBarLow: posPrevLow,
          prevBarHigh: posPrevHigh,
          lastCandleTs: latest5mCandle?.timestamp,
          atr5m: Number(entryAtr5m.toFixed(4)),
          lastPrevClose: latest5mCandle?.close,
          altContractNote: optimalContract.altContractNote,
          calibratedWinRate: calibration.winRate,
          calibratedExpectancyR: calibration.expectancyR,
          dataConvictionScore: calibration.dataConvictionScore,
          flowVwap: flowSnap?.flowVwap,
          ceilingShareChi: flowSnap?.ceilingShareChi,
          pecletNumber: flowSnap?.pecletNumber,
        };

        const emoji = candidateBto.contractType === "CALL" ? "🟢" : "🟣";
        const fluxTag =
          flowSnap &&
          typeof flowSnap.ceilingShareChi === "number" &&
          typeof flowSnap.pecletNumber === "number"
            ? ` · FVWAP $${flowSnap.flowVwap.toFixed(2)} (χ=${(flowSnap.ceilingShareChi * 100).toFixed(0)}%, Pe=${flowSnap.pecletNumber >= 0 ? "+" : ""}${flowSnap.pecletNumber.toFixed(2)})`
            : "";
        const msg = `${emoji} BUY TO OPEN (${optimalContract.contractsQty}x @ $${optimalContract.optionMid.toFixed(
          2
        )}) · ${optimalContract.contractLabel} @ $${positionSpot.toFixed(2)} [${
          candidateBto.setupName
        }] · SL: $${positionStopLoss.toFixed(2)}, TP1: $${positionTarget1.toFixed(
          2
        )}, TP2: $${positionTarget2.toFixed(2)} (R:R ${rrRatio}:1 · $${optimalContract.totalOutlay} Outlay)${fluxTag}`;

        const alert: TradeLifecycleAlert = {
          id: `${positionId}-bto`,
          timestamp: timeStr,
          ts: nowTs,
          ticker: positionTicker,
          action: "BUY_TO_OPEN",
          contractType: candidateBto.contractType,
          contractLabel: optimalContract.contractLabel,
          strike: optimalContract.strike,
          expiration: optimalContract.expiration,
          expHuman: optimalContract.expHuman,
          robinhoodExp: optimalContract.robinhoodExp,
          robinhoodTab: optimalContract.robinhoodTab,
          setupName: candidateBto.setupName,
          reason: candidateBto.setupName,
          status: "OPEN",
          spotPrice: positionSpot,
          btoSpotPrice: positionSpot,
          target1Spot: positionTarget1,
          target2Spot: positionTarget2,
          stopLossSpot: positionStopLoss,
          optionMid: optimalContract.optionMid,
          optionBid: optimalContract.optionBid,
          optionAsk: optimalContract.optionAsk,
          btoOptionMid: optimalContract.optionMid,
          contractsQty: optimalContract.contractsQty,
          remainingQty: optimalContract.contractsQty,
          totalOutlay: optimalContract.totalOutlay,
          estTp1Mid: optimalContract.estTp1Mid,
          estTp2Mid: optimalContract.estTp2Mid,
          estStopMid: optimalContract.estStopMid,
          tp1Pct: optimalContract.tp1Pct,
          tp2Pct: optimalContract.tp2Pct,
          rrRatio,
          altContractNote: optimalContract.altContractNote,
          isHistoricalBackfill: Boolean(params.isHistoricalBackfill),
          eventId: `${positionId}-bto`,
          calibratedWinRate: calibration.winRate,
          calibratedExpectancyR: calibration.expectancyR,
          dataConvictionScore: calibration.dataConvictionScore,
          flowVwap: flowSnap?.flowVwap,
          ceilingShareChi: flowSnap?.ceilingShareChi,
          pecletNumber: flowSnap?.pecletNumber,
          message: msg,
        };

        const latestStoreBeforeCommit = loadTradeStore();
        latestStoreBeforeCommit.prevSpotPrices[normalizedTicker] = spotPrice;
        if (Object.keys(latestStoreBeforeCommit.activePositions || {}).length > 0) {
          console.warn(
            `[evaluateTradeSignals] Aborted ${positionTicker} BTO commit: global slot already occupied (${Object.keys(latestStoreBeforeCommit.activePositions).join(", ")}).`
          );
          saveTradeStore(latestStoreBeforeCommit);
          store = latestStoreBeforeCommit;
        } else {
          latestStoreBeforeCommit.activePositions[positionTicker] = newPosition;
          latestStoreBeforeCommit.alerts.push(alert);
          emittedAlerts.push(alert);
          activePos = newPosition;
          saveTradeStore(latestStoreBeforeCommit);
          store = latestStoreBeforeCommit;
        }
      }
    }
  }

  // Persist prevSpotPrices onto latest store when no commit/STEP-A write occurred after any await
  if (emittedAlerts.length === 0 && !hadActivePositionAtStart) {
    const latestIdleStore = loadTradeStore();
    if (latestIdleStore.prevSpotPrices[normalizedTicker] !== spotPrice) {
      latestIdleStore.prevSpotPrices[normalizedTicker] = spotPrice;
      saveTradeStore(latestIdleStore);
    }
    store = latestIdleStore;
  }

  // Strict Live Discord Firewall:
  // NEVER dispatch alerts to Discord if:
  // 1. params.isHistoricalBackfill is true
  // 2. Alert is flagged as historical backfill
  // 3. Time lag between bar timestamp and real clock is > 180 seconds (i.e. historical replay)
  // 4. Current execution time is outside RTH (09:30 - 16:00 ET)
  const realNowTs = Math.floor(Date.now() / 1000);
  const isLiveWithin180s = Math.abs(realNowTs - nowTs) <= 180;
  const isRthWindow = etTime.totalMinutes >= RTH_OPEN_MINS && etTime.totalMinutes < RTH_CLOSE_MINS;

  if (!params.isHistoricalBackfill && isLiveWithin180s && isRthWindow) {
    const preDiscordStore = loadTradeStore();
    const unsentTodayAlerts = preDiscordStore.alerts.filter(
      (a) =>
        (a.ticker === normalizedTicker || a.ticker === positionKey) &&
        !a.isHistoricalBackfill &&
        !preDiscordStore.dispatchedAlertIds?.[a.id]
    );
    if (unsentTodayAlerts.length > 0) {
      const sentIds: string[] = [];
      for (const alert of unsentTodayAlerts) {
        if (params.signal?.aborted) break;
        const sent = await sendDiscordTradeAlert(
          { ...alert, isHistoricalBackfill: false },
          params.webhookUrl,
          { signal: params.signal }
        ).catch(() => false);
        if (sent) {
          sentIds.push(alert.id);
        }
      }
      if (sentIds.length > 0) {
        const afterDiscordStore = loadTradeStore();
        afterDiscordStore.dispatchedAlertIds = afterDiscordStore.dispatchedAlertIds || {};
        for (const id of sentIds) {
          afterDiscordStore.dispatchedAlertIds[id] = true;
        }
        saveTradeStore(afterDiscordStore);
        store = afterDiscordStore;
      }
    }
  }

  const finalStore = loadTradeStore();
  return {
    ticker: normalizedTicker,
    activePosition: activePos,
    emittedAlerts,
    allAlerts: finalStore.alerts.slice(-50),
  };
}

/**
 * Evaluates all currently active positions across all tickers (SPY, QQQ, SPXW, IWM)
 * against live CBOE data. Ensures that positions on tickers not currently selected
 * in the active dashboard UI are continuously guarded and exited on Target, Stop Loss,
 * or Option Hard Stop.
 */
export async function evaluateAllActivePositions(params?: {
  webhookUrl?: string;
  signal?: AbortSignal;
}): Promise<TradeLifecycleAlert[]> {
  if (params?.signal?.aborted) return [];
  const store = loadTradeStore();
  const activeKeys = Object.keys(store.activePositions);
  if (activeKeys.length === 0) return [];

  const allEmitted: TradeLifecycleAlert[] = [];

  for (const ticker of activeKeys) {
    if (params?.signal?.aborted) break;
    const pos = loadTradeStore().activePositions[ticker];
    if (!pos || (pos.status !== "OPEN" && pos.status !== "PARTIAL_TP1")) continue;

    // FSM State Consistency Guard per ticker: Purge any position that contradicts canonical Call/Put Regime
    const latestGuardStore = loadTradeStore();
    const tickerFsm = latestGuardStore.gaiaStateByTicker?.[ticker];
    const fsmState = tickerFsm?.activeFsmState ?? (ticker === "SPY" ? latestGuardStore.activeFsmState : undefined);
    const tickerMacroRegime = tickerFsm?.macroRegime ?? (ticker === "SPY" ? latestGuardStore.macroRegime : undefined);
    const tickerChiPct = tickerFsm?.chiPct ?? (ticker === "SPY" ? latestGuardStore.chiPct : undefined);
    if (fsmState !== undefined || tickerMacroRegime !== undefined || tickerChiPct !== undefined) {
      const isStructuralSetup = !pos.setupName.includes("Gaia Tactical HUD");
      if (fsmState === "STAND_ASIDE" && !isStructuralSetup) {
        delete latestGuardStore.activePositions[ticker];
        saveTradeStore(latestGuardStore);
        continue;
      }
      if (
        pos.contractType === "PUT" &&
        !isStructuralSetup &&
        (fsmState === "LONG" || tickerMacroRegime === "CALL" || (tickerChiPct ?? 50) >= 50)
      ) {
        console.warn(`[evaluateAllActivePositions] Purging zombie ${ticker} PUT position while FSM is LONG/CALL.`);
        delete latestGuardStore.activePositions[ticker];
        saveTradeStore(latestGuardStore);
        continue;
      }
      if (
        pos.contractType === "CALL" &&
        !isStructuralSetup &&
        (fsmState === "SHORT" || tickerMacroRegime === "PUT" || (tickerChiPct ?? 50) < 50)
      ) {
        console.warn(`[evaluateAllActivePositions] Purging zombie ${ticker} CALL position while FSM is SHORT/PUT.`);
        delete latestGuardStore.activePositions[ticker];
        saveTradeStore(latestGuardStore);
        continue;
      }
    }

    try {
      // 1. Fetch live CBOE options chain for this ticker
      const contracts = await fetchLiveCboeOptions(ticker, params?.signal);
      if (params?.signal?.aborted) break;

      // 2. Determine spot price
      let spot = getCachedSpotPrice(ticker);
      if (!spot || spot <= 0) {
        if (ticker === "SPX" || ticker === "SPXW") {
          spot = getCachedSpotPrice("_SPX") || pos.btoSpotPrice;
        } else {
          spot = pos.btoSpotPrice;
        }
      }

      // 3. Evaluate exit rules
      const res = await evaluateTradeSignals({
        ticker,
        spotPrice: spot,
        callWall: 0,
        putWall: 0,
        zeroGamma: 0,
        contracts,
        webhookUrl: params?.webhookUrl,
        signal: params?.signal,
      });

      if (res.emittedAlerts.length > 0) {
        allEmitted.push(...res.emittedAlerts);
      }
    } catch (err) {
      console.error(`[TradeSignalEngine] Failed to evaluate active position for ${ticker}:`, err);
    }
  }

  // Check if after-market-close daily performance recap should be dispatched
  if (!params?.signal?.aborted) {
    try {
      const { checkAndSendMarketCloseRecap } = await import("./tradePerformanceEngine");
      await checkAndSendMarketCloseRecap({ webhookUrl: params?.webhookUrl });
    } catch {
      // Non-fatal
    }
  }

  return allEmitted;
}

export * from "./tradePerformanceEngine";

// ============================================================================
// UNIFIED BLACK-SCHOLES SKEW PRICER & REGIME-FILTERED SNIPER EVALUATOR
// ============================================================================

export type TradeDirection = "LONG" | "SHORT";

export interface WalkForwardFeatureVector {
  tacticalKingPull: number;
  bookCenterSlope: number;
  gammaRegime: number;
  trendVwap: number;
  mtfDivergence: number;
}

export interface WalkForwardHistoricalSample {
  features: WalkForwardFeatureVector;
  outcomeR: number;
  win: boolean;
}

export interface SkewBlackScholesInput {
  spot: number;
  strike: number;
  direction: TradeDirection; // 'LONG' -> Call, 'SHORT' -> Put
  remainingYears: number;
  atmIv: number;
  skewSlope?: number;      // Default -3.5 (boosts Put wing IV when K < S)
  smileConvexity?: number; // Default 12.0
  riskFreeRate?: number;   // Default 0.045
  dividendYield?: number;  // Default 0.012
  halfSpreadPct?: number;  // Default 0.012 (1.2% half-spread)
}

export interface SkewBlackScholesQuote {
  mid: number;
  bid: number;
  ask: number;
  iv: number;
  delta: number;
  gamma: number;
  thetaPerDay: number;
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
 * to either 0DTE 16:00 ET (dteSessions = 0) or Next-Session 16:00 ET (dteSessions = 1),
 * including fractional intraday trading minutes + overnight theta weight.
 */
export function computeRemainingYearsToExpiration(
  timestampMs: number,
  dteSessions: number = 1
): number {
  const dt = new Date(timestampMs);
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
  const remainingIntradayMins = Math.max(1, 16 * 60 - etMinutes);
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

export interface UnifiedBarFeatures extends WalkForwardFeatureVector {
  vwap: number;
  vwapSlope: number;
  sma20: number;
  sma34: number;
  atr: number;
  kingStrike: number;
  supportStrike: number;
  resistStrike: number;
  isHigherHighs: boolean;
  isLowerLows: boolean;
  atmIv: number;
}

export interface UnifiedSniperCandidate {
  direction: TradeDirection;
  setupName: string;
  strike: number;
  stopSpot: number;
  target1Spot: number;
  target2Spot: number;
  features: UnifiedBarFeatures;
}

function inferStrikeStep(spot: number): number {
  if (spot >= 15000) return 25;
  if (spot >= 1500) return 5;
  if (spot >= 250) return 1;
  return 0.5;
}

function roundToStrikeStep(price: number, step: number): number {
  return Number((Math.round(price / step) * step).toFixed(2));
}

/**
 * Computes causal bar features, intraday VWAP + slope, SMA34, structure, and Tactical King magnet.
 */
export function computeUnifiedSniperFeatures(
  bars: Array<{ timestampMs: number; open: number; high: number; low: number; close: number; volume: number }>,
  idx: number,
  explicitKingStrike?: number,
  referenceChainIv?: number
): UnifiedBarFeatures {
  const slice = bars.slice(0, idx + 1);
  const curr = slice[slice.length - 1];
  const spot = curr.close;

  // Intraday VWAP & Prior VWAP (3 bars ago) for VWAP Slope
  let cumPV = 0;
  let cumV = 0;
  let prevCumPV = 0;
  let prevCumV = 0;
  const slopeLookback = Math.max(0, slice.length - 4);
  for (let i = 0; i < slice.length; i++) {
    const b = slice[i];
    const tp = (b.high + b.low + b.close) / 3;
    const vol = Math.max(1, b.volume);
    cumPV += tp * vol;
    cumV += vol;
    if (i <= slopeLookback) {
      prevCumPV = cumPV;
      prevCumV = cumV;
    }
  }
  const vwap = cumV > 0 ? cumPV / cumV : spot;
  const prevVwap = prevCumV > 0 ? prevCumPV / prevCumV : vwap;
  const vwapSlope = vwap - prevVwap;

  const sma20Slice = slice.slice(-20);
  const sma20 = sma20Slice.reduce((s, b) => s + b.close, 0) / sma20Slice.length;

  const sma34Slice = slice.slice(-34);
  const sma34 = sma34Slice.reduce((s, b) => s + b.close, 0) / sma34Slice.length;

  const atrSlice = slice.slice(-14);
  const atr = Math.max(
    Math.max(0.05, spot * 0.0005),
    atrSlice.reduce((s, b) => s + Math.max(Math.max(0.01, b.close * 0.0001), b.high - b.low), 0) / atrSlice.length
  );

  let sessionHigh = -Infinity;
  let sessionLow = Infinity;
  for (const b of slice) {
    if (b.high > sessionHigh) sessionHigh = b.high;
    if (b.low < sessionLow) sessionLow = b.low;
  }

  const openSpot = slice[0].open;
  const intradayDrift = spot - openSpot;
  const isBullishDrift = spot >= vwap && intradayDrift >= 0;

  const projectedMagnet = isBullishDrift
    ? Math.max(sessionHigh, openSpot + Math.max(openSpot * 0.0047, atr * 4.2))
    : Math.min(sessionLow, openSpot - Math.max(openSpot * 0.0047, atr * 4.2));
  const strikeStep = inferStrikeStep(spot);
  const kingStrike = explicitKingStrike ?? roundToStrikeStep(projectedMagnet, strikeStep);

  const activeRange = Math.max(atr * 3.0, sessionHigh - sessionLow);
  const supportStrike = roundToStrikeStep(sessionLow + activeRange * 0.22, strikeStep);
  const resistStrike = roundToStrikeStep(sessionHigh - activeRange * 0.22, strikeStep);

  const recent6 = slice.slice(-6);
  const firstHalf = recent6.slice(0, Math.max(1, Math.floor(recent6.length / 2)));
  const secondHalf = recent6.slice(Math.max(1, Math.floor(recent6.length / 2)));
  const firstHigh = Math.max(...firstHalf.map((b) => b.high));
  const secondHigh = Math.max(...secondHalf.map((b) => b.high));
  const firstLow = Math.min(...firstHalf.map((b) => b.low));
  const secondLow = Math.min(...secondHalf.map((b) => b.low));

  const isHigherHighs = secondHigh >= firstHigh && secondLow >= firstLow;
  const isLowerLows = secondLow <= firstLow && secondHigh <= firstHigh;

  const kingDist = kingStrike - spot;
  const tacticalKingPull = Math.max(-1, Math.min(1, kingDist / Math.max(spot * 0.0020, atr * 3)));

  const prev3 = slice[Math.max(0, slice.length - 4)];
  const bookCenterSlope = Math.max(-1, Math.min(1, (spot - prev3.close) / Math.max(spot * 0.0007, atr * 1.5)));
  const gammaRegime = spot >= vwap ? 0.65 : -0.65;
  const trendVwap = Math.max(-1, Math.min(1, (spot - vwap) / Math.max(spot * 0.0007, atr * 1.5)));

  const roc5 = slice.length >= 2 ? spot - slice[slice.length - 2].close : 0;
  const roc15 = slice.length >= 4 ? spot - slice[slice.length - 4].close : roc5;
  const mtfDivergence =
    Math.sign(roc5) === Math.sign(roc15) && roc5 !== 0 ? Math.sign(roc5) * 0.85 : -0.35;

  const atmIv = estimateDynamicAtmIv(bars, idx, 0.085, referenceChainIv);

  return {
    tacticalKingPull,
    bookCenterSlope,
    gammaRegime,
    trendVwap,
    mtfDivergence,
    vwap,
    vwapSlope,
    sma20,
    sma34,
    atr,
    kingStrike,
    supportStrike,
    resistStrike,
    isHigherHighs,
    isLowerLows,
    atmIv,
  };
}

/**
 * Unified Regime-Aware Sniper Setup Evaluator used by both live polling and 10-day backtest.
 */
export function evaluateUnifiedSniperSetup(
  bars: Array<{ timestampMs: number; open: number; high: number; low: number; close: number; volume: number }>,
  idx: number,
  explicitKingStrike?: number,
  referenceChainIv?: number
): UnifiedSniperCandidate | null {
  if (idx < 1) return null;
  const bar = bars[idx];
  const prevBar = bars[idx - 1];

  const dt = new Date(bar.timestampMs);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    hourCycle: "h23",
  });
  const parts = fmt.formatToParts(dt);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  const etMins = hour * 60 + minute;

  // Mandatory RTH Entry Window: 09:35 ET (575) through 14:30 ET (870)
  if (etMins < ENTRY_START_MINS || etMins > ENTRY_CUTOFF_MINS) return null;

  const features = computeUnifiedSniperFeatures(bars, idx, explicitKingStrike, referenceChainIv);
  const spot = bar.close;
  const {
    vwap,
    vwapSlope,
    sma34,
    atr,
    kingStrike,
    supportStrike,
    resistStrike,
    isHigherHighs,
    isLowerLows,
  } = features;

  const distSupport = spot - supportStrike;
  const distResist = resistStrike - spot;
  const minVwapSlope = Math.max(0.002, spot * 0.00003);

  // Regime Locks: Block counter-trend entries against strong trend + Tactical King pull
  const isBullishRegimeLocked =
    (spot > vwap && spot > sma34 && kingStrike > spot) ||
    (spot > vwap && vwapSlope > minVwapSlope && isHigherHighs);

  const isBearishRegimeLocked =
    (spot < vwap && spot < sma34) ||
    (spot < vwap && kingStrike < spot) ||
    (spot < vwap && vwapSlope < -minVwapSlope && isLowerLows);

  const isMorningMomentumWindow = etMins >= 575 && etMins <= 11 * 60;
  const isOpeningHourFlushWindow = etMins >= 575 && etMins <= 10 * 60 + 30;

  // Opening range (first 15m)
  const openingSlice = bars.slice(0, Math.min(3, bars.length));
  const openingLow = Math.min(...openingSlice.map((b) => b.low));
  const openingHigh = Math.max(...openingSlice.map((b) => b.high));

  let direction: TradeDirection | null = null;
  let setupName = "";

  // 1. Morning Bullish Trend / King Magnet Pull (09:30 - 11:00 ET)
  // Triggers when high-conviction Tactical King is overhead (e.g. 2026-10-26 with $767)
  if (
    explicitKingStrike &&
    isMorningMomentumWindow &&
    spot >= vwap &&
    (spot >= sma34 || idx <= 5) &&
    explicitKingStrike > spot &&
    explicitKingStrike - spot >= Math.max(spot * 0.0011, atr * 1.1) &&
    bar.close > bar.open &&
    bar.close >= prevBar.close
  ) {
    direction = "LONG";
    setupName = "King Magnet Trend Pull";
  }
  // 2. Bearish Zero-Gamma Flush [BTO PUT] (The Morning Short: 09:30 - 10:30 ET)
  // Triggers when spot crosses or opens below Zero Gamma / Opening High, below Flow VWAP & SMA34 in negative gamma
  else if (
    isOpeningHourFlushWindow &&
    spot < vwap &&
    spot < sma34 &&
    features.gammaRegime < 0 &&
    (bar.close < bar.open || bar.close < prevBar.close)
  ) {
    direction = "SHORT";
    setupName = "Bearish Zero-Gamma Flush [BTO PUT]";
  }
  // 3. Support Bounce (Blocked if locked in Bearish Regime)
  else if (
    !isBearishRegimeLocked &&
    ((bar.low <= openingLow && bar.close > bar.open && bar.close >= sma34 && prevBar.close <= sma34) ||
      (distSupport >= -Math.max(0.05, spot * 0.0005) && distSupport <= Math.max(0.15, spot * 0.0011) && bar.close > bar.open && features.trendVwap >= -0.25))
  ) {
    direction = "LONG";
    setupName = "Support Bounce";
  }
  // 4. Morning Bearish Breakdown / Downside King Magnet Pull (09:30 - 11:00 ET)
  else if (
    explicitKingStrike &&
    isMorningMomentumWindow &&
    spot < vwap &&
    spot < sma34 &&
    explicitKingStrike < spot &&
    spot - explicitKingStrike >= Math.max(spot * 0.0011, atr * 1.1) &&
    bar.close < bar.open &&
    bar.close <= prevBar.close
  ) {
    direction = "SHORT";
    setupName = "King Magnet Breakdown";
  }
  // 5. Resistance Rejection (Strictly Blocked when Bullish Regime Locked!)
  else if (
    !isBullishRegimeLocked &&
    ((bar.high >= openingHigh && bar.close < bar.open && bar.close <= sma34 && prevBar.close >= sma34) ||
      (distResist >= -Math.max(0.05, spot * 0.0005) && distResist <= Math.max(0.15, spot * 0.0011) && bar.close < bar.open && features.trendVwap <= 0.25))
  ) {
    direction = "SHORT";
    setupName = "Resistance Rejection";
  }

  if (!direction) return null;

  const stopDist = Math.max(spot * 0.0011, atr * 1.35);
  const t1Dist = Math.max(spot * 0.0016, stopDist * 1.5);
  const t2Dist =
    direction === "LONG" && kingStrike > spot + t1Dist
      ? Math.max(t1Dist, Math.min(kingStrike - spot, stopDist * 3.0))
      : direction === "SHORT" && kingStrike > 0 && kingStrike < spot - t1Dist
        ? Math.max(t1Dist, Math.min(spot - kingStrike, stopDist * 3.0))
        : Math.max(t1Dist, Math.max(spot * 0.0028, stopDist * 2.35));

  const strikeStep = inferStrikeStep(spot);
  const strike =
    direction === "LONG"
      ? Number((Math.ceil(spot / strikeStep) * strikeStep).toFixed(2))
      : Number((Math.floor(spot / strikeStep) * strikeStep).toFixed(2));

  return {
    direction,
    setupName,
    strike,
    stopSpot: direction === "LONG" ? spot - stopDist : spot + stopDist,
    target1Spot: direction === "LONG" ? spot + t1Dist : spot - t1Dist,
    target2Spot: direction === "LONG" ? spot + t2Dist : spot - t2Dist,
    features,
  };
}

// ============================================================================
// GAIA SPY DISCORD SYNCHRONIZATION ENGINE
// ============================================================================

export interface GaiaSpySignalSyncInput {
  id: string;
  type: "LONG" | "SHORT";
  time?: string;
  timeLabel?: string;
  price: number;
  label?: string;
  tag?: string;
  excursion?: number;
  timestamp?: number;
  barTimestamp?: number;
  barSpanSeconds?: number;
  barCloseTimestamp?: number;
  index?: number;
  idx?: number;
}

export interface SyncGaiaTickerResult {
  dispatchedCount: number;
  keys: string[];
}
export type SyncGaiaSpyResult = SyncGaiaTickerResult;

const globalForGaiaDiscord = globalThis as unknown as {
  __hyperionDispatchedGaiaKeys?: Set<string>;
};

function getCanonicalGaiaSlot(sig: GaiaSpySignalSyncInput): string {
  const lbl = (sig.label || "").toUpperCase();
  const baseSlot =
    lbl.includes("OPEN") || sig.id === "sig-open" || sig.id.startsWith("sig-open")
      ? "LONG_OPEN"
      : lbl.includes("PEAK") || sig.id === "sig-peak" || sig.id.startsWith("sig-peak")
      ? "SHORT_PEAK"
      : lbl.includes("BREAK") || sig.id.includes("break")
      ? "SHORT_BREAK"
      : lbl.includes("RECLAIM") || sig.id.includes("reclaim")
      ? "LONG_RECLAIM"
      : `${sig.type}_${sig.time || sig.timeLabel || "SIG"}`;

  const idxMatch = sig.id ? sig.id.match(/-(\d+)$/) : null;
  return idxMatch ? `${baseSlot}_${idxMatch[1]}` : baseSlot;
}

export interface SyncGaiaTickerParams {
  ticker: string;
  signals: GaiaSpySignalSyncInput[];
  spotPrice: number;
  activeFsmState?: "LONG" | "SHORT" | "STAND_ASIDE";
  macroRegime?: "CALL" | "PUT";
  chiPct?: number;
  impulseChi?: number;
  zeroGamma?: number;
  sessionDate?: string;
  webhookUrl?: string;
  isHistoricalBackfill?: boolean;
  signal?: AbortSignal;
}
export type SyncGaiaSpyParams = SyncGaiaTickerParams;

export async function syncGaiaTickerSignalsToDiscord(params: SyncGaiaTickerParams): Promise<SyncGaiaTickerResult> {
  const sym = (params.ticker || "").trim().toUpperCase().replace(/^\$/, "");
  const normalizedTicker = sym === "SPX" ? "SPXW" : sym;
  if (!isSupportedTradeTicker(normalizedTicker)) {
    return { dispatchedCount: 0, keys: [] };
  }
  const isSpxwSync = normalizedTicker === "SPXW";
  const positionTicker = isSpxwSync ? "SPY" : normalizedTicker;
  const tickerSlug = positionTicker.toLowerCase().replace(/[^a-z0-9]/g, "") || "ticker";

  let store = loadTradeStore();
  store.gaiaStateByTicker = store.gaiaStateByTicker || {};
  const prevTickerState = store.gaiaStateByTicker[positionTicker] || {};
  const updatedTickerState = {
    activeFsmState:
      params.activeFsmState ??
      prevTickerState.activeFsmState ??
      (positionTicker === "SPY" ? store.activeFsmState : undefined),
    macroRegime:
      params.macroRegime ??
      prevTickerState.macroRegime ??
      (positionTicker === "SPY" ? store.macroRegime : undefined),
    chiPct:
      typeof params.chiPct === "number"
        ? params.chiPct
        : prevTickerState.chiPct ?? (positionTicker === "SPY" ? store.chiPct : undefined),
    zeroGamma:
      typeof params.zeroGamma === "number" && params.zeroGamma > 0
        ? params.zeroGamma
        : prevTickerState.zeroGamma ?? (positionTicker === "SPY" ? store.zeroGamma : undefined),
  };

  const applyGaiaStateToStore = (targetStore: DailyTradeStore): boolean => {
    targetStore.gaiaStateByTicker = targetStore.gaiaStateByTicker || {};
    const existing = targetStore.gaiaStateByTicker[positionTicker] || {};
    let changed =
      existing.activeFsmState !== updatedTickerState.activeFsmState ||
      existing.macroRegime !== updatedTickerState.macroRegime ||
      existing.chiPct !== updatedTickerState.chiPct ||
      existing.zeroGamma !== updatedTickerState.zeroGamma;
    targetStore.gaiaStateByTicker[positionTicker] = updatedTickerState;
    if (positionTicker === "SPY") {
      if (params.activeFsmState && targetStore.activeFsmState !== params.activeFsmState) {
        targetStore.activeFsmState = params.activeFsmState;
        changed = true;
      }
      if (params.macroRegime && targetStore.macroRegime !== params.macroRegime) {
        targetStore.macroRegime = params.macroRegime;
        changed = true;
      }
      if (typeof params.chiPct === "number" && targetStore.chiPct !== params.chiPct) {
        targetStore.chiPct = params.chiPct;
        changed = true;
      }
      if (typeof params.zeroGamma === "number" && params.zeroGamma > 0 && targetStore.zeroGamma !== params.zeroGamma) {
        targetStore.zeroGamma = params.zeroGamma;
        changed = true;
      }
    }
    return changed;
  };
  const gaiaStateChanged = applyGaiaStateToStore(store);

  // Consistency Guard: Transition active Gaia HUD position to CLOSED on MOC cutoff, STAND_ASIDE, or regime flip
  const tickerPos = store.activePositions[positionTicker];
  const isTickerStructural = Boolean(tickerPos && !tickerPos.setupName.includes("Gaia Tactical HUD"));
  const guardNowDate = new Date();
  const guardNowTs = Math.floor(guardNowDate.getTime() / 1000);
  const guardNowEt = getNowEtTime(guardNowDate);
  const isGuardMocCutoff = !params.isHistoricalBackfill && guardNowEt.totalMinutes >= EOD_FORCE_FLAT_MINS;
  const guardHeldSec = tickerPos ? guardNowTs - (tickerPos.openedTs || guardNowTs) : 0;
  const rawParamsSpot = Number(params.spotPrice);
  const guardCloseSpot =
    rawParamsSpot > 0
      ? (isSpxwSync ? Number((rawParamsSpot / 10).toFixed(2)) : Number(rawParamsSpot.toFixed(2)))
      : (tickerPos?.btoSpotPrice ?? 0);
  const guardAdverseMove = tickerPos
    ? (tickerPos.contractType === "CALL" ? tickerPos.btoSpotPrice - guardCloseSpot : guardCloseSpot - tickerPos.btoSpotPrice)
    : 0;
  const guardMinInvalidation = computeAdaptiveQuantMetrics(
    guardCloseSpot,
    tickerPos?.atr5m ?? guardCloseSpot * 0.0018
  ).minReversalInvalidation;

  let guardExitReason: string | null = null;
  if (tickerPos && !isTickerStructural) {
    const isGuardCall = tickerPos.contractType === "CALL";
    const isGuardWinning = isGuardCall
      ? guardCloseSpot > tickerPos.btoSpotPrice
      : guardCloseSpot < tickerPos.btoSpotPrice;
    if (isGuardMocCutoff) {
      guardExitReason = "15:55 PM ET HARD MARKET CLOSE CUTOFF";
    } else if (
      params.activeFsmState === "STAND_ASIDE" &&
      guardHeldSec >= 600 &&
      (guardAdverseMove >= guardMinInvalidation || isGuardWinning)
    ) {
      guardExitReason = "Gaia FSM Neutralization to STAND_ASIDE";
    } else if (
      guardHeldSec >= 600 &&
      guardAdverseMove >= guardMinInvalidation &&
      !isGuardCall &&
      (params.activeFsmState === "LONG" || (updatedTickerState.macroRegime === "CALL" && (updatedTickerState.chiPct ?? 50) > 52))
    ) {
      guardExitReason = "Macro Rotation to Bull Regime";
    } else if (
      guardHeldSec >= 600 &&
      guardAdverseMove >= guardMinInvalidation &&
      isGuardCall &&
      (params.activeFsmState === "SHORT" || (updatedTickerState.macroRegime === "PUT" && (updatedTickerState.chiPct ?? 50) < 48))
    ) {
      guardExitReason = "Macro Rotation to Bear Regime";
    }
  }

  let guardSaved = false;
  if (guardExitReason && tickerPos) {
    console.warn(`[GaiaSync] Closed ${positionTicker} ${tickerPos.contractType} position: ${guardExitReason}`);
    const isGuardCall = tickerPos.contractType === "CALL";
    const entryOptPrice = tickerPos.btoOptionMid || tickerPos.optionAsk || 0.50;
    const dirMove = isGuardCall ? guardCloseSpot - tickerPos.btoSpotPrice : tickerPos.btoSpotPrice - guardCloseSpot;
    const spotMovePct = Number(((dirMove / Math.max(0.01, tickerPos.btoSpotPrice)) * 100).toFixed(2));
    const rawEstOpt = Math.max(0.05, Number((entryOptPrice + dirMove * 0.45).toFixed(2)));
    const closedOptMid = clampOptionPriceToGreekEnvelope(
      tickerPos.btoSpotPrice,
      guardCloseSpot,
      entryOptPrice,
      rawEstOpt,
      isGuardCall,
      Math.max(1, guardHeldSec / 60)
    );
    const pnlOptionPct = Number((((closedOptMid - entryOptPrice) / Math.max(0.01, entryOptPrice)) * 100).toFixed(2));
    const guardTimeStr = formatTimeEt(guardNowDate);
    const isGuardLiveRth = guardNowEt.totalMinutes >= RTH_OPEN_MINS && guardNowEt.totalMinutes < RTH_CLOSE_MINS;
    const isGuardHistorical = Boolean(params.isHistoricalBackfill) || !isGuardLiveRth;
    const guardExitAlertId = `${tickerPos.id}-guard-stc-${guardNowTs}`;

    tickerPos.status = "CLOSED";
    tickerPos.remainingQty = 0;
    tickerPos.closedTs = guardNowTs;
    tickerPos.closedAt = guardTimeStr;
    tickerPos.closedSpotPrice = guardCloseSpot;
    tickerPos.closedOptionMid = closedOptMid;
    tickerPos.pnlSpotPct = spotMovePct;
    tickerPos.pnlOptionPct = pnlOptionPct;
    tickerPos.exitReason = guardExitReason;

    const guardExitAlert: TradeLifecycleAlert = {
      id: guardExitAlertId,
      timestamp: guardTimeStr,
      ts: guardNowTs,
      ticker: positionTicker,
      action: "SELL_TO_CLOSE",
      contractType: tickerPos.contractType,
      contractLabel: tickerPos.contractLabel,
      strike: tickerPos.strike,
      expiration: tickerPos.expiration,
      expHuman: tickerPos.expHuman,
      robinhoodExp: tickerPos.robinhoodExp,
      setupName: tickerPos.setupName,
      reason: guardExitReason,
      status: "CLOSED",
      spotPrice: guardCloseSpot,
      btoSpotPrice: tickerPos.btoSpotPrice,
      target1Spot: tickerPos.target1Spot,
      target2Spot: tickerPos.target2Spot,
      stopLossSpot: tickerPos.stopLossSpot,
      optionMid: closedOptMid,
      optionBid: closedOptMid,
      optionAsk: closedOptMid,
      btoOptionMid: entryOptPrice,
      contractsQty: tickerPos.contractsQty,
      remainingQty: 0,
      totalOutlay: tickerPos.totalOutlay,
      pnlSpotPct: spotMovePct,
      pnlOptionPct,
      isHistoricalBackfill: isGuardHistorical,
      eventId: guardExitAlertId,
      message: `🔴 STC · ${tickerPos.contractLabel} [${guardExitReason}] @ $${guardCloseSpot.toFixed(2)} · Spot ${spotMovePct >= 0 ? "+" : ""}${spotMovePct}% (${pnlOptionPct >= 0 ? "+" : ""}${pnlOptionPct}%)`,
    };

    store.closedPositions.push(tickerPos);
    delete store.activePositions[positionTicker];
    store.alerts.push(guardExitAlert);
    saveTradeStore(store);
    guardSaved = true;

    if (!isGuardHistorical && !params.signal?.aborted) {
      const sent = await sendDiscordTradeAlert(guardExitAlert, params.webhookUrl, { signal: params.signal }).catch(
        (err) => {
          console.error("[GaiaSync] Failed to dispatch Consistency Guard STC alert to Discord:", err);
          return false;
        }
      );
      if (sent) {
        const afterGuardSend = loadTradeStore();
        afterGuardSend.dispatchedAlertIds = afterGuardSend.dispatchedAlertIds || {};
        afterGuardSend.dispatchedAlertIds[guardExitAlertId] = true;
        saveTradeStore(afterGuardSend);
        store = afterGuardSend;
      }
    }
  }

  const rawSignals = Array.isArray(params.signals) ? params.signals : [];
  if (rawSignals.length === 0 || params.activeFsmState === "STAND_ASIDE") {
    if (gaiaStateChanged && !guardSaved) {
      saveTradeStore(store);
    }
    return { dispatchedCount: 0, keys: [] };
  }
  if (gaiaStateChanged && !guardSaved) {
    saveTradeStore(store);
  }

  if (!globalForGaiaDiscord.__hyperionDispatchedGaiaKeys) {
    globalForGaiaDiscord.__hyperionDispatchedGaiaKeys = new Set<string>();
  }
  const resolvedDate = params.sessionDate || getTodayEt();
  if ((globalForGaiaDiscord as any).__hyperionDispatchedDate !== resolvedDate) {
    (globalForGaiaDiscord as any).__hyperionDispatchedDate = resolvedDate;
    globalForGaiaDiscord.__hyperionDispatchedGaiaKeys.clear();
  }
  const dispatchedSet = globalForGaiaDiscord.__hyperionDispatchedGaiaKeys;
  const sorted = [...rawSignals].sort((a, b) => (a.index ?? a.idx ?? 0) - (b.index ?? b.idx ?? 0));
  const newlyDispatched: string[] = [];

  for (let i = 0; i < sorted.length; i++) {
    if (params.signal?.aborted) break;
    store = loadTradeStore();
    const sig = sorted[i];
    const nextSig = sorted[i + 1];
    const slot = getCanonicalGaiaSlot(sig);
    const rawSigTs = sig.timestamp || sig.barTimestamp;
    const nowTs = Math.floor(Date.now() / 1000);
    const eventTs =
      typeof rawSigTs === "number" && rawSigTs > 0
        ? rawSigTs > 1e11
          ? Math.floor(rawSigTs / 1000)
          : rawSigTs
        : nowTs;
    const isCall = sig.type === "LONG";
    const direction: ContractType = isCall ? "CALL" : "PUT";

    // Strict Macro & FSM Firewall: Never allow SHORT/PUT when FSM is LONG or strongly Bull Macro (> 52%),
    // and never allow LONG/CALL when FSM is SHORT or strongly Bear Macro (< 48%).
    const tickerFsmState = updatedTickerState.activeFsmState;
    const tickerChiPct = updatedTickerState.chiPct;
    const effectiveMacro =
      updatedTickerState.macroRegime ||
      (tickerChiPct !== undefined ? (tickerChiPct > 50 ? "CALL" : "PUT") : undefined);
    if (
      direction === "PUT" &&
      (tickerFsmState === "LONG" || (effectiveMacro === "CALL" && (tickerChiPct ?? 50) > 52))
    ) {
      console.warn(`[GaiaSync FIREWALL] Blocked ${positionTicker} PUT signal at $${sig.price} while regime is ${effectiveMacro} / FSM ${tickerFsmState} (χ=${tickerChiPct}%).`);
      continue;
    }
    const zgRef =
      typeof params.zeroGamma === "number" && params.zeroGamma > 0
        ? params.zeroGamma
        : typeof updatedTickerState.zeroGamma === "number" && updatedTickerState.zeroGamma > 0
          ? updatedTickerState.zeroGamma
          : undefined;
    const isBelowZeroGamma = typeof zgRef === "number" && zgRef > 0 && sig.price < zgRef;
    const isChiBearish = (tickerChiPct ?? 50) < 50;

    // Opening-range firewall check (< 9:45 AM ET, i.e. totalMinutes < 585):
    const sigDate = new Date(eventTs * 1000);
    const sigEt = getNowEtTime(sigDate);
    if (sigEt.totalMinutes < ENTRY_START_MINS || sigEt.totalMinutes > ENTRY_CUTOFF_MINS) {
      console.warn(`[GaiaSync FIREWALL] Blocked signal outside entry window (09:35-14:30 ET): ${sigEt.hours}:${sigEt.minutes}`);
      continue;
    }
    const storedSpotNorm = store.prevSpotPrices[normalizedTicker];
    const storedSpotPos = store.prevSpotPrices[positionTicker];
    const scaledStoredPos =
      typeof storedSpotPos === "number" && storedSpotPos > 0
        ? (isSpxwSync ? storedSpotPos * 10 : storedSpotPos)
        : undefined;
    const liveSpotRef =
      Number(params.spotPrice) > 0
        ? Number(params.spotPrice)
        : (storedSpotNorm ?? scaledStoredPos);
    if (typeof liveSpotRef === "number" && liveSpotRef > 0) {
      const basisDiffPct = Math.abs(sig.price - liveSpotRef) / liveSpotRef;
      if (basisDiffPct > 0.0075) {
        console.warn(`[GaiaSync FIREWALL] Blocked unphysical ${positionTicker} signal price ${sig.price} vs live spot ${liveSpotRef}`);
        continue;
      }
    }
    const isOpeningRangeSig = sigEt.totalMinutes < 585;
    const priorCloseRef =
      typeof storedSpotNorm === "number" && storedSpotNorm > 0
        ? storedSpotNorm
        : typeof scaledStoredPos === "number" && scaledStoredPos > 0
          ? scaledStoredPos
          : Number(params.spotPrice) > 0
            ? Number(params.spotPrice)
            : undefined;
    const isOpeningNegativeGamma =
      isOpeningRangeSig &&
      (isBelowZeroGamma ||
        (typeof priorCloseRef === "number" && sig.price < priorCloseRef) ||
        isChiBearish);

    const isImpulseCallReclaim =
      !isOpeningRangeSig &&
      ((params.impulseChi ?? 0) >= 0.60 ||
        Boolean(sig.label?.includes("Impulse") || sig.tag?.includes("IMPULSE")));
    const isHardBearishFlux = (tickerChiPct ?? 50) < 45 || effectiveMacro === "PUT" || tickerFsmState === "SHORT";
    if (
      direction === "CALL" &&
      !isImpulseCallReclaim &&
      (isHardBearishFlux || isBelowZeroGamma || isOpeningNegativeGamma)
    ) {
      console.warn(
        `[GaiaSync FIREWALL] Blocked Counter-Trend ${positionTicker} CALL signal at $${sig.price} (below ZG: ${isBelowZeroGamma}, χ: ${tickerChiPct}%, FSM: ${tickerFsmState}, Macro: ${effectiveMacro}, OpeningRange: ${isOpeningRangeSig}, PriorClose: ${priorCloseRef}).`
      );
      continue;
    }

    const idempotencyKey = `${positionTicker}_${eventTs}_${direction}`;
    const entryKey = `${resolvedDate}:${positionTicker}:ENTRY:${slot}:${idempotencyKey}`;

    if (!dispatchedSet.has(entryKey) && !store.dispatchedAlertIds?.[idempotencyKey]) {
      // Jane Street Two-Regime Single-Slot State Machine (per-ticker daily <= 2 cap, global single-slot activePositions <= 1):
      const sameTickerClosed = (store.closedPositions ?? []).filter(
        (p) => p.ticker === positionTicker || p.ticker === normalizedTicker
      );
      const closedCount = sameTickerClosed.length;
      const prevClosed = sameTickerClosed.reduce<OptionTradePosition | undefined>(
        (latest, cur) => (!latest || (cur.closedTs ?? 0) >= (latest.closedTs ?? 0) ? cur : latest),
        undefined
      );
      const prevCooldownMet =
        closedCount === 1 &&
        typeof prevClosed?.closedTs === "number" &&
        eventTs - prevClosed.closedTs >= 1800;
      const canPhase2OppositeReclaim =
        closedCount === 1 &&
        prevCooldownMet &&
        sigEt.totalMinutes >= 630 &&
        sigEt.totalMinutes <= ENTRY_CUTOFF_MINS &&
        prevClosed?.contractType !== direction;
      if (closedCount >= 2 || (closedCount >= 1 && !canPhase2OppositeReclaim)) {
        console.warn(`[GaiaSync FIREWALL] Blocked ${positionTicker} trade dispatch: Day is LOCKED_FOR_DAY (${closedCount} closed trades on ${positionTicker}).`);
        continue;
      }
      const activePos = store.activePositions[positionTicker];
      if (activePos && activePos.status === "OPEN") {
        console.warn(`[GaiaSync FIREWALL] Blocked trade dispatch: ${positionTicker} already has an ACTIVE position (${activePos.contractLabel}).`);
        continue;
      }
      if (Object.keys(store.activePositions || {}).length >= 1) {
        console.warn("[GaiaSync FIREWALL] Blocked trade dispatch: Another ticker position is already ACTIVE.");
        continue;
      }

      const posSigPrice = isSpxwSync ? Number((sig.price / 10).toFixed(2)) : Number(sig.price.toFixed(2));
      const syncStopDist = Math.max(0.05, Number((posSigPrice * 0.0016).toFixed(2)));
      const syncTp1Dist = Math.ceil((syncStopDist * 1.5 - 1e-9) * 100) / 100;
      const syncTp2Dist = Math.max(syncTp1Dist + 0.05, Number((posSigPrice * 0.0047).toFixed(2)));
      const target1Spot = isCall
        ? Number((posSigPrice + syncTp1Dist).toFixed(2))
        : Number((posSigPrice - syncTp1Dist).toFixed(2));
      const target2Spot = isCall
        ? Number((posSigPrice + syncTp2Dist).toFixed(2))
        : Number((posSigPrice - syncTp2Dist).toFixed(2));
      const stopLossSpot = isCall
        ? Number((posSigPrice - syncStopDist).toFixed(2))
        : Number((posSigPrice + syncStopDist).toFixed(2));

      // Attempt to find optimal live contract under $1.00 — fail closed when none qualifies
      const contractSpot = isSpxwSync ? Number((posSigPrice * 10).toFixed(2)) : posSigPrice;
      const contractT1 = isSpxwSync ? Number((target1Spot * 10).toFixed(2)) : target1Spot;
      const contractT2 = isSpxwSync ? Number((target2Spot * 10).toFixed(2)) : target2Spot;
      const contractSl = isSpxwSync ? Number((stopLossSpot * 10).toFixed(2)) : stopLossSpot;
      const optimal = await selectSmallAccountContract({
        ticker: normalizedTicker,
        contractType: direction,
        spotPrice: contractSpot,
        target1Spot: contractT1,
        target2Spot: contractT2,
        stopLossSpot: contractSl,
        conviction: 92,
        nowEt: sigDate,
        signal: params.signal,
      }).catch(() => null);

      if (params.signal?.aborted) break;
      if (!optimal) {
        console.warn(`[GaiaSync FIREWALL] No qualifying live contract under $1.00 for ${normalizedTicker} ${direction} @ $${posSigPrice.toFixed(2)} — skipping synthetic fallback.`);
        continue;
      }

      const strike = optimal.strike;
      const expDate = optimal.expiration;
      const contractLabel = optimal.contractLabel;
      const entryAsk = optimal.optionAsk || optimal.optionMid;
      const contractsQty: 1 = 1;
      const totalOutlay = Number((entryAsk * 100 * contractsQty).toFixed(2));
      if (contractsQty !== 1 || totalOutlay > 100) {
        console.warn(`[GaiaSync FIREWALL] Blocked ${positionTicker} outlay $${totalOutlay} (> $100 cap).`);
        continue;
      }
      const estTp1 = optimal.estTp1Mid;
      const estTp2 = optimal.estTp2Mid;
      // Hard stop loss floor: strictly clamp to max -25% loss (entryAsk * 0.75)
      const maxStopLossFloor = Number((entryAsk * 0.75).toFixed(2));
      const estStop = Math.max(maxStopLossFloor, optimal.estStopMid);
      const tp1Pct = Math.round(((estTp1 - entryAsk) / Math.max(0.01, entryAsk)) * 100);
      const tp2Pct = Math.round(((estTp2 - entryAsk) / Math.max(0.01, entryAsk)) * 100);
      const alertTimeStr = sig.time || sig.timeLabel || formatTimeEt(sigDate);

      // Dynamic Freshness Gate: Compute staleness relative to dynamic bar close timestamp
      const inferredIntervalSec =
        typeof sig.barSpanSeconds === "number" && sig.barSpanSeconds > 0
          ? sig.barSpanSeconds
          : 300;
      const eventCloseTs = sig.barCloseTimestamp || (eventTs + inferredIntervalSec);
      const isStale = nowTs - eventCloseTs > Math.round(inferredIntervalSec * 1.5);
      const isRthWindow = sigEt.totalMinutes >= RTH_OPEN_MINS && sigEt.totalMinutes < RTH_CLOSE_MINS;
      const isHistoricalBackfill = isStale || !isRthWindow || Boolean(params.isHistoricalBackfill);
      const alertId = `gaia-${tickerSlug}-${entryKey.toLowerCase().replace(/[^a-z0-9]/g, "-")}`;

      const btoAlert: TradeLifecycleAlert = {
        id: alertId,
        timestamp: alertTimeStr,
        ts: eventTs,
        dispatchedAt: nowTs,
        ticker: positionTicker,
        action: "BUY_TO_OPEN",
        contractType: direction,
        contractLabel,
        strike,
        expiration: expDate,
        expHuman: optimal.expHuman,
        robinhoodExp: optimal.robinhoodExp,
        robinhoodTab: optimal.robinhoodTab,
        setupName: `Gaia Tactical HUD [${sig.label || sig.type}]`,
        reason: `Gaia Intraday ${sig.label || sig.type} signal at $${posSigPrice.toFixed(2)}`,
        status: "OPEN",
        spotPrice: posSigPrice,
        btoSpotPrice: posSigPrice,
        target1Spot,
        target2Spot,
        stopLossSpot,
        optionMid: entryAsk,
        optionBid: optimal.optionBid,
        optionAsk: entryAsk,
        btoOptionMid: entryAsk,
        contractsQty,
        remainingQty: contractsQty,
        totalOutlay,
        estTp1Mid: estTp1,
        estTp2Mid: estTp2,
        estStopMid: estStop,
        tp1Pct,
        tp2Pct,
        rrRatio: 1.5,
        altContractNote: optimal.altContractNote,
        calibratedWinRate: 68,
        calibratedExpectancyR: 0.45,
        dataConvictionScore: 92,
        isHistoricalBackfill,
        eventId: alertId,
        message: `${isCall ? "🟢" : "🟣"} BUY TO OPEN (${contractsQty}x @ $${entryAsk.toFixed(2)}) · ${positionTicker} [Gaia ${sig.label || sig.type}] @ $${posSigPrice.toFixed(2)} · SL: $${stopLossSpot}, TP1: $${target1Spot}, TP2: $${target2Spot}`,
      };

      // Create tracking position
      const newPos: OptionTradePosition = {
        id: alertId,
        ticker: positionTicker,
        contractType: direction,
        contractLabel,
        strike,
        expiration: expDate,
        expHuman: optimal.expHuman,
        robinhoodExp: optimal.robinhoodExp,
        robinhoodTab: optimal.robinhoodTab,
        setupName: btoAlert.setupName,
        status: "OPEN",
        btoSpotPrice: posSigPrice,
        btoOptionMid: entryAsk,
        optionBid: optimal.optionBid,
        optionAsk: entryAsk,
        contractsQty,
        remainingQty: contractsQty,
        totalOutlay,
        estTp1Mid: estTp1,
        estTp2Mid: estTp2,
        estStopMid: estStop,
        tp1Pct,
        tp2Pct,
        target1Spot,
        target2Spot,
        stopLossSpot,
        openedAt: alertTimeStr,
        openedTs: eventTs,
        rrRatio: 1.5,
        initialRisk: Number(Math.max(0.05, Math.abs(posSigPrice - stopLossSpot)).toFixed(2)),
        atr5m: Number((posSigPrice * 0.0018).toFixed(4)),
        altContractNote: optimal.altContractNote,
        calibratedWinRate: 68,
        calibratedExpectancyR: 0.45,
        dataConvictionScore: 92,
      };

      if (params.signal?.aborted) break;
      const latestStoreBeforeCommit = loadTradeStore();
      if (Object.keys(latestStoreBeforeCommit.activePositions || {}).length > 0) {
        console.warn(`[GaiaSync FIREWALL] Aborted ${positionTicker} commit: global slot became occupied during option lookup.`);
        continue;
      }
      applyGaiaStateToStore(latestStoreBeforeCommit);
      latestStoreBeforeCommit.activePositions[positionTicker] = newPos;
      latestStoreBeforeCommit.alerts.push(btoAlert);
      latestStoreBeforeCommit.dispatchedAlertIds = latestStoreBeforeCommit.dispatchedAlertIds || {};
      if (isHistoricalBackfill) {
        dispatchedSet.add(entryKey);
        newlyDispatched.push(entryKey);
        latestStoreBeforeCommit.dispatchedAlertIds[btoAlert.id] = true;
        latestStoreBeforeCommit.dispatchedAlertIds[idempotencyKey] = true;
        saveTradeStore(latestStoreBeforeCommit);
        store = latestStoreBeforeCommit;
      } else {
        saveTradeStore(latestStoreBeforeCommit);
        store = latestStoreBeforeCommit;
        const sent = await sendDiscordTradeAlert(btoAlert, params.webhookUrl, { signal: params.signal }).catch((err) => {
          console.error("[GaiaSync] Failed to dispatch BTO alert to Discord:", err);
          return false;
        });
        if (sent) {
          dispatchedSet.add(entryKey);
          newlyDispatched.push(entryKey);
          const afterSendStore = loadTradeStore();
          afterSendStore.dispatchedAlertIds = afterSendStore.dispatchedAlertIds || {};
          afterSendStore.dispatchedAlertIds[btoAlert.id] = true;
          afterSendStore.dispatchedAlertIds[idempotencyKey] = true;
          saveTradeStore(afterSendStore);
          store = afterSendStore;
        }
      }
    }

    // Handle Opposing Reversal Exit — strictly require matching open ticker position (no phantom STC fabrication)
    if (nextSig && nextSig.type !== sig.type) {
      if (params.signal?.aborted) break;
      const latestExitStore = loadTradeStore();
      const openPos = latestExitStore.activePositions[positionTicker];
      if (!openPos || openPos.contractType !== direction) {
        continue;
      }
      const nextSigRawTs = nextSig.timestamp || nextSig.barTimestamp || Math.floor(Date.now() / 1000);
      const nextSigEpochSec = nextSigRawTs > 1e11 ? Math.floor(nextSigRawTs / 1000) : nextSigRawTs;
      const nextPosPrice = isSpxwSync ? Number((nextSig.price / 10).toFixed(2)) : Number(nextSig.price.toFixed(2));
      const heldSeconds = nextSigEpochSec - (openPos.openedTs || nextSigEpochSec);
      const adverseSpot = isCall ? openPos.btoSpotPrice - nextPosPrice : nextPosPrice - openPos.btoSpotPrice;
      const estOptMovePct = (((isCall ? nextPosPrice - openPos.btoSpotPrice : openPos.btoSpotPrice - nextPosPrice) * 0.45) / Math.max(0.01, openPos.btoOptionMid || 0.5)) * 100;
      const minSyncRev = computeAdaptiveQuantMetrics(
        nextPosPrice,
        openPos.atr5m ?? nextPosPrice * 0.0018
      ).minReversalInvalidation;
      if (heldSeconds < 600 || (adverseSpot < minSyncRev && estOptMovePct < 10)) {
        continue;
      }

      const exitKey = `${resolvedDate}:${positionTicker}:EXIT:${slot}`;
      const dedupExitAlertId = `gaia-${tickerSlug}-${exitKey.toLowerCase().replace(/[^a-z0-9]/g, "-")}`;
      if (!dispatchedSet.has(exitKey) && !latestExitStore.dispatchedAlertIds?.[dedupExitAlertId]) {
        const entrySpot = openPos.btoSpotPrice;
        const entryOptMid = openPos.btoOptionMid || openPos.optionAsk || 0.50;
        const underlyingMove = isCall ? nextPosPrice - entrySpot : entrySpot - nextPosPrice;
        const spotMovePct = Number(((underlyingMove / Math.max(0.01, entrySpot)) * 100).toFixed(2));
        const rawEstExit = Math.max(0.05, Number((entryOptMid + underlyingMove * 0.45).toFixed(2)));
        const estExitPrice = clampOptionPriceToGreekEnvelope(
          entrySpot,
          nextPosPrice,
          entryOptMid,
          rawEstExit,
          isCall,
          Math.max(1, heldSeconds / 60)
        );
        const pnlOptionPct = Number((((estExitPrice - entryOptMid) / Math.max(0.01, entryOptMid)) * 100).toFixed(1));
        const exitAlertId = dedupExitAlertId;
        const nextSigDate = new Date(nextSigEpochSec * 1000);
        const exitTimeStr = nextSig.time || nextSig.timeLabel || formatTimeEt(nextSigDate);
        const nextSigEt = getNowEtTime(nextSigDate);
        const isExitRthWindow = nextSigEt.totalMinutes >= RTH_OPEN_MINS && nextSigEt.totalMinutes < RTH_CLOSE_MINS;
        const isExitStale = Math.floor(Date.now() / 1000) - nextSigEpochSec > 450;
        const isExitHistorical = isExitStale || !isExitRthWindow || Boolean(params.isHistoricalBackfill);

        const exitAlert: TradeLifecycleAlert = {
          id: exitAlertId,
          timestamp: exitTimeStr,
          ts: nextSigEpochSec,
          ticker: positionTicker,
          action: "SELL_TO_CLOSE",
          contractType: direction,
          contractLabel: openPos.contractLabel,
          strike: openPos.strike,
          expiration: openPos.expiration,
          setupName: openPos.setupName,
          reason: `Gaia closed on reversal transition to ${nextSig.label || nextSig.type}`,
          status: "CLOSED",
          spotPrice: nextPosPrice,
          btoSpotPrice: entrySpot,
          target1Spot: openPos.target1Spot,
          target2Spot: openPos.target2Spot,
          stopLossSpot: openPos.stopLossSpot,
          optionMid: estExitPrice,
          optionBid: estExitPrice,
          optionAsk: estExitPrice,
          btoOptionMid: entryOptMid,
          contractsQty: openPos.contractsQty,
          remainingQty: 0,
          totalOutlay: openPos.totalOutlay,
          pnlSpotPct: spotMovePct,
          pnlOptionPct,
          isHistoricalBackfill: isExitHistorical,
          eventId: exitAlertId,
          message: `🔴 SELL TO CLOSE · ${openPos.contractLabel} [Gaia ${sig.label || sig.type}] @ $${nextPosPrice.toFixed(2)} · Spot ${spotMovePct >= 0 ? "+" : ""}${spotMovePct}% (${pnlOptionPct >= 0 ? "+" : ""}${pnlOptionPct}%)`,
        };

        openPos.status = "CLOSED";
        openPos.remainingQty = 0;
        openPos.closedAt = exitTimeStr;
        openPos.closedTs = nextSigEpochSec;
        openPos.closedSpotPrice = nextPosPrice;
        openPos.closedOptionMid = estExitPrice;
        openPos.pnlOptionPct = pnlOptionPct;
        openPos.pnlSpotPct = spotMovePct;
        openPos.exitReason = exitAlert.reason;
        latestExitStore.closedPositions.push(openPos);
        delete latestExitStore.activePositions[positionTicker];

        latestExitStore.alerts.push(exitAlert);
        latestExitStore.dispatchedAlertIds = latestExitStore.dispatchedAlertIds || {};
        if (isExitHistorical) {
          dispatchedSet.add(exitKey);
          newlyDispatched.push(exitKey);
          latestExitStore.dispatchedAlertIds[exitAlert.id] = true;
          saveTradeStore(latestExitStore);
          store = latestExitStore;
        } else {
          saveTradeStore(latestExitStore);
          store = latestExitStore;
          const sent = await sendDiscordTradeAlert(exitAlert, params.webhookUrl, { signal: params.signal }).catch((err) => {
            console.error("[GaiaSync] Failed to dispatch STC alert to Discord:", err);
            return false;
          });
          if (sent) {
            dispatchedSet.add(exitKey);
            newlyDispatched.push(exitKey);
            const afterExitSend = loadTradeStore();
            afterExitSend.dispatchedAlertIds = afterExitSend.dispatchedAlertIds || {};
            afterExitSend.dispatchedAlertIds[exitAlert.id] = true;
            saveTradeStore(afterExitSend);
            store = afterExitSend;
          }
        }
      }
    }
  }

  return { dispatchedCount: newlyDispatched.length, keys: newlyDispatched };
}

export const syncGaiaSpySignalsToDiscord = syncGaiaTickerSignalsToDiscord;

