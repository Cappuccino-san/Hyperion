"use client";

import React from "react";
import {
  getFridayEtShort,
  getTodayEtShort,
  useDashboardStore,
} from "@/store/useDashboardStore";
import { cn } from "@/lib/utils";

export function ExpectedMovesBadges() {
  const activeTicker = useDashboardStore((state) => state.activeTicker);
  const spotPrice = useDashboardStore((state) => state.spotPrice);
  const impliedVolatility = useDashboardStore(
    (state) => state.impliedVolatility
  );
  const chainExpirations = useDashboardStore((state) => state.chainExpirations);
  const expectedMoves = useDashboardStore((state) => state.expectedMoves);

  if (!expectedMoves) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs font-mono py-1">
        <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
        <span className="text-slate-400">Loading live expected moves...</span>
      </div>
    );
  }

  const dailyDate =
    expectedMoves.daily?.exp?.slice(5) ??
    chainExpirations[0]?.dateLabel ??
    getTodayEtShort();
  const weekCols = chainExpirations.filter((c) => c.inThisWeek);
  const weeklyDate =
    expectedMoves.weekly?.exp?.slice(5) ??
    weekCols[weekCols.length - 1]?.dateLabel ??
    chainExpirations[Math.min(4, Math.max(0, chainExpirations.length - 1))]
      ?.dateLabel ??
    getFridayEtShort();
  const monthlyDate =
    expectedMoves.monthly?.exp?.slice(5) ??
    chainExpirations.find((c) => c.filterGroup === "OPEX")?.dateLabel ??
    "11-20";

  const dailyEm = expectedMoves.daily?.em ?? 1.28;
  const dailyLow =
    expectedMoves.daily?.low ?? Number((spotPrice - dailyEm).toFixed(2));
  const dailyHigh =
    expectedMoves.daily?.high ?? Number((spotPrice + dailyEm).toFixed(2));

  const weeklyEm = expectedMoves.weekly?.em ?? 5.09;
  const weeklyLow =
    expectedMoves.weekly?.low ?? Number((spotPrice - weeklyEm).toFixed(2));
  const weeklyHigh =
    expectedMoves.weekly?.high ?? Number((spotPrice + weeklyEm).toFixed(2));

  const monthlyEm = expectedMoves.monthly?.em ?? 20.0;
  const monthlyLow =
    expectedMoves.monthly?.low ?? Number((spotPrice - monthlyEm).toFixed(2));
  const monthlyHigh =
    expectedMoves.monthly?.high ?? Number((spotPrice + monthlyEm).toFixed(2));

  const isAnnualSupported = ["SPX", "SPXW", "SPY", "QQQ"].includes(
    activeTicker.toUpperCase()
  );

  const annualObj = isAnnualSupported
    ? (expectedMoves?.annual ??
      (activeTicker === "SPY"
        ? { exp: "2026", em: 114.18, pct: 16.75, low: 567.74, high: 796.1, fixed: true }
        : activeTicker === "SPXW" || activeTicker === "SPX"
          ? { exp: "2026", em: 1141.8, pct: 16.75, low: 5677.4, high: 7961.0, fixed: true }
          : activeTicker === "QQQ"
            ? { exp: "2026", em: 108.45, pct: 18.2, low: 487.45, high: 704.35, fixed: true }
            : null))
    : null;

  return (
    <div className="flex flex-wrap items-center gap-2 pt-2">
      {/* Daily (D) - White */}
      <div className="inline-flex items-center gap-1.5 rounded-full border border-[#ffffff] bg-[#111520] text-slate-200 px-3 py-1 text-[11px] font-mono tabular-nums">
        <b className="font-bold text-white">Daily</b>
        <span className="font-semibold">±${dailyEm.toFixed(2)}</span>
        <span className="opacity-90">
          ({dailyLow.toFixed(2)}–{dailyHigh.toFixed(2)})
        </span>
        <span className="opacity-75">· {dailyDate}</span>
      </div>

      {/* Weekly (W) - Yellow */}
      <div className="inline-flex items-center gap-1.5 rounded-full border border-[#facc15] bg-[#111520] text-slate-200 px-3 py-1 text-[11px] font-mono tabular-nums">
        <b className="font-bold text-[#facc15]">Weekly</b>
        <span className="font-semibold">±${weeklyEm.toFixed(2)}</span>
        <span className="opacity-90">
          ({weeklyLow.toFixed(2)}–{weeklyHigh.toFixed(2)})
        </span>
        <span className="opacity-75">· {weeklyDate}</span>
      </div>

      {/* Monthly (M) - Orange */}
      <div className="inline-flex items-center gap-1.5 rounded-full border border-[#fb923c] bg-[#111520] text-slate-200 px-3 py-1 text-[11px] font-mono tabular-nums">
        <b className="font-bold text-[#fb923c]">Monthly</b>
        <span className="font-semibold">±${monthlyEm.toFixed(2)}</span>
        <span className="opacity-90">
          ({monthlyLow.toFixed(2)}–{monthlyHigh.toFixed(2)})
        </span>
        <span className="opacity-75">· {monthlyDate}</span>
      </div>

      {/* Annual (A) - Red/Coral (for SPY, SPX/SPXW, QQQ) */}
      {annualObj && (
        <div
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border border-[#f87171] bg-[#111520] text-slate-200 px-3 py-1 text-[11px] font-mono tabular-nums"
          )}
        >
          <b className="font-bold text-[#f87171]">Annual {annualObj.exp}</b>
          {!annualObj.fixed && (
            <span className="font-semibold">±${annualObj.em.toFixed(2)}</span>
          )}
          <span className="opacity-90">
            ({annualObj.low.toFixed(2)}–{annualObj.high.toFixed(2)})
          </span>
        </div>
      )}
    </div>
  );
}
