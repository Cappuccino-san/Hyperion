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
  const fetchOptionsChain = useDashboardStore((state) => state.fetchOptionsChain);
  const fetchServerTrades = useDashboardStore((state) => state.fetchServerTrades);

  useEffect(() => {
    // Initial fetch on mount or ticker change
    void fetchOptionsChain(activeTicker);
    void fetchServerTrades(activeTicker);

    // Continuous 5-second market heartbeat (skip while tab is backgrounded)
    const interval = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") {
        return;
      }
      void fetchOptionsChain(activeTicker);
      void fetchServerTrades(activeTicker);
    }, 5_000);

    return () => clearInterval(interval);
  }, [activeTicker, fetchOptionsChain, fetchServerTrades]);

  return null;
}

