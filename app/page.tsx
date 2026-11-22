"use client";

import React, { useEffect } from "react";
import { TopNavBar } from "@/components/header/TopNavBar";
import { TickerNav } from "@/components/header/TickerNav";
import { SpotDisplay } from "@/components/header/SpotDisplay";
import { SignalClarityBanner } from "@/components/SignalClarityBanner";
import { MetricsRow } from "@/components/metrics/MetricsRow";
import { IntradayChart } from "@/components/intraday/IntradayChart";
import { AlertsFeed } from "@/components/intraday/AlertsFeed";
import { HeatmapTable } from "@/components/heatmap/HeatmapTable";
import { QuadView } from "@/components/views/QuadView";
import { GaiaView } from "@/components/views/GaiaView";
import { ScannerView } from "@/components/views/ScannerView";
import { RecapView } from "@/components/views/RecapView";
import { useDashboardStore } from "@/store/useDashboardStore";

export default function DashboardPage() {
  const activeView = useDashboardStore((state) => state.activeView);
  const setActiveView = useDashboardStore((state) => state.setActiveView);
  const setSetupModalOpen = useDashboardStore(
    (state) => state.setSetupModalOpen
  );

  useEffect(() => {
    setActiveView("Heatmap");
  }, [setActiveView]);

  return (
    <div className="min-h-screen bg-[#0b0d17] text-argon-text flex flex-col">
      {/* Global Navigation & Top Header */}
      <TopNavBar />

      {/* Single-Column Layout standardized to max-w-7xl */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 py-4 space-y-4">
        {activeView === "Heatmap" && (
          <>
            {/* 1. Search Bar & 2-Row Ticker Grid */}
            <TickerNav />

            {/* 2. Hero Spot & Expected Moves Card */}
            <SpotDisplay />

            {/* 2.5 Calm Executive Signal Banner & Density Switcher */}
            <SignalClarityBanner />

            {/* 3. 3-Card Summary Row & Unified Walls + Slider Card */}
            <MetricsRow />

            {/* 4. Full-Width Intraday Sparkline & Compact Alerts Bar (Stacked 100% Width) */}
            <div className="space-y-3">
              <IntradayChart />
              <AlertsFeed />
            </div>

            {/* 5. Multi-Pill Filter Bar & Heatmap Grid */}
            <HeatmapTable />
          </>
        )}

        {activeView === "Quad" && <QuadView />}

        {activeView === "Gaia" && <GaiaView />}

        {activeView === "Scanner" && <ScannerView />}
        {activeView === "Recap" && <RecapView />}
      </main>

      {/* Footer Links & Disclaimer */}
      <footer className="border-t border-white/10 bg-[#111422]/80 py-4 px-4 mt-6">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2 text-[11px] font-mono text-slate-400">
          <div className="flex flex-wrap items-center gap-3">
            <a
              href="https://discord.gg/WS7t69W2D"
              target="_blank"
              rel="noreferrer"
              className="hover:text-white transition-colors"
            >
              Discord
            </a>
            <a
              href="https://whop.com/index-cheat-codes/affiliates"
              target="_blank"
              rel="noreferrer"
              className="hover:text-white transition-colors"
            >
              Index Cheat Codes
            </a>
            <a href="/" className="hover:text-white transition-colors">
              Heatmap
            </a>
            <a href="/quad" className="hover:text-white transition-colors">
              Quad
            </a>
            <a href="/gaia" className="hover:text-white transition-colors">
              Gaia
            </a>
            <a href="/scanner" className="hover:text-white transition-colors">
              Scanner
            </a>
            <a href="/recap" className="hover:text-white transition-colors">
              Recap
            </a>
            <a href="/guide" className="hover:text-white transition-colors">
              Guide
            </a>
            <button
              type="button"
              onClick={() => setSetupModalOpen(true)}
              className="hover:text-white transition-colors cursor-pointer"
            >
              Hyperion Alerts
            </button>
          </div>
          <div className="text-center sm:text-right text-slate-500">
            For educational and informational purposes only. Not financial advice. Data may be delayed or inaccurate; trade at your own risk.
          </div>
        </div>
      </footer>
    </div>
  );
}
