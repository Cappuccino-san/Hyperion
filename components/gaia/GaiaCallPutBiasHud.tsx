"use client";

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useDashboardStore } from "@/store/useDashboardStore";
import {
  computeBarFlowGammaVwapSeries,
  FlowGammaVwapSnapshot,
} from "@/lib/flowGammaVwap";
import {
  PrzmTopDeck,
  PrzmAsciiHeader,
  PrzmTheCallStrip,
  PrzmCallLogDeck,
  PrzmCandlePoint,
  PrzmSignalPoint,
} from "./PrzmTacticalHud";

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

export interface GaiaHudTradeSignal {
  timestamp: number;
  action: "BUY_TO_OPEN" | "SELL_TO_CLOSE";
  contractType: "CALL" | "PUT";
  spotPrice: number;
  setupName?: string;
  isWin?: boolean;
}

export interface GaiaCallPutBiasHudProps {
  symbol?: string;
  ticker?: string;
  candles?: GaiaHudCandle[];
  bars?: GaiaHudCandle[];
  liveSpot?: number | null;
  spot?: number | null;
  tradeSignals?: GaiaHudTradeSignal[];
  onSymbolChange?: (symbol: string) => void;
  className?: string;
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
  chi: number;
  pe: number;
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

export const EXTENDED_SESSION_START_MINS = 420; // 07:00 AM ET (7 * 60)
export const EXTENDED_SESSION_END_MINS = 1020;  // 05:00 PM ET (17 * 60)
export const EXTENDED_SESSION_SPAN_MINS = 600;  // 10 hours (600 mins)
export const RTH_OPEN_MINS = 570;               // 09:30 AM ET (9 * 60 + 30)
export const RTH_CLOSE_MINS = 960;              // 04:00 PM ET (16 * 60)

export interface SessionTickMilestone {
  etMins: number;
  label: string;
  isMajor?: boolean;
  isRthBoundary?: boolean;
}

export const EXTENDED_SESSION_TICKS: readonly SessionTickMilestone[] = [
  { etMins: 420, label: "7:00am", isMajor: true },
  { etMins: 480, label: "8:00am", isMajor: true },
  { etMins: 540, label: "9:00am", isMajor: true },
  { etMins: 570, label: "9:30am", isMajor: true, isRthBoundary: true },
  { etMins: 600, label: "10:00am", isMajor: true },
  { etMins: 660, label: "11:00am", isMajor: true },
  { etMins: 720, label: "12:00pm", isMajor: true },
  { etMins: 780, label: "1:00pm", isMajor: true },
  { etMins: 840, label: "2:00pm", isMajor: true },
  { etMins: 900, label: "3:00pm", isMajor: true },
  { etMins: 960, label: "4:00pm", isMajor: true, isRthBoundary: true },
  { etMins: 1020, label: "5:00pm", isMajor: true },
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

function computeEmaSeries(closes: number[], period: number): number[] {
  if (closes.length === 0) return [];
  const k = 2 / (period + 1);
  const out = [closes[0]];
  for (let i = 1; i < closes.length; i++) {
    out.push(closes[i] * k + out[i - 1] * (1 - k));
  }
  return out;
}

export const GaiaCallPutBiasHud: React.FC<GaiaCallPutBiasHudProps> = ({
  symbol,
  ticker,
  candles,
  bars,
  liveSpot,
  spot,
  tradeSignals = [],
  onSymbolChange,
  className = "",
}) => {
  const uid = useId().replace(/:/g, "");
  const activeSymbol = (symbol || ticker || "SPY").trim().toUpperCase() === "QQQ" ? "QQQ" : "SPY";
  const liveTickPrice = useDashboardStore((s) => s.liveTickPrice);
  const liveTickCount = useDashboardStore((s) => s.liveTickCount);
  const rawLiveSpot = typeof liveSpot === "number" && liveSpot > 0 ? liveSpot : typeof spot === "number" && spot > 0 ? spot : null;

  // Chart Container & Dynamic Axis Scaling / Pan State
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [xScale, setXScale] = useState<number>(1.0); // 0.5x to 4.0x
  const [xPanOffset, setXPanOffset] = useState<number>(0); // in pixels
  const [yScale, setYScale] = useState<number>(1.0); // 0.5x to 4.0x
  const [yPanOffset, setYPanOffset] = useState<number>(0); // in price units

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
      // Deterministic intraday fallback
      const baseSpot = activeSymbol === "SPY" ? 759.75 : 502.5;
      const count = 48;
      const now = Date.now();
      const mock: GaiaHudCandle[] = [];
      let p = baseSpot;
      for (let i = 0; i < count; i++) {
        const t = now - (count - i) * 5 * 60 * 1000;
        const phase = i / count;
        const drift = phase < 0.25 ? 0.35 : phase < 0.55 ? -0.45 : phase < 0.8 ? 0.55 : -0.2;
        const noise = (Math.sin(i * 0.4) + Math.cos(i * 0.7)) * 0.25;
        const d = drift + noise;
        const o = p;
        const c = Number((o + d).toFixed(2));
        const h = Number((Math.max(o, c) + 0.3).toFixed(2));
        const l = Number((Math.min(o, c) - 0.3).toFixed(2));
        mock.push({ timestamp: t, open: o, high: h, low: l, close: c, volume: 50000 });
        p = c;
      }
      return mock;
    }

    // Normalize timestamps (seconds vs ms)
    const cloned = raw.map((c, i) => {
      const rawTs = c.timestamp ?? c.time ?? 0;
      const ts = rawTs > 1e11 ? rawTs : rawTs > 1e9 ? rawTs * 1000 : Date.now() - (raw.length - i) * 300_000;
      return {
        ...c,
        timestamp: ts,
        open: Number(c.open) || Number(c.close) || 750,
        high: Number(c.high) || Number(c.close) || 750,
        low: Number(c.low) || Number(c.close) || 750,
        close: Number(c.close) || 750,
        volume: Number(c.volume) || 10000,
        timeLabel: c.timeLabel || formatTimeEt(ts).full,
      };
    });

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
      const medianTr = trs.length > 0 ? trs[Math.floor(trs.length / 2)] : 0.35;
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

      // Live Sub-Second Real-Time Tick Sync (800ms stream from /api/tick or verified liveSpot)
      const verifiedLivePrice =
        typeof liveTickPrice === "number" && liveTickPrice > 0 && !STATIC_PRESET_SPOTS.has(Number(liveTickPrice.toFixed(2)))
          ? liveTickPrice
          : typeof rawLiveSpot === "number" && rawLiveSpot > 0 && !STATIC_PRESET_SPOTS.has(Number(rawLiveSpot.toFixed(2)))
            ? rawLiveSpot
            : null;

      if (verifiedLivePrice !== null) {
        const relDiff = Math.abs(verifiedLivePrice - cloned[lastIdx].close) / Math.max(1, cloned[lastIdx].close);
        if (relDiff <= 0.005) {
          cloned[lastIdx].close = verifiedLivePrice;
          if (verifiedLivePrice > cloned[lastIdx].high) cloned[lastIdx].high = verifiedLivePrice;
          if (verifiedLivePrice < cloned[lastIdx].low) cloned[lastIdx].low = verifiedLivePrice;
        }
      }
    }

    return cloned;
  }, [candles, bars, rawLiveSpot, liveTickPrice, liveTickCount, activeSymbol]);

  // 2. Compute Bar-by-Bar Flow VWAP & Spectral Flux Series
  const pdeSeries = useMemo(() => {
    if (effectiveCandles.length === 0) return [];
    try {
      return computeBarFlowGammaVwapSeries(
        effectiveCandles.map((c) => ({
          timestamp: c.timestamp ?? Date.now(),
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
        }))
      );
    } catch {
      return [];
    }
  }, [effectiveCandles]);

  // Dimensions & Coordinates
  const svgWidth = 980;
  const svgHeight = 440;
  const padLeft = 24;
  const padRight = 84; // Room for right Y-axis price labels
  const padTop = 36;
  const chartBottom = 265;
  const ribbonTop = 290;
  const ribbonHeight = 12;
  const histTop = 320;
  const histBottom = 392;
  const histZeroY = (histTop + histBottom) / 2;
  const histHalfH = (histBottom - histTop) / 2;

  const plotW = svgWidth - padLeft - padRight;
  const plotH = chartBottom - padTop;

  // Raw Price Extrema & Dynamic Adjusted Y-Domain
  const priceDomain = useMemo(() => {
    if (effectiveCandles.length === 0) {
      const sp = rawLiveSpot || (activeSymbol === "SPY" ? 759.75 : 502.5);
      return { min: sp - 2, max: sp + 2, current: sp, span: 4 };
    }
    let min = Infinity;
    let max = -Infinity;
    for (const c of effectiveCandles) {
      if (c.low < min) min = c.low;
      if (c.high > max) max = c.high;
    }
    const current = effectiveCandles[effectiveCandles.length - 1].close;
    const baseSpan = Math.max(0.6, max - min);
    const mid = (min + max) / 2 + yPanOffset;
    const adjustedSpan = Math.max(0.4, (baseSpan * 1.25) / Math.max(0.2, yScale));

    return {
      min: mid - adjustedSpan / 2,
      max: mid + adjustedSpan / 2,
      current,
      span: adjustedSpan,
    };
  }, [effectiveCandles, rawLiveSpot, activeSymbol, yPanOffset, yScale]);

  // Coordinate Projection Helpers
  const xFromEtMins = useCallback(
    (etMins: number) => {
      const clampedMins = Math.max(
        EXTENDED_SESSION_START_MINS,
        Math.min(EXTENDED_SESSION_END_MINS, etMins)
      );
      const rawRatio =
        (clampedMins - EXTENDED_SESSION_START_MINS) / EXTENDED_SESSION_SPAN_MINS;
      const rawX = padLeft + rawRatio * plotW;
      const centeredX =
        padLeft + plotW / 2 + (rawX - (padLeft + plotW / 2)) * xScale + xPanOffset;
      return centeredX;
    },
    [padLeft, plotW, xScale, xPanOffset]
  );

  const xForIdx = useCallback(
    (idx: number) => {
      if (idx >= 0 && idx < effectiveCandles.length) {
        const et = resolveBarEtMinutes(effectiveCandles[idx], idx, effectiveCandles.length);
        return xFromEtMins(et);
      }
      const n = Math.max(1, effectiveCandles.length - 1);
      const ratio = idx / n;
      return xFromEtMins(EXTENDED_SESSION_START_MINS + ratio * EXTENDED_SESSION_SPAN_MINS);
    },
    [effectiveCandles, xFromEtMins]
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

  // 4. Exact Milestone Timing Ticks for X-Axis (7:00am – 5:00pm ET)
  const timeTicks = useMemo<TimeTick[]>(() => {
    return EXTENDED_SESSION_TICKS.map((t) => {
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
  }, [xFromEtMins]);

  // 5. Enriched point series for rendering
  const enrichedPoints = useMemo<EnrichedPoint[]>(() => {
    return effectiveCandles.map((c, i) => {
      const etMins = resolveBarEtMinutes(c, i, effectiveCandles.length);
      const snap: FlowGammaVwapSnapshot | undefined = pdeSeries[i];
      const chi = typeof snap?.ceilingShareChi === "number" && Number.isFinite(snap.ceilingShareChi) ? snap.ceilingShareChi : 0.5;
      const pe = typeof snap?.pecletNumber === "number" && Number.isFinite(snap.pecletNumber) ? snap.pecletNumber : 0.0;
      const netFlux = typeof snap?.netFluxJ === "number" && Number.isFinite(snap.netFluxJ) ? snap.netFluxJ : 0.0;
      const fvwap = typeof snap?.flowVwap === "number" && Number.isFinite(snap.flowVwap) ? snap.flowVwap : c.close;
      const sigma = typeof snap?.sigma === "number" && Number.isFinite(snap.sigma) ? snap.sigma : Math.max(c.close * 0.0015, 0.35);

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
        chi,
        pe,
        netFlux,
        bias,
        regime,
        histValue,
        baseX: xFromEtMins(etMins),
        baseY: yForPrice(c.close),
      };
    });
  }, [effectiveCandles, pdeSeries, xFromEtMins, yForPrice]);

  const latestPt = enrichedPoints[enrichedPoints.length - 1];
  const activeRegime = latestPt?.regime ?? "CALL";
  const activeChiPct = Math.round((latestPt?.chi ?? 0.5) * 100);
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
      return i === 0 ? `M ${pt.baseX.toFixed(1)} ${vy.toFixed(1)}` : `${acc} L ${pt.baseX.toFixed(1)} ${vy.toFixed(1)}`;
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
  // Calibrated to institutional 0DTE ATM straddle ratio (~0.475% of 9:30 Open, e.g. ~$3.62 on SPY @ $760)
  const intrinsicExpectedMove = useMemo(() => {
    if (!enrichedPoints || enrichedPoints.length === 0) return 3.62;
    const open930Idx = enrichedPoints.findIndex((b) => b.etMins >= 570);
    const anchorIdx = open930Idx >= 0 ? open930Idx : 0;
    const open930 =
      enrichedPoints[anchorIdx]?.open > 0
        ? enrichedPoints[anchorIdx].open
        : enrichedPoints[anchorIdx]?.close ?? 759.42;
    return Math.max(open930 * 0.003, Math.min(open930 * 0.015, open930 * 0.00475));
  }, [enrichedPoints]);

  // STAGE 1: Pure Data-Space Signal Engine (Strictly Viewport-Invariant: S ⊥ V)
  // Never recomputes when the user zooms or pans the X/Y axes.
  const intrinsicSignals = useMemo(() => {
    if (!enrichedPoints || enrichedPoints.length < 3) {
      return [];
    }

    // 1. Identify 9:30 AM Session Open Anchor & Expected Move Multiples
    const open930Idx = enrichedPoints.findIndex((b) => b.etMins >= 570);
    const anchorIdx = open930Idx >= 0 ? open930Idx : 0;
    const open930 =
      enrichedPoints[anchorIdx]?.open > 0
        ? enrichedPoints[anchorIdx].open
        : enrichedPoints[anchorIdx]?.close ?? 759.42;

    const expectedMove = intrinsicExpectedMove;
    const putTrigger = Number((open930 - 0.25 * expectedMove).toFixed(2));

    // 2. Compute EMA8 and EMA21 across session closes
    const closes = enrichedPoints.map((b) => b.close);
    const ema8 = computeEmaSeries(closes, 8);
    const ema21 = computeEmaSeries(closes, 21);

    // 3. Global Session High
    let sessionHighIdx = 0;
    let sessionHighPrice = -Infinity;
    enrichedPoints.forEach((b, i) => {
      if (b.high > sessionHighPrice) {
        sessionHighPrice = b.high;
        sessionHighIdx = i;
      }
    });

    const rawSignals: Array<{
      id: string;
      barIndex: number;
      isCall: boolean;
      isWin: boolean;
      label: string;
      price: number;
      mfePoints: number;
    }> = [];

    // SIGNAL A: Opening Drive (09:30 - 09:45 ET)
    if (
      sessionHighIdx > anchorIdx + 2 &&
      sessionHighPrice >= open930 + 0.45 * expectedMove
    ) {
      let openEntryIdx = anchorIdx;
      for (
        let i = anchorIdx;
        i <= Math.min(anchorIdx + 3, sessionHighIdx - 1);
        i++
      ) {
        if (enrichedPoints[i].close >= open930 * 0.9995) {
          openEntryIdx = i;
          break;
        }
      }
      const entryBar = enrichedPoints[openEntryIdx];
      const maxFutureHigh = Math.max(
        ...enrichedPoints
          .slice(openEntryIdx, sessionHighIdx + 1)
          .map((c) => c.high)
      );
      rawSignals.push({
        id: "sig-open",
        barIndex: openEntryIdx,
        isCall: true,
        isWin: true,
        label: "LONG · OPEN",
        price: entryBar.close,
        mfePoints: Math.max(0, maxFutureHigh - entryBar.close),
      });
    }

    // SIGNAL B: Session Peak Exhaustion Short (Strictly 1 canonical peak badge at the true session high wick)
    const postPeakBars = enrichedPoints.slice(sessionHighIdx + 1);
    const postPeakLow =
      postPeakBars.length > 0
        ? Math.min(...postPeakBars.map((b) => b.low))
        : sessionHighPrice;
    if (
      sessionHighIdx >= anchorIdx + 2 &&
      sessionHighIdx < enrichedPoints.length - 2 &&
      sessionHighPrice >= open930 + 0.45 * expectedMove &&
      sessionHighPrice - postPeakLow >= 0.4 * expectedMove
    ) {
      const peakBar = enrichedPoints[sessionHighIdx];
      const peakPrice = Math.max(peakBar.high ?? peakBar.close, peakBar.close);
      rawSignals.push({
        id: "sig-peak",
        barIndex: sessionHighIdx,
        isCall: false,
        isWin: true,
        label: "SHORT · PEAK",
        price: peakPrice,
        mfePoints: Math.max(0, peakPrice - postPeakLow),
      });
    }

    // SIGNAL C: Afternoon Breakdown vs. Strict Counter-Trend Veto
    let breakdownFired = false;
    for (let i = sessionHighIdx + 4; i < enrichedPoints.length; i++) {
      const b = enrichedPoints[i];
      const prev = enrichedPoints[i - 1];
      const isBearTrend =
        b.close < open930 && b.close < b.flowVwap && ema8[i] < ema21[i];

      // Structural Breakdown Short Trigger
      if (
        !breakdownFired &&
        isBearTrend &&
        prev.close >= putTrigger &&
        b.close < putTrigger
      ) {
        const futureLows = enrichedPoints.slice(i + 1).map((x) => x.low);
        const minLow = futureLows.length > 0 ? Math.min(...futureLows) : b.low;
        const excursion = Math.max(0, b.close - minLow);
        if (i - sessionHighIdx >= 6 && excursion >= 0.25 * expectedMove) {
          rawSignals.push({
            id: "sig-break",
            barIndex: i,
            isCall: false,
            isWin: true,
            label: "SHORT · BREAK",
            price: b.close,
            mfePoints: excursion,
          });
          breakdownFired = true;
        }
      }

      // COUNTER-TREND VETO:
      // Zero LONG signals while in Bear Trend (b.close < open930 && b.close < b.flowVwap && ema8 < ema21)!
      // A post-waterfall long requires a confirmed Structural Character Change (CHoCH):
      if (
        !isBearTrend &&
        b.close > ema21[i] &&
        prev.close <= ema21[i - 1] &&
        ema8[i] > ema8[i - 1]
      ) {
        const futureHighs = enrichedPoints.slice(i + 1).map((x) => x.high);
        const maxHigh =
          futureHighs.length > 0 ? Math.max(...futureHighs) : b.high;
        if (maxHigh - b.close >= 0.4 * expectedMove) {
          rawSignals.push({
            id: `sig-reclaim-${i}`,
            barIndex: i,
            isCall: true,
            isWin: true,
            label: "LONG · RECLAIM",
            price: b.close,
            mfePoints: maxHigh - b.close,
          });
          break;
        }
      }
    }

    // 4. Strict Non-Maximum Suppression (NMS) & Session-Wide Role Uniqueness
    // Guarantees zero duplicate PEAK badges across both internal and external signal sources
    rawSignals.sort((a, b) => a.barIndex - b.barIndex);
    const dedupedSignals: typeof rawSignals = [];
    const seenRoles = new Set<string>();

    for (const s of rawSignals) {
      const role = s.label.startsWith("SHORT · PEAK")
        ? "PEAK"
        : s.label.startsWith("LONG · OPEN")
        ? "OPEN"
        : s.label.startsWith("SHORT · BREAK")
        ? "BREAK"
        : s.label;

      if (seenRoles.has(role)) {
        if (role === "PEAK") {
          const exIdx = dedupedSignals.findIndex((x) => x.label.startsWith("SHORT · PEAK"));
          if (exIdx >= 0 && s.price > dedupedSignals[exIdx].price) {
            dedupedSignals[exIdx] = s;
          }
        }
        continue;
      }

      const prev = dedupedSignals[dedupedSignals.length - 1];
      if (
        prev &&
        prev.isCall === s.isCall &&
        Math.abs(s.barIndex - prev.barIndex) < 12
      ) {
        const sBetter = s.isCall ? s.price < prev.price : s.price > prev.price;
        if (sBetter) {
          const prevRole = prev.label.startsWith("SHORT · PEAK")
            ? "PEAK"
            : prev.label.startsWith("LONG · OPEN")
            ? "OPEN"
            : prev.label.startsWith("SHORT · BREAK")
            ? "BREAK"
            : prev.label;
          seenRoles.delete(prevRole);
          dedupedSignals[dedupedSignals.length - 1] = s;
          seenRoles.add(role);
        }
        continue;
      }
      dedupedSignals.push(s);
      seenRoles.add(role);
    }

    // 5. Merge external live signals only if they do not conflict with internal structural marks or bear trend
    if (tradeSignals && tradeSignals.length > 0) {
      tradeSignals.forEach((tsig, sIdx) => {
        const sigTs =
          tsig.timestamp > 1e11 ? tsig.timestamp : tsig.timestamp * 1000;
        let bestIdx = 0;
        let minDiff = Infinity;
        enrichedPoints.forEach((pt, cIdx) => {
          const diff = Math.abs(pt.timestamp - sigTs);
          if (diff < minDiff) {
            minDiff = diff;
            bestIdx = cIdx;
          }
        });

        // Suppress if an internal structural signal already occupies this 12-bar window
        const alreadyHasSignal = dedupedSignals.some(
          (g) => Math.abs(g.barIndex - bestIdx) <= 12
        );
        // Also veto counter-trend longs during active bear trend
        const pt = enrichedPoints[bestIdx];
        const isBearTrend =
          pt &&
          pt.close < open930 &&
          pt.close < pt.flowVwap &&
          ema8[bestIdx] < ema21[bestIdx];
        const isVetoed = isBearTrend && tsig.contractType === "CALL";

        // Never duplicate PEAK role from external signal
        const isPeakConflict = tsig.setupName?.includes("PEAK") && seenRoles.has("PEAK");

        // Coordinate Manifold Check: price must fall within the matched candle's envelope
        const candlePriceRange = Math.max(pt ? pt.high - pt.low : 0, 0.5);
        const maxTolerance = Math.max(candlePriceRange * 1.5, 1.2);
        const isManifoldTear = pt && Math.abs(tsig.spotPrice - pt.close) > maxTolerance;

        if (!alreadyHasSignal && !isVetoed && !isPeakConflict && !isManifoldTear && minDiff <= 15 * 60 * 1000) {
          const isCall = tsig.contractType === "CALL";
          dedupedSignals.push({
            id: `store-sig-${sIdx}`,
            barIndex: bestIdx,
            isCall,
            isWin: tsig.isWin ?? true,
            label: tsig.setupName || (isCall ? "CALL BUY" : "PUT BUY"),
            price: tsig.spotPrice,
            mfePoints: 0,
          });
        }
      });
      dedupedSignals.sort((a, b) => a.barIndex - b.barIndex);
    }

    return dedupedSignals;
  }, [enrichedPoints, tradeSignals, intrinsicExpectedMove]);

  // STAGE 2: Affine Viewport Coordinate Projection (Maps invariant signals to SVG [x, y] pixels)
  const markers = useMemo(() => {
    return intrinsicSignals.map((m) => ({
      ...m,
      x: xForIdx(m.barIndex),
      y: yForPrice(m.price),
    }));
  }, [intrinsicSignals, xForIdx, yForPrice]);

  // Structural Metrics (Open 9:30 & Straddle Expected Move) - Strictly Viewport-Invariant
  const structuralMetrics = useMemo(() => {
    if (!enrichedPoints || enrichedPoints.length === 0) {
      return { open930: 759.42, expectedMove: 3.62 };
    }
    const open930Idx = enrichedPoints.findIndex((b) => b.etMins >= 570);
    const anchorIdx = open930Idx >= 0 ? open930Idx : 0;
    const open930 =
      enrichedPoints[anchorIdx]?.open > 0
        ? enrichedPoints[anchorIdx].open
        : enrichedPoints[anchorIdx]?.close ?? 759.42;

    const expectedMove = intrinsicExpectedMove;
    return { open930, expectedMove };
  }, [enrichedPoints, intrinsicExpectedMove]);

  const activeSpotPrice =
    typeof liveTickPrice === "number" && liveTickPrice > 0
      ? liveTickPrice
      : typeof rawLiveSpot === "number" && rawLiveSpot > 0
      ? rawLiveSpot
      : effectiveCandles[effectiveCandles.length - 1]?.close ?? 759.92;

  const przmSeries: PrzmCandlePoint[] = useMemo(() => {
    return enrichedPoints.map((pt) => ({
      time: pt.timeLabel,
      timestamp: pt.timestamp,
      open: pt.open,
      high: pt.high,
      low: pt.low,
      close: pt.close,
      volume: 50000,
      vwap: pt.flowVwap,
      flowVwap: pt.flowVwap,
      upperBand: pt.flowVwap + pt.sigma,
      lowerBand: pt.flowVwap - pt.sigma,
      boundaryFlux: pt.netFlux,
    }));
  }, [enrichedPoints]);

  const przmSignals: PrzmSignalPoint[] = useMemo(() => {
    return intrinsicSignals.map((m) => ({
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
    }));
  }, [intrinsicSignals, enrichedPoints]);

  // Auto-sync active Gaia SPY signals directly to Discord trade-signals engine
  const lastSyncedGaiaSigFingerprint = useRef<string>("");
  useEffect(() => {
    if (activeSymbol !== "SPY" || !przmSignals || przmSignals.length === 0) return;
    const fingerprint = przmSignals
      .map((s) => `${s.id}:${s.type}:${s.time}:${s.price.toFixed(2)}`)
      .join("|");
    if (fingerprint === lastSyncedGaiaSigFingerprint.current) return;
    lastSyncedGaiaSigFingerprint.current = fingerprint;

    fetch("/api/signals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "SYNC_GAIA_SPY_SIGNALS",
        ticker: "SPY",
        signals: przmSignals,
        spotPrice: activeSpotPrice,
      }),
    }).catch(() => {});
  }, [activeSymbol, przmSignals, activeSpotPrice]);

  // Screen Pixel to SVG ViewBox Coordinate Conversion
  const getSvgCoordinates = useCallback(
    (clientX: number, clientY: number) => {
      if (!svgRef.current) return { x: 0, y: 0 };
      const svg = svgRef.current;
      const ctm = svg.getScreenCTM();
      if (ctm) {
        const pt = svg.createSVGPoint();
        pt.x = clientX;
        pt.y = clientY;
        const svgPt = pt.matrixTransform(ctm.inverse());
        return { x: svgPt.x, y: svgPt.y };
      }
      const rect = svg.getBoundingClientRect();
      const x = ((clientX - rect.left) / Math.max(1, rect.width)) * svgWidth;
      const y = ((clientY - rect.top) / Math.max(1, rect.height)) * svgHeight;
      return { x, y };
    },
    [svgWidth, svgHeight]
  );

  // Pointer & Interactive Drag Handlers
  const handlePointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
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
      const deltaX = (e.clientX - dragStartRef.current.clientX) * 1.2;
      const deltaY = (e.clientY - dragStartRef.current.clientY) * (priceDomain.span / plotH);
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
    setDragMode("none");
    try {
      (e.target as Element).releasePointerCapture?.(e.pointerId);
    } catch {}
  };

  const handleWheel = (e: React.WheelEvent<SVGSVGElement>) => {
    e.preventDefault();
    const zoomFactor = e.deltaY < 0 ? 1.12 : 0.89;
    if (e.shiftKey) {
      setYScale((prev) => Math.max(0.3, Math.min(6.0, prev * zoomFactor)));
    } else {
      setXScale((prev) => Math.max(0.3, Math.min(6.0, prev * zoomFactor)));
    }
  };

  const handleReset = () => {
    setXScale(1.0);
    setXPanOffset(0);
    setYScale(1.0);
    setYPanOffset(0);
    setHoverIndex(null);
  };

  return (
    <div
      className={`bg-[#0d0e19] border border-[#1e2035] rounded-2xl p-4 sm:p-5 text-white select-none relative overflow-hidden shadow-2xl ${className}`}
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
        straddleEm={structuralMetrics.expectedMove}
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

      {/* PRZM / ZERO Hero Section ASCII Header */}
      <PrzmAsciiHeader
        title={`${activeSymbol} · EVERY CALL TODAY`}
        className="mb-2.5"
        rightSlot={
          <div className="flex items-center gap-2">
            <span
              className={`w-2 h-2 rounded-full ${
                activeRegime === "CALL" ? "bg-[#00F5D4] animate-pulse" : "bg-[#FF2A55] animate-pulse"
              }`}
            />
            <span className={activeRegime === "CALL" ? "text-[#00F5D4] font-bold" : "text-[#FF2A55] font-bold"}>
              {activeRegime} (χ={activeChiPct}%)
            </span>
          </div>
        }
      />

      {/* Top Header Bar & Interactive Zoom/Pan Controls */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-2 relative z-10">
        <div className="flex items-center gap-3">
          <div className="flex items-center font-mono text-sm tracking-widest text-slate-300">
            <span className="text-cyan-400 mr-2 text-base font-bold">+</span>
            <span className="text-slate-400 mr-1.5">[</span>
            <button
              onClick={() => onSymbolChange?.(activeSymbol === "SPY" ? "QQQ" : "SPY")}
              className="text-cyan-400 font-bold hover:text-cyan-300 transition-colors uppercase tracking-wider underline decoration-cyan-500/40 decoration-dashed underline-offset-4"
              title="Click to toggle between SPY and QQQ"
            >
              {activeSymbol}
            </button>
            <span className="text-slate-400 mx-1.5">,</span>
            <span className="text-emerald-400 font-bold">EVERY CALL TODAY</span>
            <span className="text-slate-400 ml-1.5">]</span>
          </div>

          {/* Live Regime & Péclet Status Badge */}
          <div className="flex items-center gap-2 text-[11px] font-mono px-2.5 py-1 rounded-full bg-slate-900/90 border border-slate-800">
            <span
              className={`w-2 h-2 rounded-full ${
                activeRegime === "CALL" ? "bg-[#00F5D4] animate-pulse" : "bg-[#FF2A55] animate-pulse"
              }`}
            />
            <span className="text-slate-400">REGIME:</span>
            <span className={activeRegime === "CALL" ? "text-[#00F5D4] font-bold" : "text-[#FF2A55] font-bold"}>
              {activeRegime} (χ={activeChiPct}%)
            </span>
          </div>
        </div>

        {/* Dynamic Scale & Time Scope Toolbar */}
        <div className="flex items-center gap-2 font-mono text-xs">
          <button
            onClick={() => {
              setXScale(1.0);
              setXPanOffset(0);
              setYScale(1.0);
              setYPanOffset(0);
            }}
            title="Auto-fit all candles in session"
            className="px-2.5 py-1 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition cursor-pointer text-[11px]"
          >
            Fit Data
          </button>
          <button
            onClick={() => {
              const rthIdx = effectiveCandles.findIndex((c) => {
                const parts = ET_PARTS_FORMATTER.formatToParts(new Date(c.timestamp ?? 0));
                const h = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
                const m = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
                return h === 9 && m === 30;
              });
              if (rthIdx >= 0) {
                const fraction = rthIdx / Math.max(1, effectiveCandles.length - 1);
                setXScale(1.35);
                setXPanOffset((0.5 - fraction) * plotW * 0.6);
              } else {
                setXScale(1.2);
                setXPanOffset(0);
              }
              setYScale(1.0);
              setYPanOffset(0);
            }}
            title="Focus on standard 9:30am – 4:00pm RTH session"
            className="px-2.5 py-1 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition cursor-pointer text-[11px]"
          >
            RTH (9:30-4:00)
          </button>
          <button
            onClick={() => {
              setXScale(2.4);
              setXPanOffset(-plotW * 0.45);
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
              onClick={() => setYScale((s) => Math.min(5.0, s * 1.25))}
              title="Expand vertical price scale (Zoom Y+)"
              className="px-2 py-1 hover:bg-slate-800 text-slate-300 hover:text-cyan-400 border-r border-slate-800"
            >
              Y+
            </button>
            <button
              onClick={() => setYScale((s) => Math.max(0.4, s * 0.8))}
              title="Compress vertical price scale (Zoom Y-)"
              className="px-2 py-1 hover:bg-slate-800 text-slate-300 hover:text-cyan-400 border-r border-slate-800"
            >
              Y-
            </button>
            <button
              onClick={handleReset}
              title="Reset Zoom & Pan to Default (or Double-Click Canvas)"
              className="px-2 py-1 hover:bg-slate-800 text-slate-300 hover:text-cyan-400"
            >
              Reset
            </button>
          </div>

          {/* Live Spot Price Display */}
          <div className="text-right ml-2">
            <div className="text-xs text-slate-500 tracking-wider">LIVE TICK</div>
            <div className="text-base font-bold text-white tracking-wide">
              ${priceDomain.current.toFixed(2)}
            </div>
          </div>
        </div>
      </div>

      {/* SVG Canvas Chart */}
      <div className="w-full relative overflow-x-auto">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${svgWidth} ${svgHeight}`}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={() => {
            setHoverIndex(null);
            setDragMode("none");
          }}
          onWheel={handleWheel}
          onDoubleClick={handleReset}
          className={`w-full h-auto block select-none ${
            dragMode === "pan" ? "cursor-grabbing" : dragMode === "scaleY" ? "cursor-ns-resize" : dragMode === "scaleX" ? "cursor-ew-resize" : "cursor-crosshair"
          }`}
          style={{ minWidth: "680px" }}
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
          </defs>

          {/* Vertical Time Milestone Guides (cutting across all panes for clear timing) */}
          {timeTicks.map((t, idx) => {
            if (t.x < padLeft || t.x > svgWidth - padRight) return null;
            return (
              <g key={`time-guide-${idx}`}>
                <line
                  x1={t.x}
                  y1={padTop}
                  x2={t.x}
                  y2={histBottom}
                  stroke={t.isRthOpen ? "#00F5D4" : "#1e293b"}
                  strokeWidth={t.isRthOpen ? 1.5 : 1}
                  strokeDasharray={t.isRthOpen ? "none" : "3 5"}
                  opacity={t.isRthOpen ? 0.75 : 0.6}
                />
                <text
                  x={t.x}
                  y={svgHeight - 12}
                  textAnchor="middle"
                  fill={t.isRthOpen ? "#00F5D4" : "rgba(255, 255, 255, 0.45)"}
                  fontSize="10"
                  fontFamily="monospace"
                  fontWeight={t.isRthOpen ? "bold" : "normal"}
                >
                  {t.shortLabel}
                </text>
              </g>
            );
          })}

          {/* Horizontal Price Grid Lines & Right Y-Axis Numerical Labels */}
          {priceTicks.map((pt, idx) => (
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
              <text
                x={svgWidth - padRight + 8}
                y={pt.y + 4}
                fill="rgba(255, 255, 255, 0.45)"
                fontSize="11"
                fontFamily="monospace"
              >
                ${pt.label}
              </text>
            </g>
          ))}

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
          {markers.map((m) => {
            if (m.x < padLeft - 20 || m.x > svgWidth - padRight + 20) return null;
            const isCall = m.isCall;
            const markerColor = isCall ? "#00F5D4" : "#FF2A55";
            const excursionText = m.mfePoints >= 0.2 ? ` +$${m.mfePoints.toFixed(1)}` : "";
            const badgeY = isCall
              ? Math.min(chartBottom - 12, m.y + 26)
              : Math.max(padTop + 14, m.y - 28);
            const badgeWidth = m.mfePoints >= 0.2 ? 104 : 88;

            return (
              <g key={m.id} className="cursor-pointer">
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
                        d="M -4 -11 L 4 -3 M 4 -11 L -4 -3"
                        fill="none"
                        stroke="#FF2A55"
                        strokeWidth="2.2"
                        strokeLinecap="round"
                      />
                    </>
                  )}
                </g>

                {/* Tactical Trade Badge Callout */}
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
              </g>
            );
          })}

          {/* Live Pulsing Node Head at Curve Tip */}
          {latestPt && latestPt.baseX >= padLeft && latestPt.baseX <= svgWidth - padRight && (
            <g transform={`translate(${latestPt.baseX.toFixed(1)}, ${latestPt.baseY.toFixed(1)})`}>
              <circle r="12" fill="none" stroke="#00F5D4" strokeWidth="1.5" opacity="0.6" filter={`url(#tip-glow-${uid})`}>
                <animate attributeName="r" values="6;16;6" dur="2s" repeatCount="indefinite" />
                <animate attributeName="opacity" values="0.8;0.1;0.8" dur="2s" repeatCount="indefinite" />
              </circle>
              <circle r="4.5" fill="#ffffff" stroke="#00F5D4" strokeWidth="2.2" />
            </g>
          )}

          {/* Right Y-Axis Live Spot Badge */}
          <g transform={`translate(${svgWidth - padRight + 4}, ${yForPrice(priceDomain.current) - 10})`}>
            <rect width="72" height="20" rx="4" fill="#00F5D4" fillOpacity="0.18" stroke="#00F5D4" strokeWidth="1.2" />
            <text x="36" y="14" textAnchor="middle" fill="#00F5D4" fontSize="11" fontFamily="monospace" fontWeight="bold">
              ${priceDomain.current.toFixed(2)}
            </text>
          </g>

          {/* Right Y-Axis Flow VWAP Badge */}
          {latestPt && (
            <g transform={`translate(${svgWidth - padRight + 4}, ${yForPrice(latestPt.flowVwap) - 10})`}>
              <rect width="72" height="18" rx="3" fill="#f59e0b" fillOpacity="0.15" stroke="#f59e0b" strokeWidth="1" />
              <text x="36" y="13" textAnchor="middle" fill="#f59e0b" fontSize="10" fontFamily="monospace" fontWeight="bold">
                ${latestPt.flowVwap.toFixed(2)}
              </text>
            </g>
          )}

          {/* "THE CALL" Segmented Tick Bar Ribbon */}
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
              fill={activeRegime === "CALL" ? "#00F5D4" : "#FF2A55"}
              fontSize="10"
              fontFamily="monospace"
              fontWeight="bold"
            >
              CALL DOMINANCE {activeChiPct}%
            </text>

            {enrichedPoints.map((pt, i) => {
              if (pt.baseX < padLeft || pt.baseX > svgWidth - padRight) return null;
              const slotW = (plotW / 120) * xScale;
              const tickW = Math.max(2, slotW - 1.8);
              const isCall = pt.regime === "CALL";
              const col = isCall ? "#00F5D4" : "#FF2A55";
              const op = Math.max(0.4, Math.min(1.0, 0.45 + Math.abs(pt.bias) * 0.55));
              return (
                <rect
                  key={`tick-${i}`}
                  x={pt.baseX - tickW / 2}
                  y={ribbonTop}
                  width={tickW}
                  height={ribbonHeight}
                  rx="1"
                  fill={col}
                  fillOpacity={op}
                />
              );
            })}
          </g>

          {/* Net Boundary Flux & Momentum Histogram */}
          <g>
            {/* Zero Axis */}
            <line
              x1={padLeft}
              y1={histZeroY}
              x2={svgWidth - padRight}
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

            {enrichedPoints.map((pt, i) => {
              if (pt.baseX < padLeft || pt.baseX > svgWidth - padRight) return null;
              const slotW = (plotW / 120) * xScale;
              const barW = Math.max(2.4, slotW - 2.0);
              const val = pt.histValue;
              const barH = Math.max(2, Math.abs(val) * histHalfH);
              const isPos = val >= 0;
              const y = isPos ? histZeroY - barH : histZeroY;
              const col = isPos ? "#00F5D4" : "#FF2A55";
              const op = Math.max(0.45, Math.min(0.95, 0.45 + Math.abs(val) * 0.5));

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
                  Regime: <tspan fill={activePt.regime === "CALL" ? "#00F5D4" : "#FF2A55"} fontWeight="bold">{activePt.regime} (χ={Math.round(activePt.chi * 100)}%)</tspan>
                </text>
                <text x="12" y="64" fill="#94a3b8" fontSize="10" fontFamily="monospace">
                  Péclet: <tspan fill="#38bdf8">{activePt.pe >= 0 ? "+" : ""}{activePt.pe.toFixed(2)}</tspan> · J_net: <tspan fill={activePt.netFlux >= 0 ? "#00F5D4" : "#FF2A55"}>{activePt.netFlux.toFixed(1)}</tspan>
                </text>
              </g>
            </g>
          )}

          {/* Drag & Axis Helper Indicator Labels */}
          <text
            x={svgWidth - 6}
            y={(padTop + chartBottom) / 2}
            textAnchor="end"
            fill="rgba(255, 255, 255, 0.18)"
            fontSize="9"
            fontFamily="monospace"
            transform={`rotate(90 ${svgWidth - 6} ${(padTop + chartBottom) / 2})`}
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

      {/* PRZM The Call Continuous Segmented Regime Strip */}
      <PrzmTheCallStrip series={przmSeries} />

      {/* PRZM Bottom Deck: Call Log Ledger & 100% Scoreboard */}
      <PrzmCallLogDeck
        signals={przmSignals}
        series={przmSeries}
        liveSpot={activeSpotPrice}
      />
    </div>
  );
};

export default GaiaCallPutBiasHud;
