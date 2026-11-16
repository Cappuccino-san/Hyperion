"use client";

import React, { useState } from "react";
import { PlaybookPick, PlaybookExecutionStatus } from "@/lib/types/playbook";
import { cn } from "@/lib/utils";
import { evaluateExecutionStatus, computeTargetProgress } from "@/lib/playbookEngine";
import { 
  ArrowUpRight, 
  ArrowDownRight, 
  Target, 
  ShieldAlert, 
  Crosshair, 
  Crown, 
  Zap, 
  Copy, 
  Check, 
  ExternalLink,
  Activity,
  AlertTriangle
} from "lucide-react";

interface PlaybookCardProps {
  pick: PlaybookPick;
  rank?: number;
  liveSpot?: number;
  onSelectTicker?: (ticker: string) => void;
}

const f2 = (v: number | string, d = 2) => {
  if (typeof v === "string") return v;
  if (isNaN(v)) return String(v);
  return Number(v).toLocaleString("en-US", {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });
};

export function PlaybookCard({ pick, rank, liveSpot, onSelectTicker }: PlaybookCardProps) {
  const isCall = pick.type === "CALL";
  const [copied, setCopied] = useState(false);

  // Determine current active spot: prop liveSpot > pick.currentSpot > priorClose
  const currentSpot = liveSpot ?? pick.currentSpot ?? pick.priorClose;
  const status: PlaybookExecutionStatus =
    liveSpot != null && liveSpot > 0
      ? evaluateExecutionStatus(pick, currentSpot)
      : (pick.status ?? evaluateExecutionStatus(pick, currentSpot));
  const progressPct = computeTargetProgress(pick, currentSpot);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    // Institutional Copy & Export format:
    // {TICKER} {SIDE} | Entry: {trigger} | Stop: {stop} | T1: {target1} | T2 (EM): {target2}
    const institutionalSpec = `${pick.ticker} ${pick.type} | Entry: ${pick.entryTrigger} | Stop: ${pick.stopLoss} | T1: $${f2(pick.target1)} | T2 (EM): $${f2(pick.target2)}`;
    navigator.clipboard?.writeText(institutionalSpec).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      className={cn(
        "relative flex flex-col justify-between bg-[#101520] border border-[#1e2638] rounded-xl p-4 transition-all duration-200",
        "hover:border-slate-700/80 hover:shadow-xl hover:shadow-black/40",
        isCall
          ? "border-l-4 border-l-[#10b981]"
          : "border-l-4 border-l-[#ef4444]"
      )}
    >
      {/* 1. Header: Ticker, Type Badge, Prior Close & Live Trigger State Badge */}
      <div>
        <div className="flex items-center justify-between gap-2 mb-2.5">
          <div className="flex items-center gap-2">
            {rank != null && (
              <span className="text-slate-500 font-mono font-bold text-xs">
                #{rank}
              </span>
            )}
            <button
              type="button"
              onClick={() => onSelectTicker?.(pick.ticker)}
              className="group/t inline-flex items-center gap-1.5 text-lg font-black text-white hover:text-cyan-400 transition-colors"
              title={`Open ${pick.ticker} in Gaia`}
            >
              <span>{pick.ticker}</span>
              <ExternalLink className="w-3.5 h-3.5 opacity-0 group-hover/t:opacity-100 transition-opacity text-cyan-400" />
            </button>
            <span
              className={cn(
                "inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-mono font-bold tracking-wide border",
                isCall
                  ? "bg-[#10b981]/15 text-[#10b981] border-[#10b981]/40"
                  : "bg-[#ef4444]/15 text-[#ef4444] border-[#ef4444]/40"
              )}
            >
              {isCall ? (
                <>
                  <ArrowUpRight className="w-3.5 h-3.5" />
                  <span>CALL</span>
                </>
              ) : (
                <>
                  <ArrowDownRight className="w-3.5 h-3.5" />
                  <span>PUT</span>
                </>
              )}
            </span>
          </div>

          {/* Live Trigger State Badge */}
          <div className="flex items-center gap-2">
            {status === "PENDING" && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-slate-800 text-slate-300 border border-slate-700">
                <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />
                PENDING
              </span>
            )}
            {status === "TRIGGERED" && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40 animate-pulse">
                <Activity className="w-3 h-3 text-amber-400" />
                TRIGGERED
              </span>
            )}
            {status === "T1 HIT" && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                <Check className="w-3 h-3 text-emerald-400" />
                TARGET 1 HIT
              </span>
            )}
            {status === "T2 HIT" && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-cyan-500/20 text-cyan-300 border border-cyan-500/40">
                <Target className="w-3 h-3 text-cyan-400" />
                T2 HIT (EM)
              </span>
            )}
            {status === "STOPPED" && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-rose-950/60 text-rose-400 border border-rose-800/80">
                <AlertTriangle className="w-3 h-3 text-rose-400" />
                STOPPED
              </span>
            )}
          </div>
        </div>

        {/* Pricing Subheader & King Node Badges */}
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <div className="flex flex-wrap items-center gap-2">
            {pick.gexKing && pick.gexKing !== "n/a" && (
              <span
                style={{
                  color: "#facc15",
                  backgroundColor: "rgba(250, 204, 21, 0.15)",
                  borderColor: "rgba(250, 204, 21, 0.35)",
                }}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-mono font-bold border drop-shadow-[0_0_8px_rgba(250,204,21,0.2)]"
              >
                <Crown className="w-3 h-3 text-[#facc15]" />
                <span>GEX King: {f2(pick.gexKing, 0)}</span>
              </span>
            )}

            {pick.vexKing && pick.vexKing !== "n/a" && (
              <span
                style={{
                  color: "#c084fc",
                  backgroundColor: "rgba(139, 92, 246, 0.15)",
                  borderColor: "rgba(139, 92, 246, 0.35)",
                }}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-mono font-bold border"
              >
                <Zap className="w-3 h-3 text-[#c084fc]" />
                <span>VEX King: {f2(pick.vexKing, 0)}</span>
              </span>
            )}
          </div>

          <div className="flex items-center gap-3 text-right">
            <div>
              <span className="block text-[10px] text-slate-400 font-sans">
                Prior Close
              </span>
              <span className="font-mono font-bold text-xs text-slate-300 tabular-nums">
                ${f2(pick.priorClose)}
              </span>
            </div>
            {currentSpot != null && (
              <div>
                <span className="block text-[10px] text-cyan-400 font-sans font-medium">
                  Live Spot
                </span>
                <span className="font-mono font-bold text-xs text-white tabular-nums">
                  ${f2(currentSpot)}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* 2. Execution Box: Entry Trigger & Stop Loss */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 p-2.5 rounded-lg bg-[#0a0d14]/80 border border-[#1e2638] mb-3">
          {/* Entry Trigger */}
          <div className="space-y-0.5">
            <div className="flex items-center gap-1 text-[11px] text-slate-400 font-sans font-medium">
              <Crosshair
                className={cn(
                  "w-3.5 h-3.5",
                  isCall ? "text-emerald-400" : "text-rose-400"
                )}
              />
              <span>ENTRY TRIGGER</span>
            </div>
            <div
              className={cn(
                "font-mono font-bold text-xs tracking-tight tabular-nums",
                isCall ? "text-emerald-300" : "text-rose-300"
              )}
            >
              {pick.entryTrigger}
            </div>
          </div>

          {/* Stop Loss */}
          <div className="space-y-0.5">
            <div className="flex items-center gap-1 text-[11px] text-slate-400 font-sans font-medium">
              <ShieldAlert className="w-3.5 h-3.5 text-amber-400" />
              <span>STOP LOSS</span>
            </div>
            <div className="font-mono font-bold text-xs text-amber-300/90 tracking-tight tabular-nums">
              {pick.stopLoss}
            </div>
          </div>
        </div>

        {/* 3. Profit Targets: T1 & T2 (Expected Move Boundary) */}
        <div className="grid grid-cols-2 gap-2 mb-2.5">
          <div className="bg-[#141b2a]/60 border border-[#1e2638]/70 rounded-lg p-2">
            <div className="flex items-center justify-between text-[11px] text-slate-400 font-sans mb-0.5">
              <span>TARGET 1</span>
              <Target className="w-3 h-3 text-slate-500" />
            </div>
            <div className="font-mono font-bold text-sm text-slate-100 tabular-nums">
              ${f2(pick.target1)}
            </div>
            <div className="text-[10px] text-slate-500 font-sans">
              Scale 50% · Move SL to BE
            </div>
          </div>

          <div className="bg-[#141b2a]/60 border border-[#1e2638]/70 rounded-lg p-2">
            <div className="flex items-center justify-between text-[11px] text-slate-400 font-sans mb-0.5">
              <span>TARGET 2 (RUNNER)</span>
              <span
                className={cn(
                  "text-[10px] font-mono font-bold px-1 rounded",
                  isCall
                    ? "text-emerald-400 bg-emerald-500/10"
                    : "text-rose-400 bg-rose-500/10"
                )}
              >
                {isCall ? "D↑ edge" : "D↓ edge"}
              </span>
            </div>
            <div
              className={cn(
                "font-mono font-bold text-sm tabular-nums",
                isCall ? "text-emerald-400" : "text-rose-400"
              )}
            >
              ${f2(pick.target2)}
            </div>
            <div className="text-[10px] text-slate-500 font-sans">
              Expected Move boundary
            </div>
          </div>
        </div>

        {/* 4. Progress to Target Visualizer Rail */}
        <div className="bg-[#0a0d14]/70 border border-[#1e2638]/70 rounded-lg p-2 mb-3 space-y-1">
          <div className="flex items-center justify-between text-[10px] font-mono text-slate-400">
            <span>Entry (${f2(pick.entryTriggerPrice)})</span>
            <span className="text-slate-500">T1 (${f2(pick.target1)})</span>
            <span className={isCall ? "text-emerald-400" : "text-rose-400"}>
              T2 (${f2(pick.target2)})
            </span>
          </div>

          <div className="relative h-1.5 w-full bg-[#111624] rounded-full overflow-hidden">
            <div
              className={cn(
                "h-full rounded-full transition-all duration-300",
                status === "STOPPED"
                  ? "bg-rose-500"
                  : status === "T2 HIT"
                  ? "bg-cyan-400"
                  : status === "T1 HIT"
                  ? "bg-emerald-400"
                  : status === "TRIGGERED"
                  ? "bg-amber-400 animate-pulse"
                  : "bg-slate-700/60"
              )}
              style={{ width: `${Math.max(3, Math.min(100, progressPct))}%` }}
            />
          </div>

          <div className="flex items-center justify-between text-[9.5px] font-mono text-slate-500 pt-0.5">
            <span>
              {status === "PENDING"
                ? "Awaiting breakout confirmation"
                : `${progressPct}% distance covered to T2`}
            </span>
            {currentSpot != null && (
              <span className="text-slate-400">
                Spot: <b className="text-white">${f2(currentSpot)}</b>
              </span>
            )}
          </div>
        </div>

        {/* 5. Expected Move Boundary Details */}
        <div className="flex items-center justify-between py-1.5 px-2.5 rounded bg-[#111624]/60 border border-[#1e2638]/40 text-[11px] font-mono mb-3">
          <span className="text-slate-400 font-sans text-[11px]">
            0DTE Expected Move:
          </span>
          <div className="flex items-center gap-2">
            <span className="text-white font-bold tabular-nums">
              ±${f2(pick.expectedMove.value)}
            </span>
            <span className="text-slate-500 text-[10px] tabular-nums">
              (${f2(pick.expectedMove.low)} – ${f2(pick.expectedMove.high)})
            </span>
          </div>
        </div>

        {/* 6. Tactical Thesis ("Why") */}
        <div className="bg-[#141b2a]/40 border border-[#1e2638]/60 rounded-lg p-2.5 mb-3 text-xs text-slate-300 font-sans leading-relaxed">
          <span className="font-semibold text-slate-200 block mb-0.5 text-[11px] uppercase tracking-wider">
            Tactical Thesis
          </span>
          {pick.why}
        </div>
      </div>

      {/* 7. Footer Actions */}
      <div className="pt-2 border-t border-[#1e2638]/70 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center gap-1.5 text-[11px] font-mono text-slate-400 hover:text-white transition-colors cursor-pointer"
          title="Copy institutional execution specification"
        >
          {copied ? (
            <>
              <Check className="w-3.5 h-3.5 text-emerald-400" />
              <span className="text-emerald-400">Copied</span>
            </>
          ) : (
            <>
              <Copy className="w-3.5 h-3.5" />
              <span>Copy plan</span>
            </>
          )}
        </button>

        {onSelectTicker && (
          <button
            type="button"
            onClick={() => onSelectTicker(pick.ticker)}
            className="inline-flex items-center gap-1 text-[11px] font-semibold text-cyan-400 hover:text-cyan-300 transition-colors cursor-pointer"
          >
            <span>Open {pick.ticker} Gaia</span>
            <ExternalLink className="w-3 h-3" />
          </button>
        )}
      </div>
    </div>
  );
}
