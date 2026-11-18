import {
  computeOptionsAnalytics,
  deriveTacticalStructuralLevels,
  type NormalizedOptionContract,
} from "@/lib/optionsExposure";
import { computeBarFlowGammaVwapSeries, type StructuralFlowNodes } from "@/lib/flowGammaVwap";
import {
  classifyMarketRegime,
  LEG1_MIN_EXPECTANCY_R,
  LEG2_MIN_EXPECTANCY_R,
  scoreSetupExpectancy,
} from "@/lib/alphaScorer";
import { getSessionBoundsEt, getTodayEt } from "@/lib/gaiaSessionGuards";
import { readAlphaPriorsSync } from "@/lib/persistenceStore";
import {
  type ContractType,
  type DailyTradeStore,
  type OptionTradePosition,
  type TradeEvaluationParams,
  type TradeEvaluationResult,
  type TradeLifecycleAlert,
  isSupportedTradeTicker,
} from "@/lib/execution/types";
import {
  clampToCandleRange,
  fetchLive5mCandleAndDivergence,
  fetchLiveCboeOptions,
  formatEtIsoDate,
  formatTimeEt,
  getCachedSpotPrice,
  getContractMidPrice,
  getNowEtTime,
} from "@/lib/execution/optionPricing";
import { selectSmallAccountContract } from "@/lib/execution/contractRouter";
import {
  calibrateWalkForwardExpectancy,
  evaluateBtoCandidateSetup,
} from "@/lib/execution/signalScoring";
import { evaluateActivePositionStepA } from "@/lib/execution/bracketStateMachine";
import {
  loadTradeStore,
  purgeZombieToClosed,
  saveTradeStore,
} from "@/lib/execution/ledgerCommit";
import {
  flushPendingDiscordAlerts,
  isAlertDispatchEligible,
  sendDiscordTradeAlert,
} from "@/lib/execution/discordGateway";

export { getTodayEt };
export * from "@/lib/execution/types";
export {
  solveImpliedVol,
  repriceOptionBS,
  formatEtIsoDate,
  formatTimeEt,
  getNowEtTime,
  getContractMidPrice,
  computeRemainingYearsToExpiration,
  estimateDynamicAtmIv,
  priceOptionWithSkew,
  reanchorDelayedContractsToSpot,
  clampOptionPriceToGreekEnvelope,
  clampToCandleRange,
  getCachedSpotPrice,
  fetchLiveCboeOptions,
  fetchLive5mCandleAndDivergence,
} from "@/lib/execution/optionPricing";
export {
  formatExpirationHuman,
  selectSmallAccountContract,
  selectOptimalContract,
} from "@/lib/execution/contractRouter";
export {
  calibrateWalkForwardExpectancy,
  computeUnifiedSniperFeatures,
  evaluateUnifiedSniperSetup,
} from "@/lib/execution/signalScoring";
export {
  loadTradeStore,
  saveTradeStore,
  getActivePositions,
  getClosedPositions,
  getDailyTradeAlerts,
  clearDailyTrades,
  purgeZombieToClosed,
} from "@/lib/execution/ledgerCommit";
export {
  sendDiscordTradeAlert,
  isAlertDispatchEligible,
  flushPendingDiscordAlerts,
  syncGaiaTickerSignalsToDiscord,
  syncGaiaSpySignalsToDiscord,
} from "@/lib/execution/discordGateway";
export * from "./tradePerformanceEngine";

/**
 * Backfills today's RTH 5m bars from Yahoo Finance when the server boots mid-session,
 * ensuring exact causal replay without emitting live Discord alerts (`isHistoricalBackfill: true`).
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

    const todayEt = getTodayEt();
    const sessionBounds = getSessionBoundsEt(todayEt);
    const latestSessionDate = allValid[allValid.length - 1]?.dateEt;
    if (!latestSessionDate || latestSessionDate !== todayEt) return false;

    const sessionBars = allValid.filter(
      (b) =>
        b.dateEt === latestSessionDate &&
        b.totalMinutes >= sessionBounds.rthOpenMins &&
        b.totalMinutes <= sessionBounds.eodFlatMins
    );
    if (sessionBars.length < 3) return false;

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

    const resetBounceStore = loadTradeStore();
    if (resetBounceStore.bouncedPutWalls && Object.keys(resetBounceStore.bouncedPutWalls).length > 0) {
      resetBounceStore.bouncedPutWalls = {};
      saveTradeStore(resetBounceStore);
    }

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

      let evalSpot = bar.close;
      if (openPos) {
        if (openPos.contractType === "CALL") {
          if (barClosePos <= openPos.stopLossSpot) {
            evalSpot = bar.close;
          } else if (barHighPos >= openPos.target1Spot) {
            evalSpot =
              barHighPos >= openPos.target2Spot
                ? bar.high
                : Math.max(bar.close, Number((openPos.target1Spot * posScale).toFixed(2)));
          }
        } else {
          if (barClosePos >= openPos.stopLossSpot) {
            evalSpot = bar.close;
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

      const barContracts: NormalizedOptionContract[] = baseContracts.map((c) => {
        const isCallOpt = c.optionType === "C";
        const distOtm = isCallOpt ? c.strike - refSpotForChain : refSpotForChain - c.strike;
        const distOtmPct = distOtm / Math.max(1, refSpotForChain);
        const distOtmSpyScaled = (Math.max(0, distOtm) / Math.max(1, refSpotForChain)) * 750;
        const estDelta = Number(
          Math.max(0.20, Math.min(0.45, 0.42 * Math.exp(-0.18 * distOtmSpyScaled))).toFixed(2)
        );
        const sign = isCallOpt ? 1 : -1;

        let bid = c.bid ?? 0;
        let ask = c.ask ?? 0;
        let last = c.last ?? 0;

        if (
          openPos &&
          c.strike === openPos.strike &&
          c.expiration === openPos.expiration &&
          isCallOpt === (openPos.contractType === "CALL")
        ) {
          const entryRef = openPos.btoSpotPrice;
          const moveFromEntry = (refSpotForChain - entryRef) * sign;
          const baseEntryAsk = openPos.optionAsk || openPos.btoOptionMid || 0.45;
          const curEstMid = Math.max(0.05, Number((baseEntryAsk + moveFromEntry * 0.22).toFixed(2)));
          bid = Math.max(0.04, Number((curEstMid - 0.01).toFixed(2)));
          ask = Number((curEstMid + 0.01).toFixed(2));
          last = curEstMid;
        } else {
          const rawMid = getContractMidPrice(c);
          const shiftedMid = rawMid > 0 ? rawMid + dSpot * estDelta * sign : 0;
          if (shiftedMid >= 0.20 && shiftedMid <= 0.95) {
            bid = Number(Math.max(0.18, shiftedMid - 0.02).toFixed(2));
            ask = Number(Math.min(0.98, shiftedMid + 0.02).toFixed(2));
            last = Number(shiftedMid.toFixed(2));
          } else if (distOtmPct >= -0.001 && distOtmPct <= 0.006) {
            const modelMid = Number(
              Math.max(0.26, Math.min(0.78, 0.72 * Math.exp(-0.22 * distOtmSpyScaled))).toFixed(2)
            );
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

      const dropFromBtoPct = openPos ? (openPos.btoSpotPrice - sliceLowPos) / Math.max(1, openPos.btoSpotPrice) : 0;
      const bounceFromLowPct = (barClosePos - sliceLowPos) / Math.max(1, sliceLowPos);
      const isPostFlushBullReversal =
        Boolean(openPos && openPos.contractType === "PUT") &&
        bar.totalMinutes >= 630 &&
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
        dataSource: "BACKFILL",
        contractsAlreadyAnchored: true,
        nowEt: barDate,
        isHistoricalBackfill: true,
      });
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Main Evaluation Engine Orchestrator:
 * - Step A: Evaluates active STC exit & progressive ratchet rules via bracketStateMachine.
 * - Step B: Evaluates BTO setups via signalScoring, empirical expectancy gates, and
 *           second-order Taylor contract routing via contractRouter.
 * - Enforces RTH entry windows, early-close bounds, MOC cutoff, single-slot lock,
 *   and fail-closed Discord dispatch firewall.
 */
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

  const preFetchDate = params.nowEt ?? new Date();
  const preFetchSessionDate = formatEtIsoDate(preFetchDate);
  const preFetchBounds = getSessionBoundsEt(preFetchSessionDate);
  const preFetchEt = getNowEtTime(preFetchDate);
  const hasStoredPos = Boolean(store.activePositions[normalizedTicker] || store.activePositions[positionKey]);
  if (preFetchEt.totalMinutes >= preFetchBounds.rthCloseMins && !hasStoredPos) {
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

  let latest5mCandle = params.latest5mCandle ?? null;
  let divergence5m = params.divergence5m ?? null;
  let divergence30m = params.divergence30m ?? null;

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
        if (!params.allExpKing && analytics.kingNode?.allExpKing) {
          params.allExpKing = analytics.kingNode.allExpKing;
        }
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
  const sessionDate = formatEtIsoDate(now);
  const sessionBounds = getSessionBoundsEt(sessionDate);

  let activePos: OptionTradePosition | null =
    store.activePositions[normalizedTicker] ?? store.activePositions[positionKey] ?? null;
  const closedForTickerEarly = store.closedPositions.filter(
    (p) => p.ticker === positionKey || p.ticker === normalizedTicker
  );

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
    etTime.totalMinutes <= sessionBounds.entryCutoffMins;

  if ((closedForTickerEarly.length >= 2 || (closedForTickerEarly.length >= 1 && !canTryPhase2Reclaim)) && !activePos) {
    return {
      ticker: normalizedTicker,
      activePosition: null,
      emittedAlerts: [],
      allAlerts: store.alerts,
    };
  }

  if (etTime.totalMinutes >= sessionBounds.rthCloseMins && !activePos) {
    return {
      ticker: normalizedTicker,
      activePosition: null,
      emittedAlerts: [],
      allAlerts: store.alerts,
    };
  }

  const isEodCutoff = etTime.totalMinutes >= sessionBounds.eodFlatMins;
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

  // STEP A: Active STC exits & progressive ratchets
  if (activePos && (activePos.status === "OPEN" || activePos.status === "PARTIAL_TP1")) {
    activePos = evaluateActivePositionStepA({
      activePos,
      normalizedTicker,
      positionKey,
      isSpxw,
      spotPrice,
      putWall: params.putWall,
      latest5mCandle,
      divergence5m,
      contracts: params.contracts,
      nowTs,
      timeStr,
      etHours: etTime.hours,
      etMinutes: etTime.minutes,
      etTotalMinutes: etTime.totalMinutes,
      sessionDate,
      isHistoricalBackfill: params.isHistoricalBackfill,
      store,
      emittedAlerts,
    });
  }
  if (hadActivePositionAtStart) {
    saveTradeStore(store);
  }

  // STEP B: BTO entry rules
  const positionTickerForCheck = positionKey;
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
    etTime.totalMinutes <= sessionBounds.entryCutoffMins;
  const hasCompletedTradeToday =
    sameTickerClosed.length >= 2 || (sameTickerClosed.length >= 1 && !isPhase2ReclaimWindow);
  const hasActiveTrade = Boolean(
    activePos ||
      hadActivePositionAtStart ||
      store.activePositions[positionTickerForCheck] ||
      store.activePositions[normalizedTicker] ||
      Object.keys(store.activePositions || {}).length > 0
  );

  const isWithinRthEntryWindow =
    etTime.totalMinutes >= sessionBounds.entryStartMins &&
    etTime.totalMinutes <= sessionBounds.entryCutoffMins;

  if (!hasActiveTrade && !hasCompletedTradeToday && !isEodCutoff && isWithinRthEntryWindow) {
    const setupEval = evaluateBtoCandidateSetup({
      normalizedTicker,
      spotPrice,
      prevSpotPrice,
      params,
      store,
      latest5mCandle,
      divergence5m,
      divergence30m,
      etTotalMinutes: etTime.totalMinutes,
      nowTs,
      sessionDate,
      isPhase2ReclaimWindow,
      lastClosed,
      sameTickerClosedCount: sameTickerClosed.length,
    });

    const candidateBto = setupEval.candidateBto;
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
        const flowSnap = setupEval.flowSnap;
        const regimeClassification = classifyMarketRegime({
          spotPrice: entryClampedSpot,
          callWall: setupEval.tacticalCw,
          putWall: setupEval.tacticalPw,
          zeroGamma: setupEval.effectiveZeroGamma,
          zeroDteKing: params.filteredKing ?? (params.kingNode as any)?.zeroDteKing,
          bookCenter: setupEval.tacticalBookCenter,
          flowVwap: setupEval.effectiveFlowVwap,
          netGex: setupEval.resolvedNetGex,
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
          callWall: setupEval.tacticalCw,
          putWall: setupEval.tacticalPw,
          zeroGamma: setupEval.effectiveZeroGamma,
          zeroDteKing: params.filteredKing ?? (params.kingNode as any)?.zeroDteKing,
          bookCenter: setupEval.tacticalBookCenter,
          divergence5m: divergence5m ?? "NO",
          divergence30m: divergence30m ?? "NO",
          flowSnapshot: flowSnap,
          regimeClassification,
          priors: readAlphaPriorsSync(),
          minExpectancyR: isPhase2ReclaimWindow ? LEG2_MIN_EXPECTANCY_R : LEG1_MIN_EXPECTANCY_R,
        });

        const calibration = await calibrateWalkForwardExpectancy(normalizedTicker, sessionDate, params.signal);
        const passesExpectancy = calibration.passesGate && alphaScore.passesGate;
        if (params.signal?.aborted || !passesExpectancy) {
          const freshAbortStore = loadTradeStore();
          if (store.bookCenterHistoryByTicker || store.bouncedPutWalls) {
            if (store.bookCenterHistoryByTicker) {
              freshAbortStore.bookCenterHistoryByTicker = store.bookCenterHistoryByTicker;
              freshAbortStore.bookCenterLastTsByTicker = store.bookCenterLastTsByTicker;
            }
            if (store.bouncedPutWalls) {
              freshAbortStore.bouncedPutWalls = {
                ...(freshAbortStore.bouncedPutWalls || {}),
                ...store.bouncedPutWalls,
              };
            }
            saveTradeStore(freshAbortStore);
          }
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

        const absImpulsePeclet = Math.abs(flowSnap?.impulsePeclet ?? flowSnap?.pecletNumber ?? 0);
        const remainingExpectedMove =
          params.remainingExpectedMove ??
          (params.dailyExpectedMove &&
          params.dailyExpectedMove.high > params.dailyExpectedMove.low
            ? Number(((params.dailyExpectedMove.high - params.dailyExpectedMove.low) / 2).toFixed(2))
            : undefined);

        const optimalContract = await selectSmallAccountContract({
          ticker: normalizedTicker,
          contractType: candidateBto.contractType,
          spotPrice: entryClampedSpot,
          target1Spot: candidateBto.target1Spot,
          target2Spot: candidateBto.target2Spot,
          stopLossSpot: candidateBto.stopLossSpot,
          contracts: params.contracts,
          conviction: Math.max(params.conviction ?? 70, alphaScore.dataConvictionScore),
          nowEt: now,
          zeroDteCallWall: params.zeroDteCallWall || setupEval.tacticalCw,
          zeroDtePutWall: params.zeroDtePutWall || setupEval.tacticalPw,
          preferredDte: flowSnap ? regimeClassification.preferredDte : undefined,
          regime: params.regime ?? regimeClassification.regime,
          absImpulsePeclet: params.absImpulsePeclet ?? absImpulsePeclet,
          remainingExpectedMove,
          dataSource: params.dataSource,
          referenceSpotPrice: params.referenceSpotPrice,
          contractsAlreadyAnchored: params.contractsAlreadyAnchored,
          signal: params.signal,
        });

        if (params.signal?.aborted || !optimalContract) {
          const freshAbortStore = loadTradeStore();
          if (store.bouncedPutWalls) {
            freshAbortStore.bouncedPutWalls = {
              ...(freshAbortStore.bouncedPutWalls || {}),
              ...store.bouncedPutWalls,
            };
            saveTradeStore(freshAbortStore);
          }
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

        // Post-await RTH cutoff re-check for live wall-clock ticks (!params.nowEt)
        if (!params.isHistoricalBackfill && !params.nowEt) {
          const postAwaitDate = new Date();
          const postAwaitBounds = getSessionBoundsEt(formatEtIsoDate(postAwaitDate));
          const postAwaitEt = getNowEtTime(postAwaitDate);
          if (
            postAwaitEt.totalMinutes < postAwaitBounds.entryStartMins ||
            postAwaitEt.totalMinutes > postAwaitBounds.entryCutoffMins
          ) {
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

        const positionTicker = positionKey;
        const positionSpot = isSpxw ? Number((entryClampedSpot / 10).toFixed(2)) : entryClampedSpot;
        const positionTarget1 = isSpxw ? Number((candidateBto.target1Spot / 10).toFixed(2)) : candidateBto.target1Spot;
        const positionTarget2 = isSpxw ? Number((candidateBto.target2Spot / 10).toFixed(2)) : candidateBto.target2Spot;
        const positionStopLoss = isSpxw ? Number((candidateBto.stopLossSpot / 10).toFixed(2)) : candidateBto.stopLossSpot;
        const posInitialRisk = Number(
          Math.max(Math.max(0.03, positionSpot * 0.0001), Math.abs(positionSpot - positionStopLoss)).toFixed(2)
        );
        const posPrevLow =
          typeof latest5mCandle?.prevLow === "number"
            ? isSpxw
              ? Number((latest5mCandle.prevLow / 10).toFixed(2))
              : latest5mCandle.prevLow
            : undefined;
        const posPrevHigh =
          typeof latest5mCandle?.prevHigh === "number"
            ? isSpxw
              ? Number((latest5mCandle.prevHigh / 10).toFixed(2))
              : latest5mCandle.prevHigh
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
          atr5m: Number(setupEval.entryAtr5m.toFixed(4)),
          lastPrevClose: latest5mCandle?.close,
          altContractNote: optimalContract.altContractNote,
          calibratedWinRate: calibration.winRate,
          calibratedExpectancyR: calibration.expectancyR,
          dataConvictionScore: calibration.dataConvictionScore,
          flowVwap: flowSnap?.flowVwap,
          ceilingShareChi: flowSnap?.ceilingShareChi,
          pecletNumber: flowSnap?.pecletNumber,
          originBackfill: Boolean(params.isHistoricalBackfill),
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
        if (store.bookCenterHistoryByTicker) {
          latestStoreBeforeCommit.bookCenterHistoryByTicker = store.bookCenterHistoryByTicker;
          latestStoreBeforeCommit.bookCenterLastTsByTicker = store.bookCenterLastTsByTicker;
        }
        if (store.bouncedPutWalls) {
          latestStoreBeforeCommit.bouncedPutWalls = {
            ...(latestStoreBeforeCommit.bouncedPutWalls || {}),
            ...store.bouncedPutWalls,
          };
        }
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

  if (emittedAlerts.length === 0 && !hadActivePositionAtStart) {
    const latestIdleStore = loadTradeStore();
    if (
      latestIdleStore.prevSpotPrices[normalizedTicker] !== spotPrice ||
      Boolean(store.bookCenterHistoryByTicker?.[normalizedTicker]?.length) ||
      Boolean(store.bouncedPutWalls?.[normalizedTicker])
    ) {
      latestIdleStore.prevSpotPrices[normalizedTicker] = spotPrice;
      if (store.bookCenterHistoryByTicker) {
        latestIdleStore.bookCenterHistoryByTicker = store.bookCenterHistoryByTicker;
        latestIdleStore.bookCenterLastTsByTicker = store.bookCenterLastTsByTicker;
      }
      if (store.bouncedPutWalls) {
        latestIdleStore.bouncedPutWalls = {
          ...(latestIdleStore.bouncedPutWalls || {}),
          ...store.bouncedPutWalls,
        };
      }
      saveTradeStore(latestIdleStore);
    }
    store = latestIdleStore;
  }

  const realNowTs = Math.floor(Date.now() / 1000);
  if (!params.isHistoricalBackfill) {
    const preDiscordStore = loadTradeStore();
    const unsentTodayAlerts = preDiscordStore.alerts.filter(
      (a) =>
        (a.ticker === normalizedTicker || a.ticker === positionKey) &&
        !preDiscordStore.dispatchedAlertIds?.[a.id] &&
        isAlertDispatchEligible(a, realNowTs, sessionBounds)
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
 * Evaluates all currently active positions across all tickers against live CBOE quotes,
 * transitions contradictory Gaia positions to closedPositions cleanly via purgeZombieToClosed,
 * retries any pending live alerts, and dispatches EOD performance recap when RTH closes.
 */
export async function evaluateAllActivePositions(params?: {
  webhookUrl?: string;
  signal?: AbortSignal;
}): Promise<TradeLifecycleAlert[]> {
  if (params?.signal?.aborted) return [];
  const store = loadTradeStore();
  const activeKeys = Object.keys(store.activePositions);
  const allEmitted: TradeLifecycleAlert[] = [];

  for (const ticker of activeKeys) {
    if (params?.signal?.aborted) break;
    const pos = loadTradeStore().activePositions[ticker];
    if (!pos || (pos.status !== "OPEN" && pos.status !== "PARTIAL_TP1")) continue;

    const latestGuardStore = loadTradeStore();
    const tickerFsm = latestGuardStore.gaiaStateByTicker?.[ticker];
    const fsmState = tickerFsm?.activeFsmState ?? (ticker === "SPY" ? latestGuardStore.activeFsmState : undefined);
    const tickerMacroRegime = tickerFsm?.macroRegime ?? (ticker === "SPY" ? latestGuardStore.macroRegime : undefined);
    const tickerChiPct = tickerFsm?.chiPct ?? (ticker === "SPY" ? latestGuardStore.chiPct : undefined);
    if (fsmState !== undefined || tickerMacroRegime !== undefined || tickerChiPct !== undefined) {
      const isStructuralSetup = !pos.setupName.includes("Gaia Tactical HUD");
      if (fsmState === "STAND_ASIDE" && !isStructuralSetup) {
        purgeZombieToClosed(latestGuardStore, ticker, "Gaia FSM Neutralized to STAND_ASIDE");
        saveTradeStore(latestGuardStore);
        continue;
      }
      if (
        pos.contractType === "PUT" &&
        !isStructuralSetup &&
        (fsmState === "LONG" || tickerMacroRegime === "CALL" || (tickerChiPct ?? 50) >= 50)
      ) {
        console.warn(`[evaluateAllActivePositions] Closing contradictory ${ticker} PUT position while FSM is LONG/CALL.`);
        purgeZombieToClosed(latestGuardStore, ticker, "Gaia FSM/Regime Contradiction Guard (PUT vs LONG/CALL)");
        saveTradeStore(latestGuardStore);
        continue;
      }
      if (
        pos.contractType === "CALL" &&
        !isStructuralSetup &&
        (fsmState === "SHORT" || tickerMacroRegime === "PUT" || (tickerChiPct ?? 50) < 50)
      ) {
        console.warn(`[evaluateAllActivePositions] Closing contradictory ${ticker} CALL position while FSM is SHORT/PUT.`);
        purgeZombieToClosed(latestGuardStore, ticker, "Gaia FSM/Regime Contradiction Guard (CALL vs SHORT/PUT)");
        saveTradeStore(latestGuardStore);
        continue;
      }
    }

    try {
      const contracts = await fetchLiveCboeOptions(ticker, params?.signal);
      if (params?.signal?.aborted) break;

      let spot = getCachedSpotPrice(ticker);
      if (!spot || spot <= 0) {
        if (ticker === "SPX" || ticker === "SPXW") {
          spot = getCachedSpotPrice("_SPX") || pos.btoSpotPrice;
        } else {
          spot = pos.btoSpotPrice;
        }
      }

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

  if (!params?.signal?.aborted) {
    try {
      await flushPendingDiscordAlerts({
        webhookUrl: params?.webhookUrl,
        signal: params?.signal,
      });
    } catch {
      // Non-fatal
    }
    try {
      const { checkAndSendMarketCloseRecap } = await import("./tradePerformanceEngine");
      await checkAndSendMarketCloseRecap({ webhookUrl: params?.webhookUrl });
    } catch {
      // Non-fatal
    }
  }

  return allEmitted;
}
