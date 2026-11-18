/**
 * Deterministic One-Cancels-Other (OCO) Bracket Order Engine
 *
 * Implements Institutional Execution Milestone 3:
 * 1. Automatic OCO Attachment on Entry:
 *    - TP1 Limit Order resting at Bid (+25% to +35% gain)
 *    - Dynamic Stop-Loss at Bid (-25% hard cap)
 * 2. Smart Sizing Allocation:
 *    - 1-Contract Position: Exits 100% at TP1 (+25% to +35% locked in). No runner held into reversal.
 *    - 2-Contract Position: Trims 1 contract at TP1 (50%), updates Stop-Loss on runner to Breakeven.
 * 3. 10:45 AM Staged Momentum Time-Stop:
 *    - If entered before 10:15 AM, checks 5m SMA34 alignment between 10:45 AM and 11:15 AM.
 *    - If stalled below SMA34 (calls) or above SMA34 (puts), liquidates at Bid to avoid midday theta crush.
 * 4. 15:55:00 ET Hard Market-On-Close Liquidation:
 *    - Force-closes all open positions at 15:55:00 ET at market Bid.
 *    - Zero positions held into 4:00 PM close or after-hours settlement.
 */

import { NbboQuote } from "@/lib/marketDataService";
import {
  etSecondsOfDay,
  formatEtMinsAsTimeString,
  getSessionBoundsEt,
  getTodayEt,
} from "@/lib/gaiaSessionGuards";

export const DEFAULT_HARD_OPTION_STOP_LOSS_PCT = 45;
export const STALL_STOP_MINUTES = 75;
export const STALL_MIN_PROFIT_PCT = 20;
export const STALL_TIGHTENED_LOSS_PCT = 38;

export interface OptionRiskStopEvaluation {
  triggered: boolean;
  stallTightened: boolean;
  activeStopLossPct: number;
  activeStopPrice: number;
  reason: "OPTION_HARD_STOP_45" | "OPTION_STALL_STOP_25" | null;
}

/**
 * Pure deterministic option-level risk evaluator:
 * - Hard option-premium stop-loss at -45% of entry price (entry * 0.55)
 * - 4-bar (20-minute) theta-stall rule: if peak option profit has not reached +20%
 *   within 20 minutes of entry, tightens stop to -25% of entry price (entry * 0.75)
 */
export function evaluateOptionRiskStop(params: {
  entryPrice: number;
  currentPrice: number;
  heldMinutes: number;
  peakPnlPct: number;
  hardStopLossPct?: number;
  stallMinutes?: number;
  stallMinProfitPct?: number;
  stallTightenedLossPct?: number;
}): OptionRiskStopEvaluation {
  const {
    entryPrice,
    currentPrice,
    heldMinutes,
    peakPnlPct,
    hardStopLossPct = DEFAULT_HARD_OPTION_STOP_LOSS_PCT,
    stallMinutes = STALL_STOP_MINUTES,
    stallMinProfitPct = STALL_MIN_PROFIT_PCT,
    stallTightenedLossPct = STALL_TIGHTENED_LOSS_PCT,
  } = params;

  const safeEntry = Math.max(0.01, entryPrice);
  const pnlPct = ((currentPrice - safeEntry) / safeEntry) * 100;
  const stallTightened =
    heldMinutes >= stallMinutes &&
    peakPnlPct < stallMinProfitPct &&
    stallTightenedLossPct < hardStopLossPct;

  const activeStopLossPct = stallTightened ? stallTightenedLossPct : hardStopLossPct;
  const rawStop = Math.max(0.05, safeEntry * (1 - activeStopLossPct / 100));
  const activeStopPrice = Number((Math.round((rawStop + Number.EPSILON) * 100) / 100).toFixed(2));

  if (currentPrice <= activeStopPrice || pnlPct <= -activeStopLossPct) {
    return {
      triggered: true,
      stallTightened,
      activeStopLossPct,
      activeStopPrice,
      reason: stallTightened ? "OPTION_STALL_STOP_25" : "OPTION_HARD_STOP_45",
    };
  }

  return {
    triggered: false,
    stallTightened,
    activeStopLossPct,
    activeStopPrice,
    reason: null,
  };
}

export interface OcoBracketConfig {
  entryPrice: number; // Executed Ask
  contractsQty: 1 | 2;
  contractType: "CALL" | "PUT";
  openedAtEt: string;
  openedTs: number;
  tp1TargetPct: number; // e.g. 30 (+30%)
  tp2TargetPct?: number; // e.g. 60 (+60%)
  stopLossMaxLossPct: number; // 45 (-45% hard loss cap) or explicit override
  stallMinutes?: number; // Default 20 (4 bars)
  stallMinProfitPct?: number; // Default +20%
  stallTightenedLossPct?: number; // Default 25 (-25%)
  target1Spot: number;
  target2Spot: number;
  stopLossSpot: number;
}

export interface OcoBracketState {
  tp1LimitPrice: number; // Limit order at Bid
  tp2LimitPrice: number; // Limit order at Bid (for runner)
  hardStopPrice: number; // Stop order at Bid (-45% or tightened -25% on stall)
  breakevenStopPrice: number;
  isTrailingBreakevenArmed: boolean;
  stagedMomentumTimeStopActive: boolean;
  peakPnlPct?: number;
  stallTightened?: boolean;
  marketOnCloseCutoffTimeEt: string;
  remainingContracts: 0 | 1 | 2;
  status: "ARMED" | "PARTIAL_TP1_FILLED" | "CLOSED";
}

export type OcoTriggerAction =
  | "HOLD"
  | "TRIM_TP1" // 2-contract position: sell 1 of 2, move runner to BE
  | "EXIT_TP1_FULL" // 1-contract position: sell 1 of 1 (100% exit)
  | "EXIT_TP2" // 2-contract position: sell final runner
  | "EXIT_STOP_LOSS" // Stop loss triggered (-45% / -25% stall / spot invalidation)
  | "EXIT_BREAKEVEN" // Runner breakeven stop triggered
  | "EXIT_TIME_STOP" // 10:45 AM momentum stall exit
  | "EXIT_MOC"; // 15:55:00 ET Market-On-Close liquidation

export interface OcoEvaluationResult {
  action: OcoTriggerAction;
  triggered: boolean;
  reason: string;
  exitPrice: number; // Executed strictly at Bid
  pnlPct: number;
  contractsToClose: 0 | 1 | 2;
  updatedBracket: OcoBracketState;
}

/**
 * Initializes deterministic OCO brackets immediately upon trade entry
 */
export function initializeOcoBrackets(config: OcoBracketConfig): OcoBracketState {
  const { entryPrice, contractsQty, openedAtEt, tp1TargetPct, tp2TargetPct = 60, stopLossMaxLossPct } = config;

  // TP1 Limit Order at Bid (+25% to +35%)
  const tp1LimitPrice = Number((entryPrice * (1 + tp1TargetPct / 100)).toFixed(2));

  // TP2 Limit Order for runner (+50% to +80%)
  const tp2LimitPrice = Number((entryPrice * (1 + tp2TargetPct / 100)).toFixed(2));

  // Hard Stop Loss at Bid (floor at $0.05)
  const effectiveStopPct = Number.isFinite(stopLossMaxLossPct)
    ? stopLossMaxLossPct
    : DEFAULT_HARD_OPTION_STOP_LOSS_PCT;
  const rawStop = Math.max(0.05, entryPrice * (1 - effectiveStopPct / 100));
  const hardStopPrice = Number((Math.round((rawStop + Number.EPSILON) * 100) / 100).toFixed(2));

  // Elapsed 30-90m staged momentum time stop is active whenever entry timestamp/time is valid
  const parsedSec = parseEtTimeSeconds(openedAtEt);
  const openedSec =
    parsedSec > 0
      ? parsedSec
      : Number.isFinite(config.openedTs) && config.openedTs > 0
        ? etSecondsOfDay(config.openedTs)
        : 0;
  const openedEtDate =
    Number.isFinite(config.openedTs) && config.openedTs > 0
      ? getTodayEt(new Date((config.openedTs > 1e11 ? Math.floor(config.openedTs / 1000) : config.openedTs) * 1000))
      : undefined;
  const sessionBounds = getSessionBoundsEt(openedEtDate);

  return {
    tp1LimitPrice,
    tp2LimitPrice,
    hardStopPrice,
    breakevenStopPrice: entryPrice,
    isTrailingBreakevenArmed: false,
    stagedMomentumTimeStopActive: openedSec > 0,
    peakPnlPct: 0,
    stallTightened: false,
    marketOnCloseCutoffTimeEt: formatEtMinsAsTimeString(sessionBounds.eodFlatMins),
    remainingContracts: contractsQty,
    status: "ARMED",
  };
}

/**
 * Parses ET time strings ("HH:MM:SS", "H:MM:SS", or "H:MM AM/PM") into integer seconds-since-midnight.
 * Eliminates ASCII lexicographical comparison bugs (e.g. "9:45:00" > "15:55:00").
 */
export function parseEtTimeSeconds(timeEt: string): number {
  const m = timeEt.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);
  if (!m) {
    return 0;
  }
  let hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  const ss = m[3] ? parseInt(m[3], 10) : 0;
  const meridiem = m[4]?.toUpperCase();
  if (!Number.isFinite(hh) || !Number.isFinite(mm) || !Number.isFinite(ss)) {
    return 0;
  }
  if (meridiem === "PM" && hh < 12) hh += 12;
  if (meridiem === "AM" && hh === 12) hh = 0;
  return (hh % 24) * 3600 + mm * 60 + ss;
}

/**
 * Evaluates resting OCO brackets against real-time market data
 */
export function evaluateOcoBrackets(params: {
  bracket: OcoBracketState;
  config: OcoBracketConfig;
  currentNbbo: NbboQuote;
  underlyingSpot: number;
  candle5m?: { close: number; sma34: number } | null;
  nowEt?: Date;
  fluxContext?: {
    netFluxJ: number;
    peclet: number;
    impulseChi: number;
    upper2Sigma?: number;
    lower2Sigma?: number;
  } | null;
}): OcoEvaluationResult {
  const { bracket, config, currentNbbo, underlyingSpot, candle5m, nowEt, fluxContext } = params;
  const now = nowEt ?? new Date();

  const totalSeconds = etSecondsOfDay(now.getTime());
  const totalMins = Math.floor(totalSeconds / 60);

  // Real-time PnL calculated from current BID (hitting the bid on exit) vs entry ASK
  const liveBid = Math.max(0.01, currentNbbo.bid);
  const pnlPct = Number((((liveBid - config.entryPrice) / Math.max(0.01, config.entryPrice)) * 100).toFixed(2));

  // Sanity check: Ensure valid bid and underlying spot price
  if (!Number.isFinite(currentNbbo.bid) || currentNbbo.bid <= 0 || !Number.isFinite(underlyingSpot) || underlyingSpot <= 0) {
    return {
      action: "HOLD",
      triggered: false,
      reason: "MARKET_DATA_WAIT · Awaiting valid bid and spot quote",
      exitPrice: liveBid,
      pnlPct: 0,
      contractsToClose: 0,
      updatedBracket: bracket,
    };
  }

  const isCall = config.contractType === "CALL";
  const updatedBracket = { ...bracket };
  const peakPnlPct = Math.max(updatedBracket.peakPnlPct ?? 0, pnlPct);
  updatedBracket.peakPnlPct = peakPnlPct;

  const heldMinutes =
    Number.isFinite(config.openedTs) && config.openedTs > 0
      ? Math.max(0, (Math.floor(now.getTime() / 1000) - config.openedTs) / 60)
      : 0;
  const stallEval = evaluateOptionRiskStop({
    entryPrice: config.entryPrice,
    currentPrice: liveBid,
    heldMinutes,
    peakPnlPct,
    hardStopLossPct: config.stopLossMaxLossPct,
    stallMinutes: config.stallMinutes ?? STALL_STOP_MINUTES,
    stallMinProfitPct: config.stallMinProfitPct ?? STALL_MIN_PROFIT_PCT,
    stallTightenedLossPct: config.stallTightenedLossPct ?? STALL_TIGHTENED_LOSS_PCT,
  });
  if (stallEval.stallTightened && !updatedBracket.stallTightened) {
    updatedBracket.stallTightened = true;
    updatedBracket.hardStopPrice = Math.max(updatedBracket.hardStopPrice, stallEval.activeStopPrice);
  }

  // 1. Arm Trailing Breakeven Stop if position gains >= 18%
  if (!updatedBracket.isTrailingBreakevenArmed && pnlPct >= 18) {
    updatedBracket.isTrailingBreakevenArmed = true;
    updatedBracket.hardStopPrice = Math.max(updatedBracket.hardStopPrice, updatedBracket.breakevenStopPrice);
  }
  if (updatedBracket.status === "PARTIAL_TP1_FILLED" && config.contractsQty === 1) {
    const runnerFloor = Number((config.entryPrice * 1.10).toFixed(2));
    if (liveBid > runnerFloor) {
      updatedBracket.breakevenStopPrice = Math.max(updatedBracket.breakevenStopPrice, runnerFloor);
      updatedBracket.hardStopPrice = Math.max(updatedBracket.hardStopPrice, runnerFloor);
    }
  }

  // --------------------------------------------------------------------------
  // RULE 1: Hard Market-On-Close Liquidation (15:55:00 ET regular / 12:55:00 ET early close)
  // --------------------------------------------------------------------------
  const sessionBounds = getSessionBoundsEt(getTodayEt(now));
  const mocTimeLabel = formatEtMinsAsTimeString(sessionBounds.eodFlatMins);
  if (totalSeconds >= sessionBounds.eodFlatMins * 60) {
    updatedBracket.status = "CLOSED";
    const closingQty = updatedBracket.remainingContracts;
    updatedBracket.remainingContracts = 0;
    return {
      action: "EXIT_MOC",
      triggered: true,
      reason: `${mocTimeLabel} ET HARD MARKET-ON-CLOSE CUTOFF (Eliminate Expiry / Theta Wipeout)`,
      exitPrice: liveBid,
      pnlPct,
      contractsToClose: closingQty,
      updatedBracket,
    };
  }

  // --------------------------------------------------------------------------
  // RULE 2: Elapsed 30-90m (6-18 Bar) Staged Momentum Time-Stop (Avoid Midday Theta Crush)
  // --------------------------------------------------------------------------
  const openedSecOfDay =
    parseEtTimeSeconds(config.openedAtEt) ||
    (config.openedTs > 0 ? etSecondsOfDay(config.openedTs) : 0);
  const elapsedClockMins =
    heldMinutes > 0
      ? heldMinutes
      : openedSecOfDay > 0 && totalSeconds >= openedSecOfDay
        ? (totalSeconds - openedSecOfDay) / 60
        : 0;
  if (
    updatedBracket.status === "ARMED" &&
    updatedBracket.stagedMomentumTimeStopActive &&
    elapsedClockMins >= 30 &&
    elapsedClockMins <= 90 &&
    pnlPct < 25 &&
    totalMins >= 0
  ) {
    const momentumFailed = isCall
      ? candle5m && candle5m.close < candle5m.sma34
      : candle5m && candle5m.close > candle5m.sma34;

    if (momentumFailed) {
      updatedBracket.status = "CLOSED";
      const closingQty = updatedBracket.remainingContracts;
      updatedBracket.remainingContracts = 0;
      return {
        action: "EXIT_TIME_STOP",
        triggered: true,
        reason: `ELAPSED ${Math.round(elapsedClockMins)}M MOMENTUM TIME-STOP (Price Stalled Beyond 5m SMA34 · Protect Capital)`,
        exitPrice: liveBid,
        pnlPct,
        contractsToClose: closingQty,
        updatedBracket,
      };
    }
  }

  // --------------------------------------------------------------------------
  // RULE 3: Target 2 Full Exit (For Runner Position OR Gap-Over TP1+TP2)
  // --------------------------------------------------------------------------
  const isTp2Hit =
    liveBid >= updatedBracket.tp2LimitPrice ||
    (isCall && underlyingSpot >= config.target2Spot) ||
    (!isCall && underlyingSpot <= config.target2Spot) ||
    pnlPct >= (config.tp2TargetPct || 60);

  if (isTp2Hit && (updatedBracket.status === "PARTIAL_TP1_FILLED" || updatedBracket.status === "ARMED")) {
    const isGapOver = updatedBracket.status === "ARMED";
    updatedBracket.status = "CLOSED";
    const closingQty = updatedBracket.remainingContracts;
    updatedBracket.remainingContracts = 0;
    return {
      action: "EXIT_TP2",
      triggered: true,
      reason: isGapOver
        ? `TARGET 2 HIT (GAP-OVER) · FULL EXIT ALL ${closingQty} CONTRACTS @ $${liveBid.toFixed(2)} (+${pnlPct}%)`
        : `TARGET 2 HIT · SELL FINAL RUNNER @ $${liveBid.toFixed(2)} (+${pnlPct}%)`,
      exitPrice: liveBid,
      pnlPct,
      contractsToClose: closingQty,
      updatedBracket,
    };
  }

  // --------------------------------------------------------------------------
  // RULE 4: Target 1 Hit (Take-Profit 1)
  // --------------------------------------------------------------------------
  if (
    updatedBracket.status === "ARMED" &&
    (liveBid >= updatedBracket.tp1LimitPrice ||
      (isCall && underlyingSpot >= config.target1Spot) ||
      (!isCall && underlyingSpot <= config.target1Spot) ||
      pnlPct >= config.tp1TargetPct)
  ) {
    if (config.contractsQty === 2) {
      // 2 contracts: Trim 1 contract (50%), move stop on runner to breakeven
      updatedBracket.status = "PARTIAL_TP1_FILLED";
      updatedBracket.remainingContracts = 1;
      updatedBracket.isTrailingBreakevenArmed = true;
      updatedBracket.hardStopPrice = updatedBracket.breakevenStopPrice;

      return {
        action: "TRIM_TP1",
        triggered: true,
        reason: `TARGET 1 HIT · SELL 1 OF 2 CONTRACTS @ $${liveBid.toFixed(
          2
        )} (+${pnlPct}%) · Move Runner Stop to Breakeven`,
        exitPrice: liveBid,
        pnlPct,
        contractsToClose: 1,
        updatedBracket,
      };
    } else if (
      !(
        fluxContext &&
        ((isCall && fluxContext.netFluxJ > 0 && (fluxContext.impulseChi > 0.72 || fluxContext.peclet >= 1.0)) ||
          (!isCall && fluxContext.netFluxJ < 0 && (fluxContext.impulseChi < 0.28 || fluxContext.peclet <= -1.0)))
      )
    ) {
      // 1 contract: exit 100% at TP1 unless Boundary Flux remains solidly aligned toward Target 2 / ±2σ
      updatedBracket.status = "CLOSED";
      updatedBracket.remainingContracts = 0;

      return {
        action: "EXIT_TP1_FULL",
        triggered: true,
        reason: `TARGET 1 HIT · FULL 100% PROFIT EXIT (1 CONTRACT) @ $${liveBid.toFixed(2)} (+${pnlPct}%)`,
        exitPrice: liveBid,
        pnlPct,
        contractsToClose: 1,
        updatedBracket,
      };
    } else {
      // Aligned Boundary Flux runner: skip EXIT_TP1_FULL and ride toward TP2,
      // ratcheting stop to BE + 10% (when liveBid clears it) so runner never turns into a full -25% loss.
      const targetRunnerFloor = Number((config.entryPrice * 1.10).toFixed(2));
      const safeRunnerFloor =
        liveBid > targetRunnerFloor
          ? targetRunnerFloor
          : liveBid > config.entryPrice
            ? config.entryPrice
            : updatedBracket.hardStopPrice;
      updatedBracket.status = "PARTIAL_TP1_FILLED";
      updatedBracket.isTrailingBreakevenArmed = true;
      updatedBracket.breakevenStopPrice = Math.max(updatedBracket.breakevenStopPrice, safeRunnerFloor);
      updatedBracket.hardStopPrice = Math.max(updatedBracket.hardStopPrice, safeRunnerFloor);
    }
  }

  // --------------------------------------------------------------------------
  // RULE 5: Stop-Loss / Breakeven Stop / Invalidation
  // --------------------------------------------------------------------------
  const isStopHit =
    liveBid <= updatedBracket.hardStopPrice ||
    stallEval.triggered ||
    pnlPct <= -stallEval.activeStopLossPct ||
    (isCall && underlyingSpot <= config.stopLossSpot) ||
    (!isCall && underlyingSpot >= config.stopLossSpot);

  if (isStopHit) {
    const isBreakeven = updatedBracket.status === "PARTIAL_TP1_FILLED" || updatedBracket.isTrailingBreakevenArmed;
    updatedBracket.status = "CLOSED";
    const closingQty = updatedBracket.remainingContracts;
    updatedBracket.remainingContracts = 0;

    return {
      action: isBreakeven ? "EXIT_BREAKEVEN" : "EXIT_STOP_LOSS",
      triggered: true,
      reason: isBreakeven
        ? `BREAKEVEN STOP HIT · SELL @ $${liveBid.toFixed(2)} (${pnlPct >= 0 ? "+" : ""}${pnlPct}%)`
        : stallEval.reason === "OPTION_STALL_STOP_25"
          ? `STALL STOP LOSS HIT (-${stallEval.activeStopLossPct}% ${STALL_STOP_MINUTES}M THETA CAP) · SELL @ $${liveBid.toFixed(2)} (${pnlPct}%)`
          : `HARD STOP LOSS HIT (-${stallEval.activeStopLossPct}% MAX LOSS) · SELL @ $${liveBid.toFixed(2)} (${pnlPct}%)`,
      exitPrice: liveBid,
      pnlPct,
      contractsToClose: closingQty,
      updatedBracket,
    };
  }

  // Default: Hold position within active brackets
  return {
    action: "HOLD",
    triggered: false,
    reason: `HOLDING WITHIN OCO BRACKETS · Current Bid $${liveBid.toFixed(2)} (${pnlPct >= 0 ? "+" : ""}${pnlPct}%)`,
    exitPrice: liveBid,
    pnlPct,
    contractsToClose: 0,
    updatedBracket,
  };
}
