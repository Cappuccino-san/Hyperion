"use client";

import React, { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ExposureMetric,
  getStaticTickerPreset,
  useDashboardStore,
} from "@/store/useDashboardStore";
import { OptionsAnalyticsPayload } from "@/lib/optionsExposure";
import { getTodayEt } from "@/lib/gaiaSessionGuards";
import { cn } from "@/lib/utils";

const QUAD_TICKERS = ["SPY", "QQQ", "SPXW", "IWM"] as const;
const METRICS: ExposureMetric[] = ["GEX", "VEX", "DEX", "Charm"];

const QNEG: [number, number, number][] = [
  [22, 28, 56],
  [76, 36, 138],
  [147, 51, 234],
];
const QPOS: [number, number, number][] = [
  [14, 46, 44],
  [13, 138, 108],
  [34, 211, 238],
];

function quadColor(val: number, maxAbs: number): { rgb: [number, number, number]; textColor: string } {
  if (!(maxAbs > 0) || Math.abs(val) < 1) {
    return { rgb: [15, 23, 42], textColor: "#64748b" };
  }
  const norm = Math.min(1, Math.abs(val) / maxAbs);
  const d = 0.14 + 0.86 * Math.pow(norm, 1.45);
  const stops = val >= 0 ? QPOS : QNEG;
  const scaled = Math.max(0, Math.min(1, d)) * 2;
  const i = Math.min(1, Math.floor(scaled));
  const f = scaled - i;
  const a = stops[i];
  const b = stops[i + 1];
  const rgb: [number, number, number] = [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
  return { rgb, textColor: val >= 0 && d > 0.78 ? "#06101c" : "#e6edf6" };
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
  const router = useRouter();
  const activeTicker = useDashboardStore((state) => state.activeTicker);
  const metric = useDashboardStore((state) => state.gridFilters.metric);
  const globalExpFilter = useDashboardStore(
    (state) => state.gridFilters.expiration
  );
  const setFilters = useDashboardStore((state) => state.setFilters);
  const setTicker = useDashboardStore((state) => state.setTicker);
  const setActiveView = useDashboardStore((state) => state.setActiveView);
  const serverActivePositions = useDashboardStore((state) => state.serverActivePositions);

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

  useEffect(() => {
    let active = true;
    const inFlightByTicker = new Map<string, AbortController>();

    const fetchTicker = async (sym: string) => {
      if (!active || inFlightByTicker.has(sym)) return;
      const controller = new AbortController();
      inFlightByTicker.set(sym, controller);
      const timeoutId = setTimeout(() => controller.abort(), 15000);
      try {
        const res = await fetch(`/api/options?ticker=${sym}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!res.ok || !active || controller.signal.aborted) return;
        const data: OptionsAnalyticsPayload = await res.json();
        if (active && !controller.signal.aborted) {
          setQuadPayloads((prev) => ({ ...prev, [sym]: data }));
        }
      } catch {
        // Fallback handled gracefully
      } finally {
        clearTimeout(timeoutId);
        if (inFlightByTicker.get(sym) === controller) {
          inFlightByTicker.delete(sym);
        }
      }
    };

    const runFetch = () => {
      if (
        !active ||
        (typeof document !== "undefined" && document.visibilityState !== "visible")
      ) {
        return;
      }
      QUAD_TICKERS.forEach((sym) => {
        void fetchTicker(sym);
      });
    };

    runFetch();
    const interval = setInterval(runFetch, 15000);
    return () => {
      active = false;
      inFlightByTicker.forEach((ctrl) => ctrl.abort());
      inFlightByTicker.clear();
      clearInterval(interval);
    };
  }, []);

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
    const todayEt = getTodayEt();
    return first.isoDate.slice(0, 10) === todayEt ? "0DTE" : "Next exp";
  };

  const activeQuadSym = (QUAD_TICKERS as readonly string[]).includes(
    activeTicker.toUpperCase()
  )
    ? activeTicker.toUpperCase()
    : "SPY";
  const nearExpBadge = getNearExpLabel(
    quadPayloads[activeQuadSym] ?? quadPayloads["SPY"]
  );

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
          Quad Index Matrix · Tap any card header to open Gaia Flow &amp; GEX chart
        </span>
      </div>

      {/* 4-Column Grid for SPY, QQQ, SPXW, and IWM */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
        {QUAD_TICKERS.map((sym) => {
          const payload = quadPayloads[sym];
          const preset = getStaticTickerPreset(sym);
          const spot = payload?.spotPrice ?? preset.spotPrice;
          const prevClose = payload?.previousClose ?? preset.previousClose;
          const pctChange =
            prevClose > 0 ? ((spot - prevClose) / prevClose) * 100 : 0;
          const isPosChange = pctChange >= 0;
          const cardSel = cardHorizons[sym] ?? "";
          const effectiveHorizon = cardSel === "" ? globalExpFilter : cardSel;

          const fallbackAllExpKing =
            payload?.kingNode.allExpKing ?? preset.kingPreset.allExpKing;
          const contested = payload?.kingNode.isContested ?? false;

          // Determine columns to sum
          const allExps = payload?.expirations ?? [];
          let colsToSum = allExps;
          if (effectiveHorizon === "0DTE") {
            const alive = allExps.filter((e) =>
              isAliveExpiration(e.isoDate)
            );
            colsToSum = alive.length > 0 ? [alive[0]] : colsToSum.slice(0, 1);
          } else if (effectiveHorizon === "THIS_WEEK") {
            const wk = allExps.filter(
              (e) =>
                e.inThisWeek !== undefined
                  ? e.inThisWeek
                  : e.filterGroup === "0DTE" || e.filterGroup === "THIS_WEEK"
            );
            colsToSum = wk.length > 0 ? wk : allExps.slice(0, Math.min(5, allExps.length));
          } else if (effectiveHorizon !== "ALL") {
            const matched = allExps.filter(
              (e) => e.isoDate === effectiveHorizon || e.dateLabel === effectiveHorizon
            );
            colsToSum = matched.length > 0 ? matched : allExps;
          }

          // Generate ladder strikes and dynamically compute activeKing & allExpKing for the selected metric
          const strikesData = payload?.strikes ?? [];
          let computedAllKing = fallbackAllExpKing;
          let maxAllAbs = -1;
          let computedActiveKing = fallbackAllExpKing;
          let maxActiveAbs = -1;
          let peakActiveExpIso = colsToSum[0]?.isoDate ?? "";

          const rows = strikesData
            .map((sRow) => {
              if (!Number.isFinite(sRow.strike)) return null;
              const map =
                metric === "GEX"
                  ? sRow.gex
                  : metric === "VEX"
                    ? sRow.vex
                    : metric === "DEX"
                      ? sRow.dex
                      : sRow.charm;

              const allVal = allExps.reduce((acc, c) => {
                const raw = map?.[c.id] ?? 0;
                return acc + (Number.isFinite(raw) ? raw : 0);
              }, 0);
              if (Math.abs(allVal) > maxAllAbs) {
                maxAllAbs = Math.abs(allVal);
                computedAllKing = sRow.strike;
              }

              let sumVal = 0;
              let rowPeakColAbs = -1;
              let rowPeakIso = colsToSum[0]?.isoDate ?? "";
              for (const c of colsToSum) {
                const raw = map?.[c.id] ?? 0;
                const v = Number.isFinite(raw) ? raw : 0;
                sumVal += v;
                if (Math.abs(v) > rowPeakColAbs) {
                  rowPeakColAbs = Math.abs(v);
                  rowPeakIso = c.isoDate;
                }
              }
              if (Math.abs(sumVal) > maxActiveAbs) {
                maxActiveAbs = Math.abs(sumVal);
                computedActiveKing = sRow.strike;
                peakActiveExpIso = rowPeakIso;
              }

              // Compute open pct
              let pct: number | null = null;
              if (metric === "GEX" && sRow.openPctChange) {
                let sumPct = 0;
                let count = 0;
                colsToSum.forEach((c) => {
                  const o = sRow.openPctChange[c.id];
                  if (o != null && Number.isFinite(o) && o !== 0) {
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
            })
            .filter(
              (r): r is { strike: number; val: number; pct: number | null } =>
                r !== null && Number.isFinite(r.strike) && Number.isFinite(r.val)
            );

          const allExpKing = maxAllAbs > 0 ? computedAllKing : fallbackAllExpKing;
          let activeKing = maxActiveAbs > 0 ? computedActiveKing : allExpKing;
          let activeExpDate = peakActiveExpIso;

          if (maxActiveAbs <= 0) {
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
          }

          // Format structured King metadata (safe JSX, zero dangerouslySetInnerHTML)
          const nearLabel = getNearExpLabel(payload);
          const horizonKingPrefix =
            effectiveHorizon === "0DTE"
              ? `${nearLabel} King`
              : effectiveHorizon === "THIS_WEEK"
                ? "Week King"
                : `${effectiveHorizon.slice(5)} King`;
          const horizonKingDay = activeExpDate ? ` (${activeExpDate.slice(5)})` : "";

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
          const isIndex = new Set<string>(["SPXW", "SPX", "NDX", "NDXP"]).has(sym);
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
                      setActiveView("Gaia");
                      router.push(`/gaia?ticker=${encodeURIComponent(sym)}`);
                    }}
                    className="flex items-baseline gap-2 text-left group cursor-pointer"
                  >
                    <b className="text-sm font-extrabold text-white group-hover:text-cyan-400 transition-colors">
                      {sym}
                    </b>
                    {serverActivePositions?.[sym] && (
                      <span
                        className={cn(
                          "text-[9px] font-mono px-1.5 py-0.5 rounded border uppercase tracking-wider font-extrabold animate-pulse",
                          serverActivePositions[sym]?.contractType === "CALL"
                            ? "bg-emerald-500/15 text-emerald-300 border-emerald-400/40"
                            : "bg-purple-500/15 text-purple-300 border-purple-400/40"
                        )}
                        title={`Active ${serverActivePositions[sym]?.contractType} Position`}
                      >
                        {serverActivePositions[sym]?.contractType} ${serverActivePositions[sym]?.strike}
                      </span>
                    )}
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
                  <div className="flex items-center gap-1.5 text-[10.5px] font-mono tabular-nums text-slate-400 leading-tight">
                    {ext.type === "pre" ? (
                      <span className="text-[#facc15]" title="Pre-market">
                        ☀
                      </span>
                    ) : (
                      <span className="text-[#c4b5fd]" title="After hours">
                        ☾
                      </span>
                    )}
                    <b className="text-white font-bold tabular-nums">
                      ${ext.price.toFixed(2)}
                    </b>
                    <span className={cn("tabular-nums", isExtUp ? "text-emerald-400" : "text-rose-400")}>
                      {isExtUp ? "+" : ""}
                      {extDiff.toFixed(2)} ({isExtUp ? "+" : ""}
                      {extPct.toFixed(2)}%)
                    </span>
                  </div>
                )}

                {/* Expiration Select Dropdown */}
                <select
                  id={`quad-exp-${sym.toLowerCase()}`}
                  name={`quadExp_${sym}`}
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
                        : nearLabel}
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

                {/* King line (.k) — safe React JSX with tabular-nums */}
                <div className="text-[10px] text-slate-300 leading-snug break-words font-mono tabular-nums">
                  {effectiveHorizon !== "ALL" && (
                    <>
                      <span>{horizonKingPrefix} </span>
                      <b className="text-[#facc15] font-bold">{activeKing}</b>
                      <span>{horizonKingDay} · </span>
                    </>
                  )}
                  <span>All-exp King </span>
                  <b className="text-[#facc15] font-bold">{allExpKing}</b>
                  {contested && <span> · contested</span>}
                </div>
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
                    const dailyEm = payload?.expectedMoves?.daily?.em ?? 0;
                    const isOutsideTwoSigma =
                      !isKing && !isSpot && dailyEm > 0 && Math.abs(r.strike - spot) > dailyEm * 2;
                    const { rgb, textColor } = quadColor(r.val, maxVal);

                    return (
                      <div
                        key={r.strike}
                        className={cn(
                          "flex h-[32px] items-stretch text-[11px] font-mono tabular-nums relative",
                          isKing && "z-10",
                          isOutsideTwoSigma && "opacity-35"
                        )}
                      >
                        {/* Left Strike Box (.s) */}
                        <div
                          className={cn(
                            "w-[50px] flex-none flex items-center justify-center font-bold text-[10.5px] border-r border-slate-900/60 select-none tabular-nums",
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
                            "flex-1 relative flex items-center justify-between gap-1.5 px-2 font-semibold border-b border-black/20",
                            isKing && "font-extrabold"
                          )}
                        >
                          {/* Star symbol for King */}
                          <span className="text-xs shrink-0">
                            {isKing ? "★" : ""}
                          </span>

                          {/* Right-aligned inline delta badge + Exposure value (zero overlap) */}
                          <div className="flex items-center gap-1.5 ml-auto min-w-0">
                            {metric === "GEX" && r.pct != null && (
                              <span
                                className={cn(
                                  "text-[8.5px] font-extrabold px-1 py-0.5 rounded bg-black/75 leading-none tabular-nums shrink-0",
                                  r.pct >= 0 ? "text-[#4ade80]" : "text-[#f87171]"
                                )}
                              >
                                {r.pct >= 0 ? "+" : ""}
                                {Math.round(r.pct)}%
                              </span>
                            )}
                            <span className="text-[11px] tabular-nums whitespace-nowrap">
                              {Math.abs(r.val) < 1 ? "–" : formatMoney(r.val)}
                            </span>
                          </div>
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
