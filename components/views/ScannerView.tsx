"use client";

import React, { useMemo, useState } from "react";
import {
  buildKingNodeMetrics,
  getTickerPreset,
  useDashboardStore,
} from "@/store/useDashboardStore";
import { cn } from "@/lib/utils";

const SCANNER_TICKERS = [
  "IBIT",
  "SMCI",
  "AAPL",
  "NDX",
  "ARM",
  "NVDA",
  "TSLA",
  "QQQ",
  "SPY",
  "SMH",
] as const;

interface ScannerEntry {
  ticker: string;
  spot: number;
  kingStrike: number;
  kingStrength: number;
  pullScore: number;
  kingMoved: boolean;
  timestamp: string;
  distPct: number;
  distPts: number;
  vsDailyEm: number;
  isPositiveGamma: boolean;
}

export function ScannerView() {
  const setTicker = useDashboardStore((state) => state.setTicker);
  const setActiveView = useDashboardStore((state) => state.setActiveView);
  const [scanSession, setScanSession] = useState<"9:35 open" | "3:50 close">(
    "9:35 open"
  );

  const rankedItems = useMemo<ScannerEntry[]>(() => {
    const list: ScannerEntry[] = SCANNER_TICKERS.map((sym, idx) => {
      const preset = getTickerPreset(sym);
      const kingMetrics = buildKingNodeMetrics(preset, "ALL");

      // Slight deterministic score adjustment between 9:35 open and 3:50 close scan
      const sessionDelta =
        scanSession === "3:50 close" ? ((idx % 3) - 1) * 4 : 0;
      const strength = Math.min(
        96,
        Math.max(42, kingMetrics.kingStrength + sessionDelta)
      );

      const spot = preset.spotPrice;
      const kingStrike = kingMetrics.allExpKing;
      const distPts = kingStrike - spot;
      const distPct = spot > 0 ? (distPts / spot) * 100 : 0;

      const dailyEm =
        spot * preset.impliedVolatility * Math.sqrt(1 / 252);
      const vsDailyEm =
        dailyEm > 0 ? Math.abs(distPts) / dailyEm : 0;

      // Scanner Pull Score (0–100):
      // Combine kingStrength * 0.6 + Math.max(0, 1 - Math.abs(spotPrice - kingStrike) / (1.5 * dailyExpectedMove)) * 40
      const pullScore = Math.round(
        strength * 0.6 +
        Math.max(
          0,
          1 - Math.abs(spot - kingStrike) / (1.5 * Math.max(0.01, dailyEm))
        ) * 40
      );

      const isPositiveGamma =
        spot > preset.gammaLevels.zeroGamma && preset.netMetrics.netGex > 0;

      const kingMoved = sym === "SMCI" || sym === "NVDA" || sym === "TSLA";

      return {
        ticker: sym,
        spot,
        kingStrike,
        kingStrength: strength,
        pullScore,
        kingMoved,
        timestamp:
          scanSession === "9:35 open"
            ? "Oct 16, 1:04 PM ET"
            : "Oct 16, 3:50 PM ET",
        distPct,
        distPts,
        vsDailyEm,
        isPositiveGamma,
      };
    });

    return list.sort((a, b) => b.pullScore - a.pullScore);
  }, [scanSession]);

  return (
    <div className="space-y-4">
      {/* Scanner Header Card */}
      <div className="argon-card rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-extrabold text-white tracking-tight">
            King Node Scanner
          </h1>
          <p className="text-xs font-mono text-slate-400">
            {scanSession === "9:35 open"
              ? "9:35 AM ET open scan · Fri, Oct 16"
              : "3:50 PM ET close scan · Fri, Oct 16"}
          </p>
          <p className="mt-1 text-[11px] font-mono text-[#11cdef]">
            Tap a ticker to open its heatmap
          </p>
        </div>

        {/* Scan Session Toggle: [9:35 open | 3:50 close] */}
        <div className="inline-flex items-center rounded-full bg-[#0b0d17] p-1 border border-white/10">
          {(["9:35 open", "3:50 close"] as const).map((mode) => {
            const active = scanSession === mode;
            return (
              <button
                key={mode}
                type="button"
                onClick={() => setScanSession(mode)}
                className={cn(
                  "px-3.5 py-1 rounded-full text-xs font-mono font-bold transition-all",
                  active
                    ? "bg-[#1c223a] border border-[#5e72e4] text-white shadow-[0_0_10px_rgba(94,114,228,0.5)]"
                    : "text-slate-400 hover:text-white"
                )}
              >
                {mode}
              </button>
            );
          })}
        </div>
      </div>

      {/* Ranked List of Ticker Cards */}
      <div className="space-y-3">
        {rankedItems.map((item, idx) => {
          const rank = idx + 1;
          const isPositiveDist = item.distPts >= 0;

          return (
            <button
              key={item.ticker}
              type="button"
              onClick={() => {
                setTicker(item.ticker);
                setActiveView("Heatmap");
              }}
              className="w-full text-left argon-card rounded-xl p-4 hover:border-[#5e72e4]/60 hover:bg-[#15192b] transition-all space-y-3 group"
            >
              {/* Top Row: Rank (#1), Ticker (IBIT), Spot ($46.25), and Top-Right Rounded Score Pill */}
              <div className="flex items-center justify-between">
                <div className="flex items-baseline gap-2.5">
                  <span className="font-mono text-sm font-bold text-slate-400">
                    #{rank}
                  </span>
                  <span className="text-lg font-extrabold text-white group-hover:text-[#11cdef] transition-colors">
                    {item.ticker}
                  </span>
                  <span className="font-mono text-base font-bold text-slate-200 tabular-nums">
                    ${item.spot.toFixed(2)}
                  </span>
                </div>

                <span
                  title={`Pull Score ${item.pullScore}/100 · King Strength ${item.kingStrength}`}
                  className="inline-flex items-center justify-center rounded-full bg-amber-400/20 border border-amber-300/60 px-3 py-0.5 font-mono text-sm font-extrabold text-yellow-300 shadow-[0_0_12px_rgba(250,204,21,0.3)]"
                >
                  {item.pullScore}
                </span>
              </div>

              {/* 3-Column Metrics Grid: KING | DISTANCE | VS EM */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 rounded-lg bg-[#0b0d17]/90 border border-white/10 p-3 font-mono">
                {/* Col 1: KING */}
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                    KING
                  </div>
                  <div className="mt-0.5 flex items-center gap-2">
                    <span className="text-base font-extrabold text-yellow-400 tabular-nums">
                      {item.kingStrike.toFixed(0)}
                    </span>
                    {item.kingMoved && (
                      <span className="rounded bg-amber-500/20 border border-amber-400/50 px-1.5 py-0.2 text-[9px] font-bold text-amber-300">
                        King moved
                      </span>
                    )}
                  </div>
                  <div className="text-[10px] text-slate-500">
                    {item.timestamp}
                  </div>
                </div>

                {/* Col 2: DISTANCE */}
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                    DISTANCE
                  </div>
                  <div
                    className={cn(
                      "mt-0.5 text-sm font-bold tabular-nums",
                      isPositiveDist ? "text-emerald-300" : "text-rose-300"
                    )}
                  >
                    {isPositiveDist ? "+" : ""}
                    {item.distPct.toFixed(1)}% · {isPositiveDist ? "+" : ""}
                    {item.distPts.toFixed(2)} pts
                  </div>
                  <div className="text-[10px] text-slate-500">
                    From current spot
                  </div>
                </div>

                {/* Col 3: VS EM */}
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                    VS EM
                  </div>
                  <div className="mt-0.5 text-sm font-bold text-white tabular-nums">
                    {item.vsDailyEm.toFixed(1)}× daily EM
                  </div>
                  <div className="text-[10px] text-slate-500">
                    {item.vsDailyEm <= 1.0
                      ? "Inside 1D expected move"
                      : "Outside 1D expected move"}
                  </div>
                </div>
              </div>

                  {/* Bottom Row: Regime Pill + King Strength Label + Gold Progress Bar */}
              <div className="flex flex-wrap items-center gap-3 pt-0.5">
                <span
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[10px] font-mono font-bold",
                    item.isPositiveGamma
                      ? "bg-teal-500/15 border-teal-400/40 text-teal-300"
                      : "bg-purple-500/20 border-purple-400/50 text-purple-300"
                  )}
                >
                  <span
                    className={cn(
                      "h-1.5 w-1.5 rounded-full",
                      item.isPositiveGamma ? "bg-teal-400" : "bg-purple-400"
                    )}
                  />
                  {item.isPositiveGamma ? "Positive γ" : "Negative γ"}
                </span>

                <span className="text-[11px] font-mono text-slate-400">
                  King strength
                </span>

                <div className="flex-1 h-2 rounded-full bg-[#0b0d17] border border-white/10 overflow-hidden">
                  <div
                    style={{ width: `${item.kingStrength}%` }}
                    className="h-full rounded-full bg-yellow-400 shadow-[0_0_10px_rgba(250,204,21,0.8)] transition-all duration-300"
                  />
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {/* Official Hyperion Scanner Glossary & Explainer Footer */}
      <div className="argon-card rounded-xl p-5 space-y-3 text-xs leading-relaxed text-slate-300 border border-white/10">
        <div className="space-y-2">
          <p>
            <strong className="font-bold text-white">King</strong> – the
            all-expirations King, the strike with the largest total gamma. It
            tends to pull price toward it.{" "}
            <strong className="font-bold text-amber-300">contested</strong>{" "}
            means the next strike is within about 10%.
          </p>
          <p>
            <strong className="font-bold text-white">Book</strong> – when that
            row&apos;s book was taken.
          </p>
          <p>
            <strong className="font-bold text-white">King moved</strong> – a
            newer book changed the all-expirations King, so the row was rescored
            or flagged.
          </p>
          <p>
            <strong className="font-bold text-white">Distance</strong> – how far
            the King is from the price now.
          </p>
          <p>
            <strong className="font-bold text-white">vs EM</strong> – that
            distance compared with today&apos;s expected move.
          </p>
          <p>
            <strong className="font-bold text-white">Gamma regime</strong> –
            Negative γ means bigger moves; Positive γ means calmer, pinned
            trading.
          </p>
          <p>
            <strong className="font-bold text-white">King strength</strong> –
            how much the King stands out from the next-biggest strike.
          </p>
          <p>
            <strong className="font-bold text-white">Pull score</strong> – a
            0–100 ranking of how strong the pull to the King looks. It&apos;s a
            ranking, not a prediction.
          </p>
        </div>

        {/* Standard Footer Links & Disclaimer */}
        <div className="border-t border-white/10 pt-3 mt-3 space-y-1.5 text-[11px] font-mono text-slate-400">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-slate-300">
              Hyperion Quant Options &amp; Gamma Intelligence
            </span>
          </div>
          <p className="italic text-slate-500">
            For educational and informational purposes only. Not financial
            advice. Data may be delayed or inaccurate; trade at your own risk.
          </p>
        </div>
      </div>
    </div>
  );
}
