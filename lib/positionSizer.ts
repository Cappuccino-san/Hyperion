/**
 * Position Sizer & Strict Small-Account Capital Invariant Engine
 *
 * Mathematical Invariants Enforced:
 * 1. Total Capital Outlay Invariant:
 *    Total risk exposure per trade MUST be strictly UNDER $100.00 (maximum 1 or 2 contracts).
 * 2. Contract Sizing Invariant:
 *    - Ask * 100 <= $50.00  -> Size 2 contracts max (Total outlay: $30.00 - $100.00)
 *    - $50.00 < Ask * 100 <= $100.00 -> Size 1 contract (Total outlay: $51.00 - $100.00)
 *    - Ask * 100 > $100.00 -> REJECT execution immediately (Total outlay: $0.00, Never exceeds budget)
 * 3. Contract Quantity Invariant:
 *    Quantity MUST strictly be in {1, 2}. Sizing 3+ contracts is mathematically impossible.
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
      totalOutlay: contractCost,
      rejectionReason: `BUDGET_EXCEEDED: Contract cost $${contractCost.toFixed(
        2
      )} exceeds maximum allowed outlay of $${MAX_SMALL_ACCOUNT_BUDGET.toFixed(2)}`,
      sizingTier: "BUDGET_REJECTED",
    };
  }

  // 2. If 2 contracts cost <= $100.00 (20,000 cents / 2 <= 10,000 cents, Ask <= $0.50), size 2 contracts
  if (2 * singleContractCents <= MAX_OUTLAY_CENTS) {
    const contractsQty: 1 | 2 = 2;
    const totalOutlay = (2 * singleContractCents) / 100;
    return {
      allowed: true,
      contractAsk,
      contractCost,
      contractsQty,
      totalOutlay,
      sizingTier: "TWO_CONTRACTS",
    };
  }

  // 3. Otherwise (Ask between $0.51 and $1.00), size exactly 1 contract
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

  if (2 * singleContractCents <= MAX_OUTLAY_CENTS) {
    return {
      allowed: true,
      contractsQty: 2,
      totalOutlay: (2 * singleContractCents) / 100,
    };
  }

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
  if (contractsQty !== 1 && contractsQty !== 2) {
    return {
      valid: false,
      violation: `CONTRACT_QTY_VIOLATION: Sized ${contractsQty} contracts. Must strictly be 1 or 2 contracts.`,
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
