"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PlaybookPayload, PlaybookPick } from "@/lib/types/playbook";
import { DEFAULT_PLAYBOOK_PAYLOAD } from "@/lib/playbookData";
import { PlaybookCard } from "./PlaybookCard";
import { useDashboardStore } from "@/store/useDashboardStore";
import { cn } from "@/lib/utils";
import { 
  Sparkles, 
  TrendingUp, 
  TrendingDown, 
  HelpCircle, 
  RefreshCw, 
  ChevronDown, 
  ChevronUp 
} from "lucide-react";

interface HyperionPlaybookProps {
  initialPayload?: PlaybookPayload;
  onSelectTicker?: (ticker: string) => void;
}

export function HyperionPlaybook({
  initialPayload,
  onSelectTicker,
}: HyperionPlaybookProps) {
  const router = useRouter();
  const storePayload = useDashboardStore((state) => state.playbookPayload);
  const fetchStorePlaybook = useDashboardStore((state) => state.fetchPlaybook);
  const activeTicker = useDashboardStore((state) => state.activeTicker);
  const spotPrice = useDashboardStore((state) => state.spotPrice);
  const setDashboardTicker = useDashboardStore((state) => state.setTicker);
  const setActiveView = useDashboardStore((state) => state.setActiveView);

  const [localPayload, setLocalPayload] = useState<PlaybookPayload>(
    initialPayload || DEFAULT_PLAYBOOK_PAYLOAD
  );
  const [filter, setFilter] = useState<"ALL" | "CALL" | "PUT">("ALL");
  const [showRules, setShowRules] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const payload = storePayload || localPayload;

  const handleTickerSelect = (ticker: string) => {
    const sym = ticker.trim().toUpperCase();
    if (onSelectTicker) {
      onSelectTicker(sym);
    } else {
      setDashboardTicker(sym);
      setActiveView("Gaia");
      router.push(`/gaia?ticker=${encodeURIComponent(sym)}`);
    }
  };

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await fetchStorePlaybook();
      const res = await fetch("/api/scanner/playbook", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setLocalPayload(data);
      }
    } catch {
      // Fallback retained
    } finally {
      setTimeout(() => setIsRefreshing(false), 500);
    }
  };

  useEffect(() => {
    fetchStorePlaybook();
    const interval = setInterval(() => {
      fetchStorePlaybook();
    }, 45000);
    return () => clearInterval(interval);
  }, [fetchStorePlaybook]);

  const calls = payload.topCalls && payload.topCalls.length > 0
    ? payload.topCalls
    : payload.picks.filter((p) => p.type === "CALL");

  const puts = payload.topPuts && payload.topPuts.length > 0
    ? payload.topPuts
    : payload.picks.filter((p) => p.type === "PUT");

  return (
    <section className="w-full space-y-4 font-sans">
      {/* 1. Header Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-[#1e2638]">
        <div>
          <div className="flex items-center gap-2">
            <span className="flex h-2 w-2 relative">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
            </span>
            <h2 className="text-lg sm:text-xl font-extrabold text-white tracking-tight uppercase flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-cyan-400" />
              {payload.sessionTitle}
            </h2>
          </div>
          <p className="text-xs text-slate-400 mt-0.5">
            {payload.subtitle}
          </p>
        </div>

        {/* Action controls & filter tabs */}
        <div className="flex items-center gap-2">
          {/* Segmented Filter Pills */}
          <div className="inline-flex bg-[#101520] border border-[#1e2638] rounded-lg p-0.5 text-xs font-mono">
            <button
              type="button"
              onClick={() => setFilter("ALL")}
              className={cn(
                "px-2.5 py-1 rounded-md transition-all cursor-pointer",
                filter === "ALL"
                  ? "bg-slate-700/80 text-white font-bold shadow-sm"
                  : "text-slate-400 hover:text-slate-200"
              )}
            >
              All ({calls.length + puts.length})
            </button>
            <button
              type="button"
              onClick={() => setFilter("CALL")}
              className={cn(
                "px-2.5 py-1 rounded-md transition-all flex items-center gap-1 cursor-pointer",
                filter === "CALL"
                  ? "bg-emerald-500/20 text-emerald-400 font-bold border border-emerald-500/30"
                  : "text-slate-400 hover:text-emerald-400"
              )}
            >
              <TrendingUp className="w-3 h-3" />
              <span>Calls ({calls.length})</span>
            </button>
            <button
              type="button"
              onClick={() => setFilter("PUT")}
              className={cn(
                "px-2.5 py-1 rounded-md transition-all flex items-center gap-1 cursor-pointer",
                filter === "PUT"
                  ? "bg-rose-500/20 text-rose-400 font-bold border border-rose-500/30"
                  : "text-slate-400 hover:text-rose-400"
              )}
            >
              <TrendingDown className="w-3 h-3" />
              <span>Puts ({puts.length})</span>
            </button>
          </div>

          {/* Refresh Button */}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            className="p-1.5 rounded-lg border border-[#1e2638] bg-[#101520] text-slate-400 hover:text-white hover:border-slate-700 transition-colors disabled:opacity-50 cursor-pointer"
            title="Refresh 0DTE Playbook"
          >
            <RefreshCw
              className={cn("w-3.5 h-3.5", isRefreshing && "animate-spin text-cyan-400")}
            />
          </button>
        </div>
      </div>

      {/* 2. Tactical Execution Rules Callout */}
      {payload.rules && (
        <div className="bg-[#101520] border border-[#1e2638] rounded-xl overflow-hidden transition-all">
          <button
            type="button"
            onClick={() => setShowRules(!showRules)}
            className="w-full flex items-center justify-between px-3.5 py-2 text-left bg-[#141b2a]/60 hover:bg-[#141b2a] transition-colors cursor-pointer"
          >
            <div className="flex items-center gap-2 text-xs font-semibold text-cyan-300">
              <HelpCircle className="w-3.5 h-3.5 text-cyan-400" />
              <span>0DTE Execution Playbook Rules</span>
            </div>
            {showRules ? (
              <ChevronUp className="w-3.5 h-3.5 text-slate-400" />
            ) : (
              <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
            )}
          </button>

          {showRules && (
            <div className="p-3 text-xs text-slate-300/90 leading-relaxed font-sans border-t border-[#1e2638]">
              {payload.rules}
            </div>
          )}
        </div>
      )}

      {/* 3. Cards Section */}
      {filter === "ALL" ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Left Column: Top 3 Calls */}
          <div className="space-y-3">
            <div className="flex items-center justify-between px-1">
              <span className="text-xs font-bold font-mono tracking-wider text-emerald-400 flex items-center gap-1.5 uppercase">
                <TrendingUp className="w-3.5 h-3.5" />
                Top 3 Calls (Bullish Breakout)
              </span>
              <span className="text-[11px] font-mono text-slate-500">
                Trigger on break above
              </span>
            </div>

            <div className="space-y-3">
              {calls.map((pick, i) => {
                const live =
                  pick.ticker.toUpperCase() === activeTicker.toUpperCase()
                    ? spotPrice
                    : pick.currentSpot;
                return (
                  <PlaybookCard
                    key={pick.id}
                    pick={pick}
                    rank={i + 1}
                    liveSpot={live}
                    onSelectTicker={handleTickerSelect}
                  />
                );
              })}
            </div>
          </div>

          {/* Right Column: Top 3 Puts */}
          <div className="space-y-3">
            <div className="flex items-center justify-between px-1">
              <span className="text-xs font-bold font-mono tracking-wider text-rose-400 flex items-center gap-1.5 uppercase">
                <TrendingDown className="w-3.5 h-3.5" />
                Top 3 Puts (Bearish Breakdown)
              </span>
              <span className="text-[11px] font-mono text-slate-500">
                Trigger on break below
              </span>
            </div>

            <div className="space-y-3">
              {puts.map((pick, i) => {
                const live =
                  pick.ticker.toUpperCase() === activeTicker.toUpperCase()
                    ? spotPrice
                    : pick.currentSpot;
                return (
                  <PlaybookCard
                    key={pick.id}
                    pick={pick}
                    rank={i + 1}
                    liveSpot={live}
                    onSelectTicker={handleTickerSelect}
                  />
                );
              })}
            </div>
          </div>
        </div>
      ) : (
        /* Filtered View: Calls or Puts */
        <div className="space-y-3">
          <div className="flex items-center justify-between px-1">
            <span
              className={cn(
                "text-xs font-bold font-mono tracking-wider flex items-center gap-1.5 uppercase",
                filter === "CALL" ? "text-emerald-400" : "text-rose-400"
              )}
            >
              {filter === "CALL" ? (
                <>
                  <TrendingUp className="w-3.5 h-3.5" />
                  Top 3 Calls (Bullish Breakout)
                </>
              ) : (
                <>
                  <TrendingDown className="w-3.5 h-3.5" />
                  Top 3 Puts (Bearish Breakdown)
                </>
              )}
            </span>
            <span className="text-[11px] font-mono text-slate-500">
              {filter === "CALL"
                ? "Trigger on break above"
                : "Trigger on break below"}
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {(filter === "CALL" ? calls : puts).map((pick, i) => {
              const live =
                pick.ticker.toUpperCase() === activeTicker.toUpperCase()
                  ? spotPrice
                  : pick.currentSpot;
              return (
                <PlaybookCard
                  key={pick.id}
                  pick={pick}
                  rank={i + 1}
                  liveSpot={live}
                  onSelectTicker={handleTickerSelect}
                />
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
