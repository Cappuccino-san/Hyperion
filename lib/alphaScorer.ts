/**
 * Regime-Conditioned Delta Router & Second-Order Taylor Payoff Surface Scorer
 *
 * Replaces clock-based delta cutoffs (e.g. etMins < 630) with live microstructural
 * gamma-regime + advection routing and ranks eligible 1-contract candidates
 * (ask <= $0.99, spread <= 24%) by second-order Taylor net payoff efficiency.
 */

export type MicrostructuralRegime =
  | "NEG_GAMMA_TREND"
  | "ZERO_GAMMA_FLIP"
  | "POS_GAMMA_PIN"
  | "LOW_EDGE_CHOP";

export interface RegimeContextInput {
  regime?: MicrostructuralRegime;
  spotPrice?: number;
  zeroGamma?: number;
  netGex?: number;
  impulsePeclet?: number;
  pecletNumber?: number;
  impulseChi?: number;
  gammaRegime?: "POSITIVE_GAMMA" | "NEGATIVE_GAMMA";
}

export interface DeltaRoutingDecision {
  regime: MicrostructuralRegime;
  minDelta: number;
  maxDelta: number;
  preferZeroDte: boolean;
  fallbackOneToTwoDte: boolean;
  chopVeto?: boolean;
}

export interface ExpectedMoveInput {
  spotPrice: number;
  isCall: boolean;
  target1Spot: number;
  target2Spot?: number;
  zeroDteCallWall?: number;
  zeroDtePutWall?: number;
  dailyExpectedMove?: { low: number; high: number } | null;
  atmIv?: number;
  remainingRthMinutes?: number;
}

export interface TaylorPayoffInput {
  absDelta: number;
  gamma: number;
  absTheta: number;
  holdDays: number;
  spread: number;
  ask: number;
  expectedMove: number;
}

export interface TaylorPayoffResult {
  eligible: boolean;
  score: number;
  netExpectedPayoff: number;
  spreadToPayoffRatio: number;
  rejectionReason?: string;
}

export const ADV_PECLET_THRESHOLD = 1.8;
export const MAX_SPREAD_TO_EXPECTED_PAYOFF_RATIO = 0.22;

/**
 * Computes the institutional near-ATM OTM ceiling: <= min($3.50, 0.45% of spot).
 */
export function getMaxOtmDistance(spotPrice: number): number {
  return Math.min(3.50, Math.max(0, spotPrice) * 0.0045);
}

/**
 * Classifies the live microstructural gamma regime from Zero-Gamma, Net GEX, and Advection Pe.
 */
export function classifyMicrostructuralRegime(
  ctx: RegimeContextInput
): MicrostructuralRegime {
  if (ctx.regime) return ctx.regime;

  const spot = typeof ctx.spotPrice === "number" && Number.isFinite(ctx.spotPrice) ? ctx.spotPrice : 0;
  const zg = typeof ctx.zeroGamma === "number" && Number.isFinite(ctx.zeroGamma) ? ctx.zeroGamma : 0;
  const rawPe =
    typeof ctx.impulsePeclet === "number" && Number.isFinite(ctx.impulsePeclet)
      ? ctx.impulsePeclet
      : typeof ctx.pecletNumber === "number" && Number.isFinite(ctx.pecletNumber)
        ? ctx.pecletNumber
        : undefined;
  const pe = Math.abs(rawPe ?? 0);

  const nearZeroGamma = zg > 0 && spot > 0 && Math.abs(spot - zg) / spot <= 0.0025;
  if (nearZeroGamma && pe >= ADV_PECLET_THRESHOLD) {
    return "ZERO_GAMMA_FLIP";
  }

  if (
    ctx.gammaRegime === "NEGATIVE_GAMMA" ||
    (typeof ctx.netGex === "number" && Number.isFinite(ctx.netGex) && ctx.netGex < 0) ||
    (zg > 0 && spot > 0 && spot < zg) ||
    pe >= ADV_PECLET_THRESHOLD
  ) {
    return "NEG_GAMMA_TREND";
  }

  const chiDeviation = Math.abs((ctx.impulseChi ?? 0.5) - 0.5);
  if (rawPe !== undefined && pe < 0.35 && chiDeviation < 0.05) {
    return "LOW_EDGE_CHOP";
  }

  return "POS_GAMMA_PIN";
}

/**
 * Resolves minimum/maximum |delta| bounds and DTE routing strictly from microstructural
 * regime and advection (no hardcoded clock cutoff like etMins < 630).
 *
 * - NEG_GAMMA_TREND or ZERO_GAMMA_FLIP (|impulsePeclet| >= 1.8):
 *   0.24 <= |delta| <= 0.50, 0DTE preferred at any RTH hour.
 * - POS_GAMMA_PIN (mean-reversion):
 *   0.35 <= |delta| <= 0.50, with 1-2 DTE fallback when 0DTE exceeds $0.99.
 * - LOW_EDGE_CHOP: flat equilibrium chop -> vetoed upstream.
 */
export function resolveMinOptionDelta(
  ctx: RegimeContextInput
): DeltaRoutingDecision {
  const regime = classifyMicrostructuralRegime(ctx);
  if (regime === "LOW_EDGE_CHOP") {
    return {
      regime,
      minDelta: 0.35,
      maxDelta: 0.50,
      preferZeroDte: true,
      fallbackOneToTwoDte: true,
      chopVeto: true,
    };
  }
  const rawPe =
    typeof ctx.impulsePeclet === "number" && Number.isFinite(ctx.impulsePeclet)
      ? ctx.impulsePeclet
      : typeof ctx.pecletNumber === "number" && Number.isFinite(ctx.pecletNumber)
        ? ctx.pecletNumber
        : undefined;
  const absPe = rawPe !== undefined ? Math.abs(rawPe) : undefined;

  if (
    regime === "NEG_GAMMA_TREND" ||
    (regime === "ZERO_GAMMA_FLIP" && (absPe === undefined || absPe >= ADV_PECLET_THRESHOLD))
  ) {
    return {
      regime,
      minDelta: 0.24,
      maxDelta: 0.50,
      preferZeroDte: true,
      fallbackOneToTwoDte: true,
    };
  }

  return {
    regime,
    minDelta: 0.35,
    maxDelta: 0.50,
    preferZeroDte: true,
    fallbackOneToTwoDte: true,
  };
}

/**
 * Computes expected underlying move bounded by structural wall room and remaining IV expected move.
 */
export function computeBoundedExpectedMove(input: ExpectedMoveInput): number {
  const {
    spotPrice,
    isCall,
    target1Spot,
    target2Spot,
    zeroDteCallWall,
    zeroDtePutWall,
    dailyExpectedMove,
    atmIv = 0.16,
    remainingRthMinutes = 180,
  } = input;

  const safeSpot = Math.max(0.01, spotPrice);
  const target1Room = Math.abs(target1Spot - safeSpot);
  const target2Room =
    typeof target2Spot === "number" && Number.isFinite(target2Spot) && target2Spot > 0
      ? Math.abs(target2Spot - safeSpot)
      : 0;

  const directionalWall = isCall ? zeroDteCallWall : zeroDtePutWall;
  const hasDirectionalWall =
    typeof directionalWall === "number" &&
    Number.isFinite(directionalWall) &&
    directionalWall > 0 &&
    (isCall ? directionalWall > safeSpot : directionalWall < safeSpot);

  const wallRoom = hasDirectionalWall ? Math.abs(directionalWall - safeSpot) : 0;
  const structuralRoom =
    wallRoom > 0
      ? Math.max(0.05, Math.min(wallRoom, Math.max(target1Room, target2Room, wallRoom)))
      : Math.max(0.05, target1Room, safeSpot * 0.0015);

  const clampedIv = Math.max(0.06, Math.min(2.5, atmIv));
  const clampedMins = Math.max(15, Math.min(390, remainingRthMinutes));
  const bsRemainingIvMove = safeSpot * clampedIv * Math.sqrt(clampedMins / (252 * 390));

  let remainingIvMove = bsRemainingIvMove;
  if (dailyExpectedMove) {
    const emRoom = isCall
      ? dailyExpectedMove.high - safeSpot
      : safeSpot - dailyExpectedMove.low;
    if (Number.isFinite(emRoom) && emRoom > 0) {
      remainingIvMove = Math.min(bsRemainingIvMove, Math.max(safeSpot * 0.001, emRoom));
    }
  }

  return Number(Math.max(0.05, Math.min(structuralRoom, remainingIvMove)).toFixed(4));
}

/**
 * Evaluates second-order Taylor net payoff efficiency and spread-to-expected-payoff friction guard.
 *
 *   score = (absDelta * expectedMove + 0.5 * gamma * expectedMove^2 - absTheta * holdDays - 0.5 * spread) / ask
 *
 * Rejects contracts where spread / Math.max(0.05, absDelta * expectedMove) > 0.22.
 */
export function scoreContractTaylorPayoff(
  input: TaylorPayoffInput
): TaylorPayoffResult {
  const { absDelta, gamma, absTheta, holdDays, spread, ask, expectedMove } = input;
  const safeExpectedMove = Math.max(0.01, expectedMove);
  const safeSpread = Math.max(0, spread);
  const safeAsk = Math.max(0.01, ask);
  const firstOrderMove = Math.max(0, absDelta) * safeExpectedMove;
  const spreadToPayoffRatio = safeSpread / Math.max(0.05, firstOrderMove);

  if (spreadToPayoffRatio > MAX_SPREAD_TO_EXPECTED_PAYOFF_RATIO) {
    return {
      eligible: false,
      score: -Infinity,
      netExpectedPayoff: -Infinity,
      spreadToPayoffRatio,
      rejectionReason: "SPREAD_EXCEEDS_22PCT_EXPECTED_PAYOFF",
    };
  }

  const convexityTerm = 0.5 * Math.max(0, gamma) * safeExpectedMove * safeExpectedMove;
  const thetaDecayTerm = Math.max(0, absTheta) * Math.max(0, holdDays);
  const halfSpreadCost = 0.5 * safeSpread;
  const netExpectedPayoff =
    firstOrderMove + convexityTerm - thetaDecayTerm - halfSpreadCost;
  const score = netExpectedPayoff / safeAsk;

  return {
    eligible: true,
    score,
    netExpectedPayoff,
    spreadToPayoffRatio,
  };
}
