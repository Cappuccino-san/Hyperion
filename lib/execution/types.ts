import type { NormalizedOptionContract } from "@/lib/optionsExposure";
import type { FlowGammaVwapSnapshot } from "@/lib/flowGammaVwap";
import type { MarketRegimeId } from "@/lib/persistenceStore";
import { WATCH_LIST } from "@/lib/tickerPresets";

export type ContractType = "CALL" | "PUT";
export type PositionStatus = "OPEN" | "PARTIAL_TP1" | "CLOSED";
export type SignalAction = "BUY_TO_OPEN" | "SELL_TO_CLOSE";
export type DivergenceDirection = "BULL" | "BEAR" | "NO";
export type ExitQuoteSource = "LIVE_CHAIN_BID" | "DELAYED_CBOE_BID" | "BS_FALLBACK";

export const MAX_ENGINE_CACHE_ENTRIES = 64;

export function setBoundedMapEntry<K, V>(
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

export function createLinkedTimeoutSignal(
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
  btoOptionAsk?: number;
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
  closedOptionBid?: number | null;
  exitQuoteSource?: ExitQuoteSource;
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
  entryRegime?: string;
  divergence5m?: DivergenceDirection;
  divergence30m?: DivergenceDirection;
  callWall?: number;
  putWall?: number;
  zeroGamma?: number;
  peakOptionPnlPct?: number;
  peakFavorableSpotMfePct?: number;
  originBackfill?: boolean;
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
  btoOptionAsk?: number;
  closedOptionBid?: number | null;
  exitQuoteSource?: ExitQuoteSource;
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
  entryRegime?: string;
  divergence5m?: DivergenceDirection;
  divergence30m?: DivergenceDirection;
  callWall?: number;
  putWall?: number;
  zeroGamma?: number;
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
  bookCenterHistoryByTicker?: Record<string, number[]>;
  bookCenterLastTsByTicker?: Record<string, number>;
  bouncedPutWalls?: Record<string, number>;
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
  allExpKing?: number | null;
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
  regime?: MarketRegimeId;
  absImpulsePeclet?: number;
  remainingExpectedMove?: number;
  dataSource?: string;
  referenceSpotPrice?: number;
  contractsAlreadyAnchored?: boolean;
  signal?: AbortSignal;
}

export interface TradeEvaluationResult {
  ticker: string;
  activePosition: OptionTradePosition | null;
  emittedAlerts: TradeLifecycleAlert[];
  allAlerts: TradeLifecycleAlert[];
}

export interface WalkForwardCalibration {
  winRate: number;              // 0 - 100%
  expectancyR: number;          // R-multiple, e.g. +0.48R
  dataConvictionScore: number;  // 0 - 100
  sampleSize: number;
  passesGate: boolean;
}

export const SUPPORTED_TRADE_TICKERS = new Set<string>(WATCH_LIST);

export function isSupportedTradeTicker(rawTicker: string): boolean {
  const sym = rawTicker.trim().toUpperCase().replace(/^\$/, "");
  if (!sym) return false;
  return SUPPORTED_TRADE_TICKERS.has(sym) || /^[A-Z0-9._-]{1,10}$/.test(sym);
}

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
