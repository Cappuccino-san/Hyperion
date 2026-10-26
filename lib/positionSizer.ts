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

/**
 * Calculates position size based on contract ask price.
 * Enforces the strict small account rule: total capital outlay MUST always be <= $100.00.
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

  // Contract cost in dollars = Ask price * 100 shares per contract
  const contractCost = Number((contractAsk * 100).toFixed(2));

  // 1. If contract cost exceeds $100.00, reject execution immediately
  if (contractCost > MAX_SMALL_ACCOUNT_BUDGET) {
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

  // 2. If 2 contracts cost <= $100.00 (Ask <= $0.50), size 2 contracts
  if (Number((contractCost * 2).toFixed(2)) <= MAX_SMALL_ACCOUNT_BUDGET) {
    const contractsQty: 1 | 2 = 2;
    const totalOutlay = Number((contractCost * contractsQty).toFixed(2));
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
  const totalOutlay = Number((contractCost * contractsQty).toFixed(2));
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
