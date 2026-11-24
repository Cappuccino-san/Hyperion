import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

import {
  getSessionBoundsEt,
  isAliveOptionExpiration,
} from "../gaiaSessionGuards";
import { GaiaSignalFsm, computeCausalEquilibriumDispersion } from "../gaiaSignalFsm";
import { parseOccSymbol, type NormalizedOptionContract } from "../optionsExposure";
import { computeCanonicalPdeSeries } from "../flowGammaVwap";
import {
  priceOptionWithSkew,
  repriceOptionBS,
  solveImpliedVol,
} from "../execution/optionPricing";
import { selectSmallAccountContract } from "../execution/contractRouter";
import {
  getCanonicalGaiaSlot,
  DISCORD_ALLOWED_TICKERS,
  isDiscordTickerAllowed,
  sendDiscordTradeAlert,
} from "../execution/discordGateway";
import {
  DEFAULT_WATCH_TICKERS,
  getActiveTrackedTickers,
  registerActiveTrackedTicker,
} from "../liveBotDaemon";
import { POST as postDiscordRoute } from "../../app/api/discord/route";
import {
  evaluateTradeSignals,
  loadTradeStore,
  saveTradeStore,
  syncGaiaTickerSignalsToDiscord,
} from "../tradeSignalEngine";
import {
  ALPHA_PRIORS_SCHEMA_VERSION,
  readAlphaPriorsSync,
  resetPersistenceMemCachesForTests,
} from "../persistenceStore";
import { POST as postSignalsRoute } from "../../app/api/signals/route";

function withTempCacheDir<T>(fn: (tmpDir: string) => Promise<T> | T): Promise<T> {
  const prev = process.env.HYPERION_CACHE_DIR;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hyperion-phase2-test-"));
  process.env.HYPERION_CACHE_DIR = tmpDir;
  resetPersistenceMemCachesForTests();
  return Promise.resolve()
    .then(() => fn(tmpDir))
    .finally(() => {
      resetPersistenceMemCachesForTests();
      if (prev === undefined) {
        delete process.env.HYPERION_CACHE_DIR;
      } else {
        process.env.HYPERION_CACHE_DIR = prev;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
}

test("P0-A1: High-IV fallback prefers qualifying 1-2DTE and falls back to 0DTE without null drought", async () => {
  const nowEt = new Date("2026-11-23T15:30:00Z"); // 10:30 EST
  const exp0 = "2026-11-23";
  const exp1 = "2026-11-24";

  // Case 1: ATM 0DTE priced out ($1.85 > $0.99), both 1DTE ($0.88) and OTM 0DTE ($0.72) qualify -> prefers 1DTE
  const chainWithMultiDte: NormalizedOptionContract[] = [
    {
      symbol: "SPY261123C00655000",
      strike: 655,
      expiration: exp0,
      optionType: "C",
      bid: 1.80,
      ask: 1.85,
      last: 1.82,
      volume: 15000,
      openInterest: 12000,
      iv: 0.28,
      delta: 0.50,
      gamma: 0.06,
      vega: 0.08,
      percentChange: 0,
    },
    {
      symbol: "SPY261123C00659000",
      strike: 659,
      expiration: exp0,
      optionType: "C",
      bid: 0.68,
      ask: 0.72,
      last: 0.70,
      volume: 9000,
      openInterest: 8000,
      iv: 0.27,
      delta: 0.22,
      gamma: 0.04,
      vega: 0.06,
      percentChange: 0,
    },
    {
      symbol: "SPY261124C00660000",
      strike: 660,
      expiration: exp1,
      optionType: "C",
      bid: 0.84,
      ask: 0.88,
      last: 0.86,
      volume: 7000,
      openInterest: 6500,
      iv: 0.26,
      delta: 0.25,
      gamma: 0.04,
      vega: 0.09,
      percentChange: 0,
    },
  ];

  const pickedStage1 = await selectSmallAccountContract({
    ticker: "SPY",
    contractType: "CALL",
    spotPrice: 655,
    target1Spot: 659.5,
    target2Spot: 662,
    stopLossSpot: 653,
    contracts: chainWithMultiDte,
    nowEt,
    zeroDteCallWall: 663,
    zeroDtePutWall: 650,
    regime: "NEG_GAMMA_TREND",
    absImpulsePeclet: 2.1,
    remainingExpectedMove: 6.5,
  });
  assert.ok(pickedStage1, "Stage 1 should select a contract");
  assert.equal(pickedStage1?.expiration, exp1, "Should prefer qualifying 1DTE contract in High-IV");
  assert.equal(pickedStage1?.contractsQty, 1);
  assert.ok((pickedStage1?.totalOutlay ?? 999) <= 100);

  // Case 2: 1DTE is also > $0.99 ($1.35), only OTM 0DTE ($0.72) is <= $0.99 -> Stage 2 selects 0DTE without returning null
  const chainOnly0DteSubDollar: NormalizedOptionContract[] = [
    chainWithMultiDte[0],
    chainWithMultiDte[1],
    {
      ...chainWithMultiDte[2],
      bid: 1.30,
      ask: 1.35,
      last: 1.33,
    },
  ];

  const pickedStage2 = await selectSmallAccountContract({
    ticker: "SPY",
    contractType: "CALL",
    spotPrice: 655,
    target1Spot: 659.5,
    target2Spot: 662,
    stopLossSpot: 653,
    contracts: chainOnly0DteSubDollar,
    nowEt,
    zeroDteCallWall: 663,
    zeroDtePutWall: 650,
    regime: "NEG_GAMMA_TREND",
    absImpulsePeclet: 2.1,
    remainingExpectedMove: 6.5,
  });
  assert.ok(pickedStage2, "Stage 2 must keep qualifying 0DTE alive instead of returning null");
  assert.equal(pickedStage2?.expiration, exp0);
  assert.equal(pickedStage2?.strike, 659);
  assert.ok((pickedStage2?.totalOutlay ?? 999) <= 100);
});

test("P0-A2: Full 2C/2P daily capacity, 15m shakeout/win-continuation, chop kill-switch & global single-slot lock", async () => {
  await withTempCacheDir(async () => {
    const testDate = "2026-11-23";
    const tOpen = Math.floor(new Date("2026-11-23T15:00:00Z").getTime() / 1000); // 10:00 EST
    const tClose1 = tOpen + 900; // 10:15 EST

    // 1. Shakeout recovery after +15m (900s >= 900s, < 1800s) is permitted on same-direction CALL
    saveTradeStore({
      date: testDate,
      activePositions: {},
      closedPositions: [
        {
          id: "spy-shakeout-1",
          ticker: "SPY",
          contractType: "CALL",
          contractLabel: "SPY 261123 656C",
          strike: 656,
          expiration: testDate,
          setupName: "Zero-Gamma Bullish Volatility Breakout",
          status: "CLOSED",
          btoSpotPrice: 655.0,
          btoOptionMid: 0.70,
          optionAsk: 0.70,
          contractsQty: 1,
          remainingQty: 0,
          totalOutlay: 70,
          target1Spot: 658.0,
          target2Spot: 661.0,
          stopLossSpot: 653.5,
          openedAt: "10:00 AM",
          openedTs: tOpen,
          closedAt: "10:15 AM",
          closedTs: tClose1,
          closedSpotPrice: 655.2,
          pnlOptionPct: 2.0,
          exitReason: "BREAKEVEN_RATCHET_STOP",
        },
      ],
      alerts: [],
      prevSpotPrices: { SPY: 654.8 },
    });

    const chain: NormalizedOptionContract[] = [
      {
        symbol: "SPY261123C00657000",
        strike: 657,
        expiration: testDate,
        optionType: "C",
        bid: 0.74,
        ask: 0.76,
        last: 0.75,
        volume: 12000,
        openInterest: 10000,
        iv: 0.18,
        delta: 0.40,
        gamma: 0.05,
        vega: 0.06,
        percentChange: 0,
      },
    ];

    const shakeoutTs = tClose1 + 960; // 10:31 EST (+16m >= 15m)
    const reEntryRes = await evaluateTradeSignals({
      ticker: "SPY",
      spotPrice: 656.2,
      prevSpotPrice: 654.8,
      callWall: 662.0,
      putWall: 650.0,
      zeroGamma: 655.0,
      priorClose: 654.5,
      premarketFlowVwap: 655.4,
      divergence5m: "BULL",
      contracts: chain,
      nowEt: new Date(shakeoutTs * 1000),
      isHistoricalBackfill: true,
      latest5mCandle: {
        open: 655.3,
        high: 656.3,
        low: 655.2,
        close: 656.2,
        sma34: 655.5,
        timestamp: shakeoutTs,
        flowSnapshot: {
          timestamp: shakeoutTs,
          spot: 656.2,
          flowVwap: 655.6,
          ceilingShareChi: 0.68,
          impulseChi: 0.74,
          pecletNumber: 2.2,
          impulsePeclet: 2.4,
          netFluxJ: 0.35,
          deltaChi6Bar: 0.08,
          deltaImpulseChi6Bar: 0.12,
          deltaNetFlux6Bar: 0.20,
          upper1s: 657.2,
          lower1s: 654.0,
          upper2s: 658.8,
          lower2s: 652.4,
          upper1Sigma: 657.2,
          lower1Sigma: 654.0,
          upper2Sigma: 658.8,
          lower2Sigma: 652.4,
          sigma: 1.6,
          variance: 2.56,
          cumGammaWeight: 100,
          totalWeight: 100,
          signedGammaAcceleration: 0,
          count: 12,
          bandSignal: null,
        },
      },
    });
    assert.equal(reEntryRes.activePosition?.contractType, "CALL", "15m shakeout recovery should open 2nd CALL");

    // 2. Global single-slot lock: while SPY is active, QQQ and IWM are strictly blocked
    const iwmBlocked = await evaluateTradeSignals({
      ticker: "IWM",
      spotPrice: 235.0,
      prevSpotPrice: 234.0,
      callWall: 238.0,
      putWall: 231.0,
      zeroGamma: 234.2,
      contracts: [
        {
          symbol: "IWM261123C00235500",
          strike: 235.5,
          expiration: testDate,
          optionType: "C",
          bid: 0.65,
          ask: 0.68,
          last: 0.67,
          volume: 8000,
          openInterest: 7000,
          iv: 0.24,
          delta: 0.40,
          gamma: 0.09,
          vega: 0.04,
          percentChange: 0,
        },
      ],
      nowEt: new Date((shakeoutTs + 60) * 1000),
      isHistoricalBackfill: true,
    });
    assert.equal(iwmBlocked.activePosition, null, "IWM must be blocked while SPY holds global single slot");

    // 3. Chop kill-switch: 2 losing trades strictly locks ticker for day
    saveTradeStore({
      date: testDate,
      activePositions: {},
      closedPositions: [
        {
          id: "loss-1",
          ticker: "SPY",
          contractType: "CALL",
          contractLabel: "SPY 657C",
          strike: 657,
          expiration: testDate,
          setupName: "Breakout",
          status: "CLOSED",
          btoSpotPrice: 656,
          btoOptionMid: 0.75,
          optionAsk: 0.75,
          contractsQty: 1,
          remainingQty: 0,
          totalOutlay: 75,
          target1Spot: 659,
          target2Spot: 661,
          stopLossSpot: 654.5,
          openedAt: "09:45 AM",
          openedTs: tOpen - 900,
          closedAt: "10:00 AM",
          closedTs: tOpen,
          pnlOptionPct: -45,
          exitReason: "HARD_STOP_LOSS",
        },
        {
          id: "loss-2",
          ticker: "SPY",
          contractType: "PUT",
          contractLabel: "SPY 654P",
          strike: 654,
          expiration: testDate,
          setupName: "Flush",
          status: "CLOSED",
          btoSpotPrice: 655,
          btoOptionMid: 0.75,
          optionAsk: 0.75,
          contractsQty: 1,
          remainingQty: 0,
          totalOutlay: 75,
          target1Spot: 652,
          target2Spot: 650,
          stopLossSpot: 656.5,
          openedAt: "10:40 AM",
          openedTs: tOpen + 2400,
          closedAt: "11:00 AM",
          closedTs: tOpen + 3600,
          pnlOptionPct: -45,
          exitReason: "HARD_STOP_LOSS",
        },
      ],
      alerts: [],
      prevSpotPrices: { SPY: 654.8 },
    });

    const afterTwoLossesTs = tOpen + 7200; // 12:00 EST (+60m cooldown)
    const killSwitchRes = await evaluateTradeSignals({
      ticker: "SPY",
      spotPrice: 656.2,
      prevSpotPrice: 654.8,
      callWall: 662.0,
      putWall: 650.0,
      zeroGamma: 655.0,
      priorClose: 654.5,
      premarketFlowVwap: 655.4,
      divergence5m: "BULL",
      contracts: chain,
      nowEt: new Date(afterTwoLossesTs * 1000),
      isHistoricalBackfill: true,
      latest5mCandle: {
        open: 655.3,
        high: 656.3,
        low: 655.2,
        close: 656.2,
        sma34: 655.5,
        timestamp: afterTwoLossesTs,
      },
    });
    assert.equal(killSwitchRes.activePosition, null, "Chop kill-switch (>= 2 losses) must lock ticker for the day");
  });
});

test("P0-D2: Black Friday 2026-11-27 early-close bounds & EST 0DTE expiration liveness", () => {
  const bfBounds = getSessionBoundsEt("2026-11-27");
  assert.equal(bfBounds.isTradingDay, true);
  assert.equal(bfBounds.isEarlyClose, true);
  assert.equal(bfBounds.entryCutoffMins, 690, "11:30 ET entry cutoff on half-day");
  assert.equal(bfBounds.eodFlatMins, 775, "12:55 ET MOC flat on half-day");
  assert.equal(bfBounds.rthCloseMins, 780, "13:00 ET RTH close on half-day");

  // GaiaSignalFsm enforces 11:30 ET entry cutoff and 12:55 ET MOC force-close on 2026-11-27
  const fsm = new GaiaSignalFsm("STAND_ASIDE");
  const disp = computeCausalEquilibriumDispersion([], -1);
  const bf1140Ts = Math.floor(new Date("2026-11-27T16:40:00Z").getTime() / 1000); // 11:40 EST (> 11:30 cutoff)
  const blockedEntry = fsm.evaluateTransition(
    "STAND_ASIDE",
    {
      barTimestamp: bf1140Ts,
      open: 655,
      high: 657,
      low: 654.8,
      close: 656.8,
      chi: 0.78,
      bias: 60,
      netFlux: 0.45,
      peclet: 2.5,
      flowVwap: 655.2,
      sma34: 655.0,
      isClosed: true,
    },
    disp,
    {
      macroRegime: "CALL",
      callDominancePct: 78,
      structuralLevels: { zeroGamma: 654, callWall: 662, putWall: 650 },
    }
  );
  assert.equal(blockedEntry.nextState, "STAND_ASIDE", "GaiaSignalFsm must block new entries after 11:30 ET on Black Friday");

  const bf1255Ts = Math.floor(new Date("2026-11-27T17:55:00Z").getTime() / 1000); // 12:55 EST MOC
  const forcedExit = fsm.evaluateTransition(
    "LONG",
    {
      barTimestamp: bf1255Ts,
      open: 657,
      high: 657.5,
      low: 656.8,
      close: 657.2,
      chi: 0.72,
      bias: 50,
      netFlux: 0.3,
      peclet: 1.8,
      isClosed: true,
    },
    disp
  );
  assert.equal(forcedExit.nextState, "STAND_ASIDE");
  assert.equal(forcedExit.reason, "EOD_1255_FORCE_CLOSE");

  // QuadView EST 0DTE liveness (15:30 EST = 20:30Z must stay ALIVE; 16:05 EST = 21:05Z is expired)
  assert.equal(
    isAliveOptionExpiration("2026-11-23", new Date("2026-11-23T20:30:00Z")),
    true,
    "0DTE must remain alive at 15:30 EST (20:30Z)"
  );
  assert.equal(
    isAliveOptionExpiration("2026-11-23", new Date("2026-11-23T21:05:00Z")),
    false,
    "0DTE must expire at/after 16:00 EST (21:00Z)"
  );
  assert.equal(
    isAliveOptionExpiration("2026-11-27", new Date("2026-11-27T17:30:00Z")),
    true,
    "Black Friday 0DTE alive at 12:30 EST"
  );
  assert.equal(
    isAliveOptionExpiration("2026-11-27", new Date("2026-11-27T18:05:00Z")),
    false,
    "Black Friday 0DTE expired after 13:00 EST"
  );
});

test("P1-D3: Unified PDE series parity, digit-suffixed OCC root rejection, and BS r/q forward parity", () => {
  assert.deepEqual(parseOccSymbol("SPY261124C00655000"), {
    root: "SPY",
    expiration: "2026-11-24",
    optionType: "C",
    strike: 655,
  });
  assert.equal(parseOccSymbol("SPY1261124C00655000"), null, "Corporate-action adjusted root SPY1 must be rejected");
  assert.equal(parseOccSymbol("SMCI1261124P00035000"), null, "Corporate-action adjusted root SMCI1 must be rejected");

  const baseTs = Math.floor(new Date("2026-11-23T14:30:00Z").getTime() / 1000);
  const candles = Array.from({ length: 12 }, (_, i) => ({
    timestamp: baseTs + i * 300,
    open: 650 + i * 0.35,
    high: 650.5 + i * 0.35,
    low: 649.8 + i * 0.35,
    close: 650.3 + i * 0.35,
    volume: 120_000,
  }));

  const fromContracts = computeCanonicalPdeSeries({
    candles,
    contracts: [
      { strike: 655, gamma: 0.05, openInterest: 10_000, volume: 500, optionType: "C" },
      { strike: 648, gamma: 0.04, openInterest: 8_000, volume: 400, optionType: "P" },
    ],
    structuralNodes: { ceilingNode: 658, floorNode: 646, zeroGamma: 651 },
    windowLatestSession: true,
  });
  const fromBuckets = computeCanonicalPdeSeries({
    candles,
    optionBuckets: [
      { strike: 655, callGamma: 0.05, callOI: 10_000, callVol: 500 },
      { strike: 648, putGamma: 0.04, putOI: 8_000, putVol: 400 },
    ],
    structuralNodes: { callWall: 658, putWall: 646, zeroGamma: 651 },
  });

  assert.equal(fromContracts.length, fromBuckets.length);
  const lastA = fromContracts[fromContracts.length - 1];
  const lastB = fromBuckets[fromBuckets.length - 1];
  assert.equal(lastA.flowVwap, lastB.flowVwap, "Unified PDE flowVwap must match 1:1");
  assert.equal(lastA.ceilingShareChi, lastB.ceilingShareChi, "Unified PDE chi must match 1:1");
  assert.equal(lastA.pecletNumber, lastB.pecletNumber, "Unified PDE Peclet must match 1:1");

  // BS r=0.045, q=0.012 round-trip parity with priceOptionWithSkew
  const skewQuote = priceOptionWithSkew({
    spot: 655,
    strike: 655,
    direction: "LONG",
    remainingYears: 1 / 252,
    atmIv: 0.18,
  });
  const solvedIv = solveImpliedVol(skewQuote.mid, 655, 655, 1 / 252, true);
  const repriced = repriceOptionBS(655, 655, 1 / 252, solvedIv, true);
  assert.ok(Math.abs(solvedIv - skewQuote.iv) <= 0.005, `Solved IV ${solvedIv} should match ${skewQuote.iv}`);
  assert.ok(Math.abs(repriced - skewQuote.mid) <= 0.02, `Repriced ${repriced} should match ${skewQuote.mid}`);
});

test("P0-D1 & P0-A4: Single-writer ledger lock, SHORT_OPEN slot classification, and alpha-priors v2 reset", async () => {
  assert.equal(
    getCanonicalGaiaSlot({
      id: "sig-open",
      type: "SHORT",
      price: 650,
      label: "SHORT · OPEN",
    }),
    "SHORT_OPEN",
    "SHORT · OPEN must never misclassify as LONG_OPEN"
  );

  await withTempCacheDir(async (tmpDir) => {
    // Seed poisoned v1 alpha-priors with 0.60 weights -> verify automatic v2 reset
    fs.writeFileSync(
      path.join(tmpDir, "alpha-priors.json"),
      JSON.stringify({
        version: 1,
        updatedAt: "2026-11-20T00:00:00Z",
        totalAttributedSessions: 9,
        baselineExpectancyR: -0.25,
        featureWeights: {
          fluxAlignment: 0.6,
          flowVwapBand: 0.6,
          wallRoom: 0.6,
          kingMagnet: 0.6,
          mtfDivergence: 0.6,
          regimeFit: 0.6,
        },
        regimeStats: {},
        setupStats: {},
      }),
      "utf-8"
    );
    const migrated = readAlphaPriorsSync();
    assert.equal(migrated.version, ALPHA_PRIORS_SCHEMA_VERSION);
    assert.equal(migrated.featureWeights.fluxAlignment, 1.0);
    assert.equal(migrated.featureWeights.flowVwapBand, 1.0);
    assert.equal(migrated.baselineExpectancyR, 0.0);

    // Seed clean empty trade store and verify SYNC_GAIA_TICKER_SIGNALS never creates trades
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    saveTradeStore({
      date: today,
      activePositions: {},
      closedPositions: [],
      alerts: [],
      prevSpotPrices: {},
    });

    const directSync = await syncGaiaTickerSignalsToDiscord({
      ticker: "SPY",
      spotPrice: 655,
      sessionDate: today,
      activeFsmState: "LONG",
      macroRegime: "CALL",
      chiPct: 72,
      zeroGamma: 653,
      signals: [
        {
          id: "client-sig-1",
          type: "LONG",
          price: 655,
          timestamp: Math.floor(Date.now() / 1000),
          label: "LONG · OPEN",
        },
      ],
    });
    assert.equal(directSync.dispatchedCount, 0);
    const afterDirect = loadTradeStore();
    assert.equal(Object.keys(afterDirect.activePositions).length, 0, "Client sync must never open positions");
    assert.equal(afterDirect.closedPositions.length, 0, "Client sync must never close positions");
    assert.equal(afterDirect.gaiaStateByTicker?.SPY?.macroRegime, "CALL");

    const req = new NextRequest("http://localhost:3000/api/signals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "SYNC_GAIA_TICKER_SIGNALS",
        ticker: "QQQ",
        spotPrice: 575,
        sessionDate: today,
        activeFsmState: "SHORT",
        macroRegime: "PUT",
        chiPct: 31,
        signals: [{ id: "qqq-sig-1", type: "SHORT", price: 575, label: "SHORT · OPEN" }],
      }),
    });
    const routeRes = await postSignalsRoute(req);
    const routeJson = await routeRes.json();
    assert.equal(routeRes.status, 200);
    assert.equal(routeJson.dispatchedCount, 0);
    assert.equal(Object.keys(loadTradeStore().activePositions).length, 0);
  });
});

test("SPY/QQQ Autonomous Execution & Discord Allowlist Gate: blocks IWM, NVDA, and all non-SPY/QQQ tickers", async () => {
  await withTempCacheDir(async () => {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    saveTradeStore({
      date: today,
      activePositions: {},
      closedPositions: [],
      alerts: [],
      prevSpotPrices: {},
    });

    // 1. DEFAULT_WATCH_TICKERS is strictly ["SPY", "QQQ"]
    assert.deepEqual(Array.from(DEFAULT_WATCH_TICKERS), ["SPY", "QQQ"]);
    assert.deepEqual(Array.from(DISCORD_ALLOWED_TICKERS), ["SPY", "QQQ"]);

    // 2. Browsing IWM or NVDA never enrolls them into daemon tracking
    assert.deepEqual(registerActiveTrackedTicker("IWM"), ["SPY", "QQQ"]);
    assert.deepEqual(registerActiveTrackedTicker("NVDA"), ["SPY", "QQQ"]);
    assert.deepEqual(getActiveTrackedTickers(), ["SPY", "QQQ"]);

    // 3. Already-open legacy position still stays visible in getActiveTrackedTickers() solely so STC/MOC can close it cleanly
    saveTradeStore({
      date: today,
      activePositions: {
        IWM: {
          id: "legacy-iwm-open",
          ticker: "IWM",
          contractType: "PUT",
          contractLabel: "IWM 265P",
          strike: 265,
          expiration: today,
          setupName: "Legacy Open",
          status: "OPEN",
          btoSpotPrice: 266,
          btoOptionMid: 0.65,
          contractsQty: 1,
          remainingQty: 1,
          totalOutlay: 65,
          target1Spot: 264,
          target2Spot: 262,
          stopLossSpot: 267.5,
          openedAt: "10:00 AM",
          openedTs: Math.floor(Date.now() / 1000) - 300,
        },
      },
      closedPositions: [],
      alerts: [],
      prevSpotPrices: {},
    });
    assert.deepEqual(getActiveTrackedTickers(), ["SPY", "QQQ", "IWM"]);

    // 4. Outbound Discord trade & level-migration alerts hard-block non-SPY/QQQ tickers
    assert.equal(isDiscordTickerAllowed("SPY"), true);
    assert.equal(isDiscordTickerAllowed("QQQ"), true);
    assert.equal(isDiscordTickerAllowed("IWM"), false);
    assert.equal(isDiscordTickerAllowed("NVDA"), false);

    const blockedDirect = await sendDiscordTradeAlert(
      {
        id: "iwm-bto-blocked",
        timestamp: "10:15 AM",
        ts: Math.floor(Date.now() / 1000),
        ticker: "IWM",
        action: "BUY_TO_OPEN",
        contractType: "PUT",
        contractLabel: "IWM 265P",
        strike: 265,
        expiration: today,
        setupName: "Bearish Zero-Gamma Flush",
        reason: "Entry",
        status: "OPEN",
        spotPrice: 265.5,
        btoSpotPrice: 265.5,
        target1Spot: 263.5,
        target2Spot: 262.0,
        stopLossSpot: 267.0,
        optionMid: 0.65,
        btoOptionMid: 0.65,
        contractsQty: 1,
        remainingQty: 1,
        totalOutlay: 65,
        message: "Blocked non-SPY/QQQ",
      },
      "https://discord.com/api/webhooks/123456789012345678/validToken123"
    );
    assert.equal(blockedDirect, false, "sendDiscordTradeAlert must never dispatch IWM alerts");

    const prevAdminToken = process.env.HYPERION_ADMIN_TOKEN;
    process.env.HYPERION_ADMIN_TOKEN = "test-admin-lock-token";
    try {
      for (const blockedSym of ["IWM", "NVDA"]) {
        const routeBlocked = await postDiscordRoute(
          new NextRequest("http://localhost:3000/api/discord", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-hyperion-admin-token": "test-admin-lock-token",
            },
            body: JSON.stringify({
              dryRun: true,
              ticker: blockedSym,
              action: "BUY_TO_OPEN",
              spotPrice: 265,
            }),
          })
        );
        const blockedJson = await routeBlocked.json();
        assert.equal(routeBlocked.status, 200);
        assert.equal(blockedJson.ignored, true);
        assert.match(String(blockedJson.reason), /SPY and QQQ/);
      }

      for (const allowedSym of ["SPY", "QQQ"]) {
        const routeAllowed = await postDiscordRoute(
          new NextRequest("http://localhost:3000/api/discord", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-hyperion-admin-token": "test-admin-lock-token",
            },
            body: JSON.stringify({
              dryRun: true,
              ticker: allowedSym,
              action: "BUY_TO_OPEN",
              spotPrice: 650,
            }),
          })
        );
        const allowedJson = await routeAllowed.json();
        assert.equal(routeAllowed.status, 200);
        assert.equal(allowedJson.success, true);
        assert.equal(allowedJson.validated, true);
      }
    } finally {
      if (prevAdminToken === undefined) delete process.env.HYPERION_ADMIN_TOKEN;
      else process.env.HYPERION_ADMIN_TOKEN = prevAdminToken;
    }
  });
});
