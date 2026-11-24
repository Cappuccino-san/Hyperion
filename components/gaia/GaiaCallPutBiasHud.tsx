"use client";

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useDashboardStore } from "@/store/useDashboardStore";
import {
  classifyDominanceTriState,
  computeBarFlowGammaVwapSeries,
  FlowGammaVwapSnapshot,
} from "@/lib/flowGammaVwap";
import {
  PrzmTopDeck,
  PrzmCallLogDeck,
  PrzmCandlePoint,
  PrzmSignalPoint,
  ServerTradeData,
} from "./PrzmTacticalHud";
import {
  GaiaSignalFsm,
  GaiaBarData,
  computeCausalEquilibriumDispersion,
} from "@/lib/gaiaSignalFsm";
import type { SessionPlaybookPolicy } from "@/lib/persistenceStore";
import type { ZeroShadowReadout } from "@/lib/zeroShadowLedger";
import {
  RTH_OPEN_MINS as GUARD_RTH_OPEN_MINS,
  RTH_CLOSE_MINS as GUARD_RTH_CLOSE_MINS,
  etMinutesOfDay,
  getSessionBoundsEt,
  getTodayEt,
  toEpochSec,
} from "@/lib/gaiaSessionGuards";
import {
  extractNormalizedTradesForTicker,
  matchTradeToCandleIndex,
  clampSpotToCandle,
} from "@/components/chart/TradeExecutionMarkersOverlay";

export interface GaiaHudCandle {
  timestamp?: number;
  time?: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  timeLabel?: string;
}

export interface GaiaCallPutBiasHudProps {
  symbol?: string;
  ticker?: string;
  candles?: GaiaHudCandle[];
  bars?: GaiaHudCandle[];
  flowVwapPoints?: FlowGammaVwapSnapshot[];
  sigma1Move?: number;
  liveSpot?: number | null;
  spot?: number | null;
  serverTrades?: ServerTradeData;
  supervisorPolicy?: SessionPlaybookPolicy | null;
  sessionDate?: string;
  onSymbolChange?: (symbol: string) => void;
  onSignalsEvaluated?: (signals: PrzmSignalPoint[]) => void;
  dividerRatio?: number;
  className?: string;
  isReplayMode?: boolean;
  replayBarTsSec?: number;
  replayBarClose?: number;
  startHour?: number;
  xScale?: number;
  xPanOffset?: number;
  containerWidthPx?: number;
  onXViewportChange?: (xScale: number, xPanOffset: number) => void;
  onResetViewport?: () => void;
}

interface EnrichedPoint {
  index: number;
  etMins: number;
  timestamp: number;
  timeLabel: string;
  open: number;
  high: number;
  low: number;
  close: number;
  flowVwap: number;
  sigma: number;
  upper1Sigma: number;
  lower1Sigma: number;
  chi: number;
  pe: number;
  impulseChi: number;
  impulsePe: number;
  deltaNetFlux6Bar: number;
  netFlux: number;
  bias: number; // in [-1, +1]
  regime: "CALL" | "PUT";
  histValue: number;
  baseX: number;
  baseY: number;
}

interface PriceTick {
  price: number;
  y: number;
  label: string;
}

interface TimeTick {
  timestamp: number;
  x: number;
  shortLabel: string;
  fullLabel: string;
  isMajor: boolean;
  isRthOpen: boolean;
}

// ============================================================================
// EXTENDED SESSION TIMELINE (7:00 AM - 5:00 PM ET) CONSTANTS & HELPERS
// ============================================================================

export const EXTENDED_SESSION_START_MINS = 0; // 12:00 AM ET (0 * 60)
export const EXTENDED_SESSION_END_MINS = 1440;  // 12:00 AM next day ET (24 * 60)
export const EXTENDED_SESSION_SPAN_MINS = 1440; // Full 24 hours (1440 mins, 288 5m slots)
export const RTH_OPEN_MINS = GUARD_RTH_OPEN_MINS;               // 09:30 AM ET (9 * 60 + 30)
export const RTH_CLOSE_MINS = GUARD_RTH_CLOSE_MINS;              // 04:00 PM ET (16 * 60)

export interface SessionTickMilestone {
  etMins: number;
  label: string;
  isMajor?: boolean;
  isRthBoundary?: boolean;
}

export const EXTENDED_SESSION_TICKS: readonly SessionTickMilestone[] = [
  { etMins: 0, label: "12:00am", isMajor: true },
  { etMins: 180, label: "3:00am", isMajor: true },
  { etMins: 360, label: "6:00am", isMajor: true },
  { etMins: 570, label: "9:30am", isMajor: true, isRthBoundary: true },
  { etMins: 720, label: "12:00pm", isMajor: true },
  { etMins: 960, label: "4:00pm", isMajor: true, isRthBoundary: true },
  { etMins: 1140, label: "7:00pm", isMajor: true },
  { etMins: 1320, label: "10:00pm", isMajor: true },
] as const;

export function resolveBarEtMinutes(
  bar: {
    etMins?: number | null;
    timestamp?: number | string | null;
    time?: number | string | null;
    t?: number | string | null;
    timeLabel?: string | null;
    label?: string | null;
  },
  index: number,
  totalBars: number
): number {
  if (typeof bar.etMins === "number" && Number.isFinite(bar.etMins)) {
    return bar.etMins;
  }

  const rawTs = bar.timestamp ?? bar.t ?? bar.time;
  if (typeof rawTs === "number" && Number.isFinite(rawTs) && rawTs > 1_000_000_000) {
    const ms = rawTs < 1e12 ? rawTs * 1000 : rawTs;
    const parts = ET_PARTS_FORMATTER.formatToParts(new Date(ms));
    const h = Number(parts.find((p) => p.type === "hour")?.value ?? NaN);
    const m = Number(parts.find((p) => p.type === "minute")?.value ?? NaN);
    const s = Number(parts.find((p) => p.type === "second")?.value ?? 0);
    if (Number.isFinite(h) && Number.isFinite(m)) {
      const normalizedH = h === 24 ? 0 : h;
      return normalizedH * 60 + m + s / 60;
    }
  }

  const rawStr =
    typeof rawTs === "string"
      ? rawTs
      : typeof bar.timeLabel === "string"
      ? bar.timeLabel
      : typeof bar.label === "string"
      ? bar.label
      : null;

  if (rawStr) {
    const timeMatch = rawStr.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?/i);
    if (timeMatch && !rawStr.includes("T")) {
      let h = parseInt(timeMatch[1], 10);
      const m = parseInt(timeMatch[2], 10);
      const s = timeMatch[3] ? parseInt(timeMatch[3], 10) : 0;
      const meridiem = timeMatch[4]?.toLowerCase();
      if (meridiem === "pm" && h < 12) h += 12;
      if (meridiem === "am" && h === 12) h = 0;
      return h * 60 + m + s / 60;
    }
    const parsedMs = Date.parse(rawStr);
    if (Number.isFinite(parsedMs)) {
      const parts = ET_PARTS_FORMATTER.formatToParts(new Date(parsedMs));
      const h = Number(parts.find((p) => p.type === "hour")?.value ?? NaN);
      const m = Number(parts.find((p) => p.type === "minute")?.value ?? NaN);
      const s = Number(parts.find((p) => p.type === "second")?.value ?? 0);
      if (Number.isFinite(h) && Number.isFinite(m)) {
        const normalizedH = h === 24 ? 0 : h;
        return normalizedH * 60 + m + s / 60;
      }
    }
  }

  const ratio = totalBars > 1 ? index / (totalBars - 1) : 0;
  return EXTENDED_SESSION_START_MINS + ratio * EXTENDED_SESSION_SPAN_MINS;
}

const ET_TIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

const ET_PARTS_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "numeric",
  minute: "2-digit",
  hour12: false,
});

function formatTimeEt(epochMs: number): { short: string; full: string; isMajor: boolean; isRthOpen: boolean } {
  const d = new Date(epochMs);
  const full = `${ET_TIME_FORMATTER.format(d)} ET`;
  const parts = ET_PARTS_FORMATTER.formatToParts(d);
  const hour24 = parseInt(parts.find((p) => p.type === "hour")?.value ?? "9", 10);
  const minute = parseInt(parts.find((p) => p.type === "minute")?.value ?? "30", 10);

  const ampm = hour24 >= 12 ? "pm" : "am";
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;

  const isRthOpen = hour24 === 9 && minute === 30;
  const isMajor = minute === 0 || isRthOpen;

  const short = `${hour12}:${minute.toString().padStart(2, "0")}${ampm}`;
  return { short, full, isMajor, isRthOpen };
}

const GaiaCallPutBiasHudInner: React.FC<GaiaCallPutBiasHudProps> = ({
  symbol,
  ticker,
  candles,
  bars,
  flowVwapPoints,
  sigma1Move,
  liveSpot,
  spot,
  serverTrades: serverTradesProp,
  supervisorPolicy: supervisorPolicyProp,
  sessionDate,
  onSymbolChange,
  onSignalsEvaluated,
  dividerRatio = 1,
  className = "",
  isReplayMode = false,
  replayBarTsSec,
  replayBarClose,
  startHour = 0,
  xScale: controlledXScale,
  xPanOffset: controlledXPanOffset,
  containerWidthPx,
  onXViewportChange,
  onResetViewport,
}) => {
  const uid = useId().replace(/:/g, "");
  const activeSymbol = (symbol || ticker || "SPY").trim().toUpperCase() || "SPY";
  const storeActiveTicker = useDashboardStore((s) => s.activeTicker);
  const storeLoadedTicker = useDashboardStore((s) => s.loadedTicker);
  const storeSpotPrice = useDashboardStore((s) => s.spotPrice);
  const storePreviousClose = useDashboardStore((s) => s.previousClose);
  const storeExtendedQuote = useDashboardStore((s) => s.extendedQuote);
  const storeSupervisorPolicy = useDashboardStore((s) => s.supervisorPolicy);
  const liveTickPrice = useDashboardStore((s) => s.liveTickPrice);
  const liveTickCount = useDashboardStore((s) => s.liveTickCount);
  const liveTickMarketOpen = useDashboardStore((s) => s.liveTickMarketOpen);
  const gammaLevels = useDashboardStore((s) => s.gammaLevels);
  const gammaLevelsByFilter = useDashboardStore((s) => s.gammaLevelsByFilter);
  const netMetrics = useDashboardStore((s) => s.netMetrics);
  const rawLiveSpot = typeof liveSpot === "number" && liveSpot > 0 ? liveSpot : typeof spot === "number" && spot > 0 ? spot : null;

  const isStoreAligned =
    storeLoadedTicker?.toUpperCase() === activeSymbol ||
    storeActiveTicker?.toUpperCase() === activeSymbol;
  const zeroDteLevels = useMemo(() => {
    if (!isStoreAligned) return null;
    const raw0 = gammaLevelsByFilter?.["0DTE"];
    if (raw0 && (raw0.callWall > 0 || raw0.putWall > 0 || raw0.zeroGamma > 0)) {
      return raw0;
    }
    return gammaLevels;
  }, [isStoreAligned, gammaLevelsByFilter, gammaLevels]);

  const [internalServerTrades, setInternalServerTrades] = useState<ServerTradeData>(
    serverTradesProp || {}
  );
  const [hasLoadedServerTrades, setHasLoadedServerTrades] = useState<boolean>(serverTradesProp !== undefined);
  const [internalSupervisorPolicy, setInternalSupervisorPolicy] = useState<SessionPlaybookPolicy | null>(
    supervisorPolicyProp ?? null
  );
  const [zeroShadow, setZeroShadow] = useState<ZeroShadowReadout | null>(null);

  useEffect(() => {
    if (serverTradesProp !== undefined) {
      setInternalServerTrades(serverTradesProp);
      setHasLoadedServerTrades(true);
      return;
    }
    setInternalServerTrades({
      activePositions: {},
      closedPositions: [],
      alerts: [],
      loaded: false,
    });
    setInternalSupervisorPolicy(null);
  }, [activeSymbol, sessionDate, serverTradesProp]);

  // Polls /api/signals to hydrate Zero Shadow Ledger telemetry (and serverTrades when parent does not supply serverTradesProp)
  useEffect(() => {
    let isMounted = true;
    const controller = new AbortController();
    async function syncServerTrades() {
      try {
        const dateParam =
          sessionDate && /^\d{4}-\d{2}-\d{2}$/.test(sessionDate)
            ? `&date=${encodeURIComponent(sessionDate)}`
            : "";
        const res = await fetch(
          `/api/signals?ticker=${encodeURIComponent(activeSymbol)}${dateParam}`,
          {
            cache: "no-store",
            signal: controller.signal,
          }
        );
        if (!res.ok) return;
        const data = await res.json();
        if (isMounted && !controller.signal.aborted) {
          if (serverTradesProp === undefined && !isReplayMode) {
            setHasLoadedServerTrades(true);
            setInternalServerTrades({
              activePositions: data?.activePositions || {},
              closedPositions: data?.closedPositions || [],
              alerts: data?.alerts || [],
              loaded: true,
            });
          }
          if (data?.supervisorPolicy) {
            setInternalSupervisorPolicy(data.supervisorPolicy);
          }
          if (data?.zeroShadow) {
            setZeroShadow(data.zeroShadow);
          }
        }
      } catch {
        // Silent fallback
      }
    }
    void syncServerTrades();
    if (isReplayMode) {
      return () => {
        isMounted = false;
        controller.abort();
      };
    }
    const pollMs = liveTickMarketOpen ? 8_000 : 30_000;
    const interval = setInterval(syncServerTrades, pollMs);
    return () => {
      isMounted = false;
      controller.abort();
      clearInterval(interval);
    };
  }, [activeSymbol, sessionDate, serverTradesProp, isReplayMode, liveTickMarketOpen]);

  // Chart Container & Dynamic Axis Scaling / Pan State
  const svgWrapperRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const cachedInverseCtmRef = useRef<DOMMatrix | null>(null);
  const [measuredSvgWidth, setMeasuredSvgWidth] = useState<number>(980);
  const [internalXScale, setInternalXScale] = useState<number>(1.0); // 0.5x to 4.0x
  const [internalXPanOffset, setInternalXPanOffset] = useState<number>(0); // in pixels
  const [yScale, setYScale] = useState<number>(1.0); // 0.5x to 4.0x
  const [yPanOffset, setYPanOffset] = useState<number>(0); // in price units

  const xScale = typeof controlledXScale === "number" ? controlledXScale : internalXScale;
  const xPanOffset = typeof controlledXPanOffset === "number" ? controlledXPanOffset : internalXPanOffset;
  const currentXScale = xScale;
  const currentXPanOffset = xPanOffset;

  const setXScale = useCallback(
    (updater: number | ((prev: number) => number)) => {
      const next = typeof updater === "function" ? updater(xScale) : updater;
      if (onXViewportChange) {
        onXViewportChange(next, xPanOffset);
      } else {
        setInternalXScale(next);
      }
    },
    [onXViewportChange, xScale, xPanOffset]
  );

  const setXPanOffset = useCallback(
    (updater: number | ((prev: number) => number)) => {
      const next = typeof updater === "function" ? updater(xPanOffset) : updater;
      if (onXViewportChange) {
        onXViewportChange(xScale, next);
      } else {
        setInternalXPanOffset(next);
      }
    },
    [onXViewportChange, xScale, xPanOffset]
  );

  useEffect(() => {
    const el = svgWrapperRef.current;
    if (!el) return;
    const updateW = () => {
      const w = Math.floor(el.clientWidth);
      if (w > 200) setMeasuredSvgWidth(w);
    };
    updateW();
    const obs = new ResizeObserver(updateW);
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // Drag interaction state
  const [dragMode, setDragMode] = useState<"none" | "pan" | "scaleY" | "scaleX">("none");
  const dragStartRef = useRef<{ clientX: number; clientY: number; startXPan: number; startYPan: number; startXScale: number; startYScale: number }>({
    clientX: 0,
    clientY: 0,
    startXPan: 0,
    startYPan: 0,
    startXScale: 1,
    startYScale: 1,
  });

  // Crosshair hover inspection
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  // 1. Prepare effective candle series with outlier protection
  const effectiveCandles = useMemo(() => {
    const raw = (candles && candles.length > 0 ? candles : bars && bars.length > 0 ? bars : []) as GaiaHudCandle[];
    if (raw.length === 0) {
      return [];
    }

    // Normalize timestamps (seconds vs ms) and drop bars missing valid timestamps (no synthetic Date.now fallback)
    const cloned = raw
      .map((c) => {
        const rawTs = c.timestamp ?? c.time ?? 0;
        const ts = rawTs > 1e11 ? rawTs : rawTs > 1e9 ? rawTs * 1000 : 0;
        if (!Number.isFinite(ts) || ts <= 0) return null;
        return {
          ...c,
          timestamp: ts,
          open: Number(c.open) || Number(c.close) || 0,
          high: Number(c.high) || Number(c.close) || 0,
          low: Number(c.low) || Number(c.close) || 0,
          close: Number(c.close) || 0,
          volume: Number(c.volume) || 0,
          timeLabel: c.timeLabel || formatTimeEt(ts).full,
        };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);
    if (cloned.length === 0) {
      return [];
    }

    // Adaptive ATR Tail Sanitizer & Static Preset Guard
    const STATIC_PRESET_SPOTS = new Set([759.75, 608.91, 502.5, 208.45, 7597.5]);

    if (cloned.length > 1) {
      const lastIdx = cloned.length - 1;
      const prevClose = cloned[lastIdx - 1].close;
      const lastClose = cloned[lastIdx].close;

      const lookback = Math.max(0, lastIdx - 15);
      const trs = cloned
        .slice(lookback, lastIdx)
        .map((c, idx, arr) => {
          const p = idx > 0 ? arr[idx - 1].close : c.open;
          return Math.max(c.high - c.low, Math.abs(c.close - p));
        })
        .sort((a, b) => a - b);
      const medianTr = trs.length > 0 ? trs[Math.floor(trs.length / 2)] : Math.max(0.01, prevClose * 0.0005);
      const maxAllowedJump = Math.max(medianTr * 2.8, prevClose * 0.002);

      const isPresetPoisoned =
        STATIC_PRESET_SPOTS.has(Number(lastClose.toFixed(2))) &&
        Math.abs(lastClose - prevClose) > medianTr * 1.5;

      // Reject fake preset spike
      if (isPresetPoisoned || Math.abs(lastClose - prevClose) > maxAllowedJump) {
        cloned[lastIdx].close = prevClose;
        cloned[lastIdx].high = Math.max(cloned[lastIdx].open, prevClose);
        cloned[lastIdx].low = Math.min(cloned[lastIdx].open, prevClose);
      }

      // Live Sub-Second Real-Time Tick Sync strictly during active RTH (never mutate 15:55 RTH close candle off-hours)
      const tickerMatchedTick =
        liveTickMarketOpen === true && storeActiveTicker.toUpperCase() === activeSymbol
          ? liveTickPrice
          : null;
      const verifiedLivePrice =
        typeof tickerMatchedTick === "number" && tickerMatchedTick > 0 && !STATIC_PRESET_SPOTS.has(Number(tickerMatchedTick.toFixed(2)))
          ? tickerMatchedTick
          : liveTickMarketOpen === true && typeof rawLiveSpot === "number" && rawLiveSpot > 0 && !STATIC_PRESET_SPOTS.has(Number(rawLiveSpot.toFixed(2)))
            ? rawLiveSpot
            : null;

      if (!isReplayMode && liveTickMarketOpen === true && verifiedLivePrice !== null) {
        const relDiff = Math.abs(verifiedLivePrice - cloned[lastIdx].close) / Math.max(1, cloned[lastIdx].close);
        if (relDiff <= 0.005) {
          cloned[lastIdx].close = verifiedLivePrice;
          if (verifiedLivePrice > cloned[lastIdx].high) cloned[lastIdx].high = verifiedLivePrice;
          if (verifiedLivePrice < cloned[lastIdx].low) cloned[lastIdx].low = verifiedLivePrice;
        }
      }
    }

    return cloned;
  }, [candles, bars, rawLiveSpot, storeActiveTicker, liveTickPrice, liveTickCount, liveTickMarketOpen, activeSymbol, isReplayMode]);

  // 2. Compute Bar-by-Bar Flow VWAP & Spectral Flux Series anchored to 0DTE tactical walls & live intra-bar tick
  const pdeSeries = useMemo(() => {
    if (effectiveCandles.length === 0) return [];
    const lastEffClose = effectiveCandles[effectiveCandles.length - 1]?.close ?? 0;
    const lastParentSpot = flowVwapPoints?.[flowVwapPoints.length - 1]?.spot ?? 0;
    const liveTailUpdated =
      !isReplayMode &&
      flowVwapPoints &&
      flowVwapPoints.length === effectiveCandles.length &&
      Math.abs(lastEffClose - lastParentSpot) >= 0.02;
    const hasDistinct0DteWalls = Boolean(
      !isReplayMode &&
        zeroDteLevels &&
        gammaLevels &&
        (zeroDteLevels.callWall !== gammaLevels.callWall ||
          zeroDteLevels.putWall !== gammaLevels.putWall ||
          Math.abs((zeroDteLevels.zeroGamma || 0) - (gammaLevels.zeroGamma || 0)) >= 0.25)
    );

    if (
      flowVwapPoints &&
      flowVwapPoints.length === effectiveCandles.length &&
      !liveTailUpdated &&
      !hasDistinct0DteWalls
    ) {
      return flowVwapPoints;
    }
    try {
      const nodes =
        !isReplayMode && zeroDteLevels
          ? {
              ceilingNode: zeroDteLevels.callWall > 0 ? zeroDteLevels.callWall : undefined,
              floorNode: zeroDteLevels.putWall > 0 ? zeroDteLevels.putWall : undefined,
              zeroGamma: zeroDteLevels.zeroGamma > 0 ? zeroDteLevels.zeroGamma : undefined,
              netGex: typeof netMetrics?.netGex === "number" ? netMetrics.netGex : undefined,
            }
          : undefined;
      return computeBarFlowGammaVwapSeries(
        effectiveCandles.map((c) => ({
          timestamp: c.timestamp,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
        })),
        undefined,
        nodes
      );
    } catch {
      return flowVwapPoints && flowVwapPoints.length === effectiveCandles.length
        ? flowVwapPoints
        : [];
    }
  }, [effectiveCandles, flowVwapPoints, isReplayMode, zeroDteLevels, gammaLevels, netMetrics?.netGex]);

  // Dimensions & Coordinates (1:1 CSS Pixel & Left-Anchored Time Domain Parity with GaiaView)
  const svgWidth =
    containerWidthPx && containerWidthPx > 200
      ? containerWidthPx
      : measuredSvgWidth > 200
        ? measuredSvgWidth
        : 980;
  const svgHeight = 440;
  const padLeft = 24;
  const padRight = 116; // Matches GaiaView CHART_RIGHT_AXIS_WIDTH for 1:1 gutter alignment
  const padTop = 36;
  const chartBottom = 265;
  const ribbonTop = 290;
  const ribbonHeight = 12;
  const histTop = 320;
  const histBottom = 392;
  const histZeroY = (histTop + histBottom) / 2;
  const histHalfH = (histBottom - histTop) / 2;

  const fullPlotW = svgWidth - padLeft - padRight;
  const clampedDivider = Math.max(0.35, Math.min(1, dividerRatio));
  const dividerX = Math.round(padLeft + fullPlotW * clampedDivider);
  const plotW = dividerX - padLeft;
  const plotH = chartBottom - padTop;

  const axisStartMins = startHour === 0 ? 0 : startHour === 7 ? 420 : startHour === 8 ? 480 : 570;
  const axisEndMins = startHour === 0 ? 1440 : 1020;
  const axisSpanMins = Math.max(5, axisEndMins - axisStartMins);
  const totalSessionSlots = Math.round(axisSpanMins / 5);

  const fallbackReferenceSpot = useMemo(() => {
    if (rawLiveSpot && rawLiveSpot > 0) return rawLiveSpot;
    if (isStoreAligned && storeSpotPrice > 0) return storeSpotPrice;
    if (isStoreAligned && storePreviousClose > 0) return storePreviousClose;
    return 0;
  }, [rawLiveSpot, isStoreAligned, storeSpotPrice, storePreviousClose]);

  // Raw Price Extrema & Dynamic Adjusted Y-Domain (never collapses to $0.00 / $0-$2 off-hours)
  const priceDomain = useMemo(() => {
    if (effectiveCandles.length === 0) {
      const sp = fallbackReferenceSpot;
      if (sp > 0) {
        const halfPad = Math.max(1.0, Number((sp * 0.006).toFixed(2)));
        return { min: sp - halfPad, max: sp + halfPad, current: sp, span: halfPad * 2 };
      }
      return { min: 98, max: 102, current: 0, span: 4 };
    }
    let min = Infinity;
    let max = -Infinity;
    for (const c of effectiveCandles) {
      if (c.low < min) min = c.low;
      if (c.high > max) max = c.high;
    }
    const current = effectiveCandles[effectiveCandles.length - 1].close;
    const baseSpan = Math.max(Math.max(0.05, current * 0.001), max - min);
    const mid = (min + max) / 2 + yPanOffset;
    const adjustedSpan = Math.max(Math.max(0.04, current * 0.0006), (baseSpan * 1.25) / Math.max(0.2, yScale));

    return {
      min: mid - adjustedSpan / 2,
      max: mid + adjustedSpan / 2,
      current,
      span: adjustedSpan,
    };
  }, [effectiveCandles, fallbackReferenceSpot, activeSymbol, yPanOffset, yScale]);

  // Coordinate Projection Helpers (Left-Anchored 1:1 with GaiaView minsToX)
  const xFromEtMins = useCallback(
    (etMins: number) => {
      const rawRatio = (etMins - axisStartMins) / axisSpanMins;
      return padLeft + currentXPanOffset + rawRatio * plotW * currentXScale;
    },
    [axisStartMins, axisSpanMins, padLeft, plotW, currentXScale, currentXPanOffset]
  );

  const xForIdx = useCallback(
    (idx: number) => {
      if (idx >= 0 && idx < effectiveCandles.length) {
        const et = resolveBarEtMinutes(effectiveCandles[idx], idx, effectiveCandles.length);
        return xFromEtMins(et + 2.5);
      }
      const n = Math.max(1, effectiveCandles.length - 1);
      const ratio = idx / n;
      return xFromEtMins(axisStartMins + ratio * axisSpanMins);
    },
    [effectiveCandles, xFromEtMins, axisStartMins, axisSpanMins]
  );

  const yForPrice = useCallback(
    (p: number) => {
      const { min, max } = priceDomain;
      const ratio = (p - min) / Math.max(0.01, max - min);
      return chartBottom - ratio * plotH;
    },
    [priceDomain, chartBottom, plotH]
  );

  // 3. Dynamic "Nice" Price Ticks for the Right Y-Axis
  const priceTicks = useMemo<PriceTick[]>(() => {
    const { min, max, span } = priceDomain;
    const targetCount = 5;
    const rawStep = span / targetCount;
    const niceSteps = [0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20];
    const step = niceSteps.find((s) => s >= rawStep) ?? niceSteps[niceSteps.length - 1];

    const first = Math.ceil(min / step) * step;
    const ticks: PriceTick[] = [];
    for (let val = first; val <= max + step * 0.05; val += step) {
      const rounded = Number(val.toFixed(2));
      const y = yForPrice(rounded);
      if (y >= padTop && y <= chartBottom) {
        ticks.push({
          price: rounded,
          y,
          label: rounded.toFixed(2),
        });
      }
    }
    return ticks;
  }, [priceDomain, yForPrice, padTop, chartBottom]);

  // 4. Exact Milestone Timing Ticks for X-Axis (dynamically matches startHour domain)
  const timeTicks = useMemo<TimeTick[]>(() => {
    const schedule =
      startHour === 0
        ? EXTENDED_SESSION_TICKS
        : [420, 480, 540, 570, 600, 660, 720, 780, 840, 900, 960, 1020]
            .filter((m) => m >= axisStartMins && m <= axisEndMins)
            .map((etMins) => {
              const h = Math.floor(etMins / 60);
              const m = etMins % 60;
              const h12 = h % 12 === 0 ? 12 : h % 12;
              const ampm = h >= 12 ? "pm" : "am";
              return {
                etMins,
                label: `${h12}:${String(m).padStart(2, "0")}${ampm}`,
                isMajor: true,
                isRthBoundary: etMins === 570 || etMins === 960,
              };
            });
    return schedule.map((t) => {
      const x = xFromEtMins(t.etMins);
      return {
        timestamp: t.etMins,
        x,
        shortLabel: t.label,
        fullLabel: `${t.label} ET`,
        isMajor: t.isMajor ?? true,
        isRthOpen: t.isRthBoundary ?? false,
      };
    });
  }, [xFromEtMins, startHour, axisStartMins, axisEndMins]);

  // 5. Enriched point series for rendering
  const enrichedPoints = useMemo<EnrichedPoint[]>(() => {
    return effectiveCandles.map((c, i) => {
      const etMins = resolveBarEtMinutes(c, i, effectiveCandles.length);
      const snap: FlowGammaVwapSnapshot | undefined = pdeSeries[i];
      const chi = typeof snap?.ceilingShareChi === "number" && Number.isFinite(snap.ceilingShareChi) ? snap.ceilingShareChi : 0.5;
      const pe = typeof snap?.pecletNumber === "number" && Number.isFinite(snap.pecletNumber) ? snap.pecletNumber : 0.0;
      const impulseChi = typeof snap?.impulseChi === "number" && Number.isFinite(snap.impulseChi) ? snap.impulseChi : chi;
      const impulsePe = typeof snap?.impulsePeclet === "number" && Number.isFinite(snap.impulsePeclet) ? snap.impulsePeclet : pe;
      const deltaNetFlux6Bar = typeof snap?.deltaNetFlux6Bar === "number" && Number.isFinite(snap.deltaNetFlux6Bar) ? snap.deltaNetFlux6Bar : 0.0;
      const netFlux = typeof snap?.netFluxJ === "number" && Number.isFinite(snap.netFluxJ) ? snap.netFluxJ : 0.0;
      const fvwap = typeof snap?.flowVwap === "number" && Number.isFinite(snap.flowVwap) ? snap.flowVwap : c.close;
      const sigma = typeof snap?.sigma === "number" && Number.isFinite(snap.sigma) ? snap.sigma : Math.max(c.close * 0.0015, 0.02);
      const upper1Sigma = typeof snap?.upper1Sigma === "number" && Number.isFinite(snap.upper1Sigma) ? snap.upper1Sigma : fvwap + sigma;
      const lower1Sigma = typeof snap?.lower1Sigma === "number" && Number.isFinite(snap.lower1Sigma) ? snap.lower1Sigma : fvwap - sigma;

      const bias = Math.max(-1, Math.min(1, Math.tanh(1.8 * (2 * chi - 1) + 0.35 * pe + 0.015 * netFlux)));
      const regime: "CALL" | "PUT" = bias >= 0 ? "CALL" : "PUT";
      const histValue = Math.max(-1, Math.min(1, bias * Math.sqrt(Math.abs(pe) + 0.5)));

      return {
        index: i,
        etMins,
        timestamp: c.timestamp ?? Date.now(),
        timeLabel: c.timeLabel || formatTimeEt(c.timestamp ?? Date.now()).full,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        flowVwap: fvwap,
        sigma,
        upper1Sigma,
        lower1Sigma,
        chi,
        pe,
        impulseChi,
        impulsePe,
        deltaNetFlux6Bar,
        netFlux,
        bias,
        regime,
        histValue,
        baseX: xFromEtMins(etMins + 2.5),
        baseY: yForPrice(c.close),
      };
    });
  }, [effectiveCandles, pdeSeries, xFromEtMins, yForPrice]);

  const latestPt = enrichedPoints[enrichedPoints.length - 1];
  const dominanceInfo = useMemo(
    () => classifyDominanceTriState(latestPt?.chi, latestPt?.impulseChi),
    [latestPt?.chi, latestPt?.impulseChi]
  );
  const activeChiPct = dominanceInfo.chiPct;
  const activeDominance = dominanceInfo.dominance; // "CALL" | "PUT" | "NEUTRAL"
  const activeRegime: "CALL" | "PUT" =
    activeDominance === "CALL"
      ? "CALL"
      : activeDominance === "PUT"
        ? "PUT"
        : (latestPt?.bias ?? 0) >= 0
          ? "CALL"
          : "PUT";
  const activePt = hoverIndex !== null && enrichedPoints[hoverIndex] ? enrichedPoints[hoverIndex] : latestPt;

  // SVG Paths
  const lineD = useMemo(() => {
    if (enrichedPoints.length === 0) return "";
    return enrichedPoints.reduce((acc, pt, i) => {
      return i === 0 ? `M ${pt.baseX.toFixed(1)} ${pt.baseY.toFixed(1)}` : `${acc} L ${pt.baseX.toFixed(1)} ${pt.baseY.toFixed(1)}`;
    }, "");
  }, [enrichedPoints]);

  const vwapLineD = useMemo(() => {
    if (enrichedPoints.length === 0) return "";
    return enrichedPoints.reduce((acc, pt, i) => {
      const vy = yForPrice(pt.flowVwap);
      if (i === 0) return `M ${pt.baseX.toFixed(1)} ${vy.toFixed(1)}`;
      const prev = enrichedPoints[i - 1];
      const minSigma = Math.max(0.05, Math.min(prev.sigma ?? 0, pt.sigma ?? 0));
      const cmd =
        Math.abs(pt.flowVwap - prev.flowVwap) > 1.5 * minSigma ? "M" : "L";
      return `${acc} ${cmd} ${pt.baseX.toFixed(1)} ${vy.toFixed(1)}`;
    }, "");
  }, [enrichedPoints, yForPrice]);

  // Segmented Area fills under curve
  const regimeSegments = useMemo(() => {
    if (enrichedPoints.length < 2) return [];
    const segments: Array<{ path: string; regime: "CALL" | "PUT"; opacity: number }> = [];

    let curRegime: "CALL" | "PUT" = enrichedPoints[0].regime;
    let segStartIdx = 0;

    for (let i = 1; i < enrichedPoints.length; i++) {
      const pt = enrichedPoints[i];
      if (pt.regime !== curRegime || i === enrichedPoints.length - 1) {
        const slice = enrichedPoints.slice(segStartIdx, i + 1);
        if (slice.length >= 2) {
          const first = slice[0];
          const last = slice[slice.length - 1];
          let d = `M ${first.baseX.toFixed(1)} ${chartBottom} L ${first.baseX.toFixed(1)} ${first.baseY.toFixed(1)}`;
          for (let k = 1; k < slice.length; k++) {
            d += ` L ${slice[k].baseX.toFixed(1)} ${slice[k].baseY.toFixed(1)}`;
          }
          d += ` L ${last.baseX.toFixed(1)} ${chartBottom} Z`;

          const avgBias = slice.reduce((acc, p) => acc + Math.abs(p.bias), 0) / slice.length;
          segments.push({
            path: d,
            regime: curRegime,
            opacity: Math.max(0.18, Math.min(0.55, 0.22 + avgBias * 0.3)),
          });
        }
        curRegime = pt.regime;
        segStartIdx = i;
      }
    }
    return segments;
  }, [enrichedPoints, chartBottom]);

  // Intrinsic daily Straddle Expected Move (100% decoupled from viewport zoom/pan priceDomain.span)
  // Calibrated to institutional 0DTE ATM straddle ratio (preferring canonical sigma1Move prop)
  const intrinsicExpectedMove = useMemo(() => {
    if (typeof sigma1Move === "number" && Number.isFinite(sigma1Move) && sigma1Move > 0) {
      return sigma1Move;
    }
    if (!enrichedPoints || enrichedPoints.length === 0) return 0;
    const open930Idx = enrichedPoints.findIndex((b) => b.etMins >= 570);
    const anchorIdx = open930Idx >= 0 ? open930Idx : 0;
    const open930 =
      enrichedPoints[anchorIdx]?.open > 0
        ? enrichedPoints[anchorIdx].open
        : enrichedPoints[anchorIdx]?.close ?? 0;
    if (open930 <= 0) return 0;
    return Math.max(open930 * 0.003, Math.min(open930 * 0.015, open930 * 0.00475));
  }, [enrichedPoints, sigma1Move]);

  // STAGE 1: Pure Data-Space Signal Engine (Strictly Viewport-Invariant: S ⊥ V)
  // Cache closed-bar FSM evaluation so 800ms intra-bar ticks don't re-run full session FSM
  const closedFsmKey = useMemo(() => {
    if (!enrichedPoints || enrichedPoints.length < 3) return "";
    const lastClosedIdx = enrichedPoints.length - 2;
    const lc = enrichedPoints[lastClosedIdx];
    return `${activeSymbol}|${storeActiveTicker}|${isReplayMode ? 1 : 0}|${enrichedPoints.length}|${lc?.timestamp ?? 0}|${lc?.close ?? 0}|${activeRegime}|${gammaLevels?.zeroGamma ?? 0}|${gammaLevels?.callWall ?? 0}|${gammaLevels?.putWall ?? 0}|${netMetrics?.netGex ?? 0}`;
  }, [enrichedPoints, activeSymbol, storeActiveTicker, isReplayMode, activeRegime, gammaLevels?.zeroGamma, gammaLevels?.callWall, gammaLevels?.putWall, netMetrics?.netGex]);

  const fsmEvaluation = useMemo(() => {
    if (!enrichedPoints || enrichedPoints.length < 3 || !closedFsmKey) {
      return { signals: [], committedState: "STAND_ASIDE" as const };
    }

    // STRICT NON-REPAINTING FINITE STATE MACHINE (Causal Equilibrium Dispersion, Closed-Bar Append-Only)
    const fsm = new GaiaSignalFsm();
    const bars: GaiaBarData[] = enrichedPoints.map((pt, i) => {
      const tsSec = toEpochSec(pt.timestamp);
      const prevPt = i > 0 ? enrichedPoints[i - 1] : undefined;
      const vwapSlope =
        prevPt && typeof pt.flowVwap === "number" && typeof prevPt.flowVwap === "number"
          ? pt.flowVwap - prevPt.flowVwap
          : 0;
      const slice34 = enrichedPoints.slice(Math.max(0, i - 33), i + 1);
      const sma34 = slice34.reduce((acc, p) => acc + p.close, 0) / Math.max(1, slice34.length);
      const recentHigh3 = Math.max(...enrichedPoints.slice(Math.max(0, i - 3), i + 1).map((p) => p.high));
      const recentHigh4 = Math.max(...enrichedPoints.slice(Math.max(0, i - 4), i + 1).map((p) => p.high));
      const recentLow4 = Math.min(...enrichedPoints.slice(Math.max(0, i - 4), i + 1).map((p) => p.low));
      const fallbackSigma = Math.max(0.02, pt.close * 0.0015);
      const fluxLowerExtremity = (pt.flowVwap ?? pt.close) - 1.25 * (pt.sigma ?? fallbackSigma);
      const fluxUpperExtremity = (pt.flowVwap ?? pt.close) + 1.25 * (pt.sigma ?? fallbackSigma);
      const bullDiv5m = recentLow4 <= fluxLowerExtremity && pt.close > pt.open && (prevPt ? pt.close > prevPt.close : false);
      const bearDiv5m = recentHigh4 >= fluxUpperExtremity && pt.close < pt.open && (prevPt ? pt.close < prevPt.close : false);
      return {
        barTimestamp: tsSec,
        open: pt.open,
        high: pt.high,
        low: pt.low,
        close: pt.close,
        chi: pt.chi,
        prevChi: prevPt?.chi,
        bias: pt.bias,
        netFlux: pt.netFlux,
        prevNetFlux: prevPt?.netFlux,
        peclet: pt.pe,
        impulsePeclet: pt.impulsePe,
        impulseChi: pt.impulseChi,
        deltaNetFlux6Bar: pt.deltaNetFlux6Bar,
        netGex: !isReplayMode && typeof netMetrics?.netGex === "number" ? netMetrics.netGex : undefined,
        flowVwap: pt.flowVwap,
        prevFlowVwap: prevPt?.flowVwap,
        sigmaMinus1: pt.lower1Sigma,
        sigmaPlus1: pt.upper1Sigma,
        vwapSlope,
        sma34,
        recentHigh3,
        recentLow4,
        bullDiv5m,
        bearDiv5m,
        etMins: pt.etMins,
        isClosed: i < enrichedPoints.length - 1,
      };
    });

    // Use authoritative structural walls from live book whenever available for this symbol (including Replay)
    const hasMatchingWalls =
      storeActiveTicker.toUpperCase() === activeSymbol &&
      Boolean(gammaLevels && (gammaLevels.callWall > 0 || gammaLevels.putWall > 0));
    let causalLow = Infinity;
    let causalHigh = -Infinity;
    const nowEpochSec = Math.floor(Date.now() / 1000);
    for (let i = 0; i < bars.length; i++) {
      const pt = enrichedPoints[i];
      if (pt.etMins >= RTH_OPEN_MINS && pt.etMins < RTH_CLOSE_MINS) {
        if (pt.low < causalLow) causalLow = pt.low;
        if (pt.high > causalHigh) causalHigh = pt.high;
      }
      if (!bars[i].isClosed) continue;
      const refLow = Number.isFinite(causalLow) ? causalLow : pt.low;
      const refHigh = Number.isFinite(causalHigh) ? causalHigh : pt.high;
      const spotScale = Math.max(0.01, pt.close * 0.002);
      const resolvedPutWall =
        hasMatchingWalls && gammaLevels?.putWall && gammaLevels.putWall > 0
          ? gammaLevels.putWall
          : Number(refLow.toFixed(2));
      const resolvedCallWall =
        hasMatchingWalls && gammaLevels?.callWall && gammaLevels.callWall > 0
          ? gammaLevels.callWall
          : Number(((refLow + refHigh) / 2 + spotScale).toFixed(2));
      const resolvedZg =
        hasMatchingWalls && gammaLevels?.zeroGamma && gammaLevels.zeroGamma > 0
          ? gammaLevels.zeroGamma
          : Number((refHigh + spotScale * 1.5).toFixed(2));
      const disp = computeCausalEquilibriumDispersion(bars, i);
      const barCloseTs = bars[i].barCloseTimestamp || bars[i].barTimestamp + disp.barDurationSec;
      const barRegime: "CALL" | "PUT" = pt.chi >= 0.5 ? "CALL" : "PUT";
      fsm.commitClosedBar(
        bars[i],
        disp,
        {
          macroRegime: barRegime,
          callDominancePct: Math.round(pt.chi * 100),
          netGex: hasMatchingWalls && typeof netMetrics?.netGex === "number" ? netMetrics.netGex : undefined,
          structuralLevels: {
            zeroGamma: resolvedZg,
            callWall: resolvedCallWall,
            putWall: resolvedPutWall,
            bookCenter: Number(((resolvedCallWall + resolvedPutWall) / 2).toFixed(2)),
          },
        },
        { isHistoricalBackfill: nowEpochSec - barCloseTs > Math.round(disp.barDurationSec * 1.5) }
      );
    }

    const lastIdx = bars.length - 1;
    const unclosedBar = bars.length > 0 && !bars[lastIdx].isClosed ? bars[lastIdx] : undefined;
    const lastDisp = bars.length > 0 ? computeCausalEquilibriumDispersion(bars, lastIdx) : undefined;
    const lastPtRef = enrichedPoints[lastIdx];
    const lastRefLow = Number.isFinite(causalLow) ? causalLow : (lastPtRef?.low ?? 0);
    const lastRefHigh = Number.isFinite(causalHigh) ? causalHigh : (lastPtRef?.high ?? 0);
    const lastSpotScale = Math.max(0.01, (lastPtRef?.close ?? 0) * 0.002);
    const finalPutWall =
      hasMatchingWalls && gammaLevels?.putWall && gammaLevels.putWall > 0
        ? gammaLevels.putWall
        : Number(lastRefLow.toFixed(2));
    const finalCallWall =
      hasMatchingWalls && gammaLevels?.callWall && gammaLevels.callWall > 0
        ? gammaLevels.callWall
        : Number(((lastRefLow + lastRefHigh) / 2 + lastSpotScale).toFixed(2));
    const finalZg =
      hasMatchingWalls && gammaLevels?.zeroGamma && gammaLevels.zeroGamma > 0
        ? gammaLevels.zeroGamma
        : Number((lastRefHigh + lastSpotScale * 1.5).toFixed(2));
    const snapshot = fsm.getSnapshot(unclosedBar, lastDisp, {
      macroRegime: activeRegime,
      callDominancePct: activeChiPct,
      netGex: hasMatchingWalls && typeof netMetrics?.netGex === "number" ? netMetrics.netGex : undefined,
      structuralLevels: {
        zeroGamma: finalZg,
        callWall: finalCallWall,
        putWall: finalPutWall,
        bookCenter: Number(((finalCallWall + finalPutWall) / 2).toFixed(2)),
      },
    });

    // Pair directional entries with their subsequent exit signals from snapshot.committedCallLog
    const committedLog = snapshot.committedCallLog;
    const directionalSignals = committedLog
      .map((entrySig, j) => {
        if (entrySig.toState !== "LONG" && entrySig.toState !== "SHORT") {
          return null;
        }
        const exitSig = committedLog
          .slice(j + 1)
          .find((s) => s.fromState === entrySig.toState);
        const isClosed =
          exitSig !== undefined ||
          (j < committedLog.length - 1 && snapshot.committedState !== entrySig.toState);
        return { entry: entrySig, exit: exitSig, isClosed };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);

    const openSignalId =
      snapshot.committedState !== "STAND_ASIDE" &&
      directionalSignals.length > 0 &&
      !directionalSignals[directionalSignals.length - 1].isClosed
        ? directionalSignals[directionalSignals.length - 1].entry.id
        : null;

    // Map committed signals to intrinsic markers
    const signals: Array<{
      id: string;
      barIndex: number;
      isCall: boolean;
      isWin: boolean;
      label: string;
      price: number;
      mfePoints: number;
      isOpen: boolean;
      isPending?: boolean;
      barSpanSeconds?: number;
      barCloseTimestamp?: number;
      exitPrice?: number;
      exitTimestamp?: number;
      exitIndex?: number;
      exitReason?: string;
      isClosed?: boolean;
    }> = directionalSignals.map(({ entry: s, exit: exitSig, isClosed }) => {
      let matchIdx = enrichedPoints.findIndex((b) => {
        const bSec = b.timestamp > 1e11 ? Math.floor(b.timestamp / 1000) : b.timestamp;
        return bSec === s.barTimestamp;
      });
      if (matchIdx < 0) {
        let bestDiff = Infinity;
        enrichedPoints.forEach((b, idx) => {
          const bSec = b.timestamp > 1e11 ? Math.floor(b.timestamp / 1000) : b.timestamp;
          const diff = Math.abs(bSec - s.barTimestamp);
          if (diff < bestDiff) {
            bestDiff = diff;
            matchIdx = idx;
          }
        });
      }

      let exitIdx: number | undefined;
      if (exitSig) {
        exitIdx = enrichedPoints.findIndex((b) => {
          const bSec = b.timestamp > 1e11 ? Math.floor(b.timestamp / 1000) : b.timestamp;
          return bSec === exitSig.barTimestamp;
        });
        if (exitIdx < 0) exitIdx = undefined;
      }

      const isCall = s.toState === "LONG";
      const isOpen = s.id === openSignalId;
      return {
        id: s.id,
        barIndex: Math.max(0, matchIdx),
        isCall,
        isWin: exitSig ? (isCall ? exitSig.price > s.price : s.price > exitSig.price) : true,
        label: isCall ? (isOpen ? "LONG · OPEN" : "LONG") : (isOpen ? "SHORT · OPEN" : "SHORT"),
        price: s.price,
        mfePoints: 0,
        isOpen,
        isPending: false,
        barSpanSeconds: s.barSpanSeconds,
        barCloseTimestamp: s.barCloseTimestamp,
        exitPrice: exitSig?.price,
        exitTimestamp: exitSig?.barTimestamp,
        exitIndex: exitIdx,
        exitReason: exitSig?.reason,
        isClosed,
      };
    });

    signals.sort((a, b) => a.barIndex - b.barIndex);
    return { signals, committedState: snapshot.committedState };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closedFsmKey]);

  const { signals: intrinsicSignals, committedState: fsmCommittedState } = fsmEvaluation;

  // STAGE 2: Affine Viewport Coordinate Projection (Maps invariant signals to SVG [x, y] pixels)
  const markers = useMemo(() => {
    return intrinsicSignals.map((m) => ({
      ...m,
      x: xForIdx(m.barIndex),
      y: yForPrice(m.price),
    }));
  }, [intrinsicSignals, xForIdx, yForPrice]);

  const przmSignals: PrzmSignalPoint[] = useMemo(() => {
    return intrinsicSignals
      .filter((m) => !(m as any).isPending)
      .map((m) => ({
      id: m.id,
      index: m.barIndex,
      time: enrichedPoints[m.barIndex]?.timeLabel ?? "",
      timestamp: enrichedPoints[m.barIndex]?.timestamp ?? 0,
      price: m.price,
      type: m.isCall ? "LONG" : "SHORT",
      tag: m.label.includes("OPEN")
        ? "OPEN"
        : m.label.includes("PEAK")
        ? "PEAK"
        : m.label.includes("BREAK")
        ? "BREAK"
        : "CONT",
      label: m.label,
      excursion: m.mfePoints,
      reason: m.label,
      barSpanSeconds: (m as any).barSpanSeconds,
      barCloseTimestamp: (m as any).barCloseTimestamp,
      exitPrice: (m as any).exitPrice,
      exitTimestamp: (m as any).exitTimestamp,
      exitIndex: (m as any).exitIndex,
      exitReason: (m as any).exitReason,
      isClosed: (m as any).isClosed,
    }));
  }, [intrinsicSignals, enrichedPoints]);

  // Emit evaluated FSM signals upward with structural fingerprint guard to prevent render loop
  const onSignalsEvaluatedRef = useRef(onSignalsEvaluated);
  onSignalsEvaluatedRef.current = onSignalsEvaluated;
  const prevSignalsFingerprintRef = useRef<string>("");

  useEffect(() => {
    if (!onSignalsEvaluatedRef.current) return;
    const sym = String(activeSymbol || "").trim().toUpperCase();
    const tagged = (przmSignals || []).map((s) => ({
      ...s,
      ticker: sym,
    }));
    const fingerprint = `${sym}::${tagged
      .map(
        (s) =>
          `${s.id ?? ""}:${s.timestamp ?? s.time ?? ""}:${s.type ?? ""}:${
            s.price ?? ""
          }:${s.isClosed ? 1 : 0}:${s.exitPrice ?? ""}:${s.exitTimestamp ?? ""}:${
            s.reason ?? ""
          }`
      )
      .join("|")}`;

    if (fingerprint !== prevSignalsFingerprintRef.current) {
      prevSignalsFingerprintRef.current = fingerprint;
      onSignalsEvaluatedRef.current(tagged);
    }
  }, [przmSignals, activeSymbol]);

  const lastCandleTsRaw = Number(effectiveCandles[effectiveCandles.length - 1]?.timestamp ?? 0);
  const lastCandleTsSec = lastCandleTsRaw > 0 ? toEpochSec(lastCandleTsRaw) : 0;
  const effectiveReplayTsSec =
    isReplayMode ? (typeof replayBarTsSec === "number" && replayBarTsSec > 0 ? replayBarTsSec : lastCandleTsSec) : 0;

  // Project authoritative server trades (BTO / STC + PnL badges + trajectory) onto SVG coordinates
  const svgServerTradeMarkers = useMemo(() => {
    const trades = extractNormalizedTradesForTicker(
      activeSymbol,
      internalServerTrades,
      hasLoadedServerTrades || serverTradesProp !== undefined ? undefined : przmSignals
    ).filter((t) => !String(t.id).startsWith("test-"));
    if (trades.length === 0 || enrichedPoints.length === 0) return [];
    let barStepSec = 300;
    if (enrichedPoints.length >= 2) {
      const intervals: number[] = [];
      const limit = Math.min(enrichedPoints.length - 1, 10);
      for (let k = 0; k < limit; k++) {
        const t0 = toEpochSec(enrichedPoints[k].timestamp);
        const t1 = toEpochSec(enrichedPoints[k + 1].timestamp);
        const step = Math.abs(t1 - t0);
        if (step >= 60 && step <= 3600) intervals.push(step);
      }
      if (intervals.length > 0) {
        intervals.sort((a, b) => a - b);
        barStepSec = intervals[Math.floor(intervals.length / 2)];
      }
    }
    const cutoffSec = effectiveReplayTsSec > 0 ? effectiveReplayTsSec + barStepSec - 1 : Infinity;
    return trades
      .filter((t) => !t.openedTs || toEpochSec(t.openedTs) <= cutoffSec)
      .map((trade) => {
        // Match authoritative server trade timestamp/label ("10:15 AM ET", "1:15 PM ET") directly to candle index
        let entryIdx = matchTradeToCandleIndex(
          enrichedPoints,
          trade.openedTs,
          trade.openedAt
        );
        if (entryIdx < 0) return null;
        const closedSec = trade.closedTs ? toEpochSec(trade.closedTs) : 0;
        const exitVisible =
          trade.status === "CLOSED" &&
          (!isReplayMode || (closedSec > 0 && closedSec <= cutoffSec));
        const exitIdx =
          exitVisible
            ? matchTradeToCandleIndex(enrichedPoints, trade.closedTs, trade.closedAt)
            : -1;
        const entryBar = enrichedPoints[entryIdx];
        const entrySpot = clampSpotToCandle(trade.btoSpotPrice, entryBar);
        const entryX = xForIdx(entryIdx);
        const entryY = yForPrice(entrySpot);
        const entryHighY = yForPrice(entryBar.high);
        const entryLowY = yForPrice(entryBar.low);

        const isClosed = exitVisible && exitIdx >= 0;
        const exitBar = isClosed ? enrichedPoints[exitIdx] : enrichedPoints[enrichedPoints.length - 1];
        const exitSpot = isClosed
          ? clampSpotToCandle(trade.closedSpotPrice ?? exitBar.close, exitBar)
          : exitBar.close;
        const exitX = isClosed ? xForIdx(exitIdx) : xForIdx(enrichedPoints.length - 1);
        const exitY = yForPrice(exitSpot);
        const exitHighY = yForPrice(exitBar.high);
        const exitLowY = yForPrice(exitBar.low);

        return {
          ...trade,
          entryIdx,
          exitIdx,
          entryX,
          entryY,
          entryHighY,
          entryLowY,
          isClosed,
          exitX,
          exitY,
          exitHighY,
          exitLowY,
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);
  }, [activeSymbol, internalServerTrades, hasLoadedServerTrades, serverTradesProp, przmSignals, enrichedPoints, xForIdx, yForPrice, effectiveReplayTsSec, isReplayMode]);

  // Structural Metrics (Open 9:30 & Straddle Expected Move) - Strictly Viewport-Invariant
  const structuralMetrics = useMemo(() => {
    if (!enrichedPoints || enrichedPoints.length === 0) {
      return { open930: 0, expectedMove: 0 };
    }
    const open930Idx = enrichedPoints.findIndex((b) => b.etMins >= 570);
    const anchorIdx = open930Idx >= 0 ? open930Idx : 0;
    const open930 =
      enrichedPoints[anchorIdx]?.open > 0
        ? enrichedPoints[anchorIdx].open
        : enrichedPoints[anchorIdx]?.close ?? 0;

    const expectedMove = intrinsicExpectedMove;
    return { open930, expectedMove };
  }, [enrichedPoints, intrinsicExpectedMove]);

  const activeSpotPrice =
    isReplayMode && typeof replayBarClose === "number" && replayBarClose > 0
      ? replayBarClose
      : !isReplayMode &&
          liveTickMarketOpen === true &&
          storeActiveTicker.toUpperCase() === activeSymbol &&
          typeof liveTickPrice === "number" &&
          liveTickPrice > 0
        ? liveTickPrice
        : !isReplayMode && typeof rawLiveSpot === "number" && rawLiveSpot > 0
          ? rawLiveSpot
          : effectiveCandles[effectiveCandles.length - 1]?.close &&
              effectiveCandles[effectiveCandles.length - 1].close > 0
            ? effectiveCandles[effectiveCandles.length - 1].close
            : fallbackReferenceSpot;

  const effectiveSessionDate = useMemo(() => {
    if (sessionDate && /^\d{4}-\d{2}-\d{2}$/.test(sessionDate)) return sessionDate;
    if (effectiveCandles.length > 0) {
      const lastSec = toEpochSec(effectiveCandles[effectiveCandles.length - 1].timestamp ?? 0);
      if (lastSec > 0) return getTodayEt(new Date(lastSec * 1000));
    }
    return getTodayEt();
  }, [sessionDate, effectiveCandles]);

  const sessionBounds = useMemo(
    () => getSessionBoundsEt(effectiveSessionDate),
    [effectiveSessionDate]
  );

  const effectiveSupervisorPolicy = useMemo(
    () =>
      supervisorPolicyProp !== undefined
        ? supervisorPolicyProp
        : internalSupervisorPolicy ??
          (storeActiveTicker.toUpperCase() === activeSymbol ? storeSupervisorPolicy : null),
    [supervisorPolicyProp, internalSupervisorPolicy, storeActiveTicker, activeSymbol, storeSupervisorPolicy]
  );

  const przmSeries: PrzmCandlePoint[] = useMemo(() => {
    return enrichedPoints.map((pt) => ({
      time: pt.timeLabel,
      timestamp: pt.timestamp,
      open: pt.open,
      high: pt.high,
      low: pt.low,
      close: pt.close,
      volume: effectiveCandles[pt.index]?.volume ?? 0,
      vwap: pt.flowVwap,
      flowVwap: pt.flowVwap,
      sigma: pt.sigma,
      chi: pt.chi,
      impulseChi: pt.impulseChi,
      pe: pt.pe,
      impulsePe: pt.impulsePe,
      deltaNetFlux6Bar: pt.deltaNetFlux6Bar,
      upperBand: pt.flowVwap + pt.sigma,
      lowerBand: pt.flowVwap - pt.sigma,
      boundaryFlux: pt.netFlux,
    }));
  }, [enrichedPoints, effectiveCandles]);

  const invalidateSvgCtm = useCallback(() => {
    cachedInverseCtmRef.current = null;
  }, []);

  const cacheSvgCtm = useCallback((): DOMMatrix | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const ctm = svg.getScreenCTM();
    const inv = ctm ? ctm.inverse() : null;
    cachedInverseCtmRef.current = inv;
    return inv;
  }, []);

  useEffect(() => {
    cachedInverseCtmRef.current = null;
    window.addEventListener("resize", invalidateSvgCtm, { passive: true });
    window.addEventListener("scroll", invalidateSvgCtm, { passive: true });
    return () => {
      window.removeEventListener("resize", invalidateSvgCtm);
      window.removeEventListener("scroll", invalidateSvgCtm);
    };
  }, [svgWidth, svgHeight, invalidateSvgCtm]);

  // Screen Pixel to SVG ViewBox Coordinate Conversion
  const getSvgCoordinates = useCallback(
    (clientX: number, clientY: number) => {
      if (!svgRef.current) return { x: 0, y: 0 };
      const svg = svgRef.current;
      const invCtm = cachedInverseCtmRef.current ?? cacheSvgCtm();
      if (invCtm) {
        const pt = svg.createSVGPoint();
        pt.x = clientX;
        pt.y = clientY;
        const svgPt = pt.matrixTransform(invCtm);
        return { x: svgPt.x, y: svgPt.y };
      }
      const rect = svg.getBoundingClientRect();
      const x = ((clientX - rect.left) / Math.max(1, rect.width)) * svgWidth;
      const y = ((clientY - rect.top) / Math.max(1, rect.height)) * svgHeight;
      return { x, y };
    },
    [svgWidth, svgHeight, cacheSvgCtm]
  );

  // Pointer & Interactive Drag Handlers
  const handlePointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    cacheSvgCtm();
    const { x: svgX, y: svgY } = getSvgCoordinates(e.clientX, e.clientY);

    dragStartRef.current = {
      clientX: e.clientX,
      clientY: e.clientY,
      startXPan: xPanOffset,
      startYPan: yPanOffset,
      startXScale: xScale,
      startYScale: yScale,
    };

    // Right margin click -> Scale Y (Price axis)
    if (svgX >= svgWidth - padRight) {
      setDragMode("scaleY");
      (e.target as Element).setPointerCapture?.(e.pointerId);
    }
    // Bottom margin click -> Scale X (Time axis below histogram)
    else if (svgY >= histBottom) {
      setDragMode("scaleX");
      (e.target as Element).setPointerCapture?.(e.pointerId);
    }
    // Main plot body click -> Pan X and Y
    else {
      setDragMode("pan");
      (e.target as Element).setPointerCapture?.(e.pointerId);
    }
  };

  const handlePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (dragMode === "pan") {
      const rect = svgRef.current?.getBoundingClientRect();
      const scaleRatioX = rect && rect.width > 0 ? svgWidth / rect.width : 1;
      const scaleRatioY = rect && rect.height > 0 ? svgHeight / rect.height : 1;
      const deltaX = (e.clientX - dragStartRef.current.clientX) * scaleRatioX;
      const deltaY = (e.clientY - dragStartRef.current.clientY) * scaleRatioY * (priceDomain.span / plotH);
      setXPanOffset(dragStartRef.current.startXPan + deltaX);
      setYPanOffset(dragStartRef.current.startYPan + deltaY);
      return;
    }

    if (dragMode === "scaleY") {
      const deltaY = dragStartRef.current.clientY - e.clientY;
      const factor = Math.max(0.3, Math.min(6.0, dragStartRef.current.startYScale * (1 + deltaY * 0.01)));
      setYScale(factor);
      return;
    }

    if (dragMode === "scaleX") {
      const deltaX = e.clientX - dragStartRef.current.clientX;
      const factor = Math.max(0.3, Math.min(6.0, dragStartRef.current.startXScale * (1 + deltaX * 0.01)));
      setXScale(factor);
      return;
    }

    // Scrub inspection with exact SVG coordinate tracking
    const { x: svgX, y: svgY } = getSvgCoordinates(e.clientX, e.clientY);
    if (svgX >= padLeft - 10 && svgX <= svgWidth - padRight + 10 && svgY >= padTop && svgY <= histBottom + 30) {
      let closestIdx = 0;
      let minDist = Infinity;
      enrichedPoints.forEach((pt, idx) => {
        const dist = Math.abs(pt.baseX - svgX);
        if (dist < minDist) {
          minDist = dist;
          closestIdx = idx;
        }
      });
      setHoverIndex(closestIdx);
    } else {
      setHoverIndex(null);
    }
  };

  const handlePointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    invalidateSvgCtm();
    setDragMode("none");
    try {
      (e.target as Element).releasePointerCapture?.(e.pointerId);
    } catch {}
  };

  const handleWheel = (e: React.WheelEvent<SVGSVGElement>) => {
    if (!e.ctrlKey && !e.metaKey && !e.altKey) return;
    e.preventDefault();
    const zoomFactor = e.deltaY < 0 ? 1.12 : 0.89;
    if (e.shiftKey) {
      setYScale((prev) => Math.max(0.3, Math.min(6.0, prev * zoomFactor)));
    } else {
      setXScale((prev) => Math.max(0.3, Math.min(6.0, prev * zoomFactor)));
    }
  };

  const handleReset = () => {
    if (onResetViewport) {
      onResetViewport();
    } else if (onXViewportChange) {
      onXViewportChange(1.0, 0);
    } else {
      setInternalXScale(1.0);
      setInternalXPanOffset(0);
    }
    setYScale(1.0);
    setYPanOffset(0);
    setHoverIndex(null);
  };

  // De-conflicted right Y-axis badge centers (>= 25px center separation even at top/bottom edge clamps)
  const spotBadgeCenterY = Math.max(padTop + 10, Math.min(chartBottom - 10, yForPrice(priceDomain.current)));
  const rawVwapBadgeY = latestPt ? Math.max(padTop + 9, Math.min(chartBottom - 9, yForPrice(latestPt.flowVwap))) : null;
  const vwapBadgeCenterY = (() => {
    if (rawVwapBadgeY === null) return null;
    if (Math.abs(rawVwapBadgeY - spotBadgeCenterY) >= 25) return rawVwapBadgeY;
    const preferBelow = rawVwapBadgeY >= spotBadgeCenterY;
    const belowCand = spotBadgeCenterY + 25;
    const aboveCand = spotBadgeCenterY - 25;
    if (preferBelow && belowCand <= chartBottom - 9) return belowCand;
    if (!preferBelow && aboveCand >= padTop + 9) return aboveCand;
    return belowCand <= chartBottom - 9 ? belowCand : aboveCand;
  })();

  return (
    <div
      className={`bg-[#0d0e19] border border-[#1e2035] rounded-2xl p-4 text-white select-none relative overflow-hidden shadow-2xl ${className}`}
    >
      {/* Tactical HUD Corner Reticles (┌ ┐ └ ┘) */}
      <div className="absolute top-2.5 left-3 text-[#4f5670] font-mono text-xs select-none pointer-events-none">┌</div>
      <div className="absolute top-2.5 right-3 text-[#4f5670] font-mono text-xs select-none pointer-events-none">┐</div>
      <div className="absolute bottom-2.5 left-3 text-[#4f5670] font-mono text-xs select-none pointer-events-none">└</div>
      <div className="absolute bottom-2.5 right-3 text-[#4f5670] font-mono text-xs select-none pointer-events-none">┘</div>

      {/* PRZM Top Deck: 3-Card Triad (CALL | TO THE BELL | DRIVERS) */}
      <PrzmTopDeck
        ticker={activeSymbol}
        liveSpot={activeSpotPrice}
        series={przmSeries}
        signals={przmSignals}
        open930={structuralMetrics.open930}
        priorClose={isStoreAligned && storePreviousClose > 0 ? storePreviousClose : undefined}
        straddleEm={structuralMetrics.expectedMove}
        zeroGamma0Dte={zeroDteLevels?.zeroGamma}
        callWall0Dte={zeroDteLevels?.callWall}
        putWall0Dte={zeroDteLevels?.putWall}
        netGex={netMetrics?.netGex}
        activeFsmState={fsmCommittedState}
        serverTrades={internalServerTrades}
        supervisorPolicy={effectiveSupervisorPolicy}
        isReplayMode={isReplayMode}
        replayBarTsSec={effectiveReplayTsSec > 0 ? effectiveReplayTsSec : undefined}
      />

      {/* Background Micro-Grid */}
      <div
        className="absolute inset-0 pointer-events-none opacity-[0.035]"
        style={{
          backgroundImage:
            "linear-gradient(#fff 1px, transparent 1px), linear-gradient(90deg, #fff 1px, transparent 1px)",
          backgroundSize: "24px 24px",
        }}
      />

      {/* Single Crisp Dark Cockpit Control Rail ([ TICKER · ZERO ] + Mode + Tri-State χ + Viewport + Spot) */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-2.5 pb-2 border-b border-slate-800/80 relative z-10">
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex items-center font-mono text-sm tracking-widest text-slate-300 tabular-nums">
            <span className="text-cyan-400 mr-1.5 text-base font-bold">+</span>
            <span className="text-slate-400 mr-1.5">[</span>
            <button
              type="button"
              onClick={() => {
                const cycle = ["SPY", "QQQ", "IWM", "NVDA"];
                const idx = cycle.indexOf(activeSymbol);
                const nextSym = idx >= 0 ? cycle[(idx + 1) % cycle.length] : "SPY";
                onSymbolChange?.(nextSym);
              }}
              className="text-cyan-400 font-bold hover:text-cyan-300 transition-colors uppercase tracking-wider underline decoration-cyan-500/40 decoration-dashed underline-offset-4 cursor-pointer"
              title={`Active ticker: ${activeSymbol} (click to cycle SPY/QQQ/IWM/NVDA)`}
            >
              {activeSymbol}
            </button>
            <span className="text-slate-500 mx-1.5">·</span>
            <span className="text-emerald-400 font-bold tracking-[0.14em]">ZERO</span>
            <span className="text-slate-400 ml-1.5">]</span>
          </div>

          {/* Operating Mode Pill (`FOLLOW | FADE | SIT OUT`) */}
          {(() => {
            const zMode =
              effectiveSupervisorPolicy?.zeroMode ??
              (effectiveSupervisorPolicy?.standAsideVetoReason
                ? "SIT_OUT"
                : effectiveSupervisorPolicy?.regime === "POS_GAMMA_PIN"
                  ? "FADE"
                  : fsmCommittedState === "STAND_ASIDE" && activeDominance === "NEUTRAL"
                    ? "SIT_OUT"
                    : "FOLLOW");
            const modeCls =
              zMode === "FOLLOW"
                ? "border-emerald-500/40 bg-emerald-500/12 text-emerald-300"
                : zMode === "FADE"
                  ? "border-cyan-500/40 bg-cyan-500/12 text-cyan-300"
                  : "border-amber-500/45 bg-amber-500/12 text-amber-300";
            return (
              <span
                className={`px-2.5 py-0.5 rounded-full border font-mono text-[11px] font-bold tracking-wider tabular-nums ${modeCls}`}
              >
                MODE: {zMode === "SIT_OUT" ? "SIT OUT" : zMode}
              </span>
            );
          })()}

          {/* Tri-State Boundary Dominance Pill (`CALL | PUT | NEUTRAL`) */}
          <div className="flex items-center gap-2 text-[11px] font-mono tabular-nums px-2.5 py-0.5 rounded-full bg-slate-900/90 border border-slate-800">
            <span
              className={`w-2 h-2 rounded-full ${
                activeDominance === "CALL"
                  ? "bg-[#00F5D4]"
                  : activeDominance === "PUT"
                    ? "bg-[#FF2A55]"
                    : "bg-slate-400"
              }`}
            />
            <span className="text-slate-400">REGIME:</span>
            <span
              className={
                activeDominance === "CALL"
                  ? "text-[#00F5D4] font-bold"
                  : activeDominance === "PUT"
                    ? "text-[#FF2A55] font-bold"
                    : "text-slate-200 font-bold"
              }
            >
              {activeDominance} (χ={activeChiPct}%)
            </span>
          </div>
        </div>

        {/* Dynamic Scale & Time Scope Toolbar */}
        <div className="flex flex-wrap items-center gap-2 font-mono text-xs tabular-nums">
          <button
            type="button"
            onClick={() => handleReset()}
            title="Auto-fit all candles in session"
            className="px-2.5 py-1 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition cursor-pointer text-[11px]"
          >
            Fit Data
          </button>
          <button
            type="button"
            onClick={() => {
              const rthOpenSlot = Math.max(0, (sessionBounds.rthOpenMins - axisStartMins) / 5);
              const rthSlotsCount = Math.max(10, (sessionBounds.rthCloseMins - sessionBounds.rthOpenMins) / 5);
              const paddedRthSlots = rthSlotsCount + 4;
              const nextScale = Math.min(4.0, totalSessionSlots / paddedRthSlots);
              const nextStepX = (plotW / Math.max(1, totalSessionSlots)) * nextScale;
              const nextPan = 2 * nextStepX - rthOpenSlot * nextStepX;
              if (onXViewportChange) {
                onXViewportChange(nextScale, nextPan);
              } else {
                setInternalXScale(nextScale);
                setInternalXPanOffset(nextPan);
              }
              setYScale(1.0);
              setYPanOffset(0);
            }}
            title={`Focus on ${sessionBounds.isEarlyClose ? "9:30am – 1:00pm Early Close" : "9:30am – 4:00pm"} RTH session`}
            className="px-2.5 py-1 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition cursor-pointer text-[11px]"
          >
            {sessionBounds.isEarlyClose ? "RTH (9:30-1:00)" : "RTH (9:30-4:00)"}
          </button>
          <button
            type="button"
            onClick={() => {
              const latestMins =
                enrichedPoints.length > 0
                  ? enrichedPoints[enrichedPoints.length - 1].etMins
                  : sessionBounds.rthCloseMins;
              const windowSpan = 150;
              const nextScale = Math.min(4.0, axisSpanMins / windowSpan);
              const startFocus = Math.max(axisStartMins, Math.min(axisEndMins - windowSpan, latestMins - 135));
              const nextPan = -(((startFocus - axisStartMins) / axisSpanMins) * plotW * nextScale);
              if (onXViewportChange) {
                onXViewportChange(nextScale, nextPan);
              } else {
                setInternalXScale(nextScale);
                setInternalXPanOffset(nextPan);
              }
              setYScale(1.0);
              setYPanOffset(0);
            }}
            title="Zoom into recent 2 hours of trading action"
            className="px-2.5 py-1 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition cursor-pointer text-[11px]"
          >
            Last 2H
          </button>

          <div className="flex items-center bg-slate-900 border border-slate-800 rounded-md overflow-hidden">
            <button
              type="button"
              onClick={() => setYScale((s) => Math.min(5.0, s * 1.25))}
              title="Expand vertical price scale (Zoom Y+)"
              className="px-2 py-1 hover:bg-slate-800 text-slate-300 hover:text-cyan-400 border-r border-slate-800 cursor-pointer"
            >
              Y+
            </button>
            <button
              type="button"
              onClick={() => setYScale((s) => Math.max(0.4, s * 0.8))}
              title="Compress vertical price scale (Zoom Y-)"
              className="px-2 py-1 hover:bg-slate-800 text-slate-300 hover:text-cyan-400 border-r border-slate-800 cursor-pointer"
            >
              Y-
            </button>
            <button
              type="button"
              onClick={handleReset}
              title="Reset Zoom & Pan to Default (or Double-Click Canvas)"
              className="px-2 py-1 hover:bg-slate-800 text-slate-300 hover:text-cyan-400 cursor-pointer"
            >
              Reset
            </button>
          </div>

          {/* Live Spot / Off-Hours Official RTH Close Display (Never $0.00) */}
          <div className="text-right ml-2 font-mono tabular-nums">
            <div className="text-[10px] text-slate-400 tracking-wider uppercase">
              {isReplayMode ? "REPLAY SPOT" : liveTickMarketOpen ? "LIVE TICK" : "RTH CLOSE"}
            </div>
            <div className="flex items-baseline justify-end gap-1.5">
              <span className="text-base font-bold text-white tracking-wide">
                {activeSpotPrice > 0 ? `$${activeSpotPrice.toFixed(2)}` : "SYNCING"}
              </span>
              {!isReplayMode &&
                !liveTickMarketOpen &&
                isStoreAligned &&
                storeExtendedQuote &&
                storeExtendedQuote.price > 0 && (
                  <span
                    className="px-1.5 py-0.5 rounded bg-slate-800/90 border border-slate-700 text-[10px] text-cyan-300 font-semibold"
                    title={`${storeExtendedQuote.type === "pre" ? "Pre-market" : "After-hours"} extended print`}
                  >
                    EXT ${storeExtendedQuote.price.toFixed(2)}
                  </span>
                )}
            </div>
          </div>
        </div>
      </div>

      {/* SVG Canvas Chart */}
      <div ref={svgWrapperRef} className="w-full relative overflow-hidden">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${svgWidth} ${svgHeight}`}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={() => {
            setDragMode("none");
            invalidateSvgCtm();
          }}
          onPointerLeave={() => {
            invalidateSvgCtm();
            setHoverIndex(null);
            setDragMode("none");
          }}
          onWheel={handleWheel}
          onDoubleClick={handleReset}
          className={`w-full h-auto block select-none ${
            dragMode === "pan" ? "cursor-grabbing" : dragMode === "scaleY" ? "cursor-ns-resize" : dragMode === "scaleX" ? "cursor-ew-resize" : "cursor-crosshair"
          }`}
          style={{ width: "100%", height: "auto" }}
        >
          <defs>
            {/* White Glow for Price Curve */}
            <filter id={`white-glow-${uid}`} x="-20%" y="-20%" width="140%" height="140%">
              <feDropShadow dx="0" dy="0" stdDeviation="3.5" floodColor="#ffffff" floodOpacity="0.75" />
              <feDropShadow dx="0" dy="0" stdDeviation="8" floodColor="#00F5D4" floodOpacity="0.35" />
            </filter>

            {/* Cyan Regime Gradient Fill */}
            <linearGradient id={`cyan-regime-${uid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#00F5D4" stopOpacity="0.45" />
              <stop offset="70%" stopColor="#00F5D4" stopOpacity="0.08" />
              <stop offset="100%" stopColor="#00F5D4" stopOpacity="0.0" />
            </linearGradient>

            {/* Red Regime Gradient Fill */}
            <linearGradient id={`red-regime-${uid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#FF2A55" stopOpacity="0.45" />
              <stop offset="70%" stopColor="#FF2A55" stopOpacity="0.08" />
              <stop offset="100%" stopColor="#FF2A55" stopOpacity="0.0" />
            </linearGradient>

            {/* Tip Node Pulsing Glow */}
            <filter id={`tip-glow-${uid}`} x="-50%" y="-50%" width="200%" height="200%">
              <feDropShadow dx="0" dy="0" stdDeviation="6" floodColor="#00F5D4" floodOpacity="0.95" />
            </filter>

            {/* Plot Area Clip Path (prevents zoomed curves/ribbons from bleeding over axes) */}
            <clipPath id={`plot-clip-${uid}`}>
              <rect x={padLeft} y={0} width={Math.max(10, plotW + 2)} height={svgHeight} />
            </clipPath>
          </defs>

          {/* Horizontal Price Grid Lines & Right Y-Axis Numerical Labels (unclipped so right-axis labels remain visible) */}
          {(() => {
            let lastTickY = -999;
            return priceTicks.map((pt, idx) => {
              const nearSpot = Math.abs(pt.y - spotBadgeCenterY) < 25;
              const nearVwap = vwapBadgeCenterY !== null && Math.abs(pt.y - vwapBadgeCenterY) < 24;
              const nearPrev = Math.abs(pt.y - lastTickY) < 15;
              const hideTickLabel = nearSpot || nearVwap || nearPrev;
              if (!hideTickLabel) lastTickY = pt.y;
              return (
                <g key={`price-tick-${idx}`}>
                  <line
                    x1={padLeft}
                    y1={pt.y}
                    x2={svgWidth - padRight}
                    y2={pt.y}
                    stroke="#172033"
                    strokeWidth="1"
                    strokeDasharray="4 6"
                  />
                  {!hideTickLabel && (
                    <text
                      x={svgWidth - padRight + 8}
                      y={pt.y + 4}
                      fill="rgba(255, 255, 255, 0.45)"
                      fontSize="11"
                      fontFamily="monospace"
                    >
                      ${pt.label}
                    </text>
                  )}
                </g>
              );
            });
          })()}

          {/* Vertical Time Axis Milestone Labels (unclipped at bottom edge, hidden outside plot corridor) */}
          {timeTicks.map((t, idx) => {
            if (t.x < padLeft - 4 || t.x > padLeft + plotW + 4) return null;
            const anchor = t.x < padLeft + 22 ? "start" : t.x > padLeft + plotW - 22 ? "end" : "middle";
            return (
              <text
                key={`time-label-${idx}`}
                x={t.x}
                y={svgHeight - 12}
                textAnchor={anchor}
                fill={t.isRthOpen ? "#2dd4bf" : "rgba(255, 255, 255, 0.45)"}
                fontSize="10"
                fontFamily="monospace"
                fontWeight={t.isRthOpen ? "bold" : "normal"}
              >
                {t.shortLabel}
              </text>
            );
          })}

          <g clipPath={`url(#plot-clip-${uid})`}>
          {/* Vertical Time Milestone Guides (cutting across all panes for clear timing) */}
          {timeTicks.map((t, idx) => {
            if (t.x < padLeft || t.x > padLeft + plotW + 2) return null;
            return (
              <line
                key={`time-guide-${idx}`}
                x1={t.x}
                y1={padTop}
                x2={t.x}
                y2={histBottom}
                stroke={t.isRthOpen ? "#2dd4bf" : "#1e293b"}
                strokeWidth={t.isRthOpen ? 1.5 : 1}
                strokeDasharray={t.isRthOpen ? "none" : "3 5"}
                opacity={t.isRthOpen ? 0.75 : 0.6}
              />
            );
          })}

          {/* Dynamic Regime Area Shading Underneath Price Curve */}
          {regimeSegments.map((seg, idx) => (
            <path
              key={`seg-${idx}`}
              d={seg.path}
              fill={seg.regime === "CALL" ? `url(#cyan-regime-${uid})` : `url(#red-regime-${uid})`}
              opacity={seg.opacity}
            />
          ))}

          {/* Flow VWAP Trajectory (Orange Smooth Curve) */}
          <path
            d={vwapLineD}
            fill="none"
            stroke="#f59e0b"
            strokeWidth="1.6"
            strokeDasharray="4 3"
            opacity="0.8"
          />

          {/* Glowing White Price Trajectory Line */}
          <path
            d={lineD}
            fill="none"
            stroke="#ffffff"
            strokeWidth="2.4"
            strokeLinejoin="round"
            strokeLinecap="round"
            filter={`url(#white-glow-${uid})`}
          />

          {/* Pinned Intraday Trade Markers */}
          {(svgServerTradeMarkers.length > 0 ? [] : markers).map((m) => {
            if (m.x < padLeft - 20 || m.x > svgWidth - padRight + 20) return null;
            const isCall = m.isCall;
            const isPending = (m as any).isPending ?? false;
            const isOpen = (m as any).isOpen ?? false;
            const hasAuthoritativeTradeOverlay = svgServerTradeMarkers.length > 0 || serverTradesProp !== undefined || hasLoadedServerTrades;
            if (hasAuthoritativeTradeOverlay) return null;
            const showBadgeCallout = isPending || (isOpen && !hasAuthoritativeTradeOverlay);
            const markerColor = isCall ? "#00F5D4" : "#FF2A55";
            const excursionText = m.mfePoints >= 0.2 ? ` +$${m.mfePoints.toFixed(1)}` : "";
            const badgeY = isCall
              ? Math.min(chartBottom - 12, m.y + 26)
              : Math.max(padTop + 14, m.y - 28);
            const badgeWidth = isPending ? 116 : m.mfePoints >= 0.2 ? 104 : 88;

            return (
              <g key={m.id} className="cursor-pointer" opacity={isPending ? 0.8 : 1.0}>
                {/* Visual Icon (Triangle + Status Glyph) */}
                <g transform={`translate(${m.x.toFixed(1)}, ${m.y.toFixed(1)})`}>
                  {isCall ? (
                    <>
                      <polygon
                        points="0,-15 -6.5,-3 6.5,-3"
                        fill={markerColor}
                        filter={`url(#white-glow-${uid})`}
                      />
                      <path
                        d="M -5 7 L -1.5 11 L 6 3"
                        fill="none"
                        stroke="#00F5D4"
                        strokeWidth="2.2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </>
                  ) : (
                    <>
                      <polygon
                        points="0,15 -6.5,3 6.5,3"
                        fill={markerColor}
                        filter={`url(#white-glow-${uid})`}
                      />
                      <path
                        d="M -5 -7 L -1.5 -11 L 6 -3"
                        fill="none"
                        stroke="#FF2A55"
                        strokeWidth="2.2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </>
                  )}
                </g>

                {/* Tactical Trade Badge Callout - Rendered strictly on the single active OPEN position */}
                {showBadgeCallout && (
                  <g transform={`translate(${m.x.toFixed(1)}, ${badgeY.toFixed(1)})`}>
                    <rect
                      x={-badgeWidth / 2}
                      y={-10}
                      width={badgeWidth}
                      height={20}
                      rx={4}
                      fill="rgba(9, 13, 22, 0.92)"
                      stroke={markerColor}
                      strokeWidth={1.2}
                      strokeDasharray={isPending ? "3 3" : undefined}
                      filter={`url(#white-glow-${uid})`}
                    />
                    <text
                      x={0}
                      y={-0.5}
                      textAnchor="middle"
                      fill={markerColor}
                      fontSize="8.5"
                      fontWeight="800"
                      fontFamily="monospace"
                    >
                      {isCall ? "▲ " : "▼ "}
                      {m.label}
                    </text>
                    <text
                      x={0}
                      y={7.5}
                      textAnchor="middle"
                      fill="#ffffff"
                      fontSize="7.5"
                      fontWeight="700"
                      fontFamily="monospace"
                    >
                      ${m.price.toFixed(2)}
                      {excursionText && (
                        <tspan fill={isCall ? "#00F5D4" : "#F59E0B"}>{excursionText}</tspan>
                      )}
                    </text>
                  </g>
                )}
              </g>
            );
          })}

          {/* Authoritative Server BTO / STC Execution Markers, Trajectory Line & De-Collided PnL Pill Badges */}
          {(() => {
            const occupiedSvgPills: Array<{ x: number; y: number; w: number; h: number }> = [];
            const placeSvgPill = (x: number, rawY: number, w: number, h: number, preferUp: boolean): number => {
              const minY = padTop + 2;
              const maxY = chartBottom - h - 2;
              const collides = (cy: number) =>
                occupiedSvgPills.some(
                  (r) => x < r.x + r.w + 3 && x + w + 3 > r.x && cy < r.y + r.h + 2 && cy + h + 2 > r.y
                );
              const clamped = Math.max(minY, Math.min(maxY, rawY));
              if (!collides(clamped)) {
                occupiedSvgPills.push({ x, y: clamped, w, h });
                return clamped;
              }
              const step = h + 4;
              for (let k = 1; k <= 6; k++) {
                const first = Math.max(minY, Math.min(maxY, clamped + (preferUp ? -k : k) * step));
                if (!collides(first)) {
                  occupiedSvgPills.push({ x, y: first, w, h });
                  return first;
                }
                const second = Math.max(minY, Math.min(maxY, clamped + (preferUp ? k : -k) * step));
                if (!collides(second)) {
                  occupiedSvgPills.push({ x, y: second, w, h });
                  return second;
                }
              }
              occupiedSvgPills.push({ x, y: clamped, w, h });
              return clamped;
            };
            return svgServerTradeMarkers.map((st) => {
            const isPut = st.contractType === "PUT";
            const btoColor = isPut ? "#ef4444" : "#10b981";
            const btoLabel = isPut ? "BTO PUT" : "BTO CALL";
            const pnlPct = st.pnlOptionPct ?? 0;
            const isProfit = pnlPct >= 0;
            const stcColor = isProfit ? "#10b981" : "#ef4444";
            const stcFill = isProfit
              ? "rgba(16, 185, 129, 0.22)"
              : "rgba(239, 68, 68, 0.22)";
            const stcText = `STC ${pnlPct >= 0 ? "+" : ""}${Math.round(pnlPct)}%`;
            const stcBadgeW = Math.max(86, stcText.length * 8.5 + 16);

            const btoTipY = isPut
              ? Math.max(padTop + 18, st.entryHighY - 6)
              : Math.min(chartBottom - 18, st.entryLowY + 6);
            const btoPillX = Math.max(padLeft + 2, Math.min(svgWidth - padRight - 62, st.entryX - 30));
            const rawBtoPillY = isPut
              ? Math.max(padTop + 2, btoTipY - 26)
              : Math.min(chartBottom - 18, btoTipY + 12);
            const btoPillY = placeSvgPill(btoPillX, rawBtoPillY, 60, 15, isPut);

            const stcHasClearanceBelow = st.exitLowY + 22 <= chartBottom;
            const stcTipY = isPut
              ? stcHasClearanceBelow
                ? st.exitLowY + 6
                : Math.max(padTop + 20, st.exitHighY - 6)
              : Math.max(padTop + 20, st.exitHighY - 6);
            const rawBadgeX = st.exitX + 9;
            const stcBadgeX =
              rawBadgeX + stcBadgeW > svgWidth - padRight
                ? Math.max(padLeft + 4, st.exitX - stcBadgeW - 6)
                : rawBadgeX;
            const rawStcBadgeY = isPut
              ? stcHasClearanceBelow
                ? Math.min(chartBottom - 20, stcTipY + 2)
                : Math.max(padTop + 4, stcTipY - 20)
              : Math.max(padTop + 4, stcTipY - 20);
            const stcBadgeY = st.isClosed
              ? placeSvgPill(stcBadgeX, rawStcBadgeY, stcBadgeW, 18, !isPut || !stcHasClearanceBelow)
              : rawStcBadgeY;

            return (
              <g key={`srv-trade-${st.id}`}>
                {/* Dotted Trajectory Connector Line */}
                <line
                  x1={st.entryX}
                  y1={st.entryY}
                  x2={st.exitX}
                  y2={st.exitY}
                  stroke={st.isClosed ? stcColor : btoColor}
                  strokeWidth="1.75"
                  strokeDasharray="4 4"
                  opacity="0.82"
                />
                <circle cx={st.entryX} cy={st.entryY} r="3" fill={btoColor} />
                {st.isClosed && (
                  <circle cx={st.exitX} cy={st.exitY} r="3" fill={stcColor} />
                )}

                {/* BTO Entry Triangle & Label */}
                {st.entryX >= padLeft - 20 && st.entryX <= svgWidth - padRight + 20 && (
                  <g>
                    <polygon
                      points={
                        isPut
                          ? `${st.entryX},${btoTipY} ${st.entryX - 6.5},${btoTipY - 9.5} ${st.entryX + 6.5},${btoTipY - 9.5}`
                          : `${st.entryX},${btoTipY} ${st.entryX - 6.5},${btoTipY + 9.5} ${st.entryX + 6.5},${btoTipY + 9.5}`
                      }
                      fill={btoColor}
                      stroke="#ffffff"
                      strokeWidth="1"
                    />
                    <rect
                      x={btoPillX}
                      y={btoPillY}
                      width="60"
                      height="15"
                      rx="4"
                      fill="rgba(15, 23, 42, 0.92)"
                      stroke={btoColor}
                      strokeWidth="1.2"
                    />
                    <text
                      x={btoPillX + 30}
                      y={btoPillY + 10.5}
                      textAnchor="middle"
                      fill={isPut ? "#fca5a5" : "#6ee7b7"}
                      fontSize="9"
                      fontWeight="bold"
                      fontFamily="monospace"
                    >
                      {btoLabel}
                    </text>
                  </g>
                )}

                {/* STC Cover Triangle & Glowing PnL Pill Badge */}
                {st.isClosed &&
                  st.exitX >= padLeft - 20 &&
                  st.exitX <= svgWidth - padRight + 20 && (
                      <g>
                        <polygon
                          points={
                            isPut
                              ? `${st.exitX},${stcTipY} ${st.exitX - 6.5},${stcTipY + 9.5} ${st.exitX + 6.5},${stcTipY + 9.5}`
                              : `${st.exitX},${stcTipY} ${st.exitX - 6.5},${stcTipY - 9.5} ${st.exitX + 6.5},${stcTipY - 9.5}`
                          }
                          fill={stcColor}
                          stroke="#ffffff"
                          strokeWidth="1"
                        />
                        <rect
                          x={stcBadgeX}
                          y={stcBadgeY}
                          width={stcBadgeW}
                          height="18"
                          rx="5"
                          fill="rgba(9, 13, 22, 0.9)"
                        />
                        <rect
                          x={stcBadgeX}
                          y={stcBadgeY}
                          width={stcBadgeW}
                          height="18"
                          rx="5"
                          fill={stcFill}
                          stroke={stcColor}
                          strokeWidth="1.4"
                        />
                        <text
                          x={stcBadgeX + stcBadgeW / 2}
                          y={stcBadgeY + 12.5}
                          textAnchor="middle"
                          fill={stcColor}
                          fontSize="10"
                          fontWeight="bold"
                          fontFamily="monospace"
                        >
                          {stcText}
                        </text>
                      </g>
                    )}
              </g>
            );
          });
          })()}

          {/* Active Curve Tip Marker (Dark Cockpit steady illumination — no infinite SVG animate) */}
          {latestPt && latestPt.baseX >= padLeft && latestPt.baseX <= padLeft + plotW + 2 && (
            <g transform={`translate(${latestPt.baseX.toFixed(1)}, ${latestPt.baseY.toFixed(1)})`}>
              <circle r="8.5" fill="none" stroke="#00F5D4" strokeWidth="1.2" opacity="0.45" />
              <circle r="4.5" fill="#ffffff" stroke="#00F5D4" strokeWidth="2.2" />
            </g>
          )}
          </g>

          {/* Right Y-Axis Live Spot Badge */}
          {priceDomain.current > 0 && (
            <g transform={`translate(${svgWidth - padRight + 4}, ${spotBadgeCenterY - 10})`}>
              <rect width="72" height="20" rx="4" fill="#00F5D4" fillOpacity="0.18" stroke="#00F5D4" strokeWidth="1.2" />
              <text x="36" y="14" textAnchor="middle" fill="#00F5D4" fontSize="11" fontFamily="monospace" fontWeight="bold">
                ${priceDomain.current.toFixed(2)}
              </text>
            </g>
          )}

          {/* Right Y-Axis Flow VWAP Badge (De-conflicted >= 15px from Spot Badge) */}
          {latestPt && vwapBadgeCenterY !== null && (
            <g transform={`translate(${svgWidth - padRight + 4}, ${vwapBadgeCenterY - 9})`}>
              <rect width="72" height="18" rx="3" fill="#f59e0b" fillOpacity="0.15" stroke="#f59e0b" strokeWidth="1" />
              <text x="36" y="13" textAnchor="middle" fill="#f59e0b" fontSize="10" fontFamily="monospace" fontWeight="bold">
                ${latestPt.flowVwap.toFixed(2)}
              </text>
            </g>
          )}

          {/* Canonical X-Axis-Locked "THE CALL" Segmented RTH Ribbon (09:30 -> 16:00 / 13:00 Half-Day) */}
          <g>
            <text
              x={padLeft}
              y={ribbonTop - 8}
              fill="rgba(255, 255, 255, 0.72)"
              fontSize="10"
              fontFamily="monospace"
              fontWeight="bold"
              letterSpacing="0.22em"
            >
              THE CALL
            </text>

            <text
              x={svgWidth - padRight}
              y={ribbonTop - 8}
              textAnchor="end"
              fill={
                activeDominance === "CALL"
                  ? "#00F5D4"
                  : activeDominance === "PUT"
                    ? "#FF2A55"
                    : "#94A3B8"
              }
              fontSize="10"
              fontFamily="monospace"
              fontWeight="bold"
            >
              {dominanceInfo.label}
            </text>

            <g clipPath={`url(#plot-clip-${uid})`}>
              {(() => {
                const nowSec =
                  effectiveReplayTsSec > 0 ? effectiveReplayTsSec : Math.floor(Date.now() / 1000);
                const replayCutoffMins =
                  effectiveReplayTsSec > 0 ? etMinutesOfDay(effectiveReplayTsSec) : Infinity;
                const isTodaySession = !sessionDate || effectiveSessionDate === getTodayEt();
                const nowEtMins = isTodaySession ? etMinutesOfDay(nowSec) : Infinity;
                const latestActualPt =
                  enrichedPoints.length > 0 ? enrichedPoints[enrichedPoints.length - 1] : null;
                const latestActualSec = latestActualPt ? toEpochSec(latestActualPt.timestamp) : 0;
                const latestActualMins = latestActualPt ? latestActualPt.etMins : -1;

                // Map elapsed 5m buckets -> EnrichedPoint
                const bucketMap = new Map<number, EnrichedPoint>();
                for (const pt of enrichedPoints) {
                  const b = Math.floor(pt.etMins / 5) * 5;
                  bucketMap.set(b, pt);
                }

                // Allocate full RTH 5-minute slot grid (09:30 -> 16:00 ET, or 13:00 ET on NYSE half-days)
                const slotStart =
                  startHour === 0
                    ? Math.min(
                        sessionBounds.rthOpenMins,
                        enrichedPoints.length > 0
                          ? Math.floor(enrichedPoints[0].etMins / 5) * 5
                          : sessionBounds.rthOpenMins
                      )
                    : sessionBounds.rthOpenMins;
                const slotEnd = sessionBounds.rthCloseMins;
                const slotW = (plotW / Math.max(1, totalSessionSlots)) * currentXScale;
                const tickW = Math.max(2, slotW - 1.8);
                const rects: React.ReactNode[] = [];

                for (let slotMins = slotStart; slotMins < slotEnd; slotMins += 5) {
                  const baseX = xFromEtMins(slotMins + 2.5);
                  if (baseX < padLeft - tickW || baseX > padLeft + plotW + tickW) continue;
                  const pt = bucketMap.get(slotMins);
                  const ptSec = pt ? toEpochSec(pt.timestamp) : 0;
                  const isUnelapsed =
                    !pt ||
                    (ptSec > 0 && ptSec > nowSec) ||
                    (latestActualSec > 0 && ptSec > latestActualSec) ||
                    slotMins > replayCutoffMins ||
                    slotMins > nowEtMins ||
                    (latestActualMins >= 0 && slotMins > latestActualMins);

                  if (isUnelapsed) {
                    rects.push(
                      <rect
                        key={`call-slot-${slotMins}`}
                        x={baseX - tickW / 2}
                        y={ribbonTop}
                        width={tickW}
                        height={ribbonHeight}
                        rx="1"
                        fill="rgba(30, 41, 59, 0.35)"
                        fillOpacity={1}
                      />
                    );
                    continue;
                  }

                  const ptDom = classifyDominanceTriState(pt.chi, pt.impulseChi).dominance;
                  const isExtendedHours =
                    slotMins < sessionBounds.rthOpenMins || slotMins >= sessionBounds.rthCloseMins;
                  const col =
                    ptDom === "CALL"
                      ? "#00F5D4"
                      : ptDom === "PUT"
                        ? "#FF2A55"
                        : Math.abs(pt.bias) >= 0.14
                          ? pt.bias > 0
                            ? "#00F5D4"
                            : "#FF2A55"
                          : "#64748B";
                  const baseOp =
                    col === "#64748B"
                      ? 0.55
                      : Math.max(0.45, Math.min(1.0, 0.45 + Math.abs(pt.bias) * 0.55));
                  const op = isExtendedHours ? Number((baseOp * 0.55).toFixed(2)) : baseOp;
                  rects.push(
                    <rect
                      key={`call-slot-${slotMins}`}
                      x={baseX - tickW / 2}
                      y={ribbonTop}
                      width={tickW}
                      height={ribbonHeight}
                      rx="1"
                      fill={col}
                      fillOpacity={op}
                    />
                  );
                }
                return rects;
              })()}
            </g>
          </g>

          {/* Net Boundary Flux & Momentum Histogram */}
          <g>
            {/* Zero Axis */}
            <line
              x1={padLeft}
              y1={histZeroY}
              x2={padLeft + plotW}
              y2={histZeroY}
              stroke="rgba(255, 255, 255, 0.18)"
              strokeWidth="1"
            />

            <text
              x={padLeft}
              y={histTop - 6}
              fill="rgba(255, 255, 255, 0.5)"
              fontSize="9"
              fontFamily="monospace"
              letterSpacing="0.15em"
            >
              BOUNDARY FLUX (J_NET / PE)
            </text>

            <g clipPath={`url(#plot-clip-${uid})`}>
            {enrichedPoints.map((pt, i) => {
              const rawSlotTs = Number((pt as any)?.ts ?? (pt as any)?.timestamp ?? (pt as any)?.startSec ?? 0);
              const normSlotTs = rawSlotTs > 0 ? toEpochSec(rawSlotTs) : 0;
              const latestActualRaw = enrichedPoints.length > 0 ? Number(enrichedPoints[enrichedPoints.length - 1]?.timestamp ?? 0) : 0;
              const latestActualSec = latestActualRaw > 0 ? toEpochSec(latestActualRaw) : 0;
              const nowSec = effectiveReplayTsSec > 0 ? effectiveReplayTsSec : Math.floor(Date.now() / 1000);
              const slotIsFuture = normSlotTs > 0 && (normSlotTs > nowSec || (latestActualSec > 0 && normSlotTs > latestActualSec));
              if (pt.baseX < padLeft || pt.baseX > padLeft + plotW + 2) return null;
              const slotW = (plotW / Math.max(1, totalSessionSlots)) * currentXScale;
              const barW = Math.max(2.4, slotW - 2.0);
              const val = pt.histValue;
              const barH = Math.max(2, Math.abs(val) * histHalfH);
              const isPos = val >= 0;
              const y = isPos ? histZeroY - barH : histZeroY;
              const col = slotIsFuture ? "rgba(148, 163, 184, 0.25)" : isPos ? "#00F5D4" : "#FF2A55";
              const isExtendedHours = pt.etMins < 570 || pt.etMins >= 960;
              const baseOp = slotIsFuture ? 0.22 : Math.max(0.45, Math.min(0.95, 0.45 + Math.abs(val) * 0.5));
              const op = !slotIsFuture && isExtendedHours ? Number((baseOp * 0.55).toFixed(2)) : baseOp;

              return (
                <rect
                  key={`hist-${i}`}
                  x={pt.baseX - barW / 2}
                  y={y}
                  width={barW}
                  height={barH}
                  rx="1"
                  fill={col}
                  fillOpacity={op}
                />
              );
            })}
            </g>
          </g>

          {/* Interactive Laser Crosshair & Floating Exact Timestamp Badge */}
          {activePt && hoverIndex !== null && activePt.baseX >= padLeft && activePt.baseX <= svgWidth - padRight && (
            <g pointerEvents="none">
              <line
                x1={activePt.baseX}
                y1={padTop}
                x2={activePt.baseX}
                y2={histBottom}
                stroke="#38bdf8"
                strokeWidth="1.2"
                strokeDasharray="3 3"
              />

              <circle cx={activePt.baseX} cy={activePt.baseY} r="5" fill="#38bdf8" stroke="#ffffff" strokeWidth="2" />

              {/* Bottom Exact Timestamp Badge (Deconflicted Clearance) */}
              <g transform={`translate(${activePt.baseX}, ${histBottom + 4})`}>
                <rect x="-42" y="0" width="84" height="17" rx="3.5" fill="#0369a1" stroke="#38bdf8" strokeWidth="1" />
                <text x="0" y="12" textAnchor="middle" fill="#ffffff" fontSize="9.5" fontFamily="monospace" fontWeight="bold">
                  {formatTimeEt(activePt.timestamp).short}
                </text>
              </g>

              {/* Floating Quant Tooltip Card (Smart Side-Flipping) */}
              <g
                transform={`translate(${
                  activePt.baseX > (svgWidth - padRight) / 2
                    ? Math.max(padLeft + 6, activePt.baseX - 222)
                    : Math.min(svgWidth - padRight - 216, activePt.baseX + 14)
                }, ${padTop + 6})`}
              >
                <rect
                  width="210"
                  height="72"
                  rx="6"
                  fill="#090d16"
                  fillOpacity="0.94"
                  stroke="#1e293b"
                  strokeWidth="1.2"
                />
                <text x="12" y="18" fill="#ffffff" fontSize="11" fontFamily="monospace" fontWeight="bold">
                  {formatTimeEt(activePt.timestamp).short} · {activeSymbol}
                </text>
                <text x="12" y="34" fill="#94a3b8" fontSize="10" fontFamily="monospace">
                  Spot: <tspan fill="#ffffff" fontWeight="bold">${activePt.close.toFixed(2)}</tspan> · VWAP: <tspan fill="#f59e0b">${activePt.flowVwap.toFixed(2)}</tspan>
                </text>
                <text x="12" y="49" fill="#94a3b8" fontSize="10" fontFamily="monospace">
                  {(() => {
                    const tipDom = classifyDominanceTriState(activePt.chi, activePt.impulseChi);
                    const tipFill =
                      tipDom.dominance === "CALL"
                        ? "#00F5D4"
                        : tipDom.dominance === "PUT"
                          ? "#FF2A55"
                          : "#CBD5E1";
                    return (
                      <>
                        Regime: <tspan fill={tipFill} fontWeight="bold">{tipDom.dominance} (χ={tipDom.chiPct}%)</tspan>
                      </>
                    );
                  })()}
                </text>
                <text x="12" y="64" fill="#94a3b8" fontSize="10" fontFamily="monospace">
                  Péclet: <tspan fill="#38bdf8">{activePt.pe >= 0 ? "+" : ""}{activePt.pe.toFixed(2)}</tspan> · J_net: <tspan fill={activePt.netFlux >= 0 ? "#00F5D4" : "#FF2A55"}>{activePt.netFlux.toFixed(1)}</tspan>
                </text>
              </g>
            </g>
          )}

          {/* Drag & Axis Helper Indicator Labels */}
          <text
            x={svgWidth - 14}
            y={(padTop + chartBottom) / 2}
            textAnchor="middle"
            fill="rgba(255, 255, 255, 0.18)"
            fontSize="9"
            fontFamily="monospace"
            transform={`rotate(90 ${svgWidth - 14} ${(padTop + chartBottom) / 2})`}
          >
            DRAG Y TO SCALE PRICE
          </text>
          <text
            x={(padLeft + svgWidth - padRight) / 2}
            y={chartBottom - 6}
            textAnchor="middle"
            fill="rgba(255, 255, 255, 0.18)"
            fontSize="9"
            fontFamily="monospace"
          >
            DRAG X TO SCALE TIME · DOUBLE-CLICK TO RESET
          </text>
        </svg>
      </div>

      {/* PRZM Bottom Deck: Call Log Ledger (LIVE | SHADOW) & Public Scoreboard */}
      <PrzmCallLogDeck
        signals={przmSignals}
        series={przmSeries}
        liveSpot={activeSpotPrice}
        activeFsmState={fsmCommittedState}
        serverTrades={internalServerTrades}
        zeroShadow={zeroShadow}
        ticker={activeSymbol}
        replayBarTsSec={effectiveReplayTsSec > 0 ? effectiveReplayTsSec : undefined}
      />
    </div>
  );
};

export const GaiaCallPutBiasHud = React.memo(GaiaCallPutBiasHudInner);
export default GaiaCallPutBiasHud;
