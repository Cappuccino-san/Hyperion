/**
 * Unit Test Suite for Flow VWAP x Gamma Quantitative Engine
 *
 * Verifies:
 * 1. Zero flow prints default gracefully to spot without NaN or divide-by-zero errors.
 * 2. Symmetrical prints produce sigma equal to standard unweighted deviations.
 * 3. Session reset clears accumulators to zero.
 * 4. Dollar-Gamma trade weighting formulation accuracy.
 */

import assert from "node:assert";
import {
  FlowGammaVwapEngine,
  calculateDollarGammaWeight,
  computeBarFlowGammaVwapSeries,
  computeCeilingShareChi,
  computeSpectralModes,
  evaluateSpectralFlowAndFluxAtTau,
} from "../flowGammaVwap";

console.log("\n=======================================================");
console.log("Running Flow VWAP x Gamma Engine Verification Suite");
console.log("=======================================================\n");

let testsRun = 0;
let testsPassed = 0;

function runTest(name: string, fn: () => void) {
  testsRun++;
  try {
    fn();
    testsPassed++;
    console.log(`[PASS] ${name}`);
  } catch (err: any) {
    console.error(`[FAIL] ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

// -------------------------------------------------------------
// Test 1: Zero flow prints default gracefully to spot without NaN
// -------------------------------------------------------------
runTest("Zero flow prints default gracefully to spot without NaN or divide-by-zero", () => {
  const engine = new FlowGammaVwapEngine(580.5);
  const snap1 = engine.getSnapshot();

  assert.strictEqual(snap1.flowVwap, 580.5, "Default VWAP should equal initial spot");
  assert.strictEqual(snap1.spot, 580.5, "Spot should equal initial spot");
  assert.strictEqual(snap1.cumGammaWeight, 0, "Initial weight should be 0");
  assert.ok(!Number.isNaN(snap1.flowVwap), "VWAP must not be NaN");
  assert.ok(!Number.isNaN(snap1.sigma), "Sigma must not be NaN");
  assert.ok(!Number.isNaN(snap1.upper1s), "Upper 1s must not be NaN");
  assert.ok(!Number.isNaN(snap1.lower1s), "Lower 1s must not be NaN");
  assert.ok(!Number.isNaN(snap1.upper2s), "Upper 2s must not be NaN");
  assert.ok(!Number.isNaN(snap1.lower2s), "Lower 2s must not be NaN");

  // Add zero-weight spot tick
  const snap2 = engine.addSpotTick(585.0, 0);
  assert.strictEqual(snap2.spot, 585.0);
  assert.strictEqual(snap2.flowVwap, 585.0, "Zero-weight tick VWAP should track spot");
  assert.strictEqual(snap2.totalWeight, 0);
  assert.ok(!Number.isNaN(snap2.sigma));
  assert.strictEqual(snap2.sigma, Math.sqrt(0.10), "Sigma should clamp to min sqrt(0.10)");
});

// -------------------------------------------------------------
// Test 2: Symmetrical prints produce sigma equal to standard unweighted deviations
// -------------------------------------------------------------
runTest("Symmetrical prints produce sigma equal to standard unweighted deviations", () => {
  const engine = new FlowGammaVwapEngine();

  // Two symmetrical prints: 500 and 520 with identical weight W
  // Mean = 510. Unweighted deviations: -10, +10.
  // Standard unweighted deviation = sqrt(((-10)^2 + (+10)^2) / 2) = sqrt(200 / 2) = 10.0
  const weight = 2500;
  engine.addPoint(500, weight);
  const snap2 = engine.addPoint(520, weight);

  assert.strictEqual(snap2.flowVwap, 510.0, "VWAP should be exact mean 510.0");
  assert.strictEqual(Math.round(snap2.sigma * 1e6) / 1e6, 10.0, "Sigma should equal unweighted deviation 10.0");
  assert.strictEqual(snap2.upper1s, 520.0, "Upper 1s should be 510 + 10 = 520");
  assert.strictEqual(snap2.lower1s, 500.0, "Lower 1s should be 510 - 10 = 500");
  assert.strictEqual(snap2.upper2s, 530.0, "Upper 2s should be 510 + 20 = 530");
  assert.strictEqual(snap2.lower2s, 490.0, "Lower 2s should be 510 - 20 = 490");

  // Three symmetrical prints: 100, 110, 120 with equal weight
  // Mean = 110. Deviations: -10, 0, +10.
  // Variance = (100 + 0 + 100) / 3 = 200 / 3 = 66.666667
  // Sigma = sqrt(200 / 3) ~= 8.1649658
  const engine3 = new FlowGammaVwapEngine();
  engine3.addPoint(100, 1000);
  engine3.addPoint(110, 1000);
  const snap3 = engine3.addPoint(120, 1000);

  const expectedMean = 110.0;
  const expectedSigma = Math.sqrt(200 / 3);
  assert.strictEqual(Math.abs(snap3.flowVwap - expectedMean) < 1e-9, true);
  assert.strictEqual(Math.abs(snap3.sigma - expectedSigma) < 1e-9, true);
});

// -------------------------------------------------------------
// Test 3: Session reset clears accumulators to zero
// -------------------------------------------------------------
runTest("Session reset clears accumulators to zero", () => {
  const engine = new FlowGammaVwapEngine();
  engine.addPoint(580, 5000);
  engine.addPoint(582, 8000);

  assert.ok(engine.getSnapshot().totalWeight > 0);
  assert.strictEqual(engine.getSnapshot().count, 2);

  // Perform session reset
  engine.reset(583.5);
  const snap = engine.getSnapshot();

  assert.strictEqual(snap.totalWeight, 0, "totalWeight must be 0 after reset");
  assert.strictEqual(snap.cumGammaWeight, 0, "cumGammaWeight must be 0 after reset");
  assert.strictEqual(snap.count, 0, "count must be 0 after reset");
  assert.strictEqual(snap.spot, 583.5, "spot should retain provided spot 583.5");
  assert.strictEqual(snap.flowVwap, 583.5, "flowVwap should default to spot after reset");
  assert.ok(!Number.isNaN(snap.sigma), "sigma must not be NaN after reset");
});

// -------------------------------------------------------------
// Test 4: Dollar-Gamma trade weighting formulation
// -------------------------------------------------------------
runTest("Dollar-Gamma Trade Weighting matches formula |Pi_i * Gamma_i * S_t^2 * 0.01|", () => {
  // Trade: size = 50 contracts, premium = $3.20, spot = $590.00, gamma = 0.04
  // Pi_i = 50 * 3.20 * 100 = $16,000 premium transacted
  // S_t^2 = 590^2 = 348,100
  // Weight = |16,000 * 0.04 * 348,100 * 0.01| = 640 * 3,481 = 2,227,840
  const result = calculateDollarGammaWeight({
    strike: 590,
    size: 50,
    premium: 3.2,
    spot: 590,
    gamma: 0.04,
    optionType: "CALL",
    aggressorSide: "BUY_ASK",
  });

  const expectedWeight = Math.abs(50 * 3.2 * 100 * 0.04 * Math.pow(590, 2) * 0.01);
  assert.strictEqual(result.weight, expectedWeight);
  assert.strictEqual(result.weight, 2227840);
  assert.strictEqual(result.signedWeight, 2227840, "Call buyer lifting ask is bullish (+)");

  const putResult = calculateDollarGammaWeight({
    strike: 590,
    size: 50,
    premium: 3.2,
    spot: 590,
    gamma: 0.04,
    optionType: "PUT",
    aggressorSide: "BUY_ASK",
  });
  assert.strictEqual(putResult.weight, 2227840);
  assert.strictEqual(putResult.signedWeight, -2227840, "Put buyer lifting ask is bearish (-)");
});

// -------------------------------------------------------------
// Test 5: Bar-by-bar series calculation
// -------------------------------------------------------------
runTest("computeBarFlowGammaVwapSeries generates valid sequential trajectory", () => {
  const candles = [
    { timestamp: 1000, open: 580, high: 581, low: 579, close: 580.5, volume: 500 },
    { timestamp: 2000, open: 580.5, high: 582, low: 580, close: 581.5, volume: 800 },
    { timestamp: 3000, open: 581.5, high: 583, low: 581, close: 582.0, volume: 1200 },
  ];

  const series = computeBarFlowGammaVwapSeries(candles);
  assert.strictEqual(series.length, 3);
  series.forEach((pt, i) => {
    assert.ok(pt.flowVwap > 0, `Point ${i} VWAP must be positive`);
    assert.ok(pt.upper2s > pt.upper1s, `Point ${i} Upper 2s > Upper 1s`);
    assert.ok(pt.upper1s > pt.flowVwap, `Point ${i} Upper 1s > VWAP`);
    assert.ok(pt.flowVwap > pt.lower1s, `Point ${i} VWAP > Lower 1s`);
    assert.ok(pt.lower1s > pt.lower2s, `Point ${i} Lower 1s > Lower 2s`);
    assert.ok(!Number.isNaN(pt.sigma), `Point ${i} Sigma must not be NaN`);
  });
});

// -------------------------------------------------------------
// Test 6: Spectral Diffusion Flow VWAP & Flux Field PDEs (Pe, chi, J_c, A(T))
// -------------------------------------------------------------
runTest("Spectral Flow VWAP & Flux Field PDEs satisfy boundary conditions and chi in (0, 1)", () => {
  // Verify chi = 1 / (1 - e^{-Pe}) - 1 / Pe sits strictly inside (0, 1)
  const chiZero = computeCeilingShareChi(0);
  assert.strictEqual(chiZero, 0.5, "At Pe = 0, ceiling share chi must equal 0.5");

  const chiPos = computeCeilingShareChi(3.0);
  const chiNeg = computeCeilingShareChi(-3.0);
  assert.ok(chiPos > 0.5 && chiPos < 1.0, `chi(3.0) = ${chiPos} must sit strictly in (0.5, 1)`);
  assert.ok(chiNeg > 0.0 && chiNeg < 0.5, `chi(-3.0) = ${chiNeg} must sit strictly in (0, 0.5)`);
  assert.ok(Math.abs(chiPos + chiNeg - 1.0) < 1e-3, "chi(Pe) + chi(-Pe) === 1 symmetry");

  // Verify Spectral Flow VWAP converges to midpoint p_F + W/2 as tau -> infinity
  const pF = 700;
  const pC = 720;
  const W = pC - pF;
  const modes = computeSpectralModes({
    openingProfile: (x) => 5000 * Math.exp(-Math.pow((x - 16) / 1.5, 2)),
    W,
    sigmaC: 100,
    muDelta: 0.2,
    gammaDiff: 2.0,
  });
  const early = evaluateSpectralFlowAndFluxAtTau({
    tauMinutes: 1,
    floorNode: pF,
    ceilingNode: pC,
    A: modes.A,
    B: modes.B,
    kappa: 0.4,
    gammaDiff: 2.0,
    muDelta: 0.2,
    sigmaC: 100,
  });
  const late = evaluateSpectralFlowAndFluxAtTau({
    tauMinutes: 5000,
    floorNode: pF,
    ceilingNode: pC,
    A: modes.A,
    B: modes.B,
    kappa: 0.4,
    gammaDiff: 2.0,
    muDelta: 0.2,
    sigmaC: 100,
  });

  assert.ok(early.spectralFlowVwap > 710, "Early spectral Flow VWAP reflects upper opening flow (> 710)");
  assert.ok(
    Math.abs(late.spectralFlowVwap - 710) < 0.05,
    `As t -> infinity, spectral Flow VWAP (${late.spectralFlowVwap}) reverts to midpoint P/2 (710)`
  );
  assert.ok(late.fluxAlpha > early.fluxAlpha, "Flux Alpha A(T) grows monotonically as T increases");
});

console.log(`\n=======================================================`);
console.log(`Test Results: ${testsPassed} / ${testsRun} Passed`);
console.log(`=======================================================\n`);
