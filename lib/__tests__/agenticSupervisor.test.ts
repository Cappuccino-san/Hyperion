import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AttributionBar,
  cloneDefaultAlphaPriors,
  evaluateSessionPlaybook,
  runPostMarketAttribution,
  shouldRefreshSupervisorCheckpoint,
} from "../agenticSupervisor";
import { computeBarFlowGammaVwapSeries, type FlowGammaVwapSnapshot } from "../flowGammaVwap";
import {
  createEmptySessionLedger,
  resetPersistenceMemCachesForTests,
} from "../persistenceStore";
import type { DailyTradeStore } from "../tradeSignalEngine";

function makeFlowSnap(overrides: Partial<FlowGammaVwapSnapshot> = {}): FlowGammaVwapSnapshot {
  return {
    timestamp: 1794580500,
    spot: 751,
    flowVwap: 754,
    upper1s: 756,
    lower1s: 752,
    upper2s: 758,
    lower2s: 750,
    upper1Sigma: 756,
    lower1Sigma: 752,
    upper2Sigma: 758,
    lower2Sigma: 750,
    sigma: 2.0,
    variance: 4.0,
    cumGammaWeight: 100,
    totalWeight: 100,
    signedGammaAcceleration: 0,
    count: 10,
    ceilingShareChi: 0.5,
    netFluxJ: 0,
    pecletNumber: 0.6,
    gammaRegime: "POSITIVE_GAMMA",
    bandSignal: null,
    impulseChi: 0.5,
    impulsePeclet: 0.6,
    deltaChi6Bar: 0,
    deltaImpulseChi6Bar: 0,
    deltaNetFlux6Bar: 0,
    ...overrides,
  };
}

const tempCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "hyperion-supervisor-test-"));
const prevCacheEnv = process.env.HYPERION_CACHE_DIR;
process.env.HYPERION_CACHE_DIR = tempCacheDir;

beforeEach(() => {
  resetPersistenceMemCachesForTests();
});

after(() => {
  resetPersistenceMemCachesForTests();
  if (prevCacheEnv === undefined) delete process.env.HYPERION_CACHE_DIR;
  else process.env.HYPERION_CACHE_DIR = prevCacheEnv;
  try {
    fs.rmSync(tempCacheDir, { recursive: true, force: true });
  } catch {}
});

test("supervisor tightens thresholds on trailing 5d drawdown >= $150 and vetoes conflicting King levels in chop", () => {
  const losingSessions: DailyTradeStore[] = ["2026-11-10", "2026-11-11", "2026-11-12"].map(
    (date) => {
      const ledger = createEmptySessionLedger(date);
      ledger.closedPositions.push({
        id: `${date}-loss`,
        ticker: "SPY",
        contractType: "PUT",
        contractLabel: "SPY 750P",
        strike: 750,
        expiration: date,
        setupName: "Test Setup",
        status: "CLOSED",
        btoSpotPrice: 752,
        btoOptionMid: 0.8,
        optionAsk: 0.8,
        contractsQty: 1,
        remainingQty: 0,
        totalOutlay: 80,
        target1Spot: 749,
        target2Spot: 747,
        stopLossSpot: 753.5,
        openedAt: "9:40 AM",
        openedTs: 1794580800,
        closedAt: "10:00 AM",
        closedTs: 1794582000,
        closedSpotPrice: 753.6,
        closedOptionMid: 0.25, // -$55 per trade => 3 * -$55 = -$165 DD (>= $150)
        exitReason: "STOP LOSS HIT",
        pnlSpotPct: -0.21,
        pnlOptionPct: -68.8,
        rrRatio: 2.0,
      });
      return ledger;
    }
  );

  // 10:30 AM ET = 10*60+30 = 630 mins
  const ts1030Ms = Date.parse("2026-11-13T15:30:00Z"); // 10:30 AM EST
  const policyWithDrawdown = evaluateSessionPlaybook({
    sessionDate: "2026-11-13",
    ticker: "SPY",
    nowMs: ts1030Ms,
    spotPrice: 751,
    prevSpotPrice: 752,
    callWall: 760,
    putWall: 742,
    zeroGamma: 754,
    zeroDteKing: 755,
    allExpKing: 755,
    netGex: -18,
    flowSnapshot: makeFlowSnap({
      timestamp: Math.floor(ts1030Ms / 1000),
      spot: 751,
      flowVwap: 754,
      upper1s: 756,
      lower1s: 752,
      upper2s: 758,
      lower2s: 750,
      upper1Sigma: 756,
      lower1Sigma: 752,
      upper2Sigma: 758,
      lower2Sigma: 750,
      ceilingShareChi: 0.22,
      netFluxJ: -3.5,
      pecletNumber: -2.4,
      gammaRegime: "NEGATIVE_GAMMA",
      bandSignal: null,
      impulseChi: 0.22,
      impulsePeclet: -2.4,
      deltaChi6Bar: -0.1,
      deltaImpulseChi6Bar: -0.12,
      deltaNetFlux6Bar: -5.0,
    }),
    historicalSessions: losingSessions,
  });

  assert.equal(policyWithDrawdown.checkpoint, "MID_MORNING_1030");
  assert.ok(policyWithDrawdown.trailing5dDrawdownDollars >= 150);
  assert.equal(policyWithDrawdown.minExpectancyR, 0.5);
  assert.equal(policyWithDrawdown.minWinRatePct, 62.0);
  assert.equal(policyWithDrawdown.standAsideVetoReason, null);

  // 0DTE vs All-Exp King divergence >= 0.8% with weak advection (|Pe| < 1.2) -> stand-aside veto
  const kingConflictPolicy = evaluateSessionPlaybook({
    sessionDate: "2026-11-13",
    ticker: "SPY",
    nowMs: ts1030Ms,
    spotPrice: 750,
    prevSpotPrice: 750,
    callWall: 758,
    putWall: 742,
    zeroGamma: 746,
    zeroDteKing: 750,
    allExpKing: 760, // 1.33% divergence
    netGex: 20,
    flowSnapshot: makeFlowSnap({
      timestamp: Math.floor(ts1030Ms / 1000),
      spot: 750,
      flowVwap: 750,
      upper1s: 752,
      lower1s: 748,
      upper2s: 754,
      lower2s: 746,
      upper1Sigma: 752,
      lower1Sigma: 748,
      upper2Sigma: 754,
      lower2Sigma: 746,
      ceilingShareChi: 0.5,
      netFluxJ: 0.1,
      pecletNumber: 0.6,
      gammaRegime: "POSITIVE_GAMMA",
      bandSignal: "LOWER_2S_BOUNCE",
      impulseChi: 0.5,
      impulsePeclet: 0.6,
      deltaChi6Bar: 0,
      deltaImpulseChi6Bar: 0,
      deltaNetFlux6Bar: 0,
    }),
  });
  assert.ok(kingConflictPolicy.standAsideVetoReason?.includes("King conflict"));
  assert.equal(kingConflictPolicy.preferredDte, "NONE");

  // Checkpoint transition + stand-aside wakeup when |Pe| >= 1.2
  assert.equal(shouldRefreshSupervisorCheckpoint(kingConflictPolicy, 635, false, 0.5), false);
  assert.equal(shouldRefreshSupervisorCheckpoint(kingConflictPolicy, 635, false, 1.5), true);
  assert.equal(shouldRefreshSupervisorCheckpoint(policyWithDrawdown, 780, false, 0.5), true); // 13:00 ET
  assert.equal(shouldRefreshSupervisorCheckpoint(policyWithDrawdown, 635, true, 0.5), true); // Zero-Gamma flip
});

test("runPostMarketAttribution runs counterfactual simulation and updates priors within [0.6, 1.6] bounds", async () => {
  const baseTs = Math.floor(Date.parse("2026-11-13T14:30:00Z") / 1000);
  const bars: AttributionBar[] = [];
  for (let i = 0; i < 20; i++) {
    const close = Number((758 - i * 0.45).toFixed(2));
    bars.push({
      ts: baseTs + i * 300,
      open: close + 0.25,
      high: close + 0.4,
      low: close - 0.5,
      close,
    });
  }
  const flowSeries = computeBarFlowGammaVwapSeries(
    bars.map((b) => ({ timestamp: b.ts, open: b.open, high: b.high, low: b.low, close: b.close }))
  );

  const priorsStart = cloneDefaultAlphaPriors();
  const report = await runPostMarketAttribution({
    sessionDate: "2026-11-13",
    ticker: "SPY",
    bars,
    flowSeries,
    callWall: 762,
    putWall: 745,
    zeroGamma: 757,
    executedTrades: [
      {
        id: "exec-1",
        ticker: "SPY",
        contractType: "PUT",
        contractLabel: "SPY 755P",
        strike: 755,
        expiration: "2026-11-13",
        setupName: "Bearish Zero-Gamma Flush",
        status: "CLOSED",
        btoSpotPrice: 756.5,
        btoOptionMid: 0.7,
        optionAsk: 0.7,
        contractsQty: 1,
        remainingQty: 0,
        totalOutlay: 70,
        target1Spot: 752,
        target2Spot: 749,
        stopLossSpot: 758.5,
        openedAt: "9:40 AM",
        openedTs: bars[2].ts,
        closedAt: "10:25 AM",
        closedTs: bars[11].ts,
        closedSpotPrice: 751.8,
        closedOptionMid: 2.4,
        exitReason: "TARGET 1 PROFIT SECURED",
        pnlSpotPct: -0.62,
        pnlOptionPct: 242.9,
        rrRatio: 2.25,
      },
    ],
    candidateSetups: [
      {
        timestamp: bars[4].ts,
        direction: "CALL",
        setupName: "Skipped Counter-Flux Bounce",
        regime: "LOW_EDGE_CHOP",
        entrySpot: bars[4].close,
        target1Spot: bars[4].close + 2.0,
        stopLossSpot: bars[4].close - 1.0,
        wasExecuted: false,
        skipReason: "Weak advection",
      },
    ],
    persist: true,
    priorsOverride: priorsStart,
  });

  assert.equal(report.executedCount, 1);
  assert.equal(report.skippedCount, 1);
  assert.ok(report.executedAvgR > 1.0);
  assert.equal(report.savedChopCount, 1);

  const persistedPriors = JSON.parse(
    fs.readFileSync(path.join(tempCacheDir, "alpha-priors.json"), "utf-8")
  );
  assert.equal(persistedPriors.lastAttributionDate, "2026-11-13");
  for (const val of Object.values(persistedPriors.featureWeights) as number[]) {
    assert.ok(val >= 0.6 && val <= 1.6);
  }
});
