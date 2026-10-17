"use client";

import React from "react";
import { useDashboardStore } from "@/store/useDashboardStore";
import { GammaProgressBar } from "./GammaProgressBar";
import { formatExposure } from "@/lib/optionsExposure";
import { cn } from "@/lib/utils";

export function MetricsRow() {
  const { netGex, netVex } = useDashboardStore((state) => state.netMetrics);
  const kingNode = useDashboardStore((state) => state.kingNode);
  const allExpKingNode = useDashboardStore((state) => state.allExpKingNode);
  const expirationFilter = useDashboardStore(
    (state) => state.gridFilters.expiration
  );

  const isLongGex = netGex >= 0;
  const isLongVex = netVex >= 0;

  const isAllExp = expirationFilter === "ALL";
  const isZeroDte = expirationFilter === "0DTE";
  const isThisWeek =
    expirationFilter === "THIS_WEEK" || (!isAllExp && !isZeroDte);

  const gexTitle = isAllExp
    ? "NET GEX"
    : isZeroDte
      ? "0DTE GEX"
      : "WEEK GEX";

  const vexTitle = isAllExp
    ? "NET VEX"
    : isZeroDte
      ? "0DTE VEX"
      : "WEEK VEX";

  const allExpKing = kingNode.allExpKing ?? allExpKingNode?.allExpKing ?? 760;
  const weeklyKing = kingNode.weeklyKing ?? allExpKingNode?.weeklyKing ?? 765;
  const weeklyDate =
    kingNode.weeklyDate ?? allExpKingNode?.weeklyDate ?? "10-16";
  const zeroDteKing =
    kingNode.zeroDteKing ?? allExpKingNode?.zeroDteKing ?? 760;
  const zeroDteDate =
    kingNode.zeroDteDate ?? allExpKingNode?.zeroDteDate ?? "10-16";
  const hasZeroDte = kingNode.hasZeroDte ?? true;

  // Hyperion multi-king summary format: 0DTE/Next King · Week King · All-exp King
  const firstTierLabel = hasZeroDte ? "0DTE King" : "Next King";
  const multiKingSummary = `${firstTierLabel} ${zeroDteKing.toFixed(0)} (${zeroDteDate}) · Week King ${weeklyKing.toFixed(0)} (${weeklyDate}) · All-exp King ${allExpKing.toFixed(0)}`;

  return (
    <section
      aria-label="Gamma Summary & Structural Walls"
      className="space-y-3"
    >
      {/* Row A: 3 Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {/* Card 1: Dynamic NET GEX / WEEK GEX / 0DTE GEX */}
        <div className="argon-card rounded-xl p-4 flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-mono font-bold uppercase tracking-widest text-slate-400">
              {gexTitle}
            </span>
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[10px] font-mono font-bold",
                isLongGex
                  ? "bg-teal-500/15 text-teal-300 border border-teal-400/40"
                  : "bg-purple-500/20 text-purple-300 border border-purple-400/40"
              )}
            >
              {isLongGex ? "Dealer Long γ" : "Dealer Short γ"}
            </span>
          </div>
          <div className="my-auto py-2">
            <div
              className={cn(
                "text-2xl sm:text-3xl font-mono font-extrabold tabular-nums",
                isLongGex ? "text-[#14b8a6]" : "text-[#c084fc]"
              )}
            >
              {formatExposure(netGex * 1000)}
            </div>
          </div>
          <div className="text-[11px] font-mono text-slate-400">
            {isLongGex
              ? "Dealers dampen moves · buy dips / sell rips"
              : "Dealers amplify moves · hedge with trend"}
          </div>
        </div>

        {/* Card 2: Dynamic NET VEX / WEEK VEX / 0DTE VEX */}
        <div className="argon-card rounded-xl p-4 flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-mono font-bold uppercase tracking-widest text-slate-400">
              {vexTitle}
            </span>
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[10px] font-mono font-bold",
                isLongVex
                  ? "bg-emerald-500/15 text-emerald-300 border border-emerald-400/40"
                  : "bg-amber-500/15 text-amber-300 border border-amber-400/40"
              )}
            >
              {isLongVex ? "+Vanna Flow" : "-Vanna Flow"}
            </span>
          </div>
          <div className="my-auto py-2">
            <div
              className={cn(
                "text-2xl sm:text-3xl font-mono font-extrabold tabular-nums",
                isLongVex ? "text-emerald-400" : "text-amber-400"
              )}
            >
              {formatExposure(netVex)}
            </div>
          </div>
          <div className="text-[11px] font-mono text-slate-400">
            {isLongVex
              ? "IV compression supports dealer delta buying"
              : "IV expansion pressures downside hedging"}
          </div>
        </div>

        {/* Card 3: Simultaneous Multi-King Display (ALL-EXP, WEEK, 0DTE/NEXT) */}
        <div className="argon-card rounded-xl p-4 flex flex-col justify-between border-amber-400/35 shadow-[0_0_20px_rgba(251,191,36,0.12)]">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-mono font-bold uppercase tracking-widest text-amber-300">
              KING NODES
            </span>
            <span className="rounded-full bg-amber-400/20 border border-amber-300/50 px-2 py-0.5 text-[10px] font-mono font-bold text-amber-300 shrink-0">
              Strength {kingNode.kingStrength}/100
              {kingNode.isContested ? " · contested" : ""}
            </span>
          </div>

          {/* Simultaneous 3-King Tiers Display */}
          <div className="mt-2 grid grid-cols-3 gap-1.5 pt-0.5">
            {/* 0DTE / Next King */}
            <div
              className={cn(
                "rounded-lg px-2 py-1.5 transition-all border",
                isZeroDte
                  ? "bg-amber-400/20 border-amber-400/60 shadow-[0_0_12px_rgba(251,191,36,0.2)]"
                  : "bg-white/[0.03] border-white/[0.06]"
              )}
            >
              <div className="text-[10px] font-mono font-bold uppercase text-slate-400 truncate">
                {firstTierLabel}
              </div>
              <div className="text-lg sm:text-xl font-mono font-extrabold text-amber-300 tabular-nums leading-tight mt-0.5">
                ${zeroDteKing.toFixed(0)}
              </div>
              <div className="text-[10px] font-mono text-slate-400 mt-0.5">
                ({zeroDteDate})
              </div>
            </div>

            {/* Week King */}
            <div
              className={cn(
                "rounded-lg px-2 py-1.5 transition-all border",
                isThisWeek
                  ? "bg-amber-400/20 border-amber-400/60 shadow-[0_0_12px_rgba(251,191,36,0.2)]"
                  : "bg-white/[0.03] border-white/[0.06]"
              )}
            >
              <div className="text-[10px] font-mono font-bold uppercase text-slate-400 truncate">
                Week King
              </div>
              <div className="text-lg sm:text-xl font-mono font-extrabold text-amber-300 tabular-nums leading-tight mt-0.5">
                ${weeklyKing.toFixed(0)}
              </div>
              <div className="text-[10px] font-mono text-slate-400 mt-0.5">
                ({weeklyDate})
              </div>
            </div>

            {/* All-exp King */}
            <div
              className={cn(
                "rounded-lg px-2 py-1.5 transition-all border",
                isAllExp
                  ? "bg-amber-400/20 border-amber-400/60 shadow-[0_0_12px_rgba(251,191,36,0.2)]"
                  : "bg-white/[0.03] border-white/[0.06]"
              )}
            >
              <div className="text-[10px] font-mono font-bold uppercase text-slate-400 truncate">
                All-exp
              </div>
              <div className="text-lg sm:text-xl font-mono font-extrabold text-amber-300 tabular-nums leading-tight mt-0.5">
                ${allExpKing.toFixed(0)}
              </div>
              <div className="text-[10px] font-mono text-slate-400 mt-0.5">
                Global
              </div>
            </div>
          </div>

          {/* Subtext: Exact Hyperion String */}
          <div
            className="mt-2 text-[11px] font-mono text-slate-300 truncate"
            title={multiKingSummary}
          >
            {multiKingSummary}
          </div>
        </div>
      </div>

      {/* Row B: Unified Walls + Slider Card */}
      <GammaProgressBar />
    </section>
  );
}
