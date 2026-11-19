import {
  normPDF,
  NormalizedOptionContract,
} from "@/lib/optionsExposure";
import { FlowGammaVwapSnapshot } from "@/lib/flowGammaVwap";
import { getSessionBoundsEt } from "@/lib/gaiaSessionGuards";
import {
  AlphaPriorsState,
  MarketRegimeId,
  cloneDefaultAlphaPriors,
} from "@/lib/persistenceStore";
import {
  computeTaylorNetPayoff,
  MAX_OPTION_DELTA,
  MAX_SPREAD_TO_EDGE_RATIO,
  resolveMinOptionDelta,
} from "@/lib/positionSizer";

export type { MarketRegimeId };

export const LEG1_MIN_EXPECTANCY_R = 0.35;
export const LEG2_MIN_EXPECTANCY_R = 0.65;
export const LEG2_MIN_ABS_PECLET = 2.0;
export const LEG2_POST_LOSS_MIN_ABS_PECLET = 2.2;

export interface OpeningHorizonAlignmentInput {
  etMins: number;
  direction: "CALL" | "PUT";
  spotPrice: number;
  zeroDteKing?: number;
  allExpKing?: number;
  bookCenterHistory?: number[];
}

export interface OpeningHorizonAlignmentResult {
  allowed: boolean;
  deferredUntil1000: boolean;
  reason: string | null;
}

/**
 * Opening Horizon Alignment (09:35-10:00 ET):
 * Before 10:00 ET (etMins < 600), requires 0DTE/Next-Exp King pull and Book Center
 * 3-bar slope to agree with trade direction and not directly oppose All-Exp King
 * across spot; otherwise defers entry until >= 10:00 ET opening range confirmation.
 */
export function evaluateOpeningHorizonAlignment(
  input: OpeningHorizonAlignmentInput
): OpeningHorizonAlignmentResult {
  const { etMins, direction, spotPrice, zeroDteKing, allExpKing, bookCenterHistory } = input;
  if (etMins >= 600) {
    return { allowed: true, deferredUntil1000: false, reason: null };
  }

  const isCall = direction === "CALL";

  if (typeof zeroDteKing === "number" && Number.isFinite(zeroDteKing) && zeroDteKing > 0) {
    if (isCall && zeroDteKing < spotPrice) {
      return {
        allowed: false,
        deferredUntil1000: true,
        reason: `DEFERRED_PRE_1000_KING_OPPOSES: 0DTE King ($${zeroDteKing}) < spot ($${spotPrice.toFixed(2)}) for CALL`,
      };
    }
    if (!isCall && zeroDteKing > spotPrice) {
      return {
        allowed: false,
        deferredUntil1000: true,
        reason: `DEFERRED_PRE_1000_KING_OPPOSES: 0DTE King ($${zeroDteKing}) > spot ($${spotPrice.toFixed(2)}) for PUT`,
      };
    }
    if (typeof allExpKing === "number" && Number.isFinite(allExpKing) && allExpKing > 0) {
      const opposesAcrossSpot =
        (zeroDteKing > spotPrice && allExpKing < spotPrice) ||
        (zeroDteKing < spotPrice && allExpKing > spotPrice);
      if (opposesAcrossSpot) {
        return {
          allowed: false,
          deferredUntil1000: true,
          reason: `DEFERRED_PRE_1000_KING_CONFLICT: 0DTE King ($${zeroDteKing}) opposes All-Exp King ($${allExpKing}) across spot ($${spotPrice.toFixed(2)})`,
        };
      }
    }
  }

  if (Array.isArray(bookCenterHistory)) {
    const valid = bookCenterHistory.filter((v) => typeof v === "number" && Number.isFinite(v) && v > 0);
    if (valid.length < 3) {
      return {
        allowed: false,
        deferredUntil1000: true,
        reason: `DEFERRED_PRE_1000_BOOK_CENTER_SLOPE: need 3 bars of Book Center history (got ${valid.length})`,
      };
    }
    const recent3 = valid.slice(-3);
    const slope3 = recent3[2] - recent3[0];
    if (isCall && slope3 <= 0) {
      return {
        allowed: false,
        deferredUntil1000: true,
        reason: `DEFERRED_PRE_1000_BOOK_CENTER_SLOPE: Book Center 3-bar slope (${slope3.toFixed(3)}) <= 0 for CALL`,
      };
    }
    if (!isCall && slope3 >= 0) {
      return {
        allowed: false,
        deferredUntil1000: true,
        reason: `DEFERRED_PRE_1000_BOOK_CENTER_SLOPE: Book Center 3-bar slope (${slope3.toFixed(3)}) >= 0 for PUT`,
      };
    }
  }

  return { allowed: true, deferredUntil1000: false, reason: null };
}

export interface Leg2StructuralGateInput {
  direction: "CALL" | "PUT";
  etMins: number;
  nowTsSec: number;
  spotPrice: number;
  prevSpotPrice?: number;
  zeroGamma: number;
  flowVwap?: number;
  sma34?: number;
  leg1Trade: {
    contractType: "CALL" | "PUT";
    closedTs?: number;
    btoSpotPrice: number;
    closedSpotPrice?: number;
    pnlOptionPct?: number;
    realizedPnl?: number;
  };
  testedPutWallOrMinus1Sigma: boolean;
  testedCallWallOrPlus1Sigma: boolean;
  has5mBullDiv: boolean;
  has5mBearDiv: boolean;
  impulseChi: number;
  deltaChi6Bar: number;
  impulsePeclet: number;
  calibratedExpectancyR?: number;
}

export interface Leg2StructuralGateResult {
  allowed: boolean;
  requiredMinExpectancyR: number;
  reason: string | null;
}

/**
 * Asymmetric Leg-2 Conviction & Anti-Whipsaw Firewall (10:30-14:30 ET):
 * - Opposite direction only, >= 30m cooldown from Leg-1 exit
 * - Requires minExpectancyR >= 0.65 and |impulsePeclet| >= 2.0
 * - Requires confirmed structural transition:
 *   - CALL: Put Wall / -1s sweep + 5m Bull Div + Flow VWAP/SMA34 reclaim (impulseChi >= 0.65, deltaChi6Bar >= 0.04)
 *   - PUT: Call Wall / +1s rejection + 5m Bear Div + Flow VWAP/SMA34 loss (impulseChi <= 0.35, deltaChi6Bar <= -0.04)
 * - Anti-Whipsaw Rule: If Leg-1 closed as a loss, blocks opposite-direction Leg-2 flips
 *   unless spot cleanly crosses and holds across Zero Gamma with |impulsePeclet| >= 2.2.
 */
export function evaluateLeg2StructuralGate(
  input: Leg2StructuralGateInput
): Leg2StructuralGateResult {
  const {
    direction,
    etMins,
    nowTsSec,
    spotPrice,
    prevSpotPrice,
    zeroGamma,
    flowVwap,
    sma34,
    leg1Trade,
    testedPutWallOrMinus1Sigma,
    testedCallWallOrPlus1Sigma,
    has5mBullDiv,
    has5mBearDiv,
    impulseChi,
    deltaChi6Bar,
    impulsePeclet,
    calibratedExpectancyR,
  } = input;

  const sessionDateEt = new Date(nowTsSec * 1000).toLocaleDateString("en-CA", {
    timeZone: "America/New_York",
  });
  const { entryCutoffMins } = getSessionBoundsEt(sessionDateEt);
  if (etMins < 630 || etMins > entryCutoffMins) {
    return {
      allowed: false,
      requiredMinExpectancyR: LEG2_MIN_EXPECTANCY_R,
      reason: `LEG2_WINDOW_CLOSED: etMins=${etMins} outside [630, ${entryCutoffMins}]`,
    };
  }

  if (typeof leg1Trade.closedTs !== "number" || nowTsSec - leg1Trade.closedTs < 1800) {
    return {
      allowed: false,
      requiredMinExpectancyR: LEG2_MIN_EXPECTANCY_R,
      reason: "LEG2_COOLDOWN_NOT_MET: < 30m elapsed since Leg-1 exit",
    };
  }

  if (direction === leg1Trade.contractType) {
    return {
      allowed: false,
      requiredMinExpectancyR: LEG2_MIN_EXPECTANCY_R,
      reason: `LEG2_SAME_DIRECTION_BLOCKED: Leg-1 was already ${leg1Trade.contractType}`,
    };
  }

  const isCall = direction === "CALL";
  const leg1Pnl =
    typeof leg1Trade.realizedPnl === "number" && Number.isFinite(leg1Trade.realizedPnl)
      ? leg1Trade.realizedPnl
      : typeof leg1Trade.pnlOptionPct === "number" && Number.isFinite(leg1Trade.pnlOptionPct)
        ? leg1Trade.pnlOptionPct
        : 0;
  const leg1ClosedAsLoss = leg1Pnl < 0;

  if (leg1ClosedAsLoss) {
    const minCrossDist = Math.max(0.15, spotPrice * 0.0002);
    const heldAcrossZeroGamma =
      zeroGamma > 0 &&
      (isCall
        ? spotPrice >= zeroGamma + minCrossDist &&
          (prevSpotPrice === undefined || prevSpotPrice >= zeroGamma)
        : spotPrice <= zeroGamma - minCrossDist &&
          (prevSpotPrice === undefined || prevSpotPrice <= zeroGamma));
    const strongFlipPeclet = isCall
      ? impulsePeclet >= LEG2_POST_LOSS_MIN_ABS_PECLET
      : impulsePeclet <= -LEG2_POST_LOSS_MIN_ABS_PECLET;

    if (!heldAcrossZeroGamma || !strongFlipPeclet) {
      return {
        allowed: false,
        requiredMinExpectancyR: LEG2_MIN_EXPECTANCY_R,
        reason: `LEG2_ANTI_WHIPSAW_VETO: Leg-1 closed as loss (${leg1Pnl.toFixed(1)}%); requires clean Zero Gamma hold & |Pe| >= ${LEG2_POST_LOSS_MIN_ABS_PECLET}`,
      };
    }
  }

  const alignedPeclet = isCall
    ? impulsePeclet >= LEG2_MIN_ABS_PECLET
    : impulsePeclet <= -LEG2_MIN_ABS_PECLET;
  if (!alignedPeclet) {
    return {
      allowed: false,
      requiredMinExpectancyR: LEG2_MIN_EXPECTANCY_R,
      reason: `LEG2_WEAK_PECLET: impulsePeclet=${impulsePeclet.toFixed(2)} misses ±${LEG2_MIN_ABS_PECLET}`,
    };
  }

  if (isCall) {
    const reclaimed =
      (typeof flowVwap === "number" && flowVwap > 0 && spotPrice >= flowVwap) ||
      (typeof sma34 === "number" && sma34 > 0 && spotPrice >= sma34);
    if (!testedPutWallOrMinus1Sigma) {
      return {
        allowed: false,
        requiredMinExpectancyR: LEG2_MIN_EXPECTANCY_R,
        reason: "LEG2_NO_PUT_WALL_OR_MINUS1S_SWEEP",
      };
    }
    if (!has5mBullDiv) {
      return {
        allowed: false,
        requiredMinExpectancyR: LEG2_MIN_EXPECTANCY_R,
        reason: "LEG2_NO_5M_BULL_DIVERGENCE",
      };
    }
    if (!reclaimed) {
      return {
        allowed: false,
        requiredMinExpectancyR: LEG2_MIN_EXPECTANCY_R,
        reason: "LEG2_NO_FLOW_VWAP_OR_SMA34_RECLAIM",
      };
    }
    if (impulseChi < 0.65 || deltaChi6Bar < 0.04) {
      return {
        allowed: false,
        requiredMinExpectancyR: LEG2_MIN_EXPECTANCY_R,
        reason: `LEG2_FLUX_INFLECTION_WEAK: impulseChi=${impulseChi.toFixed(2)}, deltaChi6=${deltaChi6Bar.toFixed(3)}`,
      };
    }
  } else {
    const lost =
      (typeof flowVwap === "number" && flowVwap > 0 && spotPrice <= flowVwap) ||
      (typeof sma34 === "number" && sma34 > 0 && spotPrice <= sma34);
    if (!testedCallWallOrPlus1Sigma) {
      return {
        allowed: false,
        requiredMinExpectancyR: LEG2_MIN_EXPECTANCY_R,
        reason: "LEG2_NO_CALL_WALL_OR_PLUS1S_REJECTION",
      };
    }
    if (!has5mBearDiv) {
      return {
        allowed: false,
        requiredMinExpectancyR: LEG2_MIN_EXPECTANCY_R,
        reason: "LEG2_NO_5M_BEAR_DIVERGENCE",
      };
    }
    if (!lost) {
      return {
        allowed: false,
        requiredMinExpectancyR: LEG2_MIN_EXPECTANCY_R,
        reason: "LEG2_NO_FLOW_VWAP_OR_SMA34_LOSS",
      };
    }
    if (impulseChi > 0.35 || deltaChi6Bar > -0.04) {
      return {
        allowed: false,
        requiredMinExpectancyR: LEG2_MIN_EXPECTANCY_R,
        reason: `LEG2_FLUX_INFLECTION_WEAK: impulseChi=${impulseChi.toFixed(2)}, deltaChi6=${deltaChi6Bar.toFixed(3)}`,
      };
    }
  }

  if (typeof calibratedExpectancyR === "number" && calibratedExpectancyR < LEG2_MIN_EXPECTANCY_R) {
    return {
      allowed: false,
      requiredMinExpectancyR: LEG2_MIN_EXPECTANCY_R,
      reason: `LEG2_LOW_EXPECTANCY: +${calibratedExpectancyR.toFixed(2)}R < +${LEG2_MIN_EXPECTANCY_R.toFixed(2)}R`,
    };
  }

  return {
    allowed: true,
    requiredMinExpectancyR: LEG2_MIN_EXPECTANCY_R,
    reason: null,
  };
}

export interface ClassifyMarketRegimeInput {
  spotPrice: number;
  callWall: number;
  putWall: number;
  zeroGamma: number;
  zeroDteKing?: number;
  bookCenter?: number;
  flowVwap?: number;
  netGex?: number;
  flowSnapshot?: FlowGammaVwapSnapshot | null;
  directionHint?: "CALL" | "PUT";
}

export interface MarketRegimeClassification {
  regime: MarketRegimeId;
  wallCorridorPct: number;
  wallRoomPct: number;
  absPeclet: number;
  effectivePeclet: number;
  distanceToZeroGammaPct: number;
  favoredStrategies: string[];
  preferredDte: "0DTE" | "1-2DTE" | "NONE";
  shouldStandAside: boolean;
  reason: string;
}

export interface EmpiricalSampleRecord {
  regime?: MarketRegimeId;
  won: boolean;
  rMultiple: number;
}

export interface ScoreSetupExpectancyInput {
  direction: "CALL" | "PUT";
  setupName: string;
  spotPrice: number;
  stopLossSpot: number;
  target1Spot: number;
  target2Spot: number;
  callWall: number;
  putWall: number;
  zeroGamma: number;
  zeroDteKing?: number;
  bookCenter?: number;
  divergence5m?: "BULL" | "BEAR" | "NO";
  divergence30m?: "BULL" | "BEAR" | "NO";
  flowSnapshot?: FlowGammaVwapSnapshot | null;
  regimeClassification: MarketRegimeClassification;
  priors?: AlphaPriorsState;
  /** Causal outcomes strictly from [D-10, D-1]; never includes current session D */
  priorSamples?: EmpiricalSampleRecord[];
  minWinRatePct?: number;
  minExpectancyR?: number;
}

export interface AlphaSetupScore {
  featureBreakdown: {
    fluxAlignment: number;
    flowVwapBand: number;
    wallRoom: number;
    kingMagnet: number;
    mtfDivergence: number;
    regimeFit: number;
  };
  compositeFeatureScore: number; // 0..1
  rrRatio: number;
  sampleSize: number;
  calibratedWinRate: number;     // 0..100
  calibratedExpectancyR: number; // R-multiple
  dataConvictionScore: number;   // 0..100
  passesGate: boolean;
  rejectionReason: string | null;
}

export interface ContractCandidateInput {
  contract: NormalizedOptionContract;
  mid: number;
  bid: number;
  ask: number;
  dte: number;
  expHuman: string;
  robinhoodExp: string;
  robinhoodTab: string;
  absDelta: number;
  theta?: number;
}

export interface ScoredContractSelection {
  chosen: ContractCandidateInput & {
    score: number;
    gammaThetaEfficiency: number;
    ivSkewAdjustment: number;
    dailyTheta: number;
    netEv: number;
    spreadToEdgeRatio: number;
  };
  evaluatedCount: number;
}

function normCdfApprox(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p =
    d *
    t *
    (0.3193815 +
      t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

export function resolveEtMinutesFromMs(nowMs: number): number {
  const dt = new Date(nowMs);
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(dt);
    const h = Number(parts.find((p) => p.type === "hour")?.value ?? 10) % 24;
    const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
    return h * 60 + m;
  } catch {
    return dt.getHours() * 60 + dt.getMinutes();
  }
}

export function estimateRemainingYears(nowMs: number, dteDays: number): number {
  const safeDte = Math.max(0, dteDays);
  const etMins = resolveEtMinutesFromMs(nowMs);
  const { rthCloseMins } = getSessionBoundsEt();
  const minsLeftToday = Math.max(15, rthCloseMins - etMins);
  const totalTradingMinutes = safeDte * 390 + (safeDte === 0 ? minsLeftToday : 240);
  return Math.max(15 / (252 * 390), totalTradingMinutes / (252 * 390));
}

export function computeDailyOptionTheta(
  spot: number,
  strike: number,
  tYears: number,
  iv: number,
  isCall: boolean,
  r = 0.0475
): number {
  if (!Number.isFinite(spot) || !Number.isFinite(strike) || spot <= 0 || strike <= 0) {
    return -0.05;
  }
  const T = Math.max(15 / (252 * 390), tYears);
  const sigma = Math.max(0.05, Math.min(2.5, iv > 4 ? iv / 100 : iv || 0.2));
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(spot / strike) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const pdf = normPDF(d1);
  const term1 = -(spot * pdf * sigma) / (2 * sqrtT);
  const annualTheta = isCall
    ? term1 - r * strike * Math.exp(-r * T) * normCdfApprox(d2)
    : term1 + r * strike * Math.exp(-r * T) * normCdfApprox(-d2);
  return Math.min(-0.002, annualTheta / 252);
}

/**
 * 4-State Institutional Microstructural Regime Classifier
 * Splits live bars into:
 * - POS_GAMMA_PIN: Net GEX > 0 & spot inside walls -> mean reversion to King / Book Center (1-2 DTE)
 * - NEG_GAMMA_TREND: Net GEX < 0 or below Zero Gamma with |Pe| >= 1.5 -> momentum breakout (0 DTE)
 * - ZERO_GAMMA_FLIP: Reclaiming/flipping Zero Gamma + Flow VWAP with 6-bar impulse -> dealer squeeze (0 DTE)
 * - LOW_EDGE_CHOP: Compressed walls (< 0.16%) or weak advection (|Pe| < 1.2 without wall extremity) -> STAND ASIDE
 */
export function classifyMarketRegime(
  input: ClassifyMarketRegimeInput
): MarketRegimeClassification {
  const {
    spotPrice,
    callWall,
    putWall,
    zeroGamma,
    flowVwap,
    netGex,
    flowSnapshot,
    directionHint,
  } = input;

  const safeSpot = Math.max(0.01, spotPrice);
  const hasTwoSidedWalls =
    Number.isFinite(callWall) &&
    Number.isFinite(putWall) &&
    callWall > putWall &&
    putWall > 0;
  const wallCorridorPct = hasTwoSidedWalls
    ? (callWall - putWall) / safeSpot
    : 0.01;

  let wallRoomPct = wallCorridorPct;
  if (directionHint === "CALL" && callWall > safeSpot) {
    wallRoomPct = (callWall - safeSpot) / safeSpot;
  } else if (directionHint === "PUT" && putWall > 0 && putWall < safeSpot) {
    wallRoomPct = (safeSpot - putWall) / safeSpot;
  }

  const rawPe =
    typeof flowSnapshot?.pecletNumber === "number" && Number.isFinite(flowSnapshot.pecletNumber)
      ? flowSnapshot.pecletNumber
      : 0;
  const hasImpPe =
    typeof flowSnapshot?.impulsePeclet === "number" && Number.isFinite(flowSnapshot.impulsePeclet);
  const impPe = hasImpPe ? (flowSnapshot!.impulsePeclet as number) : 0;
  const effectivePeclet =
    hasImpPe && Math.abs(rawPe) >= 24.5
      ? impPe
      : Math.abs(impPe) > Math.abs(rawPe)
        ? impPe
        : rawPe;
  const absPeclet = Math.abs(effectivePeclet);

  const chi = flowSnapshot?.ceilingShareChi ?? 0.5;
  const impChi = flowSnapshot?.impulseChi ?? chi;
  const dChi6 = flowSnapshot?.deltaChi6Bar ?? 0;
  const dImpChi6 = flowSnapshot?.deltaImpulseChi6Bar ?? 0;
  const dFlux6 = flowSnapshot?.deltaNetFlux6Bar ?? 0;
  const effectiveVwap =
    flowVwap && flowVwap > 0 ? flowVwap : flowSnapshot?.flowVwap ?? 0;
  const hasFlowTelemetry = Boolean(
    flowSnapshot &&
      (typeof flowSnapshot.pecletNumber === "number" ||
        typeof flowSnapshot.impulsePeclet === "number")
  );

  const distanceToZeroGammaPct =
    zeroGamma > 0 ? (safeSpot - zeroGamma) / safeSpot : 0;

  const nearPutWall =
    putWall > 0 && Math.abs(safeSpot - putWall) / safeSpot <= 0.005;
  const nearCallWall =
    callWall > 0 && Math.abs(callWall - safeSpot) / safeSpot <= 0.005;
  const hasBandOrWallExtremity =
    flowSnapshot?.bandSignal === "LOWER_2S_BOUNCE" ||
    flowSnapshot?.bandSignal === "UPPER_2S_REJECT" ||
    nearPutWall ||
    nearCallWall;

  const isPositiveGamma =
    typeof netGex === "number" && Number.isFinite(netGex)
      ? netGex > 0
      : flowSnapshot?.gammaRegime === "POSITIVE_GAMMA" ||
        (zeroGamma > 0 && safeSpot >= zeroGamma);

  const isNegGammaState =
    typeof netGex === "number" && Number.isFinite(netGex)
      ? netGex < 0
      : flowSnapshot?.gammaRegime === "NEGATIVE_GAMMA" ||
        (zeroGamma > 0 && safeSpot < zeroGamma);

  const isZeroGammaBullFlip =
    zeroGamma > 0 &&
    safeSpot >= zeroGamma * 0.999 &&
    (effectiveVwap <= 0 || safeSpot >= effectiveVwap) &&
    (dChi6 > 0 || dImpChi6 > 0 || dFlux6 > 0 || impChi >= 0.6);

  const isZeroGammaBearFlip =
    zeroGamma > 0 &&
    safeSpot <= zeroGamma * 1.001 &&
    (effectiveVwap <= 0 || safeSpot <= effectiveVwap) &&
    (dChi6 < 0 || dImpChi6 < 0 || dFlux6 < 0 || impChi <= 0.4);

  const isNearWallSqueezeReclaim =
    (nearPutWall && (dChi6 > 0 || dImpChi6 > 0 || dFlux6 > 0) && impChi >= 0.6) ||
    (nearCallWall && (dChi6 < 0 || dImpChi6 < 0 || dFlux6 < 0) && impChi <= 0.4);

  // 1. Compressed structural corridor (< 0.16%) -> Hard STAND_ASIDE (unless Neg-Gamma acceleration breakout)
  const isCompressedCorridor =
    (hasTwoSidedWalls && wallCorridorPct < 0.0016) ||
    (Boolean(directionHint) &&
      !(isNegGammaState && absPeclet >= 1.25) &&
      absPeclet < 2.2 &&
      ((directionHint === "CALL" && callWall > safeSpot && wallRoomPct < 0.0016) ||
        (directionHint === "PUT" && putWall > 0 && putWall < safeSpot && wallRoomPct < 0.0016)));

  if (isCompressedCorridor) {
    return {
      regime: "LOW_EDGE_CHOP",
      wallCorridorPct: Number((wallCorridorPct * 100).toFixed(3)),
      wallRoomPct: Number((wallRoomPct * 100).toFixed(3)),
      absPeclet: Number(absPeclet.toFixed(2)),
      effectivePeclet: Number(effectivePeclet.toFixed(2)),
      distanceToZeroGammaPct: Number((distanceToZeroGammaPct * 100).toFixed(3)),
      favoredStrategies: [],
      preferredDte: "NONE",
      shouldStandAside: true,
      reason: `Compressed wall corridor (${(Math.min(wallCorridorPct, wallRoomPct) * 100).toFixed(2)}% < 0.16%)`,
    };
  }

  // 2. Weak advection (|Pe| < 1.2) or compressed intraday sigma (< 0.085% with |Pe| < 2.0) -> STAND ASIDE
  const sigmaPct =
    flowSnapshot?.sigma && safeSpot > 0 ? flowSnapshot.sigma / safeSpot : 1;
  if (
    hasFlowTelemetry &&
    ((absPeclet < 1.2 &&
      !(isPositiveGamma && hasBandOrWallExtremity) &&
      !((isZeroGammaBullFlip || isZeroGammaBearFlip) && absPeclet >= 0.8) &&
      !(isNearWallSqueezeReclaim && absPeclet >= 0.8)) ||
      (sigmaPct < 0.00085 && absPeclet < 2.0 && !hasBandOrWallExtremity))
  ) {
    return {
      regime: "LOW_EDGE_CHOP",
      wallCorridorPct: Number((wallCorridorPct * 100).toFixed(3)),
      wallRoomPct: Number((wallRoomPct * 100).toFixed(3)),
      absPeclet: Number(absPeclet.toFixed(2)),
      effectivePeclet: Number(effectivePeclet.toFixed(2)),
      distanceToZeroGammaPct: Number((distanceToZeroGammaPct * 100).toFixed(3)),
      favoredStrategies: [],
      preferredDte: "NONE",
      shouldStandAside: true,
      reason:
        sigmaPct < 0.00085 && absPeclet < 2.0
          ? `Compressed intraday volatility (σ=${(sigmaPct * 100).toFixed(3)}%, |Pe|=${absPeclet.toFixed(2)})`
          : `Weak PDE advection (|Pe|=${absPeclet.toFixed(2)} < 1.20) inside non-extremity range`,
    };
  }

  // 3. ZERO_GAMMA_FLIP: Reclaiming Zero Gamma + Flow VWAP with 6-bar impulse (dealer re-hedging squeeze)
  const nearZeroGammaZone =
    zeroGamma > 0 && Math.abs(distanceToZeroGammaPct) <= 0.0085;
  if (
    (nearZeroGammaZone && (isZeroGammaBullFlip || isZeroGammaBearFlip)) ||
    isNearWallSqueezeReclaim
  ) {
    return {
      regime: "ZERO_GAMMA_FLIP",
      wallCorridorPct: Number((wallCorridorPct * 100).toFixed(3)),
      wallRoomPct: Number((wallRoomPct * 100).toFixed(3)),
      absPeclet: Number(absPeclet.toFixed(2)),
      effectivePeclet: Number(effectivePeclet.toFixed(2)),
      distanceToZeroGammaPct: Number((distanceToZeroGammaPct * 100).toFixed(3)),
      favoredStrategies: ["Zero-Gamma Flip & Flux Reclaim", "Impulse Flux Reclaim"],
      preferredDte: "0DTE",
      shouldStandAside: false,
      reason: `Zero-Gamma / Boundary squeeze impulse (Δχ6=${(dImpChi6 || dChi6).toFixed(2)}, Pe=${effectivePeclet.toFixed(2)})`,
    };
  }

  // 4. NEG_GAMMA_TREND: Negative Net GEX / below Zero Gamma with strong advection (|Pe| >= 1.5, or >= 1.2 away from walls)
  if (isNegGammaState && (absPeclet >= 1.5 || (!hasFlowTelemetry && zeroGamma > 0 && safeSpot < zeroGamma))) {
    return {
      regime: "NEG_GAMMA_TREND",
      wallCorridorPct: Number((wallCorridorPct * 100).toFixed(3)),
      wallRoomPct: Number((wallRoomPct * 100).toFixed(3)),
      absPeclet: Number(absPeclet.toFixed(2)),
      effectivePeclet: Number(effectivePeclet.toFixed(2)),
      distanceToZeroGammaPct: Number((distanceToZeroGammaPct * 100).toFixed(3)),
      favoredStrategies: ["Bearish Zero-Gamma Flush", "Advection Breakout/Breakdown"],
      preferredDte: "0DTE",
      shouldStandAside: false,
      reason: `Negative Gamma Momentum (|Pe|=${absPeclet.toFixed(2)}, ZG dist ${(distanceToZeroGammaPct * 100).toFixed(2)}%)`,
    };
  }

  // 5. POS_GAMMA_PIN: Net GEX > 0 / above Zero Gamma inside Put/Call corridor -> Wall mean reversion
  if (
    isPositiveGamma &&
    (!hasTwoSidedWalls || (safeSpot >= putWall * 0.996 && safeSpot <= callWall * 1.004))
  ) {
    return {
      regime: "POS_GAMMA_PIN",
      wallCorridorPct: Number((wallCorridorPct * 100).toFixed(3)),
      wallRoomPct: Number((wallRoomPct * 100).toFixed(3)),
      absPeclet: Number(absPeclet.toFixed(2)),
      effectivePeclet: Number(effectivePeclet.toFixed(2)),
      distanceToZeroGammaPct: Number((distanceToZeroGammaPct * 100).toFixed(3)),
      favoredStrategies: [
        "Wall-Extremity Mean Reversion",
        "King Magnet Pin Pull",
        "Flow VWAP ±1σ/±2σ Bounce",
      ],
      preferredDte: "1-2DTE",
      shouldStandAside: false,
      reason: `Positive Gamma Wall Pin (${putWall > 0 ? putWall : "?"}–${callWall > 0 ? callWall : "?"} corridor, |Pe|=${absPeclet.toFixed(2)})`,
    };
  }

  // Remaining strong directional trend outside Positive Gamma Pin
  return {
    regime: "NEG_GAMMA_TREND",
    wallCorridorPct: Number((wallCorridorPct * 100).toFixed(3)),
    wallRoomPct: Number((wallRoomPct * 100).toFixed(3)),
    absPeclet: Number(absPeclet.toFixed(2)),
    effectivePeclet: Number(effectivePeclet.toFixed(2)),
    distanceToZeroGammaPct: Number((distanceToZeroGammaPct * 100).toFixed(3)),
    favoredStrategies: ["Directional Advection Momentum"],
    preferredDte: "0DTE",
    shouldStandAside: false,
    reason: `Directional Advection Regime (Pe=${effectivePeclet.toFixed(2)})`,
  };
}

/**
 * Walk-Forward Additive Empirical Expectancy Scorer
 * Calibrated causally using strictly prior [D-10, D-1] samples + Empirical Bayes shrinkage.
 */
export function scoreSetupExpectancy(
  input: ScoreSetupExpectancyInput
): AlphaSetupScore {
  const {
    direction,
    setupName,
    spotPrice,
    stopLossSpot,
    target1Spot,
    callWall,
    putWall,
    zeroGamma,
    zeroDteKing,
    bookCenter,
    divergence5m = "NO",
    divergence30m = "NO",
    flowSnapshot,
    regimeClassification,
    priors: rawPriors,
    priorSamples,
    minWinRatePct = 58.0,
    minExpectancyR = 0.35,
  } = input;

  const priors = rawPriors ?? cloneDefaultAlphaPriors();
  const isCall = direction === "CALL";
  const risk = Math.max(0.01, Math.abs(spotPrice - stopLossSpot));
  const reward1 = Math.abs(target1Spot - spotPrice);
  const rrRatio = Number((reward1 / risk).toFixed(2));

  // Feature 1: Boundary Flux Alignment (chi, netFluxJ, effectivePeclet, 6-bar impulse)
  const chi = flowSnapshot?.ceilingShareChi ?? (isCall ? 0.56 : 0.44);
  const impChi = flowSnapshot?.impulseChi ?? chi;
  const rawFluxPe = flowSnapshot?.pecletNumber ?? (isCall ? 1.25 : -1.25);
  const hasImpFluxPe =
    typeof flowSnapshot?.impulsePeclet === "number" && Number.isFinite(flowSnapshot.impulsePeclet);
  const pe =
    hasImpFluxPe && Math.abs(rawFluxPe) >= 24.5
      ? (flowSnapshot!.impulsePeclet as number)
      : hasImpFluxPe && Math.abs(flowSnapshot!.impulsePeclet as number) > Math.abs(rawFluxPe)
        ? (flowSnapshot!.impulsePeclet as number)
        : rawFluxPe;
  const flux = flowSnapshot?.netFluxJ ?? (isCall ? 0.12 : -0.12);
  const dFlux6 = flowSnapshot?.deltaNetFlux6Bar ?? 0;

  let fluxScore = 0.45;
  const dChi6 = flowSnapshot?.deltaChi6Bar ?? 0;
  const dImpChi6 = flowSnapshot?.deltaImpulseChi6Bar ?? 0;
  if (isCall) {
    if (chi >= 0.56 || impChi >= 0.6) fluxScore += 0.22;
    if (flux > 0 || dFlux6 > 0) fluxScore += 0.18;
    if (pe >= 1.2) fluxScore += 0.15;
    else if (pe < -0.5 && dFlux6 <= 0) fluxScore -= 0.25;
    if (chi <= 0.15 && dChi6 <= 0) fluxScore -= 0.40;
    else if (chi <= 0.28 && dFlux6 <= 0 && dImpChi6 < 0.15) fluxScore -= 0.35;
  } else {
    if (chi <= 0.44 || impChi <= 0.4) fluxScore += 0.22;
    if (flux < 0 || dFlux6 < 0) fluxScore += 0.18;
    if (pe <= -1.2) fluxScore += 0.15;
    else if (pe > 0.5 && dFlux6 >= 0) fluxScore -= 0.25;
    if (chi >= 0.85 && dChi6 >= 0 && dFlux6 > 0) fluxScore -= 0.40;
    else if (chi >= 0.72 && dFlux6 >= 0 && dImpChi6 > -0.15) fluxScore -= 0.35;
  }
  fluxScore = Math.max(0, Math.min(1, fluxScore));

  // Feature 2: Flow VWAP & Sigma Band Positioning
  const fvwap = flowSnapshot?.flowVwap ?? 0;
  const sigma = Math.max(0.05, flowSnapshot?.sigma ?? spotPrice * 0.002);
  const zVwap = fvwap > 0 ? (spotPrice - fvwap) / sigma : 0;
  let bandScore = 0.6;
  const bandSig = flowSnapshot?.bandSignal ?? null;
  if (isCall) {
    if (bandSig === "LOWER_2S_BOUNCE" || bandSig === "LOWER_1S_BOUNCE") {
      bandScore = 0.95;
    } else if (zVwap >= 1.6) {
      bandScore = 0.20; // Chasing +1.6 sigma extension
    } else if (fvwap > 0 && spotPrice >= fvwap && zVwap < 1.6) {
      bandScore = 0.82;
    } else if (fvwap > 0 && spotPrice < fvwap && zVwap < -1.0 && regimeClassification.regime !== "POS_GAMMA_PIN") {
      bandScore = 0.35;
    }
  } else {
    if (bandSig === "UPPER_2S_REJECT" || bandSig === "UPPER_1S_REJECT") {
      bandScore = 0.95;
    } else if (zVwap <= -1.6) {
      bandScore = 0.20; // Chasing -1.6 sigma flush exhaustion
    } else if (fvwap > 0 && spotPrice <= fvwap && zVwap > -1.6) {
      bandScore = 0.82;
    } else if (fvwap > 0 && spotPrice > fvwap && zVwap > 1.0 && regimeClassification.regime !== "POS_GAMMA_PIN") {
      bandScore = 0.35;
    }
  }

  // Feature 3: Structural Wall Room & Risk/Reward
  const roomToTargetWall = isCall
    ? callWall > spotPrice
      ? callWall - spotPrice
      : reward1
    : putWall > 0 && putWall < spotPrice
      ? spotPrice - putWall
      : reward1;
  const minRoomRatio = Math.max(0, (roomToTargetWall / Math.max(0.05, risk) - 1.0) / 2.0);
  const rrComponent = rrRatio >= 1.5 ? Math.min(1, 0.58 + (rrRatio - 1.5) * 0.25) : Math.max(0, rrRatio / 3.0);
  const wallRoomScore = Math.max(0, Math.min(1, 0.65 * rrComponent + 0.35 * Math.min(1, minRoomRatio)));

  // Feature 4: 0DTE King / Book Center Alignment
  const magnet =
    zeroDteKing && zeroDteKing > 0
      ? zeroDteKing
      : bookCenter && bookCenter > 0
        ? bookCenter
        : zeroGamma > 0
          ? zeroGamma
          : 0;
  let kingScore = 0.62;
  if (magnet > 0) {
    const magnetPull = isCall ? magnet >= spotPrice - spotPrice * 0.001 : magnet <= spotPrice + spotPrice * 0.001;
    const isReversionTowardKing =
      (isCall && magnet > spotPrice) || (!isCall && magnet < spotPrice);
    kingScore = isReversionTowardKing ? 0.92 : magnetPull ? 0.65 : 0.32;
  }

  // Feature 5: Multi-Timeframe Divergence Confluence
  const targetDiv = isCall ? "BULL" : "BEAR";
  const oppDiv = isCall ? "BEAR" : "BULL";
  let divScore = 0.58;
  if (divergence5m === targetDiv && divergence30m === targetDiv) divScore = 0.98;
  else if (divergence5m === targetDiv || divergence30m === targetDiv) divScore = 0.85;
  else if (divergence5m === oppDiv || divergence30m === oppDiv) divScore = 0.2;

  // Feature 6: Regime-Strategy Fit
  const setupLower = setupName.toLowerCase();
  let regimeFitScore = 0.6;
  if (regimeClassification.regime === "LOW_EDGE_CHOP" || regimeClassification.shouldStandAside) {
    regimeFitScore = 0.0;
  } else if (regimeClassification.regime === "POS_GAMMA_PIN") {
    const isMeanRev =
      setupLower.includes("bounce") ||
      setupLower.includes("reject") ||
      setupLower.includes("reclaim") ||
      setupLower.includes("king") ||
      setupLower.includes("pin") ||
      setupLower.includes("extremity") ||
      setupLower.includes("sweep");
    regimeFitScore = isMeanRev ? 0.9 : 0.62;
  } else if (regimeClassification.regime === "NEG_GAMMA_TREND") {
    const isMomentum =
      setupLower.includes("flush") ||
      setupLower.includes("break") ||
      setupLower.includes("advection") ||
      setupLower.includes("reclaim") ||
      setupLower.includes("reject");
    regimeFitScore = isMomentum ? 0.92 : 0.6;
  } else if (regimeClassification.regime === "ZERO_GAMMA_FLIP") {
    regimeFitScore = setupLower.includes("zero-gamma") || setupLower.includes("impulse") || setupLower.includes("reclaim")
      ? 0.95
      : 0.72;
  }

  const w = priors.featureWeights;
  const totalW =
    w.fluxAlignment +
    w.flowVwapBand +
    w.wallRoom +
    w.kingMagnet +
    w.mtfDivergence +
    w.regimeFit;

  const compositeFeatureScore = Number(
    (
      (w.fluxAlignment * fluxScore +
        w.flowVwapBand * bandScore +
        w.wallRoom * wallRoomScore +
        w.kingMagnet * kingScore +
        w.mtfDivergence * divScore +
        w.regimeFit * regimeFitScore) /
      Math.max(0.01, totalW)
    ).toFixed(4)
  );

  // Causal Empirical Bayes pooling from strictly prior sessions [D-10, D-1]
  let sampleWins = 0;
  let sampleTotal = 0;
  let sampleSumR = 0;

  if (Array.isArray(priorSamples) && priorSamples.length > 0) {
    const regimeMatching = priorSamples.filter((s) => s.regime === regimeClassification.regime);
    const pool = regimeMatching.length >= 3 ? regimeMatching : priorSamples;
    sampleTotal = pool.length;
    for (const s of pool) {
      if (s.won) sampleWins++;
      sampleSumR += s.rMultiple;
    }
  } else {
    const rs = priors.regimeStats[regimeClassification.regime];
    if (rs && rs.wins + rs.losses > 0) {
      sampleWins = rs.wins;
      sampleTotal = rs.wins + rs.losses;
      sampleSumR = rs.sumR;
    }
  }

  const m = Math.max(5, priors.priorStrengthM || 5);
  const rawW = sampleTotal > 0 ? sampleWins / sampleTotal : priors.baselineWinRate;
  const rawE = sampleTotal > 0 ? sampleSumR / sampleTotal : priors.baselineExpectancyR;

  const ebWinBase = (sampleTotal * rawW + m * priors.baselineWinRate) / (sampleTotal + m);
  const ebExpBase = (sampleTotal * rawE + m * priors.baselineExpectancyR) / (sampleTotal + m);

  // Feature-conditioned shift relative to neutral threshold 0.55
  const featureDelta = compositeFeatureScore - 0.55;
  const conditionedWin = Math.max(0.15, Math.min(0.92, ebWinBase + featureDelta * 0.46));
  const conditionedExpR = Math.max(-1.0, Math.min(2.2, ebExpBase + featureDelta * 1.35));

  const calibratedWinRate = Number((conditionedWin * 100).toFixed(1));
  const calibratedExpectancyR = Number(conditionedExpR.toFixed(2));
  const dataConvictionScore = Math.max(
    10,
    Math.min(
      99,
      Math.round(
        compositeFeatureScore * 52 +
          calibratedWinRate * 0.45 +
          Math.max(-0.5, calibratedExpectancyR) * 18
      )
    )
  );

  const hasLiveFlow = Boolean(
    flowSnapshot &&
      (typeof flowSnapshot.pecletNumber === "number" || typeof flowSnapshot.impulsePeclet === "number")
  );
  const isColdStart = sampleTotal < 5;
  let rejectionReason: string | null = null;
  if (regimeClassification.shouldStandAside || regimeClassification.regime === "LOW_EDGE_CHOP") {
    rejectionReason = `REGIME_VETO: ${regimeClassification.reason}`;
  } else if (rrRatio < 1.5) {
    rejectionReason = `RR_BELOW_1_5: ${rrRatio.toFixed(2)} < 1.50`;
  } else if (hasLiveFlow && (fluxScore < 0.45 || compositeFeatureScore < 0.55)) {
    rejectionReason = `WEAK_ALPHA_CONFLUENCE: flux=${fluxScore.toFixed(2)}, score=${compositeFeatureScore.toFixed(2)}`;
  } else if (isColdStart) {
    // Cold start (< 5 real trades): admit on standard physics/structural confluence above until posterior Bayes activates
  } else if (calibratedWinRate < minWinRatePct) {
    rejectionReason = `LOW_WIN_RATE: ${calibratedWinRate.toFixed(1)}% < ${minWinRatePct.toFixed(1)}%`;
  } else if (calibratedExpectancyR < minExpectancyR) {
    rejectionReason = `NEGATIVE_OR_WEAK_EXPECTANCY: +${calibratedExpectancyR.toFixed(2)}R < +${minExpectancyR.toFixed(2)}R`;
  }

  return {
    featureBreakdown: {
      fluxAlignment: Number(fluxScore.toFixed(3)),
      flowVwapBand: Number(bandScore.toFixed(3)),
      wallRoom: Number(wallRoomScore.toFixed(3)),
      kingMagnet: Number(kingScore.toFixed(3)),
      mtfDivergence: Number(divScore.toFixed(3)),
      regimeFit: Number(regimeFitScore.toFixed(3)),
    },
    compositeFeatureScore,
    rrRatio,
    sampleSize: sampleTotal,
    calibratedWinRate,
    calibratedExpectancyR,
    dataConvictionScore,
    passesGate: rejectionReason === null,
    rejectionReason,
  };
}

/**
 * Greeks-Aware & Regime-Adaptive Contract Optimizer
 * Preserves ALL small-account hard invariants:
 * - Ask in [$0.15, $0.99] -> strictly 1 contract, <= $100 outlay
 * - Time-of-Day Adaptive Delta Band:
 *   - 09:35-10:29 ET (etMins < 630): 0.24 <= |delta| <= 0.50
 *   - >= 10:30 ET (etMins >= 630):   0.35 <= |delta| <= 0.50
 * - Near-ATM / 1-3 OTM ceiling <= min($3.50, 0.45% of spot)
 * - Spread <= 24% and bid <= ask
 * - Expired contract firewall (dte >= 0 && expiration >= todayEt)
 * - Structural wall boundaries
 * - Falls back to 1-2 DTE whenever 0DTE qualifying contracts exceed $0.99
 *
 * Ranks valid contracts by Gamma-to-Theta efficiency (Gamma / |Theta|),
 * IV skew attractiveness, spread tightness, wall affinity, and DTE regime preference.
 */
export function selectOptimalSmallAccountContract(params: {
  candidates: ContractCandidateInput[];
  spotPrice: number;
  target1Spot: number;
  target2Spot: number;
  isCall: boolean;
  isSpxw?: boolean;
  zeroDteCallWall?: number;
  zeroDtePutWall?: number;
  isAfternoon: boolean;
  preferredDte?: "0DTE" | "1-2DTE" | "NONE";
  regime?: MarketRegimeId;
  absImpulsePeclet?: number;
  remainingExpectedMove?: number;
  etMins?: number;
  nowMs?: number;
}): ScoredContractSelection | null {
  const {
    candidates,
    spotPrice,
    target1Spot,
    target2Spot,
    isCall,
    isSpxw = false,
    zeroDteCallWall,
    zeroDtePutWall,
    isAfternoon,
    preferredDte,
    regime,
    absImpulsePeclet,
    remainingExpectedMove,
    nowMs = Date.now(),
  } = params;

  if (!candidates || candidates.length === 0) return null;

  const effectiveMinDelta = resolveMinOptionDelta({
    regime: regime ?? (preferredDte === "1-2DTE" ? "POS_GAMMA_PIN" : undefined),
    absImpulsePeclet,
    etMins: params.etMins,
  });

  // Compute median ATM IV across valid candidates for IV-skew evaluation
  const nearAtmIvs = candidates
    .filter((c) => Math.abs(c.contract.strike - spotPrice) <= spotPrice * 0.008)
    .map((c) => {
      const iv = c.contract.iv ?? 0;
      return iv > 4 ? iv / 100 : iv;
    })
    .filter((iv) => Number.isFinite(iv) && iv >= 0.04 && iv <= 2.5)
    .sort((a, b) => a - b);
  const atmMedianIv =
    nearAtmIvs.length > 0 ? nearAtmIvs[Math.floor(nearAtmIvs.length / 2)] : 0.2;

  type ScoredCand = ContractCandidateInput & {
    score: number;
    gammaThetaEfficiency: number;
    ivSkewAdjustment: number;
    dailyTheta: number;
    netEv: number;
    spreadToEdgeRatio: number;
  };

  const stage1: ScoredCand[] = [];
  const stage2: ScoredCand[] = [];
  const stage3: ScoredCand[] = [];
  const maxOtmDist = Math.min(3.5, spotPrice * 0.0045);

  const structuralTargetWall = isCall
    ? (zeroDteCallWall && isSpxw ? zeroDteCallWall / 10 : zeroDteCallWall)
    : (zeroDtePutWall && isSpxw ? zeroDtePutWall / 10 : zeroDtePutWall);
  const rawTargetMove = Math.abs(target1Spot - spotPrice);
  const wallRoom =
    structuralTargetWall &&
    structuralTargetWall > 0 &&
    ((isCall && structuralTargetWall > spotPrice) || (!isCall && structuralTargetWall < spotPrice))
      ? Math.abs(structuralTargetWall - spotPrice)
      : rawTargetMove;
  const minExpectedMove = spotPrice * 0.0007;
  const boundedByWall = Math.max(
    minExpectedMove,
    Math.min(Math.max(minExpectedMove, rawTargetMove), Math.max(minExpectedMove, wallRoom))
  );
  const expMove =
    typeof remainingExpectedMove === "number" &&
    Number.isFinite(remainingExpectedMove) &&
    remainingExpectedMove > 0
      ? Math.max(minExpectedMove, Math.min(boundedByWall, remainingExpectedMove))
      : boundedByWall;

  for (const cand of candidates) {
    const c = cand.contract;
    const askPrice = cand.ask;
    const bidPrice = cand.bid;
    const mid = cand.mid;
    const dte = cand.dte;
    const absDelta = cand.absDelta;

    // Regime & advection conditioned delta band
    if (!Number.isFinite(absDelta) || absDelta < effectiveMinDelta || absDelta > MAX_OPTION_DELTA) {
      continue;
    }
    if (!Number.isFinite(askPrice) || askPrice < 0.15 || askPrice > 0.99) {
      continue;
    }
    if (!Number.isFinite(bidPrice) || bidPrice < 0 || bidPrice > askPrice) {
      continue;
    }
    const spreadPct = askPrice > 0 ? (askPrice - bidPrice) / askPrice : 1;
    if (spreadPct > 0.24) {
      continue;
    }
    if (Math.abs(c.strike - spotPrice) > maxOtmDist) {
      continue;
    }
    const oi = Number(c.openInterest ?? 0);
    const vol = Number(c.volume ?? 0);
    if (oi < 100 && !(dte === 0 && vol >= 250)) {
      continue;
    }

    const priceScore = mid >= 0.35 && mid <= 0.85 ? 45 : 22;

    const distToTarget = Math.abs(c.strike - target1Spot);
    const targetDistUnit = Math.max(0.2, spotPrice * 0.0013);
    const targetScore = Math.max(0, 35 - (distToTarget / targetDistUnit) * 3.5);

    const gammaEst = Math.max(0, c.gamma || 0);

    // Gamma-to-Theta efficiency: Γ / max(0.005, |Θ_daily|)
    const rawIv =
      typeof c.iv === "number" && Number.isFinite(c.iv) && c.iv > 0
        ? c.iv > 4
          ? c.iv / 100
          : c.iv
        : atmMedianIv;
    const tYears = estimateRemainingYears(nowMs, dte);
    const dailyTheta =
      typeof cand.theta === "number" && Number.isFinite(cand.theta) && cand.theta < 0
        ? cand.theta
        : computeDailyOptionTheta(spotPrice, c.strike, tYears, rawIv, isCall);

    // Second-Order Taylor Net Payoff Router & Hard Spread-to-Edge Veto (spread / expectedDollarMove > 0.22)
    const taylorEval = computeTaylorNetPayoff({
      absDelta,
      gamma: gammaEst,
      dailyTheta,
      bid: bidPrice,
      ask: askPrice,
      expectedUnderlyingMove: expMove,
      minDelta: effectiveMinDelta,
    });
    if (!taylorEval.allowed) {
      continue;
    }
    const deltaScore = 18 + Math.min(42, taylorEval.netEvPerDollarAsk * 45);

    const gammaThetaEfficiency = Number(
      (gammaEst / Math.max(0.005, Math.abs(dailyTheta))).toFixed(3)
    );
    const gammaThetaScore = Math.min(32, gammaThetaEfficiency * 12);

    // IV skew reward/penalty vs median ATM IV
    let ivSkewAdjustment = 0;
    if (atmMedianIv > 0 && rawIv > 0) {
      const ivRatio = rawIv / atmMedianIv;
      if (ivRatio <= 1.03) ivSkewAdjustment = 10;
      else if (ivRatio >= 1.2) ivSkewAdjustment = -15;
    }

    // Spread-to-edge tightness score anchored to hard 0.22 veto boundary
    const spreadTightnessScore = Math.max(
      0,
      (1 - taylorEval.spreadToEdgeRatio / MAX_SPREAD_TO_EDGE_RATIO) * 18
    );

    const liqScore = Math.min(20, ((c.openInterest || 0) + (c.volume || 0)) / 120);

    let wallAffinityScore = 0;
    const targetWall = isCall
      ? (zeroDteCallWall && isSpxw ? zeroDteCallWall / 10 : zeroDteCallWall) || target2Spot
      : (zeroDtePutWall && isSpxw ? zeroDtePutWall / 10 : zeroDtePutWall) || target2Spot;
    if (targetWall && targetWall > 0) {
      const distToWall = Math.abs(c.strike - targetWall);
      const wallTier1 = Math.max(0.5, spotPrice * 0.0027);
      const wallTier2 = Math.max(1.0, spotPrice * 0.0053);
      const wallTier3 = Math.max(2.0, spotPrice * 0.0107);
      if (distToWall <= wallTier1) wallAffinityScore += 45;
      else if (distToWall <= wallTier2) wallAffinityScore += 28;
      else if (distToWall <= wallTier3) wallAffinityScore += 10;

      if (!isCall && c.strike < targetWall - wallTier2) wallAffinityScore -= 35;
      else if (isCall && c.strike > targetWall + wallTier2) wallAffinityScore -= 35;
    }

    const totalScore = Number(
      (
        priceScore +
        targetScore +
        deltaScore +
        gammaThetaScore +
        ivSkewAdjustment +
        spreadTightnessScore +
        liqScore +
        wallAffinityScore
      ).toFixed(3)
    );

    const scoredObj: ScoredCand = {
      ...cand,
      score: totalScore,
      gammaThetaEfficiency,
      ivSkewAdjustment,
      dailyTheta: Number(dailyTheta.toFixed(4)),
      netEv: Number(taylorEval.netEvPerDollarAsk.toFixed(4)),
      spreadToEdgeRatio: Number(taylorEval.spreadToEdgeRatio.toFixed(4)),
    };

    if (preferredDte === "0DTE") {
      // Prioritize 0DTE convexity when affordable <= $0.99; fall back to 1-2 DTE first, then 3+ DTE
      if (dte === 0) stage1.push(scoredObj);
      else if (dte >= 1 && dte <= 2) stage2.push(scoredObj);
      else stage3.push(scoredObj);
    } else if (preferredDte === "1-2DTE") {
      // POS_GAMMA_PIN: prioritize 1-2 DTE to minimize theta crush
      if (dte >= 1 && dte <= 2) {
        stage1.push(scoredObj);
      } else if (dte >= 3) {
        stage2.push(scoredObj);
      } else {
        if (isAfternoon) scoredObj.score -= 25;
        stage3.push(scoredObj);
      }
    } else if (isAfternoon) {
      // Default afternoon regime: 1-2 DTE Stage 1, 3+ DTE Stage 2, 0DTE penalized fallback
      if (dte >= 1 && dte <= 2) {
        stage1.push(scoredObj);
      } else if (dte >= 3) {
        stage2.push(scoredObj);
      } else {
        scoredObj.score -= 25;
        stage3.push(scoredObj);
      }
    } else {
      // Default morning regime: 0-2 DTE Stage 1, 3+ DTE Stage 2
      if (dte >= 0 && dte <= 2) stage1.push(scoredObj);
      else stage2.push(scoredObj);
    }
  }

  stage1.sort((a, b) => b.score - a.score);
  stage2.sort((a, b) => b.score - a.score);
  stage3.sort((a, b) => b.score - a.score);
  const chosen = stage1[0] ?? stage2[0] ?? stage3[0];
  if (!chosen) return null;

  return {
    chosen,
    evaluatedCount: candidates.length,
  };
}
