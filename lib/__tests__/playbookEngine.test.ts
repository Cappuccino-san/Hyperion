/**
 * Unit Test Suite for Hyperion Dynamic 0DTE Playbook Engine
 *
 * Verifies:
 * 1. For all CALL trade setups: stopLoss < entryTrigger < target1 < target2 strictly.
 * 2. For all PUT trade setups: stopLoss > entryTrigger > target1 > target2 strictly.
 * 3. Target 2 strictly matches Expected Move boundaries (D↑ / D↓ edge) within ±0.01.
 * 4. Boundary derivation holds across both large-cap index and high-volatility single stocks.
 * 5. Real-time execution status evaluator transitions cleanly (PENDING, TRIGGERED, T1 HIT, T2 HIT, STOPPED).
 */

import assert from "node:assert";
import {
  generateDailyPlaybook,
  generateCallPick,
  generatePutPick,
  buildLiveTelemetryForTicker,
  calculateExpectedMove,
  evaluateExecutionStatus,
  computeTargetProgress,
  PLAYBOOK_TICKER_UNIVERSE,
} from "../playbookEngine";

console.log("\n=======================================================");
console.log("Running Hyperion 0DTE Playbook Engine Verification Suite");
console.log("=======================================================\n");

let testsRun = 0;
let testsPassed = 0;

function runTest(name: string, fn: () => void) {
  testsRun++;
  try {
    fn();
    testsPassed++;
    console.log(`[PASS] ${name}`);
  } catch (error: any) {
    console.error(`[FAIL] ${name}`);
    console.error(error.message || error);
    process.exitCode = 1;
  }
}

runTest("generateDailyPlaybook produces exactly Top 3 Calls and Top 3 Puts", () => {
  const playbook = generateDailyPlaybook();
  assert.ok(playbook.topCalls, "topCalls must be defined");
  assert.ok(playbook.topPuts, "topPuts must be defined");
  assert.strictEqual(playbook.topCalls.length, 3, "Must have exactly 3 top calls");
  assert.strictEqual(playbook.topPuts.length, 3, "Must have exactly 3 top puts");
  assert.strictEqual(playbook.picks.length, 6, "Must contain 6 total picks");
});

runTest("Call Pick Invariant: stopLoss < entryTrigger < target1 < target2 strictly", () => {
  const playbook = generateDailyPlaybook();
  for (const call of playbook.topCalls!) {
    assert.strictEqual(call.type, "CALL");

    // Invariant: stopLoss < entryTrigger < target1 < target2
    assert.ok(
      call.stopLossPrice < call.entryTriggerPrice,
      `Call ${call.ticker} stopLoss (${call.stopLossPrice}) must be < entryTrigger (${call.entryTriggerPrice})`
    );
    assert.ok(
      call.entryTriggerPrice < call.target1,
      `Call ${call.ticker} entryTrigger (${call.entryTriggerPrice}) must be < target1 (${call.target1})`
    );
    assert.ok(
      call.target1 < call.target2,
      `Call ${call.ticker} target1 (${call.target1}) must be < target2 (${call.target2})`
    );

    // Verify string triggers match parsed numeric triggers
    const parsedEntry = parseFloat(call.entryTrigger.replace(/[^0-9.]/g, ""));
    const parsedStop = parseFloat(call.stopLoss.replace(/[^0-9.]/g, ""));
    assert.strictEqual(parsedEntry, call.entryTriggerPrice);
    assert.strictEqual(parsedStop, call.stopLossPrice);
  }
});

runTest("Put Pick Invariant: stopLoss > entryTrigger > target1 > target2 strictly", () => {
  const playbook = generateDailyPlaybook();
  for (const put of playbook.topPuts!) {
    assert.strictEqual(put.type, "PUT");

    // Invariant: stopLoss > entryTrigger > target1 > target2
    assert.ok(
      put.stopLossPrice > put.entryTriggerPrice,
      `Put ${put.ticker} stopLoss (${put.stopLossPrice}) must be > entryTrigger (${put.entryTriggerPrice})`
    );
    assert.ok(
      put.entryTriggerPrice > put.target1,
      `Put ${put.ticker} entryTrigger (${put.entryTriggerPrice}) must be > target1 (${put.target1})`
    );
    assert.ok(
      put.target1 > put.target2,
      `Put ${put.ticker} target1 (${put.target1}) must be > target2 (${put.target2})`
    );

    // Verify string triggers match parsed numeric triggers
    const parsedEntry = parseFloat(put.entryTrigger.replace(/[^0-9.]/g, ""));
    const parsedStop = parseFloat(put.stopLoss.replace(/[^0-9.]/g, ""));
    assert.strictEqual(parsedEntry, put.entryTriggerPrice);
    assert.strictEqual(parsedStop, put.stopLossPrice);
  }
});

runTest("Target 2 strictly matches daily Expected Move boundaries within ±0.01", () => {
  const playbook = generateDailyPlaybook();

  // For Calls: target2 matches expectedMove.high (Edge_high = Spot + EM)
  for (const call of playbook.topCalls!) {
    const expectedEdgeHigh = Number((call.priorClose > 0 ? call.expectedMove.high : 0).toFixed(2));
    const diff = Math.abs(call.target2 - call.expectedMove.high);
    assert.ok(
      diff <= 0.01,
      `Call ${call.ticker} Target 2 (${call.target2}) must match Edge_high (${call.expectedMove.high}) within 0.01. Diff: ${diff}`
    );
  }

  // For Puts: target2 matches expectedMove.low (Edge_low = Spot - EM)
  for (const put of playbook.topPuts!) {
    const diff = Math.abs(put.target2 - put.expectedMove.low);
    assert.ok(
      diff <= 0.01,
      `Put ${put.ticker} Target 2 (${put.target2}) must match Edge_low (${put.expectedMove.low}) within 0.01. Diff: ${diff}`
    );
  }
});

runTest("Mathematical boundary derivation holds across entire 8-ticker universe", () => {
  for (const ticker of PLAYBOOK_TICKER_UNIVERSE) {
    const telemetry = buildLiveTelemetryForTicker(ticker);
    const call = generateCallPick(telemetry);
    const put = generatePutPick(telemetry);

    // Verify Call inequalities
    assert.ok(
      call.stopLossPrice < call.entryTriggerPrice &&
        call.entryTriggerPrice < call.target1 &&
        call.target1 < call.target2,
      `Ticker ${ticker} CALL setup violated strict ascending boundary ordering: [${call.stopLossPrice}, ${call.entryTriggerPrice}, ${call.target1}, ${call.target2}]`
    );

    // Verify Put inequalities
    assert.ok(
      put.stopLossPrice > put.entryTriggerPrice &&
        put.entryTriggerPrice > put.target1 &&
        put.target1 > put.target2,
      `Ticker ${ticker} PUT setup violated strict descending boundary ordering: [${put.stopLossPrice}, ${put.entryTriggerPrice}, ${put.target1}, ${put.target2}]`
    );

    // Verify Target 2 Expected Move alignment
    assert.ok(
      Math.abs(call.target2 - (telemetry.spotPrice + telemetry.expectedMoveDaily)) <= 0.01,
      `Ticker ${ticker} Call T2 must equal spot + EM`
    );
    assert.ok(
      Math.abs(put.target2 - (telemetry.spotPrice - telemetry.expectedMoveDaily)) <= 0.01,
      `Ticker ${ticker} Put T2 must equal spot - EM`
    );
  }
});

runTest("ATM Straddle formula: EM_daily = 0.85 * (Call_ATM + Put_ATM)", () => {
  // Test straddle calculation: Call $1.20, Put $0.80 -> EM = 0.85 * 2.00 = 1.70
  const em = calculateExpectedMove(100, 0.2, 1.2, 0.8);
  assert.strictEqual(em, 1.7);

  // Fallback to IV formula when straddle not present: 100 * 0.20 / sqrt(252) ≈ 1.26
  const fallbackEm = calculateExpectedMove(100, 0.2);
  assert.ok(fallbackEm > 0, "Fallback EM must be positive");
  assert.ok(Math.abs(fallbackEm - 100 * (0.2 / Math.sqrt(252))) <= 0.02);
});

runTest("Real-time execution status evaluator transitions correctly", () => {
  // Setup sample Call: Spot 100, Entry 100.50, Stop 99.60, T1 102.50, T2 105.00
  const sampleCall = generateCallPick({
    ticker: "TEST",
    spotPrice: 100.0,
    previousClose: 99.5,
    expectedMoveDaily: 5.0,
    netGex: 1.5,
    netVex: 120,
    gexKing: 102,
    vexKing: 100,
    kingStrength: 65,
    strikeStep: 1,
  });

  // 1. Below trigger -> PENDING
  assert.strictEqual(evaluateExecutionStatus(sampleCall, 100.2), "PENDING");

  // 2. Above trigger but below T1 -> TRIGGERED
  assert.strictEqual(evaluateExecutionStatus(sampleCall, 101.5), "TRIGGERED");

  // 3. At or above T1 -> T1 HIT
  assert.strictEqual(evaluateExecutionStatus(sampleCall, sampleCall.target1), "T1 HIT");

  // 4. At or above T2 -> T2 HIT
  assert.strictEqual(evaluateExecutionStatus(sampleCall, sampleCall.target2 + 0.1), "T2 HIT");

  // 5. At or below stopLoss -> STOPPED
  assert.strictEqual(evaluateExecutionStatus(sampleCall, sampleCall.stopLossPrice - 0.05), "STOPPED");

  // Setup sample Put: Spot 100, Entry 99.50, Stop 100.40, T1 97.50, T2 95.00
  const samplePut = generatePutPick({
    ticker: "TEST",
    spotPrice: 100.0,
    previousClose: 100.5,
    expectedMoveDaily: 5.0,
    netGex: -1.5,
    netVex: -120,
    gexKing: 98,
    vexKing: 100,
    kingStrength: 65,
    strikeStep: 1,
  });

  // 1. Above trigger -> PENDING
  assert.strictEqual(evaluateExecutionStatus(samplePut, 99.8), "PENDING");

  // 2. Below trigger but above T1 -> TRIGGERED
  assert.strictEqual(evaluateExecutionStatus(samplePut, 98.5), "TRIGGERED");

  // 3. At or below T1 -> T1 HIT
  assert.strictEqual(evaluateExecutionStatus(samplePut, samplePut.target1), "T1 HIT");

  // 4. At or below T2 -> T2 HIT
  assert.strictEqual(evaluateExecutionStatus(samplePut, samplePut.target2 - 0.1), "T2 HIT");

  // 5. At or above stopLoss -> STOPPED
  assert.strictEqual(evaluateExecutionStatus(samplePut, samplePut.stopLossPrice + 0.05), "STOPPED");
});

runTest("computeTargetProgress calculates accurate 0-100% distance", () => {
  const sampleCall = generateCallPick({
    ticker: "TEST",
    spotPrice: 100.0,
    previousClose: 99.5,
    expectedMoveDaily: 5.0,
    netGex: 1.5,
    netVex: 120,
    gexKing: 102,
    vexKing: 100,
    kingStrength: 65,
    strikeStep: 1,
  });

  // Before entry -> 0%
  assert.strictEqual(computeTargetProgress(sampleCall, 100.0), 0);

  // At target 2 -> 100%
  assert.strictEqual(computeTargetProgress(sampleCall, sampleCall.target2), 100);

  // Halfway between entry and T2 -> ~50%
  const midpoint = sampleCall.entryTriggerPrice + (sampleCall.target2 - sampleCall.entryTriggerPrice) / 2;
  const progress = computeTargetProgress(sampleCall, midpoint);
  assert.ok(Math.abs(progress - 50) <= 0.1, `Midpoint progress should be 50%, got ${progress}`);
});

console.log("\n=======================================================");
console.log(`Playbook Engine Test Results: ${testsPassed} / ${testsRun} Passed`);
console.log("=======================================================\n");

if (testsPassed !== testsRun) {
  process.exit(1);
}
