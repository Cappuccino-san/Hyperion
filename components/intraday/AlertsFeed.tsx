"use client";

import React, { useEffect, useRef, useState, useCallback } from "react";
import { useDashboardStore } from "@/store/useDashboardStore";

interface OptionTradePositionUI {
  id: string;
  ticker: string;
  contractType: "CALL" | "PUT";
  contractLabel: string;
  strike: number;
  expiration: string;
  setupName: string;
  status: "OPEN" | "PARTIAL_TP1" | "CLOSED";
  btoSpotPrice: number;
  btoOptionMid: number | null;
  contractsQty?: 1 | 2;
  remainingQty?: 0 | 1 | 2;
  totalOutlay?: number;
  estTp1Mid?: number;
  estTp2Mid?: number;
  estStopMid?: number;
  tp1Pct?: number;
  tp2Pct?: number;
  target1Spot: number;
  target2Spot: number;
  stopLossSpot: number;
  openedAt: string;
  rrRatio?: number;
}

export function AlertsFeed() {
  const alerts = useDashboardStore((state) => state.alerts);
  const activeTicker = useDashboardStore((state) => state.activeTicker);
  const discordConfig = useDashboardStore((state) => state.discordConfig);
  const gammaLevels = useDashboardStore((state) => state.gammaLevels);
  const gammaLevelsByFilter = useDashboardStore((state) => state.gammaLevelsByFilter);
  const kingNode = useDashboardStore((state) => state.kingNode);
  const allExpKingNode = useDashboardStore((state) => state.allExpKingNode);
  const flowGammaVwapData = useDashboardStore((state) => state.flowGammaVwapData);
  const chainStrikes = useDashboardStore((state) => state.chainStrikes);
  const chainExpirations = useDashboardStore((state) => state.chainExpirations);
  const expectedMoves = useDashboardStore((state) => state.expectedMoves);
  const spotPrice = useDashboardStore((state) => state.spotPrice);
  const setSetupModalOpen = useDashboardStore((state) => state.setSetupModalOpen);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

  // Tactical 0DTE / Next-Exp levels for intraday Pre-Trade Radar
  // Anchors BTO Put triggers and Call triggers to 0DTE walls instead of distant all-expiration LEAPS outliers ($800)
  const zeroDteLevels = gammaLevelsByFilter?.["0DTE"] ?? gammaLevelsByFilter?.["THIS_WEEK"];
  const currentSpot = spotPrice || 764;

  const tacticalCallWall =
    zeroDteLevels?.callWall && zeroDteLevels.callWall > 0
      ? zeroDteLevels.callWall
      : gammaLevels?.callWall && spotPrice && Math.abs(gammaLevels.callWall - spotPrice) / spotPrice < 0.025
        ? gammaLevels.callWall
        : Math.round(currentSpot * 1.008);

  const rawTacticalPutWall =
    zeroDteLevels?.putWall && zeroDteLevels.putWall > 0
      ? zeroDteLevels.putWall
      : gammaLevels?.putWall && spotPrice && Math.abs(spotPrice - gammaLevels.putWall) / spotPrice < 0.025
        ? gammaLevels.putWall
        : Math.round(currentSpot * 0.992);

  // Sanitize distant multi-day Put Wall (> 0.95% below spot, e.g. $755 when SPY is $766) to nearest local negative-GEX node (e.g. $762)
  const tacticalPutWall = React.useMemo(() => {
    if (
      rawTacticalPutWall > 0 &&
      (currentSpot - rawTacticalPutWall) / currentSpot > 0.0095 &&
      chainStrikes.length > 0 &&
      chainExpirations.length > 0
    ) {
      const nearExpId = chainExpirations[0].id;
      let bestStrike = 0;
      let minGex = 0;
      for (const row of chainStrikes) {
        if (row.strike < currentSpot - 0.5 && (currentSpot - row.strike) / currentSpot <= 0.0095) {
          const g = row.gex[nearExpId] ?? 0;
          if (g < minGex) {
            minGex = g;
            bestStrike = row.strike;
          }
        }
      }
      if (bestStrike > 0) return bestStrike;
    }
    return rawTacticalPutWall;
  }, [rawTacticalPutWall, currentSpot, chainStrikes, chainExpirations]);

  const tacticalZeroGamma =
    zeroDteLevels?.zeroGamma && zeroDteLevels.zeroGamma > 0
      ? zeroDteLevels.zeroGamma
      : gammaLevels?.zeroGamma;

  // Institutional 3-Tier Multi-Horizon Execution:
  // Tier 1: Tactical Support & Resistance (0DTE Expected Move & Local Gamma Nodes: e.g. $762 & $767/$768)
  // Tier 2: Midday Equilibrium Pivot (e.g. Strike $765 where gamma / VWAP sits)
  // Tier 3: Macro Tail Boundaries (King / 0DTE Walls: e.g. $760 & $770)
  const dailyEm = expectedMoves?.daily;
  const emLow = dailyEm && dailyEm.low > 0 ? dailyEm.low : 0;
  const emHigh = dailyEm && dailyEm.high > 0 ? dailyEm.high : 0;
  const dailySigma =
    dailyEm && (dailyEm as any).sigma > 0
      ? Number((dailyEm as any).sigma)
      : emHigh > emLow
        ? (emHigh - emLow) / 2
        : currentSpot * 0.008;

  const allExpKing = kingNode?.allExpKing ?? allExpKingNode?.allExpKing ?? 0;
  const tacticalKing =
    kingNode?.zeroDteKing ??
    allExpKingNode?.zeroDteKing ??
    kingNode?.weeklyKing ??
    allExpKing;
  const hasZeroDte = kingNode?.hasZeroDte ?? allExpKingNode?.hasZeroDte ?? false;

  const distToAllExpKing = allExpKing > 0 ? Math.abs(currentSpot - allExpKing) : 0;
  const isDistantKingTrap =
    allExpKing > 0 &&
    tacticalKing > 0 &&
    allExpKing !== tacticalKing &&
    (distToAllExpKing > dailySigma * 0.85 || distToAllExpKing / currentSpot > 0.0095);

  const flowVwap = flowGammaVwapData?.flowVwap ?? 0;
  const isAboveVwap = flowVwap > 0 ? currentSpot >= flowVwap : true;

  const tacticalSupport =
    emLow > 0 && emLow > tacticalPutWall && Math.abs(currentSpot - emLow) / currentSpot < 0.02
      ? Math.round(emLow)
      : (currentSpot - tacticalPutWall) / currentSpot > 0.0095
        ? Math.round(currentSpot * 0.9935)
        : tacticalPutWall;

  const tacticalResistance =
    tacticalKing > currentSpot && tacticalKing <= tacticalCallWall
      ? tacticalKing
      : emHigh > 0 && emHigh < tacticalCallWall && Math.abs(emHigh - currentSpot) / currentSpot < 0.02
        ? Math.round(emHigh)
        : tacticalCallWall;

  const pivotMid = Number(((tacticalSupport + tacticalResistance) / 2).toFixed(1));
  const tacticalPivot =
    tacticalZeroGamma && tacticalZeroGamma > tacticalSupport && tacticalZeroGamma < tacticalResistance
      ? tacticalZeroGamma
      : flowVwap > tacticalSupport && flowVwap < tacticalResistance
        ? Number(flowVwap.toFixed(1))
        : Math.round(pivotMid);

  // Directional Targets Invariant:
  // For CALL: entry at tacticalSupport, target 1 at tacticalPivot, target 2 at tacticalResistance.
  // For PUT:  entry at tacticalResistance, target 1 at tacticalPivot, target 2 at tacticalSupport.
  const callTarget1 = tacticalPivot;
  const callTarget2 = tacticalResistance;

  const putTarget1 = tacticalPivot;
  const putTarget2 = tacticalSupport;

  const [activePosition, setActivePosition] = useState<OptionTradePositionUI | null>(null);
  const [signalAlerts, setSignalAlerts] = useState<
    { id: string; timestamp: string; message: string; ts?: number }[]
  >([]);
  const [closedCount, setClosedCount] = useState<number>(0);
  const [radarSending, setRadarSending] = useState(false);

  const handleSendRadar = async () => {
    try {
      setRadarSending(true);
      await fetch("/api/signals?action=send_radar");
      await fetchSignals();
    } catch {
      // ignore
    } finally {
      setRadarSending(false);
    }
  };

  const isConfigured = Boolean(discordConfig?.enabled && discordConfig?.webhookUrl);

  const fetchSignals = useCallback(async () => {
    try {
      const res = await fetch(`/api/signals?ticker=${encodeURIComponent(activeTicker)}`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = await res.json();
      const pos = data?.activePositions?.[activeTicker] ?? null;
      setActivePosition(pos);
      if (Array.isArray(data?.alerts)) {
        setSignalAlerts(data.alerts);
      }
      if (Array.isArray(data?.closedPositions)) {
        setClosedCount(data.closedPositions.length);
      }
    } catch {
      // Non-fatal
    }
  }, [activeTicker]);

  // Combine execution signal alerts from /api/signals with structural wall alerts from store
  const combinedAlerts = React.useMemo(() => {
    const map = new Map<string, { id: string; timestamp: string; message: string }>();
    for (const sa of signalAlerts) {
      if (sa && sa.message) {
        map.set(sa.message, {
          id: sa.id,
          timestamp: sa.timestamp,
          message: sa.message,
        });
      }
    }
    for (const a of alerts) {
      if (a && a.message && !map.has(a.message)) {
        map.set(a.message, {
          id: a.id,
          timestamp: a.timestamp,
          message: a.message,
        });
      }
    }
    const list = Array.from(map.values());
    // Put BTO / STC execution alerts at the bottom (most prominent in auto-scrolled log) or top
    return list;
  }, [signalAlerts, alerts]);

  useEffect(() => {
    fetchSignals();
    const interval = setInterval(fetchSignals, 5000);
    return () => clearInterval(interval);
  }, [fetchSignals]);

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [combinedAlerts]);

  return (
    <div className="argon-card rounded-xl p-4">
      {/* Header: ALERTS on left, posting to Discord on right */}
      <div className="flex items-center justify-between border-b border-white/10 pb-2 mb-2">
        <div className="flex items-center gap-2">
          <h4 className="text-[10px] font-mono font-bold uppercase tracking-widest text-slate-400">
            ALERTS &amp; EXECUTION SIGNALS
          </h4>
          <span className="rounded bg-emerald-500/10 px-1.5 py-0.2 text-[9px] font-mono font-semibold text-emerald-400 border border-emerald-500/20">
            BTO / STC
          </span>
          {signalAlerts.length > 0 && (
            <span className="rounded bg-sky-500/15 px-1.5 py-0.2 text-[9px] font-mono font-semibold text-sky-300 border border-sky-500/30">
              {signalAlerts.length} Signal{signalAlerts.length === 1 ? "" : "s"} Today
            </span>
          )}
          {closedCount > 0 && (
            <span className="rounded bg-amber-500/15 px-1.5 py-0.2 text-[9px] font-mono font-semibold text-amber-300 border border-amber-500/30">
              {closedCount} Closed
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => setSetupModalOpen(true)}
          className="inline-flex items-center gap-1.5 text-[11px] font-mono hover:text-white transition-colors cursor-pointer"
        >
          {isConfigured ? (
            <>
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.8)]" />
              <span className="text-emerald-400 font-medium">posting to Discord</span>
            </>
          ) : (
            <span className="text-slate-500 font-normal">Discord posting off</span>
          )}
        </button>
      </div>

      {/* Active Position Tracking Card */}
      {activePosition && (
        <div className="mb-2.5 rounded-lg border border-emerald-500/30 bg-emerald-950/20 p-2.5 font-mono">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
              </span>
              <span className="text-xs font-bold text-emerald-400">
                ACTIVE {activePosition.contractsQty ? `${activePosition.contractsQty}x ` : ""}
                {activePosition.contractType}: {activePosition.contractLabel}
              </span>
              {activePosition.totalOutlay && (
                <span className="text-[10px] text-slate-400">
                  (${activePosition.totalOutlay} Outlay)
                </span>
              )}
            </div>
            <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-300">
              {activePosition.status === "PARTIAL_TP1"
                ? `Scaled TP1 · Stop @ BE (${activePosition.remainingQty ?? 1} Runner)`
                : `${activePosition.contractsQty ?? 1}x Active Runner`}
            </span>
          </div>

          <div className="mt-2 grid grid-cols-4 gap-2 text-[11px] border-t border-white/5 pt-1.5">
            <div>
              <span className="text-[9.5px] uppercase text-slate-400 block font-semibold">Entry Spot</span>
              <span className="text-slate-200 font-bold">${activePosition.btoSpotPrice.toFixed(2)}</span>
            </div>
            <div>
              <span className="text-[9.5px] uppercase text-slate-400 block font-semibold">TP1 (Trim 50%)</span>
              <span className="text-amber-300 font-bold">${activePosition.target1Spot.toFixed(2)}</span>
            </div>
            <div>
              <span className="text-[9.5px] uppercase text-slate-400 block font-semibold">TP2 (Runner)</span>
              <span className="text-emerald-300 font-bold">${activePosition.target2Spot.toFixed(2)}</span>
            </div>
            <div>
              <span className="text-[9.5px] uppercase text-slate-400 block font-semibold">
                {activePosition.status === "PARTIAL_TP1" ? "BE Stop" : "Stop Loss"}
              </span>
              <span
                className={`font-bold ${
                  activePosition.status === "PARTIAL_TP1" ? "text-amber-400" : "text-rose-400"
                }`}
              >
                ${activePosition.stopLossSpot.toFixed(2)}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Pre-Trade Radar & Game Plan (When Flat) */}
      {!activePosition && (
        <div className="mb-2.5 rounded-lg border border-sky-500/25 bg-sky-950/20 p-2.5 font-mono text-[11px]">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/5 pb-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-sky-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-sky-500"></span>
              </span>
              <span className="text-[10px] uppercase font-bold text-sky-400 tracking-wider">
                PRE-TRADE RADAR · {activeTicker} (${spotPrice ? spotPrice.toFixed(2) : "---"})
              </span>
              {tacticalKing > 0 && (
                <span className="rounded bg-cyan-500/15 border border-cyan-500/35 px-1.5 py-0.5 text-[9.5px] font-bold text-cyan-300">
                  {hasZeroDte ? "0DTE" : "Tactical"} King ${tacticalKing}
                </span>
              )}
              {flowVwap > 0 && (
                <span
                  className={`rounded px-1.5 py-0.5 text-[9px] font-bold border ${
                    isAboveVwap
                      ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300"
                      : "bg-rose-500/10 border-rose-500/30 text-rose-300"
                  }`}
                >
                  {isAboveVwap ? `ABOVE VWAP ($${flowVwap.toFixed(2)}) · BULL BIAS` : `BELOW VWAP ($${flowVwap.toFixed(2)}) · BEAR BIAS`}
                </span>
              )}
            </div>
            <button
              onClick={handleSendRadar}
              disabled={radarSending}
              className="text-[9.5px] px-2 py-0.5 rounded bg-sky-500/10 hover:bg-sky-500/20 border border-sky-500/30 text-sky-300 transition-colors disabled:opacity-50 cursor-pointer"
            >
              {radarSending ? "Updating..." : "📡 Post Chart to Discord"}
            </button>
          </div>

          {isDistantKingTrap && (
            <div className="mt-2 rounded border border-amber-500/40 bg-amber-950/35 px-2.5 py-1.5 text-[10px] text-amber-200 leading-snug">
              <strong className="text-amber-400 uppercase tracking-wide">
                ⚠️ Distant King Trap Guardrail:
              </strong>{" "}
              All-Exp King <strong className="text-yellow-300">${allExpKing}</strong> is{" "}
              <strong>{distToAllExpKing.toFixed(1)} pts</strong> away on later expirations, while{" "}
              <strong className="text-cyan-300">
                {hasZeroDte ? "0DTE" : "Next-Exp"} Tactical King is ${tacticalKing}
              </strong>
              .{" "}
              {tacticalKing >= currentSpot - 1.5 && isAboveVwap
                ? `Price is pinning toward $${tacticalKing} above VWAP — DO NOT short HOD or buy deep OTM $${allExpKing} Puts until 5m closes below SMA34 & $${tacticalPivot}!`
                : `Trade local range ($${tacticalSupport}–$${tacticalResistance}) with ATM/1-OTM strikes ($${Math.round(currentSpot) - 2}–$${Math.round(currentSpot) + 2}); avoid deep OTM $${allExpKing} lottery strikes.`}
            </div>
          )}

          <div className="mt-2 grid grid-cols-2 gap-2 text-[10.5px]">
            <div className="rounded bg-black/25 p-2 border border-emerald-500/20">
              <div className="flex items-center justify-between mb-1">
                <span className="text-emerald-400 font-bold text-[10px]">🟢 BTO CALL TRIGGER</span>
                <span className="text-slate-400 text-[9px]">
                  {tacticalKing >= currentSpot ? `Magnet Pull / Bounce` : `Bounce Setup`}
                </span>
              </div>
              <span className="text-slate-200 block text-[11px] leading-tight">
                Support Bounce near <strong className="text-emerald-300">${tacticalSupport}</strong>{" "}
                or Hold above <strong className="text-emerald-300">${tacticalPivot}</strong>
              </span>
              <span className="text-slate-400 text-[9.5px] block mt-1">
                Target: ${callTarget1.toFixed(1)} / ${callTarget2} · Strike: ${Math.round(currentSpot)}C–${Math.round(callTarget2)}C
              </span>
            </div>

            <div className="rounded bg-black/25 p-2 border border-purple-500/20">
              <div className="flex items-center justify-between mb-1">
                <span className="text-purple-400 font-bold text-[10px]">🟣 BTO PUT TRIGGER</span>
                <span className="text-slate-400 text-[9px]">
                  {tacticalKing >= currentSpot - 1 && isAboveVwap ? "Wait for Breakdown" : "Rejection Setup"}
                </span>
              </div>
              <span className="text-slate-200 block text-[11px] leading-tight">
                Rejection near <strong className="text-purple-300">${tacticalResistance}</strong>{" "}
                <span className="text-amber-300/90 text-[9.5px]">(Requires 5m &lt; SMA34)</span>
              </span>
              <span className="text-slate-400 text-[9.5px] block mt-1">
                Target: ${putTarget1.toFixed(1)} / ${putTarget2} · Max OTM: ${Math.max(putTarget2, Math.round(currentSpot) - 3)}P
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Events List */}
      <div
        ref={scrollContainerRef}
        className="max-h-48 overflow-y-auto argon-scrollbar divide-y divide-white/5"
      >
        {combinedAlerts.length === 0 ? (
          <div className="py-2 font-mono text-xs text-slate-500">
            No events yet — monitoring live structure for BTO entries and STC profit exits.
          </div>
        ) : (
          combinedAlerts.map((alert) => {
            const isBto = alert.message.includes("BUY TO OPEN");
            const isStc = alert.message.includes("STC") || alert.message.includes("SELL TO CLOSE");

            return (
              <div
                key={alert.id}
                className={`flex items-baseline gap-3 py-1.5 font-mono text-[11.5px] ${
                  isBto
                    ? "bg-emerald-500/5 px-1.5 rounded"
                    : isStc
                      ? "bg-amber-500/5 px-1.5 rounded"
                      : ""
                }`}
              >
                <span className="text-slate-500 tabular-nums shrink-0 text-[11px]">
                  {alert.timestamp}
                </span>
                <span
                  className={`leading-relaxed font-medium ${
                    isBto
                      ? "text-emerald-300 font-semibold"
                      : isStc
                        ? "text-amber-200 font-semibold"
                        : "text-[#cbd5e1]"
                  }`}
                >
                  {alert.message}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
