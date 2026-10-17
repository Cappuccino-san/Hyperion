"use client";

import React from "react";
import { useDashboardStore } from "@/store/useDashboardStore";
import { cn } from "@/lib/utils";

const EXPECTED_HORIZONS = [
  {
    label: "Daily",
    days: 1,
    dateSuffix: " · 10-16",
    borderClass: "border-slate-300/60 bg-slate-200/5 text-slate-200",
    tagColor: "text-white",
  },
  {
    label: "Weekly",
    days: 5,
    dateSuffix: " · 10-23",
    borderClass: "border-yellow-400/60 bg-yellow-400/10 text-yellow-100",
    tagColor: "text-yellow-300",
  },
  {
    label: "Monthly",
    days: 21,
    dateSuffix: " · 11-20",
    borderClass: "border-orange-400/60 bg-orange-400/10 text-orange-100",
    tagColor: "text-orange-300",
  },
  {
    label: "Annual 2026",
    days: 252,
    dateSuffix: "",
    borderClass: "border-rose-400/60 bg-rose-500/10 text-rose-100",
    tagColor: "text-rose-300",
  },
] as const;

export function ExpectedMovesBadges() {
  const spotPrice = useDashboardStore((state) => state.spotPrice);
  const impliedVolatility = useDashboardStore(
    (state) => state.impliedVolatility
  );
  const chainExpirations = useDashboardStore((state) => state.chainExpirations);

  const dailyDate = chainExpirations[0]?.dateLabel ?? "10-19";
  const weeklyCol =
    chainExpirations.find((c) => c.dteDays >= 4 && c.dteDays <= 7) ??
    chainExpirations[Math.min(4, Math.max(0, chainExpirations.length - 1))];
  const weeklyDate = weeklyCol?.dateLabel ?? "10-23";
  const opexCol =
    chainExpirations.find((c) => c.filterGroup === "OPEX") ??
    chainExpirations[chainExpirations.length - 1];
  const monthlyDate = opexCol?.dateLabel ?? "11-20";

  const horizons = [
    {
      label: "Daily",
      days: 1,
      dateSuffix: ` · ${dailyDate}`,
      borderClass: "border-slate-300/60 bg-slate-200/5 text-slate-200",
      tagColor: "text-white",
    },
    {
      label: "Weekly",
      days: 5,
      dateSuffix: ` · ${weeklyDate}`,
      borderClass: "border-yellow-400/60 bg-yellow-400/10 text-yellow-100",
      tagColor: "text-yellow-300",
    },
    {
      label: "Monthly",
      days: 21,
      dateSuffix: ` · ${monthlyDate}`,
      borderClass: "border-orange-400/60 bg-orange-400/10 text-orange-100",
      tagColor: "text-orange-300",
    },
    {
      label: "Annual 2026",
      days: 252,
      dateSuffix: "",
      borderClass: "border-rose-400/60 bg-rose-500/10 text-rose-100",
      tagColor: "text-rose-300",
    },
  ];

  return (
    <div className="flex flex-wrap items-center gap-2 pt-2">
      {horizons.map((item) => {
        const expectedMove =
          spotPrice * impliedVolatility * Math.sqrt(item.days / 252);
        const lower = spotPrice - expectedMove;
        const upper = spotPrice + expectedMove;

        return (
          <div
            key={item.label}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-mono tabular-nums",
              item.borderClass
            )}
          >
            <span className={cn("font-bold", item.tagColor)}>{item.label}</span>
            {item.label !== "Annual 2026" && (
              <span className="font-semibold">±${expectedMove.toFixed(2)}</span>
            )}
            <span className="opacity-90">
              ({lower.toFixed(2)}–{upper.toFixed(2)})
            </span>
            {item.dateSuffix && (
              <span className="opacity-75">{item.dateSuffix}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
