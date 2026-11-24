"use client";

import { useEffect } from "react";
import { useDashboardStore } from "@/store/useDashboardStore";

/**
 * GlobalMarketDataSync
 *
 * Singleton background synchronization component mounted at the application root (layout.tsx).
 * Pumps real-time option chain analytics, underlying spot prices, and server active/closed trades
 * into useDashboardStore, ensuring state parity across all tabs (Heatmap, Quad, Gaia, Scanner, Charts).
 */
export function GlobalMarketDataSync() {
  const activeTicker = useDashboardStore((state) => state.activeTicker);
  const liveTickMarketOpen = useDashboardStore((state) => state.liveTickMarketOpen);
  const fetchOptionsChain = useDashboardStore((state) => state.fetchOptionsChain);
  const fetchServerTrades = useDashboardStore((state) => state.fetchServerTrades);
  const hydrateDiscordConfig = useDashboardStore((state) => state.hydrateDiscordConfig);

  useEffect(() => {
    hydrateDiscordConfig();
  }, [hydrateDiscordConfig]);

  useEffect(() => {
    // Initial fetch on mount or ticker change
    void fetchOptionsChain(activeTicker);
    void fetchServerTrades(activeTicker);
  }, [activeTicker, fetchOptionsChain, fetchServerTrades]);

  useEffect(() => {
    // Adaptive market heartbeat: 5s during active RTH, 45s backoff off-hours / weekends
    const pollIntervalMs = liveTickMarketOpen === false ? 45_000 : 5_000;
    const interval = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") {
        return;
      }
      void fetchOptionsChain(activeTicker);
      void fetchServerTrades(activeTicker);
    }, pollIntervalMs);

    return () => clearInterval(interval);
  }, [activeTicker, liveTickMarketOpen, fetchOptionsChain, fetchServerTrades]);

  return null;
}

