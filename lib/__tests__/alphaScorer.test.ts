import test from "node:test";
import assert from "node:assert/strict";
import {
  ContractCandidateInput,
  classifyMarketRegime,
  scoreSetupExpectancy,
  selectOptimalSmallAccountContract,
} from "../alphaScorer";
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
    delta: 0.34,
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
