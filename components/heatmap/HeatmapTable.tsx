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
  useDashboardStore,
} from "@/store/useDashboardStore";
import { cn } from "@/lib/utils";
import { Crosshair, Crown, Download, Pin, Share2, X } from "lucide-react";
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
  isOutsideTwoSigma?: boolean;
  emMarker: string | null;
  emMarkers?: EmMarkerTag[];
  kingPeakColId: string;
  values: Record<string, number>;
  gexValues?: Record<string, number>;
  vexValues?: Record<string, number>;
  dexValues?: Record<string, number>;
  charmValues?: Record<string, number>;
  openPctChange: Record<string, number>;
}

const METRIC_OPTIONS: ExposureMetric[] = ["GEX", "VEX", "DEX", "Charm"];

/**
 * Dark Cockpit Signed Heatmap Color Scale:
 * Negative runs deep indigo to purple (HNEG), positive runs dark emerald to cyan (HPOS), zero is slate (HZERO).
 * Gold (#facc15) is reserved exclusively for King Nodes (never used in continuous gradients).
 */
const HNEG: [number, number, number][] = [
  [22, 28, 62],
  [76, 38, 146],
  [147, 51, 234],
];
const HPOS: [number, number, number][] = [
  [14, 52, 46],
  [16, 138, 102],
  [34, 211, 238],
];
const HZERO = "rgb(18, 25, 38)";

function ramp3(
  stops: [number, number, number][],
  t: number
): [number, number, number] {
  const scaled = Math.max(0, Math.min(1, t)) * 2;
  const i = Math.min(1, Math.floor(scaled));
  const f = scaled - i;
  const a = stops[i];
  const b = stops[i + 1];
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

export function formatHeatmapCell(valInMillions: number): string {
  const absDollars = Math.abs(valInMillions) * 1e6;
  if (absDollars < 1) return "–";
  const s = valInMillions < 0 ? "-" : "+";
  if (absDollars >= 1e6) {
    const n = absDollars / 1e6;
    return `${s}${n >= 10 ? Math.round(n) : n.toFixed(1)}M`;
  }
  if (absDollars >= 1e3) {
    const n = absDollars / 1e3;
    return `${s}${n >= 10 ? Math.round(n) : n.toFixed(1)}K`;
  }
  return `${s}${Math.round(absDollars)}`;
}

export function getHyperionCellStyle(
  cellValue: number,
  maxAbsValue: number,
  isKingCell: boolean
): { backgroundColor: string; isBrightYellow: boolean; isZeroCell?: boolean } {
  if (isKingCell) {
    return {
      backgroundColor: "#facc15",
      isBrightYellow: true,
      isZeroCell: false,
    };
  }

  const absDollars = Math.abs(cellValue) * 1e6;
  if (!(maxAbsValue > 0) || absDollars < 1) {
    return {
      backgroundColor: HZERO,
      isBrightYellow: false,
      isZeroCell: true,
    };
  }

  const norm = Math.min(1, Math.abs(cellValue) / Math.max(0.0001, maxAbsValue));
  const d = 0.14 + 0.86 * Math.pow(norm, 1.45);
  const pos = cellValue > 0;
  const [r, g, b] = ramp3(pos ? HPOS : HNEG, d);

  return {
    backgroundColor: `rgb(${r}, ${g}, ${b})`,
    isBrightYellow: pos && d > 0.78,
    isZeroCell: false,
  };
}

function formatHeatmapStrike(strike: number): string {
  if (!Number.isFinite(strike) || strike <= 0) return "—";
  return strike % 1 !== 0 ? Number(strike.toFixed(2)).toString() : strike.toFixed(0);
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
  const [inspectedCell, setInspectedCell] = useState<{
    strike: number;
    colId: string;
    pinned?: boolean;
  } | null>(null);
  const pinnedCellKey =
    inspectedCell?.pinned ? `${inspectedCell.strike}_${inspectedCell.colId}` : null;

  useEffect(() => {
    setPickedDateCol("");
    setInspectedCell(null);
    setReplayIndex(100);
  }, [activeTicker]);

  const hasZeroDte =
    kingNode.hasZeroDte ?? chainExpirations.some((c) => c.tag === "0DTE");

  // All available columns in the chain
  const allColumns: ExpirationColMeta[] = useMemo(() => {
    return chainExpirations.map((exp, idx) => ({
      id: exp.id,
      isoDate: exp.isoDate,
      tag: exp.tag,
      filterGroup: exp.filterGroup,
      inThisWeek: exp.inThisWeek,
      dateLabel: exp.dateLabel,
      dteWeight: idx === 0 ? 1.45 : idx >= 8 ? 1.5 : 0.85,
    }));
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
    const hasLiveInputs =
      Number.isFinite(spotPrice) &&
      spotPrice > 0 &&
      Number.isFinite(impliedVolatility) &&
      impliedVolatility > 0;
    if (!expectedMoves && !hasLiveInputs) {
      return [];
    }
    const approx = (days: number) =>
      hasLiveInputs ? spotPrice * (impliedVolatility / Math.sqrt(252)) * Math.sqrt(days) : 0;

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
      { code: "D", color: "#cbd5e1", low: dLow, high: dHigh },
      { code: "W", color: "#facc15", low: wLow, high: wHigh },
      { code: "M", color: "#fb923c", low: mLow, high: mHigh },
    ];

    const isAnnualSupported = ["SPX", "SPXW", "SPY", "QQQ"].includes(
      activeTicker.toUpperCase()
    );

    const annual = isAnnualSupported ? (expectedMoves?.annual ?? null) : null;

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
      const multiMap = new Map<number, EmMarkerTag[]>();
      if (strikesList.length === 0) return multiMap;

      let strikeStep = Infinity;
      for (let i = 1; i < strikesList.length; i++) {
        const diff = Math.abs(strikesList[i].strike - strikesList[i - 1].strike);
        if (diff > 0 && diff < strikeStep) strikeStep = diff;
      }
      if (!Number.isFinite(strikeStep)) strikeStep = 1;

      const findNearestIdx = (target: number): number | null => {
        if (!Number.isFinite(target) || target <= 0) return null;
        let bestIdx = -1;
        let bestDiff = Infinity;
        strikesList.forEach((r, idx) => {
          const d = Math.abs(r.strike - target);
          if (d < bestDiff) {
            bestDiff = d;
            bestIdx = idx;
          }
        });
        if (bestIdx < 0 || bestDiff > Math.max(strikeStep * 2, 1)) {
          return null;
        }
        return bestIdx;
      };

      const pushTag = (idx: number, item: EmMarkerTag) => {
        const arr = multiMap.get(idx) ?? [];
        arr.push(item);
        multiMap.set(idx, arr);
      };

      for (const h of emHorizons) {
        const highIdx = findNearestIdx(h.high);
        if (highIdx !== null) {
          pushTag(highIdx, {
            tag: `${h.code}↑`,
            color: h.color,
            side: "high",
          });
        }
        const lowIdx = findNearestIdx(h.low);
        if (lowIdx !== null) {
          pushTag(lowIdx, {
            tag: `${h.code}↓`,
            color: h.color,
            side: "low",
          });
        }
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

      // Dynamically resolve the true King strike across allColumns and activeColumns for the active metric
      let computedAllKingStrike = kingNode.allExpKing;
      let maxAllRowAbs = -1;
      let computedFilteredKingStrike = targetKingStrike;
      let maxFilteredRowAbs = -1;

      for (const sRow of chainStrikes) {
        const metricValues =
          metric === "GEX"
            ? sRow.gex
            : metric === "VEX"
              ? sRow.vex
              : metric === "DEX"
                ? sRow.dex
                : sRow.charm;

        let allSum = 0;
        for (const col of allColumns) {
          const raw = metricValues[col.id] ?? 0;
          allSum += Number.isFinite(raw) ? raw : 0;
        }
        if (Math.abs(allSum) > maxAllRowAbs) {
          maxAllRowAbs = Math.abs(allSum);
          computedAllKingStrike = sRow.strike;
        }

        let activeSum = 0;
        for (const col of activeColumns) {
          const raw = metricValues[col.id] ?? 0;
          activeSum += Number.isFinite(raw) ? raw : 0;
        }
        if (Math.abs(activeSum) > maxFilteredRowAbs) {
          maxFilteredRowAbs = Math.abs(activeSum);
          computedFilteredKingStrike = sRow.strike;
        }
      }

      const resolvedAllKingStrike =
        maxAllRowAbs > 0 ? computedAllKingStrike : kingNode.allExpKing;
      const resolvedKingStrike =
        maxFilteredRowAbs > 0 ? computedFilteredKingStrike : targetKingStrike;

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
          Math.abs(sRow.strike - resolvedKingStrike) < strikeStep * 0.4;

        for (const col of activeColumns) {
          const rawVal = metricValues[col.id] ?? 0;
          const val = Number.isFinite(rawVal) ? rawVal : 0;
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

        const isCallWallRow =
          Math.abs(sRow.strike - gammaLevels.callWall) < strikeStep * 0.4;
        const isPutWallRow =
          Math.abs(sRow.strike - gammaLevels.putWall) < strikeStep * 0.4;
        const isZeroGammaRow = idx === bestZeroIdx;
        const isKingRow =
          Math.abs(sRow.strike - resolvedAllKingStrike) < strikeStep * 0.4;
        const dailyEmVal = expectedMoves?.daily?.em ?? 0;
        const isOutsideTwoSigma =
          dailyEmVal > 0 &&
          spotPrice > 0 &&
          Math.abs(sRow.strike - spotPrice) > dailyEmVal * 2 &&
          !isKingRow &&
          !isTargetKingRow &&
          !isCallWallRow &&
          !isPutWallRow &&
          !isZeroGammaRow &&
          idx !== bestAtmIdx;

        return {
          strike: sRow.strike,
          isAtm: idx === bestAtmIdx,
          isKingNode: isKingRow,
          isFilteredKing: isTargetKingRow,
          isCallWall: isCallWallRow,
          isPutWall: isPutWallRow,
          isZeroGamma: isZeroGammaRow,
          isOutsideTwoSigma,
          emMarker: markers.length > 0 ? markers.map((m) => m.tag).join(" ") : null,
          emMarkers: markers,
          kingPeakColId: peakColId,
          values: metricValues,
          gexValues: sRow.gex,
          vexValues: sRow.vex,
          dexValues: sRow.dex,
          charmValues: sRow.charm,
          openPctChange: sRow.openPctChange,
        };
      });

      allCellMags.sort((a, b) => b.mag - a.mag);
      const topSet = new Set(allCellMags.slice(0, 5).map((x) => x.key));

      return {
        rowsData: rows,
        maxColumnValues: colMax,
        atmRowIndex: bestAtmIdx,
        activeKingStrike: resolvedKingStrike,
        activeKingColId: bestKingColId,
        topFiveCellKeys: topSet,
      };
    }

    // Strict Live Invariant: Return honest empty state when live chain is syncing
    return {
      rowsData: [],
      maxColumnValues: {},
      atmRowIndex: -1,
      activeKingStrike: kingNode.allExpKing || 0,
      activeKingColId: "",
      topFiveCellKeys: new Set<string>(),
    };
  }, [
    chainStrikes,
    allColumns,
    activeColumns,
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

  const globalMaxAbs = useMemo(() => {
    const vals = Object.values(maxColumnValues);
    return vals.length > 0 ? Math.max(0.001, ...vals) : 1;
  }, [maxColumnValues]);

  const columns = useMemo<ColumnDef<StrikeRowData>[]>(() => {
    const strikeCol: ColumnDef<StrikeRowData> = {
      id: "strike",
      header: () => (
        <div className="flex items-center justify-center px-2 py-2 text-[10px] font-mono font-bold uppercase tracking-wider text-slate-300">
          <span>Strike</span>
        </div>
      ),
      cell: ({ row }) => {
        const {
          strike,
          isAtm,
          isFilteredKing,
          isCallWall,
          isPutWall,
          isZeroGamma,
          emMarkers = [],
        } = row.original;

        const strikeShadows: string[] = [];
        emMarkers.forEach((m, idx) => {
          if (m.side === "high") {
            strikeShadows.push(`inset 0 ${2 + idx * 2}px 0 ${m.color}`);
          } else {
            strikeShadows.push(`inset 0 -${2 + idx * 2}px 0 ${m.color}`);
          }
        });
        if (isAtm) {
          strikeShadows.push("inset 4px 0 0 #3b82f6");
        }

        return (
          <div
            style={{
              boxShadow:
                strikeShadows.length > 0 ? strikeShadows.join(", ") : undefined,
            }}
            className={cn(
              "flex flex-col items-center justify-center px-1.5 h-full font-mono text-[11px] tabular-nums select-none leading-none",
              row.original.isOutsideTwoSigma && "opacity-35",
              isAtm
                ? "bg-[#13254a] text-[#60a5fa] font-bold"
                : isFilteredKing
                  ? "bg-[#0b1220] text-[#facc15] font-bold"
                  : "bg-[#0b1220] text-slate-200 font-bold"
            )}
          >
            <span>{formatHeatmapStrike(strike)}</span>
            {(isCallWall || isPutWall || isZeroGamma) && (
              <div className="flex items-center justify-center gap-0.5 mt-[1px]">
                {isCallWall && (
                  <span className="text-[7.5px] font-extrabold text-[#22d3ee] leading-none" title="Call Wall">
                    CW
                  </span>
                )}
                {isPutWall && (
                  <span className="text-[7.5px] font-extrabold text-[#c084fc] leading-none" title="Put Wall">
                    PW
                  </span>
                )}
                {isZeroGamma && (
                  <span className="text-[7.5px] font-extrabold text-[#fbbf24] leading-none" title="Zero Gamma">
                    0Γ
                  </span>
                )}
              </div>
            )}
            {emMarkers.length > 0 && (
              <div className="flex items-center justify-center gap-0.5 mt-[2px]">
                {emMarkers.map((m) => (
                  <span
                    key={m.tag}
                    style={{ color: m.color }}
                    className="text-[8px] font-extrabold leading-none"
                  >
                    {m.tag}
                  </span>
                ))}
              </div>
            )}
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
            const rawVal = row.original.values[expCol.id] ?? 0;
            const rawCellValue = Number.isFinite(rawVal) ? rawVal : 0;
            const cellValue =
              cellMode === "Velocity"
                ? rawCellValue * ((row.original.openPctChange[expCol.id] ?? 0) / 100)
                : rawCellValue;

            const maxMatrixValue =
              cellMode === "Velocity"
                ? Math.max(0.1, globalMaxAbs * 0.35)
                : globalMaxAbs;

            const isOneGoldGlowKingCell =
              cellMode !== "Velocity" &&
              row.original.isFilteredKing &&
              expCol.id === activeKingColId;

            const { backgroundColor, isBrightYellow, isZeroCell } =
              getHyperionCellStyle(
                cellValue,
                maxMatrixValue,
                isOneGoldGlowKingCell
              );

            const formattedVal = formatHeatmapCell(cellValue);
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
              cellMode === "Value" &&
              !isZeroCell &&
              (isTopFive || isNearSpot) &&
              Math.abs(pctSinceOpen) >= 1 &&
              Math.abs(pctSinceOpen) <= 999;

            // Expected Move horizontal boundary line shadows (D white, W yellow, M orange, A coral)
            const emMarkers = row.original.emMarkers ?? [];
            const boxShadows: string[] = [];
            emMarkers.forEach((m, idx) => {
              if (m.side === "high") {
                boxShadows.push(`inset 0 ${2 + idx * 2}px 0 ${m.color}`);
              } else {
                boxShadows.push(`inset 0 -${2 + idx * 2}px 0 ${m.color}`);
              }
            });
            const isPinnedCell = pinnedCellKey === `${row.original.strike}_${expCol.id}`;

            if (isOneGoldGlowKingCell) {
              boxShadows.push(
                "0 0 0 1px #facc15, 0 0 8px 1px rgba(250,204,21,0.8)"
              );
            } else if (isPinnedCell) {
              boxShadows.push(
                "inset 0 0 0 2px #38bdf8, 0 0 8px rgba(56,189,248,0.65)"
              );
            }

            return (
              <div
                onMouseEnter={() => {
                  setInspectedCell((prev) =>
                    prev?.pinned
                      ? prev
                      : { strike: row.original.strike, colId: expCol.id, pinned: false }
                  );
                }}
                onClick={() => {
                  setInspectedCell((prev) =>
                    prev?.pinned &&
                    prev.strike === row.original.strike &&
                    prev.colId === expCol.id
                      ? null
                      : { strike: row.original.strike, colId: expCol.id, pinned: true }
                  );
                }}
                style={{
                  backgroundColor,
                  boxShadow:
                    boxShadows.length > 0 ? boxShadows.join(", ") : undefined,
                }}
                className={cn(
                  "relative flex items-end justify-end pt-[11px] pb-[2px] px-1.5 h-full font-mono text-[11px] tabular-nums transition-colors select-none cursor-pointer leading-none hover:ring-2 hover:ring-inset hover:ring-[#38bdf8] hover:z-10",
                  row.original.isOutsideTwoSigma && !isOneGoldGlowKingCell && "opacity-30",
                  isOneGoldGlowKingCell
                    ? "text-black font-extrabold z-20"
                    : isZeroCell
                      ? "text-[#475569] font-normal"
                      : isBrightYellow
                        ? "text-[#0b1220] font-bold"
                        : "text-[#e6edf6] font-bold"
                )}
              >
                {showTopRightBadge && (
                  <i
                    className={cn(
                      "absolute top-[3px] right-[2px] z-10 not-italic text-[8px] font-bold leading-none px-[2px] py-[0.5px] rounded-[2px] bg-black/82 pointer-events-none",
                      pctSinceOpen >= 0 ? "text-[#4ade80]" : "text-[#f87171]"
                    )}
                  >
                    {formattedPct}
                  </i>
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
    globalMaxAbs,
    activeKingColId,
    cellMode,
    metric,
    spotPrice,
    topFiveCellKeys,
    pinnedCellKey,
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
    if (atmRowIndex >= 0 && atmRowIndex < tableRows.length) {
      rowVirtualizer.scrollToIndex(atmRowIndex, { align: "center" });
    }
  };

  const jumpToKingRow = () => {
    const kingIdx = rowsData.findIndex((r) => r.isFilteredKing || r.isKingNode);
    if (kingIdx >= 0) {
      rowVirtualizer.scrollToIndex(kingIdx, { align: "center" });
    }
  };

  const handleExportCsv = () => {
    const headers = ["Strike", ...activeColumns.map((c) => `${c.dateLabel} (${c.tag})`)];
    const csvLines = [
      headers.join(","),
      ...rowsData.map((r) => {
        const vals = activeColumns.map((c) => (r.values[c.id] ?? 0).toFixed(2));
        return [r.strike, ...vals].join(",");
      }),
    ];
    const blob = new Blob([csvLines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${activeTicker}_${metric}_${expirationFilter}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  // Resolve inspected cell details
  const activeInspectDetails = useMemo(() => {
    const targetStrike = inspectedCell?.strike ?? rowsData[atmRowIndex]?.strike;
    const targetColId = inspectedCell?.colId ?? activeKingColId ?? activeColumns[0]?.id;
    const rowObj = rowsData.find((r) => r.strike === targetStrike) ?? rowsData[atmRowIndex];
    const colObj = activeColumns.find((c) => c.id === targetColId) ?? activeColumns[0];
    if (!rowObj || !colObj) return null;

    const gexVal = rowObj.gexValues?.[colObj.id] ?? (metric === "GEX" ? rowObj.values[colObj.id] ?? 0 : 0);
    const vexVal = rowObj.vexValues?.[colObj.id] ?? (metric === "VEX" ? rowObj.values[colObj.id] ?? 0 : 0);
    const dexVal = rowObj.dexValues?.[colObj.id] ?? (metric === "DEX" ? rowObj.values[colObj.id] ?? 0 : 0);
    const charmVal = rowObj.charmValues?.[colObj.id] ?? (metric === "Charm" ? rowObj.values[colObj.id] ?? 0 : 0);
    const activeVal = rowObj.values[colObj.id] ?? 0;
    const pctOpen = rowObj.openPctChange[colObj.id] ?? 0;
    const rowNet = activeColumns.reduce((sum, c) => sum + (rowObj.values[c.id] ?? 0), 0);
    const distPts = rowObj.strike - spotPrice;
    const distPct = spotPrice > 0 ? (distPts / spotPrice) * 100 : 0;

    return {
      rowObj,
      colObj,
      gexVal,
      vexVal,
      dexVal,
      charmVal,
      activeVal,
      pctOpen,
      rowNet,
      distPts,
      distPct,
      isPinned: Boolean(inspectedCell?.pinned),
      isLiveHover: Boolean(inspectedCell),
    };
  }, [inspectedCell, rowsData, atmRowIndex, activeKingColId, activeColumns, metric, spotPrice]);

  useEffect(() => {
    if (atmRowIndex < 0 || rowsData.length === 0) return;
    const timer = setTimeout(() => {
      rowVirtualizer.scrollToIndex(atmRowIndex, { align: "center" });
    }, 60);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTicker, chainStrikes.length, atmRowIndex]);

  const handleShareToX = () => {
    const spotLabel = Number.isFinite(spotPrice) && spotPrice > 0 ? spotPrice.toFixed(2) : "—";
    const zgLabel =
      Number.isFinite(gammaLevels.zeroGamma) && gammaLevels.zeroGamma > 0
        ? gammaLevels.zeroGamma.toFixed(2)
        : "—";
    const text = `${activeTicker} $${spotLabel} Options Positioning via Hyperion:\n• All-exp King: $${formatHeatmapStrike(kingNode.allExpKing)} (${kingNode.kingStrength}/100)\n• Call Wall: $${formatHeatmapStrike(gammaLevels.callWall)} | Put Wall: $${formatHeatmapStrike(gammaLevels.putWall)}\n• Zero γ: $${zgLabel}`;
    window.open(
      `https://x.com/intent/tweet?text=${encodeURIComponent(text)}`,
      "_blank",
      "noopener,noreferrer"
    );
  };

  const gridTemplate = `64px repeat(${activeColumns.length}, minmax(66px, 1fr))`;
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
              id="heatmap-date-picker"
              name="heatmapDatePicker"
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

        {/* Right Controls: [Export CSV] */}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={handleExportCsv}
            title="Export active heatmap matrix to CSV"
            className="inline-flex items-center gap-1 rounded-full bg-[#0b0d17] hover:bg-[#1c223a] border border-white/15 px-3 py-1 text-[11px] font-mono font-semibold text-slate-200 transition-colors cursor-pointer"
          >
            <Download className="h-3 w-3 text-emerald-400" />
            <span>CSV</span>
          </button>
        </div>
      </div>

      {/* Zoom & Velocity Control Bar */}
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
          className="px-2.5 py-1 rounded-lg bg-[#111520] border border-[#243044] text-slate-200 hover:border-slate-500 inline-flex items-center gap-1 cursor-pointer"
          title="Reset zoom and center on ATM Spot strike"
        >
          <Crosshair className="w-3 h-3 text-sky-400" />
          <span>Center Spot</span>
        </button>
        <button
          type="button"
          onClick={jumpToKingRow}
          className="px-2.5 py-1 rounded-lg bg-[#111520] border border-amber-500/40 text-amber-300 hover:bg-amber-500/10 inline-flex items-center gap-1 cursor-pointer"
          title="Scroll directly to the King Node strike"
        >
          <Crown className="w-3 h-3 text-[#facc15]" />
          <span>Jump to King</span>
        </button>

        {/* Matrix Velocity & Live Mode Controls */}
        <div className="flex items-center gap-2 ml-auto">
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
          <span className="text-[11px] text-slate-400 min-w-[60px] text-right tabular-nums">
            {cellMode === "Velocity" ? "Δ$ Vel" : replayTimeLabel}
          </span>
        </div>
      </div>

      {/* Interactive Cell Telemetry Inspector Bar */}
      {displayMode === "Grid" && activeInspectDetails && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-[#0d121f] border border-[#1e293b] px-3 py-1.5 text-[11px] font-mono">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1 text-cyan-300 font-bold">
              {activeInspectDetails.isPinned && <Pin className="w-3 h-3 text-amber-400" />}
              <span>
                Strike ${formatHeatmapStrike(activeInspectDetails.rowObj.strike)}
              </span>
            </span>
            <span className="text-slate-400">
              ({activeInspectDetails.distPts >= 0 ? "+" : ""}
              {activeInspectDetails.distPts.toFixed(2)} pts /{" "}
              {activeInspectDetails.distPct >= 0 ? "+" : ""}
              {activeInspectDetails.distPct.toFixed(2)}%)
            </span>
            <span className="px-1.5 py-0.5 rounded bg-white/5 border border-white/10 text-slate-200 font-semibold">
              Exp {activeInspectDetails.colObj.dateLabel} ({activeInspectDetails.colObj.tag})
            </span>
            {activeInspectDetails.rowObj.isFilteredKing && (
              <span className="px-1.5 py-0.5 rounded bg-amber-400/20 border border-amber-400/50 text-[#facc15] font-bold">
                ★ King Strike
              </span>
            )}
            {activeInspectDetails.rowObj.isCallWall && (
              <span className="px-1.5 py-0.5 rounded bg-cyan-500/15 border border-cyan-400/40 text-cyan-300 font-bold">
                Call Wall
              </span>
            )}
            {activeInspectDetails.rowObj.isPutWall && (
              <span className="px-1.5 py-0.5 rounded bg-fuchsia-500/15 border border-fuchsia-400/40 text-fuchsia-300 font-bold">
                Put Wall
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-3 tabular-nums">
            <span>
              <span className="text-slate-500">GEX:</span>{" "}
              <b className={activeInspectDetails.gexVal >= 0 ? "text-teal-300" : "text-purple-300"}>
                {formatExposure(activeInspectDetails.gexVal)}
              </b>
            </span>
            <span>
              <span className="text-slate-500">VEX:</span>{" "}
              <b className={activeInspectDetails.vexVal >= 0 ? "text-emerald-300" : "text-amber-300"}>
                {formatExposure(activeInspectDetails.vexVal)}
              </b>
            </span>
            <span>
              <span className="text-slate-500">DEX:</span>{" "}
              <b className="text-slate-200">{formatExposure(activeInspectDetails.dexVal)}</b>
            </span>
            <span>
              <span className="text-slate-500">Charm:</span>{" "}
              <b className="text-slate-200">{formatExposure(activeInspectDetails.charmVal)}</b>
            </span>
            <span>
              <span className="text-slate-500">Δ Open:</span>{" "}
              <b className={activeInspectDetails.pctOpen >= 0 ? "text-emerald-400" : "text-rose-400"}>
                {activeInspectDetails.pctOpen >= 0 ? "+" : ""}
                {activeInspectDetails.pctOpen}%
              </b>
            </span>
            <span>
              <span className="text-slate-500">Row Net ({metric}):</span>{" "}
              <b className="text-white">{formatExposure(activeInspectDetails.rowNet)}</b>
            </span>
            {activeInspectDetails.isPinned ? (
              <button
                type="button"
                onClick={() => setInspectedCell(null)}
                className="inline-flex items-center gap-0.5 text-[10px] text-amber-300 hover:text-white cursor-pointer"
                title="Unpin cell inspector"
              >
                <X className="w-3 h-3" />
                <span>Unpin</span>
              </button>
            ) : (
              <span className="text-[10px] text-slate-500 hidden xl:inline">
                {activeInspectDetails.isLiveHover ? "Click cell to pin" : "Hover any cell to inspect"}
              </span>
            )}
          </div>
        </div>
      )}

      {/* King Node & Expected Move Horizon Legend Subbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono">
        <div className="flex flex-wrap items-center gap-3 text-slate-400">
          <span className="text-[#facc15] font-bold">
            ★{" "}
            {kingNode.allExpKing > 0 ? (
              <>
                {expirationFilter === "ALL" && !pickedDateCol
                  ? `All-exp King ${formatHeatmapStrike(kingNode.allExpKing)}`
                  : `${kingNode.filteredLabel} · All-exp King ${formatHeatmapStrike(kingNode.allExpKing)}`}
                {metric !== "GEX" && activeKingStrike > 0
                  ? ` · ${metric} Peak ${formatHeatmapStrike(activeKingStrike)}`
                  : ""}
                {kingNode.isContested ? " · contested" : ""}
              </>
            ) : (
              "Syncing King Node..."
            )}
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-2.5 w-2.5 rounded-sm bg-[#9333ea] inline-block" />
            <span>Neg γ</span>
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-2.5 w-2.5 rounded-sm bg-[#121926] border border-slate-700 inline-block" />
            <span>Zero</span>
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-2.5 w-2.5 rounded-sm bg-[#108a66] inline-block" />
            <span>Pos γ</span>
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-slate-400">
          <span>EM Lines:</span>
          <span className="text-slate-300 font-bold">D↑/D↓</span>
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

          {/* Virtualized Rows or Syncing Banner */}
          {tableRows.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-[420px] text-zinc-400 gap-3">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
              <span className="font-mono text-xs uppercase tracking-wider text-emerald-400">
                Syncing live options chain from CBOE...
              </span>
            </div>
          ) : (
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
          )}
        </div>
      )}
    </section>
  );
}
