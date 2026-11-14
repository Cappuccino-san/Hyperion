"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useDashboardStore } from "@/store/useDashboardStore";
import { cn } from "@/lib/utils";

const MAIN = ["SPY", "QQQ", "SPXW", "NDXP", "IWM"];

interface RecapNode {
  [key: string]: any;
}

interface RecapTicker {
  label: string;
  symbol: string;
  as_of?: string;
  chain_as_of?: string;
  prev_close: number;
  open: number | null;
  close: number;
  session?: {
    tracked: boolean;
    first_ts?: number | null;
    gk?: { start: number | null; end: number | null; moves: number | null };
    vk?: { start: number | null; end: number | null; moves: number | null };
    cw?: { open: number | null; close: number | null; moves: number | null };
    pw?: { open: number | null; close: number | null; moves: number | null };
    zg?: { open: number | null; close: number | null };
  };
  next?: {
    date: string;
    gk?: [number, number];
    vk?: [number, number];
    cw?: number | null;
    pw?: number | null;
    zg?: number | null;
    nodes?: {
      above_pos?: [number, number] | null;
      above_neg?: [number, number] | null;
      below_pos?: [number, number] | null;
      below_neg?: [number, number] | null;
    };
    em?: {
      exp: string;
      atm: number;
      move: number;
      low: number;
      high: number;
    };
  };
}

interface PortfolioTradeRow {
  id: string;
  date: string;
  ticker: string;
  contractType: "CALL" | "PUT";
  contractLabel: string;
  setupName: string;
  openedAt: string;
  closedAt: string;
  entryOptionPrice: number;
  exitOptionPrice: number;
  contractsQty: number;
  outlay: number;
  realizedDollarPnl: number;
  pnlOptionPct: number;
  rMultiple: number;
  exitReason: string;
}

interface PortfolioSummary {
  windowDays: number;
  daysWithTrades: string[];
  totalTrades: number;
  wins: number;
  losses: number;
  breakevens: number;
  winRatePct: number;
  cumulativeDollarPnl: number;
  totalCapitalOutlay: number;
  profitFactor: number | null;
  maxDrawdown: number;
  expectancyR: number;
  rDistribution: Array<{ label: string; count: number }>;
  equityCurve: Array<{
    index: number;
    date: string;
    ticker: string;
    contractLabel: string;
    tradePnl: number;
    equity: number;
    rMultiple: number;
  }>;
  dailyBreakdown: Array<{
    date: string;
    trades: number;
    wins: number;
    losses: number;
    netDollarPnl: number;
    equityAfter: number;
  }>;
  trades: PortfolioTradeRow[];
}

interface RecapPayload {
  days?: string[];
  day?: string;
  today_pending?: boolean;
  session_open?: boolean;
  portfolio?: PortfolioSummary;
  recap?: {
    day: string;
    built_at: number;
    next_date: string;
    tickers: RecapTicker[];
    missing?: string[];
    partial?: any[];
  };
}

const num = (v: any) => (v == null || v === "" ? "—" : String(v));

const fmt = (v: number | null | undefined) => {
  if (v == null) return "—";
  const a = Math.abs(v);
  const s = v < 0 ? "-" : "+";
  if (a >= 1e9) return s + "$" + (a / 1e9).toFixed(2) + "B";
  if (a >= 1e6) {
    const n = a / 1e6;
    return s + "$" + (n >= 10 ? Math.round(n) : n.toFixed(1)) + "M";
  }
  if (a >= 1e3) {
    const n = a / 1e3;
    return s + "$" + (n >= 10 ? Math.round(n) : n.toFixed(1)) + "K";
  }
  if (a < 1) return "–";
  return s + "$" + Math.round(a);
};

const dlabel = (d?: string) => {
  if (!d) return "—";
  try {
    const [y, m, dd] = d.split("-").map(Number);
    const t = new Date(Date.UTC(y, m - 1, dd, 12));
    return t.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    });
  } catch {
    return d;
  }
};

const et = (ts?: number | null) => {
  if (!ts) return "—";
  return (
    new Date(ts * 1000).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: "America/New_York",
    }) + " ET"
  );
};

const etStr = (s?: string) => {
  if (!s) return "—";
  const t = Date.parse(String(s).replace(" UTC", "Z").replace(" ", "T"));
  return isNaN(t) ? s : et(t / 1000);
};

const side = (px: number | null, lv: number | null | undefined) => {
  if (px == null || lv == null) return "—";
  return px > lv ? "above" : px < lv ? "below" : "at";
};

const arrow = (a: any, b: any, moves?: number | null) => {
  const m =
    moves == null ? "" : ` · ${moves} move${moves === 1 ? "" : "s"}`;
  return `${num(a)} → ${num(b)}${m ? ` (${m.trim()})` : ""}`;
};

export function RecapView() {
  const router = useRouter();
  const [data, setData] = useState<RecapPayload | null>(null);
  const [selectedDay, setSelectedDay] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(true);
  const [postingDiscord, setPostingDiscord] = useState<boolean>(false);
  const [discordStatus, setDiscordStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const setActiveView = useDashboardStore((state) => state.setActiveView);
  const setTicker = useDashboardStore((state) => state.setTicker);
  const discordWebhookUrl = useDashboardStore((state) => state.discordConfig.webhookUrl);

  const openTickerInGaia = (symbol: string) => {
    const clean = symbol.trim().toUpperCase();
    setTicker(clean);
    setActiveView("Gaia");
    router.push(`/gaia?ticker=${encodeURIComponent(clean)}`);
  };

  const handlePostDiscordRecap = async () => {
    setPostingDiscord(true);
    setDiscordStatus(null);
    try {
      const res = await fetch("/api/signals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "send_daily_recap",
          webhookUrl: discordWebhookUrl,
        }),
      });
      const json = await res.json();
      if (res.ok && json?.success) {
        setDiscordStatus({ ok: true, msg: json.message || "EOD Recap posted to Discord." });
      } else {
        setDiscordStatus({ ok: false, msg: json?.error || "Failed to post EOD Recap." });
      }
    } catch {
      setDiscordStatus({ ok: false, msg: "Network error posting EOD Recap." });
    } finally {
      setPostingDiscord(false);
    }
  };

  useEffect(() => {
    let active = true;
    const fetchRecap = async () => {
      try {
        const url = `/api/session-recap${selectedDay ? `?day=${encodeURIComponent(selectedDay)}` : ""}`;
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) return;
        const j: RecapPayload = await res.json();
        if (active) {
          setData(j);
          if (!selectedDay && j.day) setSelectedDay(j.day);
          setLoading(false);
        }
      } catch {
        if (active) setLoading(false);
      }
    };
    fetchRecap();
    return () => {
      active = false;
    };
  }, [selectedDay]);

  const recap = data?.recap;
  const tickers = recap?.tickers || [];
  const mainTickers = tickers.filter((r) => MAIN.includes(r.symbol));
  const boardTickers = tickers.filter((r) => !MAIN.includes(r.symbol));

  const handleShare = async () => {
    if (!recap) return;
    const spy = tickers.find((x) => x.symbol === "SPY") || tickers[0];
    const s = (spy?.session ?? {}) as NonNullable<RecapTicker["session"]>;
    const d =
      spy && spy.close != null && spy.prev_close
        ? ((spy.close - spy.prev_close) / spy.prev_close) * 100
        : null;
    const base = `${spy?.label ?? "SPY"} ${recap.day.slice(5)} recap: close ${num(spy?.close)}${d == null ? "" : ` (${d >= 0 ? "+" : ""}${d.toFixed(2)}%)`}, GEX King ${s.gk?.start != null ? s.gk.start + " → " : ""}${num(s.gk?.end)}, call wall ${num(s.cw?.close)}, put wall ${num(s.pw?.close)}`;
    const text = `${base}\nFor educational and informational purposes only. Not financial advice.`;

    if (navigator.share) {
      try {
        await navigator.share({ text });
        return;
      } catch (err) {
        if ((err as Error)?.name === "AbortError") return;
      }
    }
    window.open(
      `https://x.com/intent/post?text=${encodeURIComponent(text)}`,
      "_blank",
      "noopener,noreferrer"
    );
  };

  const renderCard = (r: RecapTicker) => {
    const s = (r.session ?? {}) as NonNullable<RecapTicker["session"]>;
    const n = (r.next ?? {}) as NonNullable<RecapTicker["next"]>;
    const nd = n.nodes || {};
    const diff = r.close - r.prev_close;
    const pct = r.prev_close > 0 ? (diff / r.prev_close) * 100 : 0;
    const isUp = diff >= 0;

    const emStr = n.em
      ? `±${num(n.em.move)} · ${num(n.em.low)}–${num(n.em.high)} (${n.em.exp.slice(5)})`
      : "—";

    const nodeStr = (node?: [number, number] | null) => {
      if (!node) return "—";
      const val = node[1];
      const isPos = val >= 0;
      return (
        <span>
          {num(node[0])}{" "}
          <span className={cn(isPos ? "text-emerald-400" : "text-purple-400")}>
            {fmt(val)}
          </span>
        </span>
      );
    };

    return (
      <div
        key={r.symbol}
        className="bg-[#111827]/65 border border-slate-800 rounded-2xl p-3.5 space-y-2.5 font-sans"
      >
        {/* Card Header */}
        <div className="flex items-baseline justify-between gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => openTickerInGaia(r.symbol)}
            className="text-lg font-extrabold text-white hover:text-cyan-400 transition-colors cursor-pointer"
          >
            {r.label}
          </button>
          <div className="font-mono text-xs tabular-nums">
            <span className="font-bold text-white text-sm">${num(r.close)}</span>{" "}
            <span
              className={cn(
                "font-semibold",
                isUp ? "text-emerald-400" : "text-rose-400"
              )}
            >
              {isUp ? "+" : ""}
              {diff.toFixed(2)} ({isUp ? "+" : ""}
              {pct.toFixed(2)}%)
            </span>
          </div>
        </div>

        {/* Subtitle */}
        <div className="text-[11px] font-mono text-slate-400 tabular-nums">
          Open {num(r.open)} · Prev close {num(r.prev_close)} · Book {etStr(r.chain_as_of)}
        </div>

        {/* Section 1: Session */}
        <div className="pt-1 border-t border-slate-800/60">
          <div className="text-[10px] font-bold font-mono uppercase tracking-wider text-slate-500 mb-1">
            Session
          </div>
          <table className="w-full text-xs font-mono tabular-nums divide-y divide-slate-800/40">
            <tbody>
              <tr>
                <td className="py-1 text-slate-400 w-2/5">GEX King</td>
                <td className="py-1 text-right text-[#facc15] font-bold">
                  {arrow(s.gk?.start, s.gk?.end, s.gk?.moves)}
                </td>
              </tr>
              <tr>
                <td className="py-1 text-slate-400">VEX King</td>
                <td className="py-1 text-right text-amber-300 font-bold">
                  {arrow(s.vk?.start, s.vk?.end, s.vk?.moves)}
                </td>
              </tr>
              <tr>
                <td className="py-1 text-slate-400">Call wall</td>
                <td className="py-1 text-right text-cyan-400 font-semibold">
                  {arrow(s.cw?.open, s.cw?.close, s.cw?.moves)}
                </td>
              </tr>
              <tr>
                <td className="py-1 text-slate-400">Put wall</td>
                <td className="py-1 text-right text-fuchsia-400 font-semibold">
                  {arrow(s.pw?.open, s.pw?.close, s.pw?.moves)}
                </td>
              </tr>
              <tr>
                <td className="py-1 text-slate-400">Zero γ</td>
                <td className="py-1 text-right text-slate-300">
                  {num(s.zg?.open)} → {num(s.zg?.close)}
                </td>
              </tr>
              <tr>
                <td className="py-1 text-slate-400">Close vs levels</td>
                <td className="py-1 text-right text-slate-300 text-[11px]">
                  {side(r.close, s.gk?.end)} King · {side(r.close, s.cw?.close)} CW ·{" "}
                  {side(r.close, s.pw?.close)} PW · {side(r.close, s.zg?.close)} zero γ
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* Section 2: Next session setup */}
        <div className="pt-2 border-t border-slate-800/60">
          <div className="text-[10px] font-bold font-mono uppercase tracking-wider text-slate-500 mb-1">
            Next session setup · {dlabel(n.date)}
          </div>
          <table className="w-full text-xs font-mono tabular-nums divide-y divide-slate-800/40">
            <tbody>
              <tr>
                <td className="py-1 text-slate-400 w-2/5">GEX King</td>
                <td className="py-1 text-right">
                  <span className="text-[#facc15] font-bold">
                    {num(n.gk?.[0])}
                  </span>{" "}
                  <span
                    className={
                      (n.gk?.[1] ?? 0) >= 0 ? "text-emerald-400" : "text-purple-400"
                    }
                  >
                    {fmt(n.gk?.[1])}
                  </span>
                </td>
              </tr>
              <tr>
                <td className="py-1 text-slate-400">VEX King</td>
                <td className="py-1 text-right">
                  <span className="text-amber-300 font-bold">
                    {num(n.vk?.[0])}
                  </span>{" "}
                  <span
                    className={
                      (n.vk?.[1] ?? 0) >= 0 ? "text-emerald-400" : "text-purple-400"
                    }
                  >
                    {fmt(n.vk?.[1])}
                  </span>
                </td>
              </tr>
              <tr>
                <td className="py-1 text-slate-400">Call wall · Put wall</td>
                <td className="py-1 text-right">
                  <span className="text-cyan-400 font-semibold">{num(n.cw)}</span> ·{" "}
                  <span className="text-fuchsia-400 font-semibold">{num(n.pw)}</span>
                </td>
              </tr>
              <tr>
                <td className="py-1 text-slate-400">Zero γ</td>
                <td className="py-1 text-right text-slate-300">{num(n.zg)}</td>
              </tr>
              <tr>
                <td className="py-1 text-slate-400">Above close (±8%)</td>
                <td className="py-1 text-right text-[11px]">
                  {nodeStr(nd.above_pos)} · {nodeStr(nd.above_neg)}
                </td>
              </tr>
              <tr>
                <td className="py-1 text-slate-400">Below close (±8%)</td>
                <td className="py-1 text-right text-[11px]">
                  {nodeStr(nd.below_pos)} · {nodeStr(nd.below_neg)}
                </td>
              </tr>
              <tr>
                <td className="py-1 text-slate-400">Expected move</td>
                <td className="py-1 text-right text-[11px] text-slate-200">
                  {emStr}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  return (
    <div className="max-w-[1180px] w-full mx-auto space-y-4 font-sans">
      {/* Top Header */}
      <div>
        <h1 className="text-2xl font-extrabold text-white tracking-tight">
          Session recap
        </h1>
        <p className="text-xs text-slate-400 mt-1">
          Where the GEX King, VEX King, call wall, put wall and zero gamma started and ended,
          where price closed against them, and the setup the closing book leaves for the next session.
        </p>
      </div>

      {/* Control Bar: State badge, Day select, Share to X */}
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-[#111827] border border-slate-700 text-slate-300 font-mono">
          <span className="w-2 h-2 rounded-full bg-emerald-400" />
          {recap ? `Completed session · ${dlabel(recap.day)}` : "Loading session…"}
        </span>

        {data?.days && data.days.length > 0 && (
          <select
            id="recap-session-day"
            name="recapSessionDay"
            aria-label="Select completed session date"
            value={selectedDay}
            onChange={(e) => setSelectedDay(e.target.value)}
            className="bg-[#0f172a] text-slate-200 border border-slate-700 rounded-full px-3 py-1 text-xs font-mono focus:outline-none focus:border-cyan-400 cursor-pointer"
          >
            {data.days.map((d) => (
              <option key={d} value={d}>
                {dlabel(d)}
              </option>
            ))}
          </select>
        )}

        <button
          type="button"
          onClick={handleShare}
          className="bg-[#0f172a] hover:bg-slate-800 border border-slate-700 text-slate-200 font-semibold text-xs px-3.5 py-1 rounded-full transition-colors cursor-pointer"
        >
          Share to X
        </button>

        <button
          type="button"
          onClick={handlePostDiscordRecap}
          disabled={postingDiscord}
          className="bg-indigo-500/20 hover:bg-indigo-500/30 border border-indigo-400/50 text-indigo-200 font-semibold text-xs px-3.5 py-1 rounded-full transition-colors cursor-pointer disabled:opacity-50"
        >
          {postingDiscord ? "Posting EOD Recap…" : "Post EOD Recap to Discord"}
        </button>

        {discordStatus && (
          <span
            className={cn(
              "text-xs font-mono",
              discordStatus.ok ? "text-emerald-400" : "text-rose-400"
            )}
          >
            {discordStatus.msg}
          </span>
        )}
      </div>

      {/* 7-Day Rolling Portfolio Equity Dashboard */}
      {!loading && data?.portfolio && (
        <section className="space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h2 className="text-xs font-bold uppercase tracking-widest text-[#22d3ee] font-mono">
              7-Day Rolling Portfolio Equity ({data.portfolio.daysWithTrades.length} Sessions)
            </h2>
            <span className="text-[11px] font-mono text-slate-400">
              Retained `.cache/active-trades-*.json` Ledger
            </span>
          </div>

          {/* KPI Strip */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5 font-mono">
            <div className="bg-[#111827]/70 border border-slate-800 rounded-xl p-3">
              <div className="text-[10px] uppercase tracking-wider text-slate-500">Cumulative P&amp;L</div>
              <div
                className={cn(
                  "text-lg font-extrabold tabular-nums mt-0.5",
                  data.portfolio.cumulativeDollarPnl >= 0 ? "text-emerald-400" : "text-rose-400"
                )}
              >
                {data.portfolio.cumulativeDollarPnl >= 0 ? "+" : "-"}$
                {Math.abs(data.portfolio.cumulativeDollarPnl).toFixed(2)}
              </div>
            </div>
            <div className="bg-[#111827]/70 border border-slate-800 rounded-xl p-3">
              <div className="text-[10px] uppercase tracking-wider text-slate-500">Win Rate</div>
              <div className="text-lg font-extrabold text-white tabular-nums mt-0.5">
                {data.portfolio.winRatePct.toFixed(1)}%
              </div>
              <div className="text-[10px] text-slate-400">
                {data.portfolio.wins}W · {data.portfolio.losses}L · {data.portfolio.breakevens}BE
              </div>
            </div>
            <div className="bg-[#111827]/70 border border-slate-800 rounded-xl p-3">
              <div className="text-[10px] uppercase tracking-wider text-slate-500">Profit Factor</div>
              <div className="text-lg font-extrabold text-cyan-300 tabular-nums mt-0.5">
                {data.portfolio.profitFactor == null
                  ? "—"
                  : data.portfolio.profitFactor >= 999
                    ? "∞"
                    : data.portfolio.profitFactor.toFixed(2)}
              </div>
            </div>
            <div className="bg-[#111827]/70 border border-slate-800 rounded-xl p-3">
              <div className="text-[10px] uppercase tracking-wider text-slate-500">Expectancy</div>
              <div
                className={cn(
                  "text-lg font-extrabold tabular-nums mt-0.5",
                  data.portfolio.expectancyR >= 0 ? "text-emerald-400" : "text-rose-400"
                )}
              >
                {data.portfolio.expectancyR >= 0 ? "+" : ""}
                {data.portfolio.expectancyR.toFixed(2)}R
              </div>
            </div>
            <div className="bg-[#111827]/70 border border-slate-800 rounded-xl p-3">
              <div className="text-[10px] uppercase tracking-wider text-slate-500">Max Drawdown</div>
              <div className="text-lg font-extrabold text-amber-300 tabular-nums mt-0.5">
                ${data.portfolio.maxDrawdown.toFixed(2)}
              </div>
            </div>
            <div className="bg-[#111827]/70 border border-slate-800 rounded-xl p-3">
              <div className="text-[10px] uppercase tracking-wider text-slate-500">Trades · Outlay</div>
              <div className="text-lg font-extrabold text-white tabular-nums mt-0.5">
                {data.portfolio.totalTrades}
              </div>
              <div className="text-[10px] text-slate-400">
                ${data.portfolio.totalCapitalOutlay.toFixed(0)} risked
              </div>
            </div>
          </div>

          {/* Equity Curve & R-Multiple Distribution */}
          {data.portfolio.totalTrades > 0 && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              <div className="bg-[#111827]/65 border border-slate-800 rounded-2xl p-3.5 space-y-2">
                <div className="text-[11px] font-bold font-mono uppercase tracking-wider text-slate-400">
                  Cumulative Equity Curve ($)
                </div>
                {(() => {
                  const pts = [{ index: 0, equity: 0 }, ...data.portfolio.equityCurve];
                  const vals = pts.map((p) => p.equity);
                  const minY = Math.min(0, ...vals);
                  const maxY = Math.max(10, ...vals);
                  const spanY = Math.max(1, maxY - minY);
                  const w = 480;
                  const h = 140;
                  const pad = 12;
                  const xFor = (i: number) =>
                    pad + (i / Math.max(1, pts.length - 1)) * (w - pad * 2);
                  const yFor = (v: number) =>
                    h - pad - ((v - minY) / spanY) * (h - pad * 2);
                  const zeroY = yFor(0);
                  const poly = pts.map((p, idx) => `${xFor(idx).toFixed(1)},${yFor(p.equity).toFixed(1)}`).join(" ");
                  const lastEq = vals[vals.length - 1] ?? 0;
                  const stroke = lastEq >= 0 ? "#10b981" : "#f43f5e";
                  return (
                    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-36">
                      <line x1={pad} y1={zeroY} x2={w - pad} y2={zeroY} stroke="#334155" strokeDasharray="4 4" strokeWidth="1" />
                      <polyline fill="none" stroke={stroke} strokeWidth="2.5" strokeLinejoin="round" points={poly} />
                      {pts.map((p, idx) => (
                        <circle key={idx} cx={xFor(idx)} cy={yFor(p.equity)} r="3" fill={stroke} />
                      ))}
                    </svg>
                  );
                })()}
              </div>

              <div className="bg-[#111827]/65 border border-slate-800 rounded-2xl p-3.5 space-y-2.5">
                <div className="text-[11px] font-bold font-mono uppercase tracking-wider text-slate-400">
                  R-Multiple Distribution
                </div>
                <div className="space-y-2 font-mono text-xs">
                  {(() => {
                    const maxCount = Math.max(1, ...data.portfolio.rDistribution.map((b) => b.count));
                    return data.portfolio.rDistribution.map((bucket) => {
                      const pct = (bucket.count / maxCount) * 100;
                      const isNeg = bucket.label.startsWith("<=") || bucket.label.startsWith("-1.0");
                      return (
                        <div key={bucket.label} className="flex items-center gap-2.5">
                          <span className="w-24 text-[11px] text-slate-400 shrink-0">{bucket.label}</span>
                          <div className="flex-1 h-2.5 rounded-full bg-slate-800/90 overflow-hidden">
                            <div
                              style={{ width: `${pct}%` }}
                              className={cn(
                                "h-full rounded-full transition-all",
                                isNeg ? "bg-rose-500/80" : "bg-emerald-400/85"
                              )}
                            />
                          </div>
                          <span className="w-8 text-right text-[11px] text-slate-200 tabular-nums">
                            {bucket.count}
                          </span>
                        </div>
                      );
                    });
                  })()}
                </div>
              </div>
            </div>
          )}

          {/* Closed Trades Ledger */}
          {data.portfolio.trades.length > 0 && (
            <div className="bg-[#111827]/65 border border-slate-800 rounded-2xl p-3.5 overflow-x-auto">
              <div className="text-[11px] font-bold font-mono uppercase tracking-wider text-slate-400 mb-2">
                Closed Trades Ledger (Click Ticker to Inspect in Gaia)
              </div>
              <table className="w-full text-xs font-mono tabular-nums">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-wider text-slate-500 border-b border-slate-800">
                    <th className="py-1.5 pr-3">Date</th>
                    <th className="py-1.5 pr-3">Ticker</th>
                    <th className="py-1.5 pr-3">Contract</th>
                    <th className="py-1.5 pr-3">Window</th>
                    <th className="py-1.5 pr-3 text-right">Entry → Exit</th>
                    <th className="py-1.5 pr-3 text-right">P&amp;L $</th>
                    <th className="py-1.5 pr-3 text-right">R-Mult</th>
                    <th className="py-1.5">Exit Reason</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/50">
                  {data.portfolio.trades.map((t) => {
                    const win = t.realizedDollarPnl >= 0;
                    return (
                      <tr key={t.id} className="hover:bg-slate-800/30">
                        <td className="py-1.5 pr-3 text-slate-400 whitespace-nowrap">{t.date}</td>
                        <td className="py-1.5 pr-3">
                          <button
                            type="button"
                            onClick={() => openTickerInGaia(t.ticker)}
                            className="font-bold text-cyan-300 hover:text-cyan-200 underline-offset-2 hover:underline cursor-pointer"
                          >
                            {t.ticker}
                          </button>
                        </td>
                        <td className="py-1.5 pr-3 text-slate-200 whitespace-nowrap">{t.contractLabel}</td>
                        <td className="py-1.5 pr-3 text-slate-400 whitespace-nowrap">
                          {t.openedAt} → {t.closedAt}
                        </td>
                        <td className="py-1.5 pr-3 text-right text-slate-300 whitespace-nowrap">
                          ${t.entryOptionPrice.toFixed(2)} → ${t.exitOptionPrice.toFixed(2)}
                        </td>
                        <td
                          className={cn(
                            "py-1.5 pr-3 text-right font-bold whitespace-nowrap",
                            win ? "text-emerald-400" : "text-rose-400"
                          )}
                        >
                          {win ? "+" : "-"}${Math.abs(t.realizedDollarPnl).toFixed(2)}
                        </td>
                        <td
                          className={cn(
                            "py-1.5 pr-3 text-right font-bold whitespace-nowrap",
                            t.rMultiple >= 0 ? "text-emerald-400" : "text-rose-400"
                          )}
                        >
                          {t.rMultiple >= 0 ? "+" : ""}
                          {t.rMultiple.toFixed(2)}R
                        </td>
                        <td className="py-1.5 text-slate-400 truncate max-w-[260px]" title={t.exitReason}>
                          {t.exitReason}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* Notes */}
      {recap && tickers.length > 0 && (
        <div className="bg-[#111827]/50 border border-slate-800 rounded-xl p-3 text-xs text-slate-400 space-y-1 font-mono leading-relaxed">
          <div>
            Built {et(recap.built_at)} from the closing books. Values are shown the way the heatmap shows them; hover a value for the exact number.
          </div>
        </div>
      )}

      {/* Content */}
      {loading ? (
        <div className="bg-[#111827]/60 border border-slate-800 rounded-xl p-12 text-center text-xs text-slate-500 font-mono">
          Loading completed session recap…
        </div>
      ) : tickers.length === 0 && !data?.portfolio?.totalTrades ? (
        <div className="bg-[#111827]/60 border border-slate-800 rounded-xl p-12 text-center text-xs text-slate-500 font-mono">
          No completed session recap yet. The first recap is built after a session closes.
        </div>
      ) : tickers.length === 0 ? null : (
        <div className="space-y-6">
          {mainTickers.length > 0 && (
            <div className="space-y-3">
              <h2 className="text-xs font-bold uppercase tracking-widest text-[#22d3ee] font-mono">
                Indexes &amp; ETFs
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {mainTickers.map(renderCard)}
              </div>
            </div>
          )}

          {boardTickers.length > 0 && (
            <div className="space-y-3">
              <h2 className="text-xs font-bold uppercase tracking-widest text-[#22d3ee] font-mono">
                Board
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {boardTickers.map(renderCard)}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
