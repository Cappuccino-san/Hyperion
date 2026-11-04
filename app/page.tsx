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
import { ChartsView } from "@/components/views/ChartsView";
import { ScannerView } from "@/components/views/ScannerView";
import { RecapView } from "@/components/views/RecapView";
import { useDashboardStore } from "@/store/useDashboardStore";

export default function DashboardPage() {
  const activeView = useDashboardStore((state) => state.activeView);
  const activeTicker = useDashboardStore((state) => state.activeTicker);
  const setSetupModalOpen = useDashboardStore(
    (state) => state.setSetupModalOpen
  );
  const fetchOptionsChain = useDashboardStore(
    (state) => state.fetchOptionsChain
  );

  // Poll /api/options?ticker=${activeTicker} immediately & constantly every 5 seconds so Heatmap/Gaia stream live prices
  useEffect(() => {
    fetchOptionsChain(activeTicker);

    const pollInterval = setInterval(() => {
      fetchOptionsChain(activeTicker);
    }, 5_000);

    return () => clearInterval(pollInterval);
  }, [activeTicker, fetchOptionsChain]);

  return (
    <div className="min-h-screen bg-[#0b0d17] text-argon-text flex flex-col">
      {/* Global Navigation & Top Header */}
      <TopNavBar />

      {/* Single-Column Layout (expands to max-w-[1600px] on Gaia, max-w-[1080px] on Heatmap) */}
      <main
        className={`flex-1 w-full mx-auto px-4 py-4 space-y-4 ${
          activeView === "Gaia" || activeView === "Antaeus" || activeView === "Atlas"
            ? "max-w-[1600px]"
            : "max-w-[1080px]"
        }`}
      >
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

        {(activeView === "Gaia" || activeView === "Antaeus" || activeView === "Atlas") && (
          <GaiaView />
        )}

        {activeView === "Charts" && <ChartsView />}

        {activeView === "Scanner" && <ScannerView />}
        {activeView === "Recap" && <RecapView />}
      </main>

      {/* Footer Links & Disclaimer */}
      <footer className="border-t border-white/10 bg-[#111422]/80 py-4 px-4 mt-6">
        <div className="max-w-[1080px] mx-auto flex flex-col sm:flex-row items-center justify-between gap-2 text-[11px] font-mono text-slate-400">
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
