/**
 * Position Sizer & Strict Small-Account Capital Invariant Engine
 *
 * Mathematical Invariants Enforced:
 * 1. Total Capital Outlay Invariant:
 *    Total risk exposure per trade MUST be strictly UNDER $100.00 (maximum 1 or 2 contracts).
 * 2. Contract Sizing Invariant (1-Contract Sniper Mode):
 *    - Ask * 100 <= $100.00 -> Size strictly 1 contract (Total outlay: $1.00 - $100.00)
 *    - Ask * 100 > $100.00  -> REJECT execution immediately (Total outlay: $0.00, Never exceeds budget)
 * 3. Contract Quantity Invariant:
 *    Quantity MUST strictly be 1. Sizing 2+ contracts is mathematically impossible.
 */

export interface PositionSizingResult {
  allowed: boolean;
  contractAsk: number;
  contractCost: number; // Ask * 100
  contractsQty: 1 | 2;
  totalOutlay: number; // in dollars (e.g. 78.00)
  rejectionReason?: string;
  sizingTier: "TWO_CONTRACTS" | "ONE_CONTRACT" | "BUDGET_REJECTED";
}

export const MAX_SMALL_ACCOUNT_BUDGET = 100.0; // Hard dollar ceiling: strictly <= $100.00
const MAX_OUTLAY_CENTS = 10000; // $100.00 in cents
export const MIN_OPTION_DELTA = 0.24;
export const MORNING_MIN_OPTION_DELTA = 0.24;
export const INTRADAY_MIN_OPTION_DELTA = 0.35;
export const POS_GAMMA_MIN_OPTION_DELTA = 0.35;
export const NEG_GAMMA_MIN_OPTION_DELTA = 0.24;
export const MAX_OPTION_DELTA = 0.50;
export const MAX_SPREAD_TO_EDGE_RATIO = 0.22; // Hard veto: spread / max(0.05, expectedDollarMove) > 0.22
export const DEFAULT_HOLD_HORIZON_MINUTES = 30; // 6 bars (5m) expected hold horizon

export type DeltaRegimeContext =
  | string
  | {
      regime?: string | null;
      absImpulsePeclet?: number;
      etMins?: number;
    }
  | number;

export interface TaylorPayoffEvaluation {
  allowed: boolean;
  expectedDollarMove: number;
  thetaDragDollars: number;
  halfSpreadDollars: number;
  netDollarEdge: number;
  netEvPerDollarAsk: number;
  spreadToEdgeRatio: number;
  rejectionReason:
    | "DELTA_OUT_OF_BAND"
    | "INVALID_QUOTE"
    | "SPREAD_TO_EDGE_VETO"
    | "NEGATIVE_NET_EV"
    | null;
}

/**
 * Regime & advection-conditioned minimum |delta| floor (eliminates the 10:30 AM etMins < 630 clock step):
 * - NEG_GAMMA_TREND / ZERO_GAMMA_FLIP or |impulsePeclet| >= 1.8 -> 0.24
 * - POS_GAMMA_PIN (without strong advection) -> 0.35
 * - Default fallback -> 0.24
 */
export function resolveMinOptionDelta(regimeOrOpts?: DeltaRegimeContext): number {
  if (typeof regimeOrOpts === "string") {
    return regimeOrOpts === "POS_GAMMA_PIN"
      ? POS_GAMMA_MIN_OPTION_DELTA
      : NEG_GAMMA_MIN_OPTION_DELTA;
  }
  if (regimeOrOpts && typeof regimeOrOpts === "object") {
    const absImpPe =
      typeof regimeOrOpts.absImpulsePeclet === "number" &&
      Number.isFinite(regimeOrOpts.absImpulsePeclet)
        ? Math.abs(regimeOrOpts.absImpulsePeclet)
        : 0;
    if (
      regimeOrOpts.regime === "NEG_GAMMA_TREND" ||
      regimeOrOpts.regime === "ZERO_GAMMA_FLIP" ||
      absImpPe >= 1.8
    ) {
      return NEG_GAMMA_MIN_OPTION_DELTA;
    }
    if (regimeOrOpts.regime === "POS_GAMMA_PIN") {
      return POS_GAMMA_MIN_OPTION_DELTA;
    }
    return MIN_OPTION_DELTA;
  }
  return MIN_OPTION_DELTA;
}

export function isDeltaInTargetBand(
  delta: number,
  regimeOrOpts?: DeltaRegimeContext
): boolean {
  if (!Number.isFinite(delta)) return false;
  const absDelta = Math.abs(delta);
  const minDelta = resolveMinOptionDelta(regimeOrOpts);
  return absDelta >= minDelta && absDelta <= MAX_OPTION_DELTA;
}

/**
 * Second-Order Taylor Net Payoff Router:
 *   NetEV(K,T) = (|Delta| * dS_exp + 0.5 * Gamma * dS_exp^2 - |Theta| * dt_hold - 0.5 * Spread) / Ask
 * Paired with hard spread-to-edge veto:
 *   Spread / max(0.05, |Delta| * dS_exp + 0.5 * Gamma * dS_exp^2) > 0.22 -> VETO
 */
export function computeTaylorNetPayoff(params: {
  absDelta: number;
  gamma: number;
  dailyTheta: number; // dollars per 390-min RTH trading day
  bid: number;
  ask: number;
  expectedUnderlyingMove: number; // dS_exp in dollars (> 0)
  holdMinutes?: number;
  minDelta?: number;
}): TaylorPayoffEvaluation {
  const {
    absDelta,
    gamma,
    dailyTheta,
    bid,
    ask,
    expectedUnderlyingMove,
    holdMinutes = DEFAULT_HOLD_HORIZON_MINUTES,
    minDelta = MIN_OPTION_DELTA,
  } = params;

  if (!Number.isFinite(ask) || ask <= 0 || !Number.isFinite(bid) || bid < 0 || bid > ask) {
    return {
      allowed: false,
      expectedDollarMove: 0,
      thetaDragDollars: 0,
      halfSpreadDollars: 0,
      netDollarEdge: 0,
      netEvPerDollarAsk: -1,
      spreadToEdgeRatio: Infinity,
      rejectionReason: "INVALID_QUOTE",
    };
  }
  const absD = Math.abs(absDelta);
  if (!Number.isFinite(absD) || absD < minDelta || absD > MAX_OPTION_DELTA) {
    return {
      allowed: false,
      expectedDollarMove: 0,
      thetaDragDollars: 0,
      halfSpreadDollars: 0,
      netDollarEdge: 0,
      netEvPerDollarAsk: -1,
      spreadToEdgeRatio: Infinity,
      rejectionReason: "DELTA_OUT_OF_BAND",
    };
  }

  const dS = Math.max(
    0.01,
    Number.isFinite(expectedUnderlyingMove) ? Math.abs(expectedUnderlyingMove) : 0.01
  );
  const safeGamma = Number.isFinite(gamma) && gamma > 0 ? gamma : 0;
  const expectedDollarMove = absD * dS + 0.5 * safeGamma * dS * dS;
  const spread = Math.max(0, ask - bid);
  const halfSpreadDollars = 0.5 * spread;
  const dtHoldDays = Math.max(5, holdMinutes) / 390;
  const thetaDragDollars = Math.abs(Number.isFinite(dailyTheta) ? dailyTheta : 0) * dtHoldDays;
  const netDollarEdge = expectedDollarMove - thetaDragDollars - halfSpreadDollars;
  const netEvPerDollarAsk = netDollarEdge / ask;
  const spreadToEdgeRatio = spread / Math.max(0.05, expectedDollarMove);

  if (spreadToEdgeRatio > MAX_SPREAD_TO_EDGE_RATIO) {
    return {
      allowed: false,
      expectedDollarMove,
      thetaDragDollars,
      halfSpreadDollars,
      netDollarEdge,
      netEvPerDollarAsk,
      spreadToEdgeRatio,
      rejectionReason: "SPREAD_TO_EDGE_VETO",
    };
  }
  if (netEvPerDollarAsk <= 0) {
    return {
      allowed: false,
      expectedDollarMove,
      thetaDragDollars,
      halfSpreadDollars,
      netDollarEdge,
      netEvPerDollarAsk,
      spreadToEdgeRatio,
      rejectionReason: "NEGATIVE_NET_EV",
    };
  }

  return {
    allowed: true,
    expectedDollarMove,
    thetaDragDollars,
    halfSpreadDollars,
    netDollarEdge,
    netEvPerDollarAsk,
    spreadToEdgeRatio,
    rejectionReason: null,
  };
}

export interface SizingResult {
  allowed: boolean;
  contractsQty: number;
  totalOutlay: number;
  rejectionReason?: "BUDGET_REJECTED" | "SPREAD_TOO_WIDE" | "AFTER_HOURS_REJECTED" | "INVALID_QUOTE";
}

/**
 * Calculates position size based on contract ask price.
 * Enforces the strict small account rule: total capital outlay MUST always be <= $100.00.
 * Utilizes integer-cent arithmetic to eliminate IEEE-754 floating-point drift.
 */
export function calculateSmallAccountSize(contractAsk: number): PositionSizingResult {
  if (!Number.isFinite(contractAsk) || contractAsk <= 0) {
    return {
      allowed: false,
      contractAsk: 0,
      contractCost: 0,
      contractsQty: 1,
      totalOutlay: 0,
      rejectionReason: "INVALID_PRICE: Contract ask must be a positive finite number",
      sizingTier: "BUDGET_REJECTED",
    };
  }

  // Contract cost in integer cents = Ask price * 100 shares * 100 cents
  const singleContractCents = Math.round(contractAsk * 10000);
  const contractCost = singleContractCents / 100;

  // 1. If single contract cost exceeds $100.00 (10,000 cents), reject execution immediately
  if (singleContractCents > MAX_OUTLAY_CENTS) {
    return {
      allowed: false,
      contractAsk,
      contractCost,
      contractsQty: 1,
      totalOutlay: 0,
      rejectionReason: `BUDGET_EXCEEDED: Contract cost $${contractCost.toFixed(
        2
      )} exceeds maximum allowed outlay of $${MAX_SMALL_ACCOUNT_BUDGET.toFixed(2)}`,
      sizingTier: "BUDGET_REJECTED",
    };
  }

  // 2. Strict 1-Contract Sniper Automaton: size strictly 1 contract when Ask * 100 <= $100.00
  const contractsQty: 1 | 2 = 1;
  const totalOutlay = singleContractCents / 100;
  return {
    allowed: true,
    contractAsk,
    contractCost,
    contractsQty,
    totalOutlay,
    sizingTier: "ONE_CONTRACT",
  };
}

/**
 * Carbon Audit hardened position sizer with NBBO spread validation and integer-cent precision.
 */
export function calculatePositionSize(askPrice: number, bidPrice?: number): SizingResult {
  if (!Number.isFinite(askPrice) || askPrice <= 0) {
    return {
      allowed: false,
      contractsQty: 0,
      totalOutlay: 0,
      rejectionReason: "INVALID_QUOTE",
    };
  }

  if (bidPrice !== undefined && (!Number.isFinite(bidPrice) || bidPrice < 0 || bidPrice > askPrice)) {
    return {
      allowed: false,
      contractsQty: 0,
      totalOutlay: 0,
      rejectionReason: "INVALID_QUOTE",
    };
  }

  const singleContractCents = Math.round(askPrice * 10000);
  if (singleContractCents > MAX_OUTLAY_CENTS) {
    return {
      allowed: false,
      contractsQty: 0,
      totalOutlay: 0,
      rejectionReason: "BUDGET_REJECTED",
    };
  }

  if (bidPrice !== undefined) {
    const spread = (askPrice - bidPrice) / askPrice;
    if (spread > 0.25) {
      return {
        allowed: false,
        contractsQty: 0,
        totalOutlay: 0,
        rejectionReason: "SPREAD_TOO_WIDE",
      };
    }
  }

  // Strict 1-Contract Sniper Automaton
  return {
    allowed: true,
    contractsQty: 1,
    totalOutlay: singleContractCents / 100,
  };
}

/**
 * Invariant Validation Assertion.
 * Throws an error or returns false if any small account rule invariant is violated.
 */
export function assertSmallAccountInvariant(
  totalOutlay: number,
  contractsQty: number
): { valid: boolean; violation?: string } {
  if (contractsQty !== 1) {
    return {
      valid: false,
      violation: `CONTRACT_QTY_VIOLATION: Sized ${contractsQty} contracts. Must strictly be 1 contract.`,
    };
  }

  if (totalOutlay > MAX_SMALL_ACCOUNT_BUDGET + 0.001) {
    return {
      valid: false,
      violation: `OUTLAY_CAP_VIOLATION: Total outlay $${totalOutlay.toFixed(
        2
      )} exceeds strict $${MAX_SMALL_ACCOUNT_BUDGET.toFixed(2)} limit.`,
    };
  }

  return { valid: true };
}
