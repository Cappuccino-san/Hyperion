"use client";

import React, { useEffect } from "react";
import { TopNavBar } from "@/components/header/TopNavBar";
import { QuadView } from "@/components/views/QuadView";
import { useDashboardStore } from "@/store/useDashboardStore";

export default function QuadPage() {
  const setActiveView = useDashboardStore((state) => state.setActiveView);

  useEffect(() => {
    setActiveView("Quad");
  }, [setActiveView]);

  return (
    <div className="min-h-screen bg-[#0b0d17] text-slate-100 flex flex-col">
      <TopNavBar />
      <main className="flex-1 max-w-[1200px] w-full mx-auto px-4 py-4">
        <QuadView />
      </main>
      <footer className="border-t border-white/10 bg-[#111422]/80 py-4 px-4 mt-6">
        <div className="max-w-[1200px] mx-auto flex flex-col sm:flex-row items-center justify-between gap-2 text-[11px] font-mono text-slate-400">
          <div className="flex flex-wrap items-center gap-3">
            <a href="https://discord.gg/WS7t69W2D" target="_blank" rel="noreferrer" className="hover:text-white transition-colors">
              Discord
            </a>
            <a href="https://whop.com/index-cheat-codes/affiliates" target="_blank" rel="noreferrer" className="hover:text-white transition-colors">
              Index Cheat Codes
            </a>
            <a href="/guide" className="hover:text-white transition-colors">
              Guide
            </a>
            <a href="/recap" className="hover:text-white transition-colors">
              Recap
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
