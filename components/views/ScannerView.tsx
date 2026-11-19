"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useDashboardStore } from "@/store/useDashboardStore";
import { cn } from "@/lib/utils";
import { HyperionPlaybook } from "@/components/scanner/HyperionPlaybook";
import { Sparkles, Crown, ArrowRight, Search } from "lucide-react";

type KingFilterType = "ALL" | "POS_GAMMA" | "NEG_GAMMA" | "DOMINANT" | "CONTESTED" | "MOVED";
type KingSortType = "SCORE" | "STRENGTH" | "DISTANCE" | "XEM";

interface ScannerRow {
  t: string;
  px: number;
  king: number;
  pts: number;
  pct: number;
  xem: number;
  neg: boolean;
  str: number;
  share: number;
  base: number;
  score: number;
  rr: number;
  book?: string;
  contested?: boolean;
  moved?: boolean;
  dataStatus?: "LIVE" | "SYNCING";
  isLive?: boolean;
}

interface ScanSlot {
  slot: string;
  day: string;
  at: string;
  secs: number;
  credits: number;
  rows: ScannerRow[];
}

interface TradeRadarSetupRow {
  ticker: string;
  spotPrice: number;
  zeroGamma: number;
  callWall: number;
  putWall: number;
  callSetup?: {
    name: string;
    triggerLevel: number;
    contractLabel: string;
    totalOutlay: number;
  };
  putSetup?: {
    name: string;
    triggerLevel: number;
    contractLabel: string;
    totalOutlay: number;
  };
}

interface ScannerData {
  scans?: ScanSlot[];
  slots?: string[];
  running?: string | null;
}

const f2 = (v: number, d = 2) =>
  Number(v).toLocaleString("en-US", {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });

const sg = (v: number) =>
  (v >= 0 ? "+" : "") + f2(v, v !== 0 && Math.abs(v) < 10 ? 2 : 1);

const col = (s: number) =>
  s >= 80 ? "#facc15" : s >= 60 ? "#22d3ee" : "#94a3b8";

const hm = (k: string) => {
  if (k === "LIVE") return "LIVE";
  const [h, m] = k.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return k;
  return (h % 12 || 12) + ":" + String(m).padStart(2, "0") + (h < 12 ? " AM" : " PM");
};

const dayLab = (d: string) => {
  try {
    return new Date(d + "T12:00:00Z").toLocaleDateString("en-US", {
      timeZone: "UTC",
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  } catch {
    return d;
  }
};

const kind = (k: string) =>
  k === "LIVE" ? "live book" : k === "15:50" ? "closing scan" : "open scan";

const whenLabel = (r?: ScanSlot) => {
  if (!r) return "";
  let t = hm(r.slot) + (r.slot === "LIVE" ? " " : " ET ") + kind(r.slot) + " · " + dayLab(r.day);
  if (r.secs) {
    t += " · " + (r.secs < 90 ? Math.round(r.secs) + "s" : Math.round(r.secs / 60) + " min");
  }
  return t;
};

export function ScannerView() {
  const router = useRouter();
  const activeTicker = useDashboardStore((state) => state.activeTicker);
  const liveSpotPrice = useDashboardStore((state) => state.spotPrice);
  const liveKingNode = useDashboardStore((state) => state.kingNode);
  const liveNetGex = useDashboardStore((state) => state.netMetrics.netGex);
  const isLoadingChain = useDashboardStore((state) => state.isLoadingChain);
  const chainStrikesLen = useDashboardStore((state) => state.chainStrikes.length);
  const setTicker = useDashboardStore((state) => state.setTicker);
  const setActiveView = useDashboardStore((state) => state.setActiveView);

  const [scannerMode, setScannerMode] = useState<"PLAYBOOK" | "KING_NODES">("PLAYBOOK");
  const [data, setData] = useState<ScannerData | null>(null);
  const [radarSetups, setRadarSetups] = useState<TradeRadarSetupRow[]>([]);
  const [curSlot, setCurSlot] = useState<string>("15:50");
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [regimeFilter, setRegimeFilter] = useState<KingFilterType>("ALL");
  const [sortBy, setSortBy] = useState<KingSortType>("SCORE");
  const [searchQuery, setSearchQuery] = useState<string>("");

  useEffect(() => {
    if (scannerMode !== "KING_NODES") return;
    let active = true;
    const controller = new AbortController();
    const fetchScanner = async (isInitial = false) => {
      if (!isInitial && typeof document !== "undefined" && document.visibilityState !== "visible") {
        return;
      }
      try {
        const res = await fetch("/api/scanner", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!res.ok) return;
        const j: ScannerData = await res.json();
        if (active && !controller.signal.aborted) {
          setData(j);
          const slots = (j.scans || []).map((s) => s.slot);
          if (slots.length > 0) {
            setCurSlot((prev) => (slots.includes(prev) ? prev : slots[slots.length - 1]));
          }
          setIsLoading(false);
        }
      } catch {
        if (active && !controller.signal.aborted) setIsLoading(false);
      }
    };

    void fetchScanner(true);
    const interval = setInterval(() => {
      void fetchScanner(false);
    }, 15000);
    return () => {
      active = false;
      controller.abort();
      clearInterval(interval);
    };
  }, [scannerMode]);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const fetchRadar = async () => {
      try {
        const res = await fetch("/api/signals?radar=true", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!res.ok) return;
        const j = await res.json();
        if (active && !controller.signal.aborted && Array.isArray(j?.radar?.setups)) {
          setRadarSetups(j.radar.setups);
        }
      } catch {
        // Ignore transient radar fetch error
      }
    };
    void fetchRadar();
    return () => {
      active = false;
      controller.abort();
    };
  }, []);

  const activeScan = (data?.scans || []).find((s) => s.slot === curSlot) ?? data?.scans?.[0];
  const slots = (data?.scans || []).map((s) => s.slot);

  const rawRows = useMemo(() => {
    const base = activeScan?.rows ?? [];
    if (isLoadingChain || chainStrikesLen === 0) {
      return base;
    }
    return base.map((r) => {
      if (r.t.toUpperCase() === activeTicker.toUpperCase() && liveSpotPrice > 0) {
        const king = liveKingNode.allExpKing;
        const pts = Number((king - liveSpotPrice).toFixed(2));
        const pct = Number(((pts / liveSpotPrice) * 100).toFixed(2));
        return {
          ...r,
          px: liveSpotPrice,
          king,
          pts,
          pct,
          neg: liveNetGex < 0,
          str: liveKingNode.kingStrength,
          contested: liveKingNode.isContested,
          moved: r.moved || king !== r.king,
        };
      }
      return r;
    });
  }, [activeScan, activeTicker, liveSpotPrice, liveKingNode, liveNetGex, isLoadingChain, chainStrikesLen]);

  const filterCounts = useMemo(() => {
    return {
      ALL: rawRows.length,
      POS_GAMMA: rawRows.filter((r) => !r.neg).length,
      NEG_GAMMA: rawRows.filter((r) => r.neg).length,
      DOMINANT: rawRows.filter((r) => r.str >= 65 && !r.contested).length,
      CONTESTED: rawRows.filter((r) => Boolean(r.contested)).length,
      MOVED: rawRows.filter((r) => Boolean(r.moved)).length,
    };
  }, [rawRows]);

  const filteredAndSortedRows = useMemo(() => {
    const q = searchQuery.trim().toUpperCase();
    const filtered = rawRows.filter((r) => {
      if (q && !r.t.toUpperCase().includes(q)) return false;
      if (regimeFilter === "POS_GAMMA") return !r.neg;
      if (regimeFilter === "NEG_GAMMA") return r.neg;
      if (regimeFilter === "DOMINANT") return r.str >= 65 && !r.contested;
      if (regimeFilter === "CONTESTED") return Boolean(r.contested);
      if (regimeFilter === "MOVED") return Boolean(r.moved);
      return true;
    });

    return [...filtered].sort((a, b) => {
      const aLive = a.dataStatus !== "SYNCING";
      const bLive = b.dataStatus !== "SYNCING";
      if (aLive !== bLive) return aLive ? -1 : 1;
      if (sortBy === "STRENGTH") return b.str - a.str;
      if (sortBy === "DISTANCE") return Math.abs(a.pct) - Math.abs(b.pct);
      if (sortBy === "XEM") return (a.xem ?? 999) - (b.xem ?? 999);
      return b.score - a.score;
    });
  }, [rawRows, searchQuery, regimeFilter, sortBy]);

  const handleCardClick = (ticker: string) => {
    const sym = ticker.trim().toUpperCase();
    setTicker(sym);
    setActiveView("Gaia");
    router.push(`/gaia?ticker=${encodeURIComponent(sym)}`);
  };

  return (
    <div className="w-full space-y-5 font-sans">
      {/* Top Level Nav Bar & View Switcher */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-800">
        <div>
          <h1 className="text-xl sm:text-2xl font-black text-white tracking-tight flex items-center gap-2">
            <span>Hyperion Scanner</span>
          </h1>
          <p className="text-xs text-slate-400 mt-0.5">
            Intraday dealer positioning telemetry, King Node pulls & 0DTE execution playbooks
          </p>
        </div>

        {/* View Mode Segmented Controls */}
        <div className="inline-flex bg-[#101520] border border-[#1e2638] rounded-xl p-1 gap-1">
          <button
            type="button"
            onClick={() => setScannerMode("PLAYBOOK")}
            className={cn(
              "px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer",
              scannerMode === "PLAYBOOK"
                ? "bg-gradient-to-r from-emerald-500 to-teal-600 text-white shadow-md font-extrabold"
                : "text-slate-400 hover:text-white"
            )}
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>0DTE Playbook</span>
          </button>

          <button
            type="button"
            onClick={() => setScannerMode("KING_NODES")}
            className={cn(
              "px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer",
              scannerMode === "KING_NODES"
                ? "bg-gradient-to-r from-amber-500 to-yellow-500 text-slate-950 shadow-md font-extrabold"
                : "text-slate-400 hover:text-white"
            )}
          >
            <Crown className="w-3.5 h-3.5" />
            <span>King Node Scanner</span>
          </button>
        </div>
      </div>

      {/* Main View Display: 0DTE Playbook OR King Node Scanner */}
      {scannerMode === "PLAYBOOK" ? (
        <div className="space-y-6">
          <HyperionPlaybook onSelectTicker={handleCardClick} />

          {radarSetups.length > 0 && (
            <div className="p-4 rounded-xl bg-[#101520] border border-[#1e2638] space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold font-mono uppercase tracking-wider text-cyan-400">
                  Trade Radar · Live 0DTE Setups (Click to Launch Gaia)
                </span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                {radarSetups.map((s) => (
                  <button
                    key={s.ticker}
                    type="button"
                    onClick={() => handleCardClick(s.ticker)}
                    className="w-full text-left p-3 rounded-lg bg-[#0b0d17] border border-slate-800 hover:border-cyan-400/60 transition-colors cursor-pointer space-y-1 font-mono text-xs"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-extrabold text-white text-sm">
                        {s.ticker} · ${f2(s.spotPrice)}
                      </span>
                      <span className="text-[11px] text-cyan-300">Open in Gaia →</span>
                    </div>
                    <div className="text-[11px] text-slate-400">
                      ZG ${f2(s.zeroGamma)} · CW ${f2(s.callWall)} · PW ${f2(s.putWall)}
                    </div>
                    {s.callSetup && (
                      <div className="text-[11px] text-emerald-400 truncate">
                        CALL ≥ ${f2(s.callSetup.triggerLevel)} · {s.callSetup.contractLabel} (${s.callSetup.totalOutlay})
                      </div>
                    )}
                    {s.putSetup && (
                      <div className="text-[11px] text-rose-400 truncate">
                        PUT ≤ ${f2(s.putSetup.triggerLevel)} · {s.putSetup.contractLabel} (${s.putSetup.totalOutlay})
                      </div>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Quick banner link to the Full 50-Ticker King Node Scanner */}
          <div className="p-4 rounded-xl bg-[#101520] border border-[#1e2638] flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
            <div className="space-y-0.5">
              <span className="font-bold text-white flex items-center gap-1.5">
                <Crown className="w-4 h-4 text-[#facc15]" />
                Looking for the full Watchlist King Node Scanner?
              </span>
              <p className="text-slate-400">
                Inspect all 50 tickers ranked by pull score, distance vs 0DTE expected move, and gamma regime.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setScannerMode("KING_NODES")}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500/15 border border-amber-500/40 text-amber-300 font-mono font-bold hover:bg-amber-500/25 transition-colors cursor-pointer whitespace-nowrap self-start sm:self-auto"
            >
              <span>View King Node Board</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      ) : (
        /* King Node Scanner Table / Cards View */
        <div className="max-w-[760px] mx-auto space-y-3">
          {/* Header & Slot Selector */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div>
              <h2 className="text-lg font-extrabold text-white tracking-tight flex items-center gap-2">
                <Crown className="w-4 h-4 text-[#facc15]" />
                King Node Scanner
              </h2>
              <div className="text-xs text-slate-400 mt-0.5">
                {isLoading
                  ? "Loading scanner…"
                  : whenLabel(activeScan) || "Open scan at 9:35 AM ET. Closing scan is ready by 3:50 PM ET."}
              </div>
            </div>

            {/* Segmented Slot Toggle (.seg) */}
            {slots.length > 0 && (
              <div className="inline-flex bg-[#111827]/70 border border-slate-700/50 rounded-xl p-1 gap-1 self-start sm:self-auto">
                {slots.map((k) => {
                  const isActive = k === curSlot;
                  return (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setCurSlot(k)}
                      className={cn(
                        "px-3 py-1 rounded-lg text-xs font-bold transition-all cursor-pointer",
                        isActive
                          ? "bg-gradient-to-r from-cyan-400 to-purple-500 text-slate-950 shadow-md font-extrabold"
                          : "text-slate-400 hover:text-white"
                      )}
                    >
                      {k === "15:50" ? "3:50 close" : "9:35 open"}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Regime & Migration Filters + Search & Sort Bar */}
          <div className="bg-[#111827]/70 border border-slate-800 rounded-xl p-3 space-y-2.5">
            <div className="flex flex-wrap items-center gap-1.5">
              {(
                [
                  { id: "ALL", label: "All", count: filterCounts.ALL },
                  { id: "POS_GAMMA", label: "Positive γ", count: filterCounts.POS_GAMMA },
                  { id: "NEG_GAMMA", label: "Negative γ", count: filterCounts.NEG_GAMMA },
                  { id: "DOMINANT", label: "Dominant King", count: filterCounts.DOMINANT },
                  { id: "CONTESTED", label: "Contested", count: filterCounts.CONTESTED },
                  { id: "MOVED", label: "King Moved", count: filterCounts.MOVED },
                ] as const
              ).map((pill) => {
                const active = regimeFilter === pill.id;
                return (
                  <button
                    key={pill.id}
                    type="button"
                    onClick={() => setRegimeFilter(pill.id)}
                    className={cn(
                      "px-2.5 py-1 rounded-full text-[11px] font-mono font-semibold transition-all border cursor-pointer",
                      active
                        ? "bg-amber-500/20 border-amber-400 text-amber-300 shadow-[0_0_10px_rgba(245,158,11,0.2)]"
                        : "bg-[#0b0d17] border-slate-800 text-slate-400 hover:text-white hover:border-slate-700"
                    )}
                  >
                    {pill.label}{" "}
                    <span className="opacity-70 text-[10px]">({pill.count})</span>
                  </button>
                );
              })}
            </div>

            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pt-1 border-t border-slate-800/60">
              <div className="relative flex-1 max-w-xs">
                <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
                <input
                  id="scanner-ticker-search"
                  name="scannerTickerSearch"
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Filter ticker (e.g. NVDA, SPY)..."
                  aria-label="Filter scanner tickers"
                  className="w-full rounded-lg bg-[#0b0d17] border border-slate-800 pl-8 pr-3 py-1.5 text-xs font-mono text-white placeholder:text-slate-500 focus:outline-none focus:border-cyan-400"
                />
              </div>

              <div className="flex items-center gap-2 text-xs font-mono">
                <label htmlFor="scanner-sort-by" className="text-slate-400 text-[11px]">
                  Sort by:
                </label>
                <select
                  id="scanner-sort-by"
                  name="scannerSortBy"
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as KingSortType)}
                  className="bg-[#0b0d17] text-slate-200 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs font-mono focus:outline-none focus:border-cyan-400 cursor-pointer"
                >
                  <option value="SCORE">Pull Score (High → Low)</option>
                  <option value="STRENGTH">King Strength (High → Low)</option>
                  <option value="DISTANCE">Distance % (Closest First)</option>
                  <option value="XEM">vs Daily EM (Lowest Multiple)</option>
                </select>
              </div>
            </div>
          </div>

          {/* Hint */}
          <div className="flex items-center justify-between text-[11px] text-slate-500 font-mono">
            <span>Tap a ticker to launch Gaia Flow &amp; GEX chart</span>
            <span>
              Showing {filteredAndSortedRows.length} of {rawRows.length} tickers
            </span>
          </div>

          {/* Cards List */}
          <div className="space-y-2">
            {!activeScan || !filteredAndSortedRows.length ? (
              <div className="bg-[#111827]/60 border border-slate-800 rounded-xl p-8 text-center text-xs text-slate-400">
                {rawRows.length > 0
                  ? "No tickers match the active filter criteria."
                  : "No scan yet. The open scan runs at 9:35 AM ET. The closing scan is ready by 3:50 PM ET."}
              </div>
            ) : (
              filteredAndSortedRows.map((x, i) => {
                const c = col(x.score);
                const k = x.king;
                const flag = x.contested ? " · contested" : "";

                return (
                  <button
                    key={x.t}
                    type="button"
                    onClick={() => handleCardClick(x.t)}
                    className="w-full text-left block bg-[#111827]/65 hover:border-cyan-400/50 border border-slate-800/80 rounded-2xl p-3 transition-colors cursor-pointer group"
                  >
                    {/* Top Row: Rank, Ticker, Price, Score */}
                    <div className="flex items-center gap-2">
                      <span className="text-slate-500 font-bold text-xs w-6">
                        #{i + 1}
                      </span>
                      <b className="text-base font-extrabold text-white group-hover:text-cyan-400 transition-colors">
                        {x.t}
                      </b>
                      <span className="text-slate-400 text-xs font-mono tabular-nums">
                        ${f2(x.px)}
                      </span>
                      {x.dataStatus === "SYNCING" && (
                        <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/40">
                          SYNCING
                        </span>
                      )}
                      <div className="flex-1" />
                      <span
                        style={{
                          color: x.dataStatus === "SYNCING" ? "#f59e0b" : c,
                          borderColor: x.dataStatus === "SYNCING" ? "#f59e0b55" : `${c}55`,
                          backgroundColor: x.dataStatus === "SYNCING" ? "#f59e0b1a" : `${c}1a`,
                        }}
                        className="border rounded-full px-2.5 py-0.5 text-xs font-extrabold font-mono tabular-nums"
                      >
                        {x.dataStatus === "SYNCING" ? "…" : x.score}
                      </span>
                    </div>

                    {/* 3-Column Metrics Grid */}
                    <div className="grid grid-cols-[0.7fr_1.3fr_1fr] gap-1.5 my-2 text-xs font-mono">
                      {/* Col 1: King */}
                      <div>
                        <small className="block text-[10px] text-slate-500 uppercase tracking-wider font-semibold">
                          King
                        </small>
                        <span className="text-[#facc15] font-extrabold text-[13px] tabular-nums drop-shadow-[0_0_8px_rgba(250,204,21,0.5)]">
                          {k % 1 !== 0 ? f2(k, 1) : k}
                          {flag}
                        </span>
                        {x.book && (
                          <small className="block text-[9.5px] text-slate-500 lowercase mt-0.5">
                            {x.book}
                          </small>
                        )}
                        {x.moved && (
                          <small className="block text-[9.5px] text-slate-400 font-semibold">
                            King moved
                          </small>
                        )}
                      </div>

                      {/* Col 2: Distance */}
                      <div>
                        <small className="block text-[10px] text-slate-500 uppercase tracking-wider font-semibold">
                          Distance
                        </small>
                        <span className="text-slate-200 tabular-nums">
                          {sg(x.pct).replace(/(\.\d)\d$/, "$1")}% · {sg(x.pts)} pts
                        </span>
                      </div>

                      {/* Col 3: vs EM */}
                      <div>
                        <small className="block text-[10px] text-slate-500 uppercase tracking-wider font-semibold">
                          vs EM
                        </small>
                        <span className="text-slate-200 tabular-nums">
                          {x.xem != null ? `${f2(x.xem, 1)}× daily EM` : "–"}
                        </span>
                      </div>
                    </div>

                    {/* Bottom Row: Regime, Strength Label, Progress Bar */}
                    <div className="flex items-center gap-2 pt-1 border-t border-slate-800/40 font-mono">
                      <span
                        className={cn(
                          "text-[10px] font-bold px-2 py-0.5 rounded-full whitespace-nowrap",
                          x.neg
                            ? "text-[#c084fc] bg-purple-500/15"
                            : "text-[#22d3ee] bg-cyan-500/12"
                        )}
                      >
                        {x.neg ? "Negative" : "Positive"} γ
                      </span>
                      <span className="text-slate-500 text-[10px] whitespace-nowrap">
                        King strength
                      </span>
                      <div className="flex-1 h-1.5 rounded-full bg-slate-800 overflow-hidden">
                        <div
                          style={{ width: `${Math.max(3, x.str)}%` }}
                          className="h-full rounded-full bg-gradient-to-r from-[#fdca26] to-[#facc15]"
                        />
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>

          {/* Footer Glossary (.leg) */}
          <div className="text-xs text-slate-400 bg-[#111827]/50 border border-slate-800 rounded-xl p-3 leading-relaxed space-y-1.5 font-sans">
            <div>
              <b className="text-white">King</b> – the all-expirations King, the strike with the largest total gamma. It tends to pull price toward it.{" "}
              <b className="text-white">contested</b> means the next strike is within about 10%.
            </div>
            <div>
              <b className="text-white">Book</b> – when that row&apos;s book was taken.
            </div>
            <div>
              <b className="text-white">King moved</b> – a newer book changed the all-expirations King, so the row was rescored or flagged.
            </div>
            <div>
              <b className="text-white">Distance</b> – how far the King is from the price now.
            </div>
            <div>
              <b className="text-white">vs EM</b> – that distance compared with today&apos;s expected move.
            </div>
            <div>
              <b className="text-white">Gamma regime</b> – Negative γ means bigger moves; Positive γ means calmer, pinned trading.
            </div>
            <div>
              <b className="text-white">King strength</b> – how much the King stands out from the next-biggest strike.
            </div>
            <div>
              <b className="text-white">Pull score</b> – a 0–100 ranking of how strong the pull to the King looks. It&apos;s a ranking, not a prediction.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
