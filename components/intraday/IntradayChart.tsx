"use client";

import React, { useState, useMemo, useRef, useEffect } from "react";
import { IntradayPoint, useDashboardStore } from "@/store/useDashboardStore";
import { computeCeilingShareChi } from "@/lib/flowGammaVwap";

interface IntradayChartProps {
  points?: IntradayPoint[];
  height?: number;
  selectedExpiration?: string | null;
}

type ScaleMode = "focus" | "full";

interface RightBadgeItem {
  id: string;
  label: string;
  price: number;
  idealY: number;
  y: number;
  color: string;
  bgFill: string;
  borderColor: string;
  isPrimary?: boolean;
}

/**
 * 3-Sample Causal Median Filter:
 * Eliminates 1-tick bimodal wall oscillation (e.g. 765 -> 750 -> 765 square-wave teeth)
 * while preserving genuine structural wall migrations (>= 2 consecutive samples).
 */
function medianSmoothSeries(values: (number | undefined | null)[]): number[] {
  const n = values.length;
  if (n === 0) return [];
  const clean: number[] = [];
  let lastValid = values.find((v) => typeof v === "number" && Number.isFinite(v) && v > 0) ?? 0;

  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) {
      lastValid = v;
    }
    clean.push(lastValid);
  }

  if (n < 3) return clean;
  const smoothed = new Array<number>(n);
  smoothed[0] = clean[0];
  for (let i = 1; i < n - 1; i++) {
    const a = clean[i - 1];
    const b = clean[i];
    const c = clean[i + 1];
    smoothed[i] = a + b + c - Math.min(a, b, c) - Math.max(a, b, c);
  }
  smoothed[n - 1] = smoothed[n - 2];
  return smoothed;
}

/**
 * Single-pass greedy vertical label de-collision solver.
 * Guarantees right-axis badges never overlap inside [minY, maxY].
 */
function decollideLabels(
  items: RightBadgeItem[],
  minY: number,
  maxY: number,
  minGap: number = 22
): RightBadgeItem[] {
  if (items.length === 0) return [];
  const sorted = [...items].sort((a, b) => a.idealY - b.idealY);

  // Forward pass: push down overlapping items
  sorted[0].y = Math.max(minY, Math.min(maxY, sorted[0].idealY));
  for (let i = 1; i < sorted.length; i++) {
    const prevY = sorted[i - 1].y;
    sorted[i].y = Math.max(sorted[i].idealY, prevY + minGap);
  }

  // Backward pass: if bottom item overflowed maxY, pull upward
  if (sorted[sorted.length - 1].y > maxY) {
    sorted[sorted.length - 1].y = maxY;
    for (let i = sorted.length - 2; i >= 0; i--) {
      sorted[i].y = Math.min(sorted[i].y, sorted[i + 1].y - minGap);
    }
  }

  // Final clamp safety
  for (let i = 0; i < sorted.length; i++) {
    sorted[i].y = Math.max(minY, Math.min(maxY, sorted[i].y));
  }

  return sorted;
}

export function IntradayChart({
  points: propPoints,
  height = 210,
  selectedExpiration,
}: IntradayChartProps) {
  const storePoints = useDashboardStore((s) => s.intradayData);
  const gammaLevels = useDashboardStore((s) => s.gammaLevels);
  const flowGammaVwapData = useDashboardStore((s) => s.flowGammaVwapData);

  const [scaleMode, setScaleMode] = useState<ScaleMode>("focus");
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState<number>(1060);

  // 1:1 Responsive width observer so SVG fills 100% of container with zero lateral gray space
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const updateWidth = () => {
      const w = el.clientWidth;
      if (w && w > 240) {
        setContainerWidth(Math.round(w));
      }
    };

    updateWidth();

    const observer = new ResizeObserver(() => {
      updateWidth();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const rawPoints = propPoints ?? storePoints ?? [];
  const sigma = flowGammaVwapData?.sigma ?? 0;

  const displayData = useMemo(() => {
    if (!rawPoints || rawPoints.length === 0) return [];
    const valid = rawPoints.filter(
      (d) => typeof d.spot === "number" && Number.isFinite(d.spot) && d.spot > 0
    );
    return valid.map((d) => {
      const fw = d.flowVwap ?? flowGammaVwapData?.flowVwap;
      const u1 = d.upper1s ?? (fw && sigma > 0 ? Number((fw + sigma).toFixed(2)) : undefined);
      const l1 = d.lower1s ?? (fw && sigma > 0 ? Number((fw - sigma).toFixed(2)) : undefined);
      const u2 = d.upper2s ?? (fw && sigma > 0 ? Number((fw + 2 * sigma).toFixed(2)) : undefined);
      const l2 = d.lower2s ?? (fw && sigma > 0 ? Number((fw - 2 * sigma).toFixed(2)) : undefined);
      return {
        ...d,
        flowVwap: fw,
        upper1s: u1,
        lower1s: l1,
        upper2s: u2,
        lower2s: l2,
      };
    });
  }, [rawPoints, flowGammaVwapData?.flowVwap, sigma]);

  const stabilizedSeries = useMemo(() => {
    if (displayData.length < 2) return null;
    const callWalls = medianSmoothSeries(displayData.map((d) => d.callWall));
    const putWalls = medianSmoothSeries(displayData.map((d) => d.putWall));
    const zeroGammas = medianSmoothSeries(displayData.map((d) => d.zeroGamma));
    return { callWalls, putWalls, zeroGammas };
  }, [displayData]);

  const chartModel = useMemo(() => {
    if (!displayData || displayData.length < 2 || !stabilizedSeries) return null;

    const spots = displayData.map((d) => d.spot).filter((v) => Number.isFinite(v) && v > 0);
    if (spots.length === 0) return null;

    const vwaps = displayData
      .map((d) => d.flowVwap)
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0);
    const upper1s = displayData
      .map((d) => d.upper1s)
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0);
    const lower1s = displayData
      .map((d) => d.lower1s)
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0);

    const lastIdx = displayData.length - 1;
    const latestSpot = displayData[lastIdx].spot;
    const latestVwap = displayData[lastIdx].flowVwap;
    const latestCallWall = gammaLevels?.callWall || stabilizedSeries.callWalls[lastIdx] || 0;
    const latestPutWall = gammaLevels?.putWall || stabilizedSeries.putWalls[lastIdx] || 0;
    const latestZeroGamma = gammaLevels?.zeroGamma || stabilizedSeries.zeroGammas[lastIdx] || 0;

    // 1. Compute Core Price-Action Domain (Spot + Flow VWAP + ±1sigma envelope)
    const coreValues = [...spots, ...vwaps, ...upper1s, ...lower1s];
    const coreMin = Math.min(...coreValues);
    const coreMax = Math.max(...coreValues);
    const minCoreSpan = Math.max(latestSpot * 0.0022, 1.2); // Minimum 0.22% or $1.20 span
    const rawCoreSpan = Math.max(coreMax - coreMin, minCoreSpan);

    let yMin: number;
    let yMax: number;

    if (scaleMode === "focus") {
      // Price-First Adaptive Scaling:
      // Frame Spot, Flow VWAP, and ±1s bands comfortably.
      // Pull in any structural level that lies within 1.65x of the core span.
      const proximityThreshold = rawCoreSpan * 1.65;
      const nearbyWalls = [latestCallWall, latestPutWall, latestZeroGamma].filter(
        (w) => w > 0 && Math.abs(w - latestSpot) <= proximityThreshold
      );

      const focusPool = [...coreValues, ...nearbyWalls];
      const fMin = Math.min(...focusPool);
      const fMax = Math.max(...focusPool);
      const fSpan = Math.max(fMax - fMin, minCoreSpan);
      const fMid = (fMin + fMax) / 2;
      const paddedHalf = (fSpan * 1.26) / 2;

      yMin = fMid - paddedHalf;
      yMax = fMid + paddedHalf;
    } else {
      // Full Macro Range: include all structural walls
      const allPool = [
        ...coreValues,
        ...stabilizedSeries.callWalls.filter((w) => w > 0),
        ...stabilizedSeries.putWalls.filter((w) => w > 0),
        ...stabilizedSeries.zeroGammas.filter((w) => w > 0),
        latestCallWall,
        latestPutWall,
        latestZeroGamma,
      ].filter((v) => v > 0);
      const aMin = Math.min(...allPool);
      const aMax = Math.max(...allPool);
      const aSpan = Math.max(aMax - aMin, minCoreSpan);
      const pad = aSpan * 0.1;
      yMin = aMin - pad;
      yMax = aMax + pad;
    }

    return {
      yMin,
      yMax,
      yRange: Math.max(yMax - yMin, 0.01),
      latestSpot,
      latestVwap,
      latestCallWall,
      latestPutWall,
      latestZeroGamma,
    };
  }, [displayData, stabilizedSeries, scaleMode, gammaLevels]);

  if (!displayData || displayData.length < 2 || !chartModel || !stabilizedSeries) {
    return (
      <div
        ref={containerRef}
        className="w-full argon-card rounded-xl p-4 mb-3 flex items-center justify-between"
      >
        <div className="flex items-center gap-2.5">
          <span className="h-2 w-2 rounded-full bg-cyan-400 animate-pulse" />
          <span className="text-xs font-mono uppercase tracking-wider text-slate-300 font-semibold">
            Intraday Price &amp; Flow VWAP
          </span>
        </div>
        <span className="text-xs text-slate-400 font-mono">
          Collecting intraday telemetry ({displayData?.length || 0}/2 pts)...
        </span>
      </div>
    );
  }

  const svgW = containerWidth;
  const svgH = height;
  const padL = 54;
  const padR = 138;
  const padT = 18;
  const padB = 26;
  const innerW = Math.max(120, svgW - padL - padR);
  const innerH = Math.max(80, svgH - padT - padB);

  const {
    yMin,
    yMax,
    yRange,
    latestSpot,
    latestVwap,
    latestCallWall,
    latestPutWall,
    latestZeroGamma,
  } = chartModel;

  const toX = (i: number) => padL + (i / (displayData.length - 1)) * innerW;
  const toY = (val: number) => padT + innerH - ((val - yMin) / yRange) * innerH;
  const isInViewport = (val: number) => val >= yMin && val <= yMax;

  // Build SVG points for Spot and Flow VWAP
  const spotPoints = displayData.map((d, i) => `${toX(i).toFixed(1)},${toY(d.spot).toFixed(1)}`).join(" ");
  const spotAreaPoints = `${toX(0).toFixed(1)},${(padT + innerH).toFixed(1)} ${spotPoints} ${toX(
    displayData.length - 1
  ).toFixed(1)},${(padT + innerH).toFixed(1)}`;

  const hasFlowVwap = displayData.some((d) => typeof d.flowVwap === "number" && d.flowVwap > 0);
  const vwapPoints = hasFlowVwap
    ? displayData
        .map((d, i) =>
          typeof d.flowVwap === "number" && d.flowVwap > 0
            ? `${toX(i).toFixed(1)},${toY(d.flowVwap).toFixed(1)}`
            : null
        )
        .filter(Boolean)
        .join(" ")
    : "";

  // ±1 Sigma & ±2 Sigma Volatility Envelope Polygons
  const hasBands = displayData.some(
    (d) => typeof d.upper1s === "number" && typeof d.lower1s === "number"
  );
  const bandPolygon = hasBands
    ? [
        ...displayData.map((d, i) =>
          typeof d.upper1s === "number"
            ? `${toX(i).toFixed(1)},${Math.max(padT, Math.min(padT + innerH, toY(d.upper1s))).toFixed(1)}`
            : null
        ),
        ...displayData
          .slice()
          .reverse()
          .map((d, idx) => {
            const i = displayData.length - 1 - idx;
            return typeof d.lower1s === "number"
              ? `${toX(i).toFixed(1)},${Math.max(padT, Math.min(padT + innerH, toY(d.lower1s))).toFixed(1)}`
              : null;
          }),
      ]
        .filter(Boolean)
        .join(" ")
    : "";

  const upper2Points = hasBands
    ? displayData
        .map((d, i) =>
          typeof d.upper2s === "number"
            ? `${toX(i).toFixed(1)},${Math.max(padT, Math.min(padT + innerH, toY(d.upper2s))).toFixed(1)}`
            : null
        )
        .filter(Boolean)
        .join(" ")
    : "";

  const lower2Points = hasBands
    ? displayData
        .map((d, i) =>
          typeof d.lower2s === "number"
            ? `${toX(i).toFixed(1)},${Math.max(padT, Math.min(padT + innerH, toY(d.lower2s))).toFixed(1)}`
            : null
        )
        .filter(Boolean)
        .join(" ")
    : "";

  // Flux Field PDE Péclet number & Ceiling Share chi
  const corridorWidth = Math.max(1.0, Math.abs(latestCallWall - latestPutWall) || yRange);
  const driftEst =
    displayData.length >= 2
      ? (displayData[displayData.length - 1].spot - displayData[0].spot) /
        Math.max(1, displayData.length)
      : 0;
  const gammaDiffEst = Math.max(0.05, (corridorWidth * corridorWidth) / 140);
  const pecletNumber = Number(
    Math.max(-15, Math.min(15, (driftEst * 2.5 * corridorWidth) / gammaDiffEst)).toFixed(2)
  );
  const ceilingShareChi = computeCeilingShareChi(pecletNumber);
  const nodeMidpoint =
    latestCallWall > 0 && latestPutWall > 0
      ? Number(((latestCallWall + latestPutWall) / 2).toFixed(2))
      : 0;

  // Check if a wall shifted during the session and remains visible
  const buildWallTrace = (series: number[]) => {
    const valid = series.filter((v) => v > 0);
    if (valid.length === 0) return { points: "", shifted: false };
    const uniqueCount = new Set(valid.map((v) => v.toFixed(1))).size;
    const allInside = valid.every((v) => isInViewport(v));
    if (uniqueCount <= 1 || !allInside) return { points: "", shifted: false };
    const pts = series
      .map((v, i) => (v > 0 ? `${toX(i).toFixed(1)},${toY(v).toFixed(1)}` : null))
      .filter(Boolean)
      .join(" ");
    return { points: pts, shifted: true };
  };

  const callWallTrace = buildWallTrace(stabilizedSeries.callWalls);
  const putWallTrace = buildWallTrace(stabilizedSeries.putWalls);

  // Assemble Right-Axis Badges for visible levels & de-collide
  const rawBadges: RightBadgeItem[] = [
    {
      id: "spot",
      label: `SPOT ${latestSpot.toFixed(2)}`,
      price: latestSpot,
      idealY: toY(latestSpot),
      y: toY(latestSpot),
      color: "#f8fafc",
      bgFill: "#0284c7",
      borderColor: "#38bdf8",
      isPrimary: true,
    },
  ];

  if (typeof latestVwap === "number" && latestVwap > 0 && isInViewport(latestVwap)) {
    rawBadges.push({
      id: "vwap",
      label: `VWAP ${latestVwap.toFixed(2)}`,
      price: latestVwap,
      idealY: toY(latestVwap),
      y: toY(latestVwap),
      color: "#fde68a",
      bgFill: "#451a03",
      borderColor: "#f59e0b",
    });
  }

  if (latestCallWall > 0 && isInViewport(latestCallWall)) {
    rawBadges.push({
      id: "call",
      label: `CALL ${latestCallWall.toFixed(1)}`,
      price: latestCallWall,
      idealY: toY(latestCallWall),
      y: toY(latestCallWall),
      color: "#5eead4",
      bgFill: "#042f2e",
      borderColor: "#14b8a6",
    });
  }

  if (latestPutWall > 0 && isInViewport(latestPutWall)) {
    rawBadges.push({
      id: "put",
      label: `PUT ${latestPutWall.toFixed(1)}`,
      price: latestPutWall,
      idealY: toY(latestPutWall),
      y: toY(latestPutWall),
      color: "#f0abfc",
      bgFill: "#3b0764",
      borderColor: "#d946ef",
    });
  }

  if (latestZeroGamma > 0 && isInViewport(latestZeroGamma)) {
    rawBadges.push({
      id: "zg",
      label: `0G ${latestZeroGamma.toFixed(1)}`,
      price: latestZeroGamma,
      idealY: toY(latestZeroGamma),
      y: toY(latestZeroGamma),
      color: "#fdba74",
      bgFill: "#431407",
      borderColor: "#f97316",
    });
  }

  const rightBadges = decollideLabels(rawBadges, padT + 10, padT + innerH - 10, 22);

  // Left Y-Axis ticks (5 levels for enlarged height)
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((pct) => {
    const val = yMin + pct * yRange;
    return { val, y: toY(val) };
  });

  // Dynamic X-Axis Time Labels based on container width
  const numTimeTicks = svgW >= 850 ? 6 : 4;
  const timeIndices = Array.from({ length: numTimeTicks }, (_, idx) =>
    Math.round((idx / (numTimeTicks - 1)) * (displayData.length - 1))
  ).filter((v, i, a) => a.indexOf(v) === i);

  // Active point for hover crosshair or latest state
  const activeIdx = hoverIdx !== null && hoverIdx < displayData.length ? hoverIdx : displayData.length - 1;
  const activePt = displayData[activeIdx];
  const activeCall = stabilizedSeries.callWalls[activeIdx] || latestCallWall;
  const activePut = stabilizedSeries.putWalls[activeIdx] || latestPutWall;
  const activeZG = stabilizedSeries.zeroGammas[activeIdx] || latestZeroGamma;
  const vwapDelta =
    typeof activePt.flowVwap === "number" && activePt.flowVwap > 0
      ? activePt.spot - activePt.flowVwap
      : null;

  const formatDist = (level: number) => {
    if (!level || level <= 0) return "—";
    const diff = level - activePt.spot;
    return `${diff >= 0 ? "+" : ""}${diff.toFixed(1)}`;
  };

  return (
    <div
      ref={containerRef}
      className="w-full argon-card rounded-xl px-4 py-3.5 mb-3 select-none"
    >
      {/* Top Header: Title, Live Telemetry Pill Strip, and Viewport Mode Toggle */}
      <div className="flex flex-wrap items-center justify-between gap-2.5 mb-2.5">
        <div className="flex items-center gap-2.5">
          <span className="h-2 w-2 rounded-full bg-sky-400 shadow-[0_0_8px_#38bdf8]" />
          <span className="text-xs font-mono uppercase tracking-wider text-slate-100 font-bold">
            Intraday Price &amp; Flow VWAP
          </span>
          {selectedExpiration && (
            <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-teal-500/15 text-teal-300 border border-teal-500/30">
              {selectedExpiration}
            </span>
          )}
          {hoverIdx !== null && (
            <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-slate-800 text-sky-300 border border-sky-500/30">
              {activePt.time}
            </span>
          )}
        </div>

        {/* Structural Level Status Pills (Always visible even when off-chart in Focus Mode) */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-slate-900/95 border border-slate-800 text-[11px] font-mono">
            <span className="text-slate-400">SPOT</span>
            <span className="text-white font-bold">${activePt.spot.toFixed(2)}</span>
            {vwapDelta !== null && (
              <span
                className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${
                  vwapDelta >= 0
                    ? "bg-emerald-500/15 text-emerald-300"
                    : "bg-rose-500/15 text-rose-300"
                }`}
              >
                {vwapDelta >= 0 ? "+" : ""}
                {vwapDelta.toFixed(2)} vs VWAP
              </span>
            )}
          </div>

          {activeCall > 0 && (
            <div
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[11px] font-mono transition-opacity ${
                isInViewport(activeCall)
                  ? "bg-teal-950/40 border-teal-500/40 text-teal-200"
                  : "bg-slate-900/70 border-slate-800 text-slate-300"
              }`}
              title={
                isInViewport(activeCall)
                  ? "Call Wall visible on chart"
                  : "Call Wall outside focus band (switch to All Levels to view on axis)"
              }
            >
              <span className="h-2 w-2 rounded-full bg-teal-400" />
              <span className="text-slate-400">CALL</span>
              <span className="font-semibold text-teal-300">{activeCall.toFixed(0)}</span>
              <span className="text-[10px] text-slate-400">({formatDist(activeCall)})</span>
              {!isInViewport(activeCall) && (
                <span className="text-[10px] text-teal-400 font-bold">▲</span>
              )}
            </div>
          )}

          {activePut > 0 && (
            <div
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[11px] font-mono transition-opacity ${
                isInViewport(activePut)
                  ? "bg-fuchsia-950/40 border-fuchsia-500/40 text-fuchsia-200"
                  : "bg-slate-900/70 border-slate-800 text-slate-300"
              }`}
              title={
                isInViewport(activePut)
                  ? "Put Wall visible on chart"
                  : "Put Wall outside focus band (switch to All Levels to view on axis)"
              }
            >
              <span className="h-2 w-2 rounded-full bg-fuchsia-400" />
              <span className="text-slate-400">PUT</span>
              <span className="font-semibold text-fuchsia-300">{activePut.toFixed(0)}</span>
              <span className="text-[10px] text-slate-400">({formatDist(activePut)})</span>
              {!isInViewport(activePut) && (
                <span className="text-[10px] text-fuchsia-400 font-bold">▼</span>
              )}
            </div>
          )}

          {activeZG > 0 && (
            <div
              className={`hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[11px] font-mono ${
                isInViewport(activeZG)
                  ? "bg-orange-950/40 border-orange-500/40 text-orange-200"
                  : "bg-slate-900/70 border-slate-800 text-slate-300"
              }`}
            >
              <span className="h-2 w-2 rounded-full bg-orange-400" />
              <span className="text-slate-400">0γ</span>
              <span className="font-semibold text-orange-300">{activeZG.toFixed(0)}</span>
              <span className="text-[10px] text-slate-400">({formatDist(activeZG)})</span>
            </div>
          )}

          {/* Flux Field PDE Telemetry Badge (Ceiling Share Chi & Péclet Drift) */}
          <div
            className="hidden md:flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-amber-950/35 border border-amber-500/35 text-[11px] font-mono text-amber-200"
            title="Flux Field PDE Ceiling Share χ(Pe) and Péclet Drift Number Pe = μ_Δ W / Γ"
          >
            <span className="text-amber-400 font-bold">FLUX χ</span>
            <span className="font-semibold text-white">
              {(ceilingShareChi * 100).toFixed(0)}%
            </span>
            <span className="text-[10px] text-amber-300/80">
              (Pe {pecletNumber >= 0 ? "+" : ""}
              {pecletNumber.toFixed(1)})
            </span>
          </div>

          {/* Viewport Scale Mode Toggle: Price Focus vs Full Range */}
          <div className="flex items-center bg-slate-900 border border-slate-800 rounded-lg p-0.5 ml-1">
            <button
              type="button"
              onClick={() => setScaleMode("focus")}
              className={`px-2.5 py-1 rounded-md text-[11px] font-mono uppercase tracking-wider transition-all cursor-pointer ${
                scaleMode === "focus"
                  ? "bg-sky-500/20 text-sky-300 border border-sky-500/40 font-semibold shadow-sm"
                  : "text-slate-400 hover:text-slate-200 border border-transparent"
              }`}
              title="Zoom Y-axis to intraday Spot, Flow VWAP & ±1 Sigma action"
            >
              Price Focus
            </button>
            <button
              type="button"
              onClick={() => setScaleMode("full")}
              className={`px-2.5 py-1 rounded-md text-[11px] font-mono uppercase tracking-wider transition-all cursor-pointer ${
                scaleMode === "full"
                  ? "bg-sky-500/20 text-sky-300 border border-sky-500/40 font-semibold shadow-sm"
                  : "text-slate-400 hover:text-slate-200 border border-transparent"
              }`}
              title="Fit all distant Call/Put walls inside Y-axis"
            >
              All Levels
            </button>
          </div>
        </div>
      </div>

      {/* Main Responsive 1:1 Pixel-Exact SVG Canvas */}
      <div className="relative w-full select-none">
        <svg
          viewBox={`0 0 ${svgW} ${svgH}`}
          style={{ width: "100%", height: `${svgH}px` }}
          className="block w-full overflow-visible cursor-crosshair"
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const relX = e.clientX - rect.left;
            const plotLeft = padL;
            const plotWidth = innerW;
            const ratio = Math.max(0, Math.min(1, (relX - plotLeft) / Math.max(1, plotWidth)));
            const idx = Math.round(ratio * (displayData.length - 1));
            setHoverIdx(idx);
          }}
          onMouseLeave={() => setHoverIdx(null)}
        >
          <defs>
            <linearGradient id="intradaySpotGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.26" />
              <stop offset="75%" stopColor="#38bdf8" stopOpacity="0.05" />
              <stop offset="100%" stopColor="#38bdf8" stopOpacity="0.0" />
            </linearGradient>
            <clipPath id="intradayPlotClip">
              <rect x={padL} y={padT} width={innerW} height={innerH} rx="3" />
            </clipPath>
          </defs>

          {/* Subtle Plot Background */}
          <rect
            x={padL}
            y={padT}
            width={innerW}
            height={innerH}
            fill="#090d16"
            rx="4"
            stroke="#1e293b"
            strokeWidth="1"
          />

          {/* Horizontal Price Grid Lines & Left Y-Axis Labels */}
          {yTicks.map((t, i) => (
            <g key={i}>
              <line
                x1={padL}
                x2={padL + innerW}
                y1={t.y}
                y2={t.y}
                stroke="#1e293b"
                strokeDasharray={i === 0 || i === yTicks.length - 1 ? "none" : "3,3"}
                strokeWidth="1"
              />
              <text
                x={padL - 8}
                y={t.y + 3.5}
                textAnchor="end"
                fontSize="10.5"
                fill="#94a3b8"
                fontFamily="monospace"
                fontWeight="500"
              >
                {t.val.toFixed(1)}
              </text>
            </g>
          ))}

          {/* Clipped Plot Area so off-scale walls never overflow */}
          <g clipPath="url(#intradayPlotClip)">
            {/* ±1 Sigma Dealer Flow VWAP Shaded Band */}
            {bandPolygon && (
              <polygon
                points={bandPolygon}
                fill="#f59e0b"
                fillOpacity="0.09"
                stroke="#f59e0b"
                strokeOpacity="0.32"
                strokeWidth="0.9"
                strokeDasharray="2,2.5"
              />
            )}

            {/* ±2 Sigma Outer Dispersion Dotted Bands */}
            {upper2Points && (
              <polyline
                fill="none"
                stroke="#cbd5e1"
                strokeOpacity="0.45"
                strokeWidth="1.0"
                strokeDasharray="2,2.5"
                points={upper2Points}
              />
            )}
            {lower2Points && (
              <polyline
                fill="none"
                stroke="#cbd5e1"
                strokeOpacity="0.45"
                strokeWidth="1.0"
                strokeDasharray="2,2.5"
                points={lower2Points}
              />
            )}

            {/* Equilibrium Midpoint Ray (lim_{t->inf} VWAP_flow = P/2) */}
            {nodeMidpoint > 0 && isInViewport(nodeMidpoint) && (
              <line
                x1={padL}
                x2={padL + innerW}
                y1={toY(nodeMidpoint)}
                y2={toY(nodeMidpoint)}
                stroke="#e2e8f0"
                strokeWidth="1.0"
                strokeDasharray="1.5,2.5"
                strokeOpacity="0.45"
              />
            )}

            {/* Historical Wall Step Traces (only if wall genuinely migrated in-bounds) */}
            {callWallTrace.shifted && (
              <polyline
                fill="none"
                stroke="#14b8a6"
                strokeWidth="1.3"
                strokeOpacity="0.38"
                strokeDasharray="3,3"
                points={callWallTrace.points}
              />
            )}
            {putWallTrace.shifted && (
              <polyline
                fill="none"
                stroke="#d946ef"
                strokeWidth="1.3"
                strokeOpacity="0.38"
                strokeDasharray="3,3"
                points={putWallTrace.points}
              />
            )}

            {/* Clean Horizontal Structural Reference Rays for Active Session Levels */}
            {latestZeroGamma > 0 && isInViewport(latestZeroGamma) && (
              <line
                x1={padL}
                x2={padL + innerW}
                y1={toY(latestZeroGamma)}
                y2={toY(latestZeroGamma)}
                stroke="#f97316"
                strokeWidth="1.4"
                strokeDasharray="5,4"
                strokeOpacity="0.8"
              />
            )}

            {latestCallWall > 0 && isInViewport(latestCallWall) && (
              <line
                x1={padL}
                x2={padL + innerW}
                y1={toY(latestCallWall)}
                y2={toY(latestCallWall)}
                stroke="#14b8a6"
                strokeWidth="1.6"
                strokeDasharray="6,3"
                strokeOpacity="0.9"
              />
            )}

            {latestPutWall > 0 && isInViewport(latestPutWall) && (
              <line
                x1={padL}
                x2={padL + innerW}
                y1={toY(latestPutWall)}
                y2={toY(latestPutWall)}
                stroke="#d946ef"
                strokeWidth="1.6"
                strokeDasharray="6,3"
                strokeOpacity="0.9"
              />
            )}

            {/* Spot Price Gradient Area & Primary Line */}
            <polygon points={spotAreaPoints} fill="url(#intradaySpotGrad)" />

            {/* Flow Gamma VWAP Curve */}
            {vwapPoints && (
              <polyline
                fill="none"
                stroke="#f59e0b"
                strokeWidth="2.0"
                strokeLinejoin="round"
                strokeLinecap="round"
                points={vwapPoints}
              />
            )}

            {/* Bold Primary Spot Curve */}
            <polyline
              fill="none"
              stroke="#38bdf8"
              strokeWidth="2.5"
              strokeLinejoin="round"
              strokeLinecap="round"
              points={spotPoints}
            />

            {/* Hover Scrub Crosshair */}
            {hoverIdx !== null && (
              <g>
                <line
                  x1={toX(hoverIdx)}
                  x2={toX(hoverIdx)}
                  y1={padT}
                  y2={padT + innerH}
                  stroke="#94a3b8"
                  strokeWidth="1.1"
                  strokeDasharray="3,3"
                />
                <circle
                  cx={toX(hoverIdx)}
                  cy={toY(activePt.spot)}
                  r="4.5"
                  fill="#38bdf8"
                  stroke="#0f172a"
                  strokeWidth="1.8"
                />
                {typeof activePt.flowVwap === "number" && activePt.flowVwap > 0 && (
                  <circle
                    cx={toX(hoverIdx)}
                    cy={toY(activePt.flowVwap)}
                    r="3.5"
                    fill="#f59e0b"
                    stroke="#0f172a"
                    strokeWidth="1.4"
                  />
                )}
              </g>
            )}

            {/* Latest Live Pulse Dot on Spot */}
            <circle
              cx={toX(displayData.length - 1)}
              cy={toY(latestSpot)}
              r="4"
              fill="#38bdf8"
              stroke="#0f172a"
              strokeWidth="1.6"
            />
          </g>

          {/* Right-Gutter De-Collided Level Pills */}
          {rightBadges.map((b) => (
            <g key={b.id}>
              {/* Leader line from plot edge to de-collided badge */}
              <line
                x1={padL + innerW}
                y1={Math.max(padT, Math.min(padT + innerH, b.idealY))}
                x2={padL + innerW + 8}
                y2={b.y}
                stroke={b.borderColor}
                strokeWidth="1.2"
                strokeOpacity="0.75"
              />
              <rect
                x={padL + innerW + 8}
                y={b.y - 10}
                width={padR - 12}
                height={20}
                rx="4"
                fill={b.bgFill}
                stroke={b.borderColor}
                strokeWidth={b.isPrimary ? "1.4" : "1"}
              />
              <text
                x={padL + innerW + 14}
                y={b.y + 3.8}
                fontSize="10.5"
                fontFamily="monospace"
                fontWeight={b.isPrimary ? "700" : "600"}
                fill={b.color}
              >
                {b.label}
              </text>
            </g>
          ))}

          {/* X-Axis Time Labels */}
          {timeIndices.map((idx) => (
            <text
              key={idx}
              x={toX(idx)}
              y={svgH - 6}
              textAnchor="middle"
              fontSize="10.5"
              fill="#94a3b8"
              fontFamily="monospace"
              fontWeight="500"
            >
              {displayData[idx].time}
            </text>
          ))}
        </svg>
      </div>

      {/* Clean Minimalist Legend & Off-Chart Beacon Footer */}
      <div className="flex flex-wrap items-center justify-between gap-2 mt-2 pt-2 border-t border-slate-800/60 text-[11px] font-mono text-slate-400">
        <div className="flex flex-wrap items-center gap-4">
          <span className="inline-flex items-center gap-1.5 text-slate-200">
            <span className="w-3.5 h-0.5 bg-sky-400 inline-block rounded" /> Spot Price
          </span>
          {hasFlowVwap && (
            <span className="inline-flex items-center gap-1.5 text-amber-300/90">
              <span className="w-3.5 h-0.5 bg-amber-400 inline-block rounded" /> Flow VWAP (±1σ Band)
            </span>
          )}
          <span className="inline-flex items-center gap-1.5 text-teal-300/90">
            <span className="w-3.5 h-0 border-t-2 border-dashed border-teal-400 inline-block" /> Call Wall
          </span>
          <span className="inline-flex items-center gap-1.5 text-fuchsia-300/90">
            <span className="w-3.5 h-0 border-t-2 border-dashed border-fuchsia-400 inline-block" /> Put Wall
          </span>
          <span className="inline-flex items-center gap-1.5 text-orange-300/90">
            <span className="w-3.5 h-0 border-t-2 border-dashed border-orange-400 inline-block" /> Zero Gamma
          </span>
        </div>

        <span className="text-[10.5px] text-slate-400">
          {scaleMode === "focus"
            ? "3-pt median stabilized · Price Focus active"
            : "3-pt median stabilized · Full Wall Range"}
        </span>
      </div>
    </div>
  );
}
