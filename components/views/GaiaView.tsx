"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDashboardStore } from "@/store/useDashboardStore";
import { computeIntradayExpiryYears, normPDF } from "@/lib/optionsExposure";
import {
  computeCanonicalPdeSeries,
  FlowGammaVwapSnapshot,
} from "@/lib/flowGammaVwap";
import {
  drawFlowGammaVwapOverlay,
} from "@/components/chart/FlowGammaVwapOverlay";
import {
  GaiaCallPutBiasHud,
} from "@/components/gaia/GaiaCallPutBiasHud";
import {
  etMinutesOfDay,
  getSessionBoundsEt,
  getTodayEt,
  toEpochSec,
} from "@/lib/gaiaSessionGuards";
import { isMarketOpen } from "@/lib/marketDataService";
import type { SessionPlaybookPolicy } from "@/lib/persistenceStore";
import type {
  GaiaExpirationInfo,
  GaiaIntradayCandle,
  GaiaLivePayload,
  GaiaMtfRow,
  GaiaPivotSignal,
  GaiaSessionOption,
  GaiaStrikeExpBucket,
} from "@/app/api/gaia/route";
import { cn } from "@/lib/utils";
import {
  drawTradeExecutionMarkers,
  extractNormalizedTradesForTicker,
  type NormalizedChartTrade,
  type ServerTradesState,
} from "@/components/chart/TradeExecutionMarkersOverlay";

type ExposureMode = "GEX" | "VEX" | "Combined";
type ExpFilterMode = "ALL" | "NEXT" | "WEEK" | string; // string for specific MM-DD date

interface StrikeExposureColumn {
  netGexB: number; // in Billions ($B)
  kingStrike: number;
  kingConcPct: number;
  allExpKingStrike: number;
  allExpKingConcPct: number;
  filteredKingStrike: number;
  filteredKingConcPct: number;
  bookCenter: number;
  strikeValues: Record<number, number>; // value in Millions ($M)
  strikeGexValues?: Record<number, number>;
  strikeVexValues?: Record<number, number>;
  topLevels: { strike: number; valueM: number }[];
}

interface ComputedGaiaViewData {
  ticker: string;
  sessionDate: string;
  bookLabel: string;
  priorClose: number;
  sigma1Move: number;
  sigma2Move: number;
  yMin: number;
  yMax: number;
  yAxisTicks: number[];
  visibleStrikes: number[];
  candles: GaiaIntradayCandle[];
  columnsByBar: StrikeExposureColumn[];
  pivotSignals5m: GaiaPivotSignal[];
  mtfByBar: GaiaMtfRow[];
}

function formatBookLevelValue(valueM: number): string {
  const absM = Math.abs(valueM);
  const sign = valueM < 0 ? "-" : "+";
  if (absM >= 1000) {
    return `${sign}${(absM / 1000).toFixed(2)}B`;
  }
  return `${sign}${absM.toFixed(2)}M`;
}

function formatPct(pct: number): string {
  return `${Number(pct.toFixed(1))}`;
}

function computeNicePriceTicks(
  min: number,
  max: number,
  targetCount = 5
): number[] {
  const span = max - min;
  if (span <= 0) return [min];
  const rawStep = span / (targetCount - 1);
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const normalized = rawStep / magnitude;
  let niceStepNorm = 1;
  if (normalized > 1.2 && normalized <= 2.2) niceStepNorm = 2;
  else if (normalized > 2.2 && normalized <= 3.8) niceStepNorm = 2.5;
  else if (normalized > 3.8 && normalized <= 7.0) niceStepNorm = 5;
  else if (normalized > 7.0) niceStepNorm = 10;
  const niceStep = niceStepNorm * magnitude;

  const firstTick = Math.ceil((min - 0.0001) / niceStep) * niceStep;
  const ticks: number[] = [];
  for (let t = firstTick; t <= max + niceStep * 0.001; t += niceStep) {
    ticks.push(Number(t.toFixed(2)));
  }
  if (ticks.length >= 3) return ticks;
  const step = span / 4;
  return [0, 1, 2, 3, 4]
    .map((i) => Number((max - i * step).toFixed(2)))
    .reverse();
}

interface PreparedGaiaBucket {
  strike: number;
  logStrike: number;
  inActive: boolean;
  inNextExp: boolean;
  hasCall: boolean;
  hasPut: boolean;
  callOiScale: number;
  putOiScale: number;
  callInvIvSqrtT: number;
  callDriftT: number;
  callInvIvSqrtTVex: number;
  callIvSqrtTVex: number;
  callVexDriftT: number;
  callInvIv: number;
  callDiscountQ: number;
  putInvIvSqrtT: number;
  putDriftT: number;
  putInvIvSqrtTVex: number;
  putIvSqrtTVex: number;
  putVexDriftT: number;
  putInvIv: number;
  putDiscountQ: number;
}

function prepareGaiaBucket(
  bucket: GaiaStrikeExpBucket,
  inActive: boolean,
  inNextExp: boolean
): PreparedGaiaBucket | null {
  if (bucket.callOI <= 0 && bucket.putOI <= 0) return null;
  const days = bucket.dteDays;
  const T = computeIntradayExpiryYears(days);
  const sqrtT = Math.sqrt(T);
  const T_vex = Math.max(1 / 365, (days + 0.5) / 365);
  const sqrtT_vex = Math.sqrt(T_vex);
  const discountQ_vex = Math.exp(-0.012 * T_vex);

  const hasCall = bucket.callOI > 0;
  const callIv = hasCall ? Math.max(0.02, Math.min(3.5, bucket.callIv)) : 0.2;
  const hasPut = bucket.putOI > 0;
  const putIv = hasPut ? Math.max(0.02, Math.min(3.5, bucket.putIv)) : 0.2;

  return {
    strike: bucket.strike,
    logStrike: Math.log(Math.max(1e-4, bucket.strike)),
    inActive,
    inNextExp,
    hasCall,
    hasPut,
    callOiScale: (bucket.callOI * 100 * 0.01) / 1e6,
    putOiScale: (bucket.putOI * 100 * 0.01) / 1e6,
    callInvIvSqrtT: 1 / (callIv * sqrtT),
    callDriftT: (0.046 + 0.5 * callIv * callIv) * T,
    callInvIvSqrtTVex: 1 / (callIv * sqrtT_vex),
    callIvSqrtTVex: callIv * sqrtT_vex,
    callVexDriftT: (0.045 - 0.012 + 0.5 * callIv * callIv) * T_vex,
    callInvIv: 1 / callIv,
    callDiscountQ: discountQ_vex,
    putInvIvSqrtT: 1 / (putIv * sqrtT),
    putDriftT: (0.046 + 0.5 * putIv * putIv) * T,
    putInvIvSqrtTVex: 1 / (putIv * sqrtT_vex),
    putIvSqrtTVex: putIv * sqrtT_vex,
    putVexDriftT: (0.045 - 0.012 + 0.5 * putIv * putIv) * T_vex,
    putInvIv: 1 / putIv,
    putDiscountQ: discountQ_vex,
  };
}

function evaluatePreparedBucketDual(
  spot: number,
  logSpot: number,
  p: PreparedGaiaBucket
): { netGexM: number; netVexM: number } {
  const rawLogMoneyness = logSpot - p.logStrike;
  const logMoneyness = rawLogMoneyness > -9.210340371976182 ? rawLogMoneyness : -9.210340371976182;

  let callGexM = 0;
  let callVexM = 0;
  if (p.hasCall) {
    const d1 = (logMoneyness + p.callDriftT) * p.callInvIvSqrtT;
    const pdf = normPDF(d1);
    const gammaSpot = pdf * p.callInvIvSqrtT; // gamma * spot
    const d1v = (logMoneyness + p.callVexDriftT) * p.callInvIvSqrtTVex;
    const d2v = d1v - p.callIvSqrtTVex;
    const vanna = -p.callDiscountQ * normPDF(d1v) * (d2v * p.callInvIv);
    callGexM = p.callOiScale * gammaSpot * spot;
    callVexM = p.callOiScale * vanna * spot;
  }

  let putGexM = 0;
  let putVexM = 0;
  if (p.hasPut) {
    const d1 = (logMoneyness + p.putDriftT) * p.putInvIvSqrtT;
    const pdf = normPDF(d1);
    const gammaSpot = pdf * p.putInvIvSqrtT;
    const d1v = (logMoneyness + p.putVexDriftT) * p.putInvIvSqrtTVex;
    const d2v = d1v - p.putIvSqrtTVex;
    const vanna = -p.putDiscountQ * normPDF(d1v) * (d2v * p.putInvIv);
    putGexM = p.putOiScale * gammaSpot * spot;
    putVexM = p.putOiScale * vanna * spot;
  }

  return {
    netGexM: callGexM - putGexM,
    netVexM: callVexM - putVexM,
  };
}

function evaluateBucketExposureM(
  spot: number,
  bucket: GaiaStrikeExpBucket,
  mode: ExposureMode
): number {
  const prep = prepareGaiaBucket(bucket, true, false);
  if (!prep) return 0;
  const { netGexM, netVexM } = evaluatePreparedBucketDual(
    spot,
    Math.log(Math.max(1e-4, spot)),
    prep
  );
  if (mode === "GEX") return netGexM;
  if (mode === "VEX") return netVexM;
  return netGexM + netVexM;
}

const GAIA_CLIENT_HM_24_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const GAIA_CLIENT_TIME_12_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

function formatClientEtTimeLabel(tsSec: number): string {
  return GAIA_CLIENT_TIME_12_FMT.format(new Date(tsSec * 1000));
}

function getCandleEtMinutes(c: { timestamp?: number; timeLabel?: string }): number | null {
  if (typeof c.timestamp === "number" && c.timestamp > 0) {
    const epochMs = c.timestamp > 1e11 ? c.timestamp : c.timestamp * 1000;
    try {
      const parts = GAIA_CLIENT_HM_24_FMT.formatToParts(new Date(epochMs));
      const h = Number(parts.find((p) => p.type === "hour")?.value ?? NaN);
      const m = Number(parts.find((p) => p.type === "minute")?.value ?? NaN);
      if (Number.isFinite(h) && Number.isFinite(m)) return (h % 24) * 60 + m;
    } catch {}
  }
  if (c.timeLabel) {
    const match = c.timeLabel.match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?/i);
    if (match) {
      let h = parseInt(match[1], 10);
      const m = match[2] ? parseInt(match[2], 10) : 0;
      const ampm = (match[3] || "").toUpperCase();
      if (ampm === "PM" && h < 12) h += 12;
      if (ampm === "AM" && h === 12) h = 0;
      return h * 60 + m;
    }
  }
  return null;
}

/**
 * Closed-bar Black-Scholes column cache: prevents 800ms live ticks on the active candle
 * from re-evaluating ~150 closed historical bars x 5,700+ buckets on every tick (~99% CPU reduction).
 */
let closedBarColumnsCache: {
  key: string;
  columns: StrikeExposureColumn[];
  extraStrikes: number[];
} | null = null;

/**
 * Computes the complete Gaia chart view dataset strictly from the live API payload.
 */
function buildLiveGaiaDataset(
  payload: GaiaLivePayload,
  exposureMode: ExposureMode,
  expFilter: ExpFilterMode
): ComputedGaiaViewData {
  const {
    ticker,
    sessionDate,
    bookLabel,
    priorClose,
    sigma1Move,
    sigma2Move,
    candles,
    pivotSignals5m,
    mtfByBar,
    expirations,
    optionBuckets,
  } = payload;

  // Filter live option buckets by the selected expiration filter
  const nextExpIso = expirations[0]?.isoDate ?? "";
  const weekIsoSet = new Set(
    expirations.filter((e) => e.isThisWeek).map((e) => e.isoDate)
  );

  const filteredBuckets = optionBuckets.filter((b) => {
    if (expFilter === "ALL") return true;
    if (expFilter === "NEXT") return b.expiration === nextExpIso;
    if (expFilter === "WEEK") {
      return weekIsoSet.size > 0
        ? weekIsoSet.has(b.expiration)
        : b.expiration === nextExpIso;
    }
    return b.dateLabel === expFilter || b.expiration === expFilter;
  });

  const activeBuckets =
    filteredBuckets.length > 0 ? filteredBuckets : optionBuckets;
  const nextExpBuckets =
    nextExpIso.length > 0
      ? optionBuckets.filter((b) => b.expiration === nextExpIso)
      : activeBuckets;

  // Compute y-domain bounds from live session candles and ±2σ Expected-Move Cone
  const candleHighs = candles.map((c) => c.high);
  const candleLows = candles.map((c) => c.low);
  const maValues = candles.map((c) => c.sma5d);

  const minChartRef = Math.min(
    ...candleLows,
    priorClose - sigma2Move
  );
  const maxChartRef = Math.max(
    ...candleHighs,
    ...maValues,
    priorClose + sigma2Move
  );

  // Pre-calculate All-Exp King and Filtered King at spot to guarantee both are encompassed in the vertical price window
  const preScanSpot = payload.spotPrice || priorClose;
  const preScanAllTotals = new Map<number, number>();
  for (const b of optionBuckets) {
    const v = evaluateBucketExposureM(preScanSpot, b, exposureMode);
    preScanAllTotals.set(b.strike, (preScanAllTotals.get(b.strike) ?? 0) + v);
  }
  let preScanAllKing = preScanSpot;
  let maxAllAbs = -1;
  for (const [s, v] of Array.from(preScanAllTotals.entries())) {
    if (Math.abs(v) > maxAllAbs) {
      maxAllAbs = Math.abs(v);
      preScanAllKing = s;
    }
  }

  const preScanFilteredTotals = new Map<number, number>();
  const bucketsForPreScan = expFilter === "ALL" && nextExpBuckets.length > 0 ? nextExpBuckets : activeBuckets;
  for (const b of bucketsForPreScan) {
    const v = evaluateBucketExposureM(preScanSpot, b, exposureMode);
    preScanFilteredTotals.set(b.strike, (preScanFilteredTotals.get(b.strike) ?? 0) + v);
  }
  let preScanFilteredKing = preScanAllKing;
  let maxFilteredAbs = -1;
  for (const [s, v] of Array.from(preScanFilteredTotals.entries())) {
    if (Math.abs(v) > maxFilteredAbs) {
      maxFilteredAbs = Math.abs(v);
      preScanFilteredKing = s;
    }
  }

  const chartBoundMin = Math.min(minChartRef, preScanAllKing, preScanFilteredKing);
  const chartBoundMax = Math.max(maxChartRef, preScanAllKing, preScanFilteredKing);

  // Extract all live option strikes within the visible vertical price window
  const allUniqueStrikesDesc = Array.from(
    new Set(optionBuckets.map((b) => b.strike))
  ).sort((a, b) => b - a);

  const mustIncludeStrikes = new Set<number>(
    [preScanAllKing, preScanFilteredKing].filter((s) => s > 0)
  );
  const inWindowStrikes = allUniqueStrikesDesc.filter(
    (s) =>
      (s >= chartBoundMin - sigma1Move * 0.35 &&
        s <= chartBoundMax + sigma1Move * 0.35) ||
      mustIncludeStrikes.has(s)
  );

  const baseVisibleStrikes =
    inWindowStrikes.length >= 5
      ? inWindowStrikes
      : allUniqueStrikesDesc.slice(0, 25);

  const visibleStrikeSet = new Set(baseVisibleStrikes);

  const isLatestSession =
    payload.sessions.length === 0 ||
    sessionDate === payload.sessions[0].isoDate;

  const activeBucketSet = new Set(activeBuckets);
  const nextExpBucketSet = new Set(nextExpBuckets);
  const preparedAll: PreparedGaiaBucket[] = [];
  for (const b of optionBuckets) {
    const p = prepareGaiaBucket(b, activeBucketSet.has(b), nextExpBucketSet.has(b));
    if (p) preparedAll.push(p);
  }

  const closedCacheKey =
    candles.length >= 2
      ? `${ticker}|${sessionDate}|${exposureMode}|${expFilter}|${optionBuckets.length}|${candles.length}|${candles[0]?.timestamp ?? 0}|${candles[candles.length - 2]?.timestamp ?? 0}|${candles[candles.length - 2]?.close ?? 0}|${baseVisibleStrikes.length}|${baseVisibleStrikes[0] ?? 0}`
      : "";
  const canReuseClosedBars =
    closedCacheKey.length > 0 &&
    closedBarColumnsCache !== null &&
    closedBarColumnsCache.key === closedCacheKey &&
    closedBarColumnsCache.columns.length === candles.length - 1;
  if (canReuseClosedBars && closedBarColumnsCache) {
    for (const s of closedBarColumnsCache.extraStrikes) {
      visibleStrikeSet.add(s);
    }
  }

  // Evaluate Black-Scholes exposure in a single pass across prepared buckets per bar
  const columnsByBar: StrikeExposureColumn[] = candles.map((candle, idx) => {
    if (canReuseClosedBars && idx < candles.length - 1 && closedBarColumnsCache) {
      return closedBarColumnsCache.columns[idx];
    }
    const spot =
      isLatestSession && idx === candles.length - 1
        ? (candle.close > 0 ? candle.close : payload.spotPrice)
        : candle.close;
    const logSpot = Math.log(Math.max(1e-4, spot));

    const allExpStrikeTotals = new Map<number, number>();
    const strikeTotals = expFilter === "ALL" ? allExpStrikeTotals : new Map<number, number>();
    const strikeGexTotals = new Map<number, number>();
    const strikeVexTotals = new Map<number, number>();
    const nextExpTotals = expFilter === "ALL" && nextExpBuckets.length > 0 ? new Map<number, number>() : null;

    for (let i = 0; i < preparedAll.length; i++) {
      const prep = preparedAll[i];
      const { netGexM, netVexM } = evaluatePreparedBucketDual(spot, logSpot, prep);
      const valM =
        exposureMode === "GEX"
          ? netGexM
          : exposureMode === "VEX"
          ? netVexM
          : netGexM + netVexM;

      allExpStrikeTotals.set(
        prep.strike,
        (allExpStrikeTotals.get(prep.strike) ?? 0) + valM
      );

      if (expFilter === "ALL" || prep.inActive) {
        strikeGexTotals.set(
          prep.strike,
          (strikeGexTotals.get(prep.strike) ?? 0) + netGexM
        );
        strikeVexTotals.set(
          prep.strike,
          (strikeVexTotals.get(prep.strike) ?? 0) + netVexM
        );
      }

      if (expFilter !== "ALL" && prep.inActive) {
        strikeTotals.set(
          prep.strike,
          (strikeTotals.get(prep.strike) ?? 0) + valM
        );
      }

      if (nextExpTotals && prep.inNextExp) {
        nextExpTotals.set(
          prep.strike,
          (nextExpTotals.get(prep.strike) ?? 0) + valM
        );
      }
    }

    let totalAllExpAbsBoardM = 0;
    const rankedAllExp: { strike: number; valueM: number }[] = [];
    for (const [strike, valM] of Array.from(allExpStrikeTotals.entries())) {
      const rounded = Number(valM.toFixed(2));
      totalAllExpAbsBoardM += Math.abs(valM);
      rankedAllExp.push({ strike, valueM: rounded });
    }
    rankedAllExp.sort((a, b) => Math.abs(b.valueM) - Math.abs(a.valueM));
    const allExpKingStrike =
      rankedAllExp[0]?.strike ??
      baseVisibleStrikes[baseVisibleStrikes.length - 1] ??
      Math.round(spot);
    const allExpKingAbsM = Math.abs(rankedAllExp[0]?.valueM ?? 0);
    const allExpKingConcPct =
      totalAllExpAbsBoardM > 0
        ? Number(((allExpKingAbsM / totalAllExpAbsBoardM) * 100).toFixed(1))
        : 0;

    let totalNetM = 0;
    let totalAbsBoardM = 0;
    const rankedFiltered: { strike: number; valueM: number }[] = [];
    const strikeValues: Record<number, number> = {};
    const strikeGexValues: Record<number, number> = {};
    const strikeVexValues: Record<number, number> = {};

    for (const [strike, valM] of Array.from(strikeTotals.entries())) {
      const rounded = Number(valM.toFixed(2));
      totalNetM += valM;
      totalAbsBoardM += Math.abs(valM);
      rankedFiltered.push({ strike, valueM: rounded });
      if (visibleStrikeSet.has(strike)) {
        strikeValues[strike] = rounded;
      }
    }

    for (const [strike, valM] of Array.from(strikeGexTotals.entries())) {
      if (visibleStrikeSet.has(strike)) {
        strikeGexValues[strike] = Number(valM.toFixed(2));
      }
    }
    for (const [strike, valM] of Array.from(strikeVexTotals.entries())) {
      if (visibleStrikeSet.has(strike)) {
        strikeVexValues[strike] = Number(valM.toFixed(2));
      }
    }

    rankedFiltered.sort((a, b) => Math.abs(b.valueM) - Math.abs(a.valueM));
    const topLevels = rankedFiltered.slice(0, 3);
    let filteredKingStrike =
      topLevels[0]?.strike ??
      baseVisibleStrikes[baseVisibleStrikes.length - 1] ??
      Math.round(spot);
    let filteredKingAbsM = Math.abs(topLevels[0]?.valueM ?? 0);
    let filteredKingConcPct =
      totalAbsBoardM > 0
        ? Number(((filteredKingAbsM / totalAbsBoardM) * 100).toFixed(1))
        : 0;

    // When viewing All-Exp, also compute the Tactical 0DTE/Next-Exp King so the chart always shows the nearest expiration magnet alongside All-Exp King
    if (nextExpTotals) {
      let nextExpAbsBoardM = 0;
      let bestNextStrike = allExpKingStrike;
      let bestNextAbsM = -1;
      for (const [strike, valM] of Array.from(nextExpTotals.entries())) {
        const absM = Math.abs(valM);
        nextExpAbsBoardM += absM;
        if (absM > bestNextAbsM) {
          bestNextAbsM = absM;
          bestNextStrike = strike;
        }
      }
      if (bestNextAbsM > 0) {
        filteredKingStrike = bestNextStrike;
        filteredKingAbsM = bestNextAbsM;
        filteredKingConcPct =
          nextExpAbsBoardM > 0
            ? Number(((bestNextAbsM / nextExpAbsBoardM) * 100).toFixed(1))
            : 0;
      }
    }

    const kingStrike =
      expFilter === "ALL" ? allExpKingStrike : filteredKingStrike;
    const kingConcPct =
      expFilter === "ALL" ? allExpKingConcPct : filteredKingConcPct;

    // Ensure both King strikes are included in strikeValues & visibleStrikeSet
    if (strikeValues[filteredKingStrike] === undefined) {
      const filtVal = strikeTotals.get(filteredKingStrike) ?? 0;
      strikeValues[filteredKingStrike] = Number(filtVal.toFixed(2));
      visibleStrikeSet.add(filteredKingStrike);
    }
    if (rankedAllExp[0] && strikeValues[allExpKingStrike] === undefined) {
      const allKingInFiltered = strikeTotals.get(allExpKingStrike) ?? 0;
      strikeValues[allExpKingStrike] = Number(allKingInFiltered.toFixed(2));
      visibleStrikeSet.add(allExpKingStrike);
    }

    // Exposure-weighted Book Center across visible strikes
    let weightedStrikeSum = 0;
    let absWeightTotal = 0;
    for (const s of Array.from(visibleStrikeSet)) {
      const absExp = Math.abs(strikeValues[s] ?? 0);
      weightedStrikeSum += s * absExp;
      absWeightTotal += absExp;
    }
    const bookCenter =
      absWeightTotal > 0
        ? Number((weightedStrikeSum / absWeightTotal).toFixed(2))
        : Number(spot.toFixed(2));

    return {
      netGexB: Number((totalNetM / 1000).toFixed(2)),
      kingStrike,
      kingConcPct,
      allExpKingStrike,
      allExpKingConcPct,
      filteredKingStrike,
      filteredKingConcPct,
      bookCenter,
      strikeValues,
      strikeGexValues,
      strikeVexValues,
      topLevels,
    };
  });

  if (closedCacheKey.length > 0 && columnsByBar.length >= 2) {
    const baseSet = new Set(baseVisibleStrikes);
    const extraStrikes = Array.from(visibleStrikeSet).filter((s) => !baseSet.has(s));
    closedBarColumnsCache = {
      key: closedCacheKey,
      columns: columnsByBar.slice(0, columnsByBar.length - 1),
      extraStrikes,
    };
  }

  const visibleStrikes = Array.from(visibleStrikeSet).sort((a, b) => b - a);

  // Include visible strikes, candles, both King strikes, and full ±2σ Expected-Move Cone bounds + padding
  const lastCol = columnsByBar[columnsByBar.length - 1];
  const allExpKingFinal = lastCol?.allExpKingStrike ?? priorClose;
  const filteredKingFinal = lastCol?.filteredKingStrike ?? priorClose;
  const allDomainPrices = [
    ...visibleStrikes,
    ...candleHighs,
    ...candleLows,
    ...maValues,
    priorClose - sigma2Move,
    priorClose + sigma2Move,
    allExpKingFinal,
    filteredKingFinal,
  ];
  const minPrice = Math.min(...allDomainPrices);
  const maxPrice = Math.max(...allDomainPrices);
  const padPts = Math.max(Math.max(0.05, priorClose * 0.002), (maxPrice - minPrice) * 0.06);
  const yMin = Number((minPrice - padPts).toFixed(2));
  const yMax = Number((maxPrice + padPts).toFixed(2));

  // 5 evenly spaced right-axis price ticks across the visible domain
  const tickTop = maxPrice - padPts * 0.55;
  const tickBot = minPrice + padPts * 0.95;
  const tickStep = (tickTop - tickBot) / 4;
  const yAxisTicks = [0, 1, 2, 3, 4].map((idx) =>
    Number((tickTop - idx * tickStep).toFixed(2))
  );

  return {
    ticker,
    sessionDate,
    bookLabel,
    priorClose,
    sigma1Move,
    sigma2Move,
    yMin,
    yMax,
    yAxisTicks,
    visibleStrikes,
    candles,
    columnsByBar,
    pivotSignals5m,
    mtfByBar,
  };
}

export function GaiaView() {
  const storeTicker = useDashboardStore((state) => state.activeTicker);
  const gammaLevels = useDashboardStore((state) => state.gammaLevels);
  const setStoreTicker = useDashboardStore((state) => state.setTicker);
  const liveTickPrice = useDashboardStore((state) => state.liveTickPrice);
  const liveTickCount = useDashboardStore((state) => state.liveTickCount);
  const liveTickMarketOpen = useDashboardStore((state) => state.liveTickMarketOpen);
  const storeActivePositions = useDashboardStore(
    (state) => state.serverActivePositions
  );
  const storeClosedTrades = useDashboardStore(
    (state) => state.serverClosedTrades
  );
  const storeTradeAlerts = useDashboardStore(
    (state) => state.serverTradeAlerts
  );
  const storeServerTradesLoaded = useDashboardStore(
    (state) => state.serverTradesLoaded
  );
  const storeSupervisorPolicy = useDashboardStore(
    (state) => state.supervisorPolicy
  );

  const [serverTrades, setServerTrades] = useState<ServerTradesState>({
    activePositions: storeActivePositions,
    closedPositions: storeClosedTrades,
    alerts: storeTradeAlerts,
    loaded: storeServerTradesLoaded,
  });
  const [historicalSupervisorPolicy, setHistoricalSupervisorPolicy] =
    useState<SessionPlaybookPolicy | null>(null);

  const [atlasPalette, setAtlasPalette] = useState<"ice" | "polarity">("polarity");

  const DIVSYM = useMemo(() => new Set(["SPY", "QQQ", "SPXW", "IWM"]), []);

  const [tickerInput, setTickerInput] = useState<string>(storeTicker || "SPY");
  const [loadedTicker, setLoadedTicker] = useState<string>(storeTicker || "SPY");
  const [guideExpanded, setGuideExpanded] = useState<boolean>(false);
  const [selectedSessionIso, setSelectedSessionIso] = useState<string>("");
  const [przmHudSignals, setPrzmHudSignals] = useState<any[]>([]);

  useEffect(() => {
    setPrzmHudSignals([]);
    setServerTrades({ activePositions: {}, closedPositions: [], alerts: [], loaded: false });
    setHistoricalSupervisorPolicy(null);
    isReplayingRef.current = false;
    setIsReplaying(false);
    isReplayFrozenRef.current = false;
    setIsReplayFrozen(false);
  }, [loadedTicker]);

  const [livePayload, setLivePayload] = useState<GaiaLivePayload | null>(
    null
  );
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [exposureMode, setExposureMode] = useState<ExposureMode>("GEX");
  const [expFilter, setExpFilter] = useState<ExpFilterMode>("ALL");
  const [selectedDateExp, setSelectedDateExp] = useState<string>("");

  // Chart Layout Metrics (Unified constants across canvas draw & pointer projection)
  const CHART_PAD_LEFT = 24;
  const CHART_RIGHT_AXIS_WIDTH = 116;
  const CHART_PAD_TOP = 18;
  const CHART_PAD_BOTTOM = 32;

  const [activeBarIndex, setActiveBarIndex] = useState<number>(0);
  const [hoverBarIndex, setHoverBarIndex] = useState<number | null>(null);
  const [isReplaying, setIsReplaying] = useState<boolean>(false);
  const [isReplayFrozen, setIsReplayFrozen] = useState<boolean>(false);
  const [replaySpeed, setReplaySpeed] = useState<1 | 2 | 4>(1);
  const [barClockTick, setBarClockTick] = useState<number>(0);

  const todayEtIso = getTodayEt();
  const isHistoricalSession =
    Boolean(selectedSessionIso) &&
    selectedSessionIso !== todayEtIso &&
    selectedSessionIso !== livePayload?.sessions?.[0]?.isoDate;
  const effectiveRthOpen =
    typeof liveTickMarketOpen === "boolean"
      ? liveTickMarketOpen
      : (livePayload?.marketOpen ?? isMarketOpen().open);
  const isHistoricalOrReplay = isReplaying || isReplayFrozen || isHistoricalSession;
  const replayFrozenTradesRef = useRef<ServerTradesState | null>(null);
  const effectiveServerTrades: ServerTradesState = useMemo(() => {
    if (isHistoricalSession) {
      return {
        activePositions: serverTrades.activePositions || {},
        closedPositions: serverTrades.closedPositions || [],
        alerts: serverTrades.alerts || [],
        loaded: Boolean(serverTrades.loaded),
      };
    }
    const liveSnapshot: ServerTradesState = {
      activePositions: storeActivePositions,
      closedPositions: storeClosedTrades,
      alerts: storeTradeAlerts,
      loaded: storeServerTradesLoaded,
    };
    if (isReplaying || isReplayFrozen) {
      if (!replayFrozenTradesRef.current) {
        replayFrozenTradesRef.current = liveSnapshot;
      }
      return replayFrozenTradesRef.current;
    }
    replayFrozenTradesRef.current = null;
    return liveSnapshot;
  }, [isHistoricalSession, isReplaying, isReplayFrozen, serverTrades, storeActivePositions, storeClosedTrades, storeTradeAlerts, storeServerTradesLoaded]);
  const storeHeatmapKingNode = useDashboardStore((s) => s.kingNode);
  const storeHeatmapTicker = useDashboardStore((s) => s.activeTicker);
  const isReplayingRef = useRef<boolean>(false);
  const isReplayFrozenRef = useRef<boolean>(false);
  const prevStoreTickerRef = useRef<string>(storeTicker);
  const urlSyncDoneRef = useRef<boolean>(false);
  useEffect(() => { isReplayingRef.current = isReplaying; }, [isReplaying]);
  useEffect(() => { isReplayFrozenRef.current = isReplayFrozen; }, [isReplayFrozen]);
  const syncTickerUrlParam = useCallback((sym: string) => {
    if (typeof window === "undefined") return;
    const upper = sym.trim().toUpperCase();
    if (!upper) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("ticker")?.toUpperCase() === upper) return;
    url.searchParams.set("ticker", upper);
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  }, []);

  // Adjustable Chart Window States (Horizontal & Vertical)
  const [chartHeight, setChartHeight] = useState<number>(540); // 380 .. 950 px
  const [chartWidth, setChartWidth] = useState<number | null>(null); // null = 100% full width, or number in px (640 .. 2400)
  const [fluxFocusMode, setFluxFocusMode] = useState<boolean>(true);
  const [dividerRatio, setDividerRatio] = useState<number>(0.88); // 0.88 in Flux Focus (88% Candlesticks) .. 0.65 in Expanded Outlook
  const [xScale, setXScale] = useState<number>(1.0); // 0.5 .. 4.0 horizontal candle zoom
  const [xPanOffset, setXPanOffset] = useState<number>(0); // horizontal pan px
  const [startHour, setStartHour] = useState<number>(9); // 9 = 9:30 AM - 5:00 PM ET (default), 8 = 8:00 AM, 7 = 7:00 AM, 0 = 24H
  const [yScale, setYScale] = useState<number>(1.0); // 0.2 .. 10.0
  const [yPanOffset, setYPanOffset] = useState<number>(0); // price points
  const [scopePreset, setScopePreset] = useState<"focus" | "tactical" | "cone">("cone");
  const resetViewportTo24H = useCallback(() => {
    setStartHour(9);
    setXScale(1.0);
    setXPanOffset(0);
    setYScale(1.0);
    setYPanOffset(0);
    setScopePreset("cone");
  }, []);
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [dragMode, setDragMode] = useState<"pan" | "scaleY" | "scaleX" | "divider" | null>(null);
  const [dragStart, setDragStart] = useState<{
    x: number;
    y: number;
    yPan: number;
    yScale: number;
    xPan: number;
    xScale: number;
    dividerRatio: number;
  }>({
    x: 0,
    y: 0,
    yPan: 0,
    yScale: 1.0,
    xPan: 0,
    xScale: 1.0,
    dividerRatio: 0.88,
  });
  const [hoverCursor, setHoverCursor] = useState<{ x: number; y: number } | null>(null);

  // Global mouseup listener to release any active drag
  useEffect(() => {
    const onWindowMouseUp = () => {
      setIsDragging(false);
      setDragMode(null);
    };
    window.addEventListener("mouseup", onWindowMouseUp);
    return () => window.removeEventListener("mouseup", onWindowMouseUp);
  }, []);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [canvasWidth, setCanvasWidth] = useState<number>(1016);
  const gaiaAbortRef = useRef<AbortController | null>(null);
  const gaiaReqSeqRef = useRef<number>(0);
  const gaiaInFlightRef = useRef<boolean>(false);
  const gaiaInFlightSinceRef = useRef<number>(0);
  const hoverRafRef = useRef<number | null>(null);
  const pendingHoverRef = useRef<{
    cursor: { x: number; y: number } | null;
    barIdx: number | null;
  } | null>(null);

  useEffect(() => {
    return () => {
      gaiaAbortRef.current?.abort();
      gaiaInFlightRef.current = false;
      if (hoverRafRef.current !== null && typeof window !== "undefined") {
        window.cancelAnimationFrame(hoverRafRef.current);
      }
    };
  }, []);

  // Normalize selectedSessionIso: if it equals today's ET date (or latest live session), treat as live ("")
  useEffect(() => {
    if (!selectedSessionIso) return;
    const latestIso = livePayload?.sessions?.[0]?.isoDate;
    if (selectedSessionIso === getTodayEt() || (latestIso && selectedSessionIso === latestIso)) {
      setSelectedSessionIso("");
    }
  }, [selectedSessionIso, livePayload?.sessions]);

  // 1-second active bar countdown clock during live RTH so right-axis price pill stays continuously live
  useEffect(() => {
    if (isHistoricalOrReplay || !effectiveRthOpen) return;
    const id = setInterval(() => {
      setBarClockTick((n) => (n + 1) % 3600);
    }, 1000);
    return () => clearInterval(id);
  }, [isHistoricalOrReplay, effectiveRthOpen]);

  const fetchLiveGaia = useCallback(
    async (tickerSymbol: string, sessionIso?: string, sHour: number = startHour, silent: boolean = false) => {
      const nowMs = Date.now();
      if (
        silent &&
        gaiaInFlightRef.current &&
        nowMs - gaiaInFlightSinceRef.current < 12_000
      ) {
        return;
      }
      gaiaAbortRef.current?.abort();
      const controller = new AbortController();
      const fetchTimeout = setTimeout(() => controller.abort(), 12_000);
      gaiaAbortRef.current = controller;
      gaiaInFlightRef.current = true;
      gaiaInFlightSinceRef.current = nowMs;
      const reqSeq = ++gaiaReqSeqRef.current;
      if (!silent) {
        setIsLoading(true);
      }
      setErrorMsg(null);
      try {
        const qs = new URLSearchParams({
          ticker: tickerSymbol,
          start: String(sHour),
        });
        const cleanSession =
          sessionIso && sessionIso !== getTodayEt() ? sessionIso : "";
        if (cleanSession) qs.set("session", cleanSession);
        const res = await fetch(`/api/gaia?${qs.toString()}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const data = await res.json();
        if (!res.ok || data?.error) {
          throw new Error(data?.error ?? `HTTP ${res.status}`);
        }
        if (controller.signal.aborted || reqSeq !== gaiaReqSeqRef.current) return;
        const payload = data as GaiaLivePayload;
        setLivePayload(payload);
        if (!isReplayingRef.current && !isReplayFrozenRef.current) {
          const winStart = sHour === 0 ? 0 : sHour === 7 ? 420 : sHour === 8 ? 480 : 570;
          const winEnd = sHour === 0 ? 1440 : 1020;
          let lastAllowed = payload.candles.length - 1;
          for (let i = payload.candles.length - 1; i >= 0; i--) {
            const m = getCandleEtMinutes(payload.candles[i]);
            if (m !== null && m >= winStart && m <= winEnd) {
              lastAllowed = i;
              break;
            }
          }
          setActiveBarIndex(Math.max(0, lastAllowed));
          setHoverBarIndex(null);
        }
      } catch (err) {
        if (controller.signal.aborted || reqSeq !== gaiaReqSeqRef.current) return;
        if (!silent) {
          const msg =
            err instanceof Error
              ? err.message
              : "Live market feed unavailable";
          setErrorMsg(msg);
        }
      } finally {
        clearTimeout(fetchTimeout);
        if (reqSeq === gaiaReqSeqRef.current) {
          gaiaInFlightRef.current = false;
          setIsLoading(false);
        }
      }
    },
    [startHour]
  );

  // Browser back/forward ?ticker= URL sync
  useEffect(() => {
    const handlePopState = () => {
      const urlTicker = new URLSearchParams(window.location.search)
        .get("ticker")
        ?.trim()
        .toUpperCase();
      if (urlTicker && urlTicker !== loadedTicker) {
        prevStoreTickerRef.current = urlTicker;
        setTickerInput(urlTicker);
        setLoadedTicker(urlTicker);
        setStoreTicker(urlTicker);
        setLivePayload(null);
        isReplayingRef.current = false;
        setIsReplaying(false);
        isReplayFrozenRef.current = false;
        setIsReplayFrozen(false);
        setSelectedSessionIso("");
        resetViewportTo24H();
      }
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [loadedTicker, setStoreTicker, resetViewportTo24H]);

  // Initial load and sync when global store ticker changes externally
  useEffect(() => {
    if (storeTicker !== prevStoreTickerRef.current) {
      prevStoreTickerRef.current = storeTicker;
      if (storeTicker && storeTicker !== loadedTicker) {
        setTickerInput(storeTicker);
        setLoadedTicker(storeTicker);
        setLivePayload(null);
        setSelectedSessionIso("");
        isReplayingRef.current = false;
        setIsReplaying(false);
        isReplayFrozenRef.current = false;
        setIsReplayFrozen(false);
        resetViewportTo24H();
        syncTickerUrlParam(storeTicker);
      }
    }
  }, [storeTicker, loadedTicker, syncTickerUrlParam, resetViewportTo24H]);

  useEffect(() => {
    if (!urlSyncDoneRef.current && typeof window !== "undefined") {
      urlSyncDoneRef.current = true;
      const urlTicker = new URLSearchParams(window.location.search)
        .get("ticker")
        ?.trim()
        .toUpperCase();
      if (urlTicker && urlTicker !== loadedTicker) {
        prevStoreTickerRef.current = urlTicker;
        setTickerInput(urlTicker);
        setLoadedTicker(urlTicker);
        setStoreTicker(urlTicker);
        setLivePayload(null);
        isReplayingRef.current = false;
        setIsReplaying(false);
        isReplayFrozenRef.current = false;
        setIsReplayFrozen(false);
        setSelectedSessionIso("");
        return;
      }
      syncTickerUrlParam(loadedTicker);
    }
    fetchLiveGaia(loadedTicker, isHistoricalSession ? selectedSessionIso : "", startHour, false);
  }, [loadedTicker, isHistoricalSession, selectedSessionIso, startHour, fetchLiveGaia, setStoreTicker, syncTickerUrlParam]);

  useEffect(() => {
    if (!isReplaying && !isReplayFrozen && !isHistoricalSession) {
      const pollMs = effectiveRthOpen === false ? 45_000 : 8_000;
      const runSilentPoll = () => {
        if (
          !isReplayingRef.current &&
          !isReplayFrozenRef.current &&
          (typeof document === "undefined" || document.visibilityState === "visible")
        ) {
          void fetchLiveGaia(loadedTicker, "", startHour, true);
        }
      };
      const liveInterval = setInterval(runSilentPoll, pollMs);
      const onVisibilityOrFocus = () => {
        if (typeof document === "undefined" || document.visibilityState === "visible") {
          runSilentPoll();
        }
      };
      if (typeof document !== "undefined") {
        document.addEventListener("visibilitychange", onVisibilityOrFocus);
      }
      if (typeof window !== "undefined") {
        window.addEventListener("focus", onVisibilityOrFocus);
      }
      return () => {
        clearInterval(liveInterval);
        if (typeof document !== "undefined") {
          document.removeEventListener("visibilitychange", onVisibilityOrFocus);
        }
        if (typeof window !== "undefined") {
          window.removeEventListener("focus", onVisibilityOrFocus);
        }
      };
    }
  }, [loadedTicker, isHistoricalSession, startHour, isReplaying, isReplayFrozen, effectiveRthOpen, fetchLiveGaia]);

  // Instant 800ms tick reactivity for GaiaView livePayload spot, right-axis pill & forming 5m candle strictly during active RTH
  useEffect(() => {
    if (
      effectiveRthOpen !== true ||
      !liveTickPrice ||
      liveTickPrice <= 0 ||
      isReplaying ||
      isReplayFrozen ||
      isHistoricalSession
    ) {
      return;
    }
    if (storeTicker.toUpperCase() !== loadedTicker.toUpperCase()) return;
    let nextNewBarIdx: number | null = null;
    setLivePayload((prev) => {
      if (
        !prev ||
        prev.ticker.toUpperCase() !== loadedTicker.toUpperCase() ||
        isReplayingRef.current ||
        isReplayFrozenRef.current
      ) {
        return prev;
      }
      const candles = prev.candles;
      if (!candles || candles.length === 0) return prev;
      const lastCandle = candles[candles.length - 1];
      const relDiff = Math.abs(liveTickPrice - lastCandle.close) / Math.max(1, lastCandle.close);
      if (relDiff > 0.05) return prev;

      const nowSec = Math.floor(Date.now() / 1000);
      const curBucketSec = Math.floor(nowSec / 300) * 300;
      const lastTsSec = lastCandle.timestamp > 0 ? toEpochSec(lastCandle.timestamp) : 0;
      const lastBucketSec = lastTsSec > 0 ? Math.floor(lastTsSec / 300) * 300 : 0;
      const etMins = etMinutesOfDay(nowSec);
      const bounds = getSessionBoundsEt(getTodayEt());

      if (
        lastBucketSec > 0 &&
        curBucketSec > lastBucketSec &&
        curBucketSec - lastBucketSec <= 900 &&
        etMins >= bounds.rthOpenMins &&
        etMins < bounds.rthCloseMins
      ) {
        const liveP = Number(liveTickPrice.toFixed(2));
        const rolledBar: GaiaIntradayCandle = {
          ...lastCandle,
          index: candles.length,
          timestamp: curBucketSec,
          timeLabel: formatClientEtTimeLabel(curBucketSec),
          open: liveP,
          high: liveP,
          low: liveP,
          close: liveP,
        };
        const updatedCandles = [...candles, rolledBar];
        nextNewBarIdx = updatedCandles.length - 1;
        return {
          ...prev,
          spotPrice: liveP,
          candles: updatedCandles,
        };
      }

      if (
        Math.abs(liveTickPrice - lastCandle.close) < 1e-6 &&
        lastCandle.high >= liveTickPrice &&
        lastCandle.low <= liveTickPrice &&
        Math.abs((prev.spotPrice ?? 0) - liveTickPrice) < 1e-6
      ) {
        return prev;
      }

      const updatedCandles = [...candles];
      const last = { ...updatedCandles[updatedCandles.length - 1] };
      last.close = liveTickPrice;
      last.high = Math.max(last.high, liveTickPrice);
      last.low = Math.min(last.low, liveTickPrice);
      updatedCandles[updatedCandles.length - 1] = last;

      return {
        ...prev,
        spotPrice: liveTickPrice,
        candles: updatedCandles,
      };
    });
    if (nextNewBarIdx !== null && !isReplayingRef.current && !isReplayFrozenRef.current) {
      setActiveBarIndex(nextNewBarIdx);
    }
  }, [liveTickPrice, liveTickCount, effectiveRthOpen, isReplaying, isReplayFrozen, isHistoricalSession, storeTicker, loadedTicker]);

  // Observe chart container width for responsive high-DPI canvas rendering
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const updateWidth = () => {
      const parentEl = canvasRef.current?.parentElement;
      const innerW = parentEl ? parentEl.clientWidth : (el.clientWidth - 32);
      if (innerW > 200) {
        setCanvasWidth(Math.floor(innerW));
      }
    };
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const { minBarIdx, maxBarIdx } = useMemo(() => {
    const candles = livePayload?.candles ?? [];
    if (candles.length === 0) return { minBarIdx: 0, maxBarIdx: 0 };
    const winStartMins = startHour === 0 ? 0 : startHour === 7 ? 420 : startHour === 8 ? 480 : 570;
    const winEndMins = startHour === 0 ? 1440 : 1020; // 5:00 PM ET (17:00)
    let first = -1;
    let last = -1;
    for (let i = 0; i < candles.length; i++) {
      const m = getCandleEtMinutes(candles[i]);
      if (m !== null && m >= winStartMins && m <= winEndMins) {
        if (first === -1) first = i;
        last = i;
      }
    }
    if (first === -1) return { minBarIdx: 0, maxBarIdx: candles.length - 1 };
    return { minBarIdx: first, maxBarIdx: last };
  }, [livePayload, startHour]);

  // Automatic bar-by-bar replay timer scaled by replaySpeed (1x / 2x / 4x)
  useEffect(() => {
    if (!isReplaying) return;
    const intervalMs = Math.max(60, Math.round(320 / replaySpeed));
    const timer = setInterval(() => {
      setActiveBarIndex((prev) => {
        if (prev >= maxBarIdx) {
          isReplayingRef.current = false;
          setIsReplaying(false);
          isReplayFrozenRef.current = false;
          setIsReplayFrozen(false);
          return maxBarIdx;
        }
        return prev + 1;
      });
    }, intervalMs);
    return () => clearInterval(timer);
  }, [isReplaying, replaySpeed, maxBarIdx]);

  const dataset = useMemo(() => {
    if (!livePayload) return null;
    return buildLiveGaiaDataset(livePayload, exposureMode, expFilter);
  }, [livePayload, exposureMode, expFilter]);

  const chartSessionDate = useMemo<string | undefined>(() => {
    const candles = dataset?.candles;
    if (candles && candles.length > 0) {
      const lastTs = candles[candles.length - 1]?.timestamp;
      if (typeof lastTs === "number" && Number.isFinite(lastTs) && lastTs > 0) {
        const tsMs = toEpochSec(lastTs) * 1000;
        return new Intl.DateTimeFormat("en-CA", {
          timeZone: "America/New_York",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date(tsMs));
      }
    }
    const fallback = selectedSessionIso || livePayload?.sessionDate || dataset?.sessionDate;
    return fallback && /^\d{4}-\d{2}-\d{2}$/.test(fallback) ? fallback : undefined;
  }, [dataset?.candles, dataset?.sessionDate, selectedSessionIso, livePayload?.sessionDate]);

  // Historical Session Trade Signals Hook (live session uses GlobalMarketDataSync store state)
  useEffect(() => {
    if (!isHistoricalSession) {
      setServerTrades({ activePositions: {}, closedPositions: [], alerts: [], loaded: false });
      setHistoricalSupervisorPolicy(null);
      return;
    }
    if (isReplaying || isReplayFrozen) return;
    let isMounted = true;
    const controller = new AbortController();
    async function fetchSignals() {
      try {
        const dateParam = chartSessionDate ? `&date=${encodeURIComponent(chartSessionDate)}` : "";
        const res = await fetch(
          `/api/signals?ticker=${encodeURIComponent(loadedTicker)}${dateParam}`,
          {
            cache: "no-store",
            signal: controller.signal,
          }
        );
        if (!res.ok) return;
        const data = await res.json();
        if (isMounted && !controller.signal.aborted && data) {
          setServerTrades({
            activePositions: data.activePositions || {},
            closedPositions: data.closedPositions || [],
            alerts: data.alerts || [],
            loaded: true,
          });
          setHistoricalSupervisorPolicy(data.supervisorPolicy ?? null);
        }
      } catch {
        // Silent fallback
      }
    }
    void fetchSignals();
    return () => {
      isMounted = false;
      controller.abort();
    };
  }, [loadedTicker, chartSessionDate, isHistoricalSession, isReplaying, isReplayFrozen]);

  const flowVwapPoints = useMemo<FlowGammaVwapSnapshot[]>(() => {
    if (!dataset?.candles || dataset.candles.length === 0) return [];
    const allowLiveWalls =
      !isHistoricalOrReplay &&
      storeHeatmapTicker?.toUpperCase() === loadedTicker?.toUpperCase();
    return computeCanonicalPdeSeries({
      candles: dataset.candles,
      optionBuckets: livePayload?.optionBuckets,
      structuralNodes: allowLiveWalls
        ? {
            callWall: gammaLevels?.callWall,
            putWall: gammaLevels?.putWall,
            zeroGamma: gammaLevels?.zeroGamma,
          }
        : undefined,
    });
  }, [
    dataset?.candles,
    livePayload?.optionBuckets,
    isHistoricalOrReplay,
    storeHeatmapTicker,
    loadedTicker,
    gammaLevels?.callWall,
    gammaLevels?.putWall,
    gammaLevels?.zeroGamma,
  ]);

  const precomputedChartTrades = useMemo<NormalizedChartTrade[]>(
    () =>
      extractNormalizedTradesForTicker(
        dataset?.ticker || loadedTicker,
        effectiveServerTrades,
        przmHudSignals
      ),
    [dataset?.ticker, loadedTicker, effectiveServerTrades, przmHudSignals]
  );

  // Dynamic Price Domain Bounds based on Scope Preset, Zoom (yScale) and Pan (yPanOffset)
  const priceBounds = useMemo(() => {
    if (!dataset) return { yMin: 0, yMax: 100, yAxisTicks: [] };

    let anchorPrices: number[] = [];
    const isReplayActive = isReplaying || isReplayFrozen;
    const maxIdx = isReplayActive ? Math.min(activeBarIndex, dataset.candles.length - 1) : dataset.candles.length - 1;
    const visibleCandles = dataset.candles.slice(0, maxIdx + 1);
    const candleHighs = visibleCandles.map((c) => c.high);
    const candleLows = visibleCandles.map((c) => c.low);
    const spot = visibleCandles[visibleCandles.length - 1]?.close ?? dataset.priorClose;

    const lastCol = dataset.columnsByBar[Math.max(0, maxIdx)];
    const allowLiveStoreOverlay = !isReplayActive && !isHistoricalSession;
    const isLiveSynced = allowLiveStoreOverlay && storeHeatmapTicker === loadedTicker && Boolean(storeHeatmapKingNode);
    const allExpKingStrike =
      isLiveSynced && storeHeatmapKingNode?.allExpKing
        ? storeHeatmapKingNode.allExpKing
        : (lastCol?.allExpKingStrike ?? 0);
    const filteredKingStrike =
      isLiveSynced && storeHeatmapKingNode
        ? (expFilter === "0DTE" || expFilter === "NEXT") && storeHeatmapKingNode.zeroDteKing
          ? storeHeatmapKingNode.zeroDteKing
          : expFilter === "WEEK" && storeHeatmapKingNode.weeklyKing
            ? storeHeatmapKingNode.weeklyKing
            : expFilter === "ALL"
              ? storeHeatmapKingNode.allExpKing || lastCol?.filteredKingStrike || 0
              : lastCol?.filteredKingStrike ?? 0
        : (lastCol?.filteredKingStrike ?? 0);
    const activeKing = expFilter === "ALL" ? allExpKingStrike : (filteredKingStrike || allExpKingStrike);
    const apiCallWall = allowLiveStoreOverlay ? (gammaLevels?.callWall ?? 0) : 0;
    const apiPutWall = allowLiveStoreOverlay ? (gammaLevels?.putWall ?? 0) : 0;
    const apiZeroGamma = allowLiveStoreOverlay ? (gammaLevels?.zeroGamma ?? 0) : 0;

    // Include structural gamma walls/kings within ±1.75σ so key pins are never culled
    const maxStructuralReach = Math.max(Math.max(0.05, spot * 0.005), dataset.sigma1Move * 1.75);
    const nearStructuralNodes = [
      allExpKingStrike,
      activeKing,
      apiCallWall,
      apiPutWall,
      apiZeroGamma,
    ].filter((p) => p > 0 && Math.abs(p - spot) <= maxStructuralReach);

    if (scopePreset === "focus") {
      // Focus: tightly around candle action and spot (Image 2)
      anchorPrices = [
        ...(activeKing > 0 && Math.abs(activeKing - spot) <= dataset.sigma1Move * 1.15 ? [activeKing] : []),
        ...(apiCallWall > 0 && Math.abs(apiCallWall - spot) <= dataset.sigma1Move * 1.15 ? [apiCallWall] : []),
        ...(apiPutWall > 0 && Math.abs(apiPutWall - spot) <= dataset.sigma1Move * 1.15 ? [apiPutWall] : []),
        ...candleHighs,
        ...candleLows,
        spot,
        dataset.priorClose,
        dataset.priorClose + dataset.sigma1Move * 0.45,
        dataset.priorClose - dataset.sigma1Move * 0.45,
      ];
    } else if (scopePreset === "tactical") {
      // Tactical: candles + 1σ expected move + near-field structural walls/king
      anchorPrices = [
        ...nearStructuralNodes,
        ...candleHighs,
        ...candleLows,
        spot,
        dataset.priorClose - dataset.sigma1Move,
        dataset.priorClose + dataset.sigma1Move,
      ];
    } else {
      // Cone: full ±2σ cone bounds + Kings + live structural walls (Image 1)
      anchorPrices = [
        ...(allExpKingStrike > 0 ? [allExpKingStrike] : []),
        ...(filteredKingStrike > 0 ? [filteredKingStrike] : []),
        ...(apiCallWall > 0 ? [apiCallWall] : []),
        ...(apiPutWall > 0 ? [apiPutWall] : []),
        ...(apiZeroGamma > 0 ? [apiZeroGamma] : []),
        ...dataset.visibleStrikes,
        ...candleHighs,
        ...candleLows,
        dataset.priorClose - dataset.sigma2Move,
        dataset.priorClose + dataset.sigma2Move,
      ];
    }

    const minP = Math.min(...anchorPrices);
    const maxP = Math.max(...anchorPrices);
    const rawSpan = Math.max(Math.max(0.05, spot * 0.0025), maxP - minP);
    const pad = Math.max(
      Math.max(0.05, spot * 0.003),
      rawSpan * (scopePreset === "focus" ? 0.14 : 0.12)
    );

    const baseCenter = (minP + maxP) / 2;
    const baseSpan = rawSpan + pad * 2;

    const effectiveSpan = baseSpan / Math.max(0.1, yScale);
    const effectiveCenter = baseCenter + yPanOffset;

    const yMin = Number((effectiveCenter - effectiveSpan / 2).toFixed(2));
    const yMax = Number((effectiveCenter + effectiveSpan / 2).toFixed(2));
    const yAxisTicks = computeNicePriceTicks(yMin, yMax, 6);

    return { yMin, yMax, yAxisTicks };
  }, [dataset, scopePreset, expFilter, gammaLevels, yScale, yPanOffset, isReplaying, isReplayFrozen, activeBarIndex, isHistoricalSession, storeHeatmapTicker, loadedTicker, storeHeatmapKingNode]);

  const handleLoadTicker = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const cleaned = tickerInput.trim().toUpperCase() || "SPY";
    prevStoreTickerRef.current = cleaned;
    setTickerInput(cleaned);
    setStoreTicker(cleaned);
    isReplayingRef.current = false;
    setIsReplaying(false);
    isReplayFrozenRef.current = false;
    setIsReplayFrozen(false);
    setHoverBarIndex(null);
    setSelectedSessionIso("");
    resetViewportTo24H();
    syncTickerUrlParam(cleaned);
    if (cleaned !== loadedTicker) {
      setLivePayload(null);
      setLoadedTicker(cleaned);
    } else {
      fetchLiveGaia(cleaned, "", startHour, false);
    }
  };

  const handleSessionChange = (newSessionIso: string) => {
    const latestSessionIso = sessionOptions[0]?.isoDate;
    const normalizedIso =
      !newSessionIso ||
      newSessionIso === getTodayEt() ||
      (latestSessionIso && newSessionIso === latestSessionIso)
        ? ""
        : newSessionIso;
    isReplayingRef.current = false;
    setIsReplaying(false);
    isReplayFrozenRef.current = false;
    setIsReplayFrozen(false);
    setHoverBarIndex(null);
    resetViewportTo24H();
    if (normalizedIso === selectedSessionIso) {
      fetchLiveGaia(loadedTicker, normalizedIso);
    } else {
      setSelectedSessionIso(normalizedIso);
    }
  };

  const handleResetView = () => {
    setExposureMode("GEX");
    setExpFilter("ALL");
    setSelectedDateExp("");
    setStartHour(9);
    isReplayingRef.current = false;
    setIsReplaying(false);
    isReplayFrozenRef.current = false;
    setIsReplayFrozen(false);
    setActiveBarIndex(maxBarIdx);
    setHoverBarIndex(null);
    setXScale(1.0);
    setXPanOffset(0);
    setYScale(1.0);
    setYPanOffset(0);
    setDividerRatio(fluxFocusMode ? 0.88 : 0.76);
    setScopePreset("cone");
  };

  const handleResetZoom = () => {
    setStartHour(9);
    setXScale(1.0);
    setXPanOffset(0);
    setYScale(1.0);
    setYPanOffset(0);
    setScopePreset("cone");
  };

  const handleToggleReplay = () => {
    if (isReplaying) {
      isReplayingRef.current = false;
      setIsReplaying(false);
      isReplayFrozenRef.current = true;
      setIsReplayFrozen(true);
    } else {
      isReplayFrozenRef.current = false;
      setIsReplayFrozen(false);
      isReplayingRef.current = true;
      if (activeBarIndex >= maxBarIdx - 1 || activeBarIndex < minBarIdx) {
        setActiveBarIndex(minBarIdx);
      }
      setIsReplaying(true);
    }
  };

  const handleStepBar = (delta: number) => {
    isReplayingRef.current = false;
    setIsReplaying(false);
    isReplayFrozenRef.current = true;
    setIsReplayFrozen(true);
    setActiveBarIndex((prev) => Math.max(minBarIdx, Math.min(maxBarIdx, prev + delta)));
  };

  const handleSnapToLive = () => {
    isReplayingRef.current = false;
    setIsReplaying(false);
    isReplayFrozenRef.current = false;
    setIsReplayFrozen(false);
    setSelectedSessionIso("");
    setActiveBarIndex(maxBarIdx);
    setHoverBarIndex(null);
  };

  // Canvas Mouse & Interaction Handlers for Zooming, Resizing and Panning
  const handleCanvasMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || !dataset) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = rect.width > 0 ? canvasWidth / rect.width : 1;
    const scaleY = rect.height > 0 ? chartHeight / rect.height : 1;
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;

    const padLeft = CHART_PAD_LEFT;
    const rightAxisWidth = CHART_RIGHT_AXIS_WIDTH;
    const padTop = CHART_PAD_TOP;
    const padBottom = CHART_PAD_BOTTOM;
    const outlookRightX = canvasWidth - rightAxisWidth;
    const totalPlotWidth = outlookRightX - padLeft;
    const dividerX = Math.round(padLeft + totalPlotWidth * dividerRatio);

    // Check if user clicked on the Outlook Divider (horizontal divider resizing)
    if (Math.abs(x - dividerX) <= 8 && y >= padTop && y <= chartHeight - padBottom) {
      setIsDragging(true);
      setDragMode("divider");
      setDragStart({
        x,
        y,
        yPan: yPanOffset,
        yScale,
        xPan: xPanOffset,
        xScale,
        dividerRatio,
      });
      return;
    }

    // Check if user clicked on the Right Price Axis (vertical Y-axis scaling)
    if (x >= outlookRightX) {
      setIsDragging(true);
      setDragMode("scaleY");
      setDragStart({
        x,
        y,
        yPan: yPanOffset,
        yScale,
        xPan: xPanOffset,
        xScale,
        dividerRatio,
      });
      return;
    }

    // Check if user clicked on the Bottom Time Axis (horizontal time-axis scaling)
    if (y >= chartHeight - padBottom && x >= padLeft && x <= dividerX) {
      setIsDragging(true);
      setDragMode("scaleX");
      setDragStart({
        x,
        y,
        yPan: yPanOffset,
        yScale,
        xPan: xPanOffset,
        xScale,
        dividerRatio,
      });
      return;
    }

    // Default: Clicked inside chart plot area -> Pan view
    if (x >= padLeft && x <= dividerX && y >= padTop && y <= chartHeight - padBottom) {
      setIsDragging(true);
      setDragMode("pan");
      setDragStart({
        x,
        y,
        yPan: yPanOffset,
        yScale,
        xPan: xPanOffset,
        xScale,
        dividerRatio,
      });
    }
  };

  const handleCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!dataset) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = rect.width > 0 ? canvasWidth / rect.width : 1;
    const scaleY = rect.height > 0 ? chartHeight / rect.height : 1;
    const mouseX = (e.clientX - rect.left) * scaleX;
    const mouseY = (e.clientY - rect.top) * scaleY;

    const padLeft = CHART_PAD_LEFT;
    const rightAxisWidth = CHART_RIGHT_AXIS_WIDTH;
    const padTop = CHART_PAD_TOP;
    const padBottom = CHART_PAD_BOTTOM;
    const plotHeight = chartHeight - padTop - padBottom;
    const outlookRightX = canvasWidth - rightAxisWidth;
    const totalPlotWidth = outlookRightX - padLeft;
    const dividerX = Math.round(padLeft + totalPlotWidth * dividerRatio);
    const sessionWidth = dividerX - padLeft;

    if (isDragging && dragMode) {
      if (dragMode === "divider") {
        // Dragging divider moves boundary between candlesticks and outlook cone
        const newRatio = (mouseX - padLeft) / Math.max(1, totalPlotWidth);
        setDividerRatio(Math.max(0.35, Math.min(0.90, newRatio)));
      } else if (dragMode === "scaleX") {
        // Dragging horizontally on time axis stretches / compresses candle spacing
        const dx = mouseX - dragStart.x;
        const multiplier = Math.exp(dx * 0.005);
        setXScale(Math.min(4.0, Math.max(0.5, dragStart.xScale * multiplier)));
      } else if (dragMode === "scaleY") {
        // Dragging up zooms in, dragging down zooms out
        const dy = dragStart.y - mouseY;
        const multiplier = Math.exp(dy * 0.008);
        setYScale(Math.min(10.0, Math.max(0.2, dragStart.yScale * multiplier)));
      } else if (dragMode === "pan") {
        // Dragging up/down pans vertically
        const dy = mouseY - dragStart.y;
        const { yMin, yMax } = priceBounds;
        const pricePerPx = (yMax - yMin) / Math.max(1, plotHeight);
        setYPanOffset(dragStart.yPan + dy * pricePerPx);

        if (xScale > 1.0 || dragStart.xPan !== 0) {
          const dx = mouseX - dragStart.x;
          setXPanOffset(dragStart.xPan + dx);
        }
      }
      return;
    }

    let nextBarIdx: number | null = null;
    if (mouseX >= padLeft && mouseX <= dividerX) {
      const axisStartMins = startHour === 0 ? 0 : startHour === 7 ? 420 : startHour === 8 ? 480 : 570;
      const axisEndMins = startHour === 0 ? 1440 : 1020;
      const totalSessionSlots = Math.round((axisEndMins - axisStartMins) / 5);
      const stepX = (sessionWidth / totalSessionSlots) * xScale;
      let bestBarIdx = 0;
      let bestDist = Infinity;
      for (let i = 0; i <= safeActiveIdx; i++) {
        const c = dataset.candles[i];
        const etMins = c ? getCandleEtMinutes(c) : null;
        const slotIdx = etMins !== null ? (etMins - axisStartMins) / 5 : i;
        const cx = padLeft + xPanOffset + (slotIdx + 0.5) * stepX;
        const d = Math.abs(cx - mouseX);
        if (d < bestDist) {
          bestDist = d;
          bestBarIdx = i;
        }
      }
      nextBarIdx = Math.max(0, Math.min(safeActiveIdx, bestBarIdx));
    }

    pendingHoverRef.current = {
      cursor: { x: mouseX, y: mouseY },
      barIdx: nextBarIdx,
    };
    if (hoverRafRef.current === null && typeof window !== "undefined") {
      hoverRafRef.current = window.requestAnimationFrame(() => {
        hoverRafRef.current = null;
        const pending = pendingHoverRef.current;
        if (!pending) return;
        setHoverCursor(pending.cursor);
        setHoverBarIndex((prev) => (prev === pending.barIdx ? prev : pending.barIdx));
      });
    }
  };

  const handleCanvasMouseUp = () => {
    setIsDragging(false);
    setDragMode(null);
  };

  const handleCanvasMouseLeave = () => {
    pendingHoverRef.current = null;
    if (hoverRafRef.current !== null && typeof window !== "undefined") {
      window.cancelAnimationFrame(hoverRafRef.current);
      hoverRafRef.current = null;
    }
    setHoverBarIndex(null);
    setHoverCursor(null);
  };

  const handleCanvasWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    if (!e.ctrlKey && !e.metaKey && !e.altKey) return;
    e.preventDefault();
    if (e.shiftKey) {
      // Shift + Wheel zooms horizontally
      const zoomFactor = e.deltaY < 0 ? 1.12 : 0.89;
      setXScale((prev) => Math.min(4.0, Math.max(0.5, prev * zoomFactor)));
    } else {
      // Normal Wheel zooms price vertically
      const zoomFactor = e.deltaY < 0 ? 1.12 : 0.89;
      setYScale((prev) => Math.min(10.0, Math.max(0.2, prev * zoomFactor)));
    }
  };

  const handleCanvasDoubleClick = () => {
    setStartHour(9);
    setYScale(1.0);
    setYPanOffset(0);
    setXScale(1.0);
    setXPanOffset(0);
    setDividerRatio(fluxFocusMode ? 0.88 : 0.76);
    setScopePreset("cone");
  };

  const handleCanvasKeyDown = (e: React.KeyboardEvent<HTMLCanvasElement>) => {
    if (!dataset || dataset.candles.length === 0) return;

    if (e.key === "ArrowLeft") {
      e.preventDefault();
      handleStepBar(-1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      handleStepBar(1);
    } else if (e.key === "Home") {
      e.preventDefault();
      isReplayingRef.current = false;
      setIsReplaying(false);
      isReplayFrozenRef.current = true;
      setIsReplayFrozen(true);
      setActiveBarIndex(0);
    } else if (e.key === "End") {
      e.preventDefault();
      handleSnapToLive();
    } else if (e.key === " " || e.key === "Spacebar") {
      e.preventDefault();
      handleToggleReplay();
    } else if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      setYScale((s) => Math.min(10.0, s * 1.22));
    } else if (e.key === "-" || e.key === "_") {
      e.preventDefault();
      setYScale((s) => Math.max(0.2, s * 0.82));
    } else if (e.key === "0") {
      e.preventDefault();
      setStartHour(9);
      setYScale(1.0);
      setYPanOffset(0);
      setXScale(1.0);
      setXPanOffset(0);
      setDividerRatio(fluxFocusMode ? 0.88 : 0.76);
      setScopePreset("cone");
    }
  };

  const currentTotalPlotWidth = canvasWidth - CHART_PAD_LEFT - CHART_RIGHT_AXIS_WIDTH;
  const currentDividerX = Math.round(CHART_PAD_LEFT + currentTotalPlotWidth * dividerRatio);
  const isNearDivider =
    hoverCursor &&
    Math.abs(hoverCursor.x - currentDividerX) <= 8 &&
    hoverCursor.y >= CHART_PAD_TOP &&
    hoverCursor.y <= chartHeight - CHART_PAD_BOTTOM;

  const isBottomTimeAxis =
    hoverCursor &&
    hoverCursor.y >= chartHeight - CHART_PAD_BOTTOM &&
    hoverCursor.x >= CHART_PAD_LEFT &&
    hoverCursor.x < currentDividerX;

  const cursorStyle = isDragging
    ? dragMode === "divider"
      ? "col-resize"
      : dragMode === "scaleX"
        ? "ew-resize"
        : dragMode === "scaleY"
          ? "ns-resize"
          : "grabbing"
    : isNearDivider
      ? "col-resize"
      : hoverCursor && hoverCursor.x >= canvasWidth - CHART_RIGHT_AXIS_WIDTH
        ? "ns-resize"
        : isBottomTimeAxis
          ? "ew-resize"
          : "crosshair";

  const safeActiveIdx = dataset ? Math.max(minBarIdx, Math.min(activeBarIndex, maxBarIdx, dataset.candles.length - 1)) : 0;
  const getCurrentBarCountdownStr = (): string => {
    if (isHistoricalOrReplay) {
      const barLabel = dataset?.candles[safeActiveIdx]?.timeLabel;
      return barLabel ? barLabel.replace(/\s*ET$/i, "") : "REPLAY";
    }
    if (effectiveRthOpen === false) {
      return "RTH CLOSED";
    }
    const now = new Date();
    const rem = 300 - ((now.getUTCMinutes() % 5) * 60 + now.getUTCSeconds());
    const m = Math.floor(rem / 60);
    const s = rem % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  };
  const displayBarIdx =
    hoverBarIndex !== null
      ? Math.min(safeActiveIdx, hoverBarIndex)
      : safeActiveIdx;

  const activeCandle = dataset?.candles[displayBarIdx];
  const activeBookCol = dataset?.columnsByBar[displayBarIdx];
  const liveBarIdx = dataset && dataset.candles.length > 0 ? dataset.candles.length - 1 : 0;
  const structuralBarIdx = (isReplaying || isReplayFrozen) ? Math.min(safeActiveIdx, liveBarIdx) : liveBarIdx;
  const structuralBookCol = dataset?.columnsByBar[structuralBarIdx] ?? activeBookCol;
  const isLiveHeatmapSynced = !(isReplaying || isReplayFrozen || isHistoricalSession) && storeHeatmapTicker === loadedTicker && Boolean(storeHeatmapKingNode);
  const liveAllExpKingStrike =
    isLiveHeatmapSynced && storeHeatmapKingNode && storeHeatmapKingNode.allExpKing > 0
      ? storeHeatmapKingNode.allExpKing
      : structuralBookCol?.allExpKingStrike ?? 0;
  const liveFilteredKingStrike =
    isLiveHeatmapSynced && storeHeatmapKingNode
      ? (expFilter === "0DTE" || expFilter === "NEXT") && storeHeatmapKingNode.zeroDteKing
        ? storeHeatmapKingNode.zeroDteKing
        : expFilter === "WEEK" && storeHeatmapKingNode.weeklyKing
          ? storeHeatmapKingNode.weeklyKing
          : expFilter === "ALL"
            ? storeHeatmapKingNode.allExpKing || structuralBookCol?.filteredKingStrike || 0
            : structuralBookCol?.filteredKingStrike ?? 0
      : structuralBookCol?.filteredKingStrike ?? 0;

  const sessionOptions: GaiaSessionOption[] = livePayload?.sessions ?? [];
  const expirationOptions: GaiaExpirationInfo[] =
    livePayload?.expirations ?? [];
  const has0DteActive = Boolean(livePayload?.has0DteActive);
  const nextExpPillLabel = has0DteActive ? "0DTE" : "Next exp";
  const nextExpShortDate = expirationOptions[0]?.dateLabel ?? "";

  const canvasFilterBadgePrefix =
    expFilter === "ALL" || expFilter === "NEXT"
      ? has0DteActive
        ? "0DTE"
        : "Next exp"
      : expFilter === "WEEK"
        ? "Week"
        : `${expFilter}`;

  // High-DPI 5-Layer Canvas Rendering Engine
  useEffect(() => {
    if (!dataset || !activeBookCol) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    const width = canvasWidth;
    const height = chartHeight;

    const targetW = Math.floor(width * dpr);
    const targetH = Math.floor(height * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    } else {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }

    ctx.save();
    ctx.scale(dpr, dpr);

    // Clear canvas background (Pitch black for high-contrast Atlas luminous beads)
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, width, height);

    // 1. Reserve 84px right-hand axis gutter for {Strike} — {Concentration %} & countdown badge
    const padLeft = CHART_PAD_LEFT;
    const rightAxisWidth = CHART_RIGHT_AXIS_WIDTH;
    const outlookRightX = width - rightAxisWidth;
    const padTop = 18;
    const padBottom = 32;
    const plotHeight = height - padTop - padBottom;
    const totalPlotWidth = outlookRightX - padLeft;

    // Left Zone (custom width via dividerRatio) & Right Zone (outlook Zone)
    const dividerX = Math.round(padLeft + totalPlotWidth * dividerRatio);
    const sessionWidth = dividerX - padLeft;
    const axisStartMins = startHour === 0 ? 0 : startHour === 7 ? 420 : startHour === 8 ? 480 : 570;
    const axisEndMins = startHour === 0 ? 1440 : 1020;
    const totalSessionSlots = Math.round((axisEndMins - axisStartMins) / 5);

    const { yMin, yMax, yAxisTicks } = priceBounds;
    const priceToY = (price: number): number => {
      const ratio = (price - yMin) / Math.max(0.0001, yMax - yMin);
      return padTop + (1 - ratio) * plotHeight;
    };

    const candleSlotIndices = dataset.candles.map((c, idx) => {
      const etMins = getCandleEtMinutes(c);
      if (etMins !== null) {
        return (etMins - axisStartMins) / 5;
      }
      return idx;
    });

    const barToX = (barIdx: number): number => {
      const stepX = (sessionWidth / totalSessionSlots) * xScale;
      const slotIdx = candleSlotIndices[barIdx] ?? barIdx;
      return padLeft + xPanOffset + (slotIdx + 0.5) * stepX;
    };

    const minsToX = (etMins: number): number => {
      const rawRatio = (etMins - axisStartMins) / Math.max(5, axisEndMins - axisStartMins);
      return padLeft + xPanOffset + rawRatio * sessionWidth * xScale;
    };

    // Subtle horizontal grid lines at the price axis ticks
    ctx.strokeStyle = "rgba(30, 38, 56, 0.55)";
    ctx.lineWidth = 1;
    yAxisTicks.forEach((tickPrice) => {
      const y = Math.round(priceToY(tickPrice)) + 0.5;
      if (y >= padTop && y <= height - padBottom) {
        ctx.beginPath();
        ctx.moveTo(padLeft, y);
        ctx.lineTo(outlookRightX, y);
        ctx.stroke();
      }
    });

    // Vertical outlook divider line and right boundary border at outlookRightX
    const isDividerActive = isDragging && dragMode === "divider";
    ctx.strokeStyle = isDividerActive || isNearDivider ? "#38bdf8" : "#1e2638";
    ctx.lineWidth = isDividerActive || isNearDivider ? 1.75 : 1;
    ctx.beginPath();
    ctx.moveTo(dividerX + 0.5, padTop);
    ctx.lineTo(dividerX + 0.5, height - padBottom);
    ctx.stroke();

    // 3 subtle vertical grip dots at the center of the divider for clear drag affordance
    ctx.save();
    ctx.fillStyle = isDividerActive || isNearDivider ? "#38bdf8" : "rgba(148, 163, 184, 0.4)";
    const midY = (padTop + height - padBottom) / 2;
    for (let dot = -1; dot <= 1; dot++) {
      ctx.beginPath();
      ctx.arc(dividerX + 0.5, midY + dot * 7, 1.75, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    ctx.strokeStyle = "#1e2638";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(outlookRightX + 0.5, padTop);
    ctx.lineTo(outlookRightX + 0.5, height - padBottom);
    ctx.stroke();

    // Clip plot layers to avoid overflowing top padding or bottom time axis
    ctx.save();
    ctx.beginPath();
    ctx.rect(padLeft, padTop, totalPlotWidth, plotHeight);
    ctx.clip();

    // =========================================================================
    // LAYER 1: Intraday Strike Position & Exposure Growth Over Time (Atlas Scheme)
    // =========================================================================
    let maxSessionExposure = 1;
    for (let t = 0; t <= safeActiveIdx; t++) {
      const col = dataset.columnsByBar[t];
      if (!col) continue;
      for (const s of dataset.visibleStrikes) {
        const absVal = Math.abs(col.strikeValues[s] ?? 0);
        if (absVal > maxSessionExposure) maxSessionExposure = absVal;
      }
    }

    const colStepX = sessionWidth / totalSessionSlots;
    const allExpKingStrike = liveAllExpKingStrike || structuralBookCol?.allExpKingStrike || 0;
    const filteredKingStrike = liveFilteredKingStrike || structuralBookCol?.filteredKingStrike || 0;

    // Determine Call Wall (largest positive exposure) and Put Wall (largest negative exposure)
    // Prefer authoritative signed GEX walls from /api/options (gammaLevels), falling back to signed strike scan
    let signedCallStrike = 0;
    let signedPutStrike = 0;
    let maxCallVal = 0;
    let maxPutVal = 0;
    for (const s of dataset.visibleStrikes) {
      const val = (structuralBookCol ?? activeBookCol)!.strikeValues[s] ?? 0;
      if (val > maxCallVal) {
        maxCallVal = val;
        signedCallStrike = s;
      }
      if (val < maxPutVal) {
        maxPutVal = val;
        signedPutStrike = s;
      }
    }
    const hasSignedPutBook = maxPutVal < 0;
    const allowLiveGammaOverlay = !isHistoricalOrReplay;
    const callWallStrike =
      allowLiveGammaOverlay && gammaLevels?.callWall && gammaLevels.callWall > 0
        ? gammaLevels.callWall
        : hasSignedPutBook && signedCallStrike > 0
          ? signedCallStrike
          : 0;
    const putWallStrike =
      allowLiveGammaOverlay && gammaLevels?.putWall && gammaLevels.putWall > 0
        ? gammaLevels.putWall
        : hasSignedPutBook && signedPutStrike > 0
          ? signedPutStrike
          : 0;

    // Determine Zero Gamma level (store gammaLevels or exact exposure sign-crossing interpolation)
    let zeroGammaLevel =
      allowLiveGammaOverlay && gammaLevels?.zeroGamma && gammaLevels.zeroGamma > 0 ? gammaLevels.zeroGamma : 0;
    if (zeroGammaLevel <= 0 && dataset.visibleStrikes.length > 1) {
      const ascStrikes = [...dataset.visibleStrikes].sort((a, b) => a - b);
      const refSpot = dataset.candles[safeActiveIdx]?.close ?? dataset.priorClose;
      let bestDist = Infinity;
      for (let i = 0; i < ascStrikes.length - 1; i++) {
        const s1 = ascStrikes[i];
        const s2 = ascStrikes[i + 1];
        const v1 = (structuralBookCol ?? activeBookCol)!.strikeValues[s1] ?? 0;
        const v2 = (structuralBookCol ?? activeBookCol)!.strikeValues[s2] ?? 0;
        if ((v1 <= 0 && v2 >= 0) || (v1 >= 0 && v2 <= 0)) {
          const denom = Math.abs(v1) + Math.abs(v2);
          const cross = denom > 0 ? s1 + (Math.abs(v1) / denom) * (s2 - s1) : (s1 + s2) / 2;
          const d = Math.abs(cross - refSpot);
          if (d < bestDist) {
            bestDist = d;
            zeroGammaLevel = cross;
          }
        }
      }
    }

    // =========================================================================
    // LAYER 1A: Crisp Dotted Institutional Structural Levels (`padLeft` -> `dividerX`)
    // =========================================================================
    interface StructuralLineSpec {
      price: number;
      stroke: string;
      dash: number[];
      lineWidth: number;
      label: string;
      textColor: string;
      priority: number;
    }

    const dayPlus1 = dataset.priorClose + dataset.sigma1Move;
    const dayMinus1 = dataset.priorClose - dataset.sigma1Move;
    const dayPlus2 = dataset.priorClose + dataset.sigma2Move;
    const dayMinus2 = dataset.priorClose - dataset.sigma2Move;
    const pdhPrice =
      (livePayload as (GaiaLivePayload & { pdh?: number }) | null)?.pdh ?? 0;
    const pdlPrice =
      (livePayload as (GaiaLivePayload & { pdl?: number }) | null)?.pdl ?? 0;

    const structuralSpecs: StructuralLineSpec[] = [];

    // 1. All-Exp King & Active Filtered King Node
    if (allExpKingStrike > 0) {
      structuralSpecs.push({
        price: allExpKingStrike,
        stroke: "rgba(250, 204, 21, 0.75)",
        dash: [4, 4],
        lineWidth: 1.25,
        label: `ALL-EXP KING ${allExpKingStrike}`,
        textColor: "#facc15",
        priority: 100,
      });
    }
    if (filteredKingStrike > 0 && filteredKingStrike !== allExpKingStrike) {
      structuralSpecs.push({
        price: filteredKingStrike,
        stroke: "rgba(250, 204, 21, 0.75)",
        dash: [4, 4],
        lineWidth: 1.25,
        label: `${canvasFilterBadgePrefix.toUpperCase()} KING ${filteredKingStrike}`,
        textColor: "#facc15",
        priority: 95,
      });
    }

    // 2. Call Wall
    if (callWallStrike > 0) {
      structuralSpecs.push({
        price: callWallStrike,
        stroke: "rgba(34, 211, 238, 0.65)",
        dash: [3, 3],
        lineWidth: 1.0,
        label: `CALL WALL ${callWallStrike}`,
        textColor: "#22d3ee",
        priority: 85,
      });
    }

    // 3. Put Wall
    if (putWallStrike > 0) {
      structuralSpecs.push({
        price: putWallStrike,
        stroke: "rgba(192, 132, 252, 0.65)",
        dash: [3, 3],
        lineWidth: 1.0,
        label: `PUT WALL ${putWallStrike}`,
        textColor: "#c084fc",
        priority: 85,
      });
    }

    // 4. Zero Gamma (Standardized Amber semantic polarity)
    if (zeroGammaLevel > 0) {
      structuralSpecs.push({
        price: zeroGammaLevel,
        stroke: "rgba(245, 158, 11, 0.78)",
        dash: [5, 4],
        lineWidth: 1.15,
        label: `ZERO Γ ${zeroGammaLevel.toFixed(1)}`,
        textColor: "#fbbf24",
        priority: 90,
      });
    }

    // 5. Expected Move Bounds (+1σ / -1σ / +2σ / -2σ / PDH / PDL)
    const mutedRefLevels: Array<{ price: number; tag: string }> = [
      { price: dayPlus1, tag: `+1σ ${dayPlus1.toFixed(1)}` },
      { price: dayMinus1, tag: `-1σ ${dayMinus1.toFixed(1)}` },
      { price: dayPlus2, tag: `+2σ ${dayPlus2.toFixed(1)}` },
      { price: dayMinus2, tag: `-2σ ${dayMinus2.toFixed(1)}` },
      { price: pdhPrice, tag: `PDH ${pdhPrice.toFixed(1)}` },
      { price: pdlPrice, tag: `PDL ${pdlPrice.toFixed(1)}` },
    ];
    for (const ref of mutedRefLevels) {
      if (ref.price > 0) {
        structuralSpecs.push({
          price: ref.price,
          stroke: "rgba(148, 163, 184, 0.35)",
          dash: [2, 4],
          lineWidth: 1.0,
          label: ref.tag,
          textColor: "rgba(148, 163, 184, 0.78)",
          priority: 40,
        });
      }
    }

    // Group co-located strikes (e.g., KING == CALL WALL) and de-collide micro-labels
    structuralSpecs.sort((a, b) => b.priority - a.priority);
    const mergedLines: Array<StructuralLineSpec & { y: number }> = [];
    for (const spec of structuralSpecs) {
      const y = Math.round(priceToY(spec.price)) + 0.5;
      if (y < padTop + 2 || y > height - padBottom - 2) continue;
      const samePrice = mergedLines.find((m) => Math.abs(m.price - spec.price) < 0.05);
      if (samePrice) {
        if (
          spec.priority >= 80 &&
          !samePrice.label.includes(spec.label.split(" ")[0])
        ) {
          samePrice.label = `${samePrice.label} · ${spec.label.replace(/\s+\d+(\.\d+)?$/, "")}`;
        }
        continue;
      }
      mergedLines.push({ ...spec, y });
    }

    // Unified Y-Axis Collision Resolver (>= 15px vertical separation covering Live Spot Pill, Horizontal Levels, and Right Gutter)
    const curSpot = dataset.candles[safeActiveIdx]?.close ?? dataset.priorClose;
    const spotX = barToX(safeActiveIdx);
    const ySpot = priceToY(curSpot);
    const badgeW = 76;
    const badgeH = 24;
    const spotBadgeBy = Math.max(padTop + 1, Math.min(height - padBottom - badgeH - 1, ySpot - badgeH / 2));
    const spotCenterY = spotBadgeBy + badgeH / 2;
    const spotHalfH = badgeH / 2;
    const MIN_LABEL_SEP_PX = 15;

    const hasYCollision = (
      occupied: Array<{ centerY: number; halfH: number }>,
      candCenterY: number,
      candHalfH: number = 5
    ) =>
      occupied.some((o) => {
        const minReq =
          o.halfH > candHalfH
            ? o.halfH + MIN_LABEL_SEP_PX
            : Math.max(MIN_LABEL_SEP_PX, o.halfH + candHalfH + 5);
        return Math.abs(o.centerY - candCenterY) < minReq;
      });

    ctx.save();
    ctx.font = "bold 9px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    const occupiedLevelBoxes: Array<{ centerY: number; halfH: number }> =
      ySpot >= padTop && ySpot <= height - padBottom
        ? [{ centerY: spotCenterY, halfH: spotHalfH }]
        : [];
    // Draw all horizontal lines first, then place labels in strict top-to-bottom price order
    for (const ln of mergedLines) {
      ctx.strokeStyle = ln.stroke;
      ctx.lineWidth = ln.lineWidth;
      ctx.setLineDash(ln.dash);
      ctx.beginPath();
      ctx.moveTo(padLeft, ln.y);
      ctx.lineTo(dividerX, ln.y);
      ctx.stroke();
    }

    const sortedByPriceDesc = [...mergedLines].sort((a, b) => b.price - a.price);
    let prevLabelCenterY = -Infinity;
    for (const ln of sortedByPriceDesc) {
      // Natural placement: 7px above the line, flipping 7px below only if too close to top edge
      let targetCenterY = ln.y - 7 < padTop + 8 ? ln.y + 7 : ln.y - 7;
      // Avoid Live Spot Pill box while keeping monotonic top-to-bottom order
      if (
        ySpot >= padTop &&
        ySpot <= height - padBottom &&
        Math.abs(targetCenterY - spotCenterY) < spotHalfH + 7
      ) {
        targetCenterY = ln.y <= spotCenterY ? spotCenterY - spotHalfH - 7 : spotCenterY + spotHalfH + 7;
      }
      // Enforce strict top-to-bottom ordering (>= MIN_LABEL_SEP_PX below previous higher-priced label)
      if (targetCenterY < prevLabelCenterY + MIN_LABEL_SEP_PX) {
        targetCenterY = prevLabelCenterY + MIN_LABEL_SEP_PX;
      }
      if (hasYCollision(occupiedLevelBoxes, targetCenterY, 5)) {
        const belowSpot = spotCenterY + spotHalfH + MIN_LABEL_SEP_PX;
        if (belowSpot >= prevLabelCenterY + MIN_LABEL_SEP_PX) {
          targetCenterY = belowSpot;
        }
      }
      if (targetCenterY > height - padBottom - 16) continue;
      occupiedLevelBoxes.push({ centerY: targetCenterY, halfH: 5 });

      const deltaFromLine = targetCenterY - ln.y;
      if (Math.abs(deltaFromLine) > 10) {
        ctx.save();
        ctx.setLineDash([]);
        ctx.strokeStyle = ln.stroke;
        ctx.lineWidth = 0.75;
        ctx.beginPath();
        ctx.moveTo(dividerX - 3, ln.y);
        ctx.lineTo(dividerX - 3, targetCenterY);
        ctx.stroke();
        ctx.restore();
      }
      ctx.textBaseline = "middle";
      ctx.fillStyle = ln.textColor;
      ctx.fillText(ln.label, dividerX - 6, targetCenterY);
      prevLabelCenterY = targetCenterY;
    }
    ctx.restore();
    ctx.setLineDash([]);

    // =========================================================================
    // LAYER 1B: Flow Gamma VWAP Flux Field Corridor (Rendered behind candlesticks)
    // =========================================================================
    if (flowVwapPoints.length > 0) {
      drawFlowGammaVwapOverlay({
        ctx,
        points: flowVwapPoints,
        safeActiveIdx,
        barToX,
        priceToY,
        padLeft,
        plotRightX: dividerX,
        padTop,
        padBottom,
        chartHeight: height,
        rightAxisWidth,
        showCenterline: true,
        showBands: true,
        showShading: true,
        showConfluenceMarkers: false,
        showRightAxisBadge: false,
        strikeNodes: [],
        referenceBadges: [],
        candles: dataset.candles,
      });
    }

    // Strike matrix and bead dots completely purged - zero dot clutter

    // =========================================================================
    // LAYER 2: Book Center & Moving Averages
    // =========================================================================
    // 1. Book Center: 1.25px dotted white/silver line (#cbd5e1, lineDash [2, 3])
    if (safeActiveIdx >= 1) {
      ctx.save();
      ctx.strokeStyle = "#cbd5e1";
      ctx.lineWidth = 1.25;
      ctx.setLineDash([2, 3]);
      ctx.lineJoin = "round";
      ctx.beginPath();
      for (let t = 0; t <= safeActiveIdx; t++) {
        const x = barToX(t);
        const y = priceToY(dataset.columnsByBar[t].bookCenter);
        if (t === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    // Stepped daily MAs purged (white stepped line stripped)

    // 3. Dynamic Intraday SMA 34 (5m) (1.75px, #ef4444 when close < sma34, #22c55e when close >= sma34)
    if (safeActiveIdx >= 1) {
      ctx.save();
      ctx.lineWidth = 1.75;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      for (let t = 1; t <= safeActiveIdx; t++) {
        const prevBar = dataset.candles[t - 1];
        const curBar = dataset.candles[t];
        ctx.strokeStyle =
          curBar.close >= curBar.sma34 ? "#22c55e" : "#ef4444";
        ctx.beginPath();
        ctx.moveTo(barToX(t - 1), priceToY(prevBar.sma34));
        ctx.lineTo(barToX(t), priceToY(curBar.sma34));
        ctx.stroke();
      }
      ctx.restore();
    }

    // =========================================================================
    // LAYER 3: 5-Minute Candlesticks & Non-Repainting Pivot Divergence Engine
    // =========================================================================
    const candleBodyWidth = Math.max(3, Math.min(6.5, colStepX * 0.58));

    for (let t = 0; t <= safeActiveIdx; t++) {
      const c = dataset.candles[t];
      const x = barToX(t);
      const yHigh = priceToY(c.high);
      const yLow = priceToY(c.low);
      const yOpen = priceToY(c.open);
      const yClose = priceToY(c.close);
      const isBull = c.close >= c.open;
      const color =
        atlasPalette === "ice"
          ? isBull
            ? "#60a5fa"
            : "#cbd5e1"
          : isBull
            ? "#22c55e"
            : "#ef4444";

      // High-Low Wick
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.15;
      ctx.beginPath();
      ctx.moveTo(x, yHigh);
      ctx.lineTo(x, yLow);
      ctx.stroke();

      // Open-Close Body
      const bodyTop = Math.min(yOpen, yClose);
      const bodyH = Math.max(1.8, Math.abs(yClose - yOpen));
      ctx.fillStyle = color;
      ctx.fillRect(
        x - candleBodyWidth / 2,
        bodyTop,
        candleBodyWidth,
        bodyH
      );
    }



    // Non-Repainting 3-Left / 3-Right Pivot Divergence Lines & Triangles
    const drawTriangle = (tx: number, ty: number, isBull: boolean, isNearLevel: boolean = false) => {
      ctx.fillStyle = isBull ? "#22c55e" : "#ef4444";
      ctx.beginPath();
      if (isBull) {
        ctx.moveTo(tx, ty + 3);
        ctx.lineTo(tx - 3.8, ty + 9.5);
        ctx.lineTo(tx + 3.8, ty + 9.5);
      } else {
        ctx.moveTo(tx, ty - 3);
        ctx.lineTo(tx - 3.8, ty - 9.5);
        ctx.lineTo(tx + 3.8, ty - 9.5);
      }
      ctx.closePath();
      ctx.fill();
      if (isNearLevel) {
        ctx.strokeStyle = "#facc15";
        ctx.lineWidth = 1.4;
        ctx.stroke();
      }
    };

    const curKing = liveAllExpKingStrike || (dataset.columnsByBar[safeActiveIdx]?.allExpKingStrike ?? 0);
    for (const sig of dataset.pivotSignals5m) {
      if (safeActiveIdx < sig.confirmedAtIndex) continue;

      const x2 = barToX(sig.p2Index);
      const y2 = priceToY(sig.p2Price);
      const isNear = curKing > 0 && Math.abs(sig.p2Price - curKing) / curKing <= 0.0015;

      ctx.save();
      if (sig.p1Index >= 0) {
        const x1 = barToX(sig.p1Index);
        const y1 = priceToY(sig.p1Price);

        // Solid white line (#ffffff, 2px) connecting pivot wicks P1 to P2
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();

        drawTriangle(x1, y1, sig.type === "BULL", false);
      }

      drawTriangle(x2, y2, sig.type === "BULL", isNear);
      ctx.restore();
    }

    // =========================================================================
    // LAYER 4: Right-Gutter Dealer GEX/VEX Strike Profile Histogram & ±1σ EM Bracket
    // =========================================================================
    const gutterWidth = Math.max(0, outlookRightX - dividerX);
    if (gutterWidth >= 18) {
      const profileCol = structuralBookCol ?? activeBookCol;
      const profileValues = profileCol?.strikeValues ?? {};
      const maxProfileAbs = Math.max(
        1,
        ...dataset.visibleStrikes.map((st) => Math.abs(profileValues[st] ?? 0))
      );
      const maxBarSpan = Math.max(8, gutterWidth - 10);
      const barBaseRightX = outlookRightX - 3;

      // Subtle ±1σ Daily Expected-Move Bracket anchored to Prior Close
      if (dataset.priorClose > 0 && dataset.sigma1Move > 0) {
        const emHighY = priceToY(dataset.priorClose + dataset.sigma1Move);
        const emLowY = priceToY(dataset.priorClose - dataset.sigma1Move);
        const clampedTopY = Math.max(padTop + 2, Math.min(height - padBottom - 2, emHighY));
        const clampedBotY = Math.max(padTop + 2, Math.min(height - padBottom - 2, emLowY));
        ctx.save();
        ctx.fillStyle = "rgba(56, 189, 248, 0.045)";
        ctx.fillRect(
          dividerX + 1,
          clampedTopY,
          gutterWidth - 2,
          Math.max(1, clampedBotY - clampedTopY)
        );
        ctx.strokeStyle = "rgba(56, 189, 248, 0.32)";
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        for (const emY of [emHighY, emLowY]) {
          if (emY >= padTop + 2 && emY <= height - padBottom - 2) {
            ctx.beginPath();
            ctx.moveTo(dividerX + 2, emY);
            ctx.lineTo(outlookRightX - 2, emY);
            ctx.stroke();
          }
        }
        ctx.setLineDash([]);
        ctx.restore();
      }

      // Horizontal strike exposure bars aligned 1:1 with priceToY(strike)
      const stepPx =
        dataset.visibleStrikes.length >= 2
          ? Math.abs(
              priceToY(dataset.visibleStrikes[0]) -
                priceToY(dataset.visibleStrikes[1])
            )
          : 8;
      const barH = Math.max(2, Math.min(7, stepPx * 0.62));
      ctx.save();
      for (const st of dataset.visibleStrikes) {
        const val = profileValues[st] ?? 0;
        if (Math.abs(val) <= 0) continue;
        const y = priceToY(st);
        if (y < padTop + 2 || y > height - padBottom - 2) continue;
        const norm = Math.min(1, Math.abs(val) / maxProfileAbs);
        const w = Math.max(2, norm * maxBarSpan);
        const isKingRow = st === allExpKingStrike || st === filteredKingStrike;
        ctx.fillStyle = isKingRow
          ? "rgba(250, 204, 21, 0.88)"
          : val >= 0
            ? "rgba(34, 211, 238, 0.62)"
            : "rgba(168, 85, 247, 0.62)";
        ctx.fillRect(barBaseRightX - w, y - barH / 2, w, barH);
      }
      ctx.restore();
    }

    // =========================================================================
    // LAYER 5.5: Authoritative Server Trades Execution Overlay (BTO/STC Markers, Trajectory & PnL Badges)
    // =========================================================================
    drawTradeExecutionMarkers({
      ctx,
      ticker: dataset.ticker || loadedTicker,
      candles: dataset.candles,
      safeActiveIdx,
      barToX,
      priceToY,
      serverTrades: effectiveServerTrades,
      fsmSignals: przmHudSignals,
      precomputedTrades: precomputedChartTrades,
      padLeft,
      plotRightX: dividerX,
      padTop,
      plotBottomY: height - padBottom,
    });

    // Restore plot clip before drawing axis labels
    ctx.restore();

    // Right Price Axis: Dedicated Gutter, Clear Price Scale & Strike Badges
    ctx.save();
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";

    // 1. Fill dedicated dark high-contrast right price axis gutter
    ctx.fillStyle = "#080c14";
    ctx.fillRect(outlookRightX, 0, rightAxisWidth, height);

    // 2. Crisp vertical boundary line between chart and price axis
    ctx.strokeStyle = "rgba(148, 163, 184, 0.35)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(outlookRightX + 0.5, padTop);
    ctx.lineTo(outlookRightX + 0.5, height - padBottom);
    ctx.stroke();

    // 3. Render prominent strike labels and track rendered Y positions
    // Reserve Live Spot Pill band FIRST so no strike, pinned King, or price tick overlaps behind it
    const occupiedGutterBoxes: Array<{ centerY: number; halfH: number; strike?: number }> =
      ySpot >= padTop && ySpot <= height - padBottom
        ? [{ centerY: spotCenterY, halfH: spotHalfH }]
        : [];
    const maxActiveExp = Math.max(
      1,
      ...Object.values((structuralBookCol ?? activeBookCol)!.strikeValues).map((v) => Math.abs(v))
    );

    // Prioritize Kings and highest-concentration strikes first when resolving >= 15px gutter slots
    const prioritizedStrikes = [...dataset.visibleStrikes].sort((a, b) => {
      const aKing = a === allExpKingStrike || a === filteredKingStrike ? 1 : 0;
      const bKing = b === allExpKingStrike || b === filteredKingStrike ? 1 : 0;
      if (aKing !== bKing) return bKing - aKing;
      return (
        Math.abs((structuralBookCol ?? activeBookCol)!.strikeValues[b] ?? 0) -
        Math.abs((structuralBookCol ?? activeBookCol)!.strikeValues[a] ?? 0)
      );
    });

    prioritizedStrikes.forEach((strike) => {
      const rawY = priceToY(strike);
      if (rawY < padTop + 2 || rawY > height - padBottom - 2) return;
      const y = Math.max(padTop + 7, Math.min(height - padBottom - 7, rawY));
      if (hasYCollision(occupiedGutterBoxes, y, 5)) return;

      const val = (structuralBookCol ?? activeBookCol)!.strikeValues[strike] ?? 0;
      const absVal = Math.abs(val);
      const concPct = Math.round((absVal / maxActiveExp) * 100);
      const isAllExpKing = strike === allExpKingStrike;
      const isFilteredKing = strike === filteredKingStrike;
      const isKing = isAllExpKing || isFilteredKing;

      // Show if concPct >= 15% or is King
      if (concPct >= 15 || isKing) {
        ctx.font = isKing
          ? "bold 10px ui-monospace, SFMono-Regular, Menlo, monospace"
          : "10px ui-monospace, SFMono-Regular, Menlo, monospace";

        if (isAllExpKing) {
          ctx.fillStyle = atlasPalette === "ice" ? "#ffffff" : "#facc15";
        } else if (isFilteredKing) {
          ctx.fillStyle = "#38bdf8";
        } else if (concPct >= 50) {
          ctx.fillStyle =
            atlasPalette === "ice"
              ? "#f1f5f9"
              : val >= 0
                ? "#38bdf8"
                : "#c084fc";
        } else {
          ctx.fillStyle = "#94a3b8";
        }

        const label =
          isAllExpKing && isFilteredKing
            ? `${strike} · King ${concPct}%`
            : isAllExpKing
              ? `${strike} · King ${concPct}%`
              : isFilteredKing
                ? `${strike} · ${canvasFilterBadgePrefix} ${concPct}%`
                : `${strike} · ${concPct}%`;
        ctx.fillText(label, outlookRightX + 7, y);

        // Tick dash on axis edge
        ctx.strokeStyle = isKing
          ? isAllExpKing
            ? "#facc15"
            : "#38bdf8"
          : "rgba(255, 255, 255, 0.25)";
        ctx.lineWidth = isKing ? 1.5 : 1;
        ctx.beginPath();
        ctx.moveTo(outlookRightX + 1, y);
        ctx.lineTo(outlookRightX + 5, y);
        ctx.stroke();

        occupiedGutterBoxes.push({ centerY: y, halfH: 5, strike });
      }
    });

    // Pinned right-axis horizon indicators if King, Call Wall, Put Wall, or Zero-Γ sit off-axis
    const pinnedKing = expFilter === "ALL" ? allExpKingStrike : (filteredKingStrike || allExpKingStrike);
    const offAxisHorizonNodes: Array<{ price: number; text: string; color: string; bold?: boolean }> = [];
    if (pinnedKing > 0) {
      const pct = expFilter === "ALL"
        ? (structuralBookCol ?? activeBookCol)!.allExpKingConcPct
        : (structuralBookCol ?? activeBookCol)!.filteredKingConcPct;
      offAxisHorizonNodes.push({
        price: pinnedKing,
        text: `${pinnedKing} · ${expFilter === "ALL" ? "King" : canvasFilterBadgePrefix} ${pct}%`,
        color: atlasPalette === "ice" ? "#ffffff" : "#facc15",
        bold: true,
      });
    }
    if (callWallStrike > 0 && callWallStrike !== pinnedKing) {
      offAxisHorizonNodes.push({ price: callWallStrike, text: `CW ${callWallStrike}`, color: "#22d3ee" });
    }
    if (putWallStrike > 0 && putWallStrike !== pinnedKing) {
      offAxisHorizonNodes.push({ price: putWallStrike, text: `PW ${putWallStrike}`, color: "#c084fc" });
    }
    if (zeroGammaLevel > 0) {
      offAxisHorizonNodes.push({ price: zeroGammaLevel, text: `0Γ ${zeroGammaLevel.toFixed(1)}`, color: "#fbbf24" });
    }

    for (const node of offAxisHorizonNodes) {
      const yMacro = priceToY(node.price);
      if (yMacro < padTop + 6 || yMacro > height - padBottom - 6) {
        const isBelow = yMacro > height - padBottom - 6;
        const basePinY = isBelow ? height - padBottom - 10 : padTop + 10;
        const dir = isBelow ? -1 : 1;
        let pinY: number | null = null;
        for (let step = 0; step < 6; step++) {
          const cand = basePinY + dir * step * MIN_LABEL_SEP_PX;
          if (
            cand >= padTop + 7 &&
            cand <= height - padBottom - 7 &&
            !hasYCollision(occupiedGutterBoxes, cand, 5)
          ) {
            pinY = cand;
            break;
          }
        }
        if (pinY !== null) {
          const arrow = isBelow ? "▼ " : "▲ ";
          ctx.font = `${node.bold ? "bold " : ""}10px ui-monospace, SFMono-Regular, Menlo, monospace`;
          ctx.fillStyle = node.color;
          ctx.fillText(`${arrow}${node.text}`, outlookRightX + 7, pinY);
          occupiedGutterBoxes.push({ centerY: pinY, halfH: 5, strike: node.price });
        }
      }
    }

    // 4. Always render standard price scale ticks (every round increment) with high contrast!
    yAxisTicks.forEach((tickPrice) => {
      const y = priceToY(tickPrice);
      if (y >= padTop + 4 && y <= height - padBottom - 4) {
        const hasDrawnNearby = hasYCollision(occupiedGutterBoxes, y, 5);
        if (!hasDrawnNearby) {
          ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
          ctx.fillStyle = "#cbd5e1"; // Bright high-contrast silver
          ctx.fillText(tickPrice.toFixed(2), outlookRightX + 7, y);
          occupiedGutterBoxes.push({ centerY: y, halfH: 5 });

          // Subtle tick notch on axis line
          ctx.strokeStyle = "rgba(148, 163, 184, 0.4)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(outlookRightX + 1, y);
          ctx.lineTo(outlookRightX + 4, y);
          ctx.stroke();
        }
      }
    });

    // Active Spot Badge on Right Axis (with Countdown Clock Timer, e.g. 774.00 02:01)
    if (ySpot >= padTop && ySpot <= height - padBottom) {
      // Dotted guide line across from active candle to spot badge
      ctx.save();
      ctx.strokeStyle = "rgba(255, 255, 255, 0.4)";
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(spotX, ySpot);
      ctx.lineTo(outlookRightX, ySpot);
      ctx.stroke();
      ctx.restore();

      // Spot Pill with Countdown Timer
      const spotLabel = curSpot.toFixed(2);
      const timerStr = getCurrentBarCountdownStr();
      const bx = outlookRightX + 4;
      const by = spotBadgeBy;

      ctx.save();
      ctx.fillStyle = "#0c101c";
      ctx.strokeStyle = "rgba(255, 255, 255, 0.55)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(bx, by, badgeW, badgeH, 4);
      ctx.fill();
      ctx.stroke();

      // Draw Price and Timer
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 10px ui-monospace, SFMono-Regular, Menlo, monospace";
      ctx.textAlign = "center";
      ctx.fillText(spotLabel, bx + badgeW / 2, by + 9);

      ctx.fillStyle = "#94a3b8";
      ctx.font = "9px ui-monospace, SFMono-Regular, Menlo, monospace";
      ctx.fillText(timerStr, bx + badgeW / 2, by + 19);
      ctx.restore();
    }
    ctx.restore();

    // Right axis hover cursor price badge
    if (
      hoverCursor &&
      hoverCursor.x >= padLeft &&
      hoverCursor.x <= outlookRightX &&
      hoverCursor.y >= padTop &&
      hoverCursor.y <= height - padBottom
    ) {
      const cursorRatio = 1 - (hoverCursor.y - padTop) / plotHeight;
      const cursorPrice = yMin + cursorRatio * (yMax - yMin);
      const hy = Math.max(padTop + 9, Math.min(height - padBottom - 9, hoverCursor.y));
      ctx.save();
      ctx.fillStyle = "#1e293b";
      ctx.strokeStyle = "#38bdf8";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(outlookRightX + 3, hy - 8, rightAxisWidth - 6, 16, 3);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = "#38bdf8";
      ctx.font = "bold 9px ui-monospace, monospace";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(cursorPrice.toFixed(2), outlookRightX + 6, hy);
      ctx.restore();
    }

    // -------------------------------------------------------------------------
    // Bottom X-Axis: Full-Session Timeline (from startHour to 16:00 Close)
    // -------------------------------------------------------------------------
    ctx.save();

    // 1. Fill high-contrast bottom time axis background gutter
    ctx.fillStyle = "#080c14";
    ctx.fillRect(0, height - padBottom, width, padBottom);

    // 2. Bottom Axis Horizontal Divider Line
    ctx.strokeStyle = "rgba(148, 163, 184, 0.35)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padLeft, height - padBottom + 0.5);
    ctx.lineTo(outlookRightX, height - padBottom + 0.5);
    ctx.stroke();

    // 3. Identify Milestone Ticks across Full Session (Past & Future)
    interface TimeAxisTick {
      x: number;
      label: string;
      isHourMark: boolean;
      isMarketOpen: boolean;
      isMarketClose: boolean;
    }

    const axisTicks: TimeAxisTick[] = [];
    const candles = dataset.candles;

    // Map past candles to hour marks if present
    const candleHourIndices = new Map<string, number>();
    if (candles && candles.length > 0) {
      candles.forEach((c, i) => {
        let timeKey = "";
        if (c.timestamp && c.timestamp > 0) {
          try {
            const d = new Date(toEpochSec(c.timestamp) * 1000);
            const et = d.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false });
            const [h, m] = et.split(":");
            if (m === "00" || (h === "09" && m === "30")) {
              timeKey = `${h}:${m}`;
            }
          } catch {}
        }
        if (!timeKey && c.timeLabel) {
          const match = c.timeLabel.match(/(\d+):(\d+)\s*(AM|PM)?/i);
          if (match) {
            let h = parseInt(match[1], 10);
            const m = match[2];
            const ampm = (match[3] || "").toUpperCase();
            if (ampm === "PM" && h < 12) h += 12;
            if (ampm === "AM" && h === 12) h = 0;
            const hh = String(h).padStart(2, "0");
            if (m === "00" || (hh === "09" && m === "30")) {
              timeKey = `${hh}:${m}`;
            }
          }
        }
        if (timeKey && !candleHourIndices.has(timeKey)) {
          candleHourIndices.set(timeKey, i);
        }
      });
    }

    // Generate 24h 3-hour milestone schedule (00:00 to 24:00 ET) in full-day mode, or hourly for filtered sessions
    const milestoneSchedule: { h: number; m: number; label: string; isMarketOpen?: boolean; isMarketClose?: boolean }[] =
      startHour === 0
        ? [
            { h: 0, m: 0, label: "12:00" },
            { h: 3, m: 0, label: "3:00" },
            { h: 6, m: 0, label: "6:00" },
            { h: 9, m: 30, label: "9:30", isMarketOpen: true },
            { h: 12, m: 0, label: "12:00" },
            { h: 16, m: 0, label: "4:00", isMarketClose: true },
            { h: 19, m: 0, label: "7:00" },
            { h: 22, m: 0, label: "10:00" },
          ]
        : (() => {
            const list: { h: number; m: number; label: string; isMarketOpen?: boolean; isMarketClose?: boolean }[] = [];
            for (let h = startHour; h <= 17; h++) {
              if (h === 9) {
                if (startHour < 9) {
                  list.push({ h: 9, m: 0, label: "9:00" });
                }
                list.push({ h: 9, m: 30, label: "9:30", isMarketOpen: true });
                continue;
              }
              if (h === 16) {
                list.push({ h: 16, m: 0, label: "4:00", isMarketClose: true });
                continue;
              }
              const displayH = h > 12 ? h - 12 : h;
              list.push({ h, m: 0, label: `${displayH}:00` });
            }
            return list;
          })();

    milestoneSchedule.forEach((ms) => {
      const timeKey = `${String(ms.h).padStart(2, "0")}:${String(ms.m).padStart(2, "0")}`;
      const etMins = ms.h * 60 + ms.m;
      let x = -1;
      if (etMins >= axisStartMins && etMins <= axisEndMins) {
        x = minsToX(etMins);
      } else if (candleHourIndices.has(timeKey)) {
        x = barToX(candleHourIndices.get(timeKey)!);
      }

      if (x >= padLeft - 4 && x <= dividerX + 4) {
        axisTicks.push({
          x: Math.min(dividerX - 2, x),
          label: ms.label,
          isHourMark: true,
          isMarketOpen: Boolean(ms.isMarketOpen),
          isMarketClose: Boolean(ms.isMarketClose),
        });
      }
    });

    // 4. Two-Pass Render: Reserve 9:30 OPEN / 4:00 CLOSE boundaries first so nearby hour ticks never collide with them
    ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textBaseline = "middle";
    const labelY = height - padBottom / 2 + 1;

    const minSpacing = 32; // minimum pixels between adjacent labels to prevent overlap
    const rthBoundaryXs = axisTicks
      .filter((t) => t.isMarketOpen || t.isMarketClose)
      .map((t) => t.x);
    let lastDrawnX = -999;
    const filteredTicks = axisTicks.filter((tick) => {
      const isRthBoundary = tick.isMarketOpen || tick.isMarketClose;
      if (isRthBoundary) {
        lastDrawnX = tick.x;
        return true;
      }
      if (rthBoundaryXs.some((rx) => Math.abs(tick.x - rx) < minSpacing)) return false;
      if (Math.abs(tick.x - lastDrawnX) < minSpacing) return false;
      lastDrawnX = tick.x;
      return true;
    });
    const drawnRthPillRects: Array<{ x1: number; x2: number }> = [];

    filteredTicks.forEach((tick) => {
      const isRthBoundary = tick.isMarketOpen || tick.isMarketClose;

      // Vertical Grid Line (or crisp #2dd4bf 1.5px RTH Open/Close boundary)
      ctx.save();
      if (isRthBoundary) {
        ctx.strokeStyle = "rgba(45, 212, 191, 0.75)";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([]);
      } else {
        ctx.strokeStyle = "rgba(148, 163, 184, 0.08)";
        ctx.lineWidth = 1;
      }
      ctx.beginPath();
      ctx.moveTo(tick.x, padTop);
      ctx.lineTo(tick.x, height - padBottom);
      ctx.stroke();

      if (isRthBoundary) {
        const tagText = tick.isMarketOpen ? "9:30 OPEN" : "4:00 CLOSE";
        ctx.font = "bold 9px ui-monospace, SFMono-Regular, Menlo, monospace";
        const tagW = ctx.measureText(tagText).width + 10;
        const tagX = Math.max(padLeft + 2, Math.min(dividerX - tagW - 2, tick.x - tagW / 2));
        const hasPillOverlap = drawnRthPillRects.some(
          (r) => !(tagX + tagW + 4 < r.x1 || tagX > r.x2 + 4)
        );
        if (!hasPillOverlap) {
          drawnRthPillRects.push({ x1: tagX, x2: tagX + tagW });

          // Top RTH boundary tag
          ctx.fillStyle = "rgba(8, 12, 20, 0.88)";
          ctx.strokeStyle = "rgba(45, 212, 191, 0.45)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.roundRect(tagX, padTop + 4, tagW, 15, 4);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = "#2dd4bf";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(tagText, tagX + tagW / 2, padTop + 11.5);

          // Bottom RTH boundary tag just above axis baseline
          const botTagY = height - padBottom - 19;
          ctx.fillStyle = "rgba(8, 12, 20, 0.88)";
          ctx.beginPath();
          ctx.roundRect(tagX, botTagY, tagW, 15, 4);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = "#2dd4bf";
          ctx.fillText(tagText, tagX + tagW / 2, botTagY + 7.5);
        }
      }
      ctx.restore();

      // Tick Dash extending down from axis baseline
      ctx.strokeStyle = isRthBoundary
        ? "#2dd4bf"
        : "rgba(148, 163, 184, 0.5)";
      ctx.lineWidth = isRthBoundary ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(tick.x, height - padBottom);
      ctx.lineTo(tick.x, height - padBottom + (isRthBoundary ? 5 : 4));
      ctx.stroke();

      // Time Text Label (RTH Open/Close in bold #2dd4bf, Hour marks in silver)
      ctx.save();
      ctx.font = isRthBoundary
        ? "bold 10px ui-monospace, SFMono-Regular, Menlo, monospace"
        : "10px ui-monospace, SFMono-Regular, Menlo, monospace";
      ctx.fillStyle = isRthBoundary ? "#2dd4bf" : "#e2e8f0";
      ctx.textAlign =
        tick.x < padLeft + 18 ? "left" : tick.x > dividerX - 18 ? "right" : "center";
      ctx.fillText(tick.label, tick.x, labelY);
      ctx.restore();
    });

    // 4. Outlook Column Label
    ctx.textAlign = "center";
    ctx.fillStyle = "#64748b";
    ctx.font = "bold 10px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillText(
      "outlook",
      dividerX + (outlookRightX - dividerX) / 2,
      labelY
    );

    // 5. Crosshair and interactive time badge on hover
    if (hoverBarIndex !== null && hoverBarIndex <= safeActiveIdx) {
      const hx = barToX(hoverBarIndex);
      ctx.save();
      ctx.strokeStyle = "rgba(148, 163, 184, 0.4)";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);

      // Vertical line snapped strictly to candle center
      ctx.beginPath();
      ctx.moveTo(hx, padTop);
      ctx.lineTo(hx, height - padBottom);
      ctx.stroke();

      // Horizontal line across the plot to the price axis
      if (
        hoverCursor &&
        hoverCursor.y >= padTop &&
        hoverCursor.y <= height - padBottom
      ) {
        ctx.beginPath();
        ctx.moveTo(padLeft, hoverCursor.y);
        ctx.lineTo(outlookRightX, hoverCursor.y);
        ctx.stroke();
      }

      // Bottom axis hover time pill badge
      const hoverCandle = dataset.candles[hoverBarIndex];
      if (hoverCandle) {
        const timeText = hoverCandle.timeLabel;
        ctx.font = "bold 9px ui-monospace, SFMono-Regular, Menlo, monospace";
        const textW = ctx.measureText(timeText).width;
        const pillW = textW + 10;
        const pillH = 16;
        const pillX = Math.max(padLeft, Math.min(dividerX - pillW, hx - pillW / 2));
        const pillY = height - padBottom + 2;

        ctx.fillStyle = "#1e293b";
        ctx.strokeStyle = "#38bdf8";
        ctx.lineWidth = 1;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.roundRect(pillX, pillY, pillW, pillH, 3);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = "#38bdf8";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(timeText, pillX + pillW / 2, pillY + pillH / 2);
      }
      ctx.restore();
    }
    ctx.restore();

    ctx.restore();
  }, [
    dataset,
    safeActiveIdx,
    hoverBarIndex,
    canvasWidth,
    chartWidth,
    dividerRatio,
    xScale,
    xPanOffset,
    startHour,
    activeBookCol,
    structuralBookCol,
    liveAllExpKingStrike,
    liveFilteredKingStrike,
    gammaLevels?.callWall,
    gammaLevels?.putWall,
    exposureMode,
    expFilter,
    canvasFilterBadgePrefix,
    priceBounds,
    chartHeight,
    flowVwapPoints,
    hoverCursor,
    atlasPalette,
    effectiveServerTrades,
    przmHudSignals,
    precomputedChartTrades,
    gammaLevels?.zeroGamma,
    livePayload,
    isHistoricalOrReplay,
    barClockTick,
    effectiveRthOpen,
  ]);

  const isSma34Bullish = activeCandle
    ? activeCandle.close >= activeCandle.sma34
    : true;
  const sliderProgressPct = maxBarIdx > minBarIdx ? ((safeActiveIdx - minBarIdx) / (maxBarIdx - minBarIdx)) * 100 : 100;

  return (
    <div className="space-y-3.5 pb-4">
      {/* 2A. Section Title & Scheme Selector */}
      <div className="space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-xl font-bold text-white tracking-tight">Gaia</h1>

            {/* Scheme Selector: Ice (Skylit) vs Polarity (GEX/VEX) */}
            <div className="bg-[#101520] border border-[#1e2638] rounded-xl p-0.5 flex items-center gap-0.5">
              <button
                type="button"
                onClick={() => setAtlasPalette("ice")}
                className={cn(
                  "px-3 py-1 rounded-lg text-xs font-semibold transition cursor-pointer flex items-center gap-1.5",
                  atlasPalette === "ice"
                    ? "bg-gradient-to-r from-teal-500/25 via-sky-500/20 to-indigo-500/25 border border-teal-400/60 text-white font-bold shadow-[0_0_10px_rgba(45,212,191,0.2)]"
                    : "text-slate-400 hover:text-white"
                )}
              >
                <span>❄ Ice (Skylit)</span>
              </button>
              <button
                type="button"
                onClick={() => setAtlasPalette("polarity")}
                className={cn(
                  "px-3 py-1 rounded-lg text-xs font-semibold transition cursor-pointer flex items-center gap-1.5",
                  atlasPalette === "polarity"
                    ? "bg-gradient-to-r from-teal-500/25 via-sky-500/20 to-indigo-500/25 border border-teal-400/60 text-white font-bold shadow-[0_0_10px_rgba(45,212,191,0.2)]"
                    : "text-slate-400 hover:text-white"
                )}
              >
                <span>⚡ Polarity (GEX/VEX)</span>
              </button>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setGuideExpanded((prev) => !prev)}
            className="text-xs font-bold text-[#38bdf8] hover:text-sky-300 transition cursor-pointer flex items-center gap-1 px-3 py-1.5 rounded-lg bg-[#101520] border border-[#1e2638]"
          >
            <span>? How to read Gaia</span>
          </button>
        </div>

        {guideExpanded && (
          <div className="bg-[#101520] border border-[#1e2638] rounded-xl px-4 pb-4 pt-3 grid grid-cols-1 md:grid-cols-[165px_1fr] gap-y-2.5 gap-x-4 text-xs leading-relaxed">
            <div className="font-bold text-white">Candles &amp; Flow VWAP</div>
            <div className="text-slate-300">
              Regular session (09:30–16:00 ET, or 13:00 ET on NYSE half-days) in causal 5-minute candles overlaid with Spectral PDE Flow-VWAP, dynamic &plusmn;1&sigma;/&plusmn;2&sigma; dispersion bands, and 5m SMA(34).
            </div>

            <div className="font-bold text-white">Right-Gutter GEX/VEX</div>
            <div className="text-slate-300">
              The right-hand outlook gutter renders live horizontal strike exposure bars (<span className="text-cyan-300 font-semibold">+GEX/+VEX</span> in cyan, <span className="text-purple-300 font-semibold">-GEX/-VEX</span> in purple, <span className="text-amber-300 font-semibold">King</span> in gold) inside the dashed &plusmn;1&sigma; daily Expected-Move bracket.
            </div>

            <div className="font-bold text-white">MTF Divergence</div>
            <div className="text-slate-300">
              Non-repainting 3-left / 3-right pivot confirmation on SPY, QQQ, SPXW, and IWM:{" "}
              <span className="text-[#22c55e] font-bold">BULL</span> when price prints a lower low while both RSI(14) and MACD(12,26,9) histogram print higher lows;{" "}
              <span className="text-[#ef4444] font-bold">BEAR</span> on a higher high with lower highs on both oscillators.
            </div>

            <div className="font-bold text-white">Execution Markers</div>
            <div className="text-slate-300">
              Authoritative server <span className="text-emerald-300 font-semibold">BTO</span> / <span className="text-amber-300 font-semibold">STC</span> markers reflect Paper/Shadow single-contract sniper entries (09:35–14:30 ET) and mandatory 15:55 ET (12:55 ET half-day) MOC exits.
            </div>
          </div>
        )}
      </div>

      {/* 2B. Session Context & Ticker Loader Bar */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400 font-mono">
          <span>
            {dataset
              ? `${dataset.ticker} · ${dataset.sessionDate} · ${dataset.bookLabel}`
              : `${loadedTicker} · loading live session...`}
          </span>
          {sessionOptions.length > 0 && (
            <label className="inline-flex items-center gap-1.5 text-[11px] text-slate-400">
              <span>Session:</span>
              <select
                aria-label="Select trading session"
                value={selectedSessionIso || livePayload?.sessionDate || ""}
                onChange={(e) => handleSessionChange(e.target.value)}
                className="bg-[#101520] border border-[#1e2638] rounded-md px-2 py-0.5 text-[11px] font-mono text-slate-300 focus:outline-none focus:border-[#38bdf8]"
              >
                {sessionOptions.map((s) => (
                  <option key={s.isoDate} value={s.isoDate}>
                    {s.isoDate}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        <form
          onSubmit={handleLoadTicker}
          className="bg-[#101520] border border-[#1e2638] rounded-xl p-1.5 flex items-center justify-between"
        >
          <input
            type="text"
            value={tickerInput}
            onChange={(e) => setTickerInput(e.target.value.toUpperCase())}
            placeholder="SPY"
            aria-label="Ticker symbol"
            className="bg-transparent text-white font-bold text-sm px-3 py-1 focus:outline-none flex-1 uppercase font-sans"
          />
          <button
            type="submit"
            disabled={
              isLoading &&
              (tickerInput.trim().toUpperCase() || "SPY") === loadedTicker
            }
            className="bg-gradient-to-r from-[#38bdf8] to-[#818cf8] text-[#090d16] font-bold text-xs px-5 py-2 rounded-lg hover:opacity-95 transition cursor-pointer disabled:opacity-50"
          >
            {isLoading &&
            (tickerInput.trim().toUpperCase() || "SPY") === loadedTicker
              ? "Loading..."
              : "Load"}
          </button>
        </form>
      </div>

      {/* 2C. Horizontal Pill Filter Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        {/* 1. Exposure Mode Group */}
        <div className="bg-[#151b28] border border-[#232d42] rounded-full p-1 flex items-center gap-1">
          {(["GEX", "VEX", "Combined"] as const).map((mode) => {
            const active = exposureMode === mode;
            return (
              <button
                key={mode}
                type="button"
                onClick={() => setExposureMode(mode)}
                className={cn(
                  "px-3.5 py-1 text-xs rounded-full transition cursor-pointer",
                  active
                    ? "bg-gradient-to-r from-[#38bdf8] to-[#818cf8] text-[#090d16] font-bold"
                    : "text-slate-300 hover:text-white"
                )}
              >
                {mode}
              </button>
            );
          })}
        </div>

        {/* 2. Expiration Filter Group */}
        <div className="bg-[#151b28] border border-[#232d42] rounded-full p-1 flex items-center gap-1">
          {[
            { id: "ALL", label: "All exp" },
            { id: "NEXT", label: nextExpPillLabel },
            { id: "WEEK", label: "This week" },
          ].map((item) => {
            const active = expFilter === item.id && selectedDateExp === "";
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setSelectedDateExp("");
                  setExpFilter(item.id);
                }}
                className={cn(
                  "px-3.5 py-1 text-xs rounded-full transition cursor-pointer",
                  active
                    ? "bg-gradient-to-r from-[#38bdf8] to-[#818cf8] text-[#090d16] font-bold"
                    : "text-slate-300 hover:text-white"
                )}
              >
                {item.label}
              </button>
            );
          })}
        </div>

        {/* 3. Date Dropdown Pill */}
        <div className="relative inline-flex items-center">
          <select
            aria-label="Filter by expiration date"
            value={selectedDateExp}
            onChange={(e) => {
              const val = e.target.value;
              setSelectedDateExp(val);
              if (val) {
                setExpFilter(val);
              } else {
                setExpFilter("ALL");
              }
            }}
            className={cn(
              "appearance-none bg-[#151b28] border border-[#232d42] rounded-full pl-3.5 pr-7 py-1.5 text-xs cursor-pointer focus:outline-none",
              selectedDateExp
                ? "text-[#38bdf8] font-bold border-[#38bdf8]/60"
                : "text-slate-200 hover:text-white"
            )}
          >
            <option value="">Date</option>
            {expirationOptions.map((exp) => (
              <option key={exp.isoDate} value={exp.dateLabel}>
                {exp.dateLabel}
              </option>
            ))}
          </select>
          <span className="pointer-events-none absolute right-2.5 text-[10px] text-slate-400">
            ▾
          </span>
        </div>

        {/* Session start locked to 9:30 AM RTH */}

        {/* Flux Focus Viewport Mode Toggle (Benchmark Image 1 Style) */}
        <button
          type="button"
          onClick={() => {
            setFluxFocusMode((prev) => {
              const next = !prev;
              setDividerRatio(next ? 0.88 : 0.65);
              return next;
            });
          }}
          className={cn(
            "rounded-full px-3 py-1.5 text-xs font-mono font-bold tracking-wider transition border cursor-pointer flex items-center gap-1.5",
            fluxFocusMode
              ? "bg-amber-500/20 text-amber-300 border-amber-400/50 shadow-[0_0_10px_rgba(245,158,11,0.25)]"
              : "bg-[#151b28] text-slate-400 border-[#232d42] hover:text-white"
          )}
          title="Toggle Full-Width Flux Corridor (88% Price Action Space) vs Expanded Outlook Cone"
        >
          <span className={cn("w-2 h-2 rounded-full", fluxFocusMode ? "bg-amber-400 animate-pulse" : "bg-slate-500")} />
          {fluxFocusMode ? "⚡ FLUX CORRIDOR: 88%" : "OUTLOOK CONE: EXPANDED"}
        </button>

        {/* 6. RTH Corridor (9:30-4:00) & Reset View Pills */}
        <button
          type="button"
          onClick={() => {
            const canvasW = canvasRef.current?.clientWidth || 1050;
            const totalPlotW = Math.max(200, canvasW - CHART_PAD_LEFT - CHART_RIGHT_AXIS_WIDTH);
            const dividerX = Math.round(CHART_PAD_LEFT + totalPlotW * dividerRatio);
            const approxSessionW = dividerX - CHART_PAD_LEFT;
            const axisStartMins = startHour === 0 ? 0 : startHour === 7 ? 420 : startHour === 8 ? 480 : 570;
            const axisEndMins = startHour === 0 ? 1440 : 1020;
            const totalSlots = Math.round((axisEndMins - axisStartMins) / 5);
            const rthOpenSlot = Math.max(0, (570 - axisStartMins) / 5);
            const paddedRthSlots = 82; // 78 RTH bars (9:30-4:00) + 2-slot symmetric margin
            const nextXScale = Math.min(4.0, totalSlots / paddedRthSlots);
            const nextStepX = (approxSessionW / totalSlots) * nextXScale;
            const nextXPan = 2 * nextStepX - rthOpenSlot * nextStepX;
            setXScale(nextXScale);
            setXPanOffset(nextXPan);
            setYScale(1.0);
            setYPanOffset(0);
          }}
          title="Frame exact 9:30 AM – 4:00 PM ET RTH corridor between boundary lines"
          className="bg-[#151b28] border border-[#2dd4bf]/45 text-[#2dd4bf] hover:bg-[#2dd4bf]/15 rounded-full px-3.5 py-1.5 text-xs font-mono font-bold transition cursor-pointer"
        >
          RTH (9:30-4:00)
        </button>

        {/* 6b. Reset View Pill */}
        <button
          type="button"
          onClick={handleResetView}
          className="bg-[#151b28] border border-[#232d42] text-slate-300 hover:text-white rounded-full px-3.5 py-1.5 text-xs transition cursor-pointer"
        >
          Reset view
        </button>

        {/* Auto Width Reset Pill (appears when width or divider is customized) */}
        {(chartWidth !== null || dividerRatio !== (fluxFocusMode ? 0.88 : 0.76) || Math.abs(xScale - 1.0) > 1e-3 || Math.abs(xPanOffset) > 1e-3 || startHour !== 9) && (
          <button
            type="button"
            onClick={() => {
              setChartWidth(null);
              setDividerRatio(fluxFocusMode ? 0.88 : 0.76);
              resetViewportTo24H();
            }}
            title="Reset horizontal width and divider back to default"
            className="bg-cyan-500/20 border border-cyan-400/50 text-cyan-300 hover:bg-cyan-500/30 rounded-full px-3.5 py-1.5 text-xs font-bold transition cursor-pointer"
          >
            Auto Width (100%)
          </button>
        )}

        {/* 7. Window Scope Presets (Focus | Tactical | Cone 2σ) */}
        <div className="bg-[#151b28] border border-[#232d42] rounded-full p-1 flex items-center gap-1 font-mono text-xs">
          <button
            type="button"
            onClick={() => {
              setScopePreset("focus");
              setYScale(1.0);
              setYPanOffset(0);
            }}
            title="Focus: Tight view centered on intraday candle action"
            className={cn(
              "px-3 py-1 text-xs rounded-full transition cursor-pointer font-bold",
              scopePreset === "focus"
                ? "bg-gradient-to-r from-[#38bdf8] to-[#818cf8] text-[#090d16]"
                : "text-slate-300 hover:text-white"
            )}
          >
            Focus
          </button>
          <button
            type="button"
            onClick={() => {
              setScopePreset("tactical");
              setYScale(1.0);
              setYPanOffset(0);
            }}
            title="Tactical: Intraday candles + 1σ expected-move range"
            className={cn(
              "px-3 py-1 text-xs rounded-full transition cursor-pointer font-bold",
              scopePreset === "tactical"
                ? "bg-gradient-to-r from-[#38bdf8] to-[#818cf8] text-[#090d16]"
                : "text-slate-300 hover:text-white"
            )}
          >
            Tactical (1σ)
          </button>
          <button
            type="button"
            onClick={() => {
              setScopePreset("cone");
              setYScale(1.0);
              setYPanOffset(0);
            }}
            title="Cone: Full options board with ±2σ expected-move cone"
            className={cn(
              "px-3 py-1 text-xs rounded-full transition cursor-pointer font-bold",
              scopePreset === "cone"
                ? "bg-gradient-to-r from-[#38bdf8] to-[#818cf8] text-[#090d16]"
                : "text-slate-300 hover:text-white"
            )}
          >
            Cone (2σ)
          </button>
        </div>

        {/* 7. Zoom & Scale Adjustments */}
        <div className="flex items-center gap-0.5 bg-[#151b28] border border-[#232d42] rounded-full p-0.5 font-mono text-xs">
          <button
            type="button"
            onClick={() => setYScale((s) => Math.max(0.2, s * 0.82))}
            title="Zoom Out (Expand Price Range)"
            className="w-6 h-6 flex items-center justify-center rounded-full text-slate-300 hover:text-white hover:bg-white/10 transition cursor-pointer font-bold"
          >
            −
          </button>
          <button
            type="button"
            onClick={handleResetZoom}
            title="Auto-Fit / Reset Zoom Scale (Double-click canvas)"
            className={cn(
              "px-2.5 py-0.5 rounded-full text-[11px] font-bold transition cursor-pointer",
              Math.abs(yScale - 1.0) > 1e-3 || Math.abs(yPanOffset) > 1e-3 || Math.abs(xScale - 1.0) > 1e-3 || Math.abs(xPanOffset) > 1e-3 || startHour !== 9
                ? "bg-cyan-500/20 text-cyan-300 border border-cyan-400/40"
                : "text-slate-400 hover:text-white"
            )}
          >
            {(yScale * 100).toFixed(0)}%
          </button>
          <button
            type="button"
            onClick={() => setYScale((s) => Math.min(10.0, s * 1.22))}
            title="Zoom In (Focus on Candlesticks)"
            className="w-6 h-6 flex items-center justify-center rounded-full text-slate-300 hover:text-white hover:bg-white/10 transition cursor-pointer font-bold"
          >
            +
          </button>
        </div>
      </div>

      {/* Error State if Live Feed Fails */}
      {errorMsg && (
        <div className="bg-red-950/40 border border-red-500/40 rounded-xl px-4 py-3 text-xs text-red-200 flex items-center justify-between">
          <span>{errorMsg}</span>
          <button
            type="button"
            onClick={() => fetchLiveGaia(loadedTicker, selectedSessionIso)}
            className="px-3 py-1 rounded-md bg-red-500/20 hover:bg-red-500/30 text-red-100 font-semibold cursor-pointer"
          >
            Retry Live Feed
          </button>
        </div>
      )}

      {/* 2D. Pre-Chart Telemetry & Legend Strip */}
      {dataset && activeCandle && activeBookCol && (() => {
        const headerBookCol = structuralBookCol ?? activeBookCol;
        return (
        <div className="space-y-2 pt-0.5">
          {/* 1. Dual Pre-Chart King Pill Badges */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="bg-yellow-500/15 border border-yellow-500/80 text-[#fde047] rounded-full px-3.5 py-1 text-xs font-bold inline-flex items-center">
              All-exp King {liveAllExpKingStrike} ·{" "}
              {formatPct(headerBookCol.allExpKingConcPct)}%
            </span>
            {(exposureMode === "VEX" || exposureMode === "Combined") && (
              <span className="bg-amber-500/15 border border-amber-400/80 text-[#fde047] rounded-full px-3.5 py-1 text-xs font-bold inline-flex items-center">
                VEX King (multi-day) {liveAllExpKingStrike}
              </span>
            )}
            {(expFilter !== "ALL" || liveAllExpKingStrike !== liveFilteredKingStrike) && (
              <span className="bg-[#151b28] border border-cyan-500/60 text-[#38bdf8] rounded-full px-3.5 py-1 text-xs font-bold inline-flex items-center">
                {expFilter === "ALL" || expFilter === "NEXT"
                  ? has0DteActive
                    ? `0DTE King ${liveFilteredKingStrike} · ${formatPct(headerBookCol.filteredKingConcPct)}%`
                    : `Next exp King ${liveFilteredKingStrike}${nextExpShortDate ? ` (${nextExpShortDate})` : ""} · ${formatPct(headerBookCol.filteredKingConcPct)}%`
                  : expFilter === "WEEK"
                    ? `Week King ${liveFilteredKingStrike} · ${formatPct(headerBookCol.filteredKingConcPct)}%`
                    : `${expFilter} King ${liveFilteredKingStrike} · ${formatPct(headerBookCol.filteredKingConcPct)}%`}
              </span>
            )}
            {liveAllExpKingStrike !== liveFilteredKingStrike &&
              ((headerBookCol.allExpKingConcPct < 15 && headerBookCol.filteredKingConcPct >= 20) ||
                Math.abs(liveAllExpKingStrike - activeCandle.close) > dataset.sigma1Move * 1.05) && (
                <span className="bg-amber-950/50 border border-amber-500/50 text-amber-200 rounded-full px-3.5 py-1 text-[11px] font-semibold inline-flex items-center gap-1.5">
                  <span className="text-amber-400 font-bold">⚠️ King Trap Guardrail:</span>
                  <span>
                    All-exp {liveAllExpKingStrike} is distant ({formatPct(headerBookCol.allExpKingConcPct)}% share) · Active Intraday Pin is{" "}
                    <strong className="text-cyan-300">
                      ${liveFilteredKingStrike} ({formatPct(headerBookCol.filteredKingConcPct)}%)
                    </strong>
                    {activeCandle.close >= activeCandle.sma34 && liveAllExpKingStrike < activeCandle.close
                      ? " — Avoid shorting HOD / deep OTM Puts above SMA34"
                      : ""}
                  </span>
                </span>
              )}
          </div>

          {/* 2. Moving Average Readout Row */}
          <div className="text-[11px] font-mono tabular-nums flex flex-wrap items-center gap-4 text-slate-400">
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block w-3 h-[2px] bg-[#ffffff]" />
              <span>SMA 5 (D)</span>
              <span className="font-bold text-white">
                {activeCandle.sma5d.toFixed(2)}
              </span>
            </span>

            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block w-3 h-[2px] bg-[#14b8a6]" />
              <span>EMA 21 (D)</span>
              <span className="font-bold text-white">
                {activeCandle.ema21d.toFixed(2)}
              </span>
            </span>

            <span className="inline-flex items-center gap-1.5">
              <span
                className="inline-block w-3 h-[2px]"
                style={{
                  backgroundColor: isSma34Bullish ? "#22c55e" : "#ef4444",
                }}
              />
              <span>SMA 34 (5m)</span>
              <span className="font-bold text-white">
                {activeCandle.sma34.toFixed(2)}
              </span>
            </span>

            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block w-3 h-[2px] bg-[#f97316]" />
              <span>SMA 55 (D)</span>
              <span className="font-bold text-white">
                {activeCandle.sma55d.toFixed(2)}
              </span>
            </span>
          </div>

          {/* 3. Active Candle Book Readout */}
          <div className="text-[11px] font-mono tabular-nums text-slate-400 flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>{activeCandle.timeLabel}</span>
            <span>·</span>
            <span>
              Net {exposureMode}{" "}
              <strong className="text-white font-bold">
                {activeBookCol.netGexB >= 0 ? "+" : ""}
                {activeBookCol.netGexB.toFixed(2)}B
              </strong>
            </span>
            <span>·</span>
            <span className="inline-flex flex-wrap items-center gap-2">
              <span>{exposureMode} levels</span>
              {activeBookCol.topLevels.map((lvl, idx) => {
                const isKingLvl = idx === 0;
                const valFormatted = formatBookLevelValue(lvl.valueM);
                if (isKingLvl) {
                  return (
                    <span key={lvl.strike} className="font-bold text-[#facc15]">
                      {lvl.strike} {valFormatted}
                    </span>
                  );
                }
                return (
                  <span key={lvl.strike} className="inline-flex items-center gap-1">
                    <strong className="text-white font-bold">{lvl.strike}</strong>
                    <span
                      className={cn(
                        "font-bold",
                        lvl.valueM >= 0 ? "text-[#22d3ee]" : "text-[#a855f7]"
                      )}
                    >
                      {valFormatted}
                    </span>
                  </span>
                );
              })}
            </span>
            <span>·</span>
            <span>today&apos;s book</span>
          </div>

          {/* 4. Interactive Legend Row */}
          <div className="text-[11px] text-slate-400 flex flex-wrap items-center gap-4">
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-[#22d3ee] shadow-[0_0_8px_#22d3ee] inline-block" />
              <span>Positive γ</span>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-[#a855f7] inline-block" />
              <span>Negative γ</span>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-[#facc15] shadow-[0_0_8px_rgba(250,204,21,0.7)] inline-block" />
              <span>King</span>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-[#fbbf24] inline-block" />
              <span>Zero Γ</span>
            </span>
            {expFilter !== "ALL" && (
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-[#38bdf8] inline-block" />
                <span>Filter</span>
              </span>
            )}
          </div>
        </div>
        );
      })()}

      {/* 3 & 4A. Core Chart Canvas Card + Interactive Session Replay Bar (Above the fold on 1280x720 & 1920x1080) */}
      <div
        ref={containerRef}
        className="bg-[#0d111a] border border-[#1e2638] rounded-2xl p-4 space-y-3 relative transition-all"
        style={{
          width: chartWidth ? `${chartWidth}px` : "100%",
          maxWidth: "100%",
          minWidth: 0,
        }}
      >
        {/* Right Edge Horizontal Resize Handle */}
        <div
          onMouseDown={(e) => {
            e.preventDefault();
            const startX = e.clientX;
            const startW = containerRef.current?.getBoundingClientRect().width ?? 1000;
            const onMove = (moveEvt: MouseEvent) => {
              const delta = moveEvt.clientX - startX;
              setChartWidth(Math.max(640, Math.min(2600, Math.round(startW + delta))));
            };
            const onUp = () => {
              window.removeEventListener("mousemove", onMove);
              window.removeEventListener("mouseup", onUp);
            };
            window.addEventListener("mousemove", onMove);
            window.addEventListener("mouseup", onUp);
          }}
          onDoubleClick={() => setChartWidth(null)}
          title="Drag horizontally to resize chart width (Double-click to reset to 100%)"
          role="separator"
          tabIndex={0}
          aria-orientation="vertical"
          aria-label="Chart horizontal width resize handle. Use Left and Right arrow keys to adjust width."
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") {
              e.preventDefault();
              setChartWidth((w) =>
                Math.max(640, (w ?? (containerRef.current?.getBoundingClientRect().width || 1000)) - 30)
              );
            } else if (e.key === "ArrowRight") {
              e.preventDefault();
              setChartWidth((w) =>
                Math.min(2600, (w ?? (containerRef.current?.getBoundingClientRect().width || 1000)) + 30)
              );
            }
          }}
          className="absolute right-0 top-0 bottom-0 w-3 cursor-ew-resize hover:bg-cyan-500/10 active:bg-cyan-500/20 transition-colors flex items-center justify-center group z-30 select-none rounded-r-2xl"
        >
          <div className="w-1 h-12 bg-white/20 group-hover:bg-cyan-400 group-active:bg-cyan-400 rounded-full transition-colors" />
        </div>

        {/* Dual Width + Height Corner Grip */}
        <div
          onMouseDown={(e) => {
            e.preventDefault();
            const startX = e.clientX;
            const startY = e.clientY;
            const startW = containerRef.current?.getBoundingClientRect().width ?? 1000;
            const startH = chartHeight;
            const onMove = (moveEvt: MouseEvent) => {
              const deltaX = moveEvt.clientX - startX;
              const deltaY = moveEvt.clientY - startY;
              setChartWidth(Math.max(640, Math.min(2600, Math.round(startW + deltaX))));
              setChartHeight(Math.max(380, Math.min(950, Math.round(startH + deltaY))));
            };
            const onUp = () => {
              window.removeEventListener("mousemove", onMove);
              window.removeEventListener("mouseup", onUp);
            };
            window.addEventListener("mousemove", onMove);
            window.addEventListener("mouseup", onUp);
          }}
          onDoubleClick={() => {
            setChartWidth(null);
            setChartHeight(540);
          }}
          title="Drag corner to resize both chart width & height simultaneously (Double-click to reset)"
          className="absolute right-1 bottom-1 w-5 h-5 cursor-nwse-resize text-slate-500 hover:text-cyan-400 flex items-center justify-center z-30 select-none"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="rotate-90">
            <path
              d="M11 1L1 11M11 6L6 11M11 11H11.01"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
        </div>

        {/* Screen Reader Live Region for Accessibility */}
        <div className="sr-only" aria-live="polite" aria-atomic="true">
          {activeCandle
            ? `${dataset?.ticker} candle at ${activeCandle.timeLabel}: Close $${activeCandle.close.toFixed(2)}, High $${activeCandle.high.toFixed(2)}, Low $${activeCandle.low.toFixed(2)}, SMA34 $${activeCandle.sma34.toFixed(2)}, RSI ${activeCandle.rsi14.toFixed(1)}.`
            : ""}
        </div>

        {/* Minimalist MTF Divergence Status Strip (Non-occluding header bar above canvas aligned to CHART_PAD_LEFT=24) */}
        {dataset && DIVSYM.has(loadedTicker.toUpperCase()) && (
          <div className="pl-6 flex items-center gap-2 font-mono text-[11px] text-slate-400 select-none">
            <span className="text-slate-500 font-semibold tracking-wider">MTF:</span>
            {(() => {
              const c = dataset.candles[safeActiveIdx] || dataset.candles[dataset.candles.length - 1];
              const cur = c?.close ?? dataset.priorClose ?? 0;
              const vwap = flowVwapPoints[safeActiveIdx]?.flowVwap ?? cur;
              const zg = (!isHistoricalOrReplay && gammaLevels?.zeroGamma && gammaLevels.zeroGamma > 0) ? gammaLevels.zeroGamma : (dataset.priorClose ?? vwap);
              const slice = (n: number) => {
                const arr = dataset.candles.slice(Math.max(0, safeActiveIdx - n + 1), safeActiveIdx + 1);
                return arr.reduce((s, x) => s + x.close, 0) / Math.max(1, arr.length);
              };
              const tfs = [
                { label: "5m", bull: cur >= slice(6) && cur >= vwap },
                { label: "30m", bull: cur >= slice(12) && cur >= vwap },
                { label: "2H", bull: cur >= slice(24) && cur >= zg },
                { label: "1D", bull: cur >= (dataset.priorClose || zg) },
                { label: "1W", bull: cur >= zg },
              ];
              return tfs.map((tf, idx) => (
                <React.Fragment key={tf.label}>
                  {idx > 0 && <span className="text-slate-700">|</span>}
                  <span>
                    {tf.label}{" "}
                    <strong className={tf.bull ? "text-emerald-400" : "text-rose-400"}>
                      {tf.bull ? "▲" : "▼"}
                    </strong>
                  </span>
                </React.Fragment>
              ));
            })()}
          </div>
        )}

        <div
          className="relative w-full overflow-hidden flex items-center justify-center rounded-xl"
          style={{ minHeight: `${chartHeight}px` }}
        >
          {!dataset && isLoading && (
            <div className="text-xs font-mono text-slate-400">
              Loading live intraday candles &amp; options book for {loadedTicker}...
            </div>
          )}

          <canvas
            ref={canvasRef}
            role="img"
            tabIndex={0}
            aria-label={`Interactive intraday chart for ${dataset?.ticker || loadedTicker} on ${dataset?.sessionDate || "current session"}. Showing 5-minute candles starting at ${startHour === 0 ? "12:00 AM (24H)" : startHour === 7 ? "7:00 AM" : startHour === 8 ? "8:00 AM" : "9:30 AM"} to ${startHour === 0 ? "12:00 AM" : "4:00 PM"} ET with hourly time ticks. Use Left/Right Arrow keys to step through candles, Home/End to jump to open and close, Space to toggle replay, and Plus/Minus to zoom.`}
            onKeyDown={handleCanvasKeyDown}
            onMouseDown={handleCanvasMouseDown}
            onMouseMove={handleCanvasMouseMove}
            onMouseLeave={handleCanvasMouseLeave}
            onMouseUp={handleCanvasMouseUp}
            onWheel={handleCanvasWheel}
            onDoubleClick={handleCanvasDoubleClick}
            className={cn(
              "block w-full select-none focus:outline-none focus-visible:ring-2 focus-visible:ring-[#38bdf8] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0d111a] rounded-xl",
              !dataset && "hidden"
            )}
            style={{ height: `${chartHeight}px`, cursor: cursorStyle }}
          />

          {/* Floating Auto-Fit Reset Button on Canvas when zoomed / panned */}
          {(Math.abs(xScale - 1.0) > 1e-3 || Math.abs(xPanOffset) > 1e-3 || Math.abs(yScale - 1.0) > 1e-3 || Math.abs(yPanOffset) > 1e-3 || startHour !== 9 || scopePreset !== "cone") && (
            <button
              type="button"
              onClick={handleCanvasDoubleClick}
              title="Click to reset window (or double-click canvas)"
              className="absolute bottom-4 right-20 z-20 px-2.5 py-1 rounded-md bg-[#0e131d]/90 border border-cyan-400/50 text-[10px] font-mono font-bold text-cyan-300 shadow-[0_0_12px_rgba(34,211,238,0.25)] backdrop-blur-md hover:bg-cyan-500/20 transition flex items-center gap-1.5 cursor-pointer"
            >
              <span>Auto-Fit · {(xScale * 100).toFixed(0)}%X · {(yScale * 100).toFixed(0)}%Y</span>
            </button>
          )}
        </div>

        {/* Draggable Chart Height Resizer Grip */}
        <div
          onMouseDown={(e) => {
            e.preventDefault();
            const startY = e.clientY;
            const startH = chartHeight;
            const onMove = (moveEvt: MouseEvent) => {
              const delta = moveEvt.clientY - startY;
              setChartHeight(
                Math.max(380, Math.min(950, Math.round(startH + delta)))
              );
            };
            const onUp = () => {
              window.removeEventListener("mousemove", onMove);
              window.removeEventListener("mouseup", onUp);
            };
            window.addEventListener("mousemove", onMove);
            window.addEventListener("mouseup", onUp);
          }}
          title="Drag up or down to adjust chart window height (or use Up/Down arrow keys)"
          role="separator"
          tabIndex={0}
          aria-orientation="horizontal"
          aria-valuenow={chartHeight}
          aria-valuemin={380}
          aria-valuemax={950}
          aria-label="Chart height resize handle. Use Up and Down arrow keys to adjust height."
          onKeyDown={(e) => {
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setChartHeight((h) => Math.max(380, h - 25));
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              setChartHeight((h) => Math.min(950, h + 25));
            }
          }}
          className="w-full h-3 -my-1 flex items-center justify-center cursor-row-resize hover:bg-cyan-500/10 active:bg-cyan-500/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#38bdf8] rounded transition-colors group z-20 select-none"
        >
          <div className="w-16 h-1 rounded-full bg-white/15 group-hover:bg-cyan-400/60 group-active:bg-cyan-400 transition-colors" />
        </div>

        {/* 4A. Interactive Session Replay Bar */}
        {dataset && (
          <div className="bg-[#101520] border border-[#1e2638] rounded-xl px-4 py-2.5 flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={handleToggleReplay}
                aria-label={isReplaying ? "Pause session replay" : "Start session replay"}
                className="bg-gradient-to-r from-[#38bdf8] to-[#818cf8] text-[#090d16] font-bold text-xs px-4 py-1.5 rounded-full hover:opacity-95 transition cursor-pointer shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
              >
                {isReplaying ? "Pause" : "Replay"}
              </button>
              <button
                type="button"
                onClick={() => handleStepBar(-1)}
                disabled={safeActiveIdx <= minBarIdx}
                aria-label="Step back one candle"
                title="Previous candle (ArrowLeft)"
                className="w-7 h-7 flex items-center justify-center rounded-full border border-[#232d42] bg-[#151b28] text-slate-200 hover:text-white hover:border-[#38bdf8] disabled:opacity-40 disabled:cursor-not-allowed transition cursor-pointer text-[11px]"
              >
                ◀
              </button>
              <button
                type="button"
                onClick={() => handleStepBar(1)}
                disabled={safeActiveIdx >= maxBarIdx}
                aria-label="Step forward one candle"
                title="Next candle (ArrowRight)"
                className="w-7 h-7 flex items-center justify-center rounded-full border border-[#232d42] bg-[#151b28] text-slate-200 hover:text-white hover:border-[#38bdf8] disabled:opacity-40 disabled:cursor-not-allowed transition cursor-pointer text-[11px]"
              >
                ▶
              </button>
              <div
                className="flex items-center bg-[#151b28] border border-[#232d42] rounded-full p-0.5 font-mono text-[10px]"
                role="group"
                aria-label="Replay speed"
              >
                {([1, 2, 4] as const).map((spd) => (
                  <button
                    key={spd}
                    type="button"
                    onClick={() => setReplaySpeed(spd)}
                    aria-pressed={replaySpeed === spd}
                    className={cn(
                      "px-2 py-0.5 rounded-full font-bold transition cursor-pointer",
                      replaySpeed === spd
                        ? "bg-[#38bdf8] text-[#090d16]"
                        : "text-slate-400 hover:text-white"
                    )}
                  >
                    {spd}x
                  </button>
                ))}
              </div>
            </div>

            {/* Custom Glowing Cyan Range Scrubber */}
            <div className="relative flex-1 min-w-[160px] flex items-center h-5">
              <div className="w-full h-1.5 rounded-full bg-[#1e2638] overflow-hidden">
                <div
                  className="h-full bg-[#22d3ee] shadow-[0_0_8px_#22d3ee]"
                  style={{ width: `${sliderProgressPct}%` }}
                />
              </div>
              <div
                className="pointer-events-none absolute w-4 h-4 rounded-full bg-[#22d3ee] shadow-[0_0_10px_#22d3ee] -translate-x-1/2"
                style={{ left: `${sliderProgressPct}%` }}
              />
              <input
                type="range"
                min={minBarIdx}
                max={maxBarIdx}
                value={safeActiveIdx}
                aria-label="Session replay scrubber"
                aria-valuemin={minBarIdx}
                aria-valuemax={maxBarIdx}
                aria-valuenow={safeActiveIdx}
                aria-valuetext={`Time ${dataset.candles[safeActiveIdx]?.timeLabel ?? ""}, Price $${activeCandle?.close.toFixed(2) ?? ""}`}
                onChange={(e) => {
                  isReplayingRef.current = false;
                  setIsReplaying(false);
                  isReplayFrozenRef.current = true;
                  setIsReplayFrozen(true);
                  setActiveBarIndex(Number(e.target.value));
                }}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer focus:outline-none focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-[#38bdf8]"
              />
            </div>

            <span className="font-mono text-xs text-slate-300 tabular-nums shrink-0">
              {dataset.candles[safeActiveIdx]?.timeLabel ?? "3:55 PM"}
            </span>

            <button
              type="button"
              onClick={handleSnapToLive}
              aria-label="Snap to live candle"
              title="Jump to latest live bar and resume polling (End)"
              className={cn(
                "px-2.5 py-1 rounded-full font-mono text-[11px] font-bold border transition cursor-pointer shrink-0",
                !isReplaying && !isReplayFrozen && safeActiveIdx >= maxBarIdx
                  ? "bg-emerald-500/15 border-emerald-400/60 text-emerald-300"
                  : "bg-[#151b28] border-[#232d42] text-slate-300 hover:text-white hover:border-emerald-400/60"
              )}
            >
              Live
            </button>
          </div>
        )}
      </div>

      {/* 4A-2. Live Gaia Call/Put Bias & PRZM Tactical HUD */}
      {(() => {
        const replayBar = dataset?.candles?.[safeActiveIdx];
        const replayTsRaw = Number(replayBar?.timestamp ?? 0);
        const replayBarTsSec = replayTsRaw > 0 ? toEpochSec(replayTsRaw) : 0;
        return (
      <GaiaCallPutBiasHud
        symbol={loadedTicker}
        candles={dataset?.candles?.slice(0, safeActiveIdx + 1).map((c) => ({
          timestamp: c.timestamp,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: (c as GaiaIntradayCandle & { volume?: number }).volume,
          timeLabel: c.timeLabel,
        }))}
        flowVwapPoints={flowVwapPoints.slice(0, safeActiveIdx + 1)}
        sigma1Move={dataset?.sigma1Move}
        liveSpot={activeCandle ? activeCandle.close : null}
        serverTrades={effectiveServerTrades}
        supervisorPolicy={
          isHistoricalSession
            ? historicalSupervisorPolicy
            : loadedTicker.toUpperCase() === storeTicker.toUpperCase()
              ? storeSupervisorPolicy
              : null
        }
        sessionDate={chartSessionDate}
        dividerRatio={dividerRatio}
        isReplayMode={isHistoricalOrReplay}
        replayBarTsSec={replayBarTsSec > 0 ? replayBarTsSec : undefined}
        replayBarClose={replayBar?.close}
        startHour={startHour}
        xScale={xScale}
        xPanOffset={xPanOffset}
        containerWidthPx={canvasWidth}
        onXViewportChange={(s, p) => {
          setXScale(s);
          setXPanOffset(p);
        }}
        onResetViewport={() => {
          setStartHour(9);
          setXScale(1.0);
          setXPanOffset(0);
          setYScale(1.0);
          setYPanOffset(0);
          setDividerRatio(fluxFocusMode ? 0.88 : 0.76);
          setScopePreset("cone");
        }}
        onSignalsEvaluated={setPrzmHudSignals}
        onSymbolChange={(sym) => {
          const cleaned = sym.trim().toUpperCase() || "SPY";
          prevStoreTickerRef.current = cleaned;
          setTickerInput(cleaned);
          setStoreTicker(cleaned);
          isReplayingRef.current = false;
          setIsReplaying(false);
          isReplayFrozenRef.current = false;
          setIsReplayFrozen(false);
          setSelectedSessionIso("");
          resetViewportTo24H();
          syncTickerUrlParam(cleaned);
          if (cleaned !== loadedTicker) {
            setLivePayload(null);
            setLoadedTicker(cleaned);
          } else {
            void fetchLiveGaia(cleaned, "", startHour);
          }
        }}
      />
        );
      })()}

      {/* 4B. Range Outlook Summary Card */}
      {dataset && (
        <div className="bg-[#101520] border border-[#1e2638] rounded-xl p-4 space-y-2.5">
          <div className="text-[11px] font-bold uppercase tracking-wider text-[#38bdf8]">
            RANGE OUTLOOK
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <span className="bg-[#151b28] border border-[#232d42] rounded-full px-3.5 py-1.5 text-xs font-mono font-bold text-white">
              Prior close ${dataset.priorClose.toFixed(2)}
            </span>
            <span className="bg-[#151b28] border border-[#232d42] rounded-full px-3.5 py-1.5 text-xs font-mono font-bold text-white">
              ±1σ ${(dataset.priorClose - dataset.sigma1Move).toFixed(2)} – $
              {(dataset.priorClose + dataset.sigma1Move).toFixed(2)}
            </span>
            <span className="bg-[#151b28] border border-[#232d42] rounded-full px-3.5 py-1.5 text-xs font-mono font-bold text-white">
              ±2σ ${(dataset.priorClose - dataset.sigma2Move).toFixed(2)} – $
              {(dataset.priorClose + dataset.sigma2Move).toFixed(2)}
            </span>
          </div>

          <p className="text-[11px] text-slate-400">
            Probabilistic range from options pricing. Not a forecast. Not
            financial advice.
          </p>
        </div>
      )}
    </div>
  );
}

export default GaiaView;
