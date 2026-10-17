"use client";

import React from "react";
import { useDashboardStore } from "@/store/useDashboardStore";

export function GammaProgressBar() {
  const spotPrice = useDashboardStore((state) => state.spotPrice);
  const { putWall, callWall, zeroGamma } = useDashboardStore(
    (state) => state.gammaLevels
  );
  const kingNode = useDashboardStore((state) => state.kingNode);

  const lowBound = Math.min(putWall, callWall);
  const highBound = Math.max(putWall, callWall);
  const span = Math.max(0.01, highBound - lowBound);

  const percentage = Math.min(
    100,
    Math.max(0, ((spotPrice - lowBound) / span) * 100)
  );
  const zeroGammaPct = Math.min(
    100,
    Math.max(0, ((zeroGamma - lowBound) / span) * 100)
  );
  const kingPct = Math.min(
    100,
    Math.max(0, ((kingNode.allExpKing - lowBound) / span) * 100)
  );

  return (
    <div className="argon-card rounded-xl p-4 space-y-4">
      {/* 3-Column Walls Header with Vertical Dividers */}
      <div className="grid grid-cols-3 divide-x divide-white/10 border-b border-white/10 pb-3.5">
        {/* CALL WALL (Cyan) */}
        <div className="pr-3">
          <div className="text-[10px] font-mono font-bold uppercase tracking-widest text-slate-400">
            CALL WALL
          </div>
          <div className="mt-0.5 text-lg sm:text-xl font-mono font-extrabold text-[#11cdef] tabular-nums">
            ${callWall.toFixed(callWall % 1 !== 0 ? 2 : 0)}
          </div>
          <div className="text-[10px] font-mono text-slate-500">
            Highest +γ ≥ Spot
          </div>
        </div>

        {/* PUT WALL (Pink) */}
        <div className="px-3">
          <div className="text-[10px] font-mono font-bold uppercase tracking-widest text-slate-400">
            PUT WALL
          </div>
          <div className="mt-0.5 text-lg sm:text-xl font-mono font-extrabold text-[#f5365c] tabular-nums">
            ${putWall.toFixed(putWall % 1 !== 0 ? 2 : 0)}
          </div>
          <div className="text-[10px] font-mono text-slate-500">
            Highest -γ ≤ Spot
          </div>
        </div>

        {/* ZERO Γ (White) */}
        <div className="pl-3">
          <div className="text-[10px] font-mono font-bold uppercase tracking-widest text-slate-400">
            ZERO Γ
          </div>
          <div className="mt-0.5 text-lg sm:text-xl font-mono font-extrabold text-white tabular-nums">
            ${zeroGamma.toFixed(2)}
          </div>
          <div className="text-[10px] font-mono text-slate-500">
            {spotPrice >= zeroGamma ? "Spot above flip" : "Spot below flip"}
          </div>
        </div>
      </div>

      {/* All-exp King Purple-to-Teal Progress Slider */}
      <div className="space-y-2 pt-1">
        <div className="flex items-center justify-between text-[11px] font-mono">
          <span className="text-amber-300 font-bold">
            ★ All-exp King ${kingNode.allExpKing.toFixed(0)}
          </span>
          <span className="text-slate-400">
            Zero γ marker: ${zeroGamma.toFixed(2)}
          </span>
        </div>

        <div className="relative pt-6 pb-2">
          {/* Floating Spot Price Tooltip above Thumb */}
          <div
            className="absolute top-0 -translate-x-1/2 transition-all duration-300 z-20 pointer-events-none"
            style={{ left: `${percentage}%` }}
          >
            <div className="rounded-md bg-[#1c223a] border border-[#5e72e4] px-2 py-0.5 text-[10px] font-mono font-bold text-white shadow-[0_0_12px_rgba(94,114,228,0.8)] whitespace-nowrap">
              ${spotPrice.toFixed(2)}
            </div>
          </div>

          {/* Purple-to-Teal Gradient Track */}
          <div className="relative h-3 w-full rounded-full bg-gradient-to-r from-[#6b21a8] via-[#5e72e4] to-[#14b8a6] shadow-inner">
            {/* Zero Gamma Vertical Marker */}
            <div
              className="absolute -top-1.5 -bottom-1.5 w-0.5 bg-white/80 z-10"
              style={{ left: `${zeroGammaPct}%` }}
              title={`Zero γ: $${zeroGamma.toFixed(2)}`}
            />

            {/* King Node Gold Marker */}
            <div
              className="absolute -top-1.5 -bottom-1.5 w-1 rounded-full bg-amber-300 shadow-[0_0_10px_rgba(251,191,36,0.95)] z-10"
              style={{ left: `${kingPct}%` }}
              title={`All-exp King: $${kingNode.allExpKing.toFixed(0)}`}
            />

            {/* Glowing White/Indigo Circular Thumb */}
            <div
              className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 h-5 w-5 rounded-full bg-white border-[3px] border-[#5e72e4] shadow-[0_0_14px_3px_rgba(94,114,228,0.95)] transition-all duration-300 z-20"
              style={{ left: `${percentage}%` }}
            />
          </div>
        </div>

        {/* Footer: Put wall X | Y% of the way from put wall to call wall | Call wall Z */}
        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono text-slate-400 pt-1">
          <span>
            Put wall{" "}
            <strong className="text-[#f5365c]">
              ${putWall.toFixed(putWall % 1 !== 0 ? 2 : 0)}
            </strong>
          </span>
          <span className="text-slate-300">
            {percentage.toFixed(0)}% of the way from put wall to call wall
          </span>
          <span>
            Call wall{" "}
            <strong className="text-[#11cdef]">
              ${callWall.toFixed(callWall % 1 !== 0 ? 2 : 0)}
            </strong>
          </span>
        </div>
      </div>
    </div>
  );
}
