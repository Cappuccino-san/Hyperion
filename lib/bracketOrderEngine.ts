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

export interface OcoBracketConfig {
  entryPrice: number; // Executed Ask
  contractsQty: 1 | 2;
  contractType: "CALL" | "PUT";
  openedAtEt: string;
  openedTs: number;
  tp1TargetPct: number; // e.g. 30 (+30%)
  tp2TargetPct?: number; // e.g. 60 (+60%)
  stopLossMaxLossPct: number; // 25 (-25%)
  target1Spot: number;
  target2Spot: number;
  stopLossSpot: number;
}

export interface OcoBracketState {
  tp1LimitPrice: number; // Limit order at Bid
  tp2LimitPrice: number; // Limit order at Bid (for runner)
  hardStopPrice: number; // Stop order at Bid (-25%)
  breakevenStopPrice: number;
  isTrailingBreakevenArmed: boolean;
  stagedMomentumTimeStopActive: boolean;
  marketOnCloseCutoffTimeEt: string;
  remainingContracts: 0 | 1 | 2;
  status: "ARMED" | "PARTIAL_TP1_FILLED" | "CLOSED";
}

export type OcoTriggerAction =
  | "HOLD"
  | "TRIM_TP1" // 2-contract position: sell 1 of 2, move runner to BE
  | "EXIT_TP1_FULL" // 1-contract position: sell 1 of 1 (100% exit)
  | "EXIT_TP2" // 2-contract position: sell final runner
  | "EXIT_STOP_LOSS" // Stop loss triggered (-25% or spot invalidation)
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

  // Hard Stop Loss at Bid (-25% max loss, floor at $0.05)
  const rawStop = Math.max(0.05, entryPrice * (1 - stopLossMaxLossPct / 100));
  const hardStopPrice = Number((Math.round((rawStop + Number.EPSILON) * 100) / 100).toFixed(2));

  // Staged momentum time stop is active if position was opened before 10:15 AM
  const openedBefore1015 =
    openedAtEt.includes("9:") ||
    openedAtEt.includes("09:") ||
    (openedAtEt.includes("10:") && parseInt(openedAtEt.split(":")[1] || "99", 10) < 15);

  return {
    tp1LimitPrice,
    tp2LimitPrice,
    hardStopPrice,
    breakevenStopPrice: entryPrice,
    isTrailingBreakevenArmed: false,
    stagedMomentumTimeStopActive: openedBefore1015,
    marketOnCloseCutoffTimeEt: "15:55:00",
    remainingContracts: contractsQty,
    status: "ARMED",
  };
}

/**
 * Parses ET time strings ("HH:MM:SS" or "H:MM:SS") into integer seconds-since-midnight.
 * Eliminates ASCII lexicographical comparison bugs (e.g. "9:45:00" > "15:55:00").
 */
export function parseEtTimeSeconds(timeEt: string): number {
  const parts = timeEt.trim().split(":").map(Number);
  if (parts.length < 2 || parts.some((n) => !Number.isFinite(n))) {
    return 0;
  }
  const [hh, mm, ss = 0] = parts;
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
}): OcoEvaluationResult {
  const { bracket, config, currentNbbo, underlyingSpot, candle5m, nowEt } = params;
  const now = nowEt ?? new Date();

  const etString = now.toLocaleTimeString("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    hourCycle: "h23",
  });
  const [rawHours, minutes, seconds = 0] = etString.split(":").map(Number);
  const hours = rawHours % 24;
  const totalMins = hours * 60 + minutes;
  const totalSeconds = hours * 3600 + minutes * 60 + seconds;

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

  // 1. Arm Trailing Breakeven Stop if position gains >= 18%
  if (!updatedBracket.isTrailingBreakevenArmed && pnlPct >= 18) {
    updatedBracket.isTrailingBreakevenArmed = true;
    updatedBracket.hardStopPrice = updatedBracket.breakevenStopPrice;
  }

  // --------------------------------------------------------------------------
  // RULE 1: 15:55:00 ET Hard Market-On-Close Liquidation
  // --------------------------------------------------------------------------
  if (totalSeconds >= 15 * 3600 + 55 * 60) {
    updatedBracket.status = "CLOSED";
    const closingQty = updatedBracket.remainingContracts;
    updatedBracket.remainingContracts = 0;
    return {
      action: "EXIT_MOC",
      triggered: true,
      reason: "15:55:00 ET HARD MARKET-ON-CLOSE CUTOFF (Eliminate Expiry / Theta Wipeout)",
      exitPrice: liveBid,
      pnlPct,
      contractsToClose: closingQty,
      updatedBracket,
    };
  }

  // --------------------------------------------------------------------------
  // RULE 2: 10:45 AM Staged Momentum Time-Stop (Avoid Midday Theta Crush)
  // --------------------------------------------------------------------------
  if (
    updatedBracket.status === "ARMED" &&
    updatedBracket.stagedMomentumTimeStopActive &&
    totalMins >= 10 * 60 + 45 &&
    totalMins <= 11 * 60 + 15 &&
    pnlPct < 25
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
        reason: "10:45 AM MOMENTUM TIME-STOP (Price Stalled Below 5m SMA34 · Protect Capital)",
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
    } else {
      // 1 contract: In disciplined small-account trading, exit 100% at TP1!
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
    }
  }

  // --------------------------------------------------------------------------
  // RULE 5: Stop-Loss / Breakeven Stop / Invalidation
  // --------------------------------------------------------------------------
  const isStopHit =
    liveBid <= updatedBracket.hardStopPrice ||
    pnlPct <= -config.stopLossMaxLossPct ||
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
        : `HARD STOP LOSS HIT (-25% MAX LOSS) · SELL @ $${liveBid.toFixed(2)} (${pnlPct}%)`,
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
