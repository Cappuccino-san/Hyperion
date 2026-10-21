"use client";

import React from "react";
import { TopNavBar } from "@/components/header/TopNavBar";

export default function GuidePage() {
  return (
    <div className="min-h-screen bg-[#0b1220] text-[#e6edf6] flex flex-col font-sans">
      <TopNavBar />

      <main className="flex-1 max-w-[840px] w-full mx-auto px-4 py-6 space-y-5">
        <div>
          <h1 className="text-2xl font-extrabold text-white tracking-tight">
            How to read Hyperion
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            For educational and informational purposes only. Not financial advice. Data may be delayed or inaccurate; trade at your own risk.
          </p>
        </div>

        {/* 30-Second Quick Start */}
        <section className="bg-[#111827]/70 border border-cyan-400/35 rounded-2xl p-4.5 space-y-2">
          <h2 className="text-xs font-bold uppercase tracking-widest text-cyan-400 font-mono">
            How to read this · 30 seconds
          </h2>
          <p className="text-xs leading-relaxed text-slate-200">
            The <span className="bg-[#facc15] text-black font-extrabold px-1.5 py-0.5 rounded shadow-[0_0_8px_rgba(250,204,21,0.6)]">yellow cell</span> with one gold glow is the <b>King Node</b>, the strike with the largest total gamma across every expiration. The tile says <b>All-exp King</b> and that strike. When 0DTE, This week, or a picked date is on, it names both, for example <i>0DTE King 28 (10-16) · All-exp King 30</i>. If the next strike is within about 10%, it adds <i>contested</i>. <span className="bg-[#4338ca] text-white px-1.5 py-0.5 rounded font-bold">Blue to purple</span> cells are negative and <span className="bg-[#16a34a] text-white px-1.5 py-0.5 rounded font-bold">green to lime</span> cells are positive; the deeper the color, the bigger the value. <span className="bg-[#1e293b] text-slate-300 px-1.5 py-0.5 rounded">Dark gray</span> is zero. The <span className="bg-[#13254a] text-[#60a5fa] px-1.5 py-0.5 rounded font-bold border-l-2 border-[#3b82f6]">blue strike</span> is the price. A badge on a GEX cell is the percent change since the open. The daily expected move was set at the prior close and stays fixed through the session. The book is this regular session only.
          </p>
        </section>

        {/* Navigation Pills */}
        <nav className="flex flex-wrap gap-2 text-xs font-mono">
          {[
            { id: "start", label: "Getting started" },
            { id: "metrics", label: "The four exposures" },
            { id: "grid", label: "Grid & Quad" },
            { id: "levels", label: "Key levels" },
            { id: "glossary", label: "Glossary" },
            { id: "em", label: "Expected moves" },
            { id: "scanner", label: "Scanner" },
            { id: "gaia", label: "Gaia" },
            { id: "data", label: "Data & timing" },
          ].map((item) => (
            <a
              key={item.id}
              href={`#${item.id}`}
              className="px-3 py-1 rounded-full bg-[#0f172a] hover:bg-slate-800 border border-slate-700/60 text-slate-300 transition-colors"
            >
              {item.label}
            </a>
          ))}
        </nav>

        {/* 1. Getting Started */}
        <section id="start" className="bg-[#111827]/60 border border-slate-800 rounded-2xl p-4 space-y-3">
          <h2 className="text-xs font-bold uppercase tracking-widest text-cyan-400 font-mono">
            Getting started
          </h2>
          <dl className="space-y-2.5 text-xs">
            <div>
              <dt className="font-bold text-white">Search bar</dt>
              <dd className="text-slate-300 mt-0.5">
                Type any optionable ticker (SPY, QQQ, NVDA…) and press Load or Enter. “SPXW” is the PM-settled SPX weeklies and “NDXP” is the PM-settled NDX weeklies. IBIT is the Bitcoin ETF.
              </dd>
            </div>
            <div>
              <dt className="font-bold text-white">Watchlist chips</dt>
              <dd className="text-slate-300 mt-0.5">
                One-tap shortcuts for popular tickers. The one you&apos;re viewing is highlighted.
              </dd>
            </div>
            <div>
              <dt className="font-bold text-white">Price &amp; change</dt>
              <dd className="text-slate-300 mt-0.5">
                The regular-session price and change vs yesterday&apos;s close. Outside cash hours, a smaller line displays the pre-market print (☀ sun, 4:00–9:30 AM ET) or after-hours print (☾ moon, 4:00–8:00 PM ET) and its change versus regular close.
              </dd>
            </div>
          </dl>
        </section>

        {/* 2. The Four Exposures */}
        <section id="metrics" className="bg-[#111827]/60 border border-slate-800 rounded-2xl p-4 space-y-3">
          <h2 className="text-xs font-bold uppercase tracking-widest text-cyan-400 font-mono">
            The four exposures
          </h2>
          <p className="text-xs text-slate-400">
            Each number is an estimate in dollars, built from open interest and implied volatility of every contract using Black-Scholes. Calls count as positive and puts as negative (the standard dealers are short puts, long calls convention).
          </p>
          <dl className="space-y-2.5 text-xs">
            <div>
              <dt className="font-bold text-white">GEX: gamma exposure</dt>
              <dd className="text-slate-300 mt-0.5">
                How much hedging dealers must do per 1% move in the stock. <b>Positive gamma</b> (green/lime) means dealers buy dips and sell rips, calming volatility and pinning price. <b>Negative gamma</b> (blue/purple) means dealers chase the move, accelerating swings.
              </dd>
            </div>
            <div>
              <dt className="font-bold text-white">VEX: vanna exposure</dt>
              <dd className="text-slate-300 mt-0.5">
                How that delta hedge changes when implied volatility moves 1 point. Positive vanna pushes buying when IV drops, selling when IV spikes.
              </dd>
            </div>
            <div>
              <dt className="font-bold text-white">DEX: delta exposure</dt>
              <dd className="text-slate-300 mt-0.5">
                The share-equivalent dollar delta sitting at each strike (delta × OI × 100 × price). Large values show where major directional positioning lives.
              </dd>
            </div>
            <div>
              <dt className="font-bold text-white">Charm</dt>
              <dd className="text-slate-300 mt-0.5">
                How much delta changes per day purely from time passing. It matters most near expiration and late in the day as hedges unwind.
              </dd>
            </div>
          </dl>
        </section>

        {/* 3. Grid & Quad */}
        <section id="grid" className="bg-[#111827]/60 border border-slate-800 rounded-2xl p-4 space-y-3">
          <h2 className="text-xs font-bold uppercase tracking-widest text-cyan-400 font-mono">
            Grid &amp; Quad
          </h2>
          <dl className="space-y-2.5 text-xs">
            <div>
              <dt className="font-bold text-white">Quad view (/quad)</dt>
              <dd className="text-slate-300 mt-0.5">
                SPY, QQQ, SPXW, and IWM side by side. Each column lists strikes centered around spot with net exposure summed over chosen expirations. Colors run Viridis (purple negative, teal near zero, yellow positive). Only the King glows gold with a ★ symbol.
              </dd>
            </div>
            <div>
              <dt className="font-bold text-white">Every strike and expiration</dt>
              <dd className="text-slate-300 mt-0.5">
                Every single active contract is included; Hyperion does not cut down to an artificial window. <b>All exp</b> sums every expiration. <b>This week</b> covers nearest expiration through Friday. <b>0DTE</b> (or <b>Next exp</b> after 4 PM ET) targets the active session expiration.
              </dd>
            </div>
          </dl>
        </section>

        {/* 4. Key Levels */}
        <section id="levels" className="bg-[#111827]/60 border border-slate-800 rounded-2xl p-4 space-y-3">
          <h2 className="text-xs font-bold uppercase tracking-widest text-cyan-400 font-mono">
            Key levels
          </h2>
          <dl className="space-y-2.5 text-xs">
            <div>
              <dt className="font-bold text-white">Call wall</dt>
              <dd className="text-slate-300 mt-0.5">
                Strike at or above price with the highest call-only gamma across all expirations. Acts as resistance/ceiling.
              </dd>
            </div>
            <div>
              <dt className="font-bold text-white">Put wall</dt>
              <dd className="text-slate-300 mt-0.5">
                Strike at or below price with the highest put-only gamma across all expirations. Acts as support/floor.
              </dd>
            </div>
            <div>
              <dt className="font-bold text-white">Zero γ (gamma flip)</dt>
              <dd className="text-slate-300 mt-0.5">
                The price where total dealer gamma crosses zero. Re-prices the options chain across hypothetical spot prices around spot and interpolates the crossing closest to spot.
              </dd>
            </div>
          </dl>
        </section>

        {/* 5. Expected Moves */}
        <section id="em" className="bg-[#111827]/60 border border-slate-800 rounded-2xl p-4 space-y-3">
          <h2 className="text-xs font-bold uppercase tracking-widest text-cyan-400 font-mono">
            Expected moves (0.85 × ATM Straddle)
          </h2>
          <p className="text-xs text-slate-400">
            How far the market prices moves: <b>0.85 × (ATM Call Mid + ATM Put Mid)</b>:
          </p>
          <dl className="space-y-2.5 text-xs">
            <div>
              <dt className="font-bold text-white">Daily (D, white)</dt>
              <dd className="text-slate-300 mt-0.5">
                The ATM straddle at current price. Rolls to the next session before 9:30 AM ET and after 4:00 PM ET.
              </dd>
            </div>
            <div>
              <dt className="font-bold text-white">Weekly (W, yellow)</dt>
              <dd className="text-slate-300 mt-0.5">
                The last expiration of the Monday–Friday week (Friday).
              </dd>
            </div>
            <div>
              <dt className="font-bold text-white">Monthly (M, orange)</dt>
              <dd className="text-slate-300 mt-0.5">
                The last expiration in the current calendar month.
              </dd>
            </div>
            <div>
              <dt className="font-bold text-white">Annual (A, red)</dt>
              <dd className="text-slate-300 mt-0.5">
                Fixed 2026 high/low levels for SPX, SPY, and QQQ set at start of year.
              </dd>
            </div>
          </dl>
        </section>

        {/* 6. Scanner */}
        <section id="scanner" className="bg-[#111827]/60 border border-slate-800 rounded-2xl p-4 space-y-3">
          <h2 className="text-xs font-bold uppercase tracking-widest text-cyan-400 font-mono">
            King Node Scanner (/scanner)
          </h2>
          <p className="text-xs text-slate-300 leading-relaxed">
            Ranks tickers at 9:35 AM ET and 3:50 PM ET by King node pull strength. <b>King strength (0–100)</b> combines how far King leads the next strike (1 − next/King) with its gamma concentration (share/25%). <b>Pull score</b> incorporates the distance fit relative to daily EM (0.5×–2.0× is peak pull).
          </p>
        </section>

        {/* 7. Gaia */}
        <section id="gaia" className="bg-[#111827]/60 border border-slate-800 rounded-2xl p-4 space-y-3">
          <h2 className="text-xs font-bold uppercase tracking-widest text-cyan-400 font-mono">
            Gaia (/gaia)
          </h2>
          <p className="text-xs text-slate-300 leading-relaxed">
            Candlestick and gamma bubble engine. 5-minute bars over cyan (+GEX) and purple (-GEX) strike bubbles, with daily SMA 5 (white), EMA 21 (teal), SMA 55 (orange) levels, and intraday SMA 34 (green/red). Includes non-repainting 3-left/3-right pivot divergence table (5m, 30m, 2h, Daily, Weekly) and an expected-move cone with Pin and Fast-move shading.
          </p>
        </section>

        {/* 8. Atlas */}
        <section id="atlas" className="bg-[#111827]/60 border border-slate-800 rounded-2xl p-4 space-y-3">
          <h2 className="text-xs font-bold uppercase tracking-widest text-cyan-400 font-mono">
            Atlas (Live Pulse inside Gaia)
          </h2>
          <p className="text-xs text-slate-300 leading-relaxed">
            Live pitch-black node-pulse tracking canvas built directly into Gaia. Renders multi-timeframe candlesticks alongside dynamic comet-tail acoustic waveform ribbons at active structural nodes (King, 0DTE King, Call Wall, Put Wall, Zero γ). Features right-axis live spot countdown timer, interactive nodes drawer, adjustable vertical/horizontal scaling & pan, and a dedicated Replay button (⟲) with scrubber transport controls.
          </p>
        </section>
      </main>

      <footer className="border-t border-white/10 bg-[#111422]/80 py-4 px-4 mt-8">
        <div className="max-w-[840px] mx-auto flex flex-col sm:flex-row items-center justify-between gap-2 text-[11px] font-mono text-slate-400">
          <div className="flex flex-wrap items-center gap-3">
            <a href="https://discord.gg/WS7t69W2D" target="_blank" rel="noreferrer" className="hover:text-white transition-colors">
              Discord
            </a>
            <a href="https://whop.com/index-cheat-codes/affiliates" target="_blank" rel="noreferrer" className="hover:text-white transition-colors">
              Index Cheat Codes
            </a>
            <a href="/" className="hover:text-white transition-colors">
              Heatmap
            </a>
            <a href="/quad" className="hover:text-white transition-colors">
              Quad
            </a>
            <a href="/gaia" className="hover:text-white transition-colors">
              Gaia
            </a>
            <a href="/scanner" className="hover:text-white transition-colors">
              Scanner
            </a>
            <a href="/recap" className="hover:text-white transition-colors">
              Recap
            </a>
          </div>
          <div className="text-center sm:text-right text-slate-500">
            For educational and informational purposes only. Not financial advice.
          </div>
        </div>
      </footer>
    </div>
  );
}
