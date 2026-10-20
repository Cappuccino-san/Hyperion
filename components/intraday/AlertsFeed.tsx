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
    <div className="argon-card rounded-xl p-4">
      {/* Header: ALERTS on left, posting to Discord on right */}
      <div className="flex items-center justify-between border-b border-white/10 pb-2 mb-2">
        <h4 className="text-[10px] font-mono font-bold uppercase tracking-widest text-slate-400">
          ALERTS
        </h4>
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
            <span className="text-slate-500 font-normal">Discord posting off</span>
          )}
        </button>
      </div>

      {/* Events List */}
      <div
        ref={scrollContainerRef}
        className="max-h-36 overflow-y-auto argon-scrollbar divide-y divide-white/5"
      >
        {alerts.length === 0 ? (
          <div className="py-2 font-mono text-xs text-slate-500">
            No events yet — watching for spot crossing zero γ and call/put wall changes.
          </div>
        ) : (
          alerts.map((alert) => (
            <div
              key={alert.id}
              className="flex items-baseline gap-3 py-1.5 font-mono text-[11.5px]"
            >
              <span className="text-slate-500 tabular-nums shrink-0 text-[11px]">
                {alert.timestamp}
              </span>
              <span className="text-[#cbd5e1] font-medium leading-relaxed">
                {alert.message}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
