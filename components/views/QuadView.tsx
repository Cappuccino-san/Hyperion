"use client";

import React, { useEffect, useState } from "react";
import {
  ExposureMetric,
  getTickerPreset,
  useDashboardStore,
} from "@/store/useDashboardStore";
import { OptionsAnalyticsPayload } from "@/lib/optionsExposure";
import { getHyperionCellStyle } from "@/components/heatmap/HeatmapTable";
import { cn } from "@/lib/utils";

const QUAD_TICKERS = ["SPY", "QQQ", "SPXW", "IWM"] as const;
const METRICS: ExposureMetric[] = ["GEX", "VEX", "DEX", "Charm"];

interface QuadStrikeRow {
  strike: number;
  value: number;
  pctChange: number;
  isSpot: boolean;
  isKing: boolean;
}

export function QuadView() {
  const metric = useDashboardStore((state) => state.gridFilters.metric);
  const globalExpFilter = useDashboardStore(
    (state) => state.gridFilters.expiration
  );
  const setFilters = useDashboardStore((state) => state.setFilters);
  const setTicker = useDashboardStore((state) => state.setTicker);
  const setActiveView = useDashboardStore((state) => state.setActiveView);

  const [quadPayloads, setQuadPayloads] = useState<
    Record<string, OptionsAnalyticsPayload>
  >({});
  const [cardHorizons, setCardHorizons] = useState<
    Record<string, "ALL" | "0DTE" | "THIS_WEEK">
  >({
    SPY: "ALL",
    QQQ: "ALL",
    SPXW: "ALL",
    IWM: "ALL",
  });

  useEffect(() => {
    let active = true;
    QUAD_TICKERS.forEach(async (sym) => {
      try {
        const res = await fetch(`/api/options?ticker=${sym}`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const data: OptionsAnalyticsPayload = await res.json();
        if (active) {
          setQuadPayloads((prev) => ({ ...prev, [sym]: data }));
        }
      } catch {
        // Use deterministic preset fallback
      }
    });
    return () => {
      active = false;
    };
  }, []);

  const syncGlobalHorizon = (horizon: "ALL" | "0DTE" | "THIS_WEEK") => {
    setFilters({ expiration: horizon });
    setCardHorizons({
      SPY: horizon,
      QQQ: horizon,
      SPXW: horizon,
      IWM: horizon,
    });
  };

  return (
    <div className="space-y-4">
      {/* Top Filter Bar */}
      <div className="argon-card rounded-xl p-3.5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {/* [GEX | VEX | DEX | Charm] */}
          <div className="inline-flex items-center rounded-full bg-[#0b0d17] p-0.5 border border-white/10">
            {METRICS.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setFilters({ metric: m })}
                className={cn(
                  "px-3 py-1 rounded-full text-xs font-mono font-bold transition-all",
                  metric === m
                    ? "bg-[#1c223a] border border-[#5e72e4] text-white shadow-[0_0_10px_rgba(94,114,228,0.5)]"
                    : "text-slate-400 hover:text-white"
                )}
              >
                {m}
              </button>
            ))}
          </div>

          {/* [All exp | This week | 0DTE] */}
          <div className="inline-flex items-center rounded-full bg-[#0b0d17] p-0.5 border border-white/10">
            {(
              [
                { value: "ALL", label: "All exp" },
                { value: "THIS_WEEK", label: "This week" },
                { value: "0DTE", label: "0DTE" },
              ] as const
            ).map((h) => (
              <button
                key={h.value}
                type="button"
                onClick={() => syncGlobalHorizon(h.value)}
                className={cn(
                  "px-3 py-1 rounded-full text-xs font-mono font-semibold transition-all",
                  globalExpFilter === h.value
                    ? "bg-[#1c223a] border border-[#11cdef] text-white"
                    : "text-slate-400 hover:text-white"
                )}
              >
                {h.label}
              </button>
            ))}
          </div>
        </div>

        <span className="text-xs font-mono text-slate-400">
          Quad Index Matrix · Tap any card header to open full Heatmap
        </span>
      </div>

      {/* 2x2 Grid for SPY, QQQ, SPXW, and IWM */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {QUAD_TICKERS.map((sym) => {
          const payload = quadPayloads[sym];
          const preset = getTickerPreset(sym);
          const spot = payload?.spotPrice ?? preset.spotPrice;
          const prevClose = payload?.previousClose ?? preset.previousClose;
          const pctChange =
            prevClose > 0 ? ((spot - prevClose) / prevClose) * 100 : 0;
          const isPosChange = pctChange >= 0;
          const step = payload?.strikeStep ?? preset.strikeStep;
          const horizon = cardHorizons[sym] ?? "ALL";

          const allExpKing =
            payload?.kingNode.allExpKing ?? preset.kingPreset.allExpKing;
          const activeKing =
            horizon === "0DTE"
              ? payload?.kingByFilter["0DTE"].strike ??
                preset.kingPreset.zeroDteKing
              : horizon === "THIS_WEEK"
                ? payload?.kingByFilter.THIS_WEEK.strike ??
                  preset.kingPreset.weeklyKing
                : allExpKing;

          // Build 15 strikes centered around spot
          let ladder: QuadStrikeRow[] = [];
          if (payload && payload.strikes.length > 0) {
            let bestSpotIdx = 0;
            let bestDiff = Infinity;
            payload.strikes.forEach((r, idx) => {
              const d = Math.abs(r.strike - spot);
              if (d < bestDiff) {
                bestDiff = d;
                bestSpotIdx = idx;
              }
            });

            const startIdx = Math.max(0, bestSpotIdx - 7);
            const slice = payload.strikes.slice(startIdx, startIdx + 15);
            const matchingCols =
              horizon === "ALL"
                ? payload.expirations
                : payload.expirations.filter((e) => e.filterGroup === horizon);
            const colsToSum =
              matchingCols.length > 0 ? matchingCols : payload.expirations;

            ladder = slice.map((sRow) => {
              const map =
                metric === "GEX"
                  ? sRow.gex
                  : metric === "VEX"
                    ? sRow.vex
                    : metric === "DEX"
                      ? sRow.dex
                      : sRow.charm;
              const sumVal = colsToSum.reduce(
                (acc, c) => acc + (map[c.id] ?? 0),
                0
              );
              const firstColId = colsToSum[0]?.id ?? "exp_0";
              const rawPct = sRow.openPctChange[firstColId] ?? -18;
              return {
                strike: sRow.strike,
                value: Number(sumVal.toFixed(1)),
                pctChange: rawPct,
                isSpot: Math.abs(sRow.strike - spot) < step * 0.55,
                isKing: Math.abs(sRow.strike - activeKing) < step * 0.4,
              };
            });
          } else {
            const center = Math.round(spot / step) * step;
            for (let i = 7; i >= -7; i--) {
              const k = center + i * step;
              const isKing = Math.abs(k - activeKing) < step * 0.4;
              const isSpot = i === 0;
              const dist = (k - preset.gammaLevels.zeroGamma) / (step * 6);
              const val = isKing
                ? (preset.netMetrics.netGex >= 0 ? 1 : -1) *
                  preset.kingPreset.kingValue
                : Number((Math.tanh(dist) * 185 - i * 14).toFixed(1));
              const pct = isKing ? -279 : i * 19 + (i % 2 === 0 ? 8 : -24);
              ladder.push({
                strike: k,
                value: val,
                pctChange: pct,
                isSpot,
                isKing,
              });
            }
          }

          const maxVal = Math.max(
            1,
            ...ladder.map((r) => Math.abs(r.value))
          );

          return (
            <div
              key={sym}
              className="argon-card rounded-xl p-4 flex flex-col space-y-2.5"
            >
              {/* Card Header: Ticker, Spot, % change + Horizon Dropdown */}
              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setTicker(sym);
                    setActiveView("Heatmap");
                  }}
                  className="flex items-baseline gap-2 text-left hover:opacity-90"
                >
                  <span className="text-base font-extrabold text-white">
                    {sym}
                  </span>
                  <span className="font-mono text-base font-bold text-white tabular-nums">
                    ${spot.toFixed(2)}
                  </span>
                  <span
                    className={cn(
                      "font-mono text-xs font-bold tabular-nums",
                      isPosChange ? "text-emerald-400" : "text-rose-400"
                    )}
                  >
                    {isPosChange ? "+" : ""}
                    {pctChange.toFixed(2)}%
                  </span>
                </button>

                <select
                  aria-label={`${sym} Expiration Horizon`}
                  value={horizon}
                  onChange={(e) =>
                    setCardHorizons((prev) => ({
                      ...prev,
                      [sym]: e.target.value as "ALL" | "0DTE" | "THIS_WEEK",
                    }))
                  }
                  className="rounded-lg bg-[#0b0d17] border border-white/15 px-2.5 py-1 text-xs font-mono text-slate-200 focus:outline-none focus:border-[#11cdef]"
                >
                  <option value="ALL">Global (All exp)</option>
                  <option value="0DTE">0DTE</option>
                  <option value="THIS_WEEK">This week</option>
                </select>
              </div>

              {/* Subtitle: All-exp King [Strike] in bold yellow */}
              <div className="flex items-center justify-between text-xs font-mono">
                <span className="font-extrabold text-yellow-400">
                  ★{" "}
                  {horizon === "ALL"
                    ? `All-exp King ${allExpKing.toFixed(0)}`
                    : `${horizon === "0DTE" ? "0DTE" : "This week"} King ${activeKing.toFixed(0)} · All-exp King ${allExpKing.toFixed(0)}`}
                </span>
                <span className="text-[10px] text-slate-500 uppercase">
                  {metric} Ladder
                </span>
              </div>

              {/* Scrollable Single-Column Strike Ladder (12–15 visible strikes) */}
              <div className="h-[410px] overflow-y-auto argon-scrollbar rounded-lg border border-white/10 bg-[#0b0d17] divide-y divide-[#0b0d17]/70">
                {ladder.map((row) => {
                  const { backgroundColor, isBrightYellow } =
                    getHyperionCellStyle(row.value, maxVal, row.isKing);
                  const isPosVal = row.value >= 0;
                  const formattedVal = `${isPosVal ? "+" : "-"}$${Math.abs(row.value).toFixed(1)}M`;
                  const isPosPct = row.pctChange >= 0;

                  return (
                    <div
                      key={row.strike}
                      className={cn(
                        "grid grid-cols-[78px_1fr] h-[29px] items-center",
                        row.isKing &&
                          "ring-2 ring-inset ring-yellow-300 shadow-[0_0_15px_rgba(250,204,21,0.7)] z-10 relative"
                      )}
                    >
                      {/* Left Strike Column */}
                      <div
                        className={cn(
                          "h-full flex items-center justify-between px-2 font-mono text-xs tabular-nums border-r border-white/15",
                          row.isSpot
                            ? "bg-[#3b82f6] text-white font-extrabold"
                            : row.isKing
                              ? "bg-[#eab308] text-slate-950 font-extrabold"
                              : "bg-[#111422] text-slate-300"
                        )}
                      >
                        <span className="inline-flex items-center gap-1">
                          {row.isKing && <span>★</span>}
                          <span>
                            {row.strike.toFixed(row.strike % 1 !== 0 ? 1 : 0)}
                          </span>
                        </span>
                      </div>

                      {/* Right Full-Width Exposure Bar Cell */}
                      <div
                        style={{
                          backgroundColor: row.isKing
                            ? "#eab308"
                            : backgroundColor,
                        }}
                        className={cn(
                          "relative h-full flex flex-col justify-between px-2.5 py-0.5 font-mono tabular-nums",
                          row.isKing || isBrightYellow
                            ? "text-slate-950 font-extrabold"
                            : "text-white font-semibold"
                        )}
                      >
                        {/* Top-right intraday % delta */}
                        <div className="flex justify-end leading-none">
                          <span
                            className={cn(
                              "text-[9px] font-bold",
                              row.isKing || isBrightYellow
                                ? "text-slate-900"
                                : isPosPct
                                  ? "text-emerald-300"
                                  : "text-rose-300"
                            )}
                          >
                            {isPosPct ? `+${row.pctChange}%` : `${row.pctChange}%`}
                          </span>
                        </div>

                        {/* Bottom-right net dollar value */}
                        <div className="flex items-center justify-between leading-none">
                          <span className="text-[9px] opacity-80">
                            {row.isKing
                              ? "KING NODE"
                              : row.isSpot
                                ? "SPOT ATM"
                                : ""}
                          </span>
                          <span className="text-[11px]">{formattedVal}</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
