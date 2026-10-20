"use client";

import React from "react";
import { useDashboardStore } from "@/store/useDashboardStore";

export function IntradayChart() {
  const intradayData = useDashboardStore((state) => state.intradayData);

  const displayData = intradayData;

  const S = [
    { key: "spot", color: "#ffffff", strokeWidth: 1.8, dashed: false, label: "Spot" },
    { key: "callWall", color: "#22d3ee", strokeWidth: 1.4, dashed: false, label: "Call wall" },
    { key: "putWall", color: "#e879f9", strokeWidth: 1.4, dashed: false, label: "Put wall" },
    { key: "zeroGamma", color: "#94a3b8", strokeWidth: 1.2, dashed: true, label: "Zero γ" },
  ] as const;

  const allValues = displayData
    .flatMap((d) => [d.spot, d.callWall, d.putWall, d.zeroGamma])
    .filter((v) => typeof v === "number" && !isNaN(v) && v > 0);

  const mn = allValues.length ? Math.min(...allValues) : 0;
  const mx = allValues.length ? Math.max(...allValues) : 100;
  const pad = (mx - mn) * 0.08 || 1;

  const W = 600;
  const Ht = 90;
  const x = (i: number) => (i / Math.max(1, displayData.length - 1)) * W;
  const y = (v: number) => Ht - ((v - mn + pad) / (mx - mn + 2 * pad)) * Ht;

  const firstTime = displayData[0]?.time ?? "";
  const lastTime = displayData[displayData.length - 1]?.time ?? "";

  return (
    <div className="argon-card rounded-xl p-4">
      {/* Header: INTRADAY LEVELS on left, today on right */}
      <div className="flex items-center justify-between border-b border-white/10 pb-2 mb-2">
        <h4 className="text-[10px] font-mono font-bold uppercase tracking-widest text-slate-400">
          INTRADAY LEVELS
        </h4>
        <span className="text-[11px] font-mono text-slate-500 font-normal">
          today
        </span>
      </div>

      {displayData.length < 2 ? (
        <div className="py-4 text-xs font-mono text-slate-500">
          Collecting — {displayData.length} snapshot{displayData.length === 1 ? "" : "s"} so far today; the chart appears after the next refresh.
        </div>
      ) : (
        <div className="w-full">
          <svg
            viewBox={`0 0 ${W} ${Ht}`}
            preserveAspectRatio="none"
            className="w-full h-[90px] block"
          >
            {S.map((s) => {
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
          </svg>

          {/* Footer: Legend on left, summary on right */}
          <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] font-mono text-slate-400 pt-2 border-t border-white/5 mt-2">
            <div className="flex flex-wrap items-center gap-3">
              <span className="inline-flex items-center gap-1.5 text-white">
                <i className="inline-block w-2.5 h-[2px] bg-white align-middle" />
                Spot
              </span>
              <span className="inline-flex items-center gap-1.5 text-[#22d3ee]">
                <i className="inline-block w-2.5 h-[2px] bg-[#22d3ee] align-middle" />
                Call wall
              </span>
              <span className="inline-flex items-center gap-1.5 text-[#e879f9]">
                <i className="inline-block w-2.5 h-[2px] bg-[#e879f9] align-middle" />
                Put wall
              </span>
              <span className="inline-flex items-center gap-1.5 text-[#94a3b8]">
                <i className="inline-block w-2.5 h-[2px] bg-[#94a3b8] align-middle" />
                Zero γ
              </span>
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
