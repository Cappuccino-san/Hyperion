"use client";

import React from "react";
import Link from "next/link";
import { ActiveView, useDashboardStore } from "@/store/useDashboardStore";

const FOOTER_LINKS: Array<{ label: string; href: string; view?: ActiveView }> = [
  { label: "Heatmap", href: "/", view: "Heatmap" },
  { label: "Quad", href: "/quad", view: "Quad" },
  { label: "Gaia", href: "/gaia", view: "Gaia" },
  { label: "Scanner", href: "/scanner", view: "Scanner" },
  { label: "Recap", href: "/recap", view: "Recap" },
  { label: "Guide", href: "/guide" },
];

export function AppFooter() {
  const setActiveView = useDashboardStore((state) => state.setActiveView);
  const setSetupModalOpen = useDashboardStore((state) => state.setSetupModalOpen);

  return (
    <footer className="border-t border-white/10 bg-[#111422]/80 py-4 px-4 mt-6">
      <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2 text-[11px] font-mono text-slate-400">
        <div className="flex flex-wrap items-center gap-3.5">
          {FOOTER_LINKS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => {
                if (item.view) setActiveView(item.view);
              }}
              className="hover:text-white transition-colors"
            >
              {item.label}
            </Link>
          ))}
          <button
            type="button"
            onClick={() => setSetupModalOpen(true)}
            className="hover:text-white transition-colors cursor-pointer"
          >
            Hyperion Alerts
          </button>
        </div>
        <div className="text-center sm:text-right text-slate-500">
          Paper/Shadow Analytics Cockpit · For educational &amp; quantitative research purposes only; not financial advice.
        </div>
      </div>
    </footer>
  );
}
