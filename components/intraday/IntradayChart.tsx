"use client";

import React, { useRef, useState } from "react";
import { useDashboardStore } from "@/store/useDashboardStore";
import { cn } from "@/lib/utils";

const SERIES_CONFIG = [
  { key: "spot", color: "#ffffff", strokeWidth: 2.0, dashed: false, label: "Spot" },
  { key: "flowVwap", color: "#eab308", strokeWidth: 1.6, dashed: false, label: "Flow VWAP" },
  { key: "callWall", color: "#22d3ee", strokeWidth: 1.4, dashed: false, label: "Call wall" },
  { key: "putWall", color: "#e879f9", strokeWidth: 1.4, dashed: false, label: "Put wall" },
  { key: "zeroGamma", color: "#94a3b8", strokeWidth: 1.2, dashed: true, label: "Zero γ" },
] as const;

type SeriesKey = (typeof SERIES_CONFIG)[number]["key"];

export function IntradayChart() {
  const intradayData = useDashboardStore((state) => state.intradayData);
  const flowGammaVwapData = useDashboardStore((state) => state.flowGammaVwapData);

  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [showVwapBand, setShowVwapBand] = useState<boolean>(true);
  const [hiddenSeries, setHiddenSeries] = useState<Record<string, boolean>>({});
  const svgRef = useRef<SVGSVGElement | null>(null);

  const sigma = flowGammaVwapData?.sigma ?? 0;

  const displayData = intradayData.map((d) => {
    const fw = d.flowVwap ?? flowGammaVwapData?.flowVwap;
    return {
      ...d,
      flowVwap: fw,
      upper1s: d.upper1s ?? (fw && sigma > 0 ? Number((fw + sigma).toFixed(2)) : undefined),
      lower1s: d.lower1s ?? (fw && sigma > 0 ? Number((fw - sigma).toFixed(2)) : undefined),
    };
  });

  const visibleSeries = SERIES_CONFIG.filter((s) => !hiddenSeries[s.key]);

  const allValues = displayData
    .flatMap((d) => {
      const vals: (number | undefined)[] = [];
      for (const s of visibleSeries) {
        vals.push(d[s.key]);
      }
      if (showVwapBand && !hiddenSeries.flowVwap) {
        vals.push(d.upper1s, d.lower1s);
      }
      return vals;
    })
    .filter((v): v is number => typeof v === "number" && !isNaN(v) && v > 0);

  const mn = allValues.length ? Math.min(...allValues) : 0;
  const mx = allValues.length ? Math.max(...allValues) : 100;
  const mid = (mn + mx) / 2;
  const pad = (mx - mn) * 0.08 || 1;

  const W = 640;
  const Ht = 128;
  const padRight = 46;
  const plotW = W - padRight;

  const x = (i: number) => (i / Math.max(1, displayData.length - 1)) * plotW;
  const y = (v: number) => Ht - ((v - mn + pad) / (mx - mn + 2 * pad)) * Ht;

  const firstTime = displayData[0]?.time ?? "";
  const lastTime = displayData[displayData.length - 1]?.time ?? "";

  const activeIndex =
    hoverIdx !== null && hoverIdx >= 0 && hoverIdx < displayData.length
      ? hoverIdx
      : Math.max(0, displayData.length - 1);
  const activePoint = displayData[activeIndex];

  const handlePointerMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg || displayData.length < 2) return;
    const rect = svg.getBoundingClientRect();
    const relX = Math.max(0, Math.min(1, (e.clientX - rect.left) / (rect.width * (plotW / W))));
    const idx = Math.round(relX * (displayData.length - 1));
    setHoverIdx(Math.max(0, Math.min(displayData.length - 1, idx)));
  };

  const toggleSeries = (key: SeriesKey) => {
    setHiddenSeries((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  // Build polygon points for ±1σ Flow VWAP corridor
  const bandPolygonPoints = (() => {
    if (!showVwapBand || hiddenSeries.flowVwap || displayData.length < 2) return null;
    const upperPts: string[] = [];
    const lowerPts: string[] = [];
    displayData.forEach((d, i) => {
      if (d.upper1s != null && d.lower1s != null && !isNaN(d.upper1s) && !isNaN(d.lower1s)) {
        upperPts.push(`${x(i).toFixed(1)},${y(d.upper1s).toFixed(1)}`);
        lowerPts.unshift(`${x(i).toFixed(1)},${y(d.lower1s).toFixed(1)}`);
      }
    });
    if (upperPts.length < 2) return null;
    return [...upperPts, ...lowerPts].join(" ");
  })();

  const vwapSpread =
    activePoint?.spot && activePoint?.flowVwap
      ? activePoint.spot - activePoint.flowVwap
      : null;

  return (
    <div className="argon-card rounded-xl p-4">
      {/* Header: INTRADAY LEVELS on left, interactive telemetry & controls on right */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 pb-2 mb-2">
        <div className="flex items-center gap-2.5">
          <h4 className="text-[10px] font-mono font-bold uppercase tracking-widest text-slate-400">
            INTRADAY LEVELS
          </h4>
          {activePoint && (
            <span className="text-[10.5px] font-mono text-slate-300 tabular-nums bg-white/5 px-2 py-0.5 rounded border border-white/10">
              {hoverIdx !== null ? (
                <span className="text-cyan-300 font-semibold">{activePoint.time}</span>
              ) : (
                <span className="text-emerald-400 font-semibold">Latest ({activePoint.time})</span>
              )}
              {" · "}
              Spot <b className="text-white">${activePoint.spot.toFixed(2)}</b>
              {vwapSpread !== null && (
                <span
                  className={cn(
                    "ml-1.5",
                    vwapSpread >= 0 ? "text-emerald-400" : "text-rose-400"
                  )}
                >
                  ({vwapSpread >= 0 ? "+" : ""}
                  {vwapSpread.toFixed(2)} vs VWAP)
                </span>
              )}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowVwapBand((v) => !v)}
            className={cn(
              "px-2 py-0.5 rounded text-[10px] font-mono font-semibold border transition-colors cursor-pointer",
              showVwapBand
                ? "bg-amber-500/15 border-amber-400/40 text-amber-300"
                : "bg-white/5 border-white/10 text-slate-500 hover:text-slate-300"
            )}
            title="Toggle Flow VWAP ±1σ volatility band"
          >
            ±1σ VWAP Band
          </button>
          <span className="text-[11px] font-mono text-slate-500 font-normal">
            today
          </span>
        </div>
      </div>

      {displayData.length < 2 ? (
        <div className="py-4 text-xs font-mono text-slate-500">
          Collecting — {displayData.length} snapshot{displayData.length === 1 ? "" : "s"} so far today; the chart appears after the next refresh.
        </div>
      ) : (
        <div className="w-full">
          <div className="relative">
            <svg
              ref={svgRef}
              viewBox={`0 0 ${W} ${Ht}`}
              onMouseMove={handlePointerMove}
              onMouseLeave={() => setHoverIdx(null)}
              className="w-full h-[128px] block cursor-crosshair select-none"
            >
              {/* Horizontal Reference Grid Lines & Right Axis Price Labels */}
              {[mx, mid, mn].map((val, idx) => {
                const py = y(val);
                return (
                  <g key={idx}>
                    <line
                      x1={0}
                      y1={py}
                      x2={plotW}
                      y2={py}
                      stroke="rgba(148, 163, 184, 0.12)"
                      strokeWidth="1"
                      strokeDasharray="2 3"
                    />
                    <text
                      x={W - 2}
                      y={Math.max(10, Math.min(Ht - 4, py + 3))}
                      textAnchor="end"
                      fill="#64748b"
                      fontSize="9.5"
                      fontFamily="monospace"
                    >
                      ${val.toFixed(1)}
                    </text>
                  </g>
                );
              })}

              {/* Flow VWAP ±1σ Shaded Band */}
              {bandPolygonPoints && (
                <polygon
                  points={bandPolygonPoints}
                  fill="rgba(234, 179, 8, 0.10)"
                  stroke="rgba(234, 179, 8, 0.25)"
                  strokeWidth="0.6"
                />
              )}

              {/* Polylines for each active series */}
              {visibleSeries.map((s) => {
                const pts = displayData
                  .map((d, i) => {
                    const val = d[s.key];
                    if (val == null || isNaN(val)) return null;
                    return `${x(i).toFixed(1)},${y(val).toFixed(1)}`;
                  })
                  .filter(Boolean);

                if (pts.length < 2) return null;

                return (
                  <polyline
                    key={s.key}
                    points={pts.join(" ")}
                    fill="none"
                    stroke={s.color}
                    strokeWidth={s.strokeWidth}
                    vectorEffect="non-scaling-stroke"
                    strokeDasharray={s.dashed ? "4 3" : undefined}
                  />
                );
              })}

              {/* Interactive Hover Crosshair & Active Dots */}
              {hoverIdx !== null && activePoint && (
                <g>
                  <line
                    x1={x(hoverIdx)}
                    y1={0}
                    x2={x(hoverIdx)}
                    y2={Ht}
                    stroke="rgba(56, 189, 248, 0.55)"
                    strokeWidth="1"
                    strokeDasharray="3 2"
                  />
                  {visibleSeries.map((s) => {
                    const val = activePoint[s.key];
                    if (val == null || isNaN(val)) return null;
                    return (
                      <circle
                        key={s.key}
                        cx={x(hoverIdx)}
                        cy={y(val)}
                        r={3.2}
                        fill={s.color}
                        stroke="#0b0d17"
                        strokeWidth="1.2"
                      />
                    );
                  })}
                </g>
              )}
            </svg>
          </div>

          {/* Footer: Interactive Toggleable Legend on left, summary on right */}
          <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] font-mono text-slate-400 pt-2 border-t border-white/5 mt-2">
            <div className="flex flex-wrap items-center gap-2">
              {SERIES_CONFIG.map((s) => {
                const isHidden = Boolean(hiddenSeries[s.key]);
                const val = activePoint?.[s.key];
                return (
                  <button
                    key={s.key}
                    type="button"
                    onClick={() => toggleSeries(s.key)}
                    style={{ color: isHidden ? "#64748b" : s.color }}
                    className={cn(
                      "inline-flex items-center gap-1.5 px-2 py-0.5 rounded border transition-all cursor-pointer",
                      isHidden
                        ? "border-white/5 bg-transparent opacity-45 line-through"
                        : "border-white/10 bg-white/[0.03] hover:bg-white/[0.07]"
                    )}
                    title={`Click to ${isHidden ? "show" : "hide"} ${s.label}`}
                  >
                    <i
                      style={{ backgroundColor: isHidden ? "#64748b" : s.color }}
                      className="inline-block w-2.5 h-[2px] align-middle"
                    />
                    <span>{s.label}</span>
                    {val != null && !isNaN(val) && !isHidden && (
                      <b className="font-bold tabular-nums opacity-95">
                        {val.toFixed(s.key === "spot" || s.key === "flowVwap" ? 2 : 1)}
                      </b>
                    )}
                  </button>
                );
              })}
            </div>
            <div className="text-slate-500 tabular-nums ml-auto">
              {firstTime}–{lastTime} · {displayData.length} pts · {mn.toFixed(1)}–{mx.toFixed(1)}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

