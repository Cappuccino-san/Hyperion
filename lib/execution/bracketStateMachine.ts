import { computeAdaptiveQuantMetrics } from "@/lib/gaiaSignalFsm";
import {
  capExitTsToEodFlat,
  etMinutesOfDay,
  getSessionBoundsEt,
} from "@/lib/gaiaSessionGuards";
import { evaluateOptionRiskStop, STALL_STOP_MINUTES } from "@/lib/bracketOrderEngine";
import { evaluateOptionProfitRatchet } from "@/lib/execution/profitRatchet";
import type { NormalizedOptionContract } from "@/lib/optionsExposure";
import type {
  Candle5m,
  DailyTradeStore,
  DivergenceDirection,
  OptionTradePosition,
  TradeLifecycleAlert,
} from "@/lib/execution/types";
import {
  clampOptionPriceToGreekEnvelope,
  clampToCandleRange,
  computeRemainingYearsToExpiration,
  formatTimeEt,
  getContractMidPrice,
  repriceOptionBS,
  solveImpliedVol,
} from "@/lib/execution/optionPricing";

function computeDteDays(expIso: string, sessionIso: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expIso) || !/^\d{4}-\d{2}-\d{2}$/.test(sessionIso)) return 0;
  const [ey, em, ed] = expIso.split("-").map(Number);
  const [sy, sm, sd] = sessionIso.split("-").map(Number);
  const expMs = Date.UTC(ey, em - 1, ed, 16, 0, 0);
  const sesMs = Date.UTC(sy, sm - 1, sd, 16, 0, 0);
  return Math.max(0, Math.round((expMs - sesMs) / 86_400_000));
}

export function evaluateActivePositionStepA(input: {
  activePos: OptionTradePosition;
  normalizedTicker: string;
  positionKey: string;
  isSpxw: boolean;
  spotPrice: number;
  putWall: number;
  latest5mCandle: Candle5m | null;
  divergence5m: DivergenceDirection | null;
  contracts?: NormalizedOptionContract[] | null;
  nowTs: number;
  timeStr: string;
  etHours: number;
  etMinutes: number;
  etTotalMinutes: number;
  sessionDate: string;
  isHistoricalBackfill?: boolean;
  store: DailyTradeStore;
  emittedAlerts: TradeLifecycleAlert[];
}): OptionTradePosition | null {
  const {
    normalizedTicker,
    positionKey,
    isSpxw,
    spotPrice,
    putWall,
    latest5mCandle,
    divergence5m,
    contracts,
    nowTs,
    timeStr,
    etHours,
    etMinutes,
    etTotalMinutes,
    sessionDate,
    isHistoricalBackfill,
    store,
    emittedAlerts,
  } = input;

  let activePos: OptionTradePosition | null = input.activePos;
  const sessionBounds = getSessionBoundsEt(sessionDate);
  const isEodCutoff = etTotalMinutes >= sessionBounds.eodFlatMins;

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
  const posPutWall = isPosSpyScaled && putWall > 0 ? Number((putWall / 10).toFixed(2)) : putWall;

  let currentOptionMid: number = activePos.btoOptionMid;
  let liveBid: number | undefined = activePos.optionBid;
  let liveAsk: number | undefined = activePos.optionAsk;

  let matchedContract = false;
  if (contracts && contracts.length > 0) {
    const match = contracts.find(
      (c) =>
        c.strike === activePos?.strike &&
        c.optionType === (isCall ? "C" : "P") &&
        c.expiration === activePos?.expiration
    );
    if (match) {
      matchedContract = true;
      const liveMid = getContractMidPrice(match);
      if (liveMid > 0) currentOptionMid = liveMid;
      if (match.bid && match.bid > 0) liveBid = match.bid;
      if (match.ask && match.ask > 0) liveAsk = match.ask;
    }
  }
  if (!matchedContract && activePos.strike > 0 && nowTs > (activePos.openedTs || nowTs)) {
    const dte = computeDteDays(activePos.expiration, sessionDate);
    const tRemaining = computeRemainingYearsToExpiration(nowTs * 1000, dte);
    const tEntry =
      typeof activePos.entryTYears === "number" && activePos.entryTYears > 0
        ? activePos.entryTYears
        : computeRemainingYearsToExpiration((activePos.openedTs || nowTs) * 1000, dte);
    const entryAskRef = activePos.optionAsk || activePos.btoOptionMid || 0.45;
    const anchorIv =
      typeof activePos.entryIv === "number" && activePos.entryIv >= 0.04
        ? activePos.entryIv
        : solveImpliedVol(entryAskRef, activePos.btoSpotPrice, activePos.strike, tEntry, isCall);
    const bsEntryCheck = repriceOptionBS(activePos.btoSpotPrice, activePos.strike, tEntry, anchorIv, isCall);
    const effectiveIv =
      Math.abs(bsEntryCheck - entryAskRef) > entryAskRef * 0.15
        ? solveImpliedVol(entryAskRef, activePos.btoSpotPrice, activePos.strike, tEntry, isCall)
        : anchorIv;
    const bsMid = repriceOptionBS(posSpotPrice, activePos.strike, tRemaining, effectiveIv, isCall);
    currentOptionMid = bsMid;
    liveBid = Math.max(0.01, Number((bsMid - 0.01).toFixed(2)));
    liveAsk = Number(Math.max(liveBid + 0.01, bsMid + 0.01).toFixed(2));
  }

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
  // Strict pessimistic ordering: evaluate existing standing stops/ratchets against prior-bar peak (< t)
  // BEFORE updating peakOptionPnlPct from the current bar/tick.
  const prevPeakOptionPnlPct = activePos.peakOptionPnlPct ?? 0;
  const optStopEval = evaluateOptionRiskStop({
    entryPrice: entryFillPrice,
    currentPrice: exitFillPrice,
    heldMinutes: rawHeldMin,
    peakPnlPct: prevPeakOptionPnlPct,
  });

  const closePosition = (reason: string) => {
    const needsCap =
      isEodCutoff ||
      etTotalMinutes >= sessionBounds.rthCloseMins ||
      etTotalMinutes < sessionBounds.rthOpenMins;
    const cappedTs = needsCap ? capExitTsToEodFlat(nowTs, sessionDate).ts : nowTs;
    const exitTimeStr = needsCap ? formatTimeEt(cappedTs) : timeStr;

    activePos!.status = "CLOSED";
    activePos!.remainingQty = 0;
    activePos!.closedAt = exitTimeStr;
    activePos!.closedTs = cappedTs;
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
    const stcAlertId = `${activePos!.id}-stc`;
    const alignedExitBid = clampedExitFill;
    const alignedExitAsk = Number(
      Math.max(
        clampedExitFill + 0.01,
        typeof liveAsk === "number" &&
          typeof liveBid === "number" &&
          liveBid > 0 &&
          liveAsk >= liveBid &&
          Math.abs(liveBid - clampedExitFill) <= Math.max(0.15, clampedExitFill * 0.25)
          ? liveAsk
          : clampedExitFill + 0.02
      ).toFixed(2)
    );
    const alert: TradeLifecycleAlert = {
      id: stcAlertId,
      timestamp: exitTimeStr,
      ts: cappedTs,
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
      optionBid: alignedExitBid,
      optionAsk: alignedExitAsk,
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
      isHistoricalBackfill: Boolean(isHistoricalBackfill || activePos!.originBackfill),
      eventId: stcAlertId,
      message: msg,
    };

    emittedAlerts.push(alert);
    store.alerts.push(alert);
    store.closedPositions.unshift(activePos!);
    delete store.activePositions[normalizedTicker];
    delete store.activePositions[positionKey];
    activePos = null;
  };

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
  const isNewBarAfterEntry =
    Boolean(posCandle) &&
    ((curBarTs > 0 && curBarTs > (activePos.lastCandleTs ?? 0)) ||
      (!activePos.lastCandleTs && nowTs > (activePos.openedTs || nowTs)));
  const barFavorableSpot =
    isNewBarAfterEntry && posCandle
      ? isCall
        ? Math.max(posSpotPrice, posCandle.high)
        : Math.min(posSpotPrice, posCandle.low)
      : posSpotPrice;
  const barFavSpotMfePct =
    activePos.btoSpotPrice > 0
      ? ((isCall
          ? barFavorableSpot - activePos.btoSpotPrice
          : activePos.btoSpotPrice - barFavorableSpot) /
          activePos.btoSpotPrice) *
        100
      : 0;
  activePos.peakFavorableSpotMfePct = Number(
    Math.max(activePos.peakFavorableSpotMfePct ?? 0, barFavSpotMfePct).toFixed(4)
  );

  const hasNetFlux =
    typeof flowSnapExit?.netFluxJ === "number" && Number.isFinite(flowSnapExit.netFluxJ);
  const hasPeclet =
    typeof flowSnapExit?.pecletNumber === "number" && Number.isFinite(flowSnapExit.pecletNumber);
  const fluxFlippedAgainst = isCall
    ? (hasNetFlux && flowSnapExit!.netFluxJ! < 0) ||
      ((!hasNetFlux || flowSnapExit!.netFluxJ === 0) && hasPeclet && flowSnapExit!.pecletNumber! < 0)
    : (hasNetFlux && flowSnapExit!.netFluxJ! > 0) ||
      ((!hasNetFlux || flowSnapExit!.netFluxJ === 0) && hasPeclet && flowSnapExit!.pecletNumber! > 0);
  const hasPostEntryBarElapsed = nowTs > (activePos.openedTs || 0) || isNewBarAfterEntry;

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

  const isMorningWindowTimeStop =
    rawHeldMin >= 10 &&
    resolvedOpenedEtMins >= sessionBounds.rthOpenMins &&
    resolvedOpenedEtMins < 615 &&
    ((etHours === 10 && etMinutes >= 45) || etHours === 11);
  const isElapsedChopTimeStop = rawHeldMin >= 30 && rawHeldMin <= 90;

  // Strict pessimistic evaluation of progressive option-% profit ratchet (+30%->BE, +60%->+25%, +100%->trail)
  // and Flux-Flip MFE Harvest (>= +50% MFE + confirmed netFluxJ flip) BEFORE raising peakOptionPnlPct.
  const ratchetEval = evaluateOptionProfitRatchet({
    isCall,
    prevPeakOptionPnlPct,
    adverseOptionPnlPct: pnlOptionPct,
    closeOptionPnlPct: pnlOptionPct,
    favorableOptionPnlPct: pnlOptionPct,
    openOptionPnlPct: pnlOptionPct,
    chi: exitChi,
    netFluxJ: exitFlux,
    hasPostEntryBarElapsed,
    fluxFlippedAgainst,
  });
  activePos.peakOptionPnlPct = ratchetEval.nextPeakOptionPnlPct;

  // 1. STC (15:55 PM ET HARD CUTOFF / 12:55 PM EARLY CLOSE)
  if (isEodCutoff) {
    closePosition(
      sessionBounds.isEarlyClose
        ? "12:55 PM ET HARD EARLY-CLOSE MARKET CUTOFF"
        : "15:55 PM ET HARD MARKET CLOSE CUTOFF"
    );
  }
  // 1B. STC: BOUNDARY_FLUX_REVERSAL_LOCK (>= +0.20% favorable spot MFE + boundary flux flip against position)
  else if (
    hasPostEntryBarElapsed &&
    (activePos.peakFavorableSpotMfePct ?? 0) >= 0.20 &&
    fluxFlippedAgainst
  ) {
    closePosition("BOUNDARY_FLUX_REVERSAL_LOCK");
  }
  // 1C. STC: PROGRESSIVE OPTION-% PROFIT RATCHET / FLUX-FLIP MFE HARVEST
  else if (ratchetEval.triggered && ratchetEval.reason) {
    closePosition(ratchetEval.reason);
  }
  // 2. STC: MORNING / ELAPSED CHOP TIME STOP
  else if (
    activePos.status === "OPEN" &&
    (isMorningWindowTimeStop || isElapsedChopTimeStop) &&
    pnlOptionPct >= 10 &&
    pnlOptionPct < 25 &&
    ((isCall && posCandle && posCandle.close < posCandle.sma34) ||
      (!isCall && posCandle && posCandle.close > posCandle.sma34))
  ) {
    closePosition(
      isMorningWindowTimeStop
        ? "10:45 AM MOMENTUM CUTOFF (PROTECT PROFITS / AVOID MIDDAY CHOP)"
        : "ELAPSED CHOP TIME-STOP (30-90M PROFIT PROTECTION)"
    );
  }
  // 3. STC (MOMENTUM REVERSAL / DIVERGENCE COVER)
  else if (
    activePos.status === "OPEN" &&
    !(isRunnerSetup && solidFluxAligned) &&
    rawHeldMin >= 10 &&
    pnlOptionPct >= 10 &&
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
  // 4. STC (TARGET 2 HIT)
  else if (
    !activePos.setupName.includes("Bearish Zero-Gamma Flush") &&
    ((isCall && posSpotPrice >= activePos.target2Spot) ||
      (!isCall && posSpotPrice <= activePos.target2Spot) ||
      pnlOptionPct >= (activePos.tp2Pct || 50))
  ) {
    closePosition("TARGET 2 HIT · FULL PROFIT EXIT");
  }
  // 5. STC (TARGET 1 HIT · 1 CONTRACT SNIPER FULL EXIT)
  else if (
    activePos.status === "OPEN" &&
    !(isRunnerSetup && solidFluxAligned) &&
    !activePos.setupName.includes("Bearish Zero-Gamma Flush") &&
    ((isCall && posSpotPrice >= activePos.target1Spot) ||
      (!isCall && posSpotPrice <= activePos.target1Spot) ||
      pnlOptionPct >= (activePos.tp1Pct || 25))
  ) {
    closePosition("TARGET 1 HIT · FULL PROFIT EXIT (1 CONTRACT)");
  }
  // 6. STC (STOP LOSS / LEVEL INVALIDATION / OPTION -45% HARD STOP OR 75M -38% STALL STOP)
  else if (
    (isCall && (posCandle ? posCandle.close : posSpotPrice) <= activePos.stopLossSpot) ||
    (!isCall && (posCandle ? posCandle.close : posSpotPrice) >= activePos.stopLossSpot) ||
    optStopEval.triggered
  ) {
    const closeRefSpot = posCandle ? posCandle.close : posSpotPrice;
    const isBreakeven =
      activePos.status === "PARTIAL_TP1" ||
      Math.abs(activePos.stopLossSpot - activePos.btoSpotPrice) < 0.02;
    const isTrailingProfit =
      pnlOptionPct > 0 &&
      ((isCall && activePos.stopLossSpot > activePos.btoSpotPrice + 0.01 && closeRefSpot > activePos.btoSpotPrice) ||
       (!isCall && activePos.stopLossSpot < activePos.btoSpotPrice - 0.01 && closeRefSpot < activePos.btoSpotPrice));
    const isOptionHardStop = !isBreakeven && !isTrailingProfit && optStopEval.triggered;
    const reason = isTrailingProfit
      ? "TRAILING PROFIT LOCKED"
      : isBreakeven
        ? "BREAKEVEN STOP HIT"
        : isOptionHardStop
          ? optStopEval.reason === "OPTION_STALL_STOP_25"
            ? `OPTION STALL STOP HIT (-${optStopEval.activeStopLossPct}% ${STALL_STOP_MINUTES}M THETA CAP)`
            : "OPTION HARD STOP HIT (-45% MAX LOSS)"
          : "STOP LOSS / LEVEL INVALIDATION";
    closePosition(reason);
  }

  return activePos;
}
