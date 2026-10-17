"use client";

import React, { useEffect, useState } from "react";
import {
  ROW1_TICKERS,
  ROW2_TICKERS,
  ROW3_TICKERS,
  ROW4_TICKERS,
  ROW5_TICKERS,
  SUPPORTED_TICKERS,
  useDashboardStore,
} from "@/store/useDashboardStore";
import { cn } from "@/lib/utils";
import { AlertTriangle, Loader2, Search, Sparkles, X } from "lucide-react";

export function TickerNav() {
  const activeTicker = useDashboardStore((state) => state.activeTicker);
  const isLoadingChain = useDashboardStore((state) => state.isLoadingChain);
  const dataSource = useDashboardStore((state) => state.dataSource);
  const toastMessage = useDashboardStore((state) => state.toastMessage);
  const setToastMessage = useDashboardStore((state) => state.setToastMessage);
  const setTicker = useDashboardStore((state) => state.setTicker);
  const fetchOptionsChain = useDashboardStore(
    (state) => state.fetchOptionsChain
  );
  const [searchInput, setSearchInput] = useState("");

  // Auto-dismiss toast warning after 6 seconds
  useEffect(() => {
    if (!toastMessage) return;
    const timer = setTimeout(() => {
      setToastMessage(null);
    }, 6000);
    return () => clearTimeout(timer);
  }, [toastMessage, setToastMessage]);

  const loadCustomSymbol = (rawSymbol: string) => {
    const cleaned = rawSymbol.trim().toUpperCase().replace(/^\$/, "");
    if (!cleaned) return;

    // Validate ticker syntax; if invalid format, fallback gracefully with toast warning
    if (!/^[A-Z0-9._-]{1,10}$/.test(cleaned)) {
      setToastMessage("Ticker chain unavailable, using simulation");
      return;
    }

    setToastMessage(null);
    setTicker(cleaned);
    void fetchOptionsChain(cleaned, true, true);
    setSearchInput("");
  };

  const handleLoadSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    loadCustomSymbol(searchInput);
  };

  const handlePresetTickerClick = (ticker: string) => {
    setToastMessage(null);
    setTicker(ticker);
    void fetchOptionsChain(ticker, false, false);
  };

  const isPresetTicker = (SUPPORTED_TICKERS as readonly string[]).includes(
    activeTicker
  );

  return (
    <div className="argon-card rounded-xl p-3.5 space-y-2 relative">
      {/* Toast Warning Notification Banner */}
      {toastMessage && (
        <div
          role="status"
          aria-live="polite"
          className="flex items-center justify-between gap-2 rounded-lg border border-amber-400/50 bg-amber-500/15 px-3 py-2 text-xs font-mono text-amber-200 shadow-[0_0_15px_rgba(245,158,11,0.25)] animate-in fade-in duration-200"
        >
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-3.5 w-3.5 text-amber-400 shrink-0" />
            <span className="font-semibold">{toastMessage}</span>
            <span className="text-[10px] text-amber-300/80 hidden sm:inline">
              ({activeTicker})
            </span>
          </div>
          <button
            type="button"
            onClick={() => setToastMessage(null)}
            className="rounded p-0.5 text-amber-300 hover:bg-amber-400/20 hover:text-white transition-colors"
            aria-label="Dismiss notification"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Full-width dark search bar + cyan-to-indigo Load button */}
      <form onSubmit={handleLoadSubmit} className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search ticker — SPY, SPXW, NDXP, QQQ..."
            aria-label="Search custom optionable equity or ETF ticker"
            className="w-full rounded-lg bg-[#0b0d17] border border-white/15 pl-9 pr-3 py-2 text-xs font-mono text-white placeholder:text-slate-500 focus:outline-none focus:border-[#11cdef]"
          />
        </div>
        <button
          type="submit"
          disabled={isLoadingChain && searchInput.trim().length > 0}
          className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-[#11cdef] to-[#5e72e4] px-4 py-2 text-xs font-mono font-bold text-white shadow-[0_0_12px_rgba(17,205,239,0.4)] hover:opacity-95 disabled:opacity-60 transition-opacity"
        >
          {isLoadingChain ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading
            </>
          ) : (
            "Load"
          )}
        </button>
      </form>

      {/* Row 1 Pills: SPY, QQQ, SPX, SPXW, IWM, NDX, NDXP, DIA (+ active custom ticker badge if loaded) */}
      <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
        {ROW1_TICKERS.map((ticker) => {
          const isActive = activeTicker === ticker;
          return (
            <button
              key={ticker}
              type="button"
              onClick={() => handlePresetTickerClick(ticker)}
              className={cn(
                "px-3 py-1 rounded-full text-xs font-mono font-bold tracking-wide transition-all border",
                isActive
                  ? "bg-argon-primary text-white border-[#11cdef] shadow-[0_0_12px_rgba(94,114,228,0.65)]"
                  : "bg-[#0b0d17] text-slate-300 border-white/10 hover:text-white hover:border-[#5e72e4]/60"
              )}
            >
              {ticker}
            </button>
          );
        })}

        {!isPresetTicker && (
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-mono font-bold tracking-wide bg-gradient-to-r from-[#11cdef]/30 to-[#5e72e4]/40 text-white border border-[#11cdef] shadow-[0_0_12px_rgba(17,205,239,0.5)]">
            <Sparkles className="h-3 w-3 text-[#11cdef]" />
            <span>{activeTicker}</span>
            <span className="text-[9px] font-normal text-cyan-200/90">
              {dataSource === "CBOE_MARKET_DATA"
                ? "CBOE"
                : dataSource === "TRADIER_LIVE"
                  ? "LIVE"
                  : "SIM"}
            </span>
          </div>
        )}
      </div>

      {/* Row 2 Pills: SMH, TLT, GLD, SLV, XLE, TQQQ, SOXL, IBIT, NVDA, AAPL, TSLA, MSFT, AMZN, META */}
      <div className="flex flex-wrap items-center gap-1.5">
        {ROW2_TICKERS.map((ticker) => {
          const isActive = activeTicker === ticker;
          return (
            <button
              key={ticker}
              type="button"
              onClick={() => handlePresetTickerClick(ticker)}
              className={cn(
                "px-2.5 py-0.5 rounded-full text-[11px] font-mono font-semibold tracking-wide transition-all border",
                isActive
                  ? "bg-argon-primary text-white border-[#11cdef] shadow-[0_0_12px_rgba(94,114,228,0.65)]"
                  : "bg-[#0b0d17]/80 text-slate-400 border-white/10 hover:text-white hover:border-[#5e72e4]/50"
              )}
            >
              {ticker}
            </button>
          );
        })}
      </div>

      {/* Row 3 Pills: GOOGL, AVGO, NFLX, ORCL, AMD, MU, INTC, TSM, ARM, PLTR, COIN, MSTR, HOOD, SOFI */}
      <div className="flex flex-wrap items-center gap-1.5">
        {ROW3_TICKERS.map((ticker) => {
          const isActive = activeTicker === ticker;
          return (
            <button
              key={ticker}
              type="button"
              onClick={() => handlePresetTickerClick(ticker)}
              className={cn(
                "px-2.5 py-0.5 rounded-full text-[11px] font-mono font-semibold tracking-wide transition-all border",
                isActive
                  ? "bg-argon-primary text-white border-[#11cdef] shadow-[0_0_12px_rgba(94,114,228,0.65)]"
                  : "bg-[#0b0d17]/80 text-slate-400 border-white/10 hover:text-white hover:border-[#5e72e4]/50"
              )}
            >
              {ticker}
            </button>
          );
        })}
      </div>

      {/* Row 4 Pills: SMCI, CRWD, UBER, SHOP, RBLX, JPM, BAC, WMT, COST, XOM, BA, LLY, GME, RIVN */}
      <div className="flex flex-wrap items-center gap-1.5">
        {ROW4_TICKERS.map((ticker) => {
          const isActive = activeTicker === ticker;
          return (
            <button
              key={ticker}
              type="button"
              onClick={() => handlePresetTickerClick(ticker)}
              className={cn(
                "px-2.5 py-0.5 rounded-full text-[11px] font-mono font-semibold tracking-wide transition-all border",
                isActive
                  ? "bg-argon-primary text-white border-[#11cdef] shadow-[0_0_12px_rgba(94,114,228,0.65)]"
                  : "bg-[#0b0d17]/80 text-slate-400 border-white/10 hover:text-white hover:border-[#5e72e4]/50"
              )}
            >
              {ticker}
            </button>
          );
        })}
      </div>

      {/* Row 5 Pills: MARA, BABA, SPCX */}
      <div className="flex flex-wrap items-center gap-1.5">
        {ROW5_TICKERS.map((ticker) => {
          const isActive = activeTicker === ticker;
          return (
            <button
              key={ticker}
              type="button"
              onClick={() => handlePresetTickerClick(ticker)}
              className={cn(
                "px-2.5 py-0.5 rounded-full text-[11px] font-mono font-semibold tracking-wide transition-all border",
                isActive
                  ? "bg-argon-primary text-white border-[#11cdef] shadow-[0_0_12px_rgba(94,114,228,0.65)]"
                  : "bg-[#0b0d17]/80 text-slate-400 border-white/10 hover:text-white hover:border-[#5e72e4]/50"
              )}
            >
              {ticker}
            </button>
          );
        })}
      </div>
    </div>
  );
}
