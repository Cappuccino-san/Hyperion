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

  const fallbackDailyEm = Number(
    (spotPrice * (impliedVolatility / Math.sqrt(252))).toFixed(2)
  );

  const dailyDate =
    expectedMoves?.daily?.exp?.slice(5) ??
    chainExpirations[0]?.dateLabel ??
    getTodayEtShort();
  const weekCols = chainExpirations.filter((c) => c.inThisWeek);
  const weeklyDate =
    expectedMoves?.weekly?.exp?.slice(5) ??
    weekCols[weekCols.length - 1]?.dateLabel ??
    chainExpirations[Math.min(4, Math.max(0, chainExpirations.length - 1))]
      ?.dateLabel ??
    getFridayEtShort();
  const monthlyDate =
    expectedMoves?.monthly?.exp?.slice(5) ??
    chainExpirations.find((c) => c.filterGroup === "OPEX")?.dateLabel ??
    "11-20";

  const dailyEm =
    expectedMoves?.daily?.em ?? (fallbackDailyEm > 0 ? fallbackDailyEm : 1.28);
  const dailyLow =
    expectedMoves?.daily?.low ?? Number((spotPrice - dailyEm).toFixed(2));
  const dailyHigh =
    expectedMoves?.daily?.high ?? Number((spotPrice + dailyEm).toFixed(2));

  const weeklyEm =
    expectedMoves?.weekly?.em ?? Number((dailyEm * Math.sqrt(5)).toFixed(2));
  const weeklyLow =
    expectedMoves?.weekly?.low ?? Number((spotPrice - weeklyEm).toFixed(2));
  const weeklyHigh =
    expectedMoves?.weekly?.high ?? Number((spotPrice + weeklyEm).toFixed(2));

  const monthlyEm =
    expectedMoves?.monthly?.em ?? Number((dailyEm * Math.sqrt(21)).toFixed(2));
  const monthlyLow =
    expectedMoves?.monthly?.low ?? Number((spotPrice - monthlyEm).toFixed(2));
  const monthlyHigh =
    expectedMoves?.monthly?.high ?? Number((spotPrice + monthlyEm).toFixed(2));

  const isAnnualSupported = ["SPX", "SPXW", "SPY", "QQQ"].includes(
    activeTicker.toUpperCase()
  );

  const annualObj = isAnnualSupported
    ? (expectedMoves?.annual ?? null)
    : null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Daily (D) - Silver */}
      <div className="inline-flex items-center gap-1.5 rounded-full border border-slate-300/75 bg-[#111520] text-slate-200 px-3 py-1 text-[11px] font-mono tabular-nums">
        <b className="font-bold text-slate-200">Daily</b>
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
            "inline-flex items-center gap-1.5 rounded-full border border-[#ef4444] bg-[#111520] text-slate-200 px-3 py-1 text-[11px] font-mono tabular-nums"
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
