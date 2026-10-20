"use client";

import React, { useEffect, useState } from "react";
import { useDashboardStore } from "@/store/useDashboardStore";
import { cn } from "@/lib/utils";

interface ScannerRow {
  t: string;
  px: number;
  king: number;
  pts: number;
  pct: number;
  xem: number;
  neg: boolean;
  str: number;
  share: number;
  base: number;
  score: number;
  rr: number;
  book?: string;
  contested?: boolean;
  moved?: boolean;
}

interface ScanSlot {
  slot: string;
  day: string;
  at: string;
  secs: number;
  credits: number;
  rows: ScannerRow[];
}

interface ScannerData {
  scans?: ScanSlot[];
  slots?: string[];
  running?: string | null;
}

const f2 = (v: number, d = 2) =>
  Number(v).toLocaleString("en-US", {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });

const sg = (v: number) =>
  (v >= 0 ? "+" : "") + f2(v, v !== 0 && Math.abs(v) < 10 ? 2 : 1);

const col = (s: number) =>
  s >= 80 ? "#facc15" : s >= 60 ? "#22d3ee" : "#94a3b8";

const hm = (k: string) => {
  const [h, m] = k.split(":").map(Number);
  return (h % 12 || 12) + ":" + String(m).padStart(2, "0") + (h < 12 ? " AM" : " PM");
};

const dayLab = (d: string) => {
  try {
    return new Date(d + "T12:00:00Z").toLocaleDateString("en-US", {
      timeZone: "UTC",
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  } catch {
    return d;
  }
};

const kind = (k: string) => (k === "15:50" ? "closing scan" : "open scan");

const whenLabel = (r?: ScanSlot) => {
  if (!r) return "";
  let t = hm(r.slot) + " ET " + kind(r.slot) + " · " + dayLab(r.day);
  if (r.secs) {
    t += " · " + (r.secs < 90 ? Math.round(r.secs) + "s" : Math.round(r.secs / 60) + " min");
  }
  return t;
};

export function ScannerView() {
  const setTicker = useDashboardStore((state) => state.setTicker);
  const setActiveView = useDashboardStore((state) => state.setActiveView);

  const [data, setData] = useState<ScannerData | null>(null);
  const [curSlot, setCurSlot] = useState<string>("15:50");
  const [isLoading, setIsLoading] = useState<boolean>(true);

  useEffect(() => {
    let active = true;
    const fetchScanner = async () => {
      try {
        const res = await fetch("/api/scanner", { cache: "no-store" });
        if (!res.ok) return;
        const j: ScannerData = await res.json();
        if (active) {
          setData(j);
          const slots = (j.scans || []).map((s) => s.slot);
          if (slots.length > 0 && !slots.includes(curSlot)) {
            setCurSlot(slots[slots.length - 1]);
          }
          setIsLoading(false);
        }
      } catch {
        if (active) setIsLoading(false);
      }
    };

    fetchScanner();
    const interval = setInterval(fetchScanner, 60000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [curSlot]);

  const activeScan = (data?.scans || []).find((s) => s.slot === curSlot) ?? data?.scans?.[0];
  const slots = (data?.scans || []).map((s) => s.slot);

  const handleCardClick = (ticker: string) => {
    setTicker(ticker);
    setActiveView("Heatmap");
  };

  return (
    <div className="max-w-[760px] w-full mx-auto space-y-3 font-sans">
      {/* Top Header */}
      <div>
        <h1 className="text-xl font-extrabold text-white tracking-tight">
          King Node Scanner
        </h1>
        <div className="text-xs text-slate-400 mt-0.5">
          {isLoading
            ? "Loading scanner…"
            : whenLabel(activeScan) || "Open scan at 9:35 AM ET. Closing scan is ready by 3:50 PM ET."}
        </div>
      </div>

      {/* Segmented Slot Toggle (.seg) */}
      {slots.length > 0 && (
        <div className="inline-flex bg-[#111827]/70 border border-slate-700/50 rounded-xl p-1 gap-1">
          {slots.map((k) => {
            const isActive = k === curSlot;
            return (
              <button
                key={k}
                type="button"
                onClick={() => setCurSlot(k)}
                className={cn(
                  "px-3 py-1 rounded-lg text-xs font-bold transition-all cursor-pointer",
                  isActive
                    ? "bg-gradient-to-r from-cyan-400 to-purple-500 text-slate-950 shadow-md font-extrabold"
                    : "text-slate-400 hover:text-white"
                )}
              >
                {k === "15:50" ? "3:50 close" : "9:35 open"}
              </button>
            );
          })}
        </div>
      )}

      {/* Hint */}
      <div className="text-[11px] text-slate-500 font-mono">
        Tap a ticker to open its heatmap
      </div>

      {/* Cards List */}
      <div className="space-y-2">
        {!activeScan || !activeScan.rows.length ? (
          <div className="bg-[#111827]/60 border border-slate-800 rounded-xl p-8 text-center text-xs text-slate-400">
            No scan yet. The open scan runs at 9:35 AM ET. The closing scan is ready by 3:50 PM ET.
          </div>
        ) : (
          activeScan.rows.map((x, i) => {
            const c = col(x.score);
            const k = x.king;
            const flag = x.contested ? " · contested" : "";

            return (
              <button
                key={x.t}
                type="button"
                onClick={() => handleCardClick(x.t)}
                className="w-full text-left block bg-[#111827]/65 hover:border-cyan-400/50 border border-slate-800/80 rounded-2xl p-3 transition-colors cursor-pointer group"
              >
                {/* Top Row: Rank, Ticker, Price, Score */}
                <div className="flex items-center gap-2">
                  <span className="text-slate-500 font-bold text-xs w-6">
                    #{i + 1}
                  </span>
                  <b className="text-base font-extrabold text-white group-hover:text-cyan-400 transition-colors">
                    {x.t}
                  </b>
                  <span className="text-slate-400 text-xs font-mono tabular-nums">
                    ${f2(x.px)}
                  </span>
                  <div className="flex-1" />
                  <span
                    style={{
                      color: c,
                      borderColor: `${c}55`,
                      backgroundColor: `${c}1a`,
                    }}
                    className="border rounded-full px-2.5 py-0.5 text-xs font-extrabold font-mono"
                  >
                    {x.score}
                  </span>
                </div>

                {/* 3-Column Metrics Grid */}
                <div className="grid grid-cols-[0.7fr_1.3fr_1fr] gap-1.5 my-2 text-xs font-mono">
                  {/* Col 1: King */}
                  <div>
                    <small className="block text-[10px] text-slate-500 uppercase tracking-wider font-semibold">
                      King
                    </small>
                    <span className="text-[#facc15] font-extrabold text-[13px] drop-shadow-[0_0_8px_rgba(250,204,21,0.5)]">
                      {k % 1 !== 0 ? f2(k, 1) : k}
                      {flag}
                    </span>
                    {x.book && (
                      <small className="block text-[9.5px] text-slate-500 lowercase mt-0.5">
                        {x.book}
                      </small>
                    )}
                    {x.moved && (
                      <small className="block text-[9.5px] text-slate-400 font-semibold">
                        King moved
                      </small>
                    )}
                  </div>

                  {/* Col 2: Distance */}
                  <div>
                    <small className="block text-[10px] text-slate-500 uppercase tracking-wider font-semibold">
                      Distance
                    </small>
                    <span className="text-slate-200 tabular-nums">
                      {sg(x.pct).replace(/(\.\d)\d$/, "$1")}% · {sg(x.pts)} pts
                    </span>
                  </div>

                  {/* Col 3: vs EM */}
                  <div>
                    <small className="block text-[10px] text-slate-500 uppercase tracking-wider font-semibold">
                      vs EM
                    </small>
                    <span className="text-slate-200 tabular-nums">
                      {x.xem != null ? `${f2(x.xem, 1)}× daily EM` : "–"}
                    </span>
                  </div>
                </div>

                {/* Bottom Row: Regime, Strength Label, Progress Bar */}
                <div className="flex items-center gap-2 pt-1 border-t border-slate-800/40 font-mono">
                  <span
                    className={cn(
                      "text-[10px] font-bold px-2 py-0.5 rounded-full whitespace-nowrap",
                      x.neg
                        ? "text-[#c084fc] bg-purple-500/15"
                        : "text-[#22d3ee] bg-cyan-500/12"
                    )}
                  >
                    {x.neg ? "Negative" : "Positive"} γ
                  </span>
                  <span className="text-slate-500 text-[10px] whitespace-nowrap">
                    King strength
                  </span>
                  <div className="flex-1 h-1.5 rounded-full bg-slate-800 overflow-hidden">
                    <div
                      style={{ width: `${Math.max(3, x.str)}%` }}
                      className="h-full rounded-full bg-gradient-to-r from-[#fdca26] to-[#facc15]"
                    />
                  </div>
                </div>
              </button>
            );
          })
        )}
      </div>

      {/* Footer Glossary (.leg) */}
      <div className="text-xs text-slate-400 bg-[#111827]/50 border border-slate-800 rounded-xl p-3 leading-relaxed space-y-1.5 font-sans">
        <div>
          <b className="text-white">King</b> – the all-expirations King, the strike with the largest total gamma. It tends to pull price toward it.{" "}
          <b className="text-white">contested</b> means the next strike is within about 10%.
        </div>
        <div>
          <b className="text-white">Book</b> – when that row&apos;s book was taken.
        </div>
        <div>
          <b className="text-white">King moved</b> – a newer book changed the all-expirations King, so the row was rescored or flagged.
        </div>
        <div>
          <b className="text-white">Distance</b> – how far the King is from the price now.
        </div>
        <div>
          <b className="text-white">vs EM</b> – that distance compared with today&apos;s expected move.
        </div>
        <div>
          <b className="text-white">Gamma regime</b> – Negative γ means bigger moves; Positive γ means calmer, pinned trading.
        </div>
        <div>
          <b className="text-white">King strength</b> – how much the King stands out from the next-biggest strike.
        </div>
        <div>
          <b className="text-white">Pull score</b> – a 0–100 ranking of how strong the pull to the King looks. It&apos;s a ranking, not a prediction.
        </div>
      </div>
    </div>
  );
}
