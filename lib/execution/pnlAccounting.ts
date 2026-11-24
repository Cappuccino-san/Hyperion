/**
 * Canonical Realized P&L & R-Multiple Accounting Helper.
 * Single source of truth shared across:
 * - /api/session-recap
 * - lib/agenticSupervisor.ts (trailing 5-day equity & post-market attribution)
 * - lib/tradePerformanceEngine.ts
 * - lib/execution/signalScoring.ts (causal [D-10, D-1] Empirical Bayes calibration)
 *
 * Hard invariant: 1R = 45% hard option stop risk (0.45 * outlay), never 25%.
 */

import { DEFAULT_HARD_OPTION_STOP_LOSS_PCT } from "@/lib/bracketOrderEngine";

export interface CanonicalTradePnl {
  entryPrice: number;
  exitPrice: number;
  contractsQty: number;
  outlay: number;
  realizedDollarPnl: number;
  pnlOptionPct: number;
  riskDollars: number;
  rMultiple: number;
}

function firstPositiveNum(...vals: unknown[]): number | null {
  for (const v of vals) {
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  }
  return null;
}

function firstFiniteNum(...vals: unknown[]): number | null {
  for (const v of vals) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

export function computeTradeRealizedPnl(trade: unknown): CanonicalTradePnl {
  const raw = (trade && typeof trade === "object" ? trade : {}) as Record<string, unknown>;
  const qty = Math.max(1, Number(raw.contractsQty) || 1);

  const entryPrice =
    firstPositiveNum(
      raw.btoOptionAsk,
      raw.optionAsk,
      raw.btoPrice,
      raw.btoOptionMid,
      raw.btoMid
    ) ?? 0.5;

  const exitPrice =
    firstFiniteNum(
      raw.closedOptionBid,
      raw.stcPrice,
      raw.closedOptionMid
    ) ?? entryPrice;

  const outlay =
    entryPrice > 0
      ? Number((entryPrice * 100 * qty).toFixed(2))
      : Math.max(0, Number(raw.totalOutlay ?? 0));

  const hasExplicitEntryAndExit =
    firstPositiveNum(raw.btoOptionAsk, raw.optionAsk, raw.btoPrice, raw.btoOptionMid, raw.btoMid) !== null &&
    firstFiniteNum(raw.closedOptionBid, raw.stcPrice, raw.closedOptionMid) !== null;

  const realizedDollarPnl = Number(
    (
      firstFiniteNum(raw.realizedPnlDollars, raw.pnlDollars) ??
      (exitPrice - entryPrice) * 100 * qty
    ).toFixed(2)
  );

  const pnlOptionPct = Number(
    (
      (hasExplicitEntryAndExit && entryPrice > 0
        ? ((exitPrice - entryPrice) / entryPrice) * 100
        : null) ??
      firstFiniteNum(raw.pnlOptionPct, raw.realizedPnlPct) ??
      (entryPrice > 0 ? ((exitPrice - entryPrice) / entryPrice) * 100 : 0)
    ).toFixed(1)
  );

  // True engine hard-stop risk denominator: 45% of capital outlay (1R = 0.45 * outlay)
  const riskFraction = DEFAULT_HARD_OPTION_STOP_LOSS_PCT / 100;
  const riskDollars = Math.max(1, Number((outlay * riskFraction).toFixed(2)));
  const rMultiple = Number(
    (
      firstFiniteNum(raw.realizedR) ??
      (outlay > 0 ? realizedDollarPnl / riskDollars : pnlOptionPct / DEFAULT_HARD_OPTION_STOP_LOSS_PCT)
    ).toFixed(2)
  );

  return {
    entryPrice: Number(entryPrice.toFixed(2)),
    exitPrice: Number(exitPrice.toFixed(2)),
    contractsQty: qty,
    outlay: Number(outlay.toFixed(2)),
    realizedDollarPnl,
    pnlOptionPct,
    riskDollars,
    rMultiple,
  };
}
