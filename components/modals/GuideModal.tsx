"use client";

import React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { BookOpen, Crown, Flame, Shield, X, Zap } from "lucide-react";

interface GuideModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function GuideModal({ open, onOpenChange }: GuideModalProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm transition-opacity animate-in fade-in duration-200" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[95vw] max-w-3xl max-h-[88vh] -translate-x-1/2 -translate-y-1/2 overflow-y-auto argon-scrollbar rounded-2xl bg-[#111422] border border-[#5e72e4]/50 p-6 text-slate-200 shadow-[0_0_40px_rgba(0,0,0,0.85)] focus:outline-none">
          {/* Modal Header */}
          <div className="flex items-start justify-between gap-4 border-b border-white/10 pb-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#1c223a] border border-[#11cdef]/50 text-[#11cdef]">
                <BookOpen className="h-5 w-5" />
              </div>
              <div>
                <Dialog.Title className="text-lg font-extrabold text-white tracking-tight">
                  How to Read Hyperion · Quantitative Playbook
                </Dialog.Title>
                <Dialog.Description className="text-xs font-mono text-slate-400">
                  30-Second Dealer Positioning & Gamma Regime Field Guide
                </Dialog.Description>
              </div>
            </div>

            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="Close Guide Modal"
                className="rounded-lg bg-[#0b0d17] border border-white/15 p-1.5 text-slate-400 hover:text-white hover:border-white/30 transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </Dialog.Close>
          </div>

          <div className="mt-5 space-y-5 text-xs leading-relaxed">
            {/* 30-Second Quick Start */}
            <div className="rounded-xl bg-[#0b0d17] border border-amber-300/35 p-4 space-y-2">
              <div className="flex items-center gap-2 font-mono font-bold text-amber-300 uppercase tracking-wider">
                <Crown className="h-4 w-4" />
                <span>The 30-Second Tour</span>
              </div>
              <p className="text-slate-300">
                The <strong className="text-yellow-300">yellow cell with one gold glow</strong> is the{" "}
                <strong className="text-white">King Node</strong> — the strike with the largest total gamma exposure across every expiration.{" "}
                <strong className="text-purple-300">Deep Purple</strong> is the most negative gamma,{" "}
                <strong className="text-teal-300">Teal</strong> is near zero, and{" "}
                <strong className="text-yellow-300">Bright Yellow</strong> is the most positive gamma. The{" "}
                <strong className="text-[#3b82f6]">bright blue strike</strong> in the left column is the live spot price.
              </p>
            </div>

            {/* Regime Playbooks: Positive vs Negative Gamma */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Positive Gamma Playbook */}
              <div className="rounded-xl bg-teal-500/10 border border-teal-400/40 p-4 space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="inline-flex items-center gap-1.5 font-mono font-extrabold text-teal-300 uppercase">
                    <Shield className="h-4 w-4" />
                    Positive γ Regime
                  </span>
                  <span className="rounded-full bg-teal-500/20 px-2 py-0.5 text-[10px] font-mono font-bold text-teal-200">
                    Spot &gt; Zero γ
                  </span>
                </div>
                <p className="text-slate-300 font-medium">
                  Dealers are net long gamma and hedge counter-trend (selling rips and buying dips), suppressing realized volatility.
                </p>
                <ul className="space-y-1.5 text-slate-300 list-disc pl-4 font-mono text-[11px]">
                  <li>
                    <strong className="text-white">Mean Reversion &amp; Pinning:</strong> Breakouts frequently stall at the Call Wall; breakdowns get absorbed at the Put Wall.
                  </li>
                  <li>
                    <strong className="text-white">Execution Strategy:</strong> Fade extremes near the Call Wall / Put Wall or Daily Expected Move (<span className="text-yellow-300">D↑ / D↓</span>) back toward the King Node magnet.
                  </li>
                </ul>
              </div>

              {/* Negative Gamma Playbook */}
              <div className="rounded-xl bg-purple-500/15 border border-purple-400/45 p-4 space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="inline-flex items-center gap-1.5 font-mono font-extrabold text-purple-300 uppercase">
                    <Flame className="h-4 w-4" />
                    Negative γ Regime
                  </span>
                  <span className="rounded-full bg-purple-500/25 px-2 py-0.5 text-[10px] font-mono font-bold text-purple-200">
                    Spot &lt; Zero γ
                  </span>
                </div>
                <p className="text-slate-300 font-medium">
                  Dealers are net short gamma and must hedge WITH the trend (selling futures as price drops, buying as price squeezes).
                </p>
                <ul className="space-y-1.5 text-slate-300 list-disc pl-4 font-mono text-[11px]">
                  <li>
                    <strong className="text-white">Momentum &amp; Vol Expansion:</strong> Directional moves accelerate rapidly once price slips below Zero γ.
                  </li>
                  <li>
                    <strong className="text-white">Execution Strategy:</strong> Avoid blind fades. Trade momentum continuations toward the Put Wall magnet or wait for a reclaim of Zero γ.
                  </li>
                </ul>
              </div>
            </div>

            {/* King Strength (0-100) & Contested vs Dominant */}
            <div className="rounded-xl bg-[#0b0d17] border border-white/15 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 font-mono font-extrabold text-white uppercase">
                  <Zap className="h-4 w-4 text-yellow-400" />
                  <span>Interpreting King Strength (0–100)</span>
                </div>
                <span className="font-mono text-[11px] text-amber-300">
                  50 pts Lead + 50 pts Board Share
                </span>
              </div>

              <p className="text-slate-300">
                Hyperion scores the gravitational pull of the <strong className="text-yellow-300">All-exp King Node</strong> from{" "}
                <strong className="text-white">0 to 100</strong> using two equal components:
              </p>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 font-mono text-[11px]">
                <div className="rounded-lg bg-[#111422] border border-white/10 p-3">
                  <div className="text-amber-300 font-bold mb-1">
                    1. Lead Over #2 Strike (0–50 pts)
                  </div>
                  <div className="text-slate-400">
                    <code>(1 - secondLargest / kingValue) × 50</code>. Measures how decisively the King dominates nearby strikes.
                  </div>
                </div>
                <div className="rounded-lg bg-[#111422] border border-white/10 p-3">
                  <div className="text-amber-300 font-bold mb-1">
                    2. Share of Total Board γ (0–50 pts)
                  </div>
                  <div className="text-slate-400">
                    <code>min(1, (kingValue / totalBoard) / 0.25) × 50</code>. Capturing ≥25% of the entire chain earns the full 50 points.
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1 font-mono text-[11px]">
                <div className="rounded-lg bg-amber-400/10 border border-amber-300/40 p-3">
                  <span className="text-yellow-300 font-extrabold uppercase block mb-0.5">
                    ★ Dominant King (Score 60–100)
                  </span>
                  <span className="text-slate-300">
                    Single high-gravity price magnet. Expect strong intraday pinning and dealer delta absorption around the King strike.
                  </span>
                </div>
                <div className="rounded-lg bg-orange-500/10 border border-orange-400/40 p-3">
                  <span className="text-orange-300 font-extrabold uppercase block mb-0.5">
                    ⚠ Contested King (Next Strike within 10%)
                  </span>
                  <span className="text-slate-300">
                    Split dealer gravity between two competing nodes. Price often ping-pongs rapidly through the corridor between the #1 and #2 strikes.
                  </span>
                </div>
              </div>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
