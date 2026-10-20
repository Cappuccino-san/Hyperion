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
  isoDate?: string;
  tag: string;
  filterGroup: "0DTE" | "THIS_WEEK" | "OPEX";
  inThisWeek?: boolean;
  dateLabel: string;
  dteWeight: number;
}

export const FALLBACK_EXPIRATION_COLUMNS: ExpirationColMeta[] = [
  { id: "exp_0", isoDate: "2026-10-19", tag: "0DTE", filterGroup: "0DTE", inThisWeek: true, dateLabel: "10-19", dteWeight: 1.45 },
  { id: "exp_1", isoDate: "2026-10-20", tag: "1D", filterGroup: "THIS_WEEK", inThisWeek: true, dateLabel: "10-20", dteWeight: 0.95 },
  { id: "exp_2", isoDate: "2026-10-21", tag: "2D", filterGroup: "THIS_WEEK", inThisWeek: true, dateLabel: "10-21", dteWeight: 0.82 },
  { id: "exp_3", isoDate: "2026-10-22", tag: "3D", filterGroup: "THIS_WEEK", inThisWeek: true, dateLabel: "10-22", dteWeight: 0.78 },
  { id: "exp_4", isoDate: "2026-10-23", tag: "4D", filterGroup: "THIS_WEEK", inThisWeek: true, dateLabel: "10-23", dteWeight: 1.15 },
  { id: "exp_5", isoDate: "2026-10-26", tag: "7D", filterGroup: "THIS_WEEK", inThisWeek: false, dateLabel: "10-26", dteWeight: 0.74 },
  { id: "exp_6", isoDate: "2026-10-30", tag: "WKLY", filterGroup: "THIS_WEEK", inThisWeek: false, dateLabel: "10-30", dteWeight: 1.1 },
  { id: "exp_7", isoDate: "2026-11-06", tag: "WKLY", filterGroup: "THIS_WEEK", inThisWeek: false, dateLabel: "11-06", dteWeight: 0.85 },
  { id: "exp_8", isoDate: "2026-11-13", tag: "WKLY", filterGroup: "THIS_WEEK", inThisWeek: false, dateLabel: "11-13", dteWeight: 0.75 },
  { id: "exp_9", isoDate: "2026-11-20", tag: "OPEX", filterGroup: "OPEX", inThisWeek: false, dateLabel: "11-20", dteWeight: 1.65 },
  { id: "exp_10", isoDate: "2026-12-18", tag: "OPEX", filterGroup: "OPEX", inThisWeek: false, dateLabel: "12-18", dteWeight: 1.35 },
  { id: "exp_11", isoDate: "2027-01-15", tag: "OPEX", filterGroup: "OPEX", inThisWeek: false, dateLabel: "01-15", dteWeight: 1.05 },
];

export interface EmMarkerTag {
  tag: string;
  color: string;
  side: "high" | "low";
}

export interface StrikeRowData {
  strike: number;
  isAtm: boolean;
  isKingNode: boolean;
  isFilteredKing: boolean;
  isCallWall: boolean;
  isPutWall: boolean;
  isZeroGamma: boolean;
  emMarker: string | null;
  emMarkers?: EmMarkerTag[];
  kingPeakColId: string;
  values: Record<string, number>;
  openPctChange: Record<string, number>;
}

const METRIC_OPTIONS: ExposureMetric[] = ["GEX", "VEX", "DEX", "Charm"];

function seededStrikeHash(seed: number): number {
  const x = Math.sin(seed * 91.3458 + 17.13) * 47853.5453;
  return x - Math.floor(x);
}

/**
 * TerraShade Viridis 5-Stop Color Scale:
 * [[68,1,84],[59,82,139],[33,145,140],[94,201,98],[253,231,37]]
 */
const VIRIDIS_STOPS: [number, number, number][] = [
  [68, 1, 84],
  [59, 82, 139],
  [33, 145, 140],
  [94, 201, 98],
  [253, 231, 37],
];

function sampleViridis(t: number): string {
  const x = Math.max(0, Math.min(1, t)) * (VIRIDIS_STOPS.length - 1);
  const i = Math.min(VIRIDIS_STOPS.length - 2, Math.floor(x));
  const f = x - i;
  const a = VIRIDIS_STOPS[i];
  const b = VIRIDIS_STOPS[i + 1];
  const r = Math.round(a[0] + (b[0] - a[0]) * f);
  const g = Math.round(a[1] + (b[1] - a[1]) * f);
  const bl = Math.round(a[2] + (b[2] - a[2]) * f);
  return `rgb(${r}, ${g}, ${bl})`;
}

export function getHyperionCellStyle(
  cellValue: number,
  maxColumnValue: number,
  isKingCell: boolean
): { backgroundColor: string; isBrightYellow: boolean } {
  if (isKingCell) {
    return {
      backgroundColor: "#facc15",
      isBrightYellow: true,
    };
  }

  const u = Math.max(
    0,
    Math.min(1, 0.5 + 0.5 * (cellValue / (maxColumnValue || 1)))
  );
  const t =
    u >= 0.5 ? Math.pow(u, 0.55) : 1 - Math.pow(1 - u, 0.55);

  return {
    backgroundColor: sampleViridis(t),
    isBrightYellow: t > 0.62,
  };
}

export function HeatmapTable() {
  const activeTicker = useDashboardStore((state) => state.activeTicker);
  const spotPrice = useDashboardStore((state) => state.spotPrice);
  const impliedVolatility = useDashboardStore((state) => state.impliedVolatility);
  const strikeStep = useDashboardStore((state) => state.strikeStep);
  const gammaLevels = useDashboardStore((state) => state.gammaLevels);
  const kingNode = useDashboardStore((state) => state.kingNode);
  const expectedMoves = useDashboardStore((state) => state.expectedMoves);
  const chainExpirations = useDashboardStore((state) => state.chainExpirations);
  const chainStrikes = useDashboardStore((state) => state.chainStrikes);
  const intradayData = useDashboardStore((state) => state.intradayData);
  const metric = useDashboardStore((state) => state.gridFilters.metric);
  const expirationFilter = useDashboardStore(
    (state) => state.gridFilters.expiration
  );
  const setFilters = useDashboardStore((state) => state.setFilters);

  const [displayMode, setDisplayMode] = useState<"Grid" | "3D Surface">("Grid");
  const [cellMode, setCellMode] = useState<"Value" | "DeltaOpen" | "Velocity">("Value");
  const [zoom, setZoom] = useState<number>(1);
  const [pickedDateCol, setPickedDateCol] = useState<string>("");
  const [replayIndex, setReplayIndex] = useState<number>(100);

  const preset = getTickerPreset(activeTicker);
  const hasZeroDte = kingNode.hasZeroDte ?? true;

  // All available columns in the chain
  const allColumns: ExpirationColMeta[] = useMemo(() => {
    if (chainExpirations.length > 0) {
      return chainExpirations.map((exp, idx) => ({
        id: exp.id,
        isoDate: exp.isoDate,
        tag: exp.tag,
        filterGroup: exp.filterGroup,
        inThisWeek: exp.inThisWeek,
        dateLabel: exp.dateLabel,
        dteWeight: idx === 0 ? 1.45 : idx >= 8 ? 1.5 : 0.85,
      }));
    }
    return FALLBACK_EXPIRATION_COLUMNS;
  }, [chainExpirations]);

  // Visible columns filtered by active expiration filter (matching TerraShade cols())
  const activeColumns: ExpirationColMeta[] = useMemo(() => {
    if (expirationFilter === "ALL" && !pickedDateCol) {
      return allColumns;
    }
    if (pickedDateCol) {
      const matched = allColumns.filter(
        (c) => c.dateLabel === pickedDateCol || c.isoDate === pickedDateCol
      );
      return matched.length > 0 ? matched : allColumns;
    }
    if (expirationFilter === "0DTE") {
      return allColumns.slice(0, 1);
    }
    if (expirationFilter === "THIS_WEEK") {
      const wk = allColumns.filter((c) => c.inThisWeek);
      return wk.length > 0 ? wk : allColumns.slice(0, Math.min(5, allColumns.length));
    }
    if (expirationFilter === "OPEX") {
      const op = allColumns.filter((c) => c.filterGroup === "OPEX");
      return op.length > 0 ? op : allColumns;
    }
    const byDate = allColumns.filter(
      (c) => c.dateLabel === expirationFilter || c.isoDate === expirationFilter
    );
    return byDate.length > 0 ? byDate : allColumns;
  }, [allColumns, expirationFilter, pickedDateCol]);

  // 4-Horizon Expected Move bounds (Daily D, Weekly W, Monthly M, Annual A)
  const emHorizons = useMemo(() => {
    const approx = (days: number) =>
      0.85 *
      spotPrice *
      impliedVolatility *
      Math.sqrt(days / 252) *
      Math.sqrt(2 / Math.PI) *
      2;

    const dLow = expectedMoves?.daily?.low ?? spotPrice - approx(1);
    const dHigh = expectedMoves?.daily?.high ?? spotPrice + approx(1);
    const wLow = expectedMoves?.weekly?.low ?? spotPrice - approx(5);
    const wHigh = expectedMoves?.weekly?.high ?? spotPrice + approx(5);
    const mLow = expectedMoves?.monthly?.low ?? spotPrice - approx(21);
    const mHigh = expectedMoves?.monthly?.high ?? spotPrice + approx(21);

    const list: {
      code: string;
      color: string;
      low: number;
      high: number;
    }[] = [
      { code: "D", color: "#ffffff", low: dLow, high: dHigh },
      { code: "W", color: "#facc15", low: wLow, high: wHigh },
      { code: "M", color: "#fb923c", low: mLow, high: mHigh },
    ];

    const isAnnualSupported = ["SPX", "SPXW", "SPY", "QQQ"].includes(
      activeTicker.toUpperCase()
    );

    const annual = isAnnualSupported
      ? (expectedMoves?.annual ??
        (activeTicker === "SPY"
          ? { low: 567.74, high: 796.1 }
          : activeTicker === "SPXW" || activeTicker === "SPX"
            ? { low: 5677.4, high: 7961.0 }
            : activeTicker === "QQQ"
              ? { low: 487.45, high: 704.35 }
              : null))
      : null;

    if (annual) {
      list.push({
        code: "A",
        color: "#f87171",
        low: annual.low,
        high: annual.high,
      });
    }

    return list;
  }, [expectedMoves, spotPrice, impliedVolatility, activeTicker]);

  const {
    rowsData,
    maxColumnValues,
    atmRowIndex,
    activeKingStrike,
    activeKingColId,
    topFiveCellKeys,
  } = useMemo(() => {
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

      const multiMap = new Map<number, EmMarkerTag[]>();
      const pushTag = (idx: number, item: EmMarkerTag) => {
        const arr = multiMap.get(idx) ?? [];
        arr.push(item);
        multiMap.set(idx, arr);
      };

      for (const h of emHorizons) {
        pushTag(findNearestIdx(h.high), {
          tag: `${h.code}↑`,
          color: h.color,
          side: "high",
        });
        pushTag(findNearestIdx(h.low), {
          tag: `${h.code}↓`,
          color: h.color,
          side: "low",
        });
      }
      return multiMap;
    };

    const targetKingStrike =
      expirationFilter === "ALL" && !pickedDateCol
        ? kingNode.allExpKing
        : kingNode.filteredKing ?? kingNode.allExpKing;

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
      const allCellMags: { key: string; mag: number }[] = [];
      let bestKingColId = activeColumns[0]?.id ?? "exp_0";
      let bestKingColMag = -1;

      const rows: StrikeRowData[] = chainStrikes.map((sRow, idx) => {
        const metricValues =
          metric === "GEX"
            ? sRow.gex
            : metric === "VEX"
              ? sRow.vex
              : metric === "DEX"
                ? sRow.dex
                : sRow.charm;

        let peakColId = activeColumns[0]?.id ?? sRow.kingPeakColId;
        let maxAbsInRow = -1;
        const isTargetKingRow =
          Math.abs(sRow.strike - targetKingStrike) < strikeStep * 0.4;

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
          if (isTargetKingRow && absVal > bestKingColMag) {
            bestKingColMag = absVal;
            bestKingColId = col.id;
          }
          allCellMags.push({ key: `${sRow.strike}_${col.id}`, mag: absVal });
        }

        const markers = emMap.get(idx) ?? [];

        return {
          strike: sRow.strike,
          isAtm: idx === bestAtmIdx,
          isKingNode:
            Math.abs(sRow.strike - kingNode.allExpKing) < strikeStep * 0.4,
          isFilteredKing: isTargetKingRow,
          isCallWall:
            Math.abs(sRow.strike - gammaLevels.callWall) < strikeStep * 0.4,
          isPutWall:
            Math.abs(sRow.strike - gammaLevels.putWall) < strikeStep * 0.4,
          isZeroGamma: idx === bestZeroIdx,
          emMarker: markers.length > 0 ? markers.map((m) => m.tag).join(" ") : null,
          emMarkers: markers,
          kingPeakColId: peakColId,
          values: metricValues,
          openPctChange: sRow.openPctChange,
        };
      });

      allCellMags.sort((a, b) => b.mag - a.mag);
      const topSet = new Set(allCellMags.slice(0, 5).map((x) => x.key));

      return {
        rowsData: rows,
        maxColumnValues: colMax,
        atmRowIndex: bestAtmIdx,
        activeKingStrike: targetKingStrike,
        activeKingColId: bestKingColId,
        topFiveCellKeys: topSet,
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
    let bestKingColId = activeColumns[0]?.id ?? "exp_0";
    let bestKingColMag = -1;
    const allCellMags: { key: string; mag: number }[] = [];

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
        Math.abs(strike - targetKingStrike) < strikeStep * 0.4;
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
      let kingPeakColId = activeColumns[0]?.id ?? "exp_0";
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
        if (isFilteredKing && Math.abs(rounded) > bestKingColMag) {
          bestKingColMag = Math.abs(rounded);
          bestKingColId = col.id;
        }

        const absVal = Math.abs(rounded);
        if (absVal > colMax[col.id]) {
          colMax[col.id] = absVal;
        }
        allCellMags.push({ key: `${strike}_${col.id}`, mag: absVal });
      });

      const markers = emMap.get(i) ?? [];

      rows.push({
        strike,
        isAtm,
        isKingNode,
        isFilteredKing,
        isCallWall,
        isPutWall,
        isZeroGamma,
        emMarker: markers.length > 0 ? markers.map((m) => m.tag).join(" ") : null,
        emMarkers: markers,
        kingPeakColId,
        values,
        openPctChange,
      });
    }

    allCellMags.sort((a, b) => b.mag - a.mag);
    const topSet = new Set(allCellMags.slice(0, 5).map((x) => x.key));

    return {
      rowsData: rows,
      maxColumnValues: colMax,
      atmRowIndex: foundAtmIndex,
      activeKingStrike: targetKingStrike,
      activeKingColId: bestKingColId,
      topFiveCellKeys: topSet,
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
    expirationFilter,
    pickedDateCol,
    metric,
    emHorizons,
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
          isFilteredKing,
          emMarkers = [],
        } = row.original;

        return (
          <div
            className={cn(
              "flex items-center justify-between px-2.5 h-full font-mono text-[11px] tabular-nums select-none",
              isAtm
                ? "bg-[#13254a] text-[#60a5fa] font-bold shadow-[inset_4px_0_0_#3b82f6]"
                : isFilteredKing
                  ? "text-[#facc15] font-bold"
                  : "text-slate-200 font-semibold"
            )}
          >
            <div className="flex items-center gap-1">
              {emMarkers.map((m) => (
                <span
                  key={m.tag}
                  style={{ color: m.color }}
                  className="text-[9px] font-extrabold leading-none"
                >
                  {m.tag}
                </span>
              ))}
            </div>
            <span>{strike.toFixed(strike % 1 !== 0 ? 1 : 0)}</span>
          </div>
        );
      },
    };

    const expCols: ColumnDef<StrikeRowData>[] = activeColumns.map(
      (expCol) => {
        return {
          id: expCol.id,
          header: () => (
            <div className="flex flex-col items-center justify-center px-1.5 py-1.5 font-mono">
              <span className="text-[11px] font-bold text-slate-300">
                {expCol.dateLabel}
              </span>
              <span
                className={cn(
                  "text-[8px] font-semibold uppercase",
                  expCol.tag === "0DTE"
                    ? "text-rose-400"
                    : expCol.tag === "OPEX"
                      ? "text-cyan-300"
                      : "text-slate-500"
                )}
              >
                {expCol.tag}
              </span>
            </div>
          ),
          cell: ({ row }) => {
            const rawCellValue = row.original.values[expCol.id] ?? 0;
            const replayScale =
              replayIndex < 100 ? 0.72 + (replayIndex / 100) * 0.28 : 1;
            const cellValue =
              cellMode === "Velocity"
                ? rawCellValue * ((row.original.openPctChange[expCol.id] ?? 0) / 100)
                : rawCellValue * replayScale;

            const maxColumnValue =
              cellMode === "Velocity"
                ? Math.max(0.1, (maxColumnValues[expCol.id] || 1) * 0.35)
                : maxColumnValues[expCol.id] || 1;

            const isOneGoldGlowKingCell =
              cellMode !== "Velocity" &&
              row.original.isFilteredKing &&
              expCol.id === activeKingColId;

            const { backgroundColor, isBrightYellow } = getHyperionCellStyle(
              cellValue,
              maxColumnValue,
              isOneGoldGlowKingCell
            );

            const formattedVal = formatExposure(cellValue);
            const pctSinceOpen = row.original.openPctChange[expCol.id] ?? 0;
            const formattedPct = `${pctSinceOpen >= 0 ? "+" : ""}${pctSinceOpen}%`;

            // TerraShade shows % change badge on GEX cells for top 5 largest magnitude cells and strikes within 1% of spot
            const isNearSpot =
              spotPrice > 0 &&
              Math.abs(row.original.strike - spotPrice) / spotPrice <= 0.01;
            const isTopFive = topFiveCellKeys.has(
              `${row.original.strike}_${expCol.id}`
            );
            const showTopRightBadge =
              metric === "GEX" &&
              cellMode === "Value" &&
              (isTopFive || isNearSpot) &&
              Math.abs(pctSinceOpen) >= 1 &&
              Math.abs(pctSinceOpen) <= 999;

            // Expected Move horizontal boundary line shadows (D white, W yellow, M orange, A coral)
            const emMarkers = row.original.emMarkers ?? [];
            const boxShadows: string[] = [];
            for (const m of emMarkers) {
              if (m.side === "high") {
                boxShadows.push(`inset 0 2px 0 ${m.color}`);
              } else {
                boxShadows.push(`inset 0 -2px 0 ${m.color}`);
              }
            }
            if (isOneGoldGlowKingCell) {
              boxShadows.push(
                "0 0 0 1px #facc15, 0 0 8px 1px rgba(250,204,21,0.8)"
              );
            }

            return (
              <div
                style={{
                  backgroundColor,
                  boxShadow:
                    boxShadows.length > 0 ? boxShadows.join(", ") : undefined,
                }}
                className={cn(
                  "relative flex items-center justify-end px-1.5 h-full font-mono text-[11px] tabular-nums transition-colors select-none",
                  isOneGoldGlowKingCell
                    ? "text-black font-extrabold z-20"
                    : isBrightYellow
                      ? "text-[#0a0e17] font-semibold"
                      : "text-[#f1f5f9] font-medium"
                )}
              >
                {showTopRightBadge && (
                  <span
                    className={cn(
                      "absolute top-0.5 right-1 leading-none text-[8px] font-bold pointer-events-none",
                      isOneGoldGlowKingCell || isBrightYellow
                        ? "text-[#0a0e17]/80"
                        : "text-white/85 drop-shadow-[0_1px_2px_rgba(0,0,0,0.85)]"
                    )}
                  >
                    {formattedPct}
                  </span>
                )}

                <span>
                  {cellMode === "DeltaOpen" ? formattedPct : formattedVal}
                </span>
              </div>
            );
          },
        };
      }
    );

    return [strikeCol, ...expCols];
  }, [
    activeColumns,
    maxColumnValues,
    activeKingColId,
    cellMode,
    replayIndex,
    metric,
    spotPrice,
    topFiveCellKeys,
  ]);

  const table = useReactTable({
    data: rowsData,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  const tableRows = table.getRowModel().rows;
  const parentRef = useRef<HTMLDivElement | null>(null);
  const rowHeight = Math.round(28 * zoom);

  const rowVirtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan: 16,
  });

  const resetZoomAndCenter = () => {
    setZoom(1);
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

  const gridTemplate = `110px repeat(${activeColumns.length}, minmax(74px, 1fr))`;
  const replayTimeLabel =
    replayIndex >= 100
      ? "Live"
      : intradayData[
          Math.min(
            intradayData.length - 1,
            Math.floor((replayIndex / 100) * Math.max(0, intradayData.length - 1))
          )
        ]?.time ?? "Live";

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
                  "px-2.5 py-1 rounded-full text-[11px] font-mono font-bold transition-all cursor-pointer",
                  metric === m
                    ? "bg-[#1c223a] border border-[#5e72e4] text-white shadow-[0_0_10px_rgba(94,114,228,0.5)]"
                    : "text-slate-400 hover:text-white"
                )}
              >
                {m}
              </ToggleGroup.Item>
            ))}
          </ToggleGroup.Root>

          {/* 2. [All exp | This week | 0DTE/Next exp | Date ▾] */}
          <div className="inline-flex items-center rounded-full bg-[#0b0d17] p-0.5 border border-white/10">
            {[
              { value: "ALL", label: "All exp" },
              { value: "THIS_WEEK", label: "This week" },
              { value: "0DTE", label: hasZeroDte ? "0DTE" : "Next exp" },
            ].map((exp) => (
              <button
                key={exp.value}
                type="button"
                onClick={() => {
                  setPickedDateCol("");
                  setFilters({ expiration: exp.value });
                }}
                className={cn(
                  "px-2.5 py-1 rounded-full text-[11px] font-mono font-semibold transition-all cursor-pointer",
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
              {allColumns.map((c) => (
                <option key={c.id} value={c.dateLabel} className="bg-[#111422]">
                  {c.dateLabel}
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
                  "px-2.5 py-1 rounded-full text-[11px] font-mono font-semibold transition-all cursor-pointer",
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
                "px-2.5 py-1 rounded-full text-[11px] font-mono font-semibold transition-all cursor-pointer",
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
                "px-2.5 py-1 rounded-full text-[11px] font-mono font-semibold transition-all cursor-pointer",
                cellMode === "DeltaOpen"
                  ? "bg-[#1c223a] border border-[#5e72e4] text-white"
                  : "text-slate-400 hover:text-white"
              )}
            >
              Δ since open
            </button>
          </div>
        </div>

        {/* Right Controls: [Share to X] */}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={handleShareToX}
            className="inline-flex items-center gap-1 rounded-full bg-[#0b0d17] hover:bg-[#1c223a] border border-white/15 px-3 py-1 text-[11px] font-mono font-semibold text-slate-200 transition-colors cursor-pointer"
          >
            <Share2 className="h-3 w-3 text-[#11cdef]" />
            <span>Share to X</span>
          </button>
        </div>
      </div>

      {/* TerraShade Zoom & Replay Control Bar (.zbar): − | + | Reset | Velocity | Live | Scrubber */}
      <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
        <button
          type="button"
          onClick={() => setZoom((z) => Math.max(0.6, Number((z - 0.15).toFixed(2))))}
          className="px-3 py-1 rounded-lg bg-[#111520] border border-[#243044] text-slate-200 hover:border-slate-500 cursor-pointer"
          title="Zoom out"
        >
          −
        </button>
        <button
          type="button"
          onClick={() => setZoom((z) => Math.min(1.6, Number((z + 0.15).toFixed(2))))}
          className="px-3 py-1 rounded-lg bg-[#111520] border border-[#243044] text-slate-200 hover:border-slate-500 cursor-pointer"
          title="Zoom in"
        >
          +
        </button>
        <button
          type="button"
          onClick={resetZoomAndCenter}
          className="px-3 py-1 rounded-lg bg-[#111520] border border-[#243044] text-slate-200 hover:border-slate-500 cursor-pointer"
        >
          Reset
        </button>

        {/* Heatmap Replay & Velocity Controls */}
        <div className="flex items-center gap-2 ml-auto flex-1 min-w-[260px] max-w-[440px]">
          <button
            type="button"
            onClick={() =>
              setCellMode((m) => (m === "Velocity" ? "Value" : "Velocity"))
            }
            className={cn(
              "px-3 py-1 rounded-lg border transition-colors cursor-pointer",
              cellMode === "Velocity"
                ? "bg-amber-400/15 border-amber-400 text-amber-300 font-bold"
                : "bg-[#111520] border-[#243044] text-slate-200 hover:border-slate-500"
            )}
            title="Show GEX change over recent snapshots (velocity)"
          >
            Velocity
          </button>
          <button
            type="button"
            onClick={() => {
              setReplayIndex(100);
              if (cellMode === "Velocity") setCellMode("Value");
            }}
            className={cn(
              "px-3 py-1 rounded-lg border transition-colors cursor-pointer",
              replayIndex === 100 && cellMode !== "Velocity"
                ? "bg-emerald-500/15 border-emerald-400 text-emerald-300 font-bold"
                : "bg-[#111520] border-[#243044] text-slate-200 hover:border-slate-500"
            )}
          >
            Live
          </button>
          <input
            type="range"
            min={0}
            max={100}
            value={replayIndex}
            aria-label="Heatmap snapshot replay"
            onChange={(e) => setReplayIndex(Number(e.target.value))}
            className="flex-1 accent-[#38bdf8] cursor-pointer"
          />
          <span className="text-[11px] text-slate-400 min-w-[60px] text-right tabular-nums">
            {cellMode === "Velocity" ? "Δ$ Vel" : replayTimeLabel}
          </span>
        </div>
      </div>

      {/* King Node & Expected Move Horizon Legend Subbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono">
        <div className="flex flex-wrap items-center gap-3 text-slate-400">
          <span className="text-[#facc15] font-bold">
            ★{" "}
            {expirationFilter === "ALL" && !pickedDateCol
              ? `All-exp King ${kingNode.allExpKing.toFixed(0)}`
              : `${kingNode.filteredLabel} · All-exp King ${kingNode.allExpKing.toFixed(0)}`}
            {kingNode.isContested ? " · contested" : ""}
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-2.5 w-2.5 rounded-sm bg-[#440154] inline-block" />
            <span>Neg γ</span>
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-2.5 w-2.5 rounded-sm bg-[#21918c] inline-block" />
            <span>Zero</span>
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-2.5 w-2.5 rounded-sm bg-[#fde725] inline-block" />
            <span>Pos γ</span>
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-slate-400">
          <span>EM Lines:</span>
          <span className="text-white font-bold">D↑/D↓</span>
          <span className="text-[#facc15] font-bold">W↑/W↓</span>
          <span className="text-[#fb923c] font-bold">M↑/M↓</span>
          <span className="text-[#f87171] font-bold">A↑/A↓</span>
        </div>
      </div>

      {displayMode === "3D Surface" ? (
        <Surface3DView
          ticker={activeTicker}
          spotPrice={spotPrice}
          metric={metric}
          kingStrike={activeKingStrike}
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
          className="relative h-[580px] w-full overflow-auto argon-scrollbar rounded-lg border border-[#1c2333] bg-[#0a0c12]"
        >
          {/* Sticky Header */}
          <div
            style={{
              gridTemplateColumns: gridTemplate,
              minWidth: `${110 + activeColumns.length * 76}px`,
            }}
            className="sticky top-0 z-30 grid bg-[#0f131d] border-b border-[#1c2333] shadow-md"
          >
            {table.getHeaderGroups().map((headerGroup) =>
              headerGroup.headers.map((header, idx) => (
                <div
                  key={header.id}
                  className={cn(
                    "border-r border-[#141926] last:border-r-0",
                    idx === 0 &&
                      "sticky left-0 z-40 bg-[#0f131d] border-r border-[#243044]"
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
              minWidth: `${110 + activeColumns.length * 76}px`,
            }}
          >
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const row = tableRows[virtualRow.index];
              const { isAtm } = row.original;

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
                  className="grid border-b border-[#141926]"
                >
                  {row.getVisibleCells().map((cell, cellIdx) => {
                    const isStrikeCol = cellIdx === 0;
                    return (
                      <div
                        key={cell.id}
                        className={cn(
                          "h-full border-r border-[#141926] last:border-r-0",
                          isStrikeCol &&
                            cn(
                              "sticky left-0 z-20 border-r border-[#243044]",
                              isAtm ? "bg-[#13254a]" : "bg-[#0d1018]"
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
