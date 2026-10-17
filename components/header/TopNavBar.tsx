"use client";

import React, { useEffect, useState } from "react";
import { ActiveView, useDashboardStore } from "@/store/useDashboardStore";
import { GuideModal } from "@/components/modals/GuideModal";
import { CheatCodesModal } from "@/components/modals/CheatCodesModal";
import { SetupModal } from "@/components/modals/SetupModal";
import { cn } from "@/lib/utils";

const VIEW_TABS: ActiveView[] = ["Heatmap", "Quad", "Antaeus", "Scanner"];

export function TopNavBar() {
  const activeView = useDashboardStore((state) => state.activeView);
  const setActiveView = useDashboardStore((state) => state.setActiveView);
  const isSetupModalOpen = useDashboardStore((state) => state.isSetupModalOpen);
  const setSetupModalOpen = useDashboardStore((state) => state.setSetupModalOpen);
  const [guideOpen, setGuideOpen] = useState(false);
  const [cheatCodesOpen, setCheatCodesOpen] = useState(false);

  return (
    <>
      <header className="w-full bg-[#0b0d17]/95 backdrop-blur-md">
        <div className="max-w-[1080px] mx-auto px-4 pt-3 pb-2 space-y-3">
          {/* Brand & ? Guide Row */}
          <div className="flex items-center justify-between gap-3">
            {/* Left: Hyperion solar/orbital icon + Brand */}
            <button
              type="button"
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
            </button>

            {/* Right: ? Guide Pill */}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setGuideOpen(true)}
                className="bg-[#112228] border border-teal-500/40 text-teal-300 hover:bg-teal-500/20 rounded-full px-3.5 py-1 text-xs font-semibold transition-colors cursor-pointer"
              >
                ? Guide
              </button>
            </div>
          </div>

          {/* Full-Width 4-Tab Segmented View Switcher */}
          <nav
            aria-label="Primary View Switcher"
            className="bg-[#0e121b] border border-[#1e2638] rounded-xl p-1 grid grid-cols-4 gap-1"
          >
            {VIEW_TABS.map((tab) => {
              const isActive = activeView === tab;
              return (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setActiveView(tab)}
                  className={cn(
                    "py-1.5 px-3 text-xs transition-all text-center cursor-pointer",
                    isActive
                      ? "bg-gradient-to-r from-teal-500/25 via-sky-500/20 to-indigo-500/25 border border-teal-400/60 text-white font-semibold rounded-lg shadow-[0_0_15px_rgba(45,212,191,0.15)]"
                      : "text-slate-400 hover:text-white font-medium rounded-lg border border-transparent"
                  )}
                >
                  {tab}
                </button>
              );
            })}
          </nav>
        </div>
      </header>

      <GuideModal open={guideOpen} onOpenChange={setGuideOpen} />
      <CheatCodesModal open={cheatCodesOpen} onOpenChange={setCheatCodesOpen} />
      <SetupModal open={isSetupModalOpen} onOpenChange={setSetupModalOpen} />
    </>
  );
}
