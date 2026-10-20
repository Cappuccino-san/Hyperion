"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ExposureMetric,
  getTickerPreset,
  useDashboardStore,
} from "@/store/useDashboardStore";
import { OptionsAnalyticsPayload } from "@/lib/optionsExposure";
import { cn } from "@/lib/utils";

const QUAD_TICKERS = ["SPY", "QQQ", "SPXW", "IWM"] as const;
const METRICS: ExposureMetric[] = ["GEX", "VEX", "DEX", "Charm"];

const VIR: [number, number, number][] = [
  [68, 1, 84],
  [59, 82, 139],
  [33, 145, 140],
  [94, 201, 98],
  [253, 231, 37],
];

function vir(t: number): [number, number, number] {
  const clamped = Math.max(0, Math.min(1, t)) * 4;
  const i = Math.min(3, Math.floor(clamped));
  const f = clamped - i;
  const a = VIR[i];
  const b = VIR[i + 1];
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

function formatMoney(v: number): string {
  const a = Math.abs(v);
  const s = v < 0 ? "-" : "";
  if (a >= 1e9) return s + "$" + (a / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return s + "$" + (a / 1e6).toFixed(1) + "M";
  if (a >= 1e3) return s + "$" + (a / 1e3).toFixed(0) + "K";
  return s + "$" + a.toFixed(0);
}

function isAliveExpiration(isoDate: string): boolean {
  const now = Date.now();
  const t = Date.parse(isoDate.slice(0, 10) + "T20:00:00Z");
  return !isNaN(t) && t > now;
}

export function QuadView() {
  const metric = useDashboardStore((state) => state.gridFilters.metric);
  const globalExpFilter = useDashboardStore(
    (state) => state.gridFilters.expiration
  );
  const setFilters = useDashboardStore((state) => state.setFilters);
  const setTicker = useDashboardStore((state) => state.setTicker);
  const setActiveView = useDashboardStore((state) => state.setActiveView);

  const [quadPayloads, setQuadPayloads] = useState<
    Record<string, OptionsAnalyticsPayload>
  >({});
  const [cardHorizons, setCardHorizons] = useState<
    Record<string, string>
  >({
    SPY: "",
    QQQ: "",
    SPXW: "",
    IWM: "",
  });

  const scrollContainers = useRef<Record<string, HTMLDivElement | null>>({});
  const hasCentered = useRef<Record<string, boolean>>({});

  const fetchQuadData = useCallback(() => {
    let active = true;
    QUAD_TICKERS.forEach(async (sym) => {
      try {
        const res = await fetch(`/api/options?ticker=${sym}`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const data: OptionsAnalyticsPayload = await res.json();
        if (active) {
          setQuadPayloads((prev) => ({ ...prev, [sym]: data }));
        }
      } catch {
        // Fallback handled gracefully
      }
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const cleanup = fetchQuadData();
    const interval = setInterval(fetchQuadData, 5000);
    return () => {
      cleanup();
      clearInterval(interval);
    };
  }, [fetchQuadData]);

  // Auto-center spot row in each ladder
  useEffect(() => {
    QUAD_TICKERS.forEach((sym) => {
      if (hasCentered.current[sym]) return;
      const container = scrollContainers.current[sym];
      if (!container) return;
      const spotRow = container.querySelector(".s-spot") as HTMLElement | null;
      if (spotRow && spotRow.parentElement) {
        const row = spotRow.parentElement;
        container.scrollTop =
          row.offsetTop -
          container.offsetTop -
          container.clientHeight / 2 +
          row.offsetHeight / 2;
        hasCentered.current[sym] = true;
      }
    });
  }, [quadPayloads]);

  const syncGlobalHorizon = (horizon: "ALL" | "0DTE" | "THIS_WEEK") => {
    setFilters({ expiration: horizon });
  };

  const getNearExpLabel = (payload?: OptionsAnalyticsPayload) => {
    if (!payload || !payload.expirations.length) return "0DTE";
    const alive = payload.expirations.filter((e) => isAliveExpiration(e.isoDate));
    const first = alive.length > 0 ? alive[0] : payload.expirations[0];
    const todayEt = new Date().toLocaleDateString("en-CA", {
      timeZone: "America/New_York",
    });
    return first.isoDate.slice(0, 10) === todayEt ? "0DTE" : "Next exp";
  };

  const spyPayload = quadPayloads["SPY"];
  const nearExpBadge = getNearExpLabel(spyPayload);

  return (
    <div className="space-y-3 max-w-[1200px] mx-auto">
      {/* Top Filter Bar */}
      <div className="bg-[#111827]/70 border border-slate-700/50 rounded-xl p-2.5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {/* [GEX | VEX | DEX | Charm] */}
          <div className="inline-flex items-center rounded-full bg-[#0b1220] p-0.5 border border-slate-700/60">
            {METRICS.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setFilters({ metric: m })}
                className={cn(
                  "px-3 py-1 rounded-full text-xs font-mono font-bold transition-all cursor-pointer",
                  metric === m
                    ? "bg-gradient-to-r from-cyan-500/25 to-purple-600/30 text-white shadow-[inset_0_0_0_1px_rgba(34,211,238,0.4)]"
                    : "text-slate-400 hover:text-white"
                )}
              >
                {m}
              </button>
            ))}
          </div>

          {/* [All exp | This week | 0DTE/Next exp] */}
          <div className="inline-flex items-center rounded-full bg-[#0b1220] p-0.5 border border-slate-700/60">
            {(
              [
                { value: "ALL", label: "All exp" },
                { value: "THIS_WEEK", label: "This week" },
                { value: "0DTE", label: nearExpBadge },
              ] as const
            ).map((h) => (
              <button
                key={h.value}
                type="button"
                onClick={() => syncGlobalHorizon(h.value)}
                className={cn(
                  "px-3 py-1 rounded-full text-xs font-mono font-semibold transition-all cursor-pointer",
                  globalExpFilter === h.value
                    ? "bg-gradient-to-r from-cyan-500/25 to-purple-600/30 text-white shadow-[inset_0_0_0_1px_rgba(34,211,238,0.4)]"
                    : "text-slate-400 hover:text-white"
                )}
              >
                {h.label}
              </button>
            ))}
          </div>
        </div>

        <span className="text-xs font-mono text-slate-400 hidden sm:inline">
          Quad Index Matrix · Tap any card header to open full Heatmap
        </span>
      </div>

      {/* 4-Column Grid for SPY, QQQ, SPXW, and IWM */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
        {QUAD_TICKERS.map((sym) => {
          const payload = quadPayloads[sym];
          const preset = getTickerPreset(sym);
          const spot = payload?.spotPrice ?? preset.spotPrice;
          const prevClose = payload?.previousClose ?? preset.previousClose;
          const pctChange =
            prevClose > 0 ? ((spot - prevClose) / prevClose) * 100 : 0;
          const isPosChange = pctChange >= 0;
          const cardSel = cardHorizons[sym] ?? "";
          const effectiveHorizon = cardSel === "" ? globalExpFilter : cardSel;

          const allExpKing =
            payload?.kingNode.allExpKing ?? preset.kingPreset.allExpKing;
          const contested = payload?.kingNode.isContested ?? false;

          let activeKing = allExpKing;
          let activeExpDate = "";
          if (effectiveHorizon === "0DTE") {
            activeKing =
              payload?.kingByFilter["0DTE"].strike ??
              preset.kingPreset.zeroDteKing;
            activeExpDate = payload?.kingByFilter["0DTE"].exp ?? "";
          } else if (effectiveHorizon === "THIS_WEEK") {
            activeKing =
              payload?.kingByFilter.THIS_WEEK.strike ??
              preset.kingPreset.weeklyKing;
            activeExpDate =
              payload?.kingByFilter.THIS_WEEK.exp ?? "";
          } else if (effectiveHorizon !== "ALL") {
            const filterKing = (payload?.kingByFilter as Record<string, { strike: number; label: string; exp?: string } | undefined>)?.[effectiveHorizon];
            activeKing = filterKing?.strike ?? allExpKing;
            activeExpDate = effectiveHorizon;
          }

          // Format king phrase
          const nearLabel = getNearExpLabel(payload);
          let kingPhrase = `All-exp King <b>${allExpKing}</b>${contested ? " · contested" : ""}`;
          if (effectiveHorizon !== "ALL") {
            const pre =
              effectiveHorizon === "0DTE"
                ? `${nearLabel} King`
                : effectiveHorizon === "THIS_WEEK"
                  ? "Week King"
                  : `${effectiveHorizon.slice(5)} King`;
            const day = activeExpDate ? ` (${activeExpDate.slice(5)})` : "";
            kingPhrase = `${pre} <b>${activeKing}</b>${day} · ${kingPhrase}`;
          }

          // Determine columns to sum
          let colsToSum = payload?.expirations ?? [];
          if (effectiveHorizon === "0DTE") {
            const alive = (payload?.expirations ?? []).filter((e) =>
              isAliveExpiration(e.isoDate)
            );
            colsToSum = alive.length > 0 ? [alive[0]] : colsToSum.slice(0, 1);
          } else if (effectiveHorizon === "THIS_WEEK") {
            colsToSum = (payload?.expirations ?? []).filter(
              (e) => e.filterGroup === "THIS_WEEK"
            );
          } else if (effectiveHorizon !== "ALL") {
            colsToSum = (payload?.expirations ?? []).filter(
              (e) => e.isoDate === effectiveHorizon
            );
          }

          // Generate ladder strikes
          const strikesData = payload?.strikes ?? [];
          const rows = strikesData.map((sRow) => {
            const map =
              metric === "GEX"
                ? sRow.gex
                : metric === "VEX"
                  ? sRow.vex
                  : metric === "DEX"
                    ? sRow.dex
                    : sRow.charm;

            const sumVal = colsToSum.reduce(
              (acc, c) => acc + (map[c.id] ?? 0),
              0
            );

            // Compute open pct
            let pct: number | null = null;
            if (metric === "GEX" && sRow.openPctChange) {
              let sumPct = 0;
              let count = 0;
              colsToSum.forEach((c) => {
                const o = sRow.openPctChange[c.id];
                if (o != null && o !== 0) {
                  sumPct += o;
                  count++;
                }
              });
              if (count > 0) {
                pct = sumPct / count;
              }
            }

            return {
              strike: sRow.strike,
              val: sumVal,
              pct,
            };
          });

          // Sort strikes descending (high to low)
          rows.sort((a, b) => b.strike - a.strike);

          const maxVal = Math.max(
            1,
            ...rows.map((r) => Math.abs(r.val))
          );

          // Find spot index
          let spotStrike = spot;
          let bestDiff = Infinity;
          rows.forEach((r) => {
            const d = Math.abs(r.strike - spot);
            if (d < bestDiff) {
              bestDiff = d;
              spotStrike = r.strike;
            }
          });

          // Pre-market / After-hours quote
          const ext = payload?.extendedQuote;
          const isIndex = sym === "SPXW";
          const hasExt = !isIndex && !!ext && ext.price > 0;
          const extDiff = hasExt && ext ? ext.price - spot : 0;
          const extPct = hasExt && spot > 0 && ext ? (extDiff / spot) * 100 : 0;
          const isExtUp = extDiff >= 0;

          // Expiration dropdown options
          const cy = String(new Date().getFullYear());
          const expFormat = (d: string) =>
            d.slice(0, 4) === cy ? d.slice(5) : d.slice(5) + "-" + d.slice(2, 4);

          const aliveExps = (payload?.expirations ?? []).filter((e) =>
            isAliveExpiration(e.isoDate)
          );
          const frontExp = aliveExps[0]?.isoDate;

          return (
            <div
              key={sym}
              className="bg-[#0b1220]/80 border border-slate-800 rounded-xl flex flex-col overflow-hidden shadow-lg backdrop-blur-md"
            >
              {/* Card Header (.qh) */}
              <div className="p-2.5 border-b border-slate-800/80 bg-[#0e1726]/60 space-y-1.5">
                <div className="flex items-baseline justify-between gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      setTicker(sym);
                      setActiveView("Heatmap");
                    }}
                    className="flex items-baseline gap-2 text-left group cursor-pointer"
                  >
                    <b className="text-sm font-extrabold text-white group-hover:text-cyan-400 transition-colors">
                      {sym}
                    </b>
                    <span className="font-mono text-[13px] font-bold text-slate-100 tabular-nums">
                      ${spot.toFixed(2)}
                    </span>
                    <small
                      className={cn(
                        "font-mono text-[11px] font-semibold tabular-nums",
                        isPosChange ? "text-emerald-400" : "text-rose-400"
                      )}
                    >
                      {isPosChange ? "+" : ""}
                      {pctChange.toFixed(2)}%
                    </small>
                  </button>
                </div>

                {/* Extended Hours Sun/Moon Row (.ext) */}
                {hasExt && ext && (
                  <div className="flex items-center gap-1.5 text-[10.5px] font-mono text-slate-400 leading-tight">
                    {ext.type === "pre" ? (
                      <span className="text-[#facc15]" title="Pre-market">
                        ☀
                      </span>
                    ) : (
                      <span className="text-[#c4b5fd]" title="After hours">
                        ☾
                      </span>
                    )}
                    <b className="text-white font-bold">
                      ${ext.price.toFixed(2)}
                    </b>
                    <span className={isExtUp ? "text-emerald-400" : "text-rose-400"}>
                      {isExtUp ? "+" : ""}
                      {extDiff.toFixed(2)} ({isExtUp ? "+" : ""}
                      {extPct.toFixed(2)}%)
                    </span>
                  </div>
                )}

                {/* Expiration Select Dropdown */}
                <select
                  aria-label={`${sym} Expiration`}
                  value={cardSel}
                  onChange={(e) =>
                    setCardHorizons((prev) => ({
                      ...prev,
                      [sym]: e.target.value,
                    }))
                  }
                  className="w-full bg-[#0f172a]/90 text-slate-300 border border-slate-700/60 rounded-md px-2 py-1 text-[11px] font-mono focus:outline-none focus:border-cyan-400 cursor-pointer"
                >
                  <option value="">
                    Global (
                    {globalExpFilter === "ALL"
                      ? "All exp"
                      : globalExpFilter === "THIS_WEEK"
                        ? "This week"
                        : nearExpBadge}
                    )
                  </option>
                  <option value="ALL">All expirations</option>
                  <option value="THIS_WEEK">This week</option>
                  <option value="0DTE">
                    0DTE · {frontExp ? expFormat(frontExp) : "–"}
                  </option>
                  {aliveExps.map((e) => (
                    <option key={e.isoDate} value={e.isoDate}>
                      {expFormat(e.isoDate)}
                    </option>
                  ))}
                </select>

                {/* King line (.k) */}
                <div
                  className="text-[10px] text-slate-300 leading-snug break-words"
                  dangerouslySetInnerHTML={{ __html: kingPhrase }}
                />
              </div>

              {/* Scrollable Strike Ladder (.qs) */}
              <div
                ref={(el) => {
                  scrollContainers.current[sym] = el;
                }}
                className="overflow-y-auto overflow-x-hidden h-[calc(100vh-320px)] min-h-[380px] divide-y divide-slate-900/40 bg-[#080d1a] custom-thin-scrollbar"
              >
                {rows.length === 0 ? (
                  <div className="p-8 text-center text-xs text-slate-500">
                    Loading ladder…
                  </div>
                ) : (
                  rows.map((r) => {
                    const isKing = r.strike === activeKing;
                    const isSpot = r.strike === spotStrike;
                    const tone = (r.val / maxVal + 1) / 2;
                    const rgb = vir(tone);
                    const textColor = tone > 0.62 ? "#0b1220" : "#e6edf6";

                    return (
                      <div
                        key={r.strike}
                        className={cn(
                          "flex h-[32px] items-stretch text-[11px] font-mono tabular-nums relative",
                          isKing && "z-10"
                        )}
                      >
                        {/* Left Strike Box (.s) */}
                        <div
                          className={cn(
                            "w-[50px] flex-none flex items-center justify-center font-bold text-[10.5px] border-r border-slate-900/60 select-none",
                            isSpot
                              ? "s-spot bg-[#13254a] text-[#60a5fa] shadow-[inset_4px_0_0_#3b82f6]"
                              : "bg-[#0b1220] text-slate-400"
                          )}
                        >
                          {r.strike}
                        </div>

                        {/* Right Value Box (.v) */}
                        <div
                          style={
                            isKing
                              ? {
                                  backgroundColor: "#facc15",
                                  color: "#000000",
                                  boxShadow:
                                    "0 0 0 1px #facc15, 0 0 8px 1px rgba(250,204,21,.8)",
                                }
                              : {
                                  backgroundColor: `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`,
                                  color: textColor,
                                }
                          }
                          className={cn(
                            "flex-1 relative flex items-center justify-between px-2 font-semibold border-b border-black/20",
                            isKing && "font-extrabold"
                          )}
                        >
                          {/* Star symbol for King */}
                          <span className="text-xs">
                            {isKing ? "★" : ""}
                          </span>

                          {/* Delta % badge when GEX */}
                          {metric === "GEX" && r.pct != null && (
                            <span
                              className={cn(
                                "text-[7.5px] font-extrabold px-1 py-0.5 rounded bg-black/80 leading-none absolute top-1 right-2",
                                r.pct >= 0 ? "text-[#4ade80]" : "text-[#f87171]"
                              )}
                            >
                              {r.pct >= 0 ? "+" : ""}
                              {Math.round(r.pct)}%
                            </span>
                          )}

                          {/* Formatted Exposure Value */}
                          <span className="text-[11px] ml-auto">
                            {Math.abs(r.val) < 1 ? "–" : formatMoney(r.val)}
                          </span>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
