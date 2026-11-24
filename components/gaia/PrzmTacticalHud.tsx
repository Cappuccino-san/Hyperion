"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useDashboardStore } from "@/store/useDashboardStore";
import {
  getSessionBoundsEt,
  getTodayEt,
  toEpochSec,
} from "@/lib/gaiaSessionGuards";
import type { SessionPlaybookPolicy } from "@/lib/persistenceStore";
import { evaluateZeroFlowFilter } from "@/lib/zeroFlowFilter";
import type { ZeroShadowReadout } from "@/lib/zeroShadowLedger";

export interface PrzmCandlePoint {
  time: string;
  timestamp?: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  vwap?: number;
  flowVwap?: number;
  sigma?: number;
  chi?: number;
  impulseChi?: number;
  pe?: number;
  impulsePe?: number;
  deltaNetFlux6Bar?: number;
  upperBand?: number;
  lowerBand?: number;
  boundaryFlux?: number;
}

export interface PrzmSignalPoint {
  id: string;
  index: number;
  time: string;
  price: number;
  type: "LONG" | "SHORT";
  timestamp?: number;
  barTimestamp?: number;
  barCloseTimestamp?: number;
  barSpanSeconds?: number;
  tag?: "OPEN" | "PEAK" | "LOW" | "CONT" | "BREAK" | "RECLAIM";
  label?: string;
  excursion?: number;
  reason?: string;
  exitPrice?: number;
  exitTimestamp?: number;
  exitIndex?: number;
  exitReason?: string;
  isClosed?: boolean;
}

export interface EvaluatedCallEntry {
  id: string;
  timeFormatted: string;
  type: "LONG" | "SHORT";
  contractType?: "CALL" | "PUT";
  entryPrice: number;
  closedPrice?: number;
  closedTimeFormatted?: string;
  pnlOptionPct?: number;
  btoOptionPrice?: number;
  stcOptionPrice?: number;
  status: "OPEN" | "RIGHT" | "FLAT" | "WRONG";
  delta: number;
  heldMinutes: number;
  heldLabel: string;
  index: number;
  contractLabel?: string;
  exitReason?: string;
  exitQuoteSource?: "LIVE_CHAIN_BID" | "DELAYED_CBOE_BID" | "BS_FALLBACK";
  isServerTrade?: boolean;
}

export interface ServerTradeData {
  activePositions?: Record<string, any>;
  closedPositions?: any[];
  alerts?: any[];
  loaded?: boolean;
}

export interface PrzmLedgerSummary {
  entries: EvaluatedCallEntry[]; // Newest first
  activeCall: EvaluatedCallEntry | null;
  totalCalls: number;
  rightCount: number;
  wrongCount: number;
  flatCount: number;
  decisiveCount: number;
  winRatePct: number;
  avgR: number;
}

/**
 * Formats 24h "HH:MM" or timestamp into PRZM compact "11:38am" / "10:06am" notation
 */
function formatPrzmTime(rawTime: string = "", timestamp?: number): string {
  if (timestamp && Number.isFinite(timestamp) && timestamp > 1_000_000_000) {
    try {
      const ms = timestamp < 1e12 ? timestamp * 1000 : timestamp;
      const d = new Date(ms);
      const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });
      return formatter.format(d).toLowerCase().replace(/\s+/g, "");
    } catch {
      // Fallback to string parser below
    }
  }
  if (!rawTime) return "";
  const m = rawTime.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return rawTime.toLowerCase();
  const hh = parseInt(m[1], 10);
  const mm = m[2];
  const suffix = hh >= 12 ? "pm" : "am";
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12}:${mm}${suffix}`;
}

function toEpochSeconds(ts?: number): number {
  if (!ts || !Number.isFinite(ts) || ts <= 0) return 0;
  return toEpochSec(ts);
}

function formatHeldDuration(minutes: number): string {
  const clamped = Math.max(1, Math.min(390, Math.round(minutes)));
  if (clamped < 60) return `${clamped}M`;
  const hrs = Math.floor(clamped / 60);
  const mins = clamped % 60;
  return mins > 0 ? `${hrs}H ${mins}M` : `${hrs}H`;
}

/**
 * Universal direction resolver ensuring Short/Put symmetry across all server & client payload vocabularies
 */
export function isShortOrPutTrade(pos: any): boolean {
  if (!pos) return false;
  const ct = String(pos.contractType || "").toUpperCase();
  const dir = String(pos.direction || "").toUpperCase();
  const ty = String(pos.type || "").toUpperCase();
  const act = String(pos.action || "").toUpperCase();
  return ct === "PUT" || dir === "SHORT" || ty === "SHORT" || act.includes("PUT") || act === "SELL_TO_OPEN";
}

/**
 * Evaluates session signals into PRZM Call Log entries & Win-Rate Scoreboard metrics
 */
export function evaluatePrzmCallLedger(
  signals: PrzmSignalPoint[],
  series: PrzmCandlePoint[],
  liveSpot: number,
  activeFsmState?: "LONG" | "SHORT" | "STAND_ASIDE",
  serverTrades?: ServerTradeData,
  ticker = "SPY",
  replayBarTsSec?: number
): PrzmLedgerSummary {
  const normTicker = (ticker || "SPY").trim().toUpperCase();
  const hasReplayCutoff = typeof replayBarTsSec === "number" && replayBarTsSec > 0;
  let barStepSec = 300;
  if (series.length >= 2) {
    const intervals: number[] = [];
    const limit = Math.min(series.length - 1, 10);
    for (let k = 0; k < limit; k++) {
      const t0 = toEpochSeconds(series[k]?.timestamp);
      const t1 = toEpochSeconds(series[k + 1]?.timestamp);
      const step = Math.abs(t1 - t0);
      if (step >= 60 && step <= 3600) intervals.push(step);
    }
    if (intervals.length > 0) {
      intervals.sort((a, b) => a - b);
      barStepSec = intervals[Math.floor(intervals.length / 2)];
    }
  }
  const replayBarEndSec = hasReplayCutoff ? replayBarTsSec! + barStepSec - 1 : 0;
  const storeState = serverTrades === undefined ? useDashboardStore.getState() : null;
  const rawClosed =
    Array.isArray(serverTrades?.closedPositions)
      ? serverTrades!.closedPositions
      : Array.isArray(storeState?.serverClosedTrades)
        ? storeState!.serverClosedTrades
        : [];
  const rawActiveObj =
    serverTrades?.activePositions
      ? serverTrades.activePositions
      : storeState?.serverActivePositions || {};
  const rawAlerts =
    Array.isArray(serverTrades?.alerts)
      ? serverTrades!.alerts
      : Array.isArray(storeState?.serverTradeAlerts)
        ? storeState!.serverTradeAlerts
        : [];

  // Reconstruct closed trades from alerts if closedPositions is empty but a SELL_TO_CLOSE alert exists
  const serverClosed = [...rawClosed].filter(
    (pos: any) => pos && (!pos.ticker || pos.ticker.toUpperCase() === normTicker)
  );
  if (serverClosed.length === 0 && rawAlerts.length > 0) {
    const stcAlerts = rawAlerts.filter(
      (a: any) => a && a.action === "SELL_TO_CLOSE" && (!a.ticker || a.ticker.toUpperCase() === normTicker)
    );
    for (const stc of stcAlerts) {
      const baseId = String(stc.id || "").replace(/-stc.*$/, "");
      const bto = rawAlerts.find(
        (a: any) =>
          a &&
          a.action === "BUY_TO_OPEN" &&
          String(a.id || "").startsWith(baseId) &&
          (!a.ticker || a.ticker.toUpperCase() === normTicker)
      );
      serverClosed.push({
        id: baseId || stc.id,
        ticker: stc.ticker || bto?.ticker || normTicker,
        contractType: stc.contractType || bto?.contractType || "PUT",
        contractLabel: stc.contractLabel || bto?.contractLabel,
        status: "CLOSED",
        btoSpotPrice: bto?.btoSpotPrice ?? stc.btoSpotPrice ?? bto?.spotPrice ?? 0,
        closedSpotPrice: stc.closedSpotPrice ?? stc.spotPrice ?? 0,
        openedAt: bto?.timestamp ?? "9:35 AM",
        openedTs: bto?.ts,
        closedAt: stc.timestamp,
        closedTs: stc.ts,
        btoOptionAsk: stc.btoOptionAsk ?? bto?.btoOptionAsk ?? bto?.optionAsk,
        optionAsk: bto?.optionAsk ?? stc.btoOptionAsk,
        btoOptionMid: stc.btoOptionMid ?? bto?.btoOptionMid,
        closedOptionBid: stc.closedOptionBid ?? stc.optionBid ?? stc.optionMid,
        closedOptionMid: stc.optionMid,
        exitQuoteSource: stc.exitQuoteSource,
        pnlOptionPct: stc.pnlOptionPct,
        pnlSpotPct: stc.pnlSpotPct,
        exitReason: stc.reason || stc.setupName,
      });
    }
  }

  const closedIds = new Set(serverClosed.map((c: any) => c?.id).filter(Boolean));
  const serverActive = Object.values(rawActiveObj).filter(
    (pos: any) =>
      pos &&
      pos.id &&
      (!pos.ticker || pos.ticker.toUpperCase() === normTicker) &&
      !closedIds.has(pos.id) &&
      pos.status !== "CLOSED" &&
      !pos.closedTs &&
      !pos.stcTimestamp &&
      !String(pos.id).startsWith("test-")
  );

  const serverEntries: EvaluatedCallEntry[] = [];

  for (const pos of serverClosed) {
    if (!pos || !pos.id || String(pos.id).startsWith("test-")) continue;
    const openedSec = pos.openedTs ? toEpochSeconds(pos.openedTs) : 0;
    if (hasReplayCutoff && (openedSec === 0 || openedSec > replayBarEndSec)) continue;
    const closedSec = pos.closedTs ? toEpochSeconds(pos.closedTs) : 0;
    const isStillOpenInReplay = hasReplayCutoff && (closedSec === 0 || closedSec > replayBarEndSec);

    const isShort = isShortOrPutTrade(pos);
    const isCall = !isShort;
    const type: "LONG" | "SHORT" = isShort ? "SHORT" : "LONG";
    const btoSpot = typeof pos.btoSpotPrice === "number" && pos.btoSpotPrice > 0
      ? pos.btoSpotPrice
      : typeof pos.spotPrice === "number" && pos.spotPrice > 0
        ? pos.spotPrice
        : 0;
    const closedSpot = typeof pos.closedSpotPrice === "number" && pos.closedSpotPrice > 0
      ? pos.closedSpotPrice
      : typeof pos.spotPrice === "number" && pos.spotPrice > 0
        ? pos.spotPrice
        : btoSpot;
    const entryBucket = pos.openedTs ? Math.floor(toEpochSeconds(pos.openedTs) / 300) * 300 : 0;
    const exitBucket = pos.closedTs ? Math.floor(toEpochSeconds(pos.closedTs) / 300) * 300 : 0;
    const entryBar = entryBucket > 0 ? series.find((b) => Math.floor(toEpochSeconds(b.timestamp) / 300) * 300 === entryBucket) : undefined;
    const exitBar = exitBucket > 0 ? series.find((b) => Math.floor(toEpochSeconds(b.timestamp) / 300) * 300 === exitBucket) : undefined;
    const clampedBto = entryBar && btoSpot > 0 ? Math.max(entryBar.low, Math.min(entryBar.high, btoSpot)) : btoSpot;
    const clampedClosed = exitBar && closedSpot > 0 ? Math.max(exitBar.low, Math.min(exitBar.high, closedSpot)) : closedSpot;
    const btoOpt =
      typeof pos.btoOptionAsk === "number" && pos.btoOptionAsk > 0
        ? pos.btoOptionAsk
        : typeof pos.optionAsk === "number" && pos.optionAsk > 0
          ? pos.optionAsk
          : typeof pos.btoPrice === "number" && pos.btoPrice > 0
            ? pos.btoPrice
            : typeof pos.btoOptionMid === "number" && pos.btoOptionMid > 0
              ? pos.btoOptionMid
              : undefined;
    const stcOpt =
      typeof pos.closedOptionBid === "number" && pos.closedOptionBid > 0
        ? pos.closedOptionBid
        : typeof pos.stcPrice === "number" && pos.stcPrice > 0
          ? pos.stcPrice
          : typeof pos.closedOptionMid === "number" && pos.closedOptionMid > 0
            ? pos.closedOptionMid
            : undefined;

    if (isStillOpenInReplay) {
      const currentSpot = Number.isFinite(liveSpot) && liveSpot > 0 ? liveSpot : clampedBto;
      const delta = Number((isCall ? currentSpot - clampedBto : clampedBto - currentSpot).toFixed(2));
      const refReplaySec = openedSec <= replayBarTsSec! ? replayBarTsSec! : replayBarEndSec;
      const heldMin =
        openedSec > 0 && refReplaySec > openedSec
          ? Math.max(1, Math.round((refReplaySec - openedSec) / 60))
          : 5;
      serverEntries.push({
        id: pos.id,
        timeFormatted: pos.openedTs ? formatPrzmTime(pos.openedAt, pos.openedTs) : (pos.openedAt || ""),
        type,
        contractType: isCall ? "CALL" : "PUT",
        entryPrice: clampedBto,
        btoOptionPrice: btoOpt,
        status: "OPEN",
        delta,
        heldMinutes: heldMin,
        heldLabel: formatHeldDuration(heldMin),
        index: 0,
        contractLabel: (pos.contractLabel || (pos as any).optionSymbol),
        isServerTrade: true,
      });
      continue;
    }

    const delta = Number((type === "SHORT" ? clampedBto - clampedClosed : clampedClosed - clampedBto).toFixed(2));
    const reconciledOptPnlPct =
      typeof btoOpt === "number" && btoOpt > 0 && typeof stcOpt === "number" && stcOpt >= 0
        ? Number((((stcOpt - btoOpt) / btoOpt) * 100).toFixed(1))
        : typeof pos.pnlOptionPct === "number" && Number.isFinite(pos.pnlOptionPct)
          ? pos.pnlOptionPct
          : undefined;
    const hasOptPnl = typeof reconciledOptPnlPct === "number" && Number.isFinite(reconciledOptPnlPct);
    const isLoss = hasOptPnl
      ? reconciledOptPnlPct! < 0 || delta < -0.005
      : delta < -0.005 || Boolean(pos.exitReason?.includes("STOP")) || (typeof pos.pnlSpotPct === "number" && pos.pnlSpotPct < 0);
    const isWin = !isLoss && (
      hasOptPnl
        ? reconciledOptPnlPct! > 0 && delta >= 0
        : delta > 0.005 || (typeof pos.pnlSpotPct === "number" && pos.pnlSpotPct > 0 && delta >= 0)
    );
    const status: "RIGHT" | "WRONG" | "FLAT" = isLoss ? "WRONG" : isWin ? "RIGHT" : "FLAT";
    const heldMin =
      openedSec > 0 && closedSec > openedSec
        ? Math.max(1, Math.round((closedSec - openedSec) / 60))
        : 5;

    serverEntries.push({
      id: pos.id,
      timeFormatted: pos.openedTs ? formatPrzmTime(pos.openedAt, pos.openedTs) : (pos.openedAt || ""),
      type,
      contractType: isCall ? "CALL" : "PUT",
      entryPrice: clampedBto,
      closedPrice: clampedClosed,
      closedTimeFormatted: pos.closedTs ? formatPrzmTime(pos.closedAt, pos.closedTs) : pos.closedAt,
      pnlOptionPct: reconciledOptPnlPct,
      btoOptionPrice: btoOpt,
      stcOptionPrice: stcOpt,
      status,
      delta,
      heldMinutes: heldMin,
      heldLabel: formatHeldDuration(heldMin),
      index: 0,
      contractLabel: (pos.contractLabel || (pos as any).optionSymbol),
      exitReason: pos.exitReason,
      exitQuoteSource: pos.exitQuoteSource,
      isServerTrade: true,
    });
  }

  for (const pos of serverActive) {
    if (!pos || !pos.id) continue;
    const openedSec = pos.openedTs ? toEpochSeconds(pos.openedTs) : 0;
    if (hasReplayCutoff && (openedSec === 0 || openedSec > replayBarEndSec)) continue;
    const isShort = isShortOrPutTrade(pos);
    const isCall = !isShort;
    const type: "LONG" | "SHORT" = isShort ? "SHORT" : "LONG";
    const btoSpot = typeof pos.btoSpotPrice === "number" && pos.btoSpotPrice > 0
      ? pos.btoSpotPrice
      : typeof pos.spotPrice === "number" && pos.spotPrice > 0
        ? pos.spotPrice
        : 0;
    const entryBucket = pos.openedTs ? Math.floor(toEpochSeconds(pos.openedTs) / 300) * 300 : 0;
    const entryBar = entryBucket > 0 ? series.find((b) => Math.floor(toEpochSeconds(b.timestamp) / 300) * 300 === entryBucket) : undefined;
    const clampedBto = entryBar && btoSpot > 0 ? Math.max(entryBar.low, Math.min(entryBar.high, btoSpot)) : btoSpot;
    const currentSpot = Number.isFinite(liveSpot) && liveSpot > 0 ? liveSpot : clampedBto;
    const delta = Number((isCall ? currentSpot - clampedBto : clampedBto - currentSpot).toFixed(2));
    const nowTs = hasReplayCutoff
      ? (openedSec <= replayBarTsSec! ? replayBarTsSec! : replayBarEndSec)
      : Math.floor(Date.now() / 1000);
    const heldMin =
      openedSec > 0 && nowTs > openedSec
        ? Math.max(1, Math.round((nowTs - openedSec) / 60))
        : 5;

    serverEntries.push({
      id: pos.id,
      timeFormatted: pos.openedTs ? formatPrzmTime(pos.openedAt, pos.openedTs) : (pos.openedAt || ""),
      type,
      contractType: isCall ? "CALL" : "PUT",
      entryPrice: clampedBto,
      btoOptionPrice:
        typeof pos.btoOptionAsk === "number" && pos.btoOptionAsk > 0
          ? pos.btoOptionAsk
          : typeof pos.optionAsk === "number" && pos.optionAsk > 0
            ? pos.optionAsk
            : typeof pos.btoPrice === "number" && pos.btoPrice > 0
              ? pos.btoPrice
              : typeof pos.btoOptionMid === "number" && pos.btoOptionMid > 0
                ? pos.btoOptionMid
                : undefined,
      status: "OPEN",
      delta,
      heldMinutes: heldMin,
      heldLabel: formatHeldDuration(heldMin),
      index: 0,
      contractLabel: (pos.contractLabel || (pos as any).optionSymbol),
      isServerTrade: true,
    });
  }

  if (!signals.length && !serverEntries.length) {
    return {
      entries: [],
      activeCall: null,
      totalCalls: 0,
      rightCount: 0,
      wrongCount: 0,
      flatCount: 0,
      decisiveCount: 0,
      winRatePct: 0,
      avgR: 0,
    };
  }

  const sorted = [...signals]
    .filter((s) => {
      if (!hasReplayCutoff) return true;
      const barTs = toEpochSeconds(s.timestamp ?? series[s.index]?.timestamp);
      return barTs === 0 || barTs <= replayBarEndSec;
    })
    .sort((a, b) => a.index - b.index);
  const lastBarIdx = series.length > 0 ? series.length - 1 : 0;
  const lastBarTsSec = series.length > 0 ? toEpochSeconds(series[lastBarIdx]?.timestamp) : 0;
  const nowSec = hasReplayCutoff ? replayBarTsSec! : Math.floor(Date.now() / 1000);

  const chronologicalEntries: EvaluatedCallEntry[] = sorted.map((sig, idx) => {
    const isNewest = idx === sorted.length - 1;
    const nextSig = idx < sorted.length - 1 ? sorted[idx + 1] : null;

    let exitBarIdx = lastBarIdx;
    if (sig.exitIndex !== undefined) {
      exitBarIdx = Math.min(lastBarIdx, sig.exitIndex);
    } else if (sig.exitTimestamp) {
      const matchIdx = series.findIndex((b) => toEpochSeconds(b.timestamp) === sig.exitTimestamp);
      if (matchIdx >= 0) exitBarIdx = matchIdx;
    } else if (nextSig) {
      exitBarIdx = Math.max(sig.index, nextSig.index);
    }

    const endIdx = exitBarIdx;
    const entryBar = series[sig.index];
    const endBar = series[endIdx] ?? series[lastBarIdx];
    const entryTsSec = toEpochSeconds(entryBar?.timestamp);
    const endTsSec = toEpochSeconds(endBar?.timestamp);
    const exitTsSec = sig.exitTimestamp ? toEpochSeconds(sig.exitTimestamp) : endTsSec;
    const maskedFutureExit =
      hasReplayCutoff && sig.isClosed === true && (exitTsSec === 0 || exitTsSec > replayBarEndSec);
    const barSpanMinutes = Math.max(1, (endIdx - sig.index) * 5);

    const isCurrentlyOpen =
      sig.isClosed === false ||
      maskedFutureExit ||
      (isNewest && activeFsmState !== undefined && activeFsmState === sig.type);

    let heldMinutes = barSpanMinutes;
    if (entryTsSec > 0) {
      let refEndSec = maskedFutureExit ? replayBarTsSec! : endTsSec;
      if (isCurrentlyOpen && lastBarTsSec > 0) {
        if (hasReplayCutoff) {
          refEndSec = replayBarTsSec!;
        } else {
          // Advance to nowSec if stream is within 15 mins of last candle
          refEndSec =
            nowSec >= lastBarTsSec && nowSec - lastBarTsSec <= 15 * 60
              ? nowSec
              : lastBarTsSec;
        }
      }
      if (refEndSec >= entryTsSec) {
        const diffMin = Math.round((refEndSec - entryTsSec) / 60);
        heldMinutes = diffMin >= 1 && diffMin <= 390 ? diffMin : barSpanMinutes;
      }
    }

    const exitPrice = sig.exitPrice ?? endBar?.close ?? sig.price;
    const finalMarkPrice = isCurrentlyOpen
      ? (Number.isFinite(liveSpot) && liveSpot > 0 ? liveSpot : endBar?.close ?? sig.price)
      : exitPrice;

    // Strict Realized P&L Math: (Exit - Entry) * (LONG ? 1 : -1)
    const realizedDelta =
      sig.type === "SHORT" ? sig.price - finalMarkPrice : finalMarkPrice - sig.price;
    const sigFlatTol = 0.005;

    let status: "OPEN" | "RIGHT" | "FLAT" | "WRONG";
    if (isCurrentlyOpen) {
      status = "OPEN";
    } else if (realizedDelta > sigFlatTol) {
      status = "RIGHT";
    } else if (realizedDelta < -sigFlatTol) {
      status = "WRONG";
    } else {
      status = "FLAT";
    }

    return {
      id: sig.id,
      timeFormatted: formatPrzmTime(sig.time, entryBar?.timestamp),
      type: sig.type,
      entryPrice: sig.price,
      status,
      delta: Number(realizedDelta.toFixed(2)),
      heldMinutes,
      heldLabel: formatHeldDuration(heldMinutes),
      index: sig.index,
    };
  });

  // When authoritative server trades exist or have loaded cleanly, lock the ledger to the Single-Slot Sniper Automaton
  // so unexecuted FSM transitions do not dilute the live execution scoreboard.
  const ledgerLoaded =
    serverTrades !== undefined
      ? Boolean(serverTrades.loaded)
      : Boolean(storeState?.serverTradesLoaded);
  const mergedEntries: EvaluatedCallEntry[] =
    serverEntries.length > 0 || ledgerLoaded
      ? [...serverEntries]
      : [...chronologicalEntries];

  let rightCount = mergedEntries.filter((e) => e.status === "RIGHT").length;
  const wrongCount = mergedEntries.filter((e) => e.status === "WRONG").length;
  const flatCount = mergedEntries.filter((e) => e.status === "FLAT").length;

  const completedDecisive = rightCount + wrongCount;
  let decisiveCount = completedDecisive;
  let winRatePct = 0;

  if (completedDecisive > 0) {
    winRatePct = Math.round((rightCount / completedDecisive) * 100);
  } else {
    const openEntry = mergedEntries.find((e) => e.status === "OPEN");
    if (openEntry && openEntry.delta !== 0) {
      decisiveCount = 1;
      rightCount = openEntry.delta > 0 ? 1 : 0;
      winRatePct = openEntry.delta > 0 ? 100 : 0;
    } else {
      decisiveCount = 0;
      winRatePct = 0;
    }
  }

  const openEntry = mergedEntries.find((e) => e.status === "OPEN") ?? null;
  const activeCall = openEntry?.isServerTrade
    ? openEntry
    : activeFsmState === "STAND_ASIDE"
      ? null
      : openEntry;
  const closedWithPct = mergedEntries.filter(
    (e) => e.status !== "OPEN" && typeof e.pnlOptionPct === "number" && Number.isFinite(e.pnlOptionPct)
  );
  const avgR =
    closedWithPct.length > 0
      ? Number(
          (
            closedWithPct.reduce((acc, e) => acc + (e.pnlOptionPct ?? 0) / 45, 0) /
            closedWithPct.length
          ).toFixed(2)
        )
      : 0;

  return {
    entries: [...mergedEntries].reverse(),
    activeCall,
    totalCalls: mergedEntries.length,
    rightCount,
    wrongCount,
    flatCount,
    decisiveCount,
    winRatePct,
    avgR,
  };
}

/**
 * ASCII Section Divider Header (`+--[ TITLE ]-----------------------------------+`)
 */
export const PrzmAsciiHeader: React.FC<{
  title: string;
  rightSlot?: React.ReactNode;
  className?: string;
}> = ({ title, rightSlot, className = "" }) => {
  return (
    <div className={`flex items-center gap-2 select-none font-mono text-[11px] tracking-[0.14em] text-slate-400/90 ${className}`}>
      <span className="text-slate-500/80 shrink-0">+--[</span>
      <span className="font-bold text-slate-200 uppercase shrink-0">{title}</span>
      <span className="text-slate-500/80 shrink-0">]</span>
      <div className="flex-1 overflow-hidden text-slate-700/75 tracking-[0.08em] whitespace-nowrap">
        ------------------------------------------------------------------------------------------------------------------------
      </div>
      {rightSlot && <div className="shrink-0 pl-1">{rightSlot}</div>}
      <span className="text-slate-500/80 shrink-0">+</span>
    </div>
  );
};

/**
 * Top Tactical Triad:
 *   Card 1: +--[ CALL ]----+
 *   Card 2: +--[ TO THE BELL ]----+
 *   Card 3: +--[ DRIVERS ]----+
 */
export const PrzmTopDeck: React.FC<{
  ticker: string;
  liveSpot: number;
  series: PrzmCandlePoint[];
  signals: PrzmSignalPoint[];
  open930?: number;
  priorClose?: number;
  straddleEm?: number;
  zeroGamma0Dte?: number;
  callWall0Dte?: number;
  putWall0Dte?: number;
  netGex?: number;
  activeFsmState?: "LONG" | "SHORT" | "STAND_ASIDE";
  serverTrades?: ServerTradeData;
  supervisorPolicy?: SessionPlaybookPolicy | null;
  isReplayMode?: boolean;
  replayBarTsSec?: number;
}> = ({
  ticker,
  liveSpot,
  series,
  signals,
  open930,
  priorClose,
  straddleEm,
  zeroGamma0Dte,
  callWall0Dte,
  putWall0Dte,
  netGex,
  activeFsmState,
  serverTrades,
  supervisorPolicy,
  isReplayMode = false,
  replayBarTsSec,
}) => {
  const displayTicker = (ticker || "SPY").trim().toUpperCase() || "SPY";
  const ledger = useMemo(
    () => evaluatePrzmCallLedger(signals, series, liveSpot, activeFsmState, serverTrades, displayTicker, replayBarTsSec),
    [signals, series, liveSpot, activeFsmState, serverTrades, displayTicker, replayBarTsSec]
  );

  // Live 1-second clock during RTH, throttled to 15s off-hours to eliminate idle React churn
  const [nowDate, setNowDate] = useState<Date | null>(null);
  useEffect(() => {
    if (isReplayMode) return;
    let timerId: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      const now = new Date();
      setNowDate(now);
      let isRthTick = true;
      try {
        const parts = new Intl.DateTimeFormat("en-US", {
          timeZone: "America/New_York",
          weekday: "short",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).formatToParts(now);
        const wd = parts.find((p) => p.type === "weekday")?.value ?? "";
        const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
        const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
        const mins = h * 60 + m;
        isRthTick = wd !== "Sat" && wd !== "Sun" && mins >= 569 && mins <= 961;
      } catch {}
      timerId = setTimeout(tick, isRthTick ? 1000 : 15000);
    };
    tick();
    return () => {
      cancelled = true;
      if (timerId) clearTimeout(timerId);
    };
  }, [isReplayMode]);

  // Compute RTH (09:30 -> 16:00 ET = 390 mins) progress & countdown
  const bellMetrics = useMemo(() => {
    try {
      const refDate =
        isReplayMode && typeof replayBarTsSec === "number" && replayBarTsSec > 0
          ? new Date(replayBarTsSec * 1000)
          : nowDate;
      if (!refDate) {
        return {
          centerLabel: "--:--",
          subLabel: isReplayMode ? "REPLAY 9:30>4:00" : "9:30 > 4:00",
          progress: 0,
          litTicks: 0,
          isLiveRth: false,
          isOffHours: false,
        };
      }
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        hour: "numeric",
        minute: "numeric",
        second: "numeric",
        hour12: false,
      }).formatToParts(refDate);

      const hr = parseInt(parts.find((p) => p.type === "hour")?.value ?? "12", 10) % 24;
      const min = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
      const sec = parseInt(parts.find((p) => p.type === "second")?.value ?? "0", 10);
      const etMins = hr * 60 + min + sec / 60;

      const sessionEtDate = getTodayEt(refDate);
      const bounds = getSessionBoundsEt(sessionEtDate);
      const rthOpen = bounds.rthOpenMins;
      const rthClose = bounds.rthCloseMins;
      const totalRth = rthClose - rthOpen;
      const closeLabel = bounds.isEarlyClose ? "1:00" : "4:00";

      if (etMins >= rthOpen && etMins < rthClose) {
        const elapsed = etMins - rthOpen;
        const rem = Math.max(0, Math.ceil(rthClose - etMins));
        const remH = Math.floor(rem / 60);
        const remM = rem % 60;
        const progress = Math.min(1, Math.max(0, elapsed / totalRth));
        return {
          centerLabel: `${remH}h${String(remM).padStart(2, "0")}`,
          subLabel: isReplayMode ? `REPLAY 9:30>${closeLabel}` : `9:30 > ${closeLabel}`,
          progress,
          litTicks: Math.max(1, Math.round(progress * 48)),
          isLiveRth: !isReplayMode,
          isOffHours: false,
        };
      }

      if (etMins < rthOpen) {
        return {
          centerLabel: "PRE-MKT",
          subLabel: isReplayMode ? "REPLAY PRE-MKT" : "04:00 > 9:30",
          progress: 0,
          litTicks: 0,
          isLiveRth: false,
          isOffHours: true,
        };
      }

      return {
        centerLabel: "AFTER HRS",
        subLabel: isReplayMode ? "REPLAY POST-MKT" : "16:00 > 20:00",
        progress: 1,
        litTicks: 48,
        isLiveRth: false,
        isOffHours: true,
      };
    } catch {
      return {
        centerLabel: "AFTER HRS",
        subLabel: "9:30 > 4:00",
        progress: 1,
        litTicks: 48,
        isLiveRth: false,
        isOffHours: true,
      };
    }
  }, [nowDate, isReplayMode, replayBarTsSec]);

  const activeCall = ledger.activeCall;

  // 4-Stage @karmaoptions Pre-Vote Flow Laundering + Authoritative Zero Verdict
  const zeroEval = useMemo(() => {
    const inferredMode: "FOLLOW" | "FADE" | "SIT_OUT" =
      supervisorPolicy?.zeroMode ??
      (supervisorPolicy?.standAsideVetoReason
        ? "SIT_OUT"
        : supervisorPolicy?.regime === "POS_GAMMA_PIN"
          ? "FADE"
          : "FOLLOW");
    return evaluateZeroFlowFilter({
      ticker: displayTicker,
      candles: series.map((pt) => ({
        timestamp: pt.timestamp ?? 0,
        open: pt.open,
        high: pt.high,
        low: pt.low,
        close: pt.close,
        volume: pt.volume,
        flowVwap: pt.flowVwap,
        vwap: pt.vwap,
        sigma: pt.sigma,
        chi: pt.chi,
        impulseChi: pt.impulseChi,
        pe: pt.pe,
        impulsePe: pt.impulsePe,
        netFluxJ: pt.boundaryFlux,
        deltaNetFlux6Bar: pt.deltaNetFlux6Bar,
      })),
      liveSpot,
      open930: open930 ?? null,
      priorClose: priorClose ?? null,
      straddleEm: straddleEm ?? null,
      zeroGamma0Dte: zeroGamma0Dte ?? null,
      callWall0Dte: callWall0Dte ?? null,
      putWall0Dte: putWall0Dte ?? null,
      netGex: netGex ?? null,
      activeCallDirection: activeCall?.type ?? null,
      activeCallEntryPrice: activeCall?.entryPrice ?? null,
      regimeMode: inferredMode,
      standAsideVetoReason: supervisorPolicy?.standAsideVetoReason ?? null,
    });
  }, [
    displayTicker,
    series,
    liveSpot,
    open930,
    priorClose,
    straddleEm,
    zeroGamma0Dte,
    callWall0Dte,
    putWall0Dte,
    netGex,
    activeCall?.type,
    activeCall?.entryPrice,
    supervisorPolicy?.zeroMode,
    supervisorPolicy?.standAsideVetoReason,
    supervisorPolicy?.regime,
  ]);

  const drivers = zeroEval.drivers;
  const convictionScore = zeroEval.compositeScore;
  const activeVerdict = zeroEval.verdict; // "LONG" | "SHORT" | "STAND_ASIDE"
  const litSegments =
    activeVerdict === "STAND_ASIDE"
      ? Math.max(0, Math.min(24, Math.round((Math.abs(convictionScore) / 100) * 24)))
      : Math.max(3, Math.min(24, Math.round((Math.abs(convictionScore) / 100) * 24)));

  const effectivePolicy = useMemo(() => {
    if (supervisorPolicy) return supervisorPolicy;
    const derivedRegime: SessionPlaybookPolicy["regime"] =
      activeFsmState === "STAND_ASIDE" && activeVerdict === "STAND_ASIDE"
        ? "LOW_EDGE_CHOP"
        : Math.abs(convictionScore) >= 40
          ? "NEG_GAMMA_TREND"
          : Math.abs(drivers[4]?.value ?? 0) <= 18
            ? "POS_GAMMA_PIN"
            : "ZERO_GAMMA_FLIP";
    const derivedMode: NonNullable<SessionPlaybookPolicy["zeroMode"]> =
      derivedRegime === "LOW_EDGE_CHOP"
        ? "SIT_OUT"
        : derivedRegime === "POS_GAMMA_PIN"
          ? "FADE"
          : "FOLLOW";
    return {
      sessionDate: "",
      ticker: displayTicker,
      checkpoint: "INTRADAY" as const,
      evaluatedAtEt: isReplayMode ? "REPLAY" : "LIVE",
      evaluatedAtTs: 0,
      regime: derivedRegime,
      allowedRegimes: derivedRegime === "LOW_EDGE_CHOP" ? [] : [derivedRegime],
      preferredDte:
        derivedRegime === "LOW_EDGE_CHOP"
          ? ("NONE" as const)
          : derivedRegime === "POS_GAMMA_PIN"
            ? ("1-2DTE" as const)
            : ("0DTE" as const),
      minExpectancyR: 0,
      minWinRatePct: 0,
      standAsideVetoReason:
        derivedRegime === "LOW_EDGE_CHOP"
          ? zeroEval.verdictReason
          : null,
      kingDivergencePct: 0,
      trailing5dDrawdownDollars: 0,
      trailing5dPnlDollars: 0,
      zeroGammaSide: "AT" as const,
      wallCorridorPct: 0,
      absPeclet: 0,
      summary: "",
      zeroMode: derivedMode,
      zeroModeReason: zeroEval.verdictReason,
      tollShieldActive: false,
    };
  }, [supervisorPolicy, activeFsmState, activeVerdict, convictionScore, drivers, displayTicker, isReplayMode, zeroEval.verdictReason]);

  const effectiveZeroMode =
    effectivePolicy.zeroMode ??
    (effectivePolicy.standAsideVetoReason ? "SIT_OUT" : effectivePolicy.regime === "POS_GAMMA_PIN" ? "FADE" : "FOLLOW");

  const regimeBadgeStyle =
    effectivePolicy.regime === "POS_GAMMA_PIN"
      ? "bg-cyan-500/15 text-[#00F5D4] border-cyan-500/40"
      : effectivePolicy.regime === "NEG_GAMMA_TREND"
        ? "bg-rose-500/15 text-[#FF2A55] border-rose-500/40"
        : effectivePolicy.regime === "ZERO_GAMMA_FLIP"
          ? "bg-amber-500/15 text-amber-300 border-amber-500/40"
          : "bg-slate-800/80 text-slate-300 border-slate-700/80";

  const modeBadgeStyle =
    effectiveZeroMode === "FOLLOW"
      ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/40"
      : effectiveZeroMode === "FADE"
        ? "bg-cyan-500/15 text-cyan-300 border-cyan-500/40"
        : "bg-amber-500/15 text-amber-300 border-amber-500/40";

  const launderTag = zeroEval.stageTelemetry.counterTrendBounceDiscounted
    ? "BOUNCE DAMPED"
    : zeroEval.stageTelemetry.putSeatbeltDiscounted
      ? "SEATBELT FILTER"
      : zeroEval.stageTelemetry.outlierScrubbed
        ? "SPIKE SCRUBBED"
        : "4-STAGE CLEAN";

  return (
    <>
      {/* SUPERVISOR POLICY STRIP */}
      <div className="mb-3 rounded-lg bg-[#111322]/95 border border-slate-800/80 px-3.5 py-2 flex flex-wrap items-center justify-between gap-2.5 font-mono text-[11px] tabular-nums shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="text-[10px] font-bold tracking-[0.14em] text-slate-400 uppercase">
            SUPERVISOR
          </span>
          <span
            className={`px-2 py-0.5 rounded border text-[10px] font-bold tracking-wider ${regimeBadgeStyle}`}
          >
            {effectivePolicy.regime}
          </span>
          <span
            className={`px-2 py-0.5 rounded border text-[10px] font-bold tracking-wider ${modeBadgeStyle}`}
          >
            MODE: {effectiveZeroMode === "SIT_OUT" ? "SIT OUT" : effectiveZeroMode}
          </span>
          <span className="text-slate-400">
            PREF{" "}
            <strong className={effectivePolicy.preferredDte === "1-2DTE" ? "text-cyan-300" : "text-slate-100"}>
              {effectivePolicy.preferredDte === "1-2DTE" ? "1DTE" : effectivePolicy.preferredDte}
            </strong>
            {effectivePolicy.tollShieldActive && (
              <span className="ml-1 text-[10px] text-cyan-400">(Toll Shield)</span>
            )}
          </span>
          <span className="text-slate-600">|</span>
          <span className="text-slate-400">
            MIN E[R]{" "}
            {effectivePolicy.minExpectancyR > 0 ? (
              <>
                <strong className="text-emerald-300 tabular-nums">
                  +{effectivePolicy.minExpectancyR.toFixed(2)}R
                </strong>{" "}
                <span className="text-slate-500 tabular-nums">
                  ({effectivePolicy.minWinRatePct.toFixed(0)}% WR)
                </span>
              </>
            ) : (
              <strong className="text-slate-300">CAUSAL</strong>
            )}
          </span>
          <span className="text-slate-600 hidden sm:inline">|</span>
          <span className="text-slate-400 hidden sm:inline" title="Minutes elapsed since recent 90m swing turn">
            LAG <strong className="text-slate-200 tabular-nums">{zeroEval.turnLagMins}m</strong>
          </span>
          <span className="text-slate-600 hidden md:inline">|</span>
          <span className="text-slate-400 hidden md:inline">
            CKPT{" "}
            <strong className="text-slate-200">{effectivePolicy.checkpoint}</strong>
            {effectivePolicy.evaluatedAtEt ? (
              <span className="text-slate-500 ml-1">({effectivePolicy.evaluatedAtEt})</span>
            ) : null}
          </span>
        </div>

        {effectivePolicy.standAsideVetoReason ? (
          <div className="px-2.5 py-0.5 rounded border border-amber-500/45 bg-amber-950/40 text-amber-200 text-[10px] font-bold tracking-wide max-w-full truncate">
            STAND ASIDE · {effectivePolicy.standAsideVetoReason}
          </div>
        ) : effectivePolicy.trailing5dDrawdownDollars > 0 ? (
          <div className="text-[10px] text-slate-400 tabular-nums">
            5D DD{" "}
            <span className={effectivePolicy.trailing5dDrawdownDollars >= 150 ? "text-amber-300 font-bold" : "text-slate-300"}>
              ${effectivePolicy.trailing5dDrawdownDollars.toFixed(0)}
            </span>
          </div>
        ) : null}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3.5 mb-3.5">
      {/* CARD 1: +--[ CALL ]----+ (5 Columns on lg) */}
      <div className="lg:col-span-5 rounded-xl bg-[#131424]/95 border border-slate-800/80 px-4 py-3.5 flex flex-col justify-between shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
        <PrzmAsciiHeader
          title="CALL"
          rightSlot={
            <span className="text-[10px] font-mono font-bold tracking-wider text-slate-400">
              {effectiveZeroMode === "SIT_OUT" ? "SIT OUT" : effectiveZeroMode}
            </span>
          }
        />

        <div className="my-2.5">
          <div className="flex items-baseline justify-between gap-2.5">
            <span
              className={`font-mono text-xl sm:text-[25px] font-black tracking-tight flex items-center gap-2 ${
                activeVerdict === "LONG"
                  ? "text-[#00F5D4] drop-shadow-[0_0_12px_rgba(0,245,212,0.35)]"
                  : activeVerdict === "SHORT"
                    ? "text-[#FF2A55] drop-shadow-[0_0_12px_rgba(255,42,85,0.35)]"
                    : "text-amber-300/95"
              }`}
            >
              <span>
                {activeVerdict === "LONG" ? "↗" : activeVerdict === "SHORT" ? "↘" : "—"}
              </span>
              <span>
                {activeVerdict === "STAND_ASIDE"
                  ? effectiveZeroMode === "SIT_OUT"
                    ? "SIT OUT"
                    : "STAND ASIDE"
                  : activeVerdict}
              </span>
            </span>
            <span className="font-mono text-xl sm:text-2xl font-bold tabular-nums text-slate-100 tracking-tight">
              ${liveSpot.toFixed(2)}
            </span>
          </div>

          <div className="mt-1.5">
            <span
              className={`inline-block px-2 py-0.5 rounded text-[10px] font-mono font-semibold tracking-wider border ${
                activeVerdict === "LONG"
                  ? "bg-emerald-500/10 border-emerald-500/35 text-emerald-300"
                  : activeVerdict === "SHORT"
                    ? "bg-rose-500/10 border-rose-500/35 text-rose-300"
                    : "bg-slate-900/90 border-slate-700/80 text-slate-300"
              }`}
            >
              {zeroEval.verdictReason}
            </span>
          </div>

          {/* 24-Segment Horizontal LED Composite Conviction Bar */}
          <div className="mt-3 flex items-center gap-2.5">
            <div className="flex-1 flex items-center gap-[3px] h-4 bg-[#0b0c16] px-2 py-1 rounded border border-slate-800/70">
              {Array.from({ length: 24 }).map((_, idx) => {
                const isLit = idx < litSegments;
                const activeColor =
                  activeVerdict === "LONG"
                    ? "bg-[#00F5D4] shadow-[0_0_6px_rgba(0,245,212,0.55)]"
                    : activeVerdict === "SHORT"
                      ? "bg-[#FF2A55] shadow-[0_0_6px_rgba(255,42,85,0.55)]"
                      : convictionScore >= 0
                        ? "bg-slate-400/65"
                        : "bg-amber-400/65";
                return (
                  <div
                    key={idx}
                    className={`flex-1 h-2.5 rounded-[1px] transition-all duration-300 ${
                      isLit ? activeColor : "bg-slate-800/55"
                    }`}
                  />
                );
              })}
            </div>
            <span
              className={`font-mono text-xs font-bold tabular-nums min-w-[38px] text-right ${
                activeVerdict === "LONG"
                  ? "text-[#00F5D4]"
                  : activeVerdict === "SHORT"
                    ? "text-[#FF2A55]"
                    : "text-slate-300"
              }`}
              title="Laundered multi-driver composite conviction (-100..+100)"
            >
              {convictionScore > 0 ? `+${convictionScore}` : convictionScore}
            </span>
          </div>
        </div>

        {/* Active Server Position Risk Telemetry (Contract · Option P&L % · Stop · Target) */}
        {(() => {
          const rawActiveMap = serverTrades?.activePositions || {};
          const openTrade = Object.values(rawActiveMap).find(
            (p: any) =>
              p &&
              p.status !== "CLOSED" &&
              (!p.ticker || p.ticker.toUpperCase() === displayTicker)
          ) as any;
          if (!openTrade) return null;
          const optPct = typeof openTrade.pnlOptionPct === "number" ? openTrade.pnlOptionPct : null;
          return (
            <div className="mb-2.5 px-2.5 py-1.5 rounded-lg bg-[#0b0d17] border border-cyan-500/35 flex flex-wrap items-center justify-between gap-2 font-mono text-[10.5px] tabular-nums">
              <span className="font-bold text-amber-300">
                OPEN {openTrade.ticker || displayTicker} {openTrade.strike}
                {openTrade.contractType === "CALL" ? "C" : "P"}
                {typeof openTrade.btoOptionMid === "number" ? ` @ $${openTrade.btoOptionMid.toFixed(2)}` : ""}
              </span>
              <div className="flex items-center gap-2.5">
                {optPct !== null && (
                  <span className={optPct >= 0 ? "text-emerald-400 font-bold" : "text-rose-400 font-bold"}>
                    {optPct >= 0 ? "+" : ""}
                    {optPct.toFixed(1)}%
                  </span>
                )}
                {typeof openTrade.stopLossSpot === "number" && openTrade.stopLossSpot > 0 && (
                  <span className="text-rose-300">SL ${openTrade.stopLossSpot.toFixed(2)}</span>
                )}
                {typeof openTrade.target1Spot === "number" && openTrade.target1Spot > 0 && (
                  <span className="text-emerald-300">T1 ${openTrade.target1Spot.toFixed(2)}</span>
                )}
              </div>
            </div>
          );
        })()}

        {/* Bottom 3-Metric Strip */}
        <div className="pt-2.5 border-t border-slate-800/70 flex items-center justify-between font-mono text-[11px] tracking-[0.08em]">
          <div>
            <span className="text-slate-500 mr-1.5">{displayTicker}</span>
            <span className="text-slate-100 font-bold tabular-nums">{liveSpot.toFixed(2)}</span>
          </div>
          <div>
            <span className="text-slate-500 mr-1.5">CALLS TODAY</span>
            <span className="text-slate-100 font-bold tabular-nums">{ledger.totalCalls}</span>
          </div>
          <div>
            <span className="text-slate-500 mr-1.5">RIGHT</span>
            <span className="text-[#00F5D4] font-bold tabular-nums">{ledger.winRatePct}%</span>
          </div>
        </div>
      </div>

      {/* CARD 2: +--[ TO THE BELL ]----+ (3 Columns on lg) */}
      <div className="lg:col-span-3 rounded-xl bg-[#131424]/95 border border-slate-800/80 px-4 py-3.5 flex flex-col justify-between shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
        <PrzmAsciiHeader title="TO THE BELL" />

        <div className="my-1 flex items-center justify-center">
          <svg viewBox="0 0 144 144" className="w-[132px] h-[132px] overflow-visible">
            {Array.from({ length: 48 }).map((_, idx) => {
              const angle = -Math.PI / 2 + (idx / 48) * Math.PI * 2;
              const rIn = 49;
              const rOut = 59;
              const x1 = Number((72 + rIn * Math.cos(angle)).toFixed(3));
              const y1 = Number((72 + rIn * Math.sin(angle)).toFixed(3));
              const x2 = Number((72 + rOut * Math.cos(angle)).toFixed(3));
              const y2 = Number((72 + rOut * Math.sin(angle)).toFixed(3));
              const isLit = idx < bellMetrics.litTicks;
              const isTip = idx === bellMetrics.litTicks - 1;
              return (
                <line
                  key={idx}
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                  stroke={isLit ? "#00F5D4" : "rgba(148, 163, 184, 0.16)"}
                  strokeWidth={isTip ? 3.2 : 2.3}
                  strokeLinecap="round"
                  style={
                    isLit
                      ? { filter: "drop-shadow(0 0 4px rgba(0, 245, 212, 0.45))" }
                      : undefined
                  }
                />
              );
            })}
            <text
              x="72"
              y="72"
              textAnchor="middle"
              dominantBaseline="central"
              fill="#F8FAFC"
              className={`font-mono font-black tracking-tight ${
                bellMetrics.isOffHours ? "text-[14px]" : "text-[23px]"
              }`}
            >
              {bellMetrics.centerLabel}
            </text>
            <text
              x="72"
              y="92"
              textAnchor="middle"
              fill="#64748B"
              className="font-mono text-[9.5px] tracking-[0.12em]"
            >
              {bellMetrics.subLabel}
            </text>
          </svg>
        </div>
      </div>

      {/* CARD 3: +--[ DRIVERS ]----+ (4 Columns on lg) */}
      <div className="lg:col-span-4 rounded-xl bg-[#131424]/95 border border-slate-800/80 px-4 py-3.5 flex flex-col justify-between shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
        <PrzmAsciiHeader
          title="DRIVERS"
          rightSlot={
            <span className="text-[9.5px] font-mono font-bold tracking-wider text-cyan-300/90">
              {launderTag}
            </span>
          }
        />

        <div className="mt-2.5 flex-1 grid grid-cols-5 gap-2.5 items-end pt-1">
          {drivers.map((drv) => {
            const activeCount = drv.isPct
              ? Math.max(1, Math.min(10, Math.round(drv.value / 10)))
              : Math.max(1, Math.min(10, Math.ceil(Math.abs(drv.value) / 10)));

            const valColor = drv.isPct
              ? "text-[#A78BFA]"
              : drv.value > 0
              ? "text-[#00F5D4]"
              : drv.value < -15
              ? "text-[#FF2A55]"
              : "text-[#A78BFA]";

            const segColor = drv.isPct
              ? "bg-[#8B5CF6] shadow-[0_0_6px_rgba(139,92,246,0.45)]"
              : drv.value > 0
              ? "bg-[#00F5D4] shadow-[0_0_6px_rgba(0,245,212,0.45)]"
              : drv.value < -15
              ? "bg-[#FF2A55] shadow-[0_0_6px_rgba(255,42,85,0.45)]"
              : "bg-[#8B5CF6] shadow-[0_0_6px_rgba(139,92,246,0.4)]";

            return (
              <div key={drv.key} className="flex flex-col items-center gap-1.5">
                <span className={`font-mono text-[11px] font-bold tabular-nums ${valColor}`}>
                  {drv.display}
                </span>

                {/* 10 Vertical Stacked Segments (rendered top-to-bottom: idx 9 down to 0) */}
                <div className="w-full max-w-[38px] bg-[#0b0c16] p-1.5 rounded border border-slate-800/70 flex flex-col gap-[3px]">
                  {Array.from({ length: 10 }).map((_, i) => {
                    const segLevel = 9 - i; // 9 at top, 0 at bottom
                    const isLit = segLevel < activeCount;
                    return (
                      <div
                        key={i}
                        className={`w-full h-[5px] rounded-[1px] transition-all duration-300 ${
                          isLit ? segColor : "bg-slate-800/50"
                        }`}
                      />
                    );
                  })}
                </div>

                <span className="font-mono text-[10px] tracking-[0.12em] text-slate-400 uppercase">
                  {drv.key}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
    </>
  );
};

/**
 * Bottom Tactical Ledger & Win-Rate Scoreboard (`+--[ CALL LOG ]----+`)
 */
export const PrzmCallLogDeck: React.FC<{
  signals: PrzmSignalPoint[];
  series: PrzmCandlePoint[];
  liveSpot: number;
  activeFsmState?: "LONG" | "SHORT" | "STAND_ASIDE";
  serverTrades?: ServerTradeData;
  zeroShadow?: ZeroShadowReadout | null;
  ticker?: string;
  replayBarTsSec?: number;
}> = ({
  signals,
  series,
  liveSpot,
  activeFsmState,
  serverTrades,
  zeroShadow,
  ticker = "SPY",
  replayBarTsSec,
}) => {
  const [activeTab, setActiveTab] = useState<"LIVE" | "SHADOW">("LIVE");
  const ledger = useMemo(
    () => evaluatePrzmCallLedger(signals, series, liveSpot, activeFsmState, serverTrades, ticker, replayBarTsSec),
    [signals, series, liveSpot, activeFsmState, serverTrades, ticker, replayBarTsSec]
  );

  const shadowEntries = useMemo(
    () => [...(zeroShadow?.entriesToday ?? [])].reverse(),
    [zeroShadow?.entriesToday]
  );
  const shadowModeScores = zeroShadow?.modeScores ?? [];

  return (
    <div className="mt-3.5 rounded-xl bg-[#131424]/95 border border-slate-800/80 px-4 py-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
      <PrzmAsciiHeader
        title="CALL LOG"
        rightSlot={
          <div className="flex items-center gap-1.5 font-mono text-[10px] tabular-nums">
            <button
              type="button"
              onClick={() => setActiveTab("LIVE")}
              className={`px-2 py-0.5 rounded border transition cursor-pointer ${
                activeTab === "LIVE"
                  ? "bg-emerald-500/15 border-emerald-400/55 text-emerald-300 font-bold"
                  : "bg-slate-900/80 border-slate-800 text-slate-400 hover:text-slate-200"
              }`}
            >
              LIVE ({ledger.entries.length})
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("SHADOW")}
              className={`px-2 py-0.5 rounded border transition cursor-pointer ${
                activeTab === "SHADOW"
                  ? "bg-cyan-500/15 border-cyan-400/55 text-cyan-300 font-bold"
                  : "bg-slate-900/80 border-slate-800 text-slate-400 hover:text-slate-200"
              }`}
              title="Paper-only experimental Zero modes (Ask-in / Bid-out, isolated from live portfolio lock)"
            >
              SHADOW ({shadowEntries.length})
            </button>
          </div>
        }
      />

      {activeTab === "LIVE" ? (
        <div className="mt-3 grid grid-cols-1 lg:grid-cols-12 gap-4 items-center">
          {/* Left: Chronological Live Server Trade Ledger (8 cols) */}
          <div className="lg:col-span-8 divide-y divide-slate-800/60 font-mono text-xs tabular-nums">
            {ledger.entries.length === 0 ? (
              <div className="py-4 text-slate-500 tracking-wider uppercase text-[11px]">
                NO LIVE EXECUTIONS YET TODAY · STANDING GUARD FOR A+ CONFLUENCE
              </div>
            ) : (
              ledger.entries.map((entry) => {
                const isCallOpt =
                  entry.contractType === "CALL" || (!entry.contractType && entry.type === "LONG");
                const sideColor = isCallOpt ? "text-[#00F5D4]" : "text-[#FF2A55]";
                const pillStyle = isCallOpt
                  ? "bg-emerald-500/12 border-emerald-500/40 text-emerald-300"
                  : "bg-rose-500/12 border-rose-500/40 text-rose-300";
                const dirLabel = entry.contractType
                  ? `${entry.type} · ${entry.contractType}`
                  : entry.type;
                const shortContract = entry.contractLabel
                  ? entry.contractLabel.replace(/\s*\(.*\)/, "")
                  : null;

                let statusBadge = "";
                let statusColor = "text-slate-300";

                const signedDelta =
                  entry.delta > 0
                    ? `+${entry.delta.toFixed(2)}`
                    : entry.delta.toFixed(2);

                if (entry.status === "OPEN") {
                  statusBadge = `OPEN ${signedDelta} pts`;
                  statusColor = "text-[#A78BFA] font-bold";
                } else if (entry.status === "RIGHT") {
                  const optPctStr =
                    typeof entry.pnlOptionPct === "number"
                      ? `STC ${entry.pnlOptionPct > 0 ? "+" : ""}${entry.pnlOptionPct.toFixed(1)}% · `
                      : "STC · ";
                  statusBadge = `${optPctStr}${signedDelta} pts · RIGHT`;
                  statusColor = "text-[#10b981] font-bold";
                } else if (entry.status === "FLAT") {
                  statusBadge = `SCRATCH ${signedDelta} pts`;
                  statusColor = "text-slate-400 font-semibold";
                } else {
                  const optPctStr =
                    typeof entry.pnlOptionPct === "number"
                      ? `STC ${entry.pnlOptionPct > 0 ? "+" : ""}${entry.pnlOptionPct.toFixed(1)}% · `
                      : "STC · ";
                  statusBadge = `${optPctStr}${signedDelta} pts · WRONG`;
                  statusColor = "text-[#FF2A55] font-bold";
                }

                return (
                  <div
                    key={entry.id}
                    className="py-2.5 flex flex-wrap items-center justify-between gap-3 hover:bg-slate-800/20 px-2 rounded transition-colors"
                  >
                    <span className="text-slate-300 font-semibold tabular-nums min-w-[72px] shrink-0">
                      {entry.timeFormatted}
                    </span>
                    <span className="text-slate-500 text-[10.5px] tabular-nums shrink-0">
                      {entry.heldLabel}
                    </span>
                    <span className={`font-bold tracking-wider min-w-[88px] shrink-0 ${sideColor}`}>
                      {dirLabel}
                    </span>
                    <span className="text-slate-200 tabular-nums font-semibold shrink-0">
                      ${entry.entryPrice.toFixed(2)}
                      {entry.closedPrice && entry.status !== "OPEN" && (
                        <span className="text-slate-400 font-normal">
                          {" → "}${entry.closedPrice.toFixed(2)}
                          {entry.closedTimeFormatted ? ` (${entry.closedTimeFormatted})` : ""}
                        </span>
                      )}
                    </span>
                    {shortContract && (
                      <span
                        className={`px-2 py-0.5 rounded border font-mono text-[10.5px] font-semibold truncate max-w-[210px] ${pillStyle}`}
                        title={entry.contractLabel}
                      >
                        {shortContract}
                      </span>
                    )}
                    {typeof entry.btoOptionPrice === "number" && entry.btoOptionPrice > 0 && (
                      <span
                        className="text-slate-300 font-mono text-[11px] tabular-nums shrink-0"
                        title={
                          entry.exitQuoteSource
                            ? `Entry Ask → Exit Bid (${entry.exitQuoteSource})`
                            : "Entry Ask → Exit Bid"
                        }
                      >
                        {typeof entry.stcOptionPrice === "number" && entry.stcOptionPrice > 0 && entry.status !== "OPEN"
                          ? "$" + entry.btoOptionPrice.toFixed(2) + " → $" + entry.stcOptionPrice.toFixed(2)
                          : "@ $" + entry.btoOptionPrice.toFixed(2)}
                        {entry.status !== "OPEN" && entry.exitQuoteSource && (
                          <span className="ml-1.5 text-[9.5px] text-slate-500 uppercase">
                            {entry.exitQuoteSource === "LIVE_CHAIN_BID"
                              ? "LIVE"
                              : entry.exitQuoteSource === "DELAYED_CBOE_BID"
                                ? "CBOE"
                                : "BS"}
                          </span>
                        )}
                      </span>
                    )}
                    <span className={`tabular-nums tracking-wide text-right flex-1 ${statusColor}`}>
                      {statusBadge}
                    </span>
                  </div>
                );
              })
            )}
          </div>

          {/* Right: Live Win-Rate & Expectancy Scoreboard (4 cols) */}
          <div className="lg:col-span-4 lg:border-l lg:border-slate-800/80 lg:pl-6 flex flex-col items-center lg:items-end justify-center py-2 font-mono tabular-nums">
            <div
              className={`text-4xl sm:text-5xl font-black tracking-tight text-slate-100 transition-all duration-200 ease-out ${
                ledger.decisiveCount === 0 || ledger.winRatePct >= 50
                  ? "drop-shadow-[0_0_18px_rgba(0,245,212,0.25)]"
                  : "drop-shadow-[0_0_18px_rgba(255,42,85,0.25)]"
              }`}
            >
              {ledger.decisiveCount > 0 ? `${ledger.winRatePct}%` : "—"}
            </div>
            <div className="mt-1 text-[11px] tracking-[0.14em] text-slate-400 uppercase">
              {ledger.rightCount} OF {ledger.decisiveCount} RIGHT
              {ledger.decisiveCount > 0 && (
                <span className={`ml-2 font-bold ${ledger.avgR >= 0 ? "text-emerald-300" : "text-rose-300"}`}>
                  ({ledger.avgR >= 0 ? "+" : ""}
                  {ledger.avgR.toFixed(2)}R)
                </span>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="mt-3 grid grid-cols-1 lg:grid-cols-12 gap-4 items-center font-mono tabular-nums">
          {/* Left: Causal Paper-Only Shadow Modes (Ask-in / Bid-out) */}
          <div className="lg:col-span-8 divide-y divide-slate-800/60 text-xs">
            {shadowEntries.length === 0 ? (
              <div className="py-4 text-slate-500 tracking-wider uppercase text-[11px]">
                SHADOW LEDGER ARMED (FOLLOW · FADE · 1DTE) · AWAITING REAL ASK/BID QUOTE TRIGGER
              </div>
            ) : (
              shadowEntries.map((sh) => {
                const isCall = sh.contractType === "CALL";
                const pillStyle = isCall
                  ? "bg-emerald-500/12 border-emerald-500/40 text-emerald-300"
                  : "bg-rose-500/12 border-rose-500/40 text-rose-300";
                const pctStr = `${sh.pnlOptionPct >= 0 ? "+" : ""}${sh.pnlOptionPct.toFixed(1)}%`;
                const statusColor =
                  sh.status === "RIGHT"
                    ? "text-emerald-400 font-bold"
                    : sh.status === "WRONG"
                      ? "text-rose-400 font-bold"
                      : sh.status === "SCRATCH"
                        ? "text-slate-400 font-semibold"
                        : "text-cyan-300 font-bold";
                return (
                  <div
                    key={sh.id}
                    className="py-2.5 flex flex-wrap items-center justify-between gap-2.5 hover:bg-slate-800/20 px-2 rounded"
                  >
                    <span className="text-slate-300 font-semibold min-w-[66px]">{sh.openedTimeEt}</span>
                    <span className="px-1.5 py-0.5 rounded bg-slate-900 border border-slate-700/80 text-[10px] text-cyan-300 font-bold">
                      {sh.modeBadge}
                    </span>
                    <span className={`px-2 py-0.5 rounded border text-[10.5px] font-semibold ${pillStyle}`}>
                      {sh.contractLabel}
                    </span>
                    <span className="text-slate-300 text-[11px]">
                      Ask ${sh.entryAsk.toFixed(2)} → Bid ${(sh.exitBid ?? sh.currentBid).toFixed(2)}
                    </span>
                    <span className="text-slate-500 text-[10px]">LAG {sh.entryLagMins}m</span>
                    <span className={`text-right flex-1 ${statusColor}`}>
                      {sh.status === "OPEN" ? `OPEN ${pctStr}` : `${pctStr} (${sh.rMultiple >= 0 ? "+" : ""}${sh.rMultiple.toFixed(2)}R) · ${sh.status}`}
                    </span>
                  </div>
                );
              })
            )}
          </div>

          {/* Right: Rolling Public Shadow Mode Scoreboard */}
          <div className="lg:col-span-4 lg:border-l lg:border-slate-800/80 lg:pl-5 flex flex-col gap-1.5 py-1.5 text-[11px]">
            <div className="text-[10px] tracking-[0.14em] text-slate-400 uppercase mb-0.5">
              ROLLING SHADOW SCOREBOARD (ISOLATED)
            </div>
            {shadowModeScores.length === 0 ? (
              <div className="text-slate-500 text-[10.5px]">NO CLOSED SHADOW SAMPLES YET</div>
            ) : (
              shadowModeScores.map((ms) => (
                <div
                  key={ms.mode}
                  className="flex items-center justify-between px-2.5 py-1 rounded bg-[#0c0e1a] border border-slate-800/80"
                >
                  <span className="font-bold text-slate-200">{ms.label}</span>
                  <span className="text-slate-400">
                    {ms.totalClosed > 0 ? (
                      <>
                        <strong className={ms.winRatePct >= 50 ? "text-emerald-300" : "text-rose-300"}>
                          {ms.winRatePct}% WR
                        </strong>{" "}
                        ·{" "}
                        <span className={ms.avgR >= 0 ? "text-cyan-300" : "text-amber-300"}>
                          {ms.avgR >= 0 ? "+" : ""}
                          {ms.avgR.toFixed(2)}R
                        </span>{" "}
                        <span className="text-slate-500">({ms.rightCount}/{ms.totalClosed})</span>
                      </>
                    ) : (
                      <span className="text-slate-500">0 samples</span>
                    )}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
};
