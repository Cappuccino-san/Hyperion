"use client";

import React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Clock, Layers, Scale, ShieldAlert, X, Zap } from "lucide-react";

interface CheatCodesModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CheatCodesModal({ open, onOpenChange }: CheatCodesModalProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm transition-opacity animate-in fade-in duration-200" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[95vw] max-w-3xl max-h-[88vh] -translate-x-1/2 -translate-y-1/2 overflow-y-auto argon-scrollbar rounded-2xl bg-[#111422] border border-amber-400/50 p-6 text-slate-200 shadow-[0_0_40px_rgba(0,0,0,0.85)] focus:outline-none">
          {/* Header */}
          <div className="flex items-start justify-between gap-4 border-b border-white/10 pb-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-500/15 border border-amber-400/50 text-amber-300">
                <Zap className="h-5 w-5" />
              </div>
              <div>
                <Dialog.Title className="text-lg font-extrabold text-white tracking-tight">
                  ⚡ Index Cheat Codes · Institutional Mechanics
                </Dialog.Title>
                <Dialog.Description className="text-xs font-mono text-amber-300/90">
                  SPY vs. SPX vs. SPXW Settlement &amp; Final 60-Minute 0DTE Dealer Hedging
                </Dialog.Description>
              </div>
            </div>

            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="Close Index Cheat Codes Modal"
                className="rounded-lg bg-[#0b0d17] border border-white/15 p-1.5 text-slate-400 hover:text-white hover:border-white/30 transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </Dialog.Close>
          </div>

          <div className="mt-5 space-y-5 text-xs leading-relaxed">
            {/* Section 1: SPY vs. SPX vs. SPXW Cash vs. Physical Settlement */}
            <div className="rounded-xl bg-[#0b0d17] border border-white/15 p-4 space-y-3">
              <div className="flex items-center gap-2 font-mono font-extrabold text-amber-300 uppercase tracking-wider">
                <Scale className="h-4 w-4" />
                <span>1. SPY vs. SPX vs. SPXW: Cash vs. Physical Settlement</span>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left font-mono text-[11px] border-collapse">
                  <thead>
                    <tr className="border-b border-white/15 text-slate-400">
                      <th className="py-2 pr-3">Instrument</th>
                      <th className="py-2 px-3">Settlement</th>
                      <th className="py-2 px-3">Exercise Style</th>
                      <th className="py-2 pl-3">Expiration &amp; Pin Risk</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/10 text-slate-200">
                    <tr>
                      <td className="py-2.5 pr-3 font-bold text-[#11cdef]">
                        SPY (ETF)
                      </td>
                      <td className="py-2.5 px-3 text-rose-300 font-semibold">
                        Physical Shares (100 shs)
                      </td>
                      <td className="py-2.5 px-3">American (Early Exercise)</td>
                      <td className="py-2.5 pl-3 text-slate-300">
                        4:00 PM ET close; dividend &amp; after-hours pin risk until 5:30 PM cutoff.
                      </td>
                    </tr>
                    <tr>
                      <td className="py-2.5 pr-3 font-bold text-amber-300">
                        SPX (Monthly)
                      </td>
                      <td className="py-2.5 px-3 text-emerald-300 font-semibold">
                        Cash-Settled (10× SPY)
                      </td>
                      <td className="py-2.5 pl-3">European (No Early Assignment)</td>
                      <td className="py-2.5 pl-3 text-slate-300">
                        AM-Settled (3rd Friday open print SET); Section 1256 (60/40 tax).
                      </td>
                    </tr>
                    <tr>
                      <td className="py-2.5 pr-3 font-bold text-purple-300">
                        SPXW (Weeklys / 0DTE)
                      </td>
                      <td className="py-2.5 px-3 text-emerald-300 font-semibold">
                        Cash-Settled (10× SPY)
                      </td>
                      <td className="py-2.5 px-3">European (No Early Assignment)</td>
                      <td className="py-2.5 pl-3 text-slate-300">
                        PM-Settled (4:00 PM ET closing print); zero overnight assignment risk.
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div className="rounded-lg bg-[#111422] border border-indigo-400/30 p-3 text-[11px] font-mono text-slate-300">
                <strong className="text-indigo-300">Cross-Arb Basis Rule:</strong>{" "}
                Institutional dealers hedge <code className="text-white">SPXW</code>,{" "}
                <code className="text-white">SPY</code>, and <code className="text-white">ES</code> futures as a unified delta book. Always check whether the{" "}
                <strong className="text-yellow-300">SPXW King Node</strong> aligns with the{" "}
                <strong className="text-[#11cdef]">SPY King Node</strong> (approx. 10:1 ratio plus cost-of-carry basis).
              </div>
            </div>

            {/* Section 2: 0DTE Dealer Hedging in the Final 60 Minutes */}
            <div className="rounded-xl bg-[#0b0d17] border border-amber-400/40 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 font-mono font-extrabold text-white uppercase tracking-wider">
                  <Clock className="h-4 w-4 text-amber-300" />
                  <span>2. 0DTE Dealer Hedging in the Final 60 Minutes (3:00–4:00 PM ET)</span>
                </div>
                <span className="rounded-full bg-amber-400/20 px-2.5 py-0.5 text-[10px] font-mono font-bold text-amber-300">
                  Power Hour Mechanics
                </span>
              </div>

              <p className="text-slate-300">
                As time-to-expiration (<code className="text-white">T → 0</code>) collapses in the final 60 minutes of regular trading, 0DTE option gamma and charm reach extreme asymptotic levels:
              </p>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 font-mono text-[11px]">
                <div className="rounded-lg bg-[#111422] border border-teal-400/35 p-3 space-y-1.5">
                  <div className="flex items-center gap-1.5 text-teal-300 font-extrabold">
                    <Layers className="h-3.5 w-3.5" />
                    <span>3:00 – 3:30 PM: Charm Decay</span>
                  </div>
                  <p className="text-slate-300">
                    Out-of-the-money 0DTE options bleed delta rapidly toward zero (<strong className="text-white">Charm</strong>). Dealers unwind hedges on OTM puts/calls, creating a steady drift toward the <strong className="text-yellow-300">0DTE King Node</strong>.
                  </p>
                </div>

                <div className="rounded-lg bg-[#111422] border border-amber-400/35 p-3 space-y-1.5">
                  <div className="flex items-center gap-1.5 text-amber-300 font-extrabold">
                    <Zap className="h-3.5 w-3.5" />
                    <span>3:30 – 3:50 PM: Binary Pin vs. Rip</span>
                  </div>
                  <p className="text-slate-300">
                    At-the-money gamma spikes vertically. If dealers are <strong className="text-teal-300">Long γ</strong>, price locks onto the King strike within a tight ±0.15% clamp. If <strong className="text-purple-300">Short γ</strong>, crossing a strike forces violent market-order futures chasing.
                  </p>
                </div>

                <div className="rounded-lg bg-[#111422] border border-rose-400/35 p-3 space-y-1.5">
                  <div className="flex items-center gap-1.5 text-rose-300 font-extrabold">
                    <ShieldAlert className="h-3.5 w-3.5" />
                    <span>3:50 – 4:00 PM: MOC &amp; Cash Unwind</span>
                  </div>
                  <p className="text-slate-300">
                    At 3:50 PM ET, NYSE/Nasdaq publish Market-on-Close (MOC) imbalances. Because <code className="text-white">SPXW</code> cash-settles at 4:00 PM, dealers dump remaining futures hedges into the closing bell.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
