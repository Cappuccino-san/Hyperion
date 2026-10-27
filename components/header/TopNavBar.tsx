"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { ActiveView, useDashboardStore } from "@/store/useDashboardStore";
import { GuideModal } from "@/components/modals/GuideModal";
import { CheatCodesModal } from "@/components/modals/CheatCodesModal";
import { SetupModal } from "@/components/modals/SetupModal";
import { CommandPalette } from "@/components/CommandPalette";
import { cn } from "@/lib/utils";

const VIEW_TABS: ActiveView[] = ["Heatmap", "Quad", "Gaia", "Scanner", "Recap"];

const TAB_ROUTES: Record<ActiveView, string> = {
  Heatmap: "/",
  Quad: "/quad",
  Gaia: "/gaia",
  Antaeus: "/gaia",
  Atlas: "/gaia",
  Scanner: "/scanner",
  Charts: "/",
  Recap: "/recap",
};

const HOLIDAYS_2026 = new Set([
  "2026-01-01",
  "2026-01-19",
  "2026-02-16",
  "2026-04-03",
  "2026-05-25",
  "2026-06-19",
  "2026-07-03",
  "2026-09-07",
  "2026-11-26",
  "2026-12-25",
]);

const EARLY_CLOSE_2026 = new Set(["2026-11-27", "2026-12-24"]);

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
  return p.wd >= 1 && p.wd <= 5 && !HOLIDAYS_2026.has(p.ymd);
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
  const closeHr = EARLY_CLOSE_2026.has(p.ymd) ? 13 : 16;
  const closeSec = closeHr * 3600;
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

export function TopNavBar() {
  const router = useRouter();
  const pathname = usePathname();
  const activeView = useDashboardStore((state) => state.activeView);
  const activeTicker = useDashboardStore((state) => state.activeTicker);
  const setActiveView = useDashboardStore((state) => state.setActiveView);
  const setFilters = useDashboardStore((state) => state.setFilters);
  const fetchOptionsChain = useDashboardStore((state) => state.fetchOptionsChain);
  const isSetupModalOpen = useDashboardStore((state) => state.isSetupModalOpen);
  const setSetupModalOpen = useDashboardStore((state) => state.setSetupModalOpen);
  const [guideOpen, setGuideOpen] = useState(false);
  const [cheatCodesOpen, setCheatCodesOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [mktStatus, setMktStatus] = useState<MarketStatusInfo>(() =>
    computeMarketStatus()
  );

  const handleTabClick = (tab: ActiveView) => {
    setActiveView(tab);
    if (tab === "Heatmap") {
      router.push("/");
    } else if (tab === "Quad") {
      router.push("/quad");
    } else if (tab === "Gaia" || tab === "Antaeus" || tab === "Atlas") {
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
    if (
      pathname === "/gaia" ||
      pathname === "/atlas" ||
      pathname === "/antaeus"
    ) {
      return tab === "Gaia";
    }
    if (pathname === "/scanner") return tab === "Scanner";
    if (pathname === "/recap") return tab === "Recap";
    return activeView === tab;
  };

  useEffect(() => {
    setMounted(true);
    setMktStatus(computeMarketStatus());
    const id = setInterval(() => {
      setMktStatus(computeMarketStatus());
    }, 1000);
    return () => clearInterval(id);
  }, []);

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
        const searchEl = document.getElementById("ticker-search-input") as HTMLInputElement | null;
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
      <header className="w-full bg-[#0b0d17]/95 backdrop-blur-md">
        <div className="max-w-[1080px] mx-auto px-4 pt-3 pb-2 space-y-2.5">
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

            {/* Right: Action Pills (All 6 matching reference layout) */}
            <div className="flex flex-wrap items-center justify-end gap-2">
              {/* 1. ⚡ Index Cheat Codes */}
              <button
                type="button"
                onClick={() => setCheatCodesOpen(true)}
                className="px-3.5 py-1.5 rounded-full text-xs font-bold border border-amber-500/50 bg-[#1c1a17] text-amber-300 hover:bg-amber-500/15 transition flex items-center gap-1.5 cursor-pointer"
              >
                ⚡ Index Cheat Codes
              </button>

              {/* 2. Discord */}
              <a
                href="https://discord.gg/m2g5KDjza8"
                target="_blank"
                rel="noopener noreferrer"
                title="Join Discord Community"
                className="px-3.5 py-1.5 rounded-full text-xs font-bold border border-indigo-500/50 bg-[#17192e] text-indigo-200 hover:bg-indigo-500/20 transition flex items-center gap-1.5"
              >
                <svg width="15" height="12" viewBox="0 0 71 55" fill="currentColor" aria-hidden="true">
                  <path d="M60.1 4.9A58.5 58.5 0 0 0 45.6.4a40 40 0 0 0-1.8 3.7 54 54 0 0 0-16.2 0A39 39 0 0 0 25.8.4 58.4 58.4 0 0 0 11.2 4.9C2 18.6-.6 32 .7 45.2a58.9 58.9 0 0 0 18 9.1 43 43 0 0 0 3.8-6.2 38 38 0 0 1-6-2.9l1.5-1.1a42 42 0 0 0 35.9 0l1.5 1.1a38 38 0 0 1-6 2.9 43 43 0 0 0 3.8 6.2 58.7 58.7 0 0 0 18-9.1c1.5-15.3-2.6-28.6-11-40.3ZM23.7 37.1c-3.5 0-6.4-3.2-6.4-7.2s2.8-7.2 6.4-7.2 6.5 3.3 6.4 7.2c0 4-2.8 7.2-6.4 7.2Zm23.6 0c-3.5 0-6.4-3.2-6.4-7.2s2.8-7.2 6.4-7.2 6.5 3.3 6.4 7.2c0 4-2.8 7.2-6.4 7.2Z" />
                </svg>
                <span>Discord</span>
              </a>

              {/* 3. Add the Discord bot */}
              <button
                type="button"
                onClick={() => setSetupModalOpen(true)}
                className="px-3.5 py-1.5 rounded-full text-xs font-bold border border-cyan-500/50 bg-[#11222b] text-cyan-200 hover:bg-cyan-500/20 transition cursor-pointer"
              >
                Add the Discord bot
              </button>

              {/* 4. Setup */}
              <button
                type="button"
                onClick={() => setSetupModalOpen(true)}
                className="px-3.5 py-1.5 rounded-full text-xs font-bold border border-slate-600/70 bg-[#161926] text-slate-200 hover:bg-slate-800 transition cursor-pointer"
              >
                Setup
              </button>

              {/* 5. 𝕏 X */}
              <a
                href="https://x.com"
                target="_blank"
                rel="noopener noreferrer"
                title="X (Twitter)"
                className="px-3.5 py-1.5 rounded-full text-xs font-bold border border-slate-600/70 bg-[#161926] text-slate-200 hover:bg-slate-800 transition flex items-center gap-1"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.727-8.835L1.254 2.25H8.08l4.253 5.622L18.244 2.25zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                </svg>
                <span>X</span>
              </a>

              {/* 6. ? Guide */}
              <button
                type="button"
                onClick={() => setGuideOpen(true)}
                className="px-3.5 py-1.5 rounded-full text-xs font-bold border border-teal-500/50 bg-[#112228] text-teal-300 hover:bg-teal-500/20 transition cursor-pointer"
              >
                ? Guide
              </button>

              {/* 7. ⌘K Omnibar */}
              <button
                type="button"
                onClick={() => setPaletteOpen(true)}
                className="px-3 py-1.5 rounded-full text-xs font-bold border border-cyan-500/40 bg-cyan-950/40 text-cyan-300 hover:bg-cyan-500/20 transition flex items-center gap-1.5 cursor-pointer font-mono"
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
                    "py-1.5 px-3 text-xs transition-all text-center cursor-pointer block",
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

          {/* 4-State Live Market Status Badge & Keyboard Shortcuts Hint */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div
              id="mkt"
              className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#111520] border border-[#1e2638] text-xs font-mono text-slate-400"
            >
              <span
                className={cn(
                  "w-2 h-2 rounded-full shrink-0",
                  mktStatus.state === "open"
                    ? "bg-[#22c55e] shadow-[0_0_8px_#22c55e]"
                    : mktStatus.state === "pre" || mktStatus.state === "after"
                      ? "bg-[#eab308] shadow-[0_0_6px_#eab308]"
                      : "bg-[#64748b]"
                )}
              />
              <b className="text-slate-200 font-semibold">{mktStatus.label}</b>
              <span suppressHydrationWarning>{mounted ? `· ${mktStatus.countdown}` : ""}</span>
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
        </div>
      </header>

      <GuideModal open={guideOpen} onOpenChange={setGuideOpen} />
      <CheatCodesModal open={cheatCodesOpen} onOpenChange={setCheatCodesOpen} />
      <SetupModal open={isSetupModalOpen} onOpenChange={setSetupModalOpen} />
      <CommandPalette
        externalOpen={paletteOpen}
        onExternalClose={() => setPaletteOpen(false)}
      />
    </>
  );
}
