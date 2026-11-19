import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import { evaluateLeg2StructuralGate } from "../alphaScorer";
import {
  computeExpirationExpectedMove,
  computeIntradayExpiryYears,
  computeOptionsAnalytics,
  resolveEffectiveOpenInterest,
  type NormalizedOptionContract,
} from "../optionsExposure";
import { cloneDefaultAlphaPriors, readAlphaPriorsSync } from "../persistenceStore";
import { computeNeutralEmpiricalBayesCalibration } from "../execution/signalScoring";
import {
  evaluateOptionProfitRatchet,
  resolveRatchetFloorForPeak,
} from "../execution/profitRatchet";
import { computeTradeRealizedPnl } from "../execution/pnlAccounting";
import {
  getNyseCalendarForYear,
  getSessionBoundsEt,
  isNyseHoliday,
} from "../gaiaSessionGuards";
import { isMarketOpen, type NbboQuote } from "../marketDataService";
import {
  dispatchBrokerOrder,
  evaluatePreTradeRiskGate,
  reconcileLedgerVsBrokerPositions,
  resetOrderIdempotencyCacheForTests,
  resolveExecutionMode,
  type BrokerOrderRequest,
} from "../brokerExecution";
import { runPostMarketAttribution, type AttributionBar } from "../agenticSupervisor";
import { computeLocalMtfDivergence } from "../divergenceDetector";

function makeTestNbboQuote(overrides?: Partial<NbboQuote>): NbboQuote {
  const bid = overrides?.bid ?? 0.64;
  const ask = overrides?.ask ?? 0.66;
  const spread = Number((ask - bid).toFixed(4));
  const spreadPct = ask > 0 ? Number((spread / ask).toFixed(4)) : 0;
  return {
    symbol: "SPY261118C00752000",
    ticker: "SPY",
    strike: 752,
    expiration: "2026-11-18",
    optionType: "CALL",
    bid,
    ask,
    bidSize: 120,
    askSize: 140,
    lastPrice: Number(((bid + ask) / 2).toFixed(2)),
    midPrice: Number(((bid + ask) / 2).toFixed(2)),
    spread,
    spreadPct,
    impliedVol: 0.18,
    delta: 0.42,
    gamma: 0.06,
    theta: -0.18,
    timestamp: Math.floor(Date.parse("2026-11-18T16:00:00Z") / 1000) - 5,
    exchange: "CBOE",
    source: "TRADIER_OPRA",
    ...overrides,
  };
}

// ============================================================================
// 1. GAIA / HEATMAP SURFACE PARITY & PERFORMANCE
// ============================================================================

test("Gaia/Heatmap parity: computeExpirationExpectedMove picks exact ATM strike regardless of order", () => {
  const spot = 750.2;
  const exp = "2026-11-20";
  // Intentionally place far-from-ATM strikes FIRST (within old buggy 1.5% tolerance) and true ATM last
  const contracts: NormalizedOptionContract[] = [
    { symbol: "SPY_740C", expiration: exp, optionType: "C", strike: 740, openInterest: 5000, volume: 1000, iv: 0.22, delta: 0.85, gamma: 0.02, vega: 0.1, percentChange: 0, bid: 12.0, ask: 12.4 },
    { symbol: "SPY_740P", expiration: exp, optionType: "P", strike: 740, openInterest: 5000, volume: 1000, iv: 0.22, delta: -0.15, gamma: 0.02, vega: 0.1, percentChange: 0, bid: 1.5, ask: 1.7 },
    { symbol: "SPY_750C", expiration: exp, optionType: "C", strike: 750, openInterest: 8000, volume: 2000, iv: 0.18, delta: 0.51, gamma: 0.05, vega: 0.15, percentChange: 0, bid: 4.9, ask: 5.1 },
    { symbol: "SPY_750P", expiration: exp, optionType: "P", strike: 750, openInterest: 8000, volume: 2000, iv: 0.18, delta: -0.49, gamma: 0.05, vega: 0.15, percentChange: 0, bid: 4.7, ask: 4.9 },
  ];

  const em = computeExpirationExpectedMove(exp, spot, 0.18, 2, contracts);
  assert.ok(em, "Expected move must be computed");
  // ATM 750 straddle = 5.0 + 4.8 = 9.8 -> 0.85 * 9.8 = 8.33
  assert.equal(em.em, 8.33);
  assert.equal(em.low, Number((spot - 8.33).toFixed(2)));
  assert.equal(em.high, Number((spot + 8.33).toFixed(2)));
});

test("Gaia/Heatmap parity: computeIntradayExpiryYears decays intraday & honors early close", () => {
  const tOpen = computeIntradayExpiryYears(0, "2026-11-18", 575); // 09:35 ET (385m left)
  const tMidday = computeIntradayExpiryYears(0, "2026-11-18", 780); // 13:00 ET (180m left)
  const tClose = computeIntradayExpiryYears(0, "2026-11-18", 956); // 15:56 ET (clamped to 5m floor)

  assert.ok(tOpen > tMidday, "0DTE T must decay intraday between 09:35 and 13:00 ET");
  assert.ok(tMidday > tClose, "0DTE T must decay further into 15:56 ET");
  assert.ok(
    Math.abs(tClose - 5 / (252 * 390)) < 1e-12,
    "0DTE T must hit exact 5-minute singularity floor near close"
  );

  // Early close (Black Friday 2026-11-27 closes at 13:00 ET = 780 mins)
  const tEarlyCloseAt1255 = computeIntradayExpiryYears(0, "2026-11-27", 775);
  assert.ok(
    Math.abs(tEarlyCloseAt1255 - 5 / (252 * 390)) < 1e-12,
    "Black Friday 12:55 ET must have 5 minutes remaining to 13:00 ET early close"
  );
});

test("Gaia/Heatmap parity: resolveEffectiveOpenInterest weights OI=0 volume at 0.35x", () => {
  assert.equal(resolveEffectiveOpenInterest(1200, 5000), 1200);
  assert.equal(resolveEffectiveOpenInterest(0, 1000), 350);
  assert.equal(resolveEffectiveOpenInterest(0, 0), 0);
});

test("SPXW surface latency & aggregate parity: computeOptionsAnalytics handles 10 expirations fast & exact", () => {
  const spot = 6750;
  const exps = [
    "2026-11-19",
    "2026-11-20",
    "2026-11-23",
    "2026-11-24",
    "2026-11-25",
    "2026-11-27",
    "2026-11-30",
    "2026-12-04",
    "2026-12-11",
    "2026-12-18",
  ];
  const contracts: NormalizedOptionContract[] = [];
  for (const exp of exps) {
    for (let k = spot - 250; k <= spot + 250; k += 5) {
      contracts.push({
        symbol: `SPXW_${exp}_${k}C`,
        expiration: exp,
        optionType: "C",
        strike: k,
        openInterest: k >= spot ? 4000 : 1200,
        volume: 500,
        iv: 0.16,
        delta: 0.5,
        gamma: 0.01,
        vega: 0.2,
        percentChange: 0,
        bid: 10,
        ask: 10.4,
      });
      contracts.push({
        symbol: `SPXW_${exp}_${k}P`,
        expiration: exp,
        optionType: "P",
        strike: k,
        openInterest: k <= spot ? 4200 : 1100,
        volume: 500,
        iv: 0.165,
        delta: -0.5,
        gamma: 0.01,
        vega: 0.2,
        percentChange: 0,
        bid: 9.8,
        ask: 10.2,
      });
    }
  }

  const t0 = performance.now();
  const payload = computeOptionsAnalytics({
    ticker: "SPXW",
    dataSource: "CBOE_MARKET_DATA",
    spotPrice: spot,
    previousClose: 6740,
    impliedVolatility: 0.16,
    contracts,
  });
  const elapsedMs = performance.now() - t0;

  assert.ok(elapsedMs < 1500, `Expected <1500ms SPXW computation, got ${elapsedMs.toFixed(1)}ms`);
  assert.ok(payload.gammaLevelsByFilter?.ALL, "ALL filter gammaLevels must be present");
  assert.ok(payload.gammaLevelsByFilter?.["0DTE"], "0DTE filter gammaLevels must be present");
  assert.ok(payload.gammaLevelsByFilter?.THIS_WEEK, "THIS_WEEK filter gammaLevels must be present");
  assert.ok(payload.gammaLevelsByFilter?.OPEX, "OPEX filter gammaLevels must be present");
  assert.ok(payload.gammaLevels.callWall >= spot, "Call wall must sit at/above spot");
  assert.ok(payload.gammaLevels.putWall <= spot, "Put wall must sit at/below spot");
  assert.ok(payload.kingByFilter.ALL.strike > 0, "All-Exp King node must be populated");
  assert.ok(payload.kingByFilter["0DTE"].strike > 0, "0DTE King node must be populated");
});

// ============================================================================
// 2. NEUTRAL EMPIRICAL BAYES & REAL SETUP STATS / MTF DIVERGENCE IC
// ============================================================================

test("Neutral Empirical Bayes: default priors have zero fabricated wins & neutral W0=0.50, E0=0.0, m=5", () => {
  const defaults = cloneDefaultAlphaPriors();
  assert.equal(defaults.priorStrengthM, 5);
  assert.equal(defaults.baselineWinRate, 0.5);
  assert.equal(defaults.baselineExpectancyR, 0.0);
  for (const [regime, stat] of Object.entries(defaults.regimeStats)) {
    assert.equal(stat.wins, 0, `${regime} must not ship with fabricated wins`);
    assert.equal(stat.losses, 0, `${regime} must not ship with fabricated losses`);
    assert.equal(stat.sumR, 0, `${regime} must not ship with fabricated sumR`);
  }
});

test("Neutral Empirical Bayes: Refinement #1 gate passes valid positive expectancy without score>=62 bug", () => {
  // Cold start (N < 5) must admit on physics alone
  const cold = computeNeutralEmpiricalBayesCalibration({ wins: 0, losses: 0, totalR: 0 });
  assert.equal(cold.isColdStart, true);
  assert.equal(cold.passesGate, true);
  assert.equal(cold.winRate, 50);
  assert.equal(cold.expectancyR, 0);

  // Moderate positive edge: 6W / 4L (+2.6R total across N=10, m=5) ->
  // shrunkWR = (2.5 + 6) / 15 = 0.5667 (>= 0.52), shrunkExp = 2.6 / 15 = +0.173R (>= 0.15)
  // Under old buggy formula (WR*55 + (E+1)*22.5), this scored only 57.6 (< 62) and was falsely rejected!
  const positive = computeNeutralEmpiricalBayesCalibration({ wins: 6, losses: 4, totalR: 2.6 });
  assert.equal(positive.isColdStart, false);
  assert.ok(positive.winRate >= 52);
  assert.ok(positive.expectancyR >= 0.15);
  assert.equal(
    positive.passesGate,
    true,
    "Refinement #1: positive expectancy (WR>=52%, E>=+0.15R) must pass regardless of display conviction score"
  );

  // Negative expectancy once N >= 5 MUST be rejected
  const negative = computeNeutralEmpiricalBayesCalibration({ wins: 2, losses: 5, totalR: -2.2 });
  assert.equal(negative.isColdStart, false);
  assert.equal(negative.passesGate, false, "Negative expectancy with N>=5 must be blocked");
});

test("Agentic Supervisor attribution updates setupStats & computes local MTF divergence without network", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hyperion-quant-audit-"));
  const prevCacheDir = process.env.HYPERION_CACHE_DIR;
  process.env.HYPERION_CACHE_DIR = tmpDir;

  try {
    // Build 40 causal 5m bars with a clear lower low + RSI divergence rebound
    const baseTs = Math.floor(Date.parse("2026-11-18T14:30:00Z") / 1000);
    const bars: AttributionBar[] = [];
    let price = 750;
    for (let i = 0; i < 40; i++) {
      const wave = Math.sin(i / 4) * 1.4 + (i > 20 ? (i - 20) * 0.18 : -i * 0.08);
      const open = Number((price + wave * 0.1).toFixed(2));
      const close = Number((750 + wave).toFixed(2));
      const high = Number((Math.max(open, close) + 0.35).toFixed(2));
      const low = Number((Math.min(open, close) - 0.35).toFixed(2));
      price = close;
      bars.push({
        ts: baseTs + i * 300,
        open,
        high,
        low,
        close,
      });
    }

    const mtf = computeLocalMtfDivergence(
      bars.map((b) => ({
        ts: b.ts,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
      }))
    );
    assert.ok(
      mtf.divergence5m && mtf.divergence30m,
      "Local MTF divergence must return both 5m and 30m states"
    );

    const report = await runPostMarketAttribution({
      ticker: "SPY",
      sessionDate: "2026-11-18",
      bars,
      force: true,
      persist: true,
      executedTrades: [
        {
          id: "SPY-CALL-TEST-1",
          ticker: "SPY",
          contractType: "CALL",
          contractLabel: "SPY 752C",
          strike: 752,
          expiration: "2026-11-18",
          setupName: "Boundary Flux Advection",
          openedAt: "10:15 AM",
          openedTs: baseTs + 9 * 300,
          btoSpotPrice: 750.2,
          btoOptionMid: 0.6,
          optionAsk: 0.6,
          closedAt: "11:05 AM",
          closedTs: baseTs + 19 * 300,
          closedSpotPrice: 752.4,
          closedOptionMid: 1.14,
          contractsQty: 1,
          remainingQty: 0,
          totalOutlay: 60,
          target1Spot: 752.2,
          target2Spot: 753.8,
          stopLossSpot: 749.0,
          status: "CLOSED",
        } as any,
      ],
    });

    assert.equal(report.executedCount, 1);
    // $0.60 -> $1.14 = +90% -> 1R = 45% -> exactly +2.00R
    assert.equal(report.executedAvgR, 2.0);
    const persistedPriors = readAlphaPriorsSync();
    const setupStat = persistedPriors.setupStats["Boundary Flux Advection"];
    assert.ok(setupStat, "priors.setupStats must record executed setup stats");
    assert.equal(setupStat.wins, 1);
    assert.equal(setupStat.sumR, 2.0);
  } finally {
    if (prevCacheDir === undefined) delete process.env.HYPERION_CACHE_DIR;
    else process.env.HYPERION_CACHE_DIR = prevCacheDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// 3. STRICT PESSIMISTIC INTRABAR PROFIT RATCHET & FLUX-FLIP MFE HARVEST
// ============================================================================

test("Profit Ratchet: strict pessimistic intrabar ordering tests standing floor BEFORE raising peak", () => {
  // Entering bar t, prior peak was +35% -> standing floor is +2% BE.
  // Bar t drops to -10% adverse AND spikes to +80% favorable.
  // Pessimistic causal ordering MUST stop at +2% BE and MUST NOT raise peak to +80%.
  const evalRes = evaluateOptionProfitRatchet({
    isCall: true,
    prevPeakOptionPnlPct: 35,
    adverseOptionPnlPct: -10,
    closeOptionPnlPct: 65,
    favorableOptionPnlPct: 80,
    openOptionPnlPct: 20,
    chi: 0.72,
    netFluxJ: 1.2,
    hasPostEntryBarElapsed: true,
    fluxFlippedAgainst: false,
  });

  assert.equal(evalRes.triggered, true);
  assert.equal(evalRes.armedTier, "BREAKEVEN_30");
  assert.equal(evalRes.armedFloorPct, 2);
  assert.equal(evalRes.fillPnlPct, 2);
  assert.equal(
    evalRes.nextPeakOptionPnlPct,
    35,
    "Must NOT update peak from bar t favorable wick after stopping out on adverse wick"
  );
});

test("Profit Ratchet: progressive tiers (+30->+2%, +60->+25%, +100->max(+55%, peak-25%/35%)) & SPY +213.64% lock", () => {
  assert.deepEqual(
    resolveRatchetFloorForPeak({ peakOptionPnlPct: 29.9, isCall: true, chi: 0.7, netFluxJ: 1 }),
    { tier: "NONE", floorPct: null }
  );
  assert.deepEqual(
    resolveRatchetFloorForPeak({ peakOptionPnlPct: 30, isCall: true, chi: 0.7, netFluxJ: 1 }),
    { tier: "BREAKEVEN_30", floorPct: 2 }
  );
  assert.deepEqual(
    resolveRatchetFloorForPeak({ peakOptionPnlPct: 60, isCall: true, chi: 0.7, netFluxJ: 1 }),
    { tier: "PROFIT_LOCK_60", floorPct: 25 }
  );
  assert.deepEqual(
    resolveRatchetFloorForPeak({ peakOptionPnlPct: 100, isCall: true, chi: 0.7, netFluxJ: 1 }),
    { tier: "PROFIT_TRAIL_100", floorPct: 75 }
  );
  // Extreme runner CALL (chi >= 0.88 & netFluxJ > 0) gives wider 35% trail tolerance
  assert.deepEqual(
    resolveRatchetFloorForPeak({ peakOptionPnlPct: 100, isCall: true, chi: 0.9, netFluxJ: 1.5 }),
    { tier: "RUNNER_TRAIL_100", floorPct: 65 }
  );
  // Extreme runner PUT (chi <= 0.12 & netFluxJ < 0)
  assert.deepEqual(
    resolveRatchetFloorForPeak({ peakOptionPnlPct: 120, isCall: false, chi: 0.1, netFluxJ: -1.5 }),
    { tier: "RUNNER_TRAIL_100", floorPct: 85 }
  );

  // Historical SPY-CALL-1795026053 regression: peaked at +213.64%, then reversed sharply down to +66.7%
  const spyPullbackNormal = evaluateOptionProfitRatchet({
    isCall: true,
    prevPeakOptionPnlPct: 213.64,
    adverseOptionPnlPct: 66.7,
    closeOptionPnlPct: 66.7,
    favorableOptionPnlPct: 205,
    openOptionPnlPct: 200,
    chi: 0.74,
    netFluxJ: 0.5,
    hasPostEntryBarElapsed: true,
    fluxFlippedAgainst: false,
  });
  assert.equal(spyPullbackNormal.triggered, true);
  assert.ok(
    (spyPullbackNormal.fillPnlPct ?? 0) >= 188,
    `Normal trail must lock >= +188%, got ${spyPullbackNormal.fillPnlPct}`
  );

  const spyPullbackRunner = evaluateOptionProfitRatchet({
    isCall: true,
    prevPeakOptionPnlPct: 213.64,
    adverseOptionPnlPct: 66.7,
    closeOptionPnlPct: 66.7,
    favorableOptionPnlPct: 205,
    openOptionPnlPct: 200,
    chi: 0.91,
    netFluxJ: 1.8,
    hasPostEntryBarElapsed: true,
    fluxFlippedAgainst: false,
  });
  assert.equal(spyPullbackRunner.triggered, true);
  assert.ok(
    (spyPullbackRunner.fillPnlPct ?? 0) >= 178,
    `Runner trail must still lock >= +178%, got ${spyPullbackRunner.fillPnlPct}`
  );
});

test("Profit Ratchet: FLUX_FLIP_MFE_HARVEST fires once peak >= +50% and netFluxJ flips on confirmed 5m bar", () => {
  // Below +50% peak -> must NOT fire flux-flip harvest
  const below50 = evaluateOptionProfitRatchet({
    isCall: true,
    prevPeakOptionPnlPct: 42,
    adverseOptionPnlPct: 20,
    closeOptionPnlPct: 31,
    favorableOptionPnlPct: 45,
    chi: 0.45,
    netFluxJ: -0.4,
    hasPostEntryBarElapsed: true,
    fluxFlippedAgainst: true,
  });
  assert.equal(below50.triggered, false);

  // Peak >= +50% & confirmed 5m bar flux flip -> exits cleanly at bar close
  const harvest = evaluateOptionProfitRatchet({
    isCall: true,
    prevPeakOptionPnlPct: 54,
    adverseOptionPnlPct: 28,
    closeOptionPnlPct: 41.5,
    favorableOptionPnlPct: 56,
    chi: 0.44,
    netFluxJ: -0.6,
    hasPostEntryBarElapsed: true,
    fluxFlippedAgainst: true,
  });
  assert.equal(harvest.triggered, true);
  assert.equal(harvest.reason, "FLUX_FLIP_MFE_HARVEST");
  assert.equal(harvest.fillPnlPct, 41.5);
});

// ============================================================================
// 4. MULTI-YEAR NYSE CALENDAR & 2026-11-27 EARLY-CLOSE GUARD
// ============================================================================

test("NYSE Calendar: 2026-11-27 Black Friday closes strictly at 13:00 ET & 2027 holidays are covered", () => {
  const bf2026 = getSessionBoundsEt("2026-11-27");
  assert.equal(bf2026.isTradingDay, true);
  assert.equal(bf2026.isEarlyClose, true);
  assert.equal(bf2026.rthCloseMins, 780); // 13:00 ET
  assert.equal(bf2026.eodFlatMins, 775); // 12:55 ET
  assert.equal(bf2026.entryCutoffMins, 690); // 11:30 ET

  // Nov 27, 2026 is EST (UTC-5): 12:45 ET = 17:45 UTC, 13:05 ET = 18:05 UTC
  assert.equal(isMarketOpen(new Date("2026-11-27T17:45:00Z")).open, true);
  const afterEarlyClose = isMarketOpen(new Date("2026-11-27T18:05:00Z"));
  assert.equal(afterEarlyClose.open, false);
  assert.match(afterEarlyClose.reason ?? "", /early-close|1:00 PM ET/i);

  // 2027 multi-year algorithmic calendar checks
  const cal2027 = getNyseCalendarForYear(2027);
  assert.equal(isNyseHoliday("2027-01-01"), true, "2027 New Year's Day");
  assert.equal(isNyseHoliday("2027-03-26"), true, "2027 Good Friday (Easter is Mar 28)");
  assert.equal(isNyseHoliday("2027-07-05"), true, "2027 Independence Day observed Mon Jul 5");
  assert.equal(isNyseHoliday("2027-11-25"), true, "2027 Thanksgiving (4th Thu Nov)");
  assert.equal(isNyseHoliday("2027-12-24"), true, "2027 Christmas observed Fri Dec 24");
  assert.equal(cal2027.earlyCloses["2027-11-26"], 780, "2027 Black Friday 13:00 ET early close");
  assert.equal(isMarketOpen(new Date("2027-03-26T15:00:00Z")).open, false, "2027 Good Friday closed");
});

// ============================================================================
// 5. CANONICAL 1R = 0.45 * OUTLAY ACCOUNTING
// ============================================================================

test("Canonical P&L Accounting: 1R = 0.45 * outlay across dual-schema records", () => {
  // Exact -45% hard stop loss on $0.60 ask ($60 outlay -> 1R = $27.00) must equal -1.00R (never -1.80R)
  const fullStop = computeTradeRealizedPnl({
    btoOptionAsk: 0.6,
    btoOptionMid: 0.59,
    closedOptionBid: 0.33,
    closedOptionMid: 0.34,
    contractsQty: 1,
  });
  assert.equal(fullStop.outlay, 60);
  assert.equal(fullStop.riskDollars, 27);
  assert.equal(fullStop.realizedDollarPnl, -27);
  assert.equal(fullStop.rMultiple, -1.0);

  // +90% winner ($0.60 -> $1.14 = +$54) must equal +2.00R
  const twoR = computeTradeRealizedPnl({
    btoOptionMid: 0.6,
    closedOptionMid: 1.14,
    contractsQty: 1,
  });
  assert.equal(twoR.realizedDollarPnl, 54);
  assert.equal(twoR.rMultiple, 2.0);
});

// ============================================================================
// 6. FAIL-CLOSED PRE-TRADE RISK GATE & AUTONOMOUS BROKER SEAM
// ============================================================================

test("Broker Seam: resolveExecutionMode stays strictly PAPER_SHADOW even with broker keys set", () => {
  assert.equal(
    resolveExecutionMode({
      TRADIER_API_KEY: "live-key-123",
      TRADIER_ACCOUNT_ID: "VA123456",
    }),
    "PAPER_SHADOW"
  );
  assert.equal(
    resolveExecutionMode({
      HYPERION_EXECUTION_MODE: "LIVE",
      HYPERION_LIVE_ARM_TOKEN: "too-short",
    }),
    "PAPER_SHADOW"
  );
  assert.equal(
    resolveExecutionMode({
      HYPERION_EXECUTION_MODE: "LIVE",
      HYPERION_LIVE_ARM_TOKEN: "HYPERION-ARMED-TOKEN-2026-VERIFIED",
    }),
    "LIVE"
  );
});

test("Broker Seam: evaluatePreTradeRiskGate fails closed on halt, cutoff, stale quote, outlay & spread", () => {
  resetOrderIdempotencyCacheForTests();
  // Wednesday 2026-11-18 11:00:00 ET = 16:00:00 UTC (EST = UTC-5)
  const inWindowEt = new Date("2026-11-18T16:00:00Z");
  const validReq: BrokerOrderRequest = {
    ticker: "SPY",
    symbol: "SPY261118C00752000",
    action: "BUY_TO_OPEN",
    contractsQty: 1,
    orderType: "LIMIT",
    limitPrice: 0.68,
    clientOrderId: "HYP-TEST-UNIQUE-1",
    nowEt: inWindowEt,
    quote: makeTestNbboQuote({
      bid: 0.64,
      ask: 0.66,
      timestamp: Math.floor(inWindowEt.getTime() / 1000) - 5,
    }),
  };

  // Valid in-window PAPER_SHADOW request passes
  const ok = evaluatePreTradeRiskGate(validReq, { executionHalted: false, env: {} });
  assert.equal(ok.allowed, true);
  assert.equal(ok.executionMode, "PAPER_SHADOW");

  // Emergency kill-switch halts execution
  const halted = evaluatePreTradeRiskGate(validReq, { executionHalted: true, env: {} });
  assert.equal(halted.allowed, false);
  assert.match(halted.reason ?? "", /EXECUTION_HALTED/);

  // Post-14:30 ET BTO rejected (14:35 ET = 19:35 UTC)
  const lateEt = new Date("2026-11-18T19:35:00Z");
  const late = evaluatePreTradeRiskGate(
    {
      ...validReq,
      clientOrderId: "HYP-TEST-LATE",
      nowEt: lateEt,
      quote: makeTestNbboQuote({
        bid: 0.64,
        ask: 0.66,
        timestamp: Math.floor(lateEt.getTime() / 1000) - 2,
      }),
    },
    { executionHalted: false, env: {} }
  );
  assert.equal(late.allowed, false);
  assert.match(late.reason ?? "", /OUTSIDE_BTO_ENTRY_WINDOW/);

  // Stale quote (> 30s) rejected
  const stale = evaluatePreTradeRiskGate(
    {
      ...validReq,
      clientOrderId: "HYP-TEST-STALE",
      quote: makeTestNbboQuote({
        bid: 0.64,
        ask: 0.66,
        timestamp: Math.floor(inWindowEt.getTime() / 1000) - 45,
      }),
    },
    { executionHalted: false, env: {} }
  );
  assert.equal(stale.allowed, false);
  assert.match(stale.reason ?? "", /STALE_QUOTE_TTL_EXCEEDED/);

  // Outlay > $100 rejected
  const overBudget = evaluatePreTradeRiskGate(
    {
      ...validReq,
      clientOrderId: "HYP-TEST-BUDGET",
      quote: makeTestNbboQuote({
        bid: 1.02,
        ask: 1.05,
        timestamp: Math.floor(inWindowEt.getTime() / 1000) - 5,
      }),
    },
    { executionHalted: false, env: {} }
  );
  assert.equal(overBudget.allowed, false);
  assert.match(overBudget.reason ?? "", /BUDGET|100|EXCEED|OUTLAY/i);

  // Spread > 25% rejected
  const wideSpread = evaluatePreTradeRiskGate(
    {
      ...validReq,
      clientOrderId: "HYP-TEST-SPREAD",
      quote: makeTestNbboQuote({
        bid: 0.4,
        ask: 0.65,
        timestamp: Math.floor(inWindowEt.getTime() / 1000) - 5,
      }),
    },
    { executionHalted: false, env: {} }
  );
  assert.equal(wideSpread.allowed, false);
  assert.match(wideSpread.reason ?? "", /ILLIQUID_OR_INVALID_QUOTE|SPREAD/i);
});

test("Broker Seam: dispatchBrokerOrder enforces clientOrderId idempotency & stays PAPER_SHADOW", async () => {
  resetOrderIdempotencyCacheForTests();
  const inWindowEt = new Date("2026-11-18T16:05:00Z");
  const req: BrokerOrderRequest = {
    ticker: "SPY",
    symbol: "SPY261118C00752000",
    action: "BUY_TO_OPEN",
    contractsQty: 1,
    orderType: "LIMIT",
    limitPrice: 0.68,
    clientOrderId: "HYP-IDEMPOTENCY-KEY-42",
    nowEt: inWindowEt,
    quote: makeTestNbboQuote({
      bid: 0.64,
      ask: 0.66,
      timestamp: Math.floor(inWindowEt.getTime() / 1000) - 3,
    }),
  };

  // Even with live broker credentials in env, absent LIVE + ARM_TOKEN routes to PAPER_SHADOW
  const first = await dispatchBrokerOrder(req, {
    executionHalted: false,
    env: { TRADIER_API_KEY: "dummy-live-key", TRADIER_ACCOUNT_ID: "VA999999" },
  });
  assert.equal(first.status, "FILLED");
  assert.equal(first.executionMode, "PAPER_SHADOW");

  // Re-submitting identical clientOrderId MUST fail closed as duplicate
  const duplicate = await dispatchBrokerOrder(req, {
    executionHalted: false,
    env: { TRADIER_API_KEY: "dummy-live-key", TRADIER_ACCOUNT_ID: "VA999999" },
  });
  assert.equal(duplicate.status, "REJECTED");
  assert.match(duplicate.rejectionReason ?? "", /DUPLICATE_CLIENT_ORDER_ID/);
});

test("Broker Seam: reconcileLedgerVsBrokerPositions flags missing, phantom, and quantity mismatches", () => {
  const synced = reconcileLedgerVsBrokerPositions(
    "INSTITUTIONAL_SIMULATOR",
    [{ symbol: "SPY261118C00752000", qty: 1 }],
    [{ symbol: "SPY261118C00752000", qty: 1 }]
  );
  assert.equal(synced.inSync, true);
  assert.equal(synced.discrepancies.length, 0);

  const drifted = reconcileLedgerVsBrokerPositions(
    "TRADIER",
    [
      { symbol: "SPY261118C00752000", qty: 1 },
      { symbol: "QQQ261118P00600000", qty: 2 },
    ],
    [
      { symbol: "QQQ261118P00600000", qty: 1 },
      { symbol: "IWM261118C00250000", qty: 1 },
    ]
  );
  assert.equal(drifted.inSync, false);
  const bySym = new Map(drifted.discrepancies.map((d) => [d.symbol, d.issue]));
  assert.equal(bySym.get("SPY261118C00752000"), "MISSING_AT_BROKER");
  assert.equal(bySym.get("QQQ261118P00600000"), "QTY_MISMATCH");
  assert.equal(bySym.get("IWM261118C00250000"), "PHANTOM_AT_BROKER");
});


// ============================================================================
// 6. 2026-11-19 TREND-HOLD RATCHET, 15M OPENING SHIELD & SHAKEOUT RECOVERY
// ============================================================================

test("2026-11-19 Trend-Hold Ratchet: 9:41 AM intra-bar bounce (+8.5% after +54.9% peak) under Flow VWAP in neg-gamma does NOT exit", () => {
  const res = evaluateOptionProfitRatchet({
    isCall: false,
    prevPeakOptionPnlPct: 54.88,
    adverseOptionPnlPct: 8.54,
    closeOptionPnlPct: 18.2,
    favorableOptionPnlPct: 45.0,
    openOptionPnlPct: 40.0,
    chi: 0.22,
    netFluxJ: -1.8,
    hasPostEntryBarElapsed: true,
    fluxFlippedAgainst: false,
    isAlignedTrendRegime: true,
    heldMinutes: 6,
    onFavorableSideOfVwap: true,
    evaluateOnCloseOnly: true,
  });

  assert.equal(res.triggered, false, "Aligned negative-gamma trend runner must NOT trigger +30%->BE ratchet at 9:41 AM");
  assert.equal(res.armedTier, "NONE");
});

test("Profit Ratchet: Chop/Counter-Trend regime (isAlignedTrendRegime=false) still locks profit on confirmed 5m close after +60% MFE", () => {
  const res = evaluateOptionProfitRatchet({
    isCall: true,
    prevPeakOptionPnlPct: 64.0,
    adverseOptionPnlPct: 12.0,
    closeOptionPnlPct: 22.0,
    favorableOptionPnlPct: 40.0,
    openOptionPnlPct: 35.0,
    chi: 0.52,
    netFluxJ: 0.1,
    hasPostEntryBarElapsed: true,
    fluxFlippedAgainst: false,
    isAlignedTrendRegime: false,
    heldMinutes: 25,
    onFavorableSideOfVwap: false,
    evaluateOnCloseOnly: true,
  });

  assert.equal(res.triggered, true, "Chop scalp must lock profit on 5m close <= +25% floor");
  assert.equal(res.armedTier, "PROFIT_LOCK_60");
  assert.equal(res.fillPnlPct, 22.0);
});

test("Shakeout Recovery: < +25% ratchet exit unlocks same-direction continuation after 15m when Flow VWAP + SMA34 breakdown confirms", () => {
  const closedTs = 1795099278; // 9:41:18 AM ET
  const tooEarly = evaluateLeg2StructuralGate({
    direction: "PUT",
    etMins: 590, // 9:50 AM ET (only 9m elapsed)
    nowTsSec: closedTs + 540,
    spotPrice: 733.5,
    prevSpotPrice: 734.2,
    zeroGamma: 752.1,
    flowVwap: 737.0,
    sma34: 735.1,
    leg1Trade: {
      contractType: "PUT",
      closedTs,
      btoSpotPrice: 737.2,
      closedSpotPrice: 736.73,
      pnlOptionPct: 8.54,
      exitReason: "OPTION PROFIT RATCHET (+30% -> BREAKEVEN LOCK)",
    },
    testedPutWallOrMinus1Sigma: false,
    testedCallWallOrPlus1Sigma: false,
    has5mBullDiv: false,
    has5mBearDiv: false,
    impulseChi: 0.25,
    deltaChi6Bar: -0.06,
    impulsePeclet: -2.1,
  });
  assert.equal(tooEarly.allowed, false, "Must wait >= 15m cooldown before shakeout recovery");

  const confirmed = evaluateLeg2StructuralGate({
    direction: "PUT",
    etMins: 615, // 10:15 AM ET (34m elapsed)
    nowTsSec: closedTs + 2040,
    spotPrice: 732.8,
    prevSpotPrice: 733.9,
    zeroGamma: 752.1,
    flowVwap: 736.8,
    sma34: 734.6,
    leg1Trade: {
      contractType: "PUT",
      closedTs,
      btoSpotPrice: 737.2,
      closedSpotPrice: 736.73,
      pnlOptionPct: 8.54,
      exitReason: "OPTION PROFIT RATCHET (+30% -> BREAKEVEN LOCK)",
    },
    testedPutWallOrMinus1Sigma: false,
    testedCallWallOrPlus1Sigma: false,
    has5mBullDiv: false,
    has5mBearDiv: false,
    impulseChi: 0.24,
    deltaChi6Bar: -0.08,
    impulsePeclet: -2.4,
  });
  assert.equal(confirmed.allowed, true, "Confirmed Flow VWAP + SMA34 breakdown after < +25% ratchet shakeout must unlock continuation PUT");
});
