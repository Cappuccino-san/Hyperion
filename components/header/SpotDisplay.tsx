"use client";

import React from "react";
import { getStaticTickerPreset, useDashboardStore } from "@/store/useDashboardStore";
import { ExpectedMovesBadges } from "./ExpectedMovesBadges";
import { cn } from "@/lib/utils";
import { Database, RefreshCw } from "lucide-react";

const NO_EXT = new Set(["SPX", "^SPX", "NDX", "^NDX", "SPXW", "NDXP"]);

export function SpotDisplay() {
  const activeTicker = useDashboardStore((state) => state.activeTicker);
  const spotPrice = useDashboardStore((state) => state.spotPrice);
  const previousClose = useDashboardStore((state) => state.previousClose);
  const impliedVolatility = useDashboardStore((state) => state.impliedVolatility);
  const { netGex } = useDashboardStore((state) => state.netMetrics);
  const dataSource = useDashboardStore((state) => state.dataSource);
  const isLoadingChain = useDashboardStore((state) => state.isLoadingChain);
  const connectionStatus = useDashboardStore((state) => state.connectionStatus);
  const isStaleSnapshot = useDashboardStore((state) => state.isStaleSnapshot);
  const cboeSpotLagDollars = useDashboardStore((state) => state.cboeSpotLagDollars);
  const liveTickMarketOpen = useDashboardStore((state) => state.liveTickMarketOpen);
  const lastUpdated = useDashboardStore((state) => state.lastUpdated);
  const bookTimestamp = useDashboardStore((state) => state.bookTimestamp);
  const extendedQuote = useDashboardStore((state) => state.extendedQuote);
  const fetchOptionsChain = useDashboardStore(
    (state) => state.fetchOptionsChain
  );

  const hasValidSpot = Number.isFinite(spotPrice) && spotPrice > 0;
  const hasValidPrevClose = Number.isFinite(previousClose) && previousClose > 0;
  const absChange = hasValidSpot && hasValidPrevClose ? spotPrice - previousClose : 0;
  const pctChange = hasValidSpot && hasValidPrevClose ? (absChange / previousClose) * 100 : 0;
  const isPositive = absChange >= 0;
  const isPositiveGamma = netGex >= 0;
  const preset = getStaticTickerPreset(activeTicker);
  const showExtended =
    extendedQuote &&
    Number.isFinite(extendedQuote.price) &&
    extendedQuote.price > 0 &&
    !NO_EXT.has(activeTicker.toUpperCase());

  const isSyncing =
    connectionStatus === "SYNCING" ||
    connectionStatus === "RECONNECTING" ||
    isStaleSnapshot;

  const sourceBadge = isLoadingChain
    ? {
        label: isSyncing ? "SYNCING..." : "LOADING...",
        className:
          "bg-cyan-500/15 text-cyan-300 border-cyan-400/40 animate-pulse",
      }
    : isSyncing
      ? {
          label: "LIVE (SYNCING)",
          className:
            "bg-amber-500/15 text-amber-300 border-amber-400/40 shadow-[0_0_10px_rgba(245,158,11,0.2)]",
        }
      : dataSource === "TRADIER_LIVE"
        ? {
            label: "TRADIER LIVE",
            className:
              "bg-emerald-500/15 text-emerald-300 border-emerald-400/40",
          }
        : {
            label: "LIVE",
            className:
              "bg-emerald-500/15 text-emerald-300 border-emerald-400/40",
          };

  return (
    <div className="argon-card rounded-xl p-4 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* Left: Ticker + Huge Bold Price + Inline Red/Green Delta + Extended Hours Sun/Moon */}
        <div className="space-y-1">
          <div className="flex flex-wrap items-baseline gap-3">
            <span className="text-xl sm:text-2xl font-extrabold tracking-tight text-white">
              {activeTicker}
            </span>
            <span className="font-mono text-2xl sm:text-3xl font-extrabold tracking-tight text-white tabular-nums">
              {hasValidSpot
                ? `$${spotPrice.toLocaleString("en-US", {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}`
                : "—"}
            </span>
            {hasValidSpot && hasValidPrevClose ? (
              <span
                className={cn(
                  "font-mono text-sm font-bold tabular-nums",
                  isPositive ? "text-emerald-400" : "text-rose-400"
                )}
              >
                {isPositive ? "+" : ""}
                {absChange.toFixed(2)} ({isPositive ? "+" : ""}
                {pctChange.toFixed(2)}%)
              </span>
            ) : (
              <span className="font-mono text-xs font-semibold text-slate-400">
                Syncing live quote...
              </span>
            )}
            <span className="hidden md:inline text-xs font-mono text-slate-500">
              {preset.name}
              {hasValidSpot && Number.isFinite(impliedVolatility) && impliedVolatility > 0
                ? ` · IV30 ${(impliedVolatility * 100).toFixed(1)}%`
                : ""}
            </span>
          </div>

          {/* Pre-Market (Sun) / After-Hours (Moon) Extended Price Indicator */}
          {showExtended && (
            <div className="flex items-center gap-2 text-xs font-mono text-slate-300">
              {extendedQuote.type === "pre" ? (
                <svg
                  className="w-3.5 h-3.5 shrink-0"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#facc15"
                  strokeWidth="2"
                  strokeLinecap="round"
                >
                  <circle cx="12" cy="12" r="4" fill="#facc15" />
                  <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
                </svg>
              ) : (
                <svg
                  className="w-3.5 h-3.5 shrink-0"
                  viewBox="0 0 24 24"
                  fill="#c4b5fd"
                >
                  <path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79z" />
                </svg>
              )}
              <b className="text-slate-100 font-bold">
                ${extendedQuote.price.toFixed(2)}
              </b>
              <span
                className={cn(
                  "font-semibold",
                  extendedQuote.change >= 0
                    ? "text-emerald-400"
                    : "text-rose-400"
                )}
              >
                {extendedQuote.change >= 0 ? "+" : ""}
                {extendedQuote.change.toFixed(2)} (
                {extendedQuote.changePct >= 0 ? "+" : ""}
                {extendedQuote.changePct.toFixed(2)}%)
              </span>
            </div>
          )}
        </div>

        {/* Right: Timestamp + Green LIVE Pill + Regime Pill + Data Source & Refresh */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-mono text-slate-400 tabular-nums">
            {bookTimestamp ? `book ${bookTimestamp}` : lastUpdated || "--:-- ET"}
          </span>

          {/* Green LIVE / Amber SYNCING / Slate CLOSED indicator */}
          <div
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 border",
              isLoadingChain
                ? "bg-cyan-500/15 border-cyan-400/40"
                : isSyncing
                  ? "bg-amber-500/15 border-amber-400/40"
                  : liveTickMarketOpen === false
                    ? "bg-slate-800/80 border-slate-600/50"
                    : "bg-emerald-500/15 border-emerald-400/40"
            )}
          >
            <span className="relative flex h-2 w-2">
              {(isLoadingChain || liveTickMarketOpen !== false) && !isSyncing && (
                <span
                  className={cn(
                    "animate-ping absolute inline-flex h-full w-full rounded-full opacity-75",
                    isLoadingChain ? "bg-cyan-400" : "bg-emerald-400"
                  )}
                />
              )}
              <span
                className={cn(
                  "relative inline-flex rounded-full h-2 w-2",
                  isLoadingChain
                    ? "bg-cyan-400"
                    : isSyncing
                      ? "bg-amber-400"
                      : liveTickMarketOpen === false
                        ? "bg-slate-400"
                        : "bg-emerald-400"
                )}
              />
            </span>
            <span
              className={cn(
                "text-[10px] font-mono font-bold uppercase tracking-wider",
                isLoadingChain
                  ? "text-cyan-300"
                  : isSyncing
                    ? "text-amber-300 font-extrabold"
                    : liveTickMarketOpen === false
                      ? "text-slate-300"
                      : "text-emerald-300"
              )}
            >
              {isLoadingChain
                ? isSyncing
                  ? "SYNCING..."
                  : "CONNECTING"
                : isSyncing
                  ? "STALE (SYNCING)"
                  : liveTickMarketOpen === false
                    ? "CLOSED"
                    : "LIVE"}
            </span>
          </div>
          {cboeSpotLagDollars !== null && Math.abs(cboeSpotLagDollars) >= 0.35 && (
            <div
              className="inline-flex items-center gap-1 rounded-full border border-amber-500/45 bg-amber-500/15 px-2 py-0.5 text-[10px] font-mono font-bold text-amber-300 tabular-nums"
              title="Difference between live underlying spot and delayed CBOE option chain quote"
            >
              <span>CBOE LAG {cboeSpotLagDollars >= 0 ? "+" : ""}${cboeSpotLagDollars.toFixed(2)}</span>
            </div>
          )}

          {/* Purple / Green Gamma Regime Pill */}
          <div
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-3 py-0.5 text-[11px] font-mono font-semibold",
              isPositiveGamma
                ? "bg-emerald-500/15 border-emerald-400/40 text-emerald-300"
                : "bg-purple-500/20 border-purple-400/50 text-purple-200"
            )}
          >
            <span
              className={cn(
                "h-2 w-2 rounded-full",
                isPositiveGamma ? "bg-emerald-400" : "bg-purple-400"
              )}
            />
            <span>
              {isPositiveGamma
                ? "Positive gamma · expect chop"
                : "Negative gamma · expect bigger moves"}
            </span>
          </div>

          {/* Data Source Indicator Pill */}
          <div
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[10px] font-mono font-bold uppercase",
              sourceBadge.className
            )}
          >
            <Database className="h-3 w-3 shrink-0" />
            <span>{sourceBadge.label}</span>
          </div>

          {/* Manual Refresh Button */}
          <button
            type="button"
            onClick={() => fetchOptionsChain(activeTicker, true)}
            disabled={isLoadingChain}
            className="inline-flex items-center gap-1 rounded-full bg-[#0b0d17] hover:bg-[#1c223a] border border-white/15 px-2.5 py-0.5 text-[10px] font-mono font-semibold text-slate-200 transition-colors disabled:opacity-50 cursor-pointer"
          >
            <RefreshCw
              className={cn(
                "h-3 w-3 text-[#11cdef]",
                isLoadingChain && "animate-spin"
              )}
            />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {/* 4 Color-Coded Expected Move Pills (0.85 × ATM Straddle) */}
      <ExpectedMovesBadges />
    </div>
  );
}
