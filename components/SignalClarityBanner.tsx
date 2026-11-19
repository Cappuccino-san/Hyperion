"use client";

import React, { useMemo } from "react";
import {
  ShieldCheck,
  Flame,
  Compass,
  Magnet,
  ArrowDownRight,
  ArrowUpRight,
  Sparkles,
  SlidersHorizontal,
} from "lucide-react";
import {
  computeDealerFlowSummary,
  formatStabilizedFlowM,
} from "@/lib/dealerFlowMetrics";
import { useDashboardStore } from "@/store/useDashboardStore";

export function SignalClarityBanner() {
  const activeTicker = useDashboardStore((state) => state.activeTicker);
  const spot = useDashboardStore((state) => state.spotPrice);
  const netMetrics = useDashboardStore((state) => state.netMetrics);
  const kingNode = useDashboardStore((state) => state.kingNode);
  const gammaLevels = useDashboardStore((state) => state.gammaLevels);
  const uiMode = useDashboardStore((state) => state.uiMode);
  const toggleUiMode = useDashboardStore((state) => state.toggleUiMode);

  const flow = useMemo(
    () =>
      computeDealerFlowSummary({
        spot,
        netGexM: netMetrics.netGex || 0,
        zeroGammaFlip: gammaLevels?.zeroGamma ?? null,
        kingStrike: kingNode.filteredKing ?? kingNode.allExpKing ?? null,
        allExpKingStrike: kingNode.allExpKing ?? null,
        callWall: gammaLevels?.callWall ?? null,
        putWall: gammaLevels?.putWall ?? null,
      }),
    [spot, netMetrics.netGex, gammaLevels, kingNode]
  );

  const rangeMetrics = useMemo(() => {
    const putWall = gammaLevels?.putWall;
    const callWall = gammaLevels?.callWall;
    const kingStrike = kingNode.filteredKing ?? kingNode.allExpKing;
    const low = putWall && putWall > 0 ? putWall : spot * 0.985;
    const high = callWall && callWall > low ? callWall : spot * 1.015;
    const span = Math.max(0.01, high - low);
    const spotPct = Math.max(4, Math.min(96, ((spot - low) / span) * 100));
    const kingPct =
      kingStrike && kingStrike > 0
        ? Math.max(4, Math.min(96, ((kingStrike - low) / span) * 100))
        : null;
    return { low, high, spotPct, kingPct };
  }, [spot, gammaLevels, kingNode]);

  const isPositive = flow.hedgingBehavior === "COUNTER_TREND_ABSORB";
  const isNegative = flow.hedgingBehavior === "PRO_TREND_AMPLIFY";

  return (
    <div
      className={`relative overflow-hidden rounded-xl border transition-colors duration-500 px-4 py-3 mb-2 ${
        isPositive
          ? "bg-gradient-to-r from-emerald-950/40 via-[#0b101b] to-[#0b101b] border-emerald-500/30 shadow-[0_4px_24px_rgba(16,185,129,0.06)]"
          : isNegative
          ? "bg-gradient-to-r from-rose-950/40 via-[#0b101b] to-[#0b101b] border-rose-500/30 shadow-[0_4px_24px_rgba(244,63,94,0.06)]"
          : "bg-gradient-to-r from-amber-950/30 via-[#0b101b] to-[#0b101b] border-amber-500/25 shadow-[0_4px_24px_rgba(245,158,11,0.06)]"
      }`}
    >
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3.5 items-center">
        {/* PILLAR 1: REGIME VERDICT & PLAIN-ENGLISH THESIS (5 cols) */}
        <div className="lg:col-span-5 flex items-start gap-3">
          <div
            className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border ${
              isPositive
                ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-300"
                : isNegative
                ? "bg-rose-500/15 border-rose-500/40 text-rose-300"
                : "bg-amber-500/15 border-amber-500/40 text-amber-300"
            }`}
          >
            {isPositive ? (
              <ShieldCheck className="w-5 h-5" />
            ) : isNegative ? (
              <Flame className="w-5 h-5" />
            ) : (
              <Compass className="w-5 h-5" />
            )}
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold tracking-wider uppercase ${
                  isPositive
                    ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                    : isNegative
                    ? "bg-rose-500/20 text-rose-300 border border-rose-500/30"
                    : "bg-amber-500/20 text-amber-300 border border-amber-500/30"
                }`}
              >
                {flow.regimeLabel}
              </span>
              <span className="text-[11px] font-mono text-slate-400">
                {formatStabilizedFlowM(flow.hedgingFlowPerPtM)} / pt
              </span>
            </div>

            <p className="mt-1 text-xs text-slate-200 font-medium leading-snug">
              {flow.plainEnglishThesis}
            </p>
            <p className="mt-0.5 text-[11px] text-slate-400">
              <span className="text-slate-300 font-semibold">Playbook:</span>{" "}
              {flow.tacticalPlaybook}
            </p>
          </div>
        </div>

        {/* PILLAR 2: GLANCEABLE PRICE BOX — PUT FLOOR <-> SPOT / KING <-> CALL CEILING (5 cols) */}
        <div className="lg:col-span-5 bg-slate-900/70 border border-slate-800/80 rounded-lg px-3 py-2">
          <div className="flex items-center justify-between text-[11px] mb-1">
            <div className="flex items-center gap-1.5">
              <span className="text-purple-400 font-semibold uppercase text-[10px] tracking-wider">
                Put Floor
              </span>
              <span className="font-mono font-bold text-white text-xs tabular-nums">
                {gammaLevels?.putWall ?? "—"}
              </span>
            </div>

            <div className="flex items-center gap-1.5">
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-yellow-500/15 border border-yellow-500/35 text-[#facc15] font-mono text-[11px] font-bold tabular-nums">
                <Magnet className="w-3 h-3" />
                King {kingNode.filteredKing ?? kingNode.allExpKing ?? "—"}
              </span>
              {kingNode.allExpKing &&
                kingNode.filteredKing &&
                kingNode.allExpKing !== kingNode.filteredKing && (
                  <span
                    className="hidden sm:inline-flex items-center px-1.5 py-0.5 rounded bg-yellow-500/10 border border-yellow-500/25 text-yellow-300/90 font-mono text-[10px] tabular-nums"
                    title="Macro King Strike"
                  >
                    Macro {kingNode.allExpKing}
                  </span>
                )}
            </div>

            <div className="flex items-center gap-1.5">
              <span className="font-mono font-bold text-white text-xs tabular-nums">
                {gammaLevels?.callWall ?? "—"}
              </span>
              <span className="text-cyan-400 font-semibold uppercase text-[10px] tracking-wider">
                Call Ceiling
              </span>
            </div>
          </div>

          {/* Visual Range Bar */}
          <div className="relative h-2 w-full rounded-full bg-slate-800 overflow-visible my-1.5">
            <div className="absolute inset-0 rounded-full bg-gradient-to-r from-rose-500/30 via-slate-700/40 to-emerald-500/30" />

            {/* King Marker */}
            {rangeMetrics.kingPct !== null && (
              <div
                className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 z-10 flex flex-col items-center"
                style={{ left: `${rangeMetrics.kingPct}%` }}
                title={`King Magnet: ${kingNode.filteredKing ?? kingNode.allExpKing}`}
              >
                <div className="h-3.5 w-1.5 rounded-full bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.9)]" />
              </div>
            )}

            {/* Spot Marker */}
            <div
              className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 z-20 flex flex-col items-center"
              style={{ left: `${rangeMetrics.spotPct}%` }}
              title={`${activeTicker} Spot: $${spot.toFixed(2)}`}
            >
              <div className="h-3 w-3 rounded-full bg-white border-2 border-cyan-400 shadow-[0_0_10px_rgba(34,211,238,0.9)]" />
            </div>
          </div>

          <div className="flex items-center justify-between text-[10px] text-slate-400 font-mono">
            <span>
              Spot <strong className="text-cyan-300">${spot.toFixed(2)}</strong>
            </span>
            <span>
              Flip:{" "}
              <strong className="text-slate-200">
                {gammaLevels?.zeroGamma ? gammaLevels.zeroGamma.toFixed(1) : "—"}
              </strong>
            </span>
            <span>
              {kingNode.filteredKing && spot > 0 ? (
                <span className="inline-flex items-center gap-0.5 text-amber-300">
                  {kingNode.filteredKing >= spot ? (
                    <ArrowUpRight className="w-3 h-3" />
                  ) : (
                    <ArrowDownRight className="w-3 h-3" />
                  )}
                  {Math.abs(kingNode.filteredKing - spot).toFixed(1)} pts to King
                </span>
              ) : (
                "—"
              )}
            </span>
          </div>
        </div>

        {/* PILLAR 3: VIEW DENSITY CONTROL (SIGNAL vs QUANT MODE) (2 cols) */}
        <div className="lg:col-span-2 flex lg:flex-col items-center lg:items-end justify-between gap-1.5">
          <button
            type="button"
            onClick={toggleUiMode}
            className={`w-full inline-flex items-center justify-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-semibold transition-all ${
              uiMode === "signal"
                ? "bg-cyan-500/15 border-cyan-500/40 text-cyan-200 hover:bg-cyan-500/25"
                : "bg-slate-800/80 border-slate-700 text-slate-300 hover:bg-slate-800"
            }`}
            title="Toggle between Simplified Signal View and Full Quant View"
          >
            {uiMode === "signal" ? (
              <>
                <Sparkles className="w-3.5 h-3.5 text-cyan-400" />
                <span>Signal View</span>
              </>
            ) : (
              <>
                <SlidersHorizontal className="w-3.5 h-3.5 text-slate-400" />
                <span>Quant View</span>
              </>
            )}
          </button>
          <span className="text-[10px] text-slate-400 text-right hidden lg:block">
            {uiMode === "signal" ? "High-conviction pivots" : "Full strike tables"}
          </span>
        </div>
      </div>
    </div>
  );
}
