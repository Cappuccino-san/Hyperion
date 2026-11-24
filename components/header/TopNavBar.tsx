"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { Lock, OctagonX, Unlock, Volume2, VolumeX } from "lucide-react";
import { ActiveView, useDashboardStore } from "@/store/useDashboardStore";
import { GuideModal } from "@/components/modals/GuideModal";
import { SetupModal } from "@/components/modals/SetupModal";
import { CommandPalette } from "@/components/CommandPalette";
import { ExpectedMovesBadges } from "@/components/header/ExpectedMovesBadges";
import { isNyseHoliday, getNyseEarlyCloseMins } from "@/lib/gaiaSessionGuards";
import { cn } from "@/lib/utils";

const VIEW_TABS: ActiveView[] = ["Heatmap", "Quad", "Gaia", "Scanner", "Recap"];

const TAB_ROUTES: Record<ActiveView, string> = {
  Heatmap: "/",
  Quad: "/quad",
  Gaia: "/gaia",
  Scanner: "/scanner",
  Recap: "/recap",
};

interface MarketStatusInfo {
  state: "open" | "pre" | "after" | "closed";
  label: string;
  countdown: string;
}

function getEtParts(d: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const map: Record<string, string> = {};
  parts.forEach((p) => {
    map[p.type] = p.value;
  });
  const wdMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return {
    ymd: `${map.year}-${map.month}-${map.day}`,
    wd: wdMap[map.weekday] ?? 0,
    h: parseInt(map.hour, 10) % 24,
    m: parseInt(map.minute, 10),
    s: parseInt(map.second, 10),
  };
}

function isTradingDay(d: Date): boolean {
  const p = getEtParts(d);
  return p.wd >= 1 && p.wd <= 5 && !isNyseHoliday(p.ymd);
}

function formatDuration(totalSec: number): string {
  const sec = Math.max(0, Math.floor(totalSec));
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}

function computeMarketStatus(): MarketStatusInfo {
  const now = new Date();
  const p = getEtParts(now);
  const secOfDay = p.h * 3600 + p.m * 60 + p.s;
  const openSec = 9 * 3600 + 30 * 60; // 9:30 AM ET
  const earlyCloseMins = getNyseEarlyCloseMins(p.ymd);
  const closeSec = (earlyCloseMins ?? 16 * 60) * 60;
  const preSec = 4 * 3600; // 4:00 AM ET
  const afterEndSec = 20 * 3600; // 8:00 PM ET
  const todayTrades = isTradingDay(now);

  if (todayTrades && secOfDay >= openSec && secOfDay < closeSec) {
    return {
      state: "open",
      label: "Market Open",
      countdown: `closes in ${formatDuration(closeSec - secOfDay)}`,
    };
  }

  let secsToNextOpen = 0;
  if (todayTrades && secOfDay < openSec) {
    secsToNextOpen = openSec - secOfDay;
  } else {
    secsToNextOpen = 86400 - secOfDay + openSec;
    let probe = new Date(now.getTime() + (86400 - secOfDay + 3600) * 1000);
    while (!isTradingDay(probe)) {
      secsToNextOpen += 86400;
      probe = new Date(probe.getTime() + 86400 * 1000);
    }
  }

  if (todayTrades && secOfDay >= preSec && secOfDay < openSec) {
    return {
      state: "pre",
      label: "Pre-market",
      countdown: `opens in ${formatDuration(secsToNextOpen)}`,
    };
  }

  if (todayTrades && secOfDay >= closeSec && secOfDay < afterEndSec) {
    return {
      state: "after",
      label: "After hours",
      countdown: `opens in ${formatDuration(secsToNextOpen)}`,
    };
  }

  return {
    state: "closed",
    label: "Closed",
    countdown: `opens in ${formatDuration(secsToNextOpen)}`,
  };
}

function HeaderTickBadge() {
  const activeTicker = useDashboardStore((state) => state.activeTicker);
  const spotPrice = useDashboardStore((state) => state.spotPrice);
  const liveTickPrice = useDashboardStore((state) => state.liveTickPrice);
  const liveTickDirection = useDashboardStore((state) => state.liveTickDirection);
  const liveTickCount = useDashboardStore((state) => state.liveTickCount);
  const liveTickMarketOpen = useDashboardStore((state) => state.liveTickMarketOpen);
  const connectionStatus = useDashboardStore((state) => state.connectionStatus);
  const isStaleSnapshot = useDashboardStore((state) => state.isStaleSnapshot);
  const cboeSpotLagDollars = useDashboardStore((state) => state.cboeSpotLagDollars);
  const setLiveTick = useDashboardStore((state) => state.setLiveTick);
  const [tickFlash, setTickFlash] = useState(false);

  // Global 800ms High-Frequency Tick Streamer (isolated leaf prevents header/modal re-renders)
  useEffect(() => {
    let isCancelled = false;
    let timerId: ReturnType<typeof setTimeout> | null = null;
    let activeController: AbortController | null = null;

    let nextDelayMs = 800;

    const pollTick = async () => {
      if (isCancelled) return;
      try {
        if (typeof document === "undefined" || document.visibilityState === "visible") {
          activeController?.abort();
          activeController = new AbortController();
          const signal = activeController.signal;
          const res = await fetch(`/api/tick?ticker=${encodeURIComponent(activeTicker)}`, {
            cache: "no-store",
            signal,
          });
          if (res.ok && !isCancelled && !signal.aborted) {
            const data = await res.json();
            const isOpen = typeof data.marketOpen === "boolean" ? data.marketOpen : undefined;
            nextDelayMs = isOpen === false ? 15_000 : 800;
            if (!isCancelled && !signal.aborted && typeof data.spot === "number" && data.spot > 0) {
              setLiveTick(
                activeTicker,
                data.spot,
                data.timestamp || Date.now(),
                isOpen
              );
            }
          }
        }
      } catch {
        // Silent retry on next cycle
      } finally {
        if (!isCancelled) {
          timerId = setTimeout(pollTick, nextDelayMs);
        }
      }
    };

    pollTick();
    return () => {
      isCancelled = true;
      activeController?.abort();
      if (timerId) clearTimeout(timerId);
    };
  }, [activeTicker, setLiveTick]);

  useEffect(() => {
    if (liveTickCount === 0) return;
    setTickFlash(true);
    const t = setTimeout(() => setTickFlash(false), 250);
    return () => clearTimeout(t);
  }, [liveTickPrice, liveTickCount]);

  const isStale = isStaleSnapshot || connectionStatus === "SYNCING" || connectionStatus === "RECONNECTING";
  const isRthLive = liveTickMarketOpen === true && !isStale;
  const hasLagWarn = cboeSpotLagDollars !== null && Math.abs(cboeSpotLagDollars) >= 0.35;
  const displayPrice =
    liveTickMarketOpen === false && spotPrice > 0
      ? spotPrice
      : liveTickPrice ?? spotPrice;

  return (
    <div
      className={cn(
        "flex items-center gap-2 px-2.5 py-1 rounded-md border text-[11px] font-mono tabular-nums transition-colors duration-200",
        isStale
          ? "bg-amber-500/15 border-amber-500/45 text-amber-200"
          : tickFlash
            ? liveTickDirection === "up"
              ? "bg-emerald-500/20 border-emerald-500/50 text-emerald-300"
              : liveTickDirection === "down"
                ? "bg-rose-500/20 border-rose-500/50 text-rose-300"
                : "bg-cyan-500/15 border-cyan-500/40 text-cyan-200"
            : "bg-[#111520] border-white/10 text-slate-200"
      )}
      title={
        isStale
          ? "Feed syncing / stale snapshot — verify before acting"
          : hasLagWarn
            ? `Live tick vs delayed CBOE chain lag: ${cboeSpotLagDollars! >= 0 ? "+" : ""}$${cboeSpotLagDollars!.toFixed(2)}`
            : "Sub-second market tick stream (800ms cadence)"
      }
    >
      <span className="relative flex h-2 w-2 shrink-0">
        {isRthLive && (
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
        )}
        <span
          className={cn(
            "relative inline-flex rounded-full h-2 w-2",
            isStale ? "bg-amber-400" : isRthLive ? "bg-emerald-500" : "bg-slate-400"
          )}
        />
      </span>
      <span className="font-bold text-white">{activeTicker}</span>
      <span
        className={cn(
          "font-extrabold tabular-nums",
          liveTickDirection === "up"
            ? "text-emerald-400"
            : liveTickDirection === "down"
              ? "text-rose-400"
              : "text-cyan-300"
        )}
      >
        {displayPrice > 0 ? `$${displayPrice.toFixed(2)}` : "—"}
      </span>
      <span
        className={cn(
          "text-[9.5px] font-bold uppercase px-1 py-0.5 rounded",
          isStale
            ? "bg-amber-500/20 text-amber-300"
            : isRthLive
              ? "bg-emerald-500/15 text-emerald-300"
              : "bg-slate-800 text-slate-400"
        )}
      >
        {isStale ? "STALE" : isRthLive ? "LIVE" : "CLOSED"}
      </span>
      {hasLagWarn && (
        <span className="hidden xl:inline text-[9.5px] font-bold text-amber-300 bg-amber-500/15 border border-amber-500/35 px-1 py-0.5 rounded">
          CBOE {cboeSpotLagDollars! >= 0 ? "+" : ""}${cboeSpotLagDollars!.toFixed(2)}
        </span>
      )}
    </div>
  );
}

function MarketStatusPill() {
  const [mounted, setMounted] = useState(false);
  const [mktStatus, setMktStatus] = useState<MarketStatusInfo>(() => computeMarketStatus());

  useEffect(() => {
    setMounted(true);
    setMktStatus(computeMarketStatus());
    const id = setInterval(() => {
      setMktStatus(computeMarketStatus());
    }, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div
      id="mkt"
      className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#111520] border border-[#1e2638] text-xs font-mono tabular-nums text-slate-400"
    >
      <span
        suppressHydrationWarning
        className={cn(
          "w-2 h-2 rounded-full shrink-0",
          mktStatus.state === "open"
            ? "bg-[#22c55e] shadow-[0_0_8px_#22c55e]"
            : mktStatus.state === "pre" || mktStatus.state === "after"
              ? "bg-[#eab308] shadow-[0_0_6px_#eab308]"
              : "bg-[#64748b]"
        )}
      />
      <b suppressHydrationWarning className="text-slate-200 font-semibold">
        {mktStatus.label}
      </b>
      <span suppressHydrationWarning className="tabular-nums">
        {mounted ? `· ${mktStatus.countdown}` : ""}
      </span>
    </div>
  );
}

export function TopNavBar() {
  const router = useRouter();
  const pathname = usePathname();
  const activeView = useDashboardStore((state) => state.activeView);
  const activeTicker = useDashboardStore((state) => state.activeTicker);
  const netGex = useDashboardStore((state) => state.netMetrics.netGex);
  const zeroGamma = useDashboardStore((state) => state.gammaLevels.zeroGamma);
  const serverActivePositions = useDashboardStore((state) => state.serverActivePositions);
  const executionArmState = useDashboardStore((state) => state.executionArmState);
  const audioAlertsMuted = useDashboardStore((state) => state.audioAlertsMuted);
  const toggleExecutionLock = useDashboardStore((state) => state.toggleExecutionLock);
  const setAudioAlertsMuted = useDashboardStore((state) => state.setAudioAlertsMuted);
  const setActiveView = useDashboardStore((state) => state.setActiveView);
  const setFilters = useDashboardStore((state) => state.setFilters);
  const fetchOptionsChain = useDashboardStore((state) => state.fetchOptionsChain);
  const isSetupModalOpen = useDashboardStore((state) => state.isSetupModalOpen);
  const setSetupModalOpen = useDashboardStore((state) => state.setSetupModalOpen);
  const [guideOpen, setGuideOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const openPositionsList = Object.values(serverActivePositions || {}).filter(Boolean) as any[];
  const activePos = openPositionsList[0] ?? null;
  const isPositiveGamma = netGex >= 0;
  const isLocked = executionArmState === "LOCKED";

  const handleTabClick = (tab: ActiveView) => {
    setActiveView(tab);
    if (tab === "Heatmap") {
      router.push("/");
    } else if (tab === "Quad") {
      router.push("/quad");
    } else if (tab === "Gaia") {
      router.push("/gaia");
    } else if (tab === "Scanner") {
      router.push("/scanner");
    } else if (tab === "Recap") {
      router.push("/recap");
    }
  };

  const isTabActive = (tab: ActiveView) => {
    if (pathname === "/") {
      return activeView === tab;
    }
    if (pathname === "/quad") return tab === "Quad";
    if (pathname === "/gaia") {
      return tab === "Gaia";
    }
    if (pathname === "/scanner") return tab === "Scanner";
    if (pathname === "/recap") return tab === "Recap";
    return activeView === tab;
  };

  // Global Quantitative Terminal Keyboard Shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toUpperCase() ?? "";
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) {
        if (e.key === "Escape") {
          target?.blur();
        }
        return;
      }

      if (e.key === "/") {
        e.preventDefault();
        const searchEl = (
          document.getElementById("ticker-search-input") ??
          document.getElementById("gaia-ticker-search-input")
        ) as HTMLInputElement | null;
        if (searchEl) searchEl.focus();
      } else if (e.key === "1") {
        handleTabClick("Heatmap");
      } else if (e.key === "2") {
        handleTabClick("Quad");
      } else if (e.key === "3") {
        handleTabClick("Gaia");
      } else if (e.key === "4") {
        handleTabClick("Scanner");
      } else if (e.key === "5") {
        handleTabClick("Recap");
      } else if (e.key.toLowerCase() === "r") {
        void fetchOptionsChain(activeTicker, true);
      } else if (e.key.toLowerCase() === "g") {
        setFilters({ metric: "GEX" });
      } else if (e.key.toLowerCase() === "v") {
        setFilters({ metric: "VEX" });
      } else if (e.key.toLowerCase() === "d") {
        setFilters({ metric: "DEX" });
      } else if (e.key.toLowerCase() === "c") {
        setFilters({ metric: "Charm" });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTicker, fetchOptionsChain, setFilters]);

  return (
    <>
      <header className="sticky top-0 z-40 w-full bg-[#0b0d17]/95 backdrop-blur-md border-b border-white/[0.06]">
        <div className="max-w-7xl mx-auto px-4 pt-3 pb-2 space-y-2.5">
          {/* Brand & Top Action Links Row */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            {/* Left: Hyperion solar/orbital icon + Brand */}
            <Link
              href="/"
              onClick={() => setActiveView("Heatmap")}
              className="flex items-center gap-2.5 text-left group cursor-pointer"
            >
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-[#38bdf8]/20 via-[#1c223a] to-[#5e72e4]/30 border border-[#38bdf8]/45 shadow-[0_0_14px_rgba(56,189,248,0.28)]">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  className="h-4 w-4 text-[#38bdf8]"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="12" r="4" className="fill-[#38bdf8]/25 stroke-[#38bdf8]" />
                  <ellipse cx="12" cy="12" rx="10" ry="4.2" transform="rotate(-28 12 12)" className="stroke-[#818cf8]" />
                  <circle cx="18.5" cy="8.5" r="1.3" className="fill-[#fde047] stroke-none" />
                </svg>
              </div>
              <div className="leading-tight">
                <div className="text-base font-bold tracking-tight text-white group-hover:text-[#38bdf8] transition-colors">
                  Hyperion
                </div>
                <div className="text-xs text-slate-400 font-medium">
                  Quant Options &amp; Gamma Intelligence
                </div>
              </div>
            </Link>

            {/* Right: Cockpit Safety, Telemetry & Tool Controls */}
            <div className="flex flex-wrap items-center justify-end gap-2">
              {/* 1. Master Execution Mode Pill (Strictly Paper/Shadow or Locked — zero live broker routing) */}
              <button
                type="button"
                onClick={() => void toggleExecutionLock(false)}
                title={
                  isLocked
                    ? "Execution LOCKED (Stand Aside). Click to resume Paper/Shadow simulation."
                    : "Paper / Shadow Simulation Mode (no real-money broker routing). Click to engage Emergency Lock."
                }
                className={cn(
                  "px-2.5 py-1 rounded-md text-[11px] font-mono font-bold border transition inline-flex items-center gap-1.5 cursor-pointer uppercase tracking-wider",
                  isLocked
                    ? "bg-rose-500/20 border-rose-500/60 text-rose-200 shadow-[0_0_10px_rgba(244,63,94,0.28)]"
                    : "bg-amber-500/12 border-amber-500/45 text-amber-300 hover:bg-amber-500/20"
                )}
              >
                {isLocked ? (
                  <Lock className="w-3 h-3 shrink-0 text-rose-400" />
                ) : (
                  <Unlock className="w-3 h-3 shrink-0 text-amber-400" />
                )}
                <span>{isLocked ? "LOCKED · STAND ASIDE" : "PAPER / SHADOW"}</span>
              </button>

              {/* 2. Emergency Flatten (Paper) when an open position exists */}
              {activePos && (
                <button
                  type="button"
                  onClick={() => void toggleExecutionLock(true)}
                  title="Emergency Lock & Flatten active paper position immediately"
                  className="px-2.5 py-1 rounded-md text-[11px] font-mono font-extrabold border border-rose-500/70 bg-rose-600/25 text-rose-100 hover:bg-rose-600/40 transition inline-flex items-center gap-1 cursor-pointer uppercase tracking-wider"
                >
                  <OctagonX className="w-3.5 h-3.5 shrink-0 text-rose-300" />
                  <span>Halt &amp; Flatten</span>
                </button>
              )}

              {/* 3. Real-Time Tick Stream Telemetry Badge (isolated leaf) */}
              <HeaderTickBadge />

              {/* 4. Header Audio Mute Control */}
              <button
                type="button"
                onClick={() => setAudioAlertsMuted(!audioAlertsMuted)}
                aria-label={audioAlertsMuted ? "Unmute cockpit audio alerts" : "Mute cockpit audio alerts"}
                title={audioAlertsMuted ? "Audio alerts MUTED — click to unmute" : "Audio alerts ENABLED — click to mute"}
                className={cn(
                  "px-2 py-1 rounded-md text-xs font-mono font-bold border transition inline-flex items-center gap-1 cursor-pointer",
                  audioAlertsMuted
                    ? "bg-[#111520] border-slate-700 text-slate-500 hover:text-slate-300"
                    : "bg-emerald-500/10 border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/20"
                )}
              >
                {audioAlertsMuted ? (
                  <VolumeX className="w-3.5 h-3.5" />
                ) : (
                  <Volume2 className="w-3.5 h-3.5" />
                )}
                <span className="hidden lg:inline text-[10px] uppercase">
                  {audioAlertsMuted ? "Mute" : "Audio"}
                </span>
              </button>

              {/* 5. Setup */}
              <button
                type="button"
                onClick={() => setSetupModalOpen(true)}
                className="px-2.5 py-1 rounded-md text-xs font-semibold border border-slate-700/80 bg-[#141824] text-slate-300 hover:text-white hover:bg-slate-800 transition cursor-pointer"
              >
                Setup
              </button>

              {/* 6. ? Guide */}
              <button
                type="button"
                onClick={() => setGuideOpen(true)}
                className="px-2.5 py-1 rounded-md text-xs font-semibold border border-teal-500/40 bg-[#112228] text-teal-300 hover:bg-teal-500/20 transition cursor-pointer"
              >
                ? Guide
              </button>

              {/* 7. ⌘K Omnibar */}
              <button
                type="button"
                onClick={() => setPaletteOpen(true)}
                className="px-2.5 py-1 rounded-md text-xs font-bold border border-cyan-500/40 bg-cyan-950/40 text-cyan-300 hover:bg-cyan-500/20 transition flex items-center gap-1.5 cursor-pointer font-mono"
                title="Open Omnibar (Cmd+K / Ctrl+K)"
              >
                <span>⌘K</span>
                <span className="hidden sm:inline font-sans text-slate-300 font-semibold">Search</span>
              </button>
            </div>
          </div>

          {/* Full-Width 5-Tab Segmented View Switcher */}
          <nav
            aria-label="Primary View Switcher"
            className="bg-[#0e121b] border border-[#1e2638] rounded-xl p-1 grid grid-cols-5 gap-1"
          >
            {VIEW_TABS.map((tab) => {
              const active = isTabActive(tab);
              return (
                <Link
                  key={tab}
                  href={TAB_ROUTES[tab]}
                  onClick={() => setActiveView(tab)}
                  className={cn(
                    "py-1 px-3 text-xs transition-all text-center cursor-pointer block",
                    active
                      ? "bg-gradient-to-r from-teal-500/25 via-sky-500/20 to-indigo-500/25 border border-teal-400/60 text-white font-semibold rounded-lg shadow-[0_0_15px_rgba(45,212,191,0.15)]"
                      : "text-slate-400 hover:text-white font-medium rounded-lg border border-transparent"
                  )}
                >
                  {tab}
                </Link>
              );
            })}
          </nav>

          {/* Standardized T-Scan Status Rail: Session Countdown | Gamma Regime | Active Risk | Shortcuts */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <MarketStatusPill />

              <span
                className={cn(
                  "inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full border text-[11px] font-mono font-bold tabular-nums",
                  isPositiveGamma
                    ? "bg-emerald-500/12 border-emerald-500/40 text-emerald-300"
                    : "bg-purple-500/15 border-purple-500/45 text-purple-300"
                )}
              >
                <span>{isPositiveGamma ? "+Γ PIN" : "-Γ ACCEL"}</span>
                {zeroGamma > 0 && (
                  <span className="text-amber-300 border-l border-white/15 pl-1.5">
                    0Γ {zeroGamma.toFixed(1)}
                  </span>
                )}
              </span>

              {activePos ? (
                <span
                  className={cn(
                    "inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full border text-[11px] font-mono font-bold tabular-nums",
                    activePos.contractType === "CALL"
                      ? "bg-emerald-500/15 border-emerald-400/50 text-emerald-300"
                      : "bg-rose-500/15 border-rose-400/50 text-rose-300"
                  )}
                  title={`Entry $${Number(activePos.btoSpotPrice ?? 0).toFixed(2)} | Stop $${Number(activePos.stopLossSpot ?? 0).toFixed(2)} | T1 $${Number(activePos.target1Spot ?? 0).toFixed(2)}`}
                >
                  <span>
                    OPEN {activePos.ticker} {activePos.strike}
                    {activePos.contractType === "CALL" ? "C" : "P"}
                  </span>
                  {typeof activePos.pnlOptionPct === "number" && (
                    <span>
                      {activePos.pnlOptionPct >= 0 ? "+" : ""}
                      {activePos.pnlOptionPct.toFixed(1)}%
                    </span>
                  )}
                </span>
              ) : (
                <span className="hidden sm:inline-flex items-center px-2 py-0.5 rounded-full border border-slate-800 bg-[#111520] text-[10.5px] font-mono text-slate-400 tabular-nums">
                  FLAT · 0 OPEN
                </span>
              )}
            </div>

            <div className="hidden md:flex items-center gap-2 text-[10px] font-mono text-slate-500">
              <span>
                <kbd className="px-1.5 py-0.5 rounded bg-[#111520] border border-[#1e2638] text-slate-300">/</kbd> Search
              </span>
              <span>
                <kbd className="px-1.5 py-0.5 rounded bg-[#111520] border border-[#1e2638] text-slate-300">1–5</kbd> Views
              </span>
              <span>
                <kbd className="px-1.5 py-0.5 rounded bg-[#111520] border border-[#1e2638] text-slate-300">G/V/D/C</kbd> Greek
              </span>
              <span>
                <kbd className="px-1.5 py-0.5 rounded bg-[#111520] border border-[#1e2638] text-slate-300">R</kbd> Refresh
              </span>
            </div>
          </div>

          {(pathname !== "/" || activeView !== "Heatmap") && (
            <div className="pt-1 border-t border-white/5">
              <ExpectedMovesBadges />
            </div>
          )}
        </div>
      </header>

      <GuideModal open={guideOpen} onOpenChange={setGuideOpen} />
      <SetupModal open={isSetupModalOpen} onOpenChange={setSetupModalOpen} />
      <CommandPalette
        externalOpen={paletteOpen}
        onExternalClose={() => setPaletteOpen(false)}
      />
    </>
  );
}
