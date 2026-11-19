"use client";

import React, { useState, useEffect, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import { useDashboardStore } from "@/store/useDashboardStore";
import {
  computeDealerFlowSummary,
  formatInstitutionalDeskBrief,
  playTerminalAlertTone,
} from "@/lib/dealerFlowMetrics";

interface CommandItem {
  id: string;
  category: "NAVIGATION" | "TICKER" | "GREEK_MODE" | "DESK_TOOLS";
  label: string;
  sublabel: string;
  shortcut?: string;
  badgeColor?: string;
  action: () => void;
}

const CORE_TICKERS: Array<{ symbol: string; name: string }> = [
  { symbol: "SPY", name: "SPDR S&P 500 ETF Trust" },
  { symbol: "QQQ", name: "Invesco QQQ Trust (Nasdaq-100)" },
  { symbol: "SPXW", name: "S&P 500 Index Weekly/0DTE Options" },
  { symbol: "IWM", name: "iShares Russell 2000 ETF" },
  { symbol: "NVDA", name: "NVIDIA Corporation" },
  { symbol: "TSLA", name: "Tesla, Inc." },
  { symbol: "AAPL", name: "Apple Inc." },
  { symbol: "META", name: "Meta Platforms, Inc." },
  { symbol: "MSFT", name: "Microsoft Corporation" },
  { symbol: "AMZN", name: "Amazon.com, Inc." },
  { symbol: "AMD", name: "Advanced Micro Devices, Inc." },
];

export function CommandPalette({
  externalOpen,
  onExternalClose,
}: {
  externalOpen?: boolean;
  onExternalClose?: () => void;
}) {
  const router = useRouter();
  const activeTicker = useDashboardStore((state) => state.activeTicker);
  const setTicker = useDashboardStore((state) => state.setTicker);
  const activeMetric = useDashboardStore((state) => state.gridFilters.metric);
  const setFilters = useDashboardStore((state) => state.setFilters);
  const spotPrice = useDashboardStore((state) => state.spotPrice);
  const netMetrics = useDashboardStore((state) => state.netMetrics);
  const gammaLevels = useDashboardStore((state) => state.gammaLevels);
  const kingNode = useDashboardStore((state) => state.kingNode);
  const expectedMoves = useDashboardStore((state) => state.expectedMoves);
  const chainStrikes = useDashboardStore((state) => state.chainStrikes);
  const fetchOptionsChain = useDashboardStore((state) => state.fetchOptionsChain);
  const uiMode = useDashboardStore((state) => state.uiMode);
  const toggleUiMode = useDashboardStore((state) => state.toggleUiMode);
  const audioAlertsMuted = useDashboardStore((state) => state.audioAlertsMuted);
  const setAudioAlertsMuted = useDashboardStore((state) => state.setAudioAlertsMuted);
  const serverActivePositions = useDashboardStore((state) => state.serverActivePositions);
  const serverClosedTrades = useDashboardStore((state) => state.serverClosedTrades);
  const isStaleSnapshot = useDashboardStore((state) => state.isStaleSnapshot);
  const audioAlertsEnabled = !audioAlertsMuted;

  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const prevKingRef = useRef<number | null>(null);
  const prevZeroGammaRef = useRef<number | null>(null);
  const prevActiveCountRef = useRef<number | null>(null);
  const prevClosedCountRef = useRef<number | null>(null);
  const prevStaleRef = useRef<boolean>(false);
  const focusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = (msg: string, durationMs = 3500) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToastMsg(msg);
    toastTimerRef.current = setTimeout(() => {
      toastTimerRef.current = null;
      setToastMsg(null);
    }, durationMs);
  };

  useEffect(() => {
    return () => {
      if (focusTimerRef.current) clearTimeout(focusTimerRef.current);
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  const openPalette = () => {
    setIsOpen(true);
    setQuery("");
    setSelectedIndex(0);
  };

  const closePalette = () => {
    setIsOpen(false);
    setQuery("");
    onExternalClose?.();
  };

  useEffect(() => {
    if (externalOpen) {
      openPalette();
    }
  }, [externalOpen]);

  // Global Cmd+K / Ctrl+K listener
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (isOpen) {
          closePalette();
        } else {
          openPalette();
        }
      } else if (e.key === "Escape" && isOpen) {
        e.preventDefault();
        closePalette();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  useEffect(() => {
    if (focusTimerRef.current) {
      clearTimeout(focusTimerRef.current);
      focusTimerRef.current = null;
    }
    if (isOpen) {
      focusTimerRef.current = setTimeout(() => {
        focusTimerRef.current = null;
        inputRef.current?.focus();
      }, 20);
    }
    return () => {
      if (focusTimerRef.current) {
        clearTimeout(focusTimerRef.current);
        focusTimerRef.current = null;
      }
    };
  }, [isOpen]);

  // Acoustic monitoring for live King Node migration & Zero-Gamma Flips
  useEffect(() => {
    if (!audioAlertsEnabled) return;
    const currentKing = kingNode.filteredKing ?? kingNode.allExpKing ?? 0;
    const currentZg = gammaLevels?.zeroGamma ?? 0;

    if (
      prevKingRef.current !== null &&
      prevKingRef.current > 0 &&
      currentKing > 0 &&
      prevKingRef.current !== currentKing
    ) {
      playTerminalAlertTone("KING_SHIFT");
      showToast(`⚡ King Node Migrated: ${prevKingRef.current} → ${currentKing}`, 4000);
    } else if (
      prevZeroGammaRef.current !== null &&
      prevZeroGammaRef.current > 0 &&
      currentZg > 0 &&
      Math.abs(prevZeroGammaRef.current - currentZg) >= 1
    ) {
      playTerminalAlertTone("GAMMA_FLIP");
      showToast(`⚠️ Zero Gamma Level Shift: ${currentZg.toFixed(1)}`, 4000);
    }

    prevKingRef.current = currentKing;
    prevZeroGammaRef.current = currentZg;
  }, [kingNode.allExpKing, kingNode.filteredKing, gammaLevels?.zeroGamma, audioAlertsEnabled]);

  // Cockpit acoustic alerts for BTO fill, STC exit, Stale feed, and 15:50-15:55 ET MOC warning
  useEffect(() => {
    const activeCount = Object.keys(serverActivePositions || {}).length;
    const closedCount = (serverClosedTrades || []).length;

    if (audioAlertsEnabled) {
      if (prevActiveCountRef.current !== null && activeCount > prevActiveCountRef.current) {
        playTerminalAlertTone("BTO_FILL");
        showToast("🟢 Paper BTO Position Opened", 4000);
      } else if (prevClosedCountRef.current !== null && closedCount > prevClosedCountRef.current) {
        playTerminalAlertTone("STC_EXIT");
        showToast("🔔 Paper STC Position Closed", 4000);
      }
      if (!prevStaleRef.current && isStaleSnapshot) {
        playTerminalAlertTone("STALE_FEED");
        showToast("⚠️ Market feed stale / syncing", 4000);
      }
      if (activeCount > 0) {
        try {
          const parts = new Intl.DateTimeFormat("en-US", {
            timeZone: "America/New_York",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          }).formatToParts(new Date());
          const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
          const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
          const etMins = h * 60 + m;
          if (etMins >= 950 && etMins <= 955) {
            playTerminalAlertTone("MOC_WARNING");
            showToast("⚠️ 15:55 ET MOC Hard Cutoff Approaching", 4500);
          }
        } catch {}
      }
    }

    prevActiveCountRef.current = activeCount;
    prevClosedCountRef.current = closedCount;
    prevStaleRef.current = isStaleSnapshot;
  }, [serverActivePositions, serverClosedTrades, isStaleSnapshot, audioAlertsEnabled]);

  // Compute live Dealer Hedging Flow Snapshot only when palette is open (avoids 800ms 491-strike idle work)
  const liveFlowSnapshot = useMemo(() => {
    if (!isOpen) return null;
    if (!spotPrice || spotPrice <= 0) return null;
    const strikeSummaries = chainStrikes.map((s) => ({
      strike: s.strike,
      netGex: s.gex?.ALL ?? 0,
      netVex: s.vex?.ALL ?? 0,
    }));

    return computeDealerFlowSummary({
      spot: spotPrice,
      netGexM: netMetrics.netGex || 0,
      zeroGammaFlip: gammaLevels?.zeroGamma ?? null,
      kingStrike: kingNode.filteredKing ?? kingNode.allExpKing ?? null,
      allExpKingStrike: kingNode.allExpKing ?? null,
      callWall: gammaLevels?.callWall ?? null,
      putWall: gammaLevels?.putWall ?? null,
      strikes: strikeSummaries,
    });
  }, [isOpen, spotPrice, netMetrics.netGex, gammaLevels, kingNode, chainStrikes]);

  const handleCopyBrief = () => {
    const brief = formatInstitutionalDeskBrief({
      symbol: activeTicker,
      spot: spotPrice,
      regime: liveFlowSnapshot?.regimeLabel ?? "NEUTRAL",
      totalNetGex: netMetrics.netGex || 0,
      totalNetVex: netMetrics.netVex || 0,
      totalNetDex: netMetrics.netDex || 0,
      kingStrike: kingNode.filteredKing ?? kingNode.allExpKing ?? 0,
      allExpKingStrike: kingNode.allExpKing ?? 0,
      callWall: gammaLevels?.callWall ?? 0,
      putWall: gammaLevels?.putWall ?? 0,
      zeroGammaLevel: gammaLevels?.zeroGamma ?? 0,
      expectedMove: expectedMoves?.daily?.em ?? 0,
      flow: liveFlowSnapshot ?? undefined,
    });

    if (!navigator?.clipboard?.writeText) {
      showToast("Clipboard unavailable in this browser context", 3200);
      return;
    }

    navigator.clipboard.writeText(brief).then(
      () => {
        playTerminalAlertTone("CONFIRM");
        showToast(`Copied ${activeTicker} Institutional Desk Brief to Clipboard`, 3200);
        closePalette();
      },
      () => {
        showToast("Clipboard permission denied", 3200);
      }
    );
  };

  const commands = useMemo<CommandItem[]>(() => {
    const items: CommandItem[] = [
      // Desk Tools
      {
        id: "tool-copy-brief",
        category: "DESK_TOOLS",
        label: `Copy ${activeTicker} Institutional Desk Brief`,
        sublabel: liveFlowSnapshot
          ? `${liveFlowSnapshot.plainEnglishThesis}`
          : "Export Markdown summary of Spot, GEX/VEX, Kings, Walls & Hedging Flow",
        shortcut: "⌘C",
        badgeColor: "text-amber-300 border-amber-400/40 bg-amber-500/10",
        action: handleCopyBrief,
      },
      {
        id: "tool-toggle-density",
        category: "DESK_TOOLS",
        label: `Toggle Density Lens: Current [${uiMode.toUpperCase()}]`,
        sublabel:
          uiMode === "signal"
            ? "Switch to Quant Mode (full granular multi-greek strike tables)"
            : "Switch to Signal Mode (calm, uncluttered high-conviction executive view)",
        shortcut: "S",
        badgeColor: "text-cyan-300 border-cyan-400/40 bg-cyan-500/10",
        action: () => {
          toggleUiMode();
          playTerminalAlertTone("CONFIRM");
          closePalette();
        },
      },
      {
        id: "tool-refresh",
        category: "DESK_TOOLS",
        label: "Force Live Options Book Re-Ingestion",
        sublabel: `Bypass timer and re-poll ${activeTicker} options chain immediately`,
        shortcut: "R",
        badgeColor: "text-cyan-300 border-cyan-400/40 bg-cyan-500/10",
        action: () => {
          fetchOptionsChain(activeTicker, true);
          playTerminalAlertTone("CONFIRM");
          closePalette();
        },
      },
      {
        id: "tool-audio-toggle",
        category: "DESK_TOOLS",
        label: `Acoustic Regime Alerts: ${audioAlertsEnabled ? "ENABLED" : "MUTED"}`,
        sublabel: "Synthesize Web Audio tones on King Node migrations & Zero-Gamma flips",
        badgeColor: audioAlertsEnabled
          ? "text-emerald-300 border-emerald-400/40 bg-emerald-500/10"
          : "text-slate-400 border-slate-600 bg-slate-800",
        action: () => {
          const next = !audioAlertsEnabled;
          setAudioAlertsMuted(!next);
          if (next) playTerminalAlertTone("CONFIRM");
          closePalette();
        },
      },
      // Navigation
      {
        id: "nav-heatmap",
        category: "NAVIGATION",
        label: "1 · Heatmap & Dealer Walls Matrix",
        sublabel: "Strike × Expiration GEX/VEX/DEX/Charm grid, intraday sparkline & alerts",
        shortcut: "1",
        action: () => {
          router.push("/");
          closePalette();
        },
      },
      {
        id: "nav-scanner",
        category: "NAVIGATION",
        label: "2 · 0DTE Tactical Execution Scanner",
        sublabel: "Top 3 Call/Put playbooks, triggers, stops, targets & 5-min King history",
        shortcut: "4",
        action: () => {
          router.push("/scanner");
          closePalette();
        },
      },
      {
        id: "nav-quad",
        category: "NAVIGATION",
        label: "3 · Quad Multi-Index Comparative Grid",
        sublabel: "Synchronized 4-pane dealer positioning across SPY, QQQ, SPXW & IWM",
        shortcut: "2",
        action: () => {
          router.push("/quad");
          closePalette();
        },
      },
      {
        id: "nav-gaia",
        category: "NAVIGATION",
        label: "4 · Gaia Dealer Book & Flow Gamma VWAP Canvas",
        sublabel: "Multi-timeframe candles, Macro/0DTE King trajectories & oscillator divergences",
        shortcut: "3",
        action: () => {
          router.push("/gaia");
          closePalette();
        },
      },
      {
        id: "nav-recap",
        category: "NAVIGATION",
        label: "5 · End-of-Day Multi-Ticker Session Recap",
        sublabel: "Intraday GK/VK migrations, wall shifts & next-session expected move cones",
        shortcut: "5",
        action: () => {
          router.push("/recap");
          closePalette();
        },
      },
      // Greek Lenses
      {
        id: "mode-gex",
        category: "GREEK_MODE",
        label: "Switch Exposure Lens → GEX (Gamma Exposure)",
        sublabel: `Current lens: ${activeMetric} · View dealer gamma pinning & acceleration walls`,
        shortcut: "G",
        action: () => {
          setFilters({ metric: "GEX" });
          closePalette();
        },
      },
      {
        id: "mode-vex",
        category: "GREEK_MODE",
        label: "Switch Exposure Lens → VEX (Vanna Exposure)",
        sublabel: "Measure dealer delta re-hedging flow per implied volatility shift",
        shortcut: "V",
        action: () => {
          setFilters({ metric: "VEX" });
          closePalette();
        },
      },
      {
        id: "mode-dex",
        category: "GREEK_MODE",
        label: "Switch Exposure Lens → DEX (Delta Exposure)",
        sublabel: "View aggregate directional dealer delta positioning across strikes",
        shortcut: "D",
        action: () => {
          setFilters({ metric: "DEX" });
          closePalette();
        },
      },
      {
        id: "mode-charm",
        category: "GREEK_MODE",
        label: "Switch Exposure Lens → CHARM (Delta Decay)",
        sublabel: "Quantify passive intraday time-decay dealer hedging flows",
        shortcut: "C",
        action: () => {
          setFilters({ metric: "Charm" });
          closePalette();
        },
      },
    ];

    // Add Core Tickers
    for (const t of CORE_TICKERS) {
      items.push({
        id: `ticker-${t.symbol}`,
        category: "TICKER",
        label: `Switch Symbol → ${t.symbol}`,
        sublabel: t.name,
        badgeColor:
          activeTicker === t.symbol
            ? "text-emerald-300 border-emerald-400/40 bg-emerald-500/10"
            : undefined,
        action: () => {
          setTicker(t.symbol);
          closePalette();
        },
      });
    }

    // Custom Ticker Jump
    const cleanQuery = query.trim().toUpperCase();
    if (
      /^[A-Z]{1,5}$/.test(cleanQuery) &&
      !CORE_TICKERS.some((t) => t.symbol === cleanQuery)
    ) {
      items.unshift({
        id: `custom-ticker-${cleanQuery}`,
        category: "TICKER",
        label: `Load Custom Ticker → ${cleanQuery}`,
        sublabel: `Fetch live option chain & dealer exposures for ${cleanQuery}`,
        badgeColor: "text-cyan-300 border-cyan-400/40 bg-cyan-500/10",
        action: () => {
          setTicker(cleanQuery);
          closePalette();
        },
      });
    }

    return items;
  }, [
    activeTicker,
    activeMetric,
    query,
    audioAlertsEnabled,
    liveFlowSnapshot,
    uiMode,
    router,
    setTicker,
    setFilters,
    fetchOptionsChain,
    toggleUiMode,
  ]);

  const filteredCommands = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter(
      (c) =>
        c.label.toLowerCase().includes(q) ||
        c.sublabel.toLowerCase().includes(q) ||
        c.category.toLowerCase().includes(q)
    );
  }, [commands, query]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) =>
        filteredCommands.length > 0 ? (prev + 1) % filteredCommands.length : 0
      );
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) =>
        filteredCommands.length > 0
          ? (prev - 1 + filteredCommands.length) % filteredCommands.length
          : 0
      );
    } else if (e.key === "Enter" && filteredCommands[selectedIndex]) {
      e.preventDefault();
      filteredCommands[selectedIndex].action();
    }
  };

  return (
    <>
      {toastMsg && (
        <div className="fixed bottom-5 right-5 z-[110] flex items-center gap-2.5 rounded-lg border border-cyan-500/40 bg-slate-950/95 px-4 py-2.5 text-xs font-medium text-cyan-200 shadow-2xl backdrop-blur-md">
          <span className="h-2 w-2 rounded-full bg-cyan-400 animate-ping" />
          <span>{toastMsg}</span>
        </div>
      )}

      {isOpen && (
        <div
          className="fixed inset-0 z-[100] flex items-start justify-center bg-black/75 pt-[11vh] backdrop-blur-sm"
          onClick={closePalette}
        >
          <div
            className="w-full max-w-2xl overflow-hidden rounded-xl border border-slate-700/80 bg-[#070b14]/98 shadow-[0_24px_80px_rgba(0,0,0,0.85)]"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Live Quantitative Telemetry Header Strip */}
            {spotPrice > 0 && liveFlowSnapshot && (
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/90 bg-slate-900/70 px-4 py-2 text-[11px]">
                <div className="flex items-center gap-2">
                  <span className="font-bold text-white">{activeTicker}</span>
                  <span className="font-mono text-cyan-300">
                    ${spotPrice.toFixed(2)}
                  </span>
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                      liveFlowSnapshot.hedgingBehavior === "COUNTER_TREND_ABSORB"
                        ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"
                        : "bg-rose-500/15 text-rose-300 border border-rose-500/30"
                    }`}
                  >
                    Hedging Flow: {liveFlowSnapshot.hedgingFlowPerPtM >= 0 ? "+" : ""}
                    {liveFlowSnapshot.hedgingFlowPerPtM.toFixed(1)}M / pt
                  </span>
                </div>
                <div className="flex items-center gap-3 font-mono text-slate-300">
                  <span>
                    CoGM:{" "}
                    <strong className="text-amber-300">
                      {liveFlowSnapshot.centerOfGammaMass.toFixed(1)}
                    </strong>
                  </span>
                  <span>
                    Pin Conviction:{" "}
                    <strong className="text-cyan-300">
                      {liveFlowSnapshot.pinConvictionScore}/100
                    </strong>
                  </span>
                </div>
              </div>
            )}

            {/* Search Input */}
            <div className="flex items-center border-b border-slate-800 px-4 py-3">
              <span className="mr-3 font-mono text-sm text-cyan-400">⌘K</span>
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleInputKeyDown}
                placeholder="Type a ticker (e.g. SPY, NVDA), view (Gaia, Quad), Greek (GEX, VEX), or 'Brief'..."
                className="w-full bg-transparent text-sm text-slate-100 placeholder-slate-500 focus:outline-none"
              />
              <button
                onClick={closePalette}
                className="ml-2 rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-400 hover:text-slate-200"
              >
                ESC
              </button>
            </div>

            {/* Command List */}
            <div className="max-h-[55vh] overflow-y-auto p-2">
              {filteredCommands.length === 0 ? (
                <div className="py-8 text-center text-xs text-slate-500">
                  No matching commands or symbols found.
                </div>
              ) : (
                filteredCommands.map((cmd, idx) => {
                  const active = idx === selectedIndex;
                  return (
                    <button
                      key={cmd.id}
                      onMouseEnter={() => setSelectedIndex(idx)}
                      onClick={cmd.action}
                      className={`flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left transition-colors ${
                        active
                          ? "bg-cyan-500/15 border border-cyan-500/40"
                          : "border border-transparent hover:bg-slate-900/60"
                      }`}
                    >
                      <div className="min-w-0 flex-1 pr-3">
                        <div className="flex items-center gap-2">
                          <span
                            className={`rounded px-1.5 py-0.5 text-[9px] font-semibold tracking-wider ${
                              cmd.badgeColor ||
                              "bg-slate-800 text-slate-400 border border-slate-700"
                            }`}
                          >
                            {cmd.category}
                          </span>
                          <span className="truncate text-xs font-semibold text-slate-100">
                            {cmd.label}
                          </span>
                        </div>
                        <p className="mt-0.5 truncate text-[11px] text-slate-400">
                          {cmd.sublabel}
                        </p>
                      </div>
                      {cmd.shortcut && (
                        <kbd className="rounded border border-slate-700 bg-slate-900 px-2 py-0.5 font-mono text-[10px] text-slate-300">
                          {cmd.shortcut}
                        </kbd>
                      )}
                    </button>
                  );
                })
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between border-t border-slate-800/80 bg-slate-950 px-4 py-2 text-[10px] text-slate-500">
              <div className="flex items-center gap-3">
                <span>↑↓ Navigate</span>
                <span>↵ Execute</span>
                <span>ESC Close</span>
              </div>
              <button
                onClick={handleCopyBrief}
                className="font-medium text-amber-300 hover:underline"
              >
                ⚡ Copy Live Desk Brief
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
