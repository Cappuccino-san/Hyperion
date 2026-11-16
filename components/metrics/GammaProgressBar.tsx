"use client";

import React from "react";
import { useDashboardStore } from "@/store/useDashboardStore";
import { formatExposure } from "@/lib/optionsExposure";

interface GammaProgressBarProps {
  kingPhrase?: string;
}

export function GammaProgressBar({ kingPhrase }: GammaProgressBarProps) {
  const spotPrice = useDashboardStore((state) => state.spotPrice);
  const liveTickPrice = useDashboardStore((state) => state.liveTickPrice);
  const effectiveSpot =
    liveTickPrice && liveTickPrice > 0 ? liveTickPrice : spotPrice;
  const {
    putWall,
    putWallGex,
    callWall,
    callWallGex,
    zeroGamma,
    hasZeroGammaFlip = true,
  } = useDashboardStore((state) => state.gammaLevels);
  const kingNode = useDashboardStore((state) => state.kingNode);
  const allExpKingNode = useDashboardStore((state) => state.allExpKingNode);

  const hasLiveSpot = Number.isFinite(effectiveSpot) && effectiveSpot > 0;
  const lowBound = Math.min(putWall, callWall);
  const highBound = Math.max(putWall, callWall);
  const hasValidWalls =
    hasLiveSpot &&
    Number.isFinite(lowBound) &&
    Number.isFinite(highBound) &&
    lowBound > 0 &&
    highBound > lowBound;
  const span = hasValidWalls ? Math.max(0.01, highBound - lowBound) : 1;

  const rawPct = hasValidWalls ? ((effectiveSpot - lowBound) / span) * 100 : 50;
  const percentage = Math.min(100, Math.max(0, rawPct));
  const zeroGammaPct = hasValidWalls
    ? Math.min(100, Math.max(0, ((zeroGamma - lowBound) / span) * 100))
    : 50;
  const showZgTick =
    hasValidWalls &&
    hasZeroGammaFlip &&
    Number.isFinite(zeroGamma) &&
    zeroGamma > 0 &&
    zeroGamma >= lowBound &&
    zeroGamma <= highBound;
  const activeKingStrike = kingNode.filteredKing ?? kingNode.allExpKing;
  const kingPct = hasValidWalls
    ? Math.min(100, Math.max(0, ((activeKingStrike - lowBound) / span) * 100))
    : 50;
  const showKingMarker =
    hasValidWalls &&
    Number.isFinite(activeKingStrike) &&
    activeKingStrike > 0 &&
    activeKingStrike >= lowBound &&
    activeKingStrike <= highBound;

  const positionMessage = !hasValidWalls
    ? "awaiting structural walls"
    : effectiveSpot > highBound
      ? `spot $${(effectiveSpot - highBound).toFixed(2)} above the upper wall`
      : effectiveSpot < lowBound
        ? `spot $${(lowBound - effectiveSpot).toFixed(2)} below the lower wall`
        : `${Math.round(percentage)}% of the way from put wall to call wall`;

  const isContested = kingNode.isContested || allExpKingNode?.isContested;
  const displayKingPhrase =
    kingPhrase ??
    (kingNode.allExpKing > 0
      ? `All-exp King ${kingNode.allExpKing.toFixed(kingNode.allExpKing % 1 !== 0 ? 1 : 0)}${
          isContested ? " · contested" : ""
        }`
      : "Awaiting live King Node...");

  return (
    <div className="argon-card rounded-xl p-4 space-y-4">
      {/* 3-Column Walls Header with Vertical Dividers */}
      <div className="grid grid-cols-3 divide-x divide-white/10 border-b border-white/10 pb-3.5">
        {/* CALL WALL (Cyan) */}
        <div className="pr-3">
          <div className="text-[10px] font-mono font-bold uppercase tracking-widest text-slate-400">
            CALL WALL
          </div>
          <div className="mt-0.5 text-lg sm:text-xl font-mono font-extrabold text-[#22d3ee] tabular-nums">
            {hasLiveSpot && callWall > 0 ? callWall.toFixed(callWall % 1 !== 0 ? 2 : 0) : "—"}
          </div>
          <div className="text-[11px] font-mono text-slate-400">
            {hasLiveSpot && callWallGex !== undefined && callWallGex !== 0
              ? formatExposure(callWallGex, { showPlus: false })
              : "Highest +γ ≥ Spot"}
          </div>
        </div>

        {/* PUT WALL (Pink) */}
        <div className="px-3">
          <div className="text-[10px] font-mono font-bold uppercase tracking-widest text-slate-400">
            PUT WALL
          </div>
          <div className="mt-0.5 text-lg sm:text-xl font-mono font-extrabold text-[#e879f9] tabular-nums">
            {hasLiveSpot && putWall > 0 ? putWall.toFixed(putWall % 1 !== 0 ? 2 : 0) : "—"}
          </div>
          <div className="text-[11px] font-mono text-slate-400">
            {hasLiveSpot && putWallGex !== undefined && putWallGex !== 0
              ? formatExposure(putWallGex)
              : "Highest -γ ≤ Spot"}
          </div>
        </div>

        {/* ZERO Γ (White) */}
        <div className="pl-3">
          <div className="text-[10px] font-mono font-bold uppercase tracking-widest text-slate-400">
            ZERO Γ
          </div>
          <div className="mt-0.5 text-lg sm:text-xl font-mono font-extrabold text-white tabular-nums">
            {hasLiveSpot && hasZeroGammaFlip && zeroGamma > 0 ? zeroGamma.toFixed(1) : "—"}
          </div>
          <div className="text-[11px] font-mono text-slate-400">
            {hasLiveSpot && hasZeroGammaFlip && zeroGamma > 0
              ? effectiveSpot >= zeroGamma
                ? "spot above"
                : "spot below"
              : hasZeroGammaFlip
                ? "awaiting spot"
                : "no flip"}
          </div>
        </div>
      </div>

      {/* Full-Width King Row + Wall-to-Wall Corridor Slider */}
      <div className="space-y-2 pt-0.5">
        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono">
          <span className="text-[#facc15] font-bold">
            ★ {displayKingPhrase}
          </span>
          {hasLiveSpot && hasZeroGammaFlip && zeroGamma > 0 && (
            <span className="text-slate-400">
              Zero γ: {zeroGamma.toFixed(1)}
            </span>
          )}
        </div>

        <div className="relative pt-6 pb-2">
          {/* Floating Spot Price Tooltip above Thumb */}
          <div
            className="absolute top-0 -translate-x-1/2 transition-all duration-300 z-20 pointer-events-none"
            style={{ left: `${percentage}%` }}
          >
            <div className="rounded-md bg-[#1c223a] border border-[#5e72e4] px-2 py-0.5 text-[10px] font-mono font-bold text-white shadow-[0_0_12px_rgba(94,114,228,0.8)] whitespace-nowrap">
              {hasLiveSpot ? `$${effectiveSpot.toFixed(2)}` : "—"}
            </div>
          </div>

          {/* Purple-to-Teal Gradient Track */}
          <div className="relative h-3 w-full rounded-full bg-gradient-to-r from-[#581c87] via-[#1e293b] to-[#115e59] border border-[#243044] shadow-inner">
            {/* Zero Gamma Vertical Tick Mark (div.zg) */}
            {showZgTick && (
              <div
                className="absolute -top-1 -bottom-1 w-0.5 bg-white/85 z-10"
                style={{ left: `${zeroGammaPct}%` }}
                title={`Zero γ ${zeroGamma.toFixed(1)}`}
              />
            )}

            {/* King Node Gold Marker */}
            {showKingMarker && (
              <div
                className="absolute -top-1 -bottom-1 w-1 rounded-full bg-[#facc15] shadow-[0_0_10px_rgba(250,204,21,0.95)] z-10"
                style={{ left: `${kingPct}%` }}
                title={`King: $${activeKingStrike.toFixed(activeKingStrike % 1 !== 0 ? 1 : 0)}`}
              />
            )}

            {/* Glowing White/Indigo Circular Thumb */}
            <div
              className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 h-4 w-4 rounded-full bg-white border-2 border-[#6366f1] shadow-[0_0_10px_rgba(99,102,241,0.9)] transition-all duration-300 z-20"
              style={{ left: `${percentage}%` }}
            />
          </div>
        </div>

        {/* Footer: Put wall X | positionMessage | Call wall Z */}
        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono text-slate-400 pt-1">
          <span>
            Put wall{" "}
            <strong className="text-[#e879f9]">
              {hasLiveSpot && putWall > 0 ? putWall.toFixed(putWall % 1 !== 0 ? 2 : 0) : "—"}
            </strong>
          </span>
          <span className="text-slate-300">{positionMessage}</span>
          <span>
            Call wall{" "}
            <strong className="text-[#22d3ee]">
              {hasLiveSpot && callWall > 0 ? callWall.toFixed(callWall % 1 !== 0 ? 2 : 0) : "—"}
            </strong>
          </span>
        </div>
      </div>
    </div>
  );
}
