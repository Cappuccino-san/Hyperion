"use client";

import React from "react";
import { getFridayEtShort, getTodayEtShort, useDashboardStore } from "@/store/useDashboardStore";
import { GammaProgressBar } from "./GammaProgressBar";
import { formatExposure } from "@/lib/optionsExposure";
import { cn } from "@/lib/utils";

export function MetricsRow() {
  const { netGex, netVex, netDex = 0, netCharm = 0 } = useDashboardStore(
    (state) => state.netMetrics
  );
  const kingNode = useDashboardStore((state) => state.kingNode);
  const allExpKingNode = useDashboardStore((state) => state.allExpKingNode);
  const activeMetric = useDashboardStore((state) => state.gridFilters.metric);
  const expirationFilter = useDashboardStore(
    (state) => state.gridFilters.expiration
  );

  const hasZeroDte = kingNode.hasZeroDte ?? allExpKingNode?.hasZeroDte ?? true;
  const isAllExp = expirationFilter === "ALL";
  const isZeroDte = expirationFilter === "0DTE";
  const isThisWeek = expirationFilter === "THIS_WEEK";

  const prefix = isAllExp
    ? "NET "
    : isThisWeek
      ? "WEEK "
      : isZeroDte
        ? hasZeroDte
          ? "0DTE "
          : "NEXT EXP "
        : expirationFilter === "OPEX"
          ? "OPEX "
          : `${expirationFilter} `;

  const gexTitle = `${prefix}GEX`;
  const altMetric = activeMetric === "GEX" ? "VEX" : activeMetric.toUpperCase();
  const secondTitle = `${prefix}${altMetric}`;
  const secondValueM =
    altMetric === "DEX"
      ? netDex
      : altMetric === "CHARM"
        ? netCharm
        : netVex;

  const isLongGex = netGex >= 0;
  const isLongSecond = secondValueM >= 0;

  const allExpKing = kingNode.allExpKing ?? allExpKingNode?.allExpKing ?? 760;
  const weeklyKing = kingNode.weeklyKing ?? allExpKingNode?.weeklyKing ?? 765;
  const weeklyDate =
    kingNode.weeklyDate ?? allExpKingNode?.weeklyDate ?? getFridayEtShort();
  const zeroDteKing =
    kingNode.zeroDteKing ?? allExpKingNode?.zeroDteKing ?? 760;
  const zeroDteDate =
    kingNode.zeroDteDate ?? allExpKingNode?.zeroDteDate ?? getTodayEtShort();

  const firstTierLabel = hasZeroDte ? "0DTE King" : "Next exp King";
  const isContested = kingNode.isContested || allExpKingNode?.isContested;

  // TerraShade exact kingPhrase():
  // When All exp: "All-exp King 760 · contested"
  // When filtered: "{Filter} King {strike} ({MM-DD}) · All-exp King {allExpKing} · contested"
  let kingPhrase = `All-exp King ${allExpKing.toFixed(0)}${
    isContested ? " · contested" : ""
  }`;
  if (!isAllExp) {
    if (isZeroDte) {
      kingPhrase = `${firstTierLabel} ${zeroDteKing.toFixed(0)} (${zeroDteDate}) · All-exp King ${allExpKing.toFixed(0)}${
        isContested ? " · contested" : ""
      }`;
    } else if (isThisWeek) {
      kingPhrase = `Week King ${weeklyKing.toFixed(0)} (${weeklyDate}) · All-exp King ${allExpKing.toFixed(0)}${
        isContested ? " · contested" : ""
      }`;
    } else {
      const filtStrike = kingNode.filteredKing ?? allExpKing;
      const dateMatch =
        kingNode.filteredLabel?.match(/\(([^)]+)\)/)?.[1] ?? expirationFilter;
      kingPhrase = `${dateMatch} King ${filtStrike.toFixed(0)} (${dateMatch}) · All-exp King ${allExpKing.toFixed(0)}${
        isContested ? " · contested" : ""
      }`;
    }
  }

  return (
    <section
      aria-label="Gamma Summary & Structural Walls"
      className="space-y-3"
    >
      {/* Row A: 3 Summary Cards (#stats) */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {/* Card 1: Dynamic NET GEX / WEEK GEX / 0DTE GEX / NEXT EXP GEX */}
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

        {/* Card 2: Dynamic VEX / DEX / CHARM */}
        <div className="argon-card rounded-xl p-4 flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-mono font-bold uppercase tracking-widest text-slate-400">
              {secondTitle}
            </span>
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[10px] font-mono font-bold",
                isLongSecond
                  ? "bg-emerald-500/15 text-emerald-300 border border-emerald-400/40"
                  : "bg-amber-500/15 text-amber-300 border border-amber-400/40"
              )}
            >
              {isLongSecond ? `+${altMetric} Flow` : `-${altMetric} Flow`}
            </span>
          </div>
          <div className="my-auto py-2">
            <div
              className={cn(
                "text-2xl sm:text-3xl font-mono font-extrabold tabular-nums",
                isLongSecond ? "text-emerald-400" : "text-amber-400"
              )}
            >
              {formatExposure(secondValueM)}
            </div>
          </div>
          <div className="text-[11px] font-mono text-slate-400">
            {altMetric === "VEX"
              ? isLongSecond
                ? "IV compression supports dealer delta buying"
                : "IV expansion pressures downside hedging"
              : altMetric === "DEX"
                ? "Net dealer delta notional across active book"
                : "Daily delta decay across active book"}
          </div>
        </div>

        {/* Card 3: King Node Summary Card */}
        <div className="argon-card rounded-xl p-4 flex flex-col justify-between border-amber-400/35 shadow-[0_0_20px_rgba(251,191,36,0.12)]">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-mono font-bold uppercase tracking-widest text-amber-300">
              KING
            </span>
            <span className="rounded-full bg-amber-400/20 border border-amber-300/50 px-2 py-0.5 text-[10px] font-mono font-bold text-amber-300 shrink-0">
              Strength {kingNode.kingStrength}/100
              {isContested ? " · contested" : ""}
            </span>
          </div>

          <div className="my-auto py-2">
            <div className="text-base sm:text-lg font-mono font-extrabold text-[#facc15] leading-snug">
              ★ {kingPhrase}
            </div>
          </div>

          {/* 3-King Horizon Reference Row */}
          <div className="text-[11px] font-mono text-slate-400 truncate">
            {firstTierLabel} {zeroDteKing.toFixed(0)} ({zeroDteDate}) · Week{" "}
            {weeklyKing.toFixed(0)} ({weeklyDate}) · All-exp{" "}
            {allExpKing.toFixed(0)}
          </div>
        </div>
      </div>

      {/* Row B: Unified Levels & Wall-to-Wall Corridor Card */}
      <GammaProgressBar kingPhrase={kingPhrase} />
    </section>
  );
}
