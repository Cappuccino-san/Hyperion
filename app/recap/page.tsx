"use client";

import React, { useEffect } from "react";
import { TopNavBar } from "@/components/header/TopNavBar";
import { RecapView } from "@/components/views/RecapView";
import { useDashboardStore } from "@/store/useDashboardStore";

export default function RecapPage() {
  const setActiveView = useDashboardStore((state) => state.setActiveView);

  useEffect(() => {
    setActiveView("Recap");
  }, [setActiveView]);

  return (
    <div className="min-h-screen bg-[#0b0d17] text-slate-100 flex flex-col">
      <TopNavBar />
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 py-4">
        <RecapView />
      </main>
      <footer className="border-t border-white/10 bg-[#111422]/80 py-4 px-4 mt-6">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2 text-[11px] font-mono text-slate-400">
          <div className="flex flex-wrap items-center gap-3">
            <a href="https://discord.gg/WS7t69W2D" target="_blank" rel="noreferrer" className="hover:text-white transition-colors">
              Discord
            </a>
            <a href="https://whop.com/index-cheat-codes/affiliates" target="_blank" rel="noreferrer" className="hover:text-white transition-colors">
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
            <a href="/atlas" className="hover:text-white transition-colors">
              Atlas
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
          </div>
          <div className="text-center sm:text-right text-slate-500">
            For educational and informational purposes only. Not financial advice. Data may be delayed or inaccurate; trade at your own risk.
          </div>
        </div>
      </footer>
    </div>
  );
}
