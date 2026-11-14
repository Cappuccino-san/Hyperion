"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useDashboardStore } from "@/store/useDashboardStore";

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
  return ts > 1e11 ? Math.floor(ts / 1000) : Math.floor(ts);
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
  ticker = "SPY"
): PrzmLedgerSummary {
  const normTicker = (ticker || "SPY").trim().toUpperCase();
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
    const delta = Number((isCall ? clampedClosed - clampedBto : clampedBto - clampedClosed).toFixed(2));
    const isWin =
      pos.pnlOptionPct > 0 ||
      delta > 0.05 ||
      pos.exitReason?.includes("TARGET") ||
      pos.exitReason?.includes("TP1") ||
      pos.exitReason?.includes("TP2") ||
      pos.exitReason?.includes("COVER") ||
      (typeof pos.pnlSpotPct === "number" && (isCall ? pos.pnlSpotPct > 0 : pos.pnlSpotPct > 0 || delta > 0.05));
    const isLoss =
      pos.pnlOptionPct < -5 ||
      pos.exitReason?.includes("STOP") ||
      delta < -0.05 ||
      (typeof pos.pnlSpotPct === "number" && isCall && pos.pnlSpotPct < 0);
    const status: "RIGHT" | "WRONG" | "FLAT" = isWin ? "RIGHT" : isLoss ? "WRONG" : "FLAT";
    const heldMin =
      pos.openedTs && pos.closedTs && pos.closedTs > pos.openedTs
        ? Math.max(1, Math.round((pos.closedTs - pos.openedTs) / 60))
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
    const nowTs = Math.floor(Date.now() / 1000);
    const heldMin =
      pos.openedTs && nowTs > pos.openedTs
        ? Math.max(1, Math.round((nowTs - pos.openedTs) / 60))
        : 5;

    serverEntries.push({
      id: pos.id,
      timeFormatted: pos.openedTs ? formatPrzmTime(pos.openedAt, pos.openedTs) : (pos.openedAt || ""),
      type,
      contractType: isCall ? "CALL" : "PUT",
      entryPrice: clampedBto,
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
      winRatePct: 100,
    };
  }

  const sorted = [...signals].sort((a, b) => a.index - b.index);
  const lastBarIdx = series.length > 0 ? series.length - 1 : 0;
  const lastBarTsSec = series.length > 0 ? toEpochSeconds(series[lastBarIdx]?.timestamp) : 0;
  const nowSec = Math.floor(Date.now() / 1000);

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
    const barSpanMinutes = Math.max(1, (endIdx - sig.index) * 5);

    let heldMinutes = barSpanMinutes;
    if (entryTsSec > 0) {
      let refEndSec = endTsSec;
      if (isNewest && lastBarTsSec > 0) {
        // Advance to nowSec if stream is within 15 mins of last candle
        refEndSec =
          nowSec >= lastBarTsSec && nowSec - lastBarTsSec <= 15 * 60
            ? nowSec
            : lastBarTsSec;
      }
      if (refEndSec >= entryTsSec) {
        const diffMin = Math.round((refEndSec - entryTsSec) / 60);
        heldMinutes = diffMin >= 1 && diffMin <= 390 ? diffMin : barSpanMinutes;
      }
    }

    const isCurrentlyOpen =
      sig.isClosed === false ||
      (isNewest && activeFsmState !== undefined && activeFsmState === sig.type);

    const exitPrice = sig.exitPrice ?? endBar?.close ?? sig.price;
    const finalMarkPrice = isCurrentlyOpen
      ? (Number.isFinite(liveSpot) && liveSpot > 0 ? liveSpot : endBar?.close ?? sig.price)
      : exitPrice;

    // Strict Realized P&L Math: (Exit - Entry) * (LONG ? 1 : -1)
    const realizedDelta =
      sig.type === "LONG" ? finalMarkPrice - sig.price : sig.price - finalMarkPrice;

    let status: "OPEN" | "RIGHT" | "FLAT" | "WRONG";
    if (isCurrentlyOpen) {
      status = "OPEN";
    } else if (realizedDelta > 0.05) {
      status = "RIGHT";
    } else if (realizedDelta < -0.05) {
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

  // When authoritative server trades exist, lock the ledger to the Single-Slot Sniper Automaton
  // so unexecuted FSM transitions do not dilute the 1-Trade-Max scoreboard.
  const mergedEntries: EvaluatedCallEntry[] =
    serverEntries.length > 0 ? [...serverEntries] : [...chronologicalEntries];

  let rightCount = mergedEntries.filter((e) => e.status === "RIGHT").length;
  const wrongCount = mergedEntries.filter((e) => e.status === "WRONG").length;
  const flatCount = mergedEntries.filter((e) => e.status === "FLAT").length;

  const completedDecisive = rightCount + wrongCount;
  let decisiveCount = completedDecisive;
  let winRatePct = 100;

  if (completedDecisive > 0) {
    winRatePct = Math.round((rightCount / completedDecisive) * 100);
  } else {
    const openEntry = mergedEntries.find((e) => e.status === "OPEN");
    if (openEntry) {
      decisiveCount = 1;
      rightCount = openEntry.delta >= 0 ? 1 : 0;
      winRatePct = openEntry.delta >= 0 ? 100 : 0;
    } else {
      decisiveCount = 0;
      winRatePct = 100;
    }
  }

  const newest = mergedEntries[mergedEntries.length - 1] ?? null;
  const openEntry = mergedEntries.find((e) => e.status === "OPEN") ?? null;
  const activeCall = activeFsmState === "STAND_ASIDE" ? null : (openEntry || newest);

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
}> = ({ ticker, liveSpot, series, signals, open930, straddleEm, activeFsmState, serverTrades }) => {
  const ledger = useMemo(
    () => evaluatePrzmCallLedger(signals, series, liveSpot, activeFsmState, serverTrades, ticker),
    [signals, series, liveSpot, activeFsmState, serverTrades, ticker]
  );

  // Live 1-second clock for "TO THE BELL" radial dial
  const [nowDate, setNowDate] = useState<Date>(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNowDate(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // Compute RTH (09:30 -> 16:00 ET = 390 mins) progress & countdown
  const bellMetrics = useMemo(() => {
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        hour: "numeric",
        minute: "numeric",
        second: "numeric",
        hour12: false,
      }).formatToParts(nowDate);

      const hr = parseInt(parts.find((p) => p.type === "hour")?.value ?? "12", 10);
      const min = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
      const sec = parseInt(parts.find((p) => p.type === "second")?.value ?? "0", 10);
      const etMins = hr * 60 + min + sec / 60;

      const rthOpen = 9 * 60 + 30; // 570
      const rthClose = 16 * 60; // 960
      const totalRth = 390;

      // If currently inside live Regular Trading Hours
      if (etMins >= rthOpen && etMins < rthClose) {
        const elapsed = etMins - rthOpen;
        const rem = Math.max(0, Math.ceil(rthClose - etMins));
        const remH = Math.floor(rem / 60);
        const remM = rem % 60;
        const progress = Math.min(1, Math.max(0, elapsed / totalRth));
        return {
          centerLabel: `${remH}h${String(remM).padStart(2, "0")}`,
          subLabel: "9:30 > 4:00",
          progress,
          litTicks: Math.max(1, Math.round(progress * 48)),
          isLiveRth: true,
        };
      }

      // If outside live RTH, inspect the latest candle time in the chart
      const lastCandle = series[series.length - 1];
      if (lastCandle?.time) {
        const m = lastCandle.time.match(/^(\d{1,2}):(\d{2})/);
        if (m) {
          const barMins = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
          if (barMins >= rthOpen && barMins < rthClose - 5) {
            const elapsed = barMins - rthOpen;
            const rem = Math.max(0, rthClose - barMins);
            const remH = Math.floor(rem / 60);
            const remM = rem % 60;
            const progress = Math.min(1, Math.max(0.05, elapsed / totalRth));
            return {
              centerLabel: `${remH}h${String(remM).padStart(2, "0")}`,
              subLabel: "9:30 > 4:00",
              progress,
              litTicks: Math.max(1, Math.round(progress * 48)),
              isLiveRth: false,
            };
          }
        }
      }

      // Session complete / After-hours state
      return {
        centerLabel: "0h00",
        subLabel: "9:30 > 4:00",
        progress: 1,
        litTicks: 48,
        isLiveRth: false,
      };
    } catch {
      return {
        centerLabel: "1h35",
        subLabel: "9:30 > 4:00",
        progress: 0.75,
        litTicks: 36,
        isLiveRth: false,
      };
    }
  }, [nowDate, series]);

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
    const em = Math.max(0.5, straddleEm || spot * 0.0048);

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
    const em = Math.max(0.5, straddleEm || liveSpot * 0.0048);
    const raw = Math.round((deltaPts / (em * 0.4)) * 45) + Math.round(drivers[2].value * 0.35 * dir);
    return Math.max(-99, Math.min(99, raw === 0 ? 12 : raw));
  }, [activeCall, liveSpot, straddleEm, drivers]);

  const litSegments = Math.max(3, Math.min(24, Math.round((Math.abs(convictionScore) / 100) * 24)));

  return (
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

        {/* Bottom 3-Metric Strip */}
        <div className="pt-2.5 border-t border-slate-800/70 flex items-center justify-between font-mono text-[11px] tracking-[0.08em]">
          <div>
            <span className="text-slate-500 mr-1.5">{ticker}</span>
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
              const x1 = 72 + rIn * Math.cos(angle);
              const y1 = 72 + rIn * Math.sin(angle);
              const x2 = 72 + rOut * Math.cos(angle);
              const y2 = 72 + rOut * Math.sin(angle);
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
              className="font-mono font-black text-[23px] tracking-tight"
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
  );
};

/**
 * Horizontal Segmented Regime Strip (`THE CALL`) directly below the main trajectory
 */
export const PrzmTheCallStrip: React.FC<{
  series: PrzmCandlePoint[];
}> = ({ series }) => {
  if (!series.length) return null;

  return (
    <div className="mt-2 px-2 py-1.5 rounded-lg bg-[#0d0e1a]/90 border border-slate-800/70 flex items-center gap-3">
      <span className="font-mono text-[10px] font-bold tracking-[0.16em] text-slate-400 uppercase shrink-0 min-w-[68px]">
        THE CALL
      </span>
      <div className="flex-1 flex items-center gap-[2px] h-3.5">
        {series.map((bar, idx) => {
          const rawTs = Number(bar.timestamp ?? 0);
          const barSec = rawTs > 1e11 ? Math.floor(rawTs / 1000) : rawTs;
          const isFuture = barSec > 0 && barSec > Math.floor(Date.now() / 1000);
          const refVwap = bar.flowVwap || bar.vwap || bar.close;
          const spread = bar.close - refVwap;
          const bandSpan = Math.max(0.15, ((bar.upperBand ?? refVwap + 1.25) - (bar.lowerBand ?? refVwap - 1.25)) * 0.12);
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
}> = ({ signals, series, liveSpot, activeFsmState, serverTrades, ticker = "SPY" }) => {
  const ledger = useMemo(
    () => evaluatePrzmCallLedger(signals, series, liveSpot, activeFsmState, serverTrades, ticker),
    [signals, series, liveSpot, activeFsmState, serverTrades, ticker]
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

              if (entry.status === "OPEN") {
                const signed =
                  entry.delta >= 0
                    ? `+${entry.delta.toFixed(2)}`
                    : entry.delta.toFixed(2);
                statusBadge = `OPEN ${signed} pts`;
                statusColor = "text-[#A78BFA] font-bold";
              } else if (entry.status === "RIGHT") {
                const optPctStr =
                  typeof entry.pnlOptionPct === "number"
                    ? `STC ${entry.pnlOptionPct > 0 ? "+" : ""}${entry.pnlOptionPct.toFixed(1)}% · `
                    : "STC · ";
                statusBadge = `${optPctStr}+${Math.abs(entry.delta).toFixed(2)} pts · RIGHT`;
                statusColor = "text-[#10b981] font-bold";
              } else if (entry.status === "FLAT") {
                const signed =
                  entry.delta >= 0
                    ? `+${entry.delta.toFixed(2)}`
                    : entry.delta.toFixed(2);
                statusBadge = `FLAT ${signed} pts`;
                statusColor = "text-slate-400";
              } else {
                const optPctStr =
                  typeof entry.pnlOptionPct === "number"
                    ? `STC ${entry.pnlOptionPct.toFixed(1)}% · `
                    : "STC · ";
                const formattedPts =
                  entry.delta <= 0
                    ? entry.delta.toFixed(2)
                    : `-${Math.abs(entry.delta).toFixed(2)}`;
                statusBadge = `${optPctStr}${formattedPts} pts · WRONG`;
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
