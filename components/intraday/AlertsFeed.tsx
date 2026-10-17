"use client";

import React, { useEffect, useRef } from "react";
import { useDashboardStore } from "@/store/useDashboardStore";

export function AlertsFeed() {
  const alerts = useDashboardStore((state) => state.alerts);
  const discordConfig = useDashboardStore((state) => state.discordConfig);
  const setSetupModalOpen = useDashboardStore((state) => state.setSetupModalOpen);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

  const isConfigured = Boolean(discordConfig?.enabled && discordConfig?.webhookUrl);

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [alerts]);

  return (
    <div className="bg-[#111422] rounded-2xl border border-white/[0.08] p-4">
      {/* Card Header */}
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-mono font-bold uppercase tracking-wider text-white">
          ALERTS
        </h3>
        <button
          type="button"
          onClick={() => setSetupModalOpen(true)}
          className="inline-flex items-center gap-1.5 text-[11px] font-mono hover:text-white transition-colors cursor-pointer"
        >
          {isConfigured ? (
            <>
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.8)]" />
              <span className="text-emerald-400 font-medium">posting to Discord</span>
            </>
          ) : (
            <span className="text-argon-muted">posting to Discord (setup)</span>
          )}
        </button>
      </div>

      {/* Fixed-height scrollable minimalist log */}
      <div
        ref={scrollContainerRef}
        className="max-h-36 overflow-y-auto argon-scrollbar divide-y divide-white/[0.04]"
      >
        {alerts.map((alert) => (
          <div
            key={alert.id}
            className="flex items-baseline gap-3 py-1.5 font-mono text-xs border-b border-white/[0.04] last:border-b-0"
          >
            <span className="text-argon-muted tabular-nums shrink-0">
              {alert.timestamp}
            </span>
            <span className="text-argon-text">{alert.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
