"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useDashboardStore } from "@/store/useDashboardStore";
import {
  getSessionBoundsEt,
  getTodayEt,
  toEpochSec,
} from "@/lib/gaiaSessionGuards";
import type { SessionPlaybookPolicy } from "@/lib/persistenceStore";

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
      typeof pos.btoOptionMid === "number" && pos.btoOptionMid > 0
        ? pos.btoOptionMid
        : typeof pos.btoPrice === "number" && pos.btoPrice > 0
          ? pos.btoPrice
          : undefined;
    const stcOpt =
      typeof pos.closedOptionMid === "number" && pos.closedOptionMid > 0
        ? pos.closedOptionMid
        : typeof pos.stcPrice === "number" && pos.stcPrice > 0
          ? pos.stcPrice
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
    const hasOptPnl = typeof pos.pnlOptionPct === "number" && Number.isFinite(pos.pnlOptionPct);
    const isLoss = hasOptPnl
      ? pos.pnlOptionPct < 0 || delta < -0.005
      : delta < -0.005 || Boolean(pos.exitReason?.includes("STOP")) || (typeof pos.pnlSpotPct === "number" && pos.pnlSpotPct < 0);
    const isWin = !isLoss && (
      hasOptPnl
        ? pos.pnlOptionPct > 0 && delta >= 0
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
      pnlOptionPct: typeof pos.pnlOptionPct === "number" ? pos.pnlOptionPct : undefined,
      btoOptionPrice: btoOpt,
      stcOptionPrice: stcOpt,
      status,
      delta,
      heldMinutes: heldMin,
      heldLabel: formatHeldDuration(heldMin),
      index: 0,
      contractLabel: (pos.contractLabel || (pos as any).optionSymbol),
      exitReason: pos.exitReason,
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
        typeof pos.btoOptionMid === "number" && pos.btoOptionMid > 0
          ? pos.btoOptionMid
          : typeof pos.btoPrice === "number" && pos.btoPrice > 0
            ? pos.btoPrice
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
  const activeCall = activeFsmState === "STAND_ASIDE" ? null : openEntry;

  return {
    entries: [...mergedEntries].reverse(),
    activeCall,
    totalCalls: mergedEntries.length,
    rightCount,
    wrongCount,
    flatCount,
    decisiveCount,
    winRatePct,
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
  straddleEm?: number;
  activeFsmState?: "LONG" | "SHORT" | "STAND_ASIDE";
  serverTrades?: ServerTradeData;
  supervisorPolicy?: SessionPlaybookPolicy | null;
  isReplayMode?: boolean;
  replayBarTsSec?: number;
}> = ({ ticker, liveSpot, series, signals, open930, straddleEm, activeFsmState, serverTrades, supervisorPolicy, isReplayMode = false, replayBarTsSec }) => {
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

  // Compute the 5 multi-timeframe Drivers (SES, 30M, 10M, STDY, PX)
  const drivers = useMemo(() => {
    const n = series.length;
    if (n === 0) {
      return [
        { key: "SES", value: 0, display: "0", isPct: false },
        { key: "30M", value: 0, display: "0", isPct: false },
        { key: "10M", value: 0, display: "0", isPct: false },
        { key: "STDY", value: 75, display: "75%", isPct: true },
        { key: "PX", value: 0, display: "0", isPct: false },
      ];
    }

    const last = series[n - 1];
    const spot = Number.isFinite(liveSpot) && liveSpot > 0 ? liveSpot : last.close;
    const em = Math.max(Math.max(0.05, spot * 0.0005), straddleEm || spot * 0.0048);

    // 1. SES: Session bias relative to 9:30 Open
    const baseOpen = open930 || series[0]?.open || spot;
    const sesRaw = ((spot - baseOpen) / em) * 65;
    const ses = Math.max(-99, Math.min(99, Math.round(sesRaw)));

    // 2. 30M: 6-bar (30-min) momentum
    const bar30m = series[Math.max(0, n - 7)];
    const m30Raw = ((spot - bar30m.close) / (em * 0.45)) * 75;
    const m30 = Math.max(-99, Math.min(99, Math.round(m30Raw)));

    // 3. 10M: 2-bar (10-min) micro-impulse
    const bar10m = series[Math.max(0, n - 3)];
    const m10Raw = ((spot - bar10m.close) / (em * 0.22)) * 80;
    const m10 = Math.max(-99, Math.min(99, Math.round(m10Raw)));

    // 4. STDY: 8-bar Kaufman Efficiency Ratio + VWAP stability
    const lookback = Math.min(8, n - 1);
    let pathSum = 0;
    for (let i = n - lookback; i < n; i++) {
      const prevC = series[i - 1]?.close ?? series[i].open;
      const curC = i === n - 1 ? spot : series[i].close;
      pathSum += Math.abs(curC - prevC);
    }
    const netChange = Math.abs(spot - series[Math.max(0, n - 1 - lookback)].close);
    const er = pathSum > 1e-5 ? netChange / pathSum : 0.5;
    const stdy = Math.max(20, Math.min(98, Math.round((0.42 + 0.56 * er) * 100)));

    // 5. PX: Price vs Flow VWAP normalized spread
    const fVwap = last.flowVwap || last.vwap || spot;
    const pxRaw = ((spot - fVwap) / (em * 0.35)) * 70;
    const px = Math.max(-99, Math.min(99, Math.round(pxRaw)));

    const fmtSigned = (v: number) => (v > 0 ? `+${v}` : `${v}`);

    return [
      { key: "SES", value: ses, display: fmtSigned(ses), isPct: false },
      { key: "30M", value: m30, display: fmtSigned(m30), isPct: false },
      { key: "10M", value: m10, display: fmtSigned(m10), isPct: false },
      { key: "STDY", value: stdy, display: `${stdy}%`, isPct: true },
      { key: "PX", value: px, display: fmtSigned(px), isPct: false },
    ];
  }, [series, liveSpot, open930, straddleEm]);

  // Active call conviction meter score (-99 to +99)
  const activeCall = ledger.activeCall;
  const activeType = activeCall?.type ?? (drivers[0].value >= 0 ? "LONG" : "SHORT");
  const convictionScore = useMemo(() => {
    if (!activeCall) return drivers[2].value;
    const dir = activeCall.type === "LONG" ? 1 : -1;
    const deltaPts = (liveSpot - activeCall.entryPrice) * dir;
    const em = Math.max(Math.max(0.05, liveSpot * 0.0005), straddleEm || liveSpot * 0.0048);
    const raw = Math.round((deltaPts / (em * 0.4)) * 45) + Math.round(drivers[2].value * 0.35 * dir);
    return Math.max(-99, Math.min(99, raw === 0 ? 12 : raw));
  }, [activeCall, liveSpot, straddleEm, drivers]);

  const litSegments = Math.max(3, Math.min(24, Math.round((Math.abs(convictionScore) / 100) * 24)));

  const effectivePolicy = useMemo(() => {
    if (supervisorPolicy) return supervisorPolicy;
    const derivedRegime: SessionPlaybookPolicy["regime"] =
      activeFsmState === "STAND_ASIDE"
        ? "LOW_EDGE_CHOP"
        : Math.abs(drivers[2]?.value ?? 0) >= 45
          ? "NEG_GAMMA_TREND"
          : Math.abs(drivers[4]?.value ?? 0) <= 18
            ? "POS_GAMMA_PIN"
            : "ZERO_GAMMA_FLIP";
    return {
      sessionDate: "",
      ticker: displayTicker,
      checkpoint: "INTRADAY" as const,
      evaluatedAtEt: isReplayMode ? "REPLAY" : "SYNCING",
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
        activeFsmState === "STAND_ASIDE"
          ? "FSM Neutral / Compressed Advection Corridor"
          : null,
      kingDivergencePct: 0,
      trailing5dDrawdownDollars: 0,
      trailing5dPnlDollars: 0,
      zeroGammaSide: "AT" as const,
      wallCorridorPct: 0,
      absPeclet: 0,
      summary: "",
    };
  }, [supervisorPolicy, activeFsmState, drivers, displayTicker, isReplayMode]);

  const regimeBadgeStyle =
    effectivePolicy.regime === "POS_GAMMA_PIN"
      ? "bg-cyan-500/15 text-[#00F5D4] border-cyan-500/40"
      : effectivePolicy.regime === "NEG_GAMMA_TREND"
        ? "bg-rose-500/15 text-[#FF2A55] border-rose-500/40"
        : effectivePolicy.regime === "ZERO_GAMMA_FLIP"
          ? "bg-amber-500/15 text-amber-300 border-amber-500/40"
          : "bg-red-500/20 text-red-300 border-red-500/50";

  return (
    <>
      {/* SUPERVISOR POLICY STRIP */}
      <div className="mb-3 rounded-lg bg-[#111322]/95 border border-slate-800/80 px-3.5 py-2 flex flex-wrap items-center justify-between gap-2.5 font-mono text-[11px] shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="text-[10px] font-bold tracking-[0.14em] text-slate-400 uppercase">
            SUPERVISOR
          </span>
          <span
            className={`px-2 py-0.5 rounded border text-[10px] font-bold tracking-wider ${regimeBadgeStyle}`}
          >
            {effectivePolicy.regime}
          </span>
          <span className="text-slate-400">
            PREF{" "}
            <strong className="text-slate-100">{effectivePolicy.preferredDte}</strong>
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
              <strong className="text-amber-300">UNCALIBRATED</strong>
            )}
          </span>
          <span className="text-slate-600 hidden sm:inline">|</span>
          <span className="text-slate-400 hidden sm:inline">
            CKPT{" "}
            <strong className="text-slate-200">{effectivePolicy.checkpoint}</strong>
            {effectivePolicy.evaluatedAtEt ? (
              <span className="text-slate-500 ml-1">({effectivePolicy.evaluatedAtEt})</span>
            ) : null}
          </span>
        </div>

        {effectivePolicy.standAsideVetoReason ? (
          <div className="px-2.5 py-0.5 rounded border border-red-500/50 bg-red-950/60 text-red-200 text-[10px] font-bold tracking-wide max-w-full truncate">
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
        <PrzmAsciiHeader title="CALL" />

        <div className="my-3">
          <div className="flex items-baseline justify-between gap-2.5">
            <span
              className={`font-mono text-2xl sm:text-[28px] font-black tracking-tight flex items-center gap-2 ${
                activeType === "LONG"
                  ? "text-[#00F5D4] drop-shadow-[0_0_12px_rgba(0,245,212,0.35)]"
                  : "text-[#FF2A55] drop-shadow-[0_0_12px_rgba(255,42,85,0.35)]"
              }`}
            >
              <span>{activeType === "LONG" ? "↗" : "↘"}</span>
              <span>{activeType}</span>
            </span>
            <span className="font-mono text-xl sm:text-2xl font-bold tabular-nums text-slate-100 tracking-tight">
              ${liveSpot.toFixed(2)}
            </span>
          </div>

          {/* 24-Segment Horizontal LED Conviction Bar */}
          <div className="mt-3.5 flex items-center gap-2.5">
            <div className="flex-1 flex items-center gap-[3px] h-4 bg-[#0b0c16] px-2 py-1 rounded border border-slate-800/70">
              {Array.from({ length: 24 }).map((_, idx) => {
                const isLit = idx < litSegments;
                const activeColor =
                  activeType === "LONG"
                    ? "bg-[#00F5D4] shadow-[0_0_6px_rgba(0,245,212,0.55)]"
                    : "bg-[#FF2A55] shadow-[0_0_6px_rgba(255,42,85,0.55)]";
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
              className={`font-mono text-xs font-bold tabular-nums min-w-[34px] text-right ${
                activeType === "LONG" ? "text-[#00F5D4]" : "text-[#FF2A55]"
              }`}
            >
              {convictionScore >= 0 ? `+${convictionScore}` : convictionScore}
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
        <PrzmAsciiHeader title="DRIVERS" />

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
 * Horizontal Segmented Regime Strip (`THE CALL`) directly below the main trajectory
 */
export const PrzmTheCallStrip: React.FC<{
  series: PrzmCandlePoint[];
  replayBarTsSec?: number;
}> = ({ series, replayBarTsSec }) => {
  if (!series.length) return null;
  const refNowSec = typeof replayBarTsSec === "number" && replayBarTsSec > 0 ? replayBarTsSec : Math.floor(Date.now() / 1000);

  return (
    <div className="mt-2 px-2 py-1.5 rounded-lg bg-[#0d0e1a]/90 border border-slate-800/70 flex items-center gap-3">
      <span className="font-mono text-[10px] font-bold tracking-[0.16em] text-slate-400 uppercase shrink-0 min-w-[68px]">
        THE CALL
      </span>
      <div className="flex-1 flex items-center gap-[2px] h-3.5">
        {series.map((bar, idx) => {
          const rawTs = Number(bar.timestamp ?? 0);
          const barSec = toEpochSeconds(rawTs);
          const isFuture = barSec > 0 && barSec > refNowSec;
          const refVwap = bar.flowVwap || bar.vwap || bar.close;
          const spread = bar.close - refVwap;
          const fallbackWing = Math.max(0.05, bar.close * 0.0015);
          const bandSpan = Math.max(
            Math.max(0.02, bar.close * 0.0003),
            ((bar.upperBand ?? refVwap + fallbackWing) - (bar.lowerBand ?? refVwap - fallbackWing)) * 0.12
          );
          let bg = "bg-[#8B5CF6]/70";
          if (isFuture) {
            bg = "bg-slate-800/40";
          } else if (spread > bandSpan * 0.35) {
            bg = "bg-[#00F5D4] shadow-[0_0_4px_rgba(0,245,212,0.35)]";
          } else if (spread < -bandSpan * 0.35) {
            bg = "bg-[#FF2A55] shadow-[0_0_4px_rgba(255,42,85,0.35)]";
          }
          return (
            <div
              key={`${bar.time}-${idx}`}
              className={`flex-1 h-2.5 rounded-[1px] ${bg}`}
              title={`${bar.time} · Close $${bar.close.toFixed(2)} vs FlowVWAP $${refVwap.toFixed(2)}`}
            />
          );
        })}
      </div>
    </div>
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
  ticker?: string;
  replayBarTsSec?: number;
}> = ({ signals, series, liveSpot, activeFsmState, serverTrades, ticker = "SPY", replayBarTsSec }) => {
  const ledger = useMemo(
    () => evaluatePrzmCallLedger(signals, series, liveSpot, activeFsmState, serverTrades, ticker, replayBarTsSec),
    [signals, series, liveSpot, activeFsmState, serverTrades, ticker, replayBarTsSec]
  );

  return (
    <div className="mt-3.5 rounded-xl bg-[#131424]/95 border border-slate-800/80 px-4 py-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
      <PrzmAsciiHeader title="CALL LOG" />

      <div className="mt-3 grid grid-cols-1 lg:grid-cols-12 gap-4 items-center">
        {/* Left: Chronological Trade Ledger (8 cols) */}
        <div className="lg:col-span-8 divide-y divide-slate-800/60 font-mono text-xs">
          {ledger.entries.length === 0 ? (
            <div className="py-4 text-slate-500 tracking-wider uppercase text-[11px]">
              AWAITING HIGH-CONVICTION REGIME TRIGGER...
            </div>
          ) : (
            ledger.entries.map((entry) => {
              const sideColor =
                entry.type === "LONG" ? "text-[#00F5D4]" : "text-[#FF2A55]";
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
                statusBadge = `FLAT ${signedDelta} pts`;
                statusColor = "text-slate-400";
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
                      className="px-2 py-0.5 rounded bg-slate-800/80 border border-slate-700/70 text-amber-300 font-mono text-[10.5px] font-semibold truncate max-w-[210px]"
                      title={entry.contractLabel}
                    >
                      {shortContract}
                    </span>
                  )}
                  {typeof entry.btoOptionPrice === "number" && entry.btoOptionPrice > 0 && (
                    <span className="text-slate-300 font-mono text-[11px] tabular-nums shrink-0">
                      {typeof entry.stcOptionPrice === "number" && entry.stcOptionPrice > 0 && entry.status !== "OPEN"
                        ? "$" + entry.btoOptionPrice.toFixed(2) + " → $" + entry.stcOptionPrice.toFixed(2)
                        : "@ $" + entry.btoOptionPrice.toFixed(2)}
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

        {/* Right: Giant Win-Rate Scoreboard (4 cols) */}
        <div className="lg:col-span-4 lg:border-l lg:border-slate-800/80 lg:pl-6 flex flex-col items-center lg:items-end justify-center py-2">
          <div
            className={`font-mono text-4xl sm:text-5xl font-black tracking-tight text-slate-100 tabular-nums transition-all duration-200 ease-out ${
              ledger.winRatePct >= 50
                ? "drop-shadow-[0_0_18px_rgba(0,245,212,0.25)]"
                : "drop-shadow-[0_0_18px_rgba(255,42,85,0.25)]"
            }`}
          >
            {ledger.winRatePct}%
          </div>
          <div className="mt-1 font-mono text-[11px] tracking-[0.16em] text-slate-400 uppercase transition-colors duration-200 ease-out">
            {ledger.rightCount} OF {ledger.decisiveCount} RIGHT
          </div>
        </div>
      </div>
    </div>
  );
};
