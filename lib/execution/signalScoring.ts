import type { FlowGammaVwapSnapshot } from "@/lib/flowGammaVwap";
import { computeAdaptiveQuantMetrics } from "@/lib/gaiaSignalFsm";
import { getSessionBoundsEt } from "@/lib/gaiaSessionGuards";
import {
  evaluateLeg2StructuralGate,
  evaluateOpeningHorizonAlignment,
} from "@/lib/alphaScorer";
import { readHistoricalSessions } from "@/lib/persistenceStore";
import { computeTradeRealizedPnl } from "@/lib/execution/pnlAccounting";
import {
  ContractType,
  DailyTradeStore,
  OptionTradePosition,
  TradeDirection,
  TradeEvaluationParams,
  UnifiedBarFeatures,
  UnifiedSniperCandidate,
  WalkForwardCalibration,
  createLinkedTimeoutSignal,
  setBoundedMapEntry,
} from "@/lib/execution/types";
import { estimateDynamicAtmIv, formatEtIsoDate } from "@/lib/execution/optionPricing";

const calibrationCache = new Map<string, { timestampMs: number; result: WalkForwardCalibration }>();

/**
 * Pure Neutral Empirical Bayes shrinkage evaluator (W_0 = 0.50, E_0 = 0.0R, m = 5).
 * Keeps dataConvictionScore strictly for display/ranking and gates solely on
 * cold-start admission (totalSamples < 5) or (shrunkWinRate >= 0.52 && shrunkExpectancy >= 0.15).
 */
export function computeNeutralEmpiricalBayesCalibration(params: {
  wins: number;
  losses: number;
  totalR: number;
  priorStrengthM?: number;
}): WalkForwardCalibration & { isColdStart: boolean } {
  const m = params.priorStrengthM ?? 5;
  const priorWinRate = 0.50;
  const priorExpR = 0.0;
  const totalSamples = Math.max(0, Math.round(params.wins) + Math.round(params.losses));
  const denom = totalSamples + m;
  const shrunkWinRate = (m * priorWinRate + Math.max(0, params.wins)) / denom;
  const shrunkExpectancy = (m * priorExpR + params.totalR) / denom;
  const winRatePct = Number((shrunkWinRate * 100).toFixed(1));
  const expectancyR = Number(shrunkExpectancy.toFixed(2));
  const isColdStart = totalSamples < 5;
  const dataConvictionScore = Math.max(
    10,
    Math.min(
      99,
      Math.round(winRatePct * 0.72 + Math.max(-0.5, expectancyR) * 32 + Math.min(14, totalSamples * 0.8))
    )
  );
  const passesGate = isColdStart || (shrunkWinRate >= 0.52 && shrunkExpectancy >= 0.15);

  return {
    winRate: winRatePct,
    expectancyR,
    dataConvictionScore,
    sampleSize: totalSamples,
    passesGate,
    isColdStart,
  };
}

/**
 * Calibrates rolling 10-day historical expectancy with Neutral Empirical Bayes shrinkage
 * strictly from prior durable Hyperion session ledgers [D-10, D-1] (date < sessionDate).
 * Zero lookahead, zero synthetic SMA proxy, zero optimistic floors.
 */
export async function calibrateWalkForwardExpectancy(
  ticker: string,
  sessionDate: string,
  signal?: AbortSignal
): Promise<WalkForwardCalibration> {
  const sym = ticker.trim().toUpperCase();
  const cacheKey = `${sym}:${sessionDate}`;
  const now = Date.now();
  const cachedEntry = calibrationCache.get(cacheKey);
  if (cachedEntry && now - cachedEntry.timestampMs < 300_000) {
    return cachedEntry.result;
  }

  const defaultResult: WalkForwardCalibration = computeNeutralEmpiricalBayesCalibration({
    wins: 0,
    losses: 0,
    totalR: 0,
  });

  if (signal?.aborted) {
    return defaultResult;
  }

  try {
    const sessions = await readHistoricalSessions(14);
    let wins = 0;
    let losses = 0;
    let totalR = 0;

    for (const s of sessions) {
      if (!s || !s.date || s.date >= sessionDate) continue;
      for (const pos of s.closedPositions || []) {
        if (!pos) continue;
        // Pool all real closed trades on this ticker (or portfolio-wide when ticker-specific N is small)
        const posTicker = (pos.ticker || "").trim().toUpperCase();
        if (posTicker && posTicker !== sym) continue;
        const pnl = computeTradeRealizedPnl(pos);
        if (pnl.realizedDollarPnl > 0) wins++;
        else if (pnl.realizedDollarPnl < 0) losses++;
        totalR += pnl.rMultiple;
      }
    }

    const finalResult: WalkForwardCalibration = computeNeutralEmpiricalBayesCalibration({
      wins,
      losses,
      totalR,
      priorStrengthM: 5,
    });

    setBoundedMapEntry(calibrationCache, cacheKey, { timestampMs: now, result: finalResult });
    return finalResult;
  } catch {
    if (!signal?.aborted) {
      setBoundedMapEntry(calibrationCache, cacheKey, { timestampMs: now, result: defaultResult });
    }
    return defaultResult;
  }
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
  const sessionDate = formatEtIsoDate(dt);
  const bounds = getSessionBoundsEt(sessionDate);
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

  if (etMins < bounds.entryStartMins || etMins > bounds.entryCutoffMins) return null;

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

  const isBullishRegimeLocked =
    (spot > vwap && spot > sma34 && kingStrike > spot) ||
    (spot > vwap && vwapSlope > minVwapSlope && isHigherHighs);

  const isBearishRegimeLocked =
    (spot < vwap && spot < sma34) ||
    (spot < vwap && kingStrike < spot) ||
    (spot < vwap && vwapSlope < -minVwapSlope && isLowerLows);

  const isMorningMomentumWindow = etMins >= bounds.entryStartMins && etMins <= 11 * 60;
  const isOpeningHourFlushWindow = etMins >= bounds.entryStartMins && etMins <= 10 * 60 + 30;

  const openingSlice = bars.slice(0, Math.min(3, bars.length));
  const openingLow = Math.min(...openingSlice.map((b) => b.low));
  const openingHigh = Math.max(...openingSlice.map((b) => b.high));

  let direction: TradeDirection | null = null;
  let setupName = "";

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
  } else if (
    isOpeningHourFlushWindow &&
    spot < vwap &&
    spot < sma34 &&
    vwapSlope <= -minVwapSlope * 0.5 &&
    features.gammaRegime < 0 &&
    bar.close < bar.open &&
    bar.close <= prevBar.close
  ) {
    direction = "SHORT";
    setupName = "Bearish Zero-Gamma Flush [BTO PUT]";
  } else if (
    !isBearishRegimeLocked &&
    ((bar.low <= openingLow && bar.close > bar.open && bar.close >= sma34 && prevBar.close <= sma34) ||
      (distSupport >= -Math.max(0.05, spot * 0.0005) && distSupport <= Math.max(0.15, spot * 0.0011) && bar.close > bar.open && features.trendVwap >= -0.25))
  ) {
    direction = "LONG";
    setupName = "Support Bounce";
  } else if (
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
  } else if (
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

export interface BtoCandidateSetupResult {
  candidateBto: {
    contractType: ContractType;
    setupName: string;
    stopLossSpot: number;
    target1Spot: number;
    target2Spot: number;
  } | null;
  tacticalCw: number;
  tacticalPw: number;
  effectiveZeroGamma: number;
  effectiveFlowVwap: number;
  effectiveSma34: number;
  tacticalBookCenter: number;
  resolvedNetGex: number | undefined;
  flowSnap: FlowGammaVwapSnapshot | null;
  entryMetrics: ReturnType<typeof computeAdaptiveQuantMetrics>;
  entryAtr5m: number;
}

export function evaluateBtoCandidateSetup(input: {
  normalizedTicker: string;
  spotPrice: number;
  prevSpotPrice: number;
  params: TradeEvaluationParams;
  store: DailyTradeStore;
  latest5mCandle: TradeEvaluationParams["latest5mCandle"];
  divergence5m: TradeEvaluationParams["divergence5m"];
  divergence30m: TradeEvaluationParams["divergence30m"];
  etTotalMinutes: number;
  nowTs: number;
  sessionDate: string;
  isPhase2ReclaimWindow: boolean;
  isShakeoutRecoveryWindow?: boolean;
  lastClosed?: OptionTradePosition;
  sameTickerClosedCount: number;
}): BtoCandidateSetupResult {
  const {
    normalizedTicker,
    spotPrice,
    prevSpotPrice,
    params,
    store,
    latest5mCandle,
    divergence5m,
    divergence30m,
    etTotalMinutes,
    nowTs,
    sessionDate,
    isPhase2ReclaimWindow,
    isShakeoutRecoveryWindow = false,
    lastClosed,
    sameTickerClosedCount,
  } = input;

  const {
    callWall,
    putWall,
    zeroGamma,
    dailyExpectedMove,
    kingNode,
    filteredKing,
    bookCenter,
  } = params;
  const sessionBounds = getSessionBoundsEt(sessionDate);

  let candidateBto: BtoCandidateSetupResult["candidateBto"] = null;

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

  const isOpeningRange = etTotalMinutes < 585;
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
      rawChi = 0.35;
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

  const effectiveFlowVwap =
    flowSnap && typeof flowSnap.flowVwap === "number" && flowSnap.flowVwap > 0
      ? flowSnap.flowVwap
      : premarketFlowVwapRef;
  const effectiveSma34 =
    latest5mCandle && typeof latest5mCandle.sma34 === "number" && latest5mCandle.sma34 > 0
      ? latest5mCandle.sma34
      : priorCloseRef;
  const isOpeningHour = etTotalMinutes >= sessionBounds.entryStartMins && etTotalMinutes <= 630;
  const tickerMacroRegime =
    store.gaiaStateByTicker?.[normalizedTicker]?.macroRegime ??
    (normalizedTicker === "SPY" && !store.gaiaStateByTicker ? store.macroRegime : undefined);
  const isShortGammaOrRedFlux =
    currentChi < 0.45 || currentNetFlux < 0 || isOpeningNegativeGamma || tickerMacroRegime === "PUT";
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
  const minRiskFloor = Math.max(0.15, entryAtr5m * 0.90, spotPrice * 0.0010);
  const stopWickBuf = entryMetrics.stopWickBuffer;
  const smallTargetTrim = Math.max(0.02, spotPrice * 0.00013);
  const barBody = latest5mCandle ? latest5mCandle.close - latest5mCandle.open : 0;
  const minOpposingWallClearance =
    spotPrice >= 400 ? Math.max(2.25, spotPrice * 0.0032) : spotPrice * 0.0032;
  const opposingPutWall =
    params.zeroDtePutWall && params.zeroDtePutWall > 0 && params.zeroDtePutWall <= spotPrice * 1.005
      ? params.zeroDtePutWall
      : tacticalPw > 0
        ? tacticalPw
        : putWall > 0
          ? putWall
          : 0;
  const opposingCallWall =
    params.zeroDteCallWall && params.zeroDteCallWall > 0 && params.zeroDteCallWall >= spotPrice * 0.995
      ? params.zeroDteCallWall
      : tacticalCw > 0
        ? tacticalCw
        : callWall > 0
          ? callWall
          : 0;
  const hasDecisivePutBreakdown =
    opposingPutWall > 0 &&
    spotPrice < opposingPutWall &&
    (!latest5mCandle || latest5mCandle.close < opposingPutWall) &&
    currentChi <= 0.44 &&
    currentPe <= -1.5;
  const hasDecisiveCallBreakout =
    opposingCallWall > 0 &&
    spotPrice > opposingCallWall &&
    (!latest5mCandle || latest5mCandle.close > opposingCallWall) &&
    currentChi >= 0.56 &&
    currentPe >= 1.5;
  const hasAdequatePutRoomToWall =
    opposingPutWall <= 0 ||
    hasDecisivePutBreakdown ||
    (spotPrice >= opposingPutWall && spotPrice - opposingPutWall >= minOpposingWallClearance);
  const hasAdequateCallRoomToWall =
    opposingCallWall <= 0 ||
    hasDecisiveCallBreakout ||
    (spotPrice <= opposingCallWall && opposingCallWall - spotPrice >= minOpposingWallClearance);
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

  // SETUP 1A: Bearish Zero-Gamma Flush [BTO PUT]
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
    const maxTacticalSpotRisk = Math.max(
      entryMetrics.minReversalInvalidation,
      Math.min(spotPrice * 0.0045, fluxSigma * 1.25)
    );
    const stopAnchor = Math.min(rawStructuralStop, spotPrice + maxTacticalSpotRisk);
    const stopLoss = Number(Math.max(spotPrice + minRiskFloor, stopAnchor * 1.001).toFixed(2));
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

      if (target1 < spotPrice && target2 <= target1 && (spotPrice - target1) / risk >= 1.5 - 1e-6) {
        candidateBto = {
          contractType: "PUT",
          setupName: (etTotalMinutes >= sessionBounds.entryStartMins && etTotalMinutes <= 615)
            ? "Pre-Market Flux High Rejection & Bearish Open [BTO PUT]"
            : "Bearish Zero-Gamma Flush [BTO PUT]",
          stopLossSpot: stopLoss,
          target1Spot: target1,
          target2Spot: target2,
        };
      }
    }
  }

  // SETUP 1B: Dynamic LOD Put Wall, King Node & Flux-Extremity Reclaim [BTO CALL]
  const isMiddayReclaimWindow = etTotalMinutes >= 600 && etTotalMinutes <= sessionBounds.entryCutoffMins;
  const fallbackAllExpKing = params.allExpKing ?? kingNode?.allExpKing ?? 0;
  const activeKingNode = (filteredKing && filteredKing > 0) ? filteredKing : (fallbackAllExpKing > 0 ? Number(fallbackAllExpKing) : 0);
  const tacticalBookCenter = (activeKingNode > 0 && Math.abs(activeKingNode - spotPrice) / spotPrice <= 0.012)
    ? activeKingNode
    : (tacticalPw > 0 && tacticalCw > tacticalPw)
      ? Number(((tacticalCw + tacticalPw) / 2).toFixed(2))
      : effectiveSma34;
  const observedBookCenter =
    typeof bookCenter === "number" && Number.isFinite(bookCenter) && bookCenter > 0
      ? bookCenter
      : tacticalBookCenter;
  if (observedBookCenter > 0) {
    const histMap = { ...(store.bookCenterHistoryByTicker || {}) };
    const tsMap = { ...(store.bookCenterLastTsByTicker || {}) };
    const prevHist = [...(histMap[normalizedTicker] || [])];
    const barTsVal = latest5mCandle?.timestamp ?? 0;
    if (barTsVal > 0 && tsMap[normalizedTicker] === barTsVal && prevHist.length > 0) {
      prevHist[prevHist.length - 1] = observedBookCenter;
    } else {
      prevHist.push(observedBookCenter);
      if (barTsVal > 0) tsMap[normalizedTicker] = barTsVal;
    }
    histMap[normalizedTicker] = prevHist.slice(-6);
    store.bookCenterHistoryByTicker = histMap;
    store.bookCenterLastTsByTicker = tsMap;
  }

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
      if (target1 > spotPrice && target2 >= target1 && (target1 - spotPrice) / risk >= 1.5 - 1e-6) {
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

  // SETUP 1C: Zero-Gamma Flip & Boundary Flux Reclaim [BTO CALL]
  const reclaimedZeroGammaAndVwap =
    effectiveZeroGamma > 0 &&
    spotPrice > effectiveZeroGamma &&
    spotPrice > effectiveFlowVwap &&
    spotPrice > effectiveSma34;
  const hasPositiveFluxImpulse =
    currentChi >= 0.48 || currentNetFlux > 0 || currentPe >= 0.40 || tickerMacroRegime === "CALL";
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
      if (target1 > spotPrice && target2 >= target1 && (target1 - spotPrice) / risk >= 1.5 - 1e-6) {
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

  // Flow VWAP Dispersion Band Regime Signals (1B/1C/1D)
  if (!candidateBto && flowSnap && latest5mCandle) {
    const bandSig = flowSnap.bandSignal;

    if (
      (bandSig === "LOWER_2S_BOUNCE" ||
        (bandSig === "LOWER_1S_BOUNCE" && currentChi >= 0.52) ||
        (isPositiveGammaRegime &&
          Math.abs(currentPe) < 1.5 &&
          (spotPrice <= flowSnap.lower1Sigma * 1.0015 || recent5mLow <= flowSnap.lower1Sigma) &&
          divergence5m === "BULL" &&
          spotPrice >= effectiveFlowVwap)) &&
      currentChi >= 0.48 &&
      (currentNetFlux >= 0 || latest5mCandle.close >= latest5mCandle.sma34) &&
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
        if (target1 > spotPrice && target2 >= target1 && (target1 - spotPrice) / risk >= 1.5 - 1e-6) {
          candidateBto = {
            contractType: "CALL",
            setupName: `Gaia Call Regime -2σ Flow Bounce (χ=${(currentChi * 100).toFixed(0)}%)`,
            stopLossSpot: stopLoss,
            target1Spot: target1,
            target2Spot: target2,
          };
        }
      }
    } else if (
      (bandSig === "UPPER_2S_REJECT" ||
        (bandSig === "UPPER_1S_REJECT" && currentChi <= 0.48) ||
        (isPositiveGammaRegime &&
          Math.abs(currentPe) < 1.5 &&
          (spotPrice >= flowSnap.upper1Sigma * 0.9985 || recent5mHigh >= flowSnap.upper1Sigma) &&
          divergence5m === "BEAR" &&
          spotPrice <= effectiveFlowVwap)) &&
      currentChi <= 0.52 &&
      (currentNetFlux <= 0 || latest5mCandle.close <= latest5mCandle.sma34) &&
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
        if (target1 < spotPrice && target2 <= target1 && (spotPrice - target1) / risk >= 1.5 - 1e-6) {
          candidateBto = {
            contractType: "PUT",
            setupName: `Gaia Put Regime +2σ Flow Rejection (χ=${(currentChi * 100).toFixed(0)}%)`,
            stopLossSpot: stopLoss,
            target1Spot: target1,
            target2Spot: target2,
          };
        }
      }
    } else if (
      (!isPositiveGammaRegime || Math.abs(currentPe) >= 1.5) &&
      currentChi >= 0.58 &&
      currentPe >= 0.85 &&
      currentNetFlux > 0 &&
      hasAdequateCallRoomToWall &&
      spotPrice > flowSnap.flowVwap &&
      latest5mCandle.close > latest5mCandle.sma34 &&
      latest5mCandle.close > latest5mCandle.open &&
      Math.abs(spotPrice - flowSnap.flowVwap) <= entryAtr5m * (latest5mCandle.open <= flowSnap.flowVwap + entryAtr5m * 0.15 ? 1.25 : 0.75) &&
      Math.abs(barBody) <= maxSignalBarBody * (latest5mCandle.open <= flowSnap.flowVwap + entryAtr5m * 0.15 ? 1.35 : 1.0)
    ) {
      const candleStop = Number(
        Math.min(spotPrice - minRiskFloor, Math.min(flowSnap.flowVwap, latest5mCandle.low) - spotPrice * 0.0005).toFixed(2)
      );
      const cwCeiling = tacticalCw > spotPrice ? tacticalCw : 0;
      const stopLoss = candleStop;
      const risk = Math.max(minRiskFloor, spotPrice - stopLoss);
      if (cwCeiling === 0 || cwCeiling - spotPrice >= risk * 1.5) {
        const minT1 = Math.ceil((spotPrice + risk * 1.5 - 1e-9) * 100) / 100;
        const sigma1Target = cwCeiling > 0 ? Math.min(cwCeiling, flowSnap.upper1Sigma) : flowSnap.upper1Sigma;
        const rawT1 = Number((Math.ceil((Math.max(minT1, sigma1Target) - 1e-9) * 100) / 100).toFixed(2));
        const target1 = cwCeiling > 0 ? Math.min(cwCeiling, rawT1) : rawT1;
        const rawT2 = Number(Math.max(target1 + Math.max(0.05, spotPrice * 0.0005), flowSnap.upper2Sigma, cwCeiling).toFixed(2));
        const target2 = cwCeiling > 0 ? Number(Math.max(target1, Math.min(cwCeiling, rawT2)).toFixed(2)) : rawT2;
        if (target1 > spotPrice && target2 >= target1 && (target1 - spotPrice) / risk >= 1.5 - 1e-6) {
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
      Math.abs(spotPrice - flowSnap.flowVwap) <= entryAtr5m * (latest5mCandle.open >= flowSnap.flowVwap - entryAtr5m * 0.15 ? 1.25 : 0.75) &&
      Math.abs(barBody) <= maxSignalBarBody * (latest5mCandle.open >= flowSnap.flowVwap - entryAtr5m * 0.15 ? 1.35 : 1.0)
    ) {
      const candleStop = Number(
        Math.max(spotPrice + minRiskFloor, Math.max(flowSnap.flowVwap, latest5mCandle.high) + spotPrice * 0.0005).toFixed(2)
      );
      const pwFloor = tacticalPw > 0 && tacticalPw < spotPrice ? tacticalPw : 0;
      const stopLoss = candleStop;
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
        if (target1 < spotPrice && target2 <= target1 && (spotPrice - target1) / risk >= 1.5 - 1e-6) {
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

  // SETUP 2: Support Bounce / Bullish Reversal
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
    etTotalMinutes >= 630 &&
    impChi >= 0.60 &&
    (deltaChi6 >= 0.03 || deltaImpulseChi6 >= 0.06 || deltaFlux6 > 0 || spotPrice >= effectiveFlowVwap || spotPrice >= effectiveSma34) &&
    (deltaFlux6 > 0 || impPe >= 0.40 || spotPrice >= effectiveFlowVwap || spotPrice >= effectiveSma34) &&
    barBody <= maxSignalBarBody &&
    (!isPhase2ReclaimWindow || (isShakeoutRecoveryWindow && leg2CallRoom >= Math.max(2.25, entryMetrics.minWallRoom)) || (testedPutWallOrMinus1Sigma && leg2CallRoom >= entryMetrics.minWallRoom)) &&
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
    etTotalMinutes >= 630 &&
    impChi <= 0.40 &&
    (deltaChi6 <= -0.03 || deltaImpulseChi6 <= -0.06 || deltaFlux6 < 0 || spotPrice <= effectiveFlowVwap || spotPrice <= effectiveSma34) &&
    (deltaFlux6 < 0 || impPe <= -0.40 || spotPrice <= effectiveFlowVwap || spotPrice <= effectiveSma34) &&
    -barBody <= maxSignalBarBody &&
    (!isPhase2ReclaimWindow || (isShakeoutRecoveryWindow && leg2PutRoom >= Math.max(2.25, entryMetrics.minWallRoom)) || (testedCallWallOrPlus1Sigma && leg2PutRoom >= entryMetrics.minWallRoom)) &&
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
  const hasConfirmedAdvectionReclaim = Boolean(
    !isOpeningRange &&
      etTotalMinutes >= 585 &&
      spotPrice > effectiveFlowVwap &&
      spotPrice > effectiveSma34 &&
      impChi >= 0.72 &&
      impPe >= 1.8 &&
      currentNetFlux > 0 &&
      deltaFlux6 >= 0 &&
      barBody > 0 &&
      barBody <= maxSignalBarBody * 1.35
  );
  const isCounterTrendCallBlocked = Boolean(
    !hasBullImpulseReclaim &&
    !hasConfirmedAdvectionReclaim &&
    !hasPositiveGammaPutSweepBounce && (
    (zeroGamma > 0 && spotPrice < zeroGamma) ||
    (flowSnap && typeof flowSnap.flowVwap === "number" && spotPrice < flowSnap.flowVwap) ||
    (latest5mCandle && typeof latest5mCandle.sma34 === "number" && spotPrice < latest5mCandle.sma34) ||
    currentChi < 0.50 ||
    tickerMacroRegime === "PUT" ||
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

    if (target1 > spotPrice && target2 >= target1 && (target1 - spotPrice) / risk >= 1.5 - 1e-6) {
      candidateBto = {
        contractType: "CALL",
        setupName: "Support Bounce / Bullish Reversal",
        stopLossSpot: stopLoss,
        target1Spot: Number(target1.toFixed(2)),
        target2Spot: Number(target2.toFixed(2)),
      };
    }
  }

  // Morning Bullish King Magnet Pull (09:35 - 11:00 ET)
  if (
    !candidateBto &&
    etTotalMinutes >= sessionBounds.entryStartMins &&
    etTotalMinutes <= Math.min(660, sessionBounds.entryCutoffMins) &&
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
    if (target1 > spotPrice && target2 >= target1 && (target1 - spotPrice) / risk >= 1.5 - 1e-6) {
      candidateBto = {
        contractType: "CALL",
        setupName: "King Magnet Trend Pull",
        stopLossSpot: stopLoss,
        target1Spot: target1,
        target2Spot: target2,
      };
    }
  }

  // SETUP 2B: Resistance Rejection / Bearish Reversal
  const prevClosedTrade = lastClosed;
  const tickerClosedHistory = (store.closedPositions || []).filter((p) => p.ticker === normalizedTicker);
  const callClosedCountToday = tickerClosedHistory.filter((p) => p.contractType === "CALL").length;
  const putClosedCountToday = tickerClosedHistory.filter((p) => p.contractType === "PUT").length;
  const isWinningTrendContinuation = Boolean(
    prevClosedTrade &&
      sameTickerClosedCount >= 1 &&
      sameTickerClosedCount < 4 &&
      typeof prevClosedTrade.pnlOptionPct === "number" &&
      prevClosedTrade.pnlOptionPct >= 25 &&
      !/WALL/i.test(prevClosedTrade.exitReason || "") &&
      typeof prevClosedTrade.closedTs === "number" &&
      nowTs - prevClosedTrade.closedTs >= 900 &&
      etTotalMinutes >= 630 &&
      !isPositiveGammaRegime &&
      !(callClosedCountToday >= 1 && putClosedCountToday >= 1) &&
      Math.abs(impPe) >= 1.8 &&
      (prevClosedTrade.contractType === "PUT"
        ? putClosedCountToday < 2 &&
          impChi <= 0.35 &&
          spotPrice < effectiveFlowVwap &&
          spotPrice < effectiveSma34 &&
          (!prevClosedTrade.closedSpotPrice || spotPrice < prevClosedTrade.closedSpotPrice) &&
          (effectiveZeroGamma <= 0 || spotPrice < effectiveZeroGamma)
        : callClosedCountToday < 2 &&
          impChi >= 0.65 &&
          spotPrice > effectiveFlowVwap &&
          spotPrice > effectiveSma34 &&
          (!prevClosedTrade.closedSpotPrice || spotPrice > prevClosedTrade.closedSpotPrice) &&
          (effectiveZeroGamma <= 0 || spotPrice > effectiveZeroGamma))
  );
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

    const isTacticalKingPinningOverhead =
      Boolean(filteredKing && Math.abs(filteredKing - callRejectRef) / spotPrice <= 0.003);

    const isConfirmedBelowSmaWhenPinned =
      !isTacticalKingPinningOverhead ||
      !latest5mCandle ||
      latest5mCandle.close <= latest5mCandle.sma34;

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

      const structuralCeiling = Math.max(callRejectRef, latest5mCandle?.high ?? callRejectRef);
      const stopLoss = Number((structuralCeiling * 1.0012).toFixed(2));
      const risk = Math.max(Math.max(0.05, spotPrice * 0.00033), stopLoss - spotPrice);
      const totalReward2 = Math.max(entryMetrics.minWallRoom, spotPrice - target2);

      const maxTarget1 = spotPrice - risk * 1.5;
      const candidates = [zeroGamma, bookCenter, filteredKing, latest5mCandle?.sma34].filter(
        (v): v is number => typeof v === "number" && v <= maxTarget1 && v > target2
      );
      const target1 =
        candidates.length > 0
          ? Math.max(...candidates)
          : Number(Math.max(target2 + stopWickBuf, Math.min(maxTarget1, spotPrice - totalReward2 * 0.55)).toFixed(2));

      if (target1 < spotPrice && target2 <= target1 && (spotPrice - target1) / risk >= 1.5 - 1e-6) {
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

  // SETUP 3: Zero-Gamma Volatility Breakout
  if (!candidateBto && zeroGamma > 0) {
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
        if (target1 > spotPrice && callWall >= target1 && (target1 - spotPrice) / risk >= 1.5 - 1e-6) {
          candidateBto = {
            contractType: "CALL",
            setupName: "Zero-Gamma Bullish Volatility Breakout",
            stopLossSpot: stopLoss,
            target1Spot: target1,
            target2Spot: Number(Math.max(target1, callWall).toFixed(2)),
          };
        }
      }
    } else if (
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
        if (target1 < spotPrice && tacticalPw <= target1 && (spotPrice - target1) / risk >= 1.5 - 1e-6) {
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

  // SETUP 4: Tactical 0DTE/1DTE or Uncontested King Magnet Pull
  const kingNodeWithZeroDte = kingNode as ({ zeroDteKing?: number; allExpKing?: number; strike?: number; kingStrength: number; isContested: boolean } | null | undefined);
  const tacticalKingStrike =
    filteredKing && filteredKing > 0
      ? filteredKing
      : kingNodeWithZeroDte?.zeroDteKing && kingNodeWithZeroDte.zeroDteKing > 0
        ? kingNodeWithZeroDte.zeroDteKing
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

    const qualifiesMagnet =
      distPct >= 0.0022 &&
      distPct <= 0.011 &&
      (isTacticalMagnet || (kingStrength >= 60 && !isContested));

    if (qualifiesMagnet) {
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
          if (target1 > spotPrice && cwMagnetCap >= target1 && (target1 - spotPrice) / risk >= 1.5 - 1e-6) {
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
      } else if (
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
          if (target1 < spotPrice && pwMagnetCap <= target1 && (spotPrice - target1) / risk >= 1.5 - 1e-6) {
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

  // UNIVERSAL OPEN-SESSION & COUNTER-TREND CALL FIREWALL
  if (candidateBto && candidateBto.contractType === "CALL" && isCounterTrendCallBlocked) {
    console.warn(
      `[FIREWALL] Universally blocked Counter-Trend CALL candidate "${candidateBto.setupName}" at $${spotPrice.toFixed(2)} ` +
      `(OpeningRange: ${isOpeningRange}, χ: ${(currentChi * 100).toFixed(0)}%, ZG: ${zeroGamma}, PriorClose: ${priorCloseRef}).`
    );
    candidateBto = null;
  }

  // SETUP 5: Windowed Impulse Flux & Divergence Reclaim [BTO CALL]
  if (
    !candidateBto &&
    hasBullImpulseReclaim &&
    fluxZScore <= 0.95 &&
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
      if (target1 > spotPrice && target2 >= target1 && (target1 - spotPrice) / risk >= 1.5 - 1e-6) {
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

  // SETUP 5B: Windowed Impulse Flux & Divergence Rejection [BTO PUT]
  if (
    !candidateBto &&
    hasBearImpulseRejection &&
    fluxZScore >= -0.95 &&
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
      if (target1 < spotPrice && target2 <= target1 && (spotPrice - target1) / risk >= 1.5 - 1e-6) {
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

  // Post-Setup Direction Cap (2C / 2P), Same-Direction Continuation Gate & 30m Opposite-Leg Cooldown
  if (candidateBto && sameTickerClosedCount >= 1 && prevClosedTrade) {
    const dirCapHit =
      (candidateBto.contractType === "CALL" && callClosedCountToday >= 2) ||
      (candidateBto.contractType === "PUT" && putClosedCountToday >= 2);
    const sameDirBlocked =
      candidateBto.contractType === prevClosedTrade.contractType &&
      !isShakeoutRecoveryWindow &&
      !isWinningTrendContinuation;
    const oppDirBeforeCooldown =
      candidateBto.contractType !== prevClosedTrade.contractType &&
      (!prevClosedTrade.closedTs ||
        nowTs - prevClosedTrade.closedTs < 1800 ||
        etTotalMinutes < 630);
    if (dirCapHit || sameDirBlocked || oppDirBeforeCooldown) {
      candidateBto = null;
    }
  }

  // Opening Horizon Alignment (09:35-10:00 ET)
  if (candidateBto && etTotalMinutes < 600) {
    const pre1000Check = evaluateOpeningHorizonAlignment({
      etMins: etTotalMinutes,
      direction: candidateBto.contractType,
      spotPrice,
      zeroDteKing:
        filteredKing && filteredKing > 0
          ? filteredKing
          : kingNodeWithZeroDte?.zeroDteKing,
      allExpKing:
        kingNode?.allExpKing && kingNode.allExpKing > 0
          ? kingNode.allExpKing
          : kingNode?.strike,
      bookCenterHistory: store.bookCenterHistoryByTicker?.[normalizedTicker] ?? [],
    });
    if (!pre1000Check.allowed) {
      candidateBto = null;
    }
  }

  // Asymmetric Leg-2 Structural Gating & Anti-Whipsaw Firewall (10:30-cutoff ET, >= 30m cooldown, opposite dir)
  if (
    candidateBto &&
    sameTickerClosedCount >= 1 &&
    lastClosed &&
    !(isShakeoutRecoveryWindow && candidateBto.contractType === lastClosed.contractType) &&
    !(isWinningTrendContinuation && candidateBto.contractType === lastClosed.contractType)
  ) {
    const effectiveDeltaChi6 =
      deltaChi6 !== 0
        ? deltaChi6
        : deltaImpulseChi6 !== 0
          ? deltaImpulseChi6
          : deltaFlux6 > 0
            ? 0.04
            : deltaFlux6 < 0
              ? -0.04
              : 0;
    const leg2Gate = evaluateLeg2StructuralGate({
      direction: candidateBto.contractType,
      etMins: etTotalMinutes,
      nowTsSec: nowTs,
      spotPrice,
      prevSpotPrice,
      zeroGamma: effectiveZeroGamma,
      flowVwap: effectiveFlowVwap,
      sma34: effectiveSma34,
      leg1Trade: {
        contractType: lastClosed.contractType,
        closedTs: lastClosed.closedTs,
        btoSpotPrice: lastClosed.btoSpotPrice,
        closedSpotPrice: lastClosed.closedSpotPrice,
        pnlOptionPct: lastClosed.pnlOptionPct,
        exitReason: lastClosed.exitReason,
      },
      testedPutWallOrMinus1Sigma,
      testedCallWallOrPlus1Sigma,
      has5mBullDiv: divergence5m === "BULL",
      has5mBearDiv: divergence5m === "BEAR",
      impulseChi: impChi,
      deltaChi6Bar: effectiveDeltaChi6,
      impulsePeclet: impPe,
      ceilingShareChi: currentChi,
      netFluxJ: currentNetFlux,
    });
    const requiredLeg2Room = isShakeoutRecoveryWindow
      ? Math.max(2.25, entryMetrics.minWallRoom)
      : entryMetrics.minWallRoom;
    const minLeg2RoomOk =
      candidateBto.contractType === "CALL"
        ? leg2CallRoom >= requiredLeg2Room
        : leg2PutRoom >= requiredLeg2Room;
    if (!leg2Gate.allowed || !minLeg2RoomOk) {
      candidateBto = null;
    }
  }

  // Persist Put Wall bounce memory (>= 0.15% touch + bounce above Put Wall) on DailyTradeStore
  const barLowForWall = latest5mCandle ? Math.min(latest5mCandle.low, spotPrice) : spotPrice;
  const barHighForResist = latest5mCandle ? Math.max(latest5mCandle.high, spotPrice) : spotPrice;
  if (
    opposingPutWall > 0 &&
    barLowForWall <= opposingPutWall * 1.0015 &&
    spotPrice > opposingPutWall
  ) {
    store.bouncedPutWalls = {
      ...(store.bouncedPutWalls || {}),
      [normalizedTicker]: opposingPutWall,
    };
  }

  if (candidateBto) {
    const isExplicitReversionOrBounceSetup =
      /Flow Bounce|Flow Rejection|Support Bounce|Resistance Rejection|Extremity Reclaim|Zero-Gamma Flip/i.test(
        candidateBto.setupName
      );
    const isFreshVwapPolarityFlip = Boolean(
      latest5mCandle &&
        flowSnap &&
        flowSnap.flowVwap > 0 &&
        (candidateBto.contractType === "PUT"
          ? latest5mCandle.open >= flowSnap.flowVwap - entryAtr5m * 0.15 && latest5mCandle.close < flowSnap.flowVwap
          : latest5mCandle.open <= flowSnap.flowVwap + entryAtr5m * 0.15 && latest5mCandle.close > flowSnap.flowVwap)
    );
    const maxVwapStretchMult = isFreshVwapPolarityFlip ? 1.25 : 0.90;
    const vwapStretchOverExtended =
      !isExplicitReversionOrBounceSetup &&
      flowSnap &&
      flowSnap.flowVwap > 0 &&
      Math.abs(spotPrice - flowSnap.flowVwap) > entryAtr5m * maxVwapStretchMult;
    if (vwapStretchOverExtended) {
      candidateBto = null;
    }
  }

  if (candidateBto) {
    const candRisk = Math.max(minRiskFloor, Math.abs(spotPrice - candidateBto.stopLossSpot));
    if (candidateBto.contractType === "PUT") {
      // Strict Flux Polarity Gate: block neutral chop (0.44 < chi < 0.56) and opposing J_net / Pe
      const fluxBearAligned = currentChi <= 0.44 && currentNetFlux < 0 && currentPe < 0;
      // Dynamic Opposing-Wall Clearance (>= max(2.25, 0.32% spot) AND >= 2.0R) or decisive close below PW
      const putWallClearanceOk =
        opposingPutWall <= 0 ||
        hasDecisivePutBreakdown ||
        (spotPrice - opposingPutWall >= minOpposingWallClearance &&
          (spotPrice - opposingPutWall) / candRisk >= 2.0);
      // Post-Put-Wall-Bounce Mid-Range Block (unless rejecting upper resistance or breaking below PW)
      const bouncedPw = store.bouncedPutWalls?.[normalizedTicker];
      const bouncedPutWallRecently =
        typeof bouncedPw === "number" &&
        bouncedPw > 0 &&
        Math.abs(bouncedPw - opposingPutWall) <= Math.max(0.5, opposingPutWall * 0.002);
      const isRejectingUpperResist = [effectiveZeroGamma, opposingCallWall, flowSnap?.upper1Sigma].some(
        (lvl) => typeof lvl === "number" && lvl > opposingPutWall && barHighForResist >= lvl * 0.9965
      );
      const postBouncePutBlocked =
        bouncedPutWallRecently &&
        opposingPutWall > 0 &&
        spotPrice >= opposingPutWall &&
        !isRejectingUpperResist;
      if (!fluxBearAligned || !putWallClearanceOk || postBouncePutBlocked) {
        candidateBto = null;
      }
    } else {
      const fluxBullAligned = currentChi >= 0.56 && currentNetFlux > 0 && currentPe > 0;
      const callWallClearanceOk =
        opposingCallWall <= 0 ||
        hasDecisiveCallBreakout ||
        (opposingCallWall - spotPrice >= minOpposingWallClearance &&
          (opposingCallWall - spotPrice) / candRisk >= 2.0);
      if (!fluxBullAligned || !callWallClearanceOk) {
        candidateBto = null;
      }
    }
  }

  if (candidateBto) {
    const snapWithBand2 = flowSnap as (FlowGammaVwapSnapshot & {
      upperBand2?: number;
      lowerBand2?: number;
    }) | null;
    const upperBand2 =
      typeof snapWithBand2?.upperBand2 === "number" &&
      Number.isFinite(snapWithBand2.upperBand2) &&
      snapWithBand2.upperBand2 > 0
        ? snapWithBand2.upperBand2
        : typeof flowSnap?.upper2Sigma === "number" &&
            Number.isFinite(flowSnap.upper2Sigma) &&
            flowSnap.upper2Sigma > 0
          ? flowSnap.upper2Sigma
          : typeof flowSnap?.upper2s === "number" &&
              Number.isFinite(flowSnap.upper2s) &&
              flowSnap.upper2s > 0
            ? flowSnap.upper2s
            : 0;
    const lowerBand2 =
      typeof snapWithBand2?.lowerBand2 === "number" &&
      Number.isFinite(snapWithBand2.lowerBand2) &&
      snapWithBand2.lowerBand2 > 0
        ? snapWithBand2.lowerBand2
        : typeof flowSnap?.lower2Sigma === "number" &&
            Number.isFinite(flowSnap.lower2Sigma) &&
            flowSnap.lower2Sigma > 0
          ? flowSnap.lower2Sigma
          : typeof flowSnap?.lower2s === "number" &&
              Number.isFinite(flowSnap.lower2s) &&
              flowSnap.lower2s > 0
            ? flowSnap.lower2s
            : 0;

    const remainingMins = Math.max(15, sessionBounds.rthCloseMins - etTotalMinutes);
    const baseDailyEm =
      dailyExpectedMove && dailyExpectedMove.high > dailyExpectedMove.low
        ? (dailyExpectedMove.high - dailyExpectedMove.low) / 2
        : spotPrice * 0.012;
    const emRemaining = baseDailyEm * Math.sqrt(remainingMins / 390);
    const minT1AtrDist = Math.max(entryAtr5m, spotPrice * 0.0005);
    const setupRiskDist = Math.max(minRiskFloor, Math.abs(spotPrice - candidateBto.stopLossSpot));
    const minT1RiskDist = Math.max(minT1AtrDist, setupRiskDist * 1.52);

    if (candidateBto.contractType === "CALL") {
      const isCallWallFar = tacticalCw <= spotPrice || tacticalCw - spotPrice > 1.5 * entryAtr5m;
      if (isCallWallFar && upperBand2 > spotPrice + minT1RiskDist) {
        candidateBto.target1Spot = Number(Math.min(candidateBto.target1Spot, upperBand2).toFixed(2));
      }
      const emCappedT1 = spotPrice + Math.max(minT1RiskDist, emRemaining * 0.65);
      const emCappedT2 = spotPrice + Math.max(minT1RiskDist * 1.25, emRemaining);
      const wallCap = tacticalCw > spotPrice ? tacticalCw : Number.POSITIVE_INFINITY;
      const boundedT1 = Math.min(
        wallCap,
        Math.max(
          Math.min(wallCap, spotPrice + minT1RiskDist),
          Math.min(candidateBto.target1Spot, emCappedT1)
        )
      );
      candidateBto.target1Spot = Number(boundedT1.toFixed(2));
      candidateBto.target2Spot = Number(
        Math.max(candidateBto.target1Spot, Math.min(wallCap, candidateBto.target2Spot, emCappedT2)).toFixed(2)
      );
    } else {
      const isPutWallFar =
        tacticalPw <= 0 || tacticalPw >= spotPrice || spotPrice - tacticalPw > 1.5 * entryAtr5m;
      if (isPutWallFar && lowerBand2 > 0 && lowerBand2 < spotPrice - minT1RiskDist) {
        candidateBto.target1Spot = Number(Math.max(candidateBto.target1Spot, lowerBand2).toFixed(2));
      }
      const emCappedT1 = spotPrice - Math.max(minT1RiskDist, emRemaining * 0.65);
      const emCappedT2 = spotPrice - Math.max(minT1RiskDist * 1.25, emRemaining);
      const wallFloor = tacticalPw > 0 && tacticalPw < spotPrice ? tacticalPw : 0;
      const boundedT1 = Math.max(
        wallFloor,
        Math.min(
          Math.max(wallFloor, spotPrice - minT1RiskDist),
          Math.max(candidateBto.target1Spot, emCappedT1)
        )
      );
      candidateBto.target1Spot = Number(boundedT1.toFixed(2));
      candidateBto.target2Spot = Number(
        Math.min(candidateBto.target1Spot, Math.max(wallFloor, candidateBto.target2Spot, emCappedT2)).toFixed(2)
      );
    }
  }

  return {
    candidateBto,
    tacticalCw,
    tacticalPw,
    effectiveZeroGamma,
    effectiveFlowVwap,
    effectiveSma34,
    tacticalBookCenter,
    resolvedNetGex,
    flowSnap,
    entryMetrics,
    entryAtr5m,
  };
}
