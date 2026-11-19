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

  const safeNetGex = Number.isFinite(netGex) ? netGex : 0;
  const safeSecondValueM = Number.isFinite(secondValueM) ? secondValueM : 0;
  const isLongGex = safeNetGex >= 0;
  const isLongSecond = safeSecondValueM >= 0;

  const rawAllExpKing = kingNode.allExpKing ?? allExpKingNode?.allExpKing ?? 0;
  const rawWeeklyKing = kingNode.weeklyKing ?? allExpKingNode?.weeklyKing ?? 0;
  const rawZeroDteKing = kingNode.zeroDteKing ?? allExpKingNode?.zeroDteKing ?? 0;

  const allExpKing = Number.isFinite(rawAllExpKing) ? rawAllExpKing : 0;
  const weeklyKing = Number.isFinite(rawWeeklyKing) ? rawWeeklyKing : 0;
  const zeroDteKing = Number.isFinite(rawZeroDteKing) ? rawZeroDteKing : 0;

  const weeklyDate =
    kingNode.weeklyDate || allExpKingNode?.weeklyDate || getFridayEtShort();
  const zeroDteDate =
    kingNode.zeroDteDate || allExpKingNode?.zeroDteDate || getTodayEtShort();

  const firstTierLabel = hasZeroDte ? "0DTE King" : "Next exp King";
  const isContested = kingNode.isContested || allExpKingNode?.isContested;
  const fmtStrike = (s: number) =>
    Number.isFinite(s) && s > 0
      ? s % 1 !== 0
        ? Number(s.toFixed(2)).toString()
        : s.toFixed(0)
      : "—";

  let kingPhrase =
    allExpKing > 0
      ? `All-exp King ${fmtStrike(allExpKing)}${isContested ? " · contested" : ""}`
      : "Awaiting live King Node...";
  if (!isAllExp && allExpKing > 0) {
    if (isZeroDte) {
      kingPhrase = `${firstTierLabel} ${fmtStrike(zeroDteKing)} (${zeroDteDate}) · All-exp King ${fmtStrike(allExpKing)}${
        isContested ? " · contested" : ""
      }`;
    } else if (isThisWeek) {
      kingPhrase = `Week King ${fmtStrike(weeklyKing)} (${weeklyDate}) · All-exp King ${fmtStrike(allExpKing)}${
        isContested ? " · contested" : ""
      }`;
    } else {
      const rawFiltStrike = kingNode.filteredKing ?? allExpKing;
      const filtStrike = Number.isFinite(rawFiltStrike) ? rawFiltStrike : 0;
      const dateMatch =
        kingNode.filteredLabel?.match(/\(([^)]+)\)/)?.[1] ?? expirationFilter;
      const labelPrefix =
        expirationFilter === "OPEX"
          ? "OPEX"
          : expirationFilter === dateMatch
            ? dateMatch
            : expirationFilter;
      const dateSuffix = labelPrefix === dateMatch ? "" : ` (${dateMatch})`;
      kingPhrase = `${labelPrefix} King ${fmtStrike(filtStrike)}${dateSuffix} · All-exp King ${fmtStrike(allExpKing)}${
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
              {formatExposure(safeNetGex * 1000)}
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
                  : "bg-rose-500/15 text-rose-300 border border-rose-400/40"
              )}
            >
              {isLongSecond ? `+${altMetric} Flow` : `-${altMetric} Flow`}
            </span>
          </div>
          <div className="my-auto py-2">
            <div
              className={cn(
                "text-2xl sm:text-3xl font-mono font-extrabold tabular-nums",
                isLongSecond ? "text-emerald-400" : "text-rose-400"
              )}
            >
              {formatExposure(safeSecondValueM)}
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
              Strength {Number.isFinite(kingNode.kingStrength) ? kingNode.kingStrength : 0}/100
              {isContested ? " · contested" : ""}
            </span>
          </div>

          <div className="my-auto py-2">
            <div className="text-base sm:text-lg font-mono font-extrabold text-[#facc15] leading-snug">
              ★ {kingPhrase}
            </div>
          </div>

          {/* 3-King Horizon Reference Row */}
          <div className="text-[11px] font-mono tabular-nums text-slate-400 leading-snug break-words">
            {allExpKing > 0 ? (
              <>
                {firstTierLabel} {fmtStrike(zeroDteKing)} ({zeroDteDate}) · Week{" "}
                {fmtStrike(weeklyKing)} ({weeklyDate}) · All-exp{" "}
                {fmtStrike(allExpKing)}
              </>
            ) : (
              "Syncing multi-horizon Kings..."
            )}
          </div>
        </div>
      </div>

      {/* Row B: Unified Levels & Wall-to-Wall Corridor Card */}
      <GammaProgressBar kingPhrase={kingPhrase} />
    </section>
  );
}
