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
import { AppFooter } from "@/components/layout/AppFooter";
import { useDashboardStore } from "@/store/useDashboardStore";

export default function DashboardPage() {
  const activeView = useDashboardStore((state) => state.activeView);
  const setActiveView = useDashboardStore((state) => state.setActiveView);

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

      <AppFooter />
    </div>
  );
}
