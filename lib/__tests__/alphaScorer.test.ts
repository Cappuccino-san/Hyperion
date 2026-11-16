import test from "node:test";
import assert from "node:assert/strict";
import {
  ContractCandidateInput,
  classifyMarketRegime,
  evaluateLeg2StructuralGate,
  evaluateOpeningHorizonAlignment,
  scoreSetupExpectancy,
  selectOptimalSmallAccountContract,
} from "../alphaScorer";
import { evaluateOptionRiskStop } from "../bracketOrderEngine";
import type { FlowGammaVwapSnapshot } from "../flowGammaVwap";
import { cloneDefaultAlphaPriors } from "../persistenceStore";

function makeFlowSnap(overrides: Partial<FlowGammaVwapSnapshot> = {}): FlowGammaVwapSnapshot {
  return {
    timestamp: 1794580500,
    spot: 755,
    flowVwap: 755,
    upper1s: 757,
    lower1s: 753,
    upper2s: 759,
    lower2s: 751,
    upper1Sigma: 757,
    lower1Sigma: 753,
    upper2Sigma: 759,
    lower2Sigma: 751,
    sigma: 2.0,
    variance: 4.0,
    cumGammaWeight: 100,
    totalWeight: 100,
    signedGammaAcceleration: 0,
    count: 10,
    ceilingShareChi: 0.65,
    netFluxJ: 2.5,
    pecletNumber: 2.4,
    gammaRegime: "POSITIVE_GAMMA",
    bandSignal: null,
    impulseChi: 0.65,
    impulsePeclet: 2.4,
    deltaChi6Bar: 0.08,
    deltaImpulseChi6Bar: 0.1,
    deltaNetFlux6Bar: 4.5,
    ...overrides,
  };
}

function makeContractCandidate(params: {
  symbol: string;
  strike: number;
  dte: number;
  expiration: string;
  bid: number;
  ask: number;
  delta: number;
  gamma: number;
  iv: number;
  theta: number;
  optionType?: "C" | "P";
}): ContractCandidateInput {
  return {
    contract: {
      symbol: params.symbol,
      strike: params.strike,
      expiration: params.expiration,
      optionType: params.optionType ?? "C",
      bid: params.bid,
      ask: params.ask,
      last: Number(((params.bid + params.ask) / 2).toFixed(2)),
      volume: 15000,
      openInterest: 10000,
      delta: params.delta,
      gamma: params.gamma,
      vega: 0.12,
      iv: params.iv,
      percentChange: 0,
    },
    mid: Number(((params.bid + params.ask) / 2).toFixed(2)),
    bid: params.bid,
    ask: params.ask,
    dte: params.dte,
    expHuman: params.expiration,
    robinhoodExp: params.expiration,
    robinhoodTab: params.dte === 0 ? "0DTE" : `${params.dte}DTE`,
    absDelta: Math.abs(params.delta),
    theta: params.theta,
  };
}

test("classifyMarketRegime splits all 4 microstructural regimes and defers opening +/-25 Pe saturation", () => {
  // 1. LOW_EDGE_CHOP via compressed corridor (< 0.16%)
  const chopCorridor = classifyMarketRegime({
    spotPrice: 750,
    callWall: 750.8,
    putWall: 749.9,
    zeroGamma: 750,
    netGex: 15,
    flowSnapshot: makeFlowSnap({ pecletNumber: 0.8, impulsePeclet: 0.8 }),
  });
  assert.equal(chopCorridor.regime, "LOW_EDGE_CHOP");
  assert.equal(chopCorridor.shouldStandAside, true);
  assert.equal(chopCorridor.preferredDte, "NONE");

  // 2. Opening Péclet saturation (+/-25) with weak impulsePeclet (0.45) must defer to impulsePeclet and filter chop
  const saturatedOpenChop = classifyMarketRegime({
    spotPrice: 754,
    callWall: 760,
    putWall: 748,
    zeroGamma: 753.5,
    netGex: 12,
    flowSnapshot: makeFlowSnap({
      pecletNumber: 25,
      impulsePeclet: 0.45,
      bandSignal: null,
    }),
  });
  assert.equal(saturatedOpenChop.regime, "LOW_EDGE_CHOP");
  assert.equal(saturatedOpenChop.effectivePeclet, 0.45);
  assert.equal(saturatedOpenChop.shouldStandAside, true);

  // 3. NEG_GAMMA_TREND (0DTE preference)
  const negTrend = classifyMarketRegime({
    spotPrice: 748,
    callWall: 760,
    putWall: 740,
    zeroGamma: 756,
    netGex: -28,
    flowSnapshot: makeFlowSnap({
      pecletNumber: -3.2,
      impulsePeclet: -3.2,
      ceilingShareChi: 0.12,
      impulseChi: 0.2,
      netFluxJ: -5.4,
      deltaNetFlux6Bar: -12,
      gammaRegime: "NEGATIVE_GAMMA",
    }),
  });
  assert.equal(negTrend.regime, "NEG_GAMMA_TREND");
  assert.equal(negTrend.preferredDte, "0DTE");
  assert.equal(negTrend.shouldStandAside, false);

  // 4. ZERO_GAMMA_FLIP (reclaiming Zero Gamma + positive impulse)
  const zgFlip = classifyMarketRegime({
    spotPrice: 755.5,
    callWall: 762,
    putWall: 748,
    zeroGamma: 755.0,
    netGex: 8,
    flowSnapshot: makeFlowSnap({
      flowVwap: 755.1,
      pecletNumber: 2.1,
      impulsePeclet: 2.1,
      deltaImpulseChi6Bar: 0.18,
    }),
  });
  assert.equal(zgFlip.regime, "ZERO_GAMMA_FLIP");
  assert.equal(zgFlip.preferredDte, "0DTE");
  assert.equal(zgFlip.shouldStandAside, false);

  // 5. POS_GAMMA_PIN (inside walls, calm positive GEX near lower extremity -> 1-2DTE)
  const posPin = classifyMarketRegime({
    spotPrice: 750.4,
    callWall: 762,
    putWall: 750,
    zeroGamma: 747,
    netGex: 40,
    flowSnapshot: makeFlowSnap({
      flowVwap: 755,
      pecletNumber: 0.9,
      impulsePeclet: 0.9,
      bandSignal: "LOWER_2S_BOUNCE",
      deltaChi6Bar: 0,
      deltaImpulseChi6Bar: 0,
      deltaNetFlux6Bar: 0,
    }),
  });
  assert.equal(posPin.regime, "POS_GAMMA_PIN");
  assert.equal(posPin.preferredDte, "1-2DTE");
  assert.equal(posPin.shouldStandAside, false);
});

test("scoreSetupExpectancy uses causal [D-10, D-1] priors and blocks counter-flux or low-R setups", () => {
  const priors = cloneDefaultAlphaPriors();
  const alignedRegime = classifyMarketRegime({
    spotPrice: 756,
    callWall: 764,
    putWall: 748,
    zeroGamma: 755.5,
    netGex: 15,
    flowSnapshot: makeFlowSnap({ bandSignal: "LOWER_2S_BOUNCE", pecletNumber: 2.6, impulsePeclet: 2.6 }),
  });

  const strongCall = scoreSetupExpectancy({
    direction: "CALL",
    setupName: "Support Bounce",
    spotPrice: 756,
    stopLossSpot: 754.2,
    target1Spot: 759.2,
    target2Spot: 762.5,
    callWall: 764,
    putWall: 748,
    zeroGamma: 755.5,
    zeroDteKing: 760,
    divergence5m: "BULL",
    divergence30m: "BULL",
    flowSnapshot: makeFlowSnap({ bandSignal: "LOWER_2S_BOUNCE", pecletNumber: 2.6, impulsePeclet: 2.6 }),
    regimeClassification: alignedRegime,
    priors,
    priorSamples: [
      { regime: "ZERO_GAMMA_FLIP", won: true, rMultiple: 1.5 },
      { regime: "ZERO_GAMMA_FLIP", won: true, rMultiple: 1.2 },
    ],
  });
  assert.equal(strongCall.passesGate, true);
  assert.ok(strongCall.calibratedExpectancyR >= 0.35);
  assert.ok(strongCall.calibratedWinRate >= 58);

  // Counter-flux short while session chi >= 0.85 and dFlux6 > 0 must fail
  const counterFluxPut = scoreSetupExpectancy({
    direction: "PUT",
    setupName: "Resistance Rejection",
    spotPrice: 756,
    stopLossSpot: 757.5,
    target1Spot: 753.0,
    target2Spot: 751.0,
    callWall: 764,
    putWall: 748,
    zeroGamma: 755.5,
    flowSnapshot: makeFlowSnap({
      ceilingShareChi: 0.96,
      impulseChi: 0.72,
      pecletNumber: 25,
      impulsePeclet: 1.5,
      netFluxJ: 3.1,
      deltaNetFlux6Bar: 4.5,
      deltaChi6Bar: 0.05,
    }),
    regimeClassification: alignedRegime,
    priors,
  });
  assert.equal(counterFluxPut.passesGate, false);
  assert.ok(counterFluxPut.rejectionReason?.includes("WEAK_ALPHA_CONFLUENCE"));
});

test("selectOptimalSmallAccountContract honors Gamma/Theta efficiency, IV skew, and $0.15-$0.99 invariant", () => {
  const highThetaRichIv0Dte = makeContractCandidate({
    symbol: "SPY261113C00757000",
    strike: 757,
    dte: 0,
    expiration: "2026-11-13",
    bid: 0.62,
    ask: 0.66,
    delta: 0.31,
    gamma: 0.045,
    iv: 0.31, // Rich IV skew vs 0.18 ATM
    theta: -0.45, // Severe decay
  });

  const cleanEfficiency1Dte = makeContractCandidate({
    symbol: "SPY261114C00757000",
    strike: 757,
    dte: 1,
    expiration: "2026-11-14",
    bid: 0.78,
    ask: 0.80,
    delta: 0.38,
    gamma: 0.042,
    iv: 0.17, // Fair IV skew
    theta: -0.09, // High Gamma/Theta efficiency
  });

  const selection = selectOptimalSmallAccountContract({
    candidates: [highThetaRichIv0Dte, cleanEfficiency1Dte],
    spotPrice: 755,
    target1Spot: 758,
    target2Spot: 760,
    isCall: true,
    zeroDteCallWall: 760,
    zeroDtePutWall: 750,
    isAfternoon: false,
    preferredDte: "1-2DTE",
  });

  assert.ok(selection);
  assert.equal(selection.chosen.dte, 1);
  assert.equal(selection.chosen.contract.symbol, "SPY261114C00757000");
  assert.ok(selection.chosen.ask >= 0.15 && selection.chosen.ask <= 0.99);
  assert.ok(selection.chosen.gammaThetaEfficiency > 0.3);
});

test("selectOptimalSmallAccountContract enforces Time-of-Day Adaptive Delta Floor (0.24 pre-10:30 ET, 0.35 from 10:30 ET onward) and 1-2 DTE fallback", () => {
  const belowMorningFloor = makeContractCandidate({
    symbol: "SPY261113C00758500",
    strike: 758.2,
    dte: 0,
    expiration: "2026-11-13",
    bid: 0.42,
    ask: 0.45,
    delta: 0.23, // < 0.24 morning floor -> always rejected
    gamma: 0.035,
    iv: 0.16,
    theta: -0.22,
  });

  const morningExactFloor = makeContractCandidate({
    symbol: "SPY261113C00758000",
    strike: 758,
    dte: 0,
    expiration: "2026-11-13",
    bid: 0.55,
    ask: 0.58,
    delta: 0.24, // exact 0.24 morning floor -> admitted at etMins < 630, rejected at etMins >= 630
    gamma: 0.04,
    iv: 0.16,
    theta: -0.25,
  });

  const subIntradayBorderline = makeContractCandidate({
    symbol: "SPY261113C00757500",
    strike: 757.5,
    dte: 0,
    expiration: "2026-11-13",
    bid: 0.70,
    ask: 0.73,
    delta: 0.34, // admitted pre-10:30 ET, rejected >= 10:30 ET (< 0.35)
    gamma: 0.045,
    iv: 0.16,
    theta: -0.22,
  });

  // 1. Morning Window (09:35-10:29 ET, etMins = 585 & boundary 629): 0.23 rejected, 0.24 admitted
  const morningRejectSub24 = selectOptimalSmallAccountContract({
    candidates: [belowMorningFloor],
    spotPrice: 755,
    target1Spot: 758,
    target2Spot: 760,
    isCall: true,
    isAfternoon: false,
    preferredDte: "0DTE",
    etMins: 585, // 09:45 AM ET
  });
  assert.equal(morningRejectSub24, null);

  const morningAccept24 = selectOptimalSmallAccountContract({
    candidates: [belowMorningFloor, morningExactFloor],
    spotPrice: 755,
    target1Spot: 758,
    target2Spot: 760,
    isCall: true,
    isAfternoon: false,
    preferredDte: "0DTE",
    etMins: 629, // 10:29 AM ET (last minute of morning window)
  });
  assert.ok(morningAccept24);
  assert.equal(morningAccept24.chosen.contract.symbol, "SPY261113C00758000");
  assert.equal(morningAccept24.chosen.absDelta, 0.24);

  // 2. Intraday / Afternoon Window (>= 10:30 ET, etMins = 630): 0.24 & 0.34 both rejected (< 0.35)
  const post1030Rejected = selectOptimalSmallAccountContract({
    candidates: [belowMorningFloor, morningExactFloor, subIntradayBorderline],
    spotPrice: 755,
    target1Spot: 758,
    target2Spot: 760,
    isCall: true,
    isAfternoon: false,
    preferredDte: "0DTE",
    etMins: 630, // exact 10:30 AM ET
  });
  assert.equal(post1030Rejected, null);

  // 3. Intraday >= 10:30 ET: 0DTE 0.42-delta exceeds $0.99 ask cap -> falls back to 1-2 DTE >= 0.35-delta
  const expensive0Dte = makeContractCandidate({
    symbol: "SPY261113C00755000",
    strike: 755,
    dte: 0,
    expiration: "2026-11-13",
    bid: 1.25,
    ask: 1.30, // > $0.99
    delta: 0.42,
    gamma: 0.06,
    iv: 0.16,
    theta: -0.4,
  });

  const fallback1Dte = makeContractCandidate({
    symbol: "SPY261114C00757000",
    strike: 757,
    dte: 1,
    expiration: "2026-11-14",
    bid: 0.82,
    ask: 0.85,
    delta: 0.37,
    gamma: 0.045,
    iv: 0.16,
    theta: -0.1,
  });

  const selection = selectOptimalSmallAccountContract({
    candidates: [morningExactFloor, subIntradayBorderline, expensive0Dte, fallback1Dte],
    spotPrice: 755,
    target1Spot: 758,
    target2Spot: 760,
    isCall: true,
    isAfternoon: true,
    preferredDte: "0DTE",
    etMins: 720, // 12:00 PM ET (>= 10:30 ET)
  });
  assert.ok(selection);
  assert.equal(selection.chosen.dte, 1);
  assert.equal(selection.chosen.contract.symbol, "SPY261114C00757000");
  assert.ok(selection.chosen.absDelta >= 0.35 && selection.chosen.absDelta <= 0.5);
});

test("evaluateOpeningHorizonAlignment blocks pre-10:00 King/Book-Center conflicts and admits >= 10:00 ET", () => {
  // Pre-10:00 ET with opposing 0DTE King (< spot for CALL) -> deferred
  const opposingKing = evaluateOpeningHorizonAlignment({
    etMins: 580, // 09:40 AM ET
    direction: "CALL",
    spotPrice: 755,
    zeroDteKing: 752,
    allExpKing: 760,
    bookCenterHistory: [753.8, 754.2, 754.7],
  });
  assert.equal(opposingKing.allowed, false);
  assert.equal(opposingKing.deferredUntil1000, true);

  // Pre-10:00 ET with 0DTE King above spot opposing All-Exp King below spot -> deferred
  const splitKings = evaluateOpeningHorizonAlignment({
    etMins: 585, // 09:45 AM ET
    direction: "CALL",
    spotPrice: 755,
    zeroDteKing: 758,
    allExpKing: 750,
    bookCenterHistory: [754.0, 754.5, 755.1],
  });
  assert.equal(splitKings.allowed, false);
  assert.ok(splitKings.reason?.includes("KING_CONFLICT"));

  // Pre-10:00 ET with flat/falling Book Center 3-bar slope for CALL -> deferred
  const flatSlope = evaluateOpeningHorizonAlignment({
    etMins: 590, // 09:50 AM ET
    direction: "CALL",
    spotPrice: 755,
    zeroDteKing: 758,
    allExpKing: 760,
    bookCenterHistory: [755.2, 755.0, 754.9],
  });
  assert.equal(flatSlope.allowed, false);
  assert.ok(flatSlope.reason?.includes("BOOK_CENTER_SLOPE"));

  // Pre-10:00 ET with aligned Kings & positive 3-bar Book Center slope -> allowed
  const alignedMorning = evaluateOpeningHorizonAlignment({
    etMins: 590,
    direction: "CALL",
    spotPrice: 755,
    zeroDteKing: 758,
    allExpKing: 760,
    bookCenterHistory: [754.1, 754.6, 755.2],
  });
  assert.equal(alignedMorning.allowed, true);
  assert.equal(alignedMorning.deferredUntil1000, false);

  // >= 10:00 ET opening range confirmation -> always allowed
  const post1000 = evaluateOpeningHorizonAlignment({
    etMins: 600,
    direction: "CALL",
    spotPrice: 755,
    zeroDteKing: 750,
    allExpKing: 748,
    bookCenterHistory: [755.5, 755.0, 754.5],
  });
  assert.equal(post1000.allowed, true);
});

test("evaluateLeg2StructuralGate enforces asymmetric structural transition & post-loss anti-whipsaw firewall", () => {
  const leg1ExitTs = 1794580200;
  // Post-loss Leg-2 opposite flip WITHOUT clean Zero-Gamma cross + hold must be vetoed
  const postLossNoCross = evaluateLeg2StructuralGate({
    direction: "CALL",
    etMins: 720, // 12:00 PM ET
    nowTsSec: leg1ExitTs + 2400, // 40m cooldown >= 30m
    spotPrice: 754.8,
    prevSpotPrice: 754.4,
    zeroGamma: 755.5, // Spot still below Zero Gamma
    flowVwap: 754.5,
    sma34: 754.4,
    leg1Trade: {
      contractType: "PUT",
      closedTs: leg1ExitTs,
      btoSpotPrice: 755.0,
      closedSpotPrice: 756.2,
      pnlOptionPct: -45.0,
      realizedPnl: -35,
    },
    testedPutWallOrMinus1Sigma: true,
    testedCallWallOrPlus1Sigma: false,
    has5mBullDiv: true,
    has5mBearDiv: false,
    impulseChi: 0.72,
    deltaChi6Bar: 0.08,
    impulsePeclet: 2.3,
    calibratedExpectancyR: 0.72,
  });
  assert.equal(postLossNoCross.allowed, false);
  assert.ok(postLossNoCross.reason?.includes("ANTI_WHIPSAW"));

  // Post-loss Leg-2 WITH clean Zero-Gamma cross+hold and |Pe| >= 2.2 -> allowed
  const postLossCleanCross = evaluateLeg2StructuralGate({
    direction: "CALL",
    etMins: 725,
    nowTsSec: leg1ExitTs + 2700,
    spotPrice: 756.1,
    prevSpotPrice: 755.7, // Both prev and current >= Zero Gamma 755.5
    zeroGamma: 755.5,
    flowVwap: 755.4,
    sma34: 755.3,
    leg1Trade: {
      contractType: "PUT",
      closedTs: leg1ExitTs,
      btoSpotPrice: 755.0,
      closedSpotPrice: 756.2,
      pnlOptionPct: -45.0,
      realizedPnl: -35,
    },
    testedPutWallOrMinus1Sigma: true,
    testedCallWallOrPlus1Sigma: false,
    has5mBullDiv: true,
    has5mBearDiv: false,
    impulseChi: 0.72,
    deltaChi6Bar: 0.08,
    impulsePeclet: 2.3,
    calibratedExpectancyR: 0.72,
  });
  assert.equal(postLossCleanCross.allowed, true);

  // Weak |Pe| < 2.0 on winning Leg-1 -> vetoed
  const weakPeclet = evaluateLeg2StructuralGate({
    direction: "PUT",
    etMins: 760,
    nowTsSec: leg1ExitTs + 2700,
    spotPrice: 758.0,
    prevSpotPrice: 758.6,
    zeroGamma: 755.0,
    flowVwap: 758.4,
    sma34: 758.5,
    leg1Trade: {
      contractType: "CALL",
      closedTs: leg1ExitTs,
      btoSpotPrice: 754.0,
      closedSpotPrice: 758.5,
      pnlOptionPct: 48.0,
    },
    testedPutWallOrMinus1Sigma: false,
    testedCallWallOrPlus1Sigma: true,
    has5mBullDiv: false,
    has5mBearDiv: true,
    impulseChi: 0.28,
    deltaChi6Bar: -0.06,
    impulsePeclet: -1.7,
    calibratedExpectancyR: 0.7,
  });
  assert.equal(weakPeclet.allowed, false);
  assert.ok(weakPeclet.reason?.includes("LEG2_WEAK_PECLET"));
});

test("evaluateOptionRiskStop enforces -45% hard stop and 20m -25% theta-stall tightener", () => {
  // 1. -45% hard stop triggers immediately on entry * 0.55
  const hardStop = evaluateOptionRiskStop({
    entryPrice: 0.8,
    currentPrice: 0.44, // -45.0%
    peakPnlPct: 5,
    heldMinutes: 8,
  });
  assert.equal(hardStop.triggered, true);
  assert.equal(hardStop.reason, "OPTION_HARD_STOP_45");
  assert.equal(hardStop.activeStopPrice, 0.44);

  // 2. 20m stall tightener: elapsed >= 20m, peak < +20%, price <= entry * 0.75 (-25%) -> triggers
  const stallStop = evaluateOptionRiskStop({
    entryPrice: 0.8,
    currentPrice: 0.6, // -25.0%
    peakPnlPct: 12,
    heldMinutes: 20,
  });
  assert.equal(stallStop.triggered, true);
  assert.equal(stallStop.stallTightened, true);
  assert.equal(stallStop.reason, "OPTION_STALL_STOP_25");
  assert.equal(stallStop.activeStopPrice, 0.6);

  // 3. If peak profit reached >= +20% before pulling back to -25%, 20m stall tightener stays inactive
  const runnerPullback = evaluateOptionRiskStop({
    entryPrice: 0.8,
    currentPrice: 0.6, // -25.0%, still above -45% hard floor
    peakPnlPct: 24,
    heldMinutes: 22,
  });
  assert.equal(runnerPullback.triggered, false);
  assert.equal(runnerPullback.stallTightened, false);
});

