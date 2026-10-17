"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import * as ToggleGroup from "@radix-ui/react-toggle-group";
import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ExposureMetric,
  getTickerPreset,
  useDashboardStore,
} from "@/store/useDashboardStore";
import { cn } from "@/lib/utils";
import { RotateCcw, Share2, ZoomIn, ZoomOut } from "lucide-react";
import { Surface3DView } from "./Surface3DView";
import { formatExposure } from "@/lib/optionsExposure";

export interface ExpirationColMeta {
  id: string;
  tag: string;
  filterGroup: "0DTE" | "THIS_WEEK" | "OPEX";
  dateLabel: string;
  dteWeight: number;
}

export const FALLBACK_EXPIRATION_COLUMNS: ExpirationColMeta[] = [
  { id: "exp_0", tag: "0DTE", filterGroup: "0DTE", dateLabel: "10-16", dteWeight: 1.45 },
  { id: "exp_1", tag: "3D", filterGroup: "THIS_WEEK", dateLabel: "10-19", dteWeight: 0.95 },
  { id: "exp_2", tag: "4D", filterGroup: "THIS_WEEK", dateLabel: "10-20", dteWeight: 0.82 },
  { id: "exp_3", tag: "5D", filterGroup: "THIS_WEEK", dateLabel: "10-21", dteWeight: 0.78 },
  { id: "exp_4", tag: "6D", filterGroup: "THIS_WEEK", dateLabel: "10-22", dteWeight: 0.74 },
  { id: "exp_5", tag: "WKLY", filterGroup: "THIS_WEEK", dateLabel: "10-23", dteWeight: 1.15 },
  { id: "exp_6", tag: "10D", filterGroup: "THIS_WEEK", dateLabel: "10-26", dteWeight: 0.68 },
  { id: "exp_7", tag: "WKLY", filterGroup: "THIS_WEEK", dateLabel: "10-30", dteWeight: 1.1 },
  { id: "exp_8", tag: "WKLY", filterGroup: "THIS_WEEK", dateLabel: "11-06", dteWeight: 0.85 },
  { id: "exp_9", tag: "WKLY", filterGroup: "THIS_WEEK", dateLabel: "11-13", dteWeight: 0.75 },
  { id: "exp_10", tag: "OPEX", filterGroup: "OPEX", dateLabel: "11-20", dteWeight: 1.65 },
  { id: "exp_11", tag: "OPEX", filterGroup: "OPEX", dateLabel: "12-18", dteWeight: 1.35 },
  { id: "exp_12", tag: "OPEX", filterGroup: "OPEX", dateLabel: "01-15", dteWeight: 1.05 },
];

export interface StrikeRowData {
  strike: number;
  isAtm: boolean;
  isKingNode: boolean;
  isFilteredKing: boolean;
  isCallWall: boolean;
  isPutWall: boolean;
  isZeroGamma: boolean;
  emMarker: "D↑" | "D↓" | "W↑" | "W↓" | null;
  kingPeakColId: string;
  values: Record<string, number>;
  openPctChange: Record<string, number>;
}

const METRIC_OPTIONS: ExposureMetric[] = ["GEX", "VEX", "DEX", "Charm"];

function seededStrikeHash(seed: number): number {
  const x = Math.sin(seed * 91.3458 + 17.13) * 47853.5453;
  return x - Math.floor(x);
}

function lerpChannel(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

function lerpRgb(
  c1: [number, number, number],
  c2: [number, number, number],
  t: number
): string {
  const clamped = Math.max(0, Math.min(1, t));
  const r = lerpChannel(c1[0], c2[0], clamped);
  const g = lerpChannel(c1[1], c2[1], clamped);
  const b = lerpChannel(c1[2], c2[2], clamped);
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * Hyperion Signature 3-Stop Heatmap Color Scale:
 * - Most Negative Gamma: Deep Purple (#6b21a8 / #9333ea)
 * - Near Zero: Teal (#0d9488 / #14b8a6)
 * - Most Positive Gamma: Bright Yellow (#facc15 / #fde047)
 */
export function getHyperionCellStyle(
  cellValue: number,
  maxColumnValue: number,
  isKingCell: boolean
): { backgroundColor: string; isBrightYellow: boolean } {
  if (isKingCell) {
    return {
      backgroundColor: "#fde047",
      isBrightYellow: true,
    };
  }

  const ratio = Math.max(
    -1,
    Math.min(1, cellValue / Math.max(0.01, maxColumnValue))
  );

  const deepPurple: [number, number, number] = [107, 33, 168]; // #6b21a8
  const midPurple: [number, number, number] = [147, 51, 234]; // #9333ea
  const darkTeal: [number, number, number] = [13, 148, 136]; // #0d9488
  const brightTeal: [number, number, number] = [20, 184, 166]; // #14b8a6
  const brightYellow: [number, number, number] = [250, 204, 21]; // #facc15
  const radiantYellow: [number, number, number] = [253, 224, 71]; // #fde047

  if (ratio < 0) {
    const mag = Math.abs(ratio);
    if (mag < 0.5) {
      return {
        backgroundColor: lerpRgb(darkTeal, midPurple, mag / 0.5),
        isBrightYellow: false,
      };
    }
    return {
      backgroundColor: lerpRgb(midPurple, deepPurple, (mag - 0.5) / 0.5),
      isBrightYellow: false,
    };
  }

  if (ratio < 0.38) {
    return {
      backgroundColor: lerpRgb(darkTeal, brightTeal, ratio / 0.38),
      isBrightYellow: false,
    };
  }
  if (ratio < 0.78) {
    const t = (ratio - 0.38) / 0.4;
    return {
      backgroundColor: lerpRgb(brightTeal, brightYellow, t),
      isBrightYellow: ratio >= 0.52,
    };
  }
  return {
    backgroundColor: lerpRgb(brightYellow, radiantYellow, (ratio - 0.78) / 0.22),
    isBrightYellow: true,
  };
}

export function HeatmapTable() {
  const activeTicker = useDashboardStore((state) => state.activeTicker);
  const spotPrice = useDashboardStore((state) => state.spotPrice);
  const impliedVolatility = useDashboardStore((state) => state.impliedVolatility);
  const strikeStep = useDashboardStore((state) => state.strikeStep);
  const gammaLevels = useDashboardStore((state) => state.gammaLevels);
  const kingNode = useDashboardStore((state) => state.kingNode);
  const chainExpirations = useDashboardStore((state) => state.chainExpirations);
  const chainStrikes = useDashboardStore((state) => state.chainStrikes);
  const metric = useDashboardStore((state) => state.gridFilters.metric);
  const expirationFilter = useDashboardStore(
    (state) => state.gridFilters.expiration
  );
  const setFilters = useDashboardStore((state) => state.setFilters);

  const [displayMode, setDisplayMode] = useState<"Grid" | "3D Surface">("Grid");
  const [cellMode, setCellMode] = useState<"Value" | "DeltaOpen">("Value");
  const [zoom, setZoom] = useState<number>(1);
  const [pickedDateCol, setPickedDateCol] = useState<string>("");

  const preset = getTickerPreset(activeTicker);

  const activeColumns: ExpirationColMeta[] = useMemo(() => {
    if (chainExpirations.length > 0) {
      return chainExpirations.map((exp, idx) => ({
        id: exp.id,
        tag: exp.tag,
        filterGroup: exp.filterGroup,
        dateLabel: exp.dateLabel,
        dteWeight: idx === 0 ? 1.45 : idx >= 8 ? 1.5 : 0.85,
      }));
    }
    return FALLBACK_EXPIRATION_COLUMNS;
  }, [chainExpirations]);

  // Expected move target prices for D↑, D↓, W↑, W↓ markers
  const dailyEm = spotPrice * impliedVolatility * Math.sqrt(1 / 252);
  const weeklyEm = spotPrice * impliedVolatility * Math.sqrt(5 / 252);
  const targetDUp = spotPrice + dailyEm;
  const targetDDown = spotPrice - dailyEm;
  const targetWUp = spotPrice + weeklyEm;
  const targetWDown = spotPrice - weeklyEm;

  const { rowsData, maxColumnValues, atmRowIndex } = useMemo(() => {
    const colMax: Record<string, number> = {};
    activeColumns.forEach((col) => {
      colMax[col.id] = 0.01;
    });

    const assignEmMarkers = (strikesList: { strike: number }[]) => {
      const findNearestIdx = (target: number) => {
        let bestIdx = 0;
        let bestDiff = Infinity;
        strikesList.forEach((r, idx) => {
          const d = Math.abs(r.strike - target);
          if (d < bestDiff) {
            bestDiff = d;
            bestIdx = idx;
          }
        });
        return bestIdx;
      };
      const idxDUp = findNearestIdx(targetDUp);
      const idxDDown = findNearestIdx(targetDDown);
      const idxWUp = findNearestIdx(targetWUp);
      const idxWDown = findNearestIdx(targetWDown);

      const map = new Map<number, "D↑" | "D↓" | "W↑" | "W↓">();
      map.set(idxWUp, "W↑");
      map.set(idxWDown, "W↓");
      map.set(idxDUp, "D↑");
      map.set(idxDDown, "D↓");
      return map;
    };

    if (chainStrikes.length > 0) {
      let bestAtmIdx = 0;
      let bestAtmDiff = Infinity;
      let bestZeroIdx = 0;
      let bestZeroDiff = Infinity;

      chainStrikes.forEach((sRow, idx) => {
        const diffSpot = Math.abs(sRow.strike - spotPrice);
        if (diffSpot < bestAtmDiff) {
          bestAtmDiff = diffSpot;
          bestAtmIdx = idx;
        }
        const diffZero = Math.abs(sRow.strike - gammaLevels.zeroGamma);
        if (diffZero < bestZeroDiff) {
          bestZeroDiff = diffZero;
          bestZeroIdx = idx;
        }
      });

      const emMap = assignEmMarkers(chainStrikes);

      const rows: StrikeRowData[] = chainStrikes.map((sRow, idx) => {
        const metricValues =
          metric === "GEX"
            ? sRow.gex
            : metric === "VEX"
              ? sRow.vex
              : metric === "DEX"
                ? sRow.dex
                : sRow.charm;

        let peakColId = sRow.kingPeakColId;
        let maxAbsInRow = -1;

        for (const col of activeColumns) {
          const val = metricValues[col.id] ?? 0;
          const absVal = Math.abs(val);
          if (absVal > colMax[col.id]) {
            colMax[col.id] = absVal;
          }
          if (absVal > maxAbsInRow) {
            maxAbsInRow = absVal;
            peakColId = col.id;
          }
        }

        return {
          strike: sRow.strike,
          isAtm: idx === bestAtmIdx,
          isKingNode:
            Math.abs(sRow.strike - kingNode.allExpKing) < strikeStep * 0.4,
          isFilteredKing:
            Math.abs(sRow.strike - kingNode.filteredKing) < strikeStep * 0.4,
          isCallWall:
            Math.abs(sRow.strike - gammaLevels.callWall) < strikeStep * 0.4,
          isPutWall:
            Math.abs(sRow.strike - gammaLevels.putWall) < strikeStep * 0.4,
          isZeroGamma: idx === bestZeroIdx,
          emMarker: emMap.get(idx) ?? null,
          kingPeakColId: peakColId,
          values: metricValues,
          openPctChange: sRow.openPctChange,
        };
      });

      return {
        rowsData: rows,
        maxColumnValues: colMax,
        atmRowIndex: bestAtmIdx,
      };
    }

    // Deterministic Fallback (160 strikes)
    const totalRows = 160;
    const halfRows = Math.floor(totalRows / 2);
    const centerStrike =
      Math.round(preset.spotPrice / strikeStep) * strikeStep;
    const nearestAtmStrike =
      Math.round(spotPrice / strikeStep) * strikeStep;

    const tickerSeed = activeTicker
      .split("")
      .reduce((acc, ch) => acc + ch.charCodeAt(0) * 13, 0);

    const tempStrikes = Array.from({ length: totalRows }, (_, i) => ({
      strike: centerStrike + (halfRows - i) * strikeStep,
    }));
    const emMap = assignEmMarkers(tempStrikes);

    const rows: StrikeRowData[] = [];
    let foundAtmIndex = halfRows;

    const corridorSpan = Math.max(
      strikeStep * 8,
      Math.abs(gammaLevels.callWall - gammaLevels.putWall)
    );

    for (let i = 0; i < totalRows; i++) {
      const strike = tempStrikes[i].strike;
      const isAtm = Math.abs(strike - nearestAtmStrike) < strikeStep * 0.4;
      if (isAtm) {
        foundAtmIndex = i;
      }

      const isKingNode =
        Math.abs(strike - kingNode.allExpKing) < strikeStep * 0.4;
      const isFilteredKing =
        Math.abs(strike - kingNode.filteredKing) < strikeStep * 0.4;
      const isCallWall =
        Math.abs(strike - gammaLevels.callWall) < strikeStep * 0.4;
      const isPutWall =
        Math.abs(strike - gammaLevels.putWall) < strikeStep * 0.4;
      const isZeroGamma =
        Math.abs(strike - gammaLevels.zeroGamma) < strikeStep * 0.4;

      const distFromCall = (strike - gammaLevels.callWall) / corridorSpan;
      const distFromPut = (strike - gammaLevels.putWall) / corridorSpan;
      const distFromZero = (strike - gammaLevels.zeroGamma) / corridorSpan;
      const distFromSpot = (strike - spotPrice) / corridorSpan;
      const distFromKing = (strike - kingNode.allExpKing) / corridorSpan;

      const values: Record<string, number> = {};
      const openPctChange: Record<string, number> = {};
      let kingPeakColId = activeColumns[0].id;
      let rowMaxVal = -Infinity;

      activeColumns.forEach((col, colIdx) => {
        const noise =
          0.75 +
          0.5 * seededStrikeHash(tickerSeed + strike * 3.7 + colIdx * 101);

        const callGaussian = Math.exp(-Math.pow(distFromCall * 3.4, 2));
        const putGaussian = Math.exp(-Math.pow(distFromPut * 3.4, 2));
        const kingGaussian = Math.exp(-Math.pow(distFromKing * 4.0, 2));
        const atmGaussian = Math.exp(-Math.pow(distFromSpot * 2.2, 2));
        const wideEnvelope = Math.exp(-Math.pow(distFromSpot * 0.65, 2));

        let rawVal = 0;
        const scaleBase =
          activeTicker === "SPX" || activeTicker === "SPXW"
            ? 42
            : activeTicker === "SPY"
              ? 28
              : activeTicker === "QQQ"
                ? 22
                : 15;

        if (metric === "GEX") {
          const regimeSign = Math.tanh(distFromZero * 2.8);
          const wallComponent =
            callGaussian * 1.45 +
            kingGaussian * 0.55 -
            putGaussian * 1.35 +
            regimeSign * atmGaussian * 0.55;
          rawVal =
            scaleBase *
            col.dteWeight *
            noise *
            (wallComponent + regimeSign * wideEnvelope * 0.18);
        } else if (metric === "VEX") {
          const vannaWave =
            callGaussian * 1.2 +
            kingGaussian * 0.45 +
            atmGaussian * 0.65 * Math.sign(distFromZero + 0.15) -
            putGaussian * 1.1;
          rawVal =
            scaleBase *
            0.82 *
            col.dteWeight *
            noise *
            (vannaWave + wideEnvelope * 0.15 * Math.sin(distFromSpot * 4));
        } else if (metric === "DEX") {
          const dexCurve =
            -Math.tanh(distFromSpot * 1.9) * atmGaussian * 1.4 +
            callGaussian * 0.85 -
            putGaussian * 0.95;
          rawVal =
            scaleBase *
            1.25 *
            col.dteWeight *
            noise *
            (dexCurve + wideEnvelope * 0.12);
        } else {
          const charmFlip =
            -Math.sin(distFromSpot * 4.2) * atmGaussian * 1.5 +
            (callGaussian - putGaussian) * 0.45;
          rawVal =
            scaleBase *
            0.65 *
            col.dteWeight *
            noise *
            (charmFlip + wideEnvelope * 0.08 * Math.sign(-distFromSpot));
        }

        const rounded = Number(rawVal.toFixed(2));
        values[col.id] = rounded;

        const pctSeed = seededStrikeHash(tickerSeed + strike * 11 + colIdx * 37);
        openPctChange[col.id] = Math.round((pctSeed - 0.42) * 48);

        if (Math.abs(rounded) > rowMaxVal) {
          rowMaxVal = Math.abs(rounded);
          kingPeakColId = col.id;
        }

        const absVal = Math.abs(rounded);
        if (absVal > colMax[col.id]) {
          colMax[col.id] = absVal;
        }
      });

      rows.push({
        strike,
        isAtm,
        isKingNode,
        isFilteredKing,
        isCallWall,
        isPutWall,
        isZeroGamma,
        emMarker: emMap.get(i) ?? null,
        kingPeakColId,
        values,
        openPctChange,
      });
    }

    return {
      rowsData: rows,
      maxColumnValues: colMax,
      atmRowIndex: foundAtmIndex,
    };
  }, [
    chainStrikes,
    activeColumns,
    activeTicker,
    preset.spotPrice,
    strikeStep,
    spotPrice,
    gammaLevels,
    kingNode.allExpKing,
    kingNode.filteredKing,
    metric,
    targetDUp,
    targetDDown,
    targetWUp,
    targetWDown,
  ]);

  const columns = useMemo<ColumnDef<StrikeRowData>[]>(() => {
    const strikeCol: ColumnDef<StrikeRowData> = {
      id: "strike",
      header: () => (
        <div className="flex items-center justify-between px-2.5 py-2 text-[10px] font-mono font-bold uppercase tracking-wider text-slate-300">
          <span>Strike</span>
          <span className="text-[9px] text-slate-500">EM / LEVEL</span>
        </div>
      ),
      cell: ({ row }) => {
        const {
          strike,
          isAtm,
          isKingNode,
          isCallWall,
          isPutWall,
          isZeroGamma,
          emMarker,
        } = row.original;

        return (
          <div
            className={cn(
              "flex items-center justify-between px-2.5 h-full font-mono text-[11px] tabular-nums select-none",
              isAtm
                ? "bg-[#3b82f6] text-white font-extrabold"
                : isKingNode
                  ? "text-amber-300 font-bold"
                  : "text-slate-200 font-medium"
            )}
          >
            <span>{strike.toFixed(strike % 1 !== 0 ? 1 : 0)}</span>
            <div className="flex items-center gap-1">
              {emMarker && (
                <span className="rounded bg-yellow-400/25 border border-yellow-400 px-1 py-0.2 text-[8px] font-extrabold text-yellow-300">
                  {emMarker}
                </span>
              )}
              {isKingNode && (
                <span className="rounded bg-amber-300 px-1 py-0.2 text-[8px] font-extrabold text-slate-950 shadow-[0_0_8px_rgba(251,191,36,0.9)]">
                  [KING]
                </span>
              )}
              {isAtm && (
                <span className="rounded bg-white px-1 py-0.2 text-[8px] font-extrabold text-slate-950">
                  SPOT
                </span>
              )}
              {isCallWall && !isKingNode && !isAtm && (
                <span className="rounded bg-cyan-500/20 border border-cyan-400/50 px-1 py-0.2 text-[8px] font-bold text-cyan-300">
                  CW
                </span>
              )}
              {isPutWall && !isAtm && (
                <span className="rounded bg-rose-500/20 border border-rose-400/50 px-1 py-0.2 text-[8px] font-bold text-rose-300">
                  PW
                </span>
              )}
              {isZeroGamma && !isAtm && (
                <span className="rounded bg-orange-500/20 border border-orange-400/50 px-1 py-0.2 text-[8px] font-bold text-orange-300">
                  0γ
                </span>
              )}
            </div>
          </div>
        );
      },
    };

    const expCols: ColumnDef<StrikeRowData>[] = activeColumns.map(
      (expCol, colIdx) => {
        const isFilterHighlighted =
          (expirationFilter !== "ALL" && expCol.filterGroup === expirationFilter) ||
          pickedDateCol === expCol.dateLabel;

        return {
          id: expCol.id,
          header: () => (
            <div
              className={cn(
                "flex flex-col items-center justify-center px-1.5 py-1.5 font-mono transition-colors",
                isFilterHighlighted && "bg-[#5e72e4]/25"
              )}
            >
              <span className="text-[11px] font-bold text-white">
                {expCol.dateLabel}
              </span>
              <span
                className={cn(
                  "text-[8px] font-semibold uppercase",
                  expCol.tag === "0DTE"
                    ? "text-rose-400"
                    : expCol.tag === "OPEX"
                      ? "text-cyan-300"
                      : "text-slate-400"
                )}
              >
                {expCol.tag}
              </span>
            </div>
          ),
          cell: ({ row }) => {
            const cellValue = row.original.values[expCol.id] ?? 0;
            const maxColumnValue = maxColumnValues[expCol.id] || 1;
            const isOneGoldGlowKingCell =
              row.original.isKingNode && row.original.kingPeakColId === expCol.id;

            const { backgroundColor, isBrightYellow } = getHyperionCellStyle(
              cellValue,
              maxColumnValue,
              isOneGoldGlowKingCell
            );

            const formattedVal = formatExposure(cellValue);
            const pctSinceOpen = row.original.openPctChange[expCol.id] ?? 0;
            const formattedPct = `${pctSinceOpen >= 0 ? "+" : ""}${pctSinceOpen}%`;

            // Show top-right intraday % change badge in near-term cells (first 4 columns) or peak cells
            const showTopRightBadge =
              colIdx <= 3 && Math.abs(pctSinceOpen) >= 3 && cellMode === "Value";

            return (
              <div
                style={{ backgroundColor }}
                className={cn(
                  "relative flex items-center justify-end px-1.5 h-full font-mono text-[10px] tabular-nums transition-colors select-none",
                  isBrightYellow
                    ? "text-slate-950 font-extrabold"
                    : "text-white font-medium",
                  isOneGoldGlowKingCell &&
                    "ring-2 ring-amber-300 shadow-[0_0_16px_rgba(251,191,36,0.85)] z-20 font-extrabold"
                )}
              >
                {/* Top-right intraday % change badge */}
                {showTopRightBadge && (
                  <span
                    className={cn(
                      "absolute top-0.5 right-1 rounded px-1 leading-tight text-[7px] font-bold",
                      isBrightYellow
                        ? "bg-slate-950/20 text-slate-950"
                        : pctSinceOpen >= 0
                          ? "bg-emerald-950/75 text-emerald-300"
                          : "bg-rose-950/75 text-rose-300"
                    )}
                  >
                    {formattedPct}
                  </span>
                )}

                {isOneGoldGlowKingCell && (
                  <span className="absolute left-1 top-1/2 -translate-y-1/2 rounded bg-slate-950/85 px-1 text-[7px] font-bold text-amber-300">
                    ★
                  </span>
                )}

                <span className={cn(showTopRightBadge && "mt-2")}>
                  {cellMode === "DeltaOpen" ? formattedPct : formattedVal}
                </span>
              </div>
            );
          },
        };
      }
    );

    return [strikeCol, ...expCols];
  }, [activeColumns, maxColumnValues, expirationFilter, pickedDateCol, cellMode]);

  const table = useReactTable({
    data: rowsData,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  const tableRows = table.getRowModel().rows;
  const parentRef = useRef<HTMLDivElement | null>(null);
  const rowHeight = Math.round(30 * zoom);

  const rowVirtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan: 16,
  });

  const resetZoomAndCenter = () => {
    setZoom(1);
    setPickedDateCol("");
    rowVirtualizer.scrollToIndex(atmRowIndex, { align: "center" });
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      rowVirtualizer.scrollToIndex(atmRowIndex, { align: "center" });
    }, 60);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTicker, chainStrikes.length]);

  const handleShareToX = () => {
    const text = `${activeTicker} $${spotPrice.toFixed(2)} Options Positioning via Hyperion:\n• All-exp King: $${kingNode.allExpKing.toFixed(0)} (${kingNode.kingStrength}/100)\n• Call Wall: $${gammaLevels.callWall.toFixed(0)} | Put Wall: $${gammaLevels.putWall.toFixed(0)}\n• Zero γ: $${gammaLevels.zeroGamma.toFixed(2)}`;
    window.open(
      `https://x.com/intent/tweet?text=${encodeURIComponent(text)}`,
      "_blank",
      "noopener,noreferrer"
    );
  };

  const gridTemplate = `145px repeat(${activeColumns.length}, minmax(74px, 1fr))`;

  return (
    <section
      aria-label="Multi-Expiry Heatmap Grid"
      className="argon-card rounded-xl p-4 flex flex-col space-y-3"
    >
      {/* Multi-Pill Filter Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 pb-2.5 border-b border-white/10">
        <div className="flex flex-wrap items-center gap-2">
          {/* 1. [GEX | VEX | DEX | Charm] */}
          <ToggleGroup.Root
            type="single"
            value={metric}
            onValueChange={(val) => {
              if (val) setFilters({ metric: val as ExposureMetric });
            }}
            aria-label="Exposure Metric"
            className="inline-flex items-center rounded-full bg-[#0b0d17] p-0.5 border border-white/10"
          >
            {METRIC_OPTIONS.map((m) => (
              <ToggleGroup.Item
                key={m}
                value={m}
                className={cn(
                  "px-2.5 py-1 rounded-full text-[11px] font-mono font-bold transition-all",
                  metric === m
                    ? "bg-[#1c223a] border border-[#5e72e4] text-white shadow-[0_0_10px_rgba(94,114,228,0.5)]"
                    : "text-slate-400 hover:text-white"
                )}
              >
                {m}
              </ToggleGroup.Item>
            ))}
          </ToggleGroup.Root>

          {/* 2. [All exp | This week | 0DTE | Date ▾] */}
          <div className="inline-flex items-center rounded-full bg-[#0b0d17] p-0.5 border border-white/10">
            {[
              { value: "ALL", label: "All exp" },
              { value: "THIS_WEEK", label: "This week" },
              { value: "0DTE", label: "0DTE" },
            ].map((exp) => (
              <button
                key={exp.value}
                type="button"
                onClick={() => {
                  setPickedDateCol("");
                  setFilters({ expiration: exp.value });
                }}
                className={cn(
                  "px-2.5 py-1 rounded-full text-[11px] font-mono font-semibold transition-all",
                  expirationFilter === exp.value && !pickedDateCol
                    ? "bg-[#1c223a] border border-[#11cdef] text-white"
                    : "text-slate-400 hover:text-white"
                )}
              >
                {exp.label}
              </button>
            ))}
            <select
              aria-label="Pick specific expiration date"
              value={pickedDateCol}
              onChange={(e) => {
                const val = e.target.value;
                setPickedDateCol(val);
                setFilters({ expiration: val || "ALL" });
              }}
              className="bg-transparent text-[11px] font-mono text-slate-300 px-2 py-1 rounded-full focus:outline-none cursor-pointer"
            >
              <option value="" className="bg-[#111422]">
                Date ▾
              </option>
              {activeColumns.map((c) => (
                <option key={c.id} value={c.dateLabel} className="bg-[#111422]">
                  {c.dateLabel} ({c.tag})
                </option>
              ))}
            </select>
          </div>

          {/* 3. [Grid | 3D Surface] */}
          <div className="inline-flex items-center rounded-full bg-[#0b0d17] p-0.5 border border-white/10">
            {(["Grid", "3D Surface"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setDisplayMode(mode)}
                className={cn(
                  "px-2.5 py-1 rounded-full text-[11px] font-mono font-semibold transition-all",
                  displayMode === mode
                    ? "bg-[#1c223a] border border-[#5e72e4] text-white"
                    : "text-slate-400 hover:text-white"
                )}
              >
                {mode}
              </button>
            ))}
          </div>

          {/* 4. [Value | Δ since open] */}
          <div className="inline-flex items-center rounded-full bg-[#0b0d17] p-0.5 border border-white/10">
            <button
              type="button"
              onClick={() => setCellMode("Value")}
              className={cn(
                "px-2.5 py-1 rounded-full text-[11px] font-mono font-semibold transition-all",
                cellMode === "Value"
                  ? "bg-[#1c223a] border border-[#5e72e4] text-white"
                  : "text-slate-400 hover:text-white"
              )}
            >
              Value
            </button>
            <button
              type="button"
              onClick={() => setCellMode("DeltaOpen")}
              className={cn(
                "px-2.5 py-1 rounded-full text-[11px] font-mono font-semibold transition-all",
                cellMode === "DeltaOpen"
                  ? "bg-[#1c223a] border border-[#5e72e4] text-white"
                  : "text-slate-400 hover:text-white"
              )}
            >
              Δ since open
            </button>
          </div>
        </div>

        {/* Right Controls: [Share to X] + [- / + / Reset] Zoom Buttons */}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={handleShareToX}
            className="inline-flex items-center gap-1 rounded-full bg-[#0b0d17] hover:bg-[#1c223a] border border-white/15 px-3 py-1 text-[11px] font-mono font-semibold text-slate-200 transition-colors"
          >
            <Share2 className="h-3 w-3 text-[#11cdef]" />
            <span>Share to X</span>
          </button>

          <div className="inline-flex items-center rounded-full bg-[#0b0d17] border border-white/15 p-0.5">
            <button
              type="button"
              onClick={() => setZoom((z) => Math.max(0.75, Number((z - 0.1).toFixed(2))))}
              className="px-2 py-0.5 text-xs font-mono text-slate-300 hover:text-white"
              title="Zoom out"
            >
              <ZoomOut className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setZoom((z) => Math.min(1.4, Number((z + 0.1).toFixed(2))))}
              className="px-2 py-0.5 text-xs font-mono text-slate-300 hover:text-white"
              title="Zoom in"
            >
              <ZoomIn className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={resetZoomAndCenter}
              className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono font-semibold text-slate-300 hover:text-white border-l border-white/10"
              title="Reset zoom & center on Spot"
            >
              <RotateCcw className="h-3 w-3" />
              <span>Reset</span>
            </button>
          </div>
        </div>
      </div>

      {/* King Node & Color Scale Subbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono">
        <div className="flex flex-wrap items-center gap-3 text-slate-400">
          <span className="text-amber-300 font-bold">
            ★{" "}
            {expirationFilter === "ALL"
              ? `All-exp King ${kingNode.allExpKing.toFixed(0)}`
              : `${kingNode.filteredLabel.split(" ")[0]} King ${kingNode.filteredKing.toFixed(0)} · All-exp King ${kingNode.allExpKing.toFixed(0)}`}
            {kingNode.isContested ? " · contested" : ""}
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-2.5 w-2.5 rounded-sm bg-[#6b21a8] inline-block" />
            <span>Neg γ</span>
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-2.5 w-2.5 rounded-sm bg-[#0d9488] inline-block" />
            <span>Zero</span>
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-2.5 w-2.5 rounded-sm bg-[#facc15] inline-block" />
            <span>Pos γ</span>
          </span>
        </div>
        <div className="text-slate-400">
          Yellow horizontal lines = <span className="text-yellow-300 font-semibold">D↑ / D↓</span> (Daily EM) & <span className="text-yellow-300 font-semibold">W↑ / W↓</span> (Weekly EM)
        </div>
      </div>

      {displayMode === "3D Surface" ? (
        <Surface3DView
          ticker={activeTicker}
          spotPrice={spotPrice}
          metric={metric}
          kingStrike={kingNode.allExpKing}
          kingStrength={kingNode.kingStrength}
          callWall={gammaLevels.callWall}
          putWall={gammaLevels.putWall}
          zeroGamma={gammaLevels.zeroGamma}
          columns={activeColumns}
          rows={rowsData}
          atmRowIndex={atmRowIndex}
        />
      ) : (
        /* Virtualized 2D Heatmap Matrix */
        <div
          ref={parentRef}
          className="relative h-[560px] w-full overflow-auto argon-scrollbar rounded-lg border border-white/10 bg-[#0b0d17]"
        >
          {/* Sticky Header */}
          <div
            style={{ gridTemplateColumns: gridTemplate }}
            className="sticky top-0 z-30 grid min-w-[1110px] bg-[#111422] border-b border-white/15 shadow-md"
          >
            {table.getHeaderGroups().map((headerGroup) =>
              headerGroup.headers.map((header, idx) => (
                <div
                  key={header.id}
                  className={cn(
                    "border-r border-white/10 last:border-r-0",
                    idx === 0 &&
                      "sticky left-0 z-40 bg-[#111422] border-r border-white/20"
                  )}
                >
                  {header.isPlaceholder
                    ? null
                    : flexRender(
                        header.column.columnDef.header,
                        header.getContext()
                      )}
                </div>
              ))
            )}
          </div>

          {/* Virtualized Rows */}
          <div
            style={{
              height: `${rowVirtualizer.getTotalSize()}px`,
              position: "relative",
            }}
            className="min-w-[1110px]"
          >
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const row = tableRows[virtualRow.index];
              const {
                isAtm,
                isKingNode,
                isCallWall,
                isPutWall,
                isZeroGamma,
                emMarker,
              } = row.original;

              return (
                <div
                  key={row.id}
                  data-index={virtualRow.index}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    height: `${virtualRow.size}px`,
                    transform: `translateY(${virtualRow.start}px)`,
                    gridTemplateColumns: gridTemplate,
                  }}
                  className={cn(
                    "grid border-b border-[#0b0d17]/70 transition-colors",
                    emMarker && "border-b-2 border-yellow-400 z-10",
                    isAtm && "ring-1 ring-inset ring-[#3b82f6] z-10",
                    isKingNode && "ring-1 ring-inset ring-amber-300/80 z-20"
                  )}
                >
                  {row.getVisibleCells().map((cell, cellIdx) => {
                    const isStrikeCol = cellIdx === 0;
                    return (
                      <div
                        key={cell.id}
                        className={cn(
                          "h-full border-r border-[#0b0d17]/45 last:border-r-0",
                          isStrikeCol &&
                            cn(
                              "sticky left-0 z-20 border-r border-white/20",
                              isAtm
                                ? "bg-[#3b82f6] text-white"
                                : isKingNode
                                  ? "bg-amber-950/90 ring-1 ring-inset ring-amber-300/80"
                                  : isCallWall
                                    ? "bg-[#13253a]"
                                    : isPutWall
                                      ? "bg-[#2b142c]"
                                      : isZeroGamma
                                        ? "bg-[#262030]"
                                        : "bg-[#111422]"
                            )
                        )}
                      >
                        {flexRender(
                          cell.column.columnDef.cell,
                          cell.getContext()
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
