import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

import {
  computeDominanceReadout,
  evaluateZeroFlowFilter,
  type OpraPrintAdapter,
  type ZeroFlowCandlePoint,
} from "../zeroFlowFilter";
import { evaluateZeroRegimeSwitcher } from "../zeroRegimeSwitcher";
import {
  evaluateZeroShadowTick,
  readZeroShadowSummary,
} from "../zeroShadowLedger";
import { classifyDominanceTriState } from "../flowGammaVwap";
import {
  createEmptySessionLedger,
  readSessionLedgerSync,
  resetPersistenceMemCachesForTests,
} from "../persistenceStore";
import type { NormalizedOptionContract } from "../optionsExposure";

const tempCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "hyperion-zero-suite-"));
const prevCacheEnv = process.env.HYPERION_CACHE_DIR;
process.env.HYPERION_CACHE_DIR = tempCacheDir;

beforeEach(() => {
  resetPersistenceMemCachesForTests();
  const shadowFile = path.join(tempCacheDir, "zero-shadow-ledger.json");
  if (fs.existsSync(shadowFile)) {
    fs.unlinkSync(shadowFile);
  }
});

after(() => {
  resetPersistenceMemCachesForTests();
  if (prevCacheEnv === undefined) delete process.env.HYPERION_CACHE_DIR;
  else process.env.HYPERION_CACHE_DIR = prevCacheEnv;
  try {
    fs.rmSync(tempCacheDir, { recursive: true, force: true });
  } catch {}
});

test("Bug 1a Regression: SPY 10:54 AM bearish selloff + noisy +58 10M bounce resolves STAND_ASIDE (never LONG +58)", () => {
  // Reproduce 2026-11-24 10:54 AM ET SPY state:
  // priorClose = $722.29, open930 = $715.56, Flow VWAP = $719.15, spot = $715.72 ($3.43 below VWAP),
  // Net GEX = -8.90B, 10:40 low = $713.50 -> 2-bar bounce to $715.72, CALLS TODAY = 0.
  const baseTs = Math.floor(Date.parse("2026-11-24T15:20:00Z") / 1000); // 10:20 AM EST
  const prices = [717.8, 716.9, 715.8, 714.4, 713.5, 713.98, 715.72];
  const candles: ZeroFlowCandlePoint[] = prices.map((close, idx) => ({
    timestamp: baseTs + idx * 300,
    open: idx === 0 ? 718.1 : prices[idx - 1],
    high: Math.max(idx === 0 ? 718.1 : prices[idx - 1], close) + 0.15,
    low: Math.min(idx === 0 ? 718.1 : prices[idx - 1], close) - 0.15,
    close,
    flowVwap: 719.15,
    sigma: 1.85,
    chi: idx === prices.length - 1 ? 0.48 : 0.33,
    impulseChi: idx === prices.length - 1 ? 0.62 : 0.31,
    pe: idx === prices.length - 1 ? -0.24 : -2.17,
    impulsePe: idx === prices.length - 1 ? 0.45 : -1.9,
    netFluxJ: idx === prices.length - 1 ? -7.28 : -61.48,
    deltaNetFlux6Bar: -12.4,
  }));

  const res = evaluateZeroFlowFilter({
    ticker: "SPY",
    candles,
    liveSpot: 715.72,
    open930: 715.56,
    priorClose: 722.29,
    straddleEm: 3.4,
    zeroGamma0Dte: 719.23,
    callWall0Dte: 730,
    putWall0Dte: 715,
    netGex: -8.9,
    activeCallDirection: null,
    regimeMode: "FOLLOW",
  });

  assert.equal(res.dataMode, "CHAIN_SNAPSHOT_PDE");
  assert.notEqual(res.verdict, "LONG", "10M micro-bounce below Flow VWAP must NEVER trigger LONG");
  assert.equal(res.verdict, "STAND_ASIDE");
  assert.equal(res.stageTelemetry.counterTrendBounceDiscounted, true);
  assert.ok(res.compositeScore < 0, `Expected negative composite score below VWAP, got ${res.compositeScore}`);
  const m10 = res.drivers.find((d) => d.key === "10M")!;
  const px = res.drivers.find((d) => d.key === "PX")!;
  assert.ok(m10.rawValue >= 40, `Expected raw 10M >= +40, got ${m10.rawValue}`);
  assert.ok(m10.value < m10.rawValue * 0.6, "Laundered 10M must discount counter-trend bounce");
  assert.ok(px.value <= -50, `Expected bearish PX <= -50, got ${px.value}`);
});

test("Bug 1b Regression: chi=0.50 resolves NEUTRAL (never CALL) & chi<=0.45 resolves PUT DOMINANCE", () => {
  const tie = classifyDominanceTriState(0.5, 0.5);
  assert.equal(tie.dominance, "NEUTRAL");
  assert.equal(tie.chiPct, 50);
  assert.match(tie.label, /NEUTRAL BALANCE/);
  assert.doesNotMatch(tie.label, /^CALL DOMINANCE/);

  const bearish = classifyDominanceTriState(0.4, 0.38);
  assert.equal(bearish.dominance, "PUT");
  assert.equal(bearish.chiPct, 40);
  assert.equal(bearish.dominancePct, 60);
  assert.equal(bearish.label, "PUT DOMINANCE 60% (χ=40%)");

  const bullish = computeDominanceReadout(0.64, 0.68);
  assert.equal(bullish.dominance, "CALL");
  assert.equal(bullish.dominanceLabel, "CALL DOMINANCE 64%");
});

test("Pillar 2.1: 4-Stage Flow Filter discounts unconfirmed put-hedge seatbelt noise, boosts AM call bursts, and supports OpraPrintAdapter", () => {
  const amTs = Math.floor(Date.parse("2026-11-24T15:10:00Z") / 1000); // 10:10 AM EST (pre-noon)
  // Spot above Flow VWAP ($724.50 > $722.00) and above Zero-Gamma ($721.00) with minor 2-bar dip -> seatbelt discount
  const pullbackAboveVwap: ZeroFlowCandlePoint[] = [722.2, 723.0, 724.1, 725.0, 724.8, 724.45].map(
    (c, i, arr) => ({
      timestamp: amTs + i * 300,
      open: i === 0 ? 722.0 : arr[i - 1],
      high: Math.max(c, i === 0 ? 722.0 : arr[i - 1]) + 0.12,
      low: Math.min(c, i === 0 ? 722.0 : arr[i - 1]) - 0.12,
      close: c,
      flowVwap: 722.0,
      sigma: 1.5,
      chi: 0.62,
      impulseChi: 0.56,
      pe: 1.4,
      impulsePe: 0.9,
      netFluxJ: 18.0,
    })
  );

  const seatbeltRes = evaluateZeroFlowFilter({
    ticker: "SPY",
    candles: pullbackAboveVwap,
    liveSpot: 724.45,
    open930: 722.0,
    priorClose: 721.5,
    zeroGamma0Dte: 721.0,
    netGex: 4.5,
  });
  assert.equal(seatbeltRes.stageTelemetry.putSeatbeltDiscounted, true);
  assert.notEqual(seatbeltRes.verdict, "SHORT");

  // Pre-noon decisive call breakout + plugged-in OpraPrintAdapter
  const mockAdapter: OpraPrintAdapter = {
    providerName: "MockOpraStream",
    getWindowSummary: () => ({
      windowStartTs: amTs,
      windowEndTs: amTs + 1500,
      totalContracts: 2000,
      askSideContracts: 1550,
      bidSideContracts: 300,
      midOrCrossContracts: 150,
      sweepContracts: 620,
      callAskPremiumDollars: 420_000,
      putAskPremiumDollars: 65_000,
      callBidPremiumDollars: 50_000,
      putBidPremiumDollars: 90_000,
    }),
  };

  const amBreakout: ZeroFlowCandlePoint[] = [722.0, 722.6, 723.2, 723.9, 724.7, 725.6].map(
    (c, i, arr) => ({
      timestamp: amTs + i * 300,
      open: i === 0 ? 721.8 : arr[i - 1],
      high: c + 0.05,
      low: (i === 0 ? 721.8 : arr[i - 1]) - 0.05,
      close: c,
      flowVwap: 722.8,
      sigma: 1.4,
      chi: 0.68,
      impulseChi: 0.74,
      pe: 2.3,
      impulsePe: 2.8,
      netFluxJ: 34.0,
      deltaNetFlux6Bar: 16.0,
    })
  );

  const amRes = evaluateZeroFlowFilter({
    ticker: "SPY",
    candles: amBreakout,
    liveSpot: 725.6,
    open930: 722.0,
    priorClose: 721.5,
    zeroGamma0Dte: 722.0,
    netGex: -3.2,
    regimeMode: "FOLLOW",
    opraAdapter: mockAdapter,
  });
  assert.equal(amRes.dataMode, "OPRA_PRINT_STREAM");
  assert.equal(amRes.stageTelemetry.amCallClarityBoost, true);
  assert.equal(amRes.verdict, "LONG");
  assert.ok(amRes.compositeScore >= 32);
});

test("Pillar 2.2 & 2.3: Causal Zero Regime Switcher switches FOLLOW / FADE / SIT_OUT and activates 1DTE Toll Shield without lookahead", () => {
  const s1 = createEmptySessionLedger("2026-11-20");
  s1.closedPositions.push({
    id: "fade-w1",
    ticker: "SPY",
    contractType: "CALL",
    contractLabel: "SPY 718C",
    strike: 718,
    expiration: "2026-11-20",
    setupName: "Support Bounce",
    status: "CLOSED",
    btoSpotPrice: 713.6,
    btoOptionMid: 0.85,
    optionAsk: 0.85,
    contractsQty: 1,
    remainingQty: 0,
    totalOutlay: 85,
    target1Spot: 717,
    target2Spot: 719,
    stopLossSpot: 712,
    openedAt: "09:45 AM",
    openedTs: 1795185900,
    closedAt: "10:05 AM",
    closedTs: 1795187100,
    closedSpotPrice: 717.5,
    closedOptionMid: 1.9,
    pnlOptionPct: 123.5,
    rrRatio: 2.0,
  });
  const s2 = createEmptySessionLedger("2026-11-23");
  s2.closedPositions.push({
    id: "fade-w2",
    ticker: "SPY",
    contractType: "PUT",
    contractLabel: "SPY 722P",
    strike: 722,
    expiration: "2026-11-24",
    setupName: "Call Wall Rejection",
    status: "CLOSED",
    btoSpotPrice: 723.0,
    btoOptionMid: 0.8,
    optionAsk: 0.8,
    contractsQty: 1,
    remainingQty: 0,
    totalOutlay: 80,
    target1Spot: 720,
    target2Spot: 718,
    stopLossSpot: 724.5,
    openedAt: "10:30 AM",
    openedTs: 1795447800,
    closedAt: "11:10 AM",
    closedTs: 1795450200,
    closedSpotPrice: 720.2,
    closedOptionMid: 1.45,
    pnlOptionPct: 81.2,
    rrRatio: 2.0,
  });

  // Future date session (2026-11-25) must be ignored causally when evaluating 2026-11-24!
  const futureSession = createEmptySessionLedger("2026-11-25");
  futureSession.closedPositions.push({
    ...s1.closedPositions[0],
    id: "future-leak",
    pnlOptionPct: -90,
  });

  const spyDecision = evaluateZeroRegimeSwitcher({
    sessionDate: "2026-11-24",
    ticker: "SPY",
    etMins: 630,
    spotPrice: 716,
    callWall: 730,
    putWall: 710,
    zeroGamma: 719,
    flowSnapshot: {
      timestamp: 1795534200,
      spot: 716,
      flowVwap: 718,
      upper1s: 719.5,
      lower1s: 716.5,
      upper2s: 721,
      lower2s: 715,
      upper1Sigma: 719.5,
      lower1Sigma: 716.5,
      upper2Sigma: 721,
      lower2Sigma: 715,
      sigma: 1.5,
      variance: 2.25,
      cumGammaWeight: 100,
      totalWeight: 100,
      signedGammaAcceleration: 0,
      count: 20,
      ceilingShareChi: 0.45,
      netFluxJ: -8,
      pecletNumber: -1.6,
      gammaRegime: "NEGATIVE_GAMMA",
      bandSignal: null,
      impulseChi: 0.44,
      impulsePeclet: -1.6,
    },
    historicalSessions: [s1, s2, futureSession],
    baseRegime: "ZERO_GAMMA_FLIP",
    basePreferredDte: "0DTE",
  });

  assert.equal(spyDecision.fadeStats.trades, 2, "Future session must be causally excluded");
  assert.equal(spyDecision.mode, "FADE", "Strong rolling [D-10,D-1] Fade edge must select FADE mode");

  // Coarse strike-grid ETF (IWM $265, $1 step = 0.38%) post-10:15 ET with weak impulse -> SIT_OUT
  const iwmChop = evaluateZeroRegimeSwitcher({
    sessionDate: "2026-11-24",
    ticker: "IWM",
    etMins: 625, // 10:25 AM ET
    spotPrice: 265,
    callWall: 270,
    putWall: 260,
    zeroGamma: 266,
    flowSnapshot: {
      timestamp: 1795533900,
      spot: 265,
      flowVwap: 266.1,
      upper1s: 267,
      lower1s: 265.2,
      upper2s: 267.9,
      lower2s: 264.3,
      upper1Sigma: 267,
      lower1Sigma: 265.2,
      upper2Sigma: 267.9,
      lower2Sigma: 264.3,
      sigma: 0.9,
      variance: 0.81,
      cumGammaWeight: 50,
      totalWeight: 50,
      signedGammaAcceleration: 0,
      count: 12,
      ceilingShareChi: 0.38,
      netFluxJ: -5,
      pecletNumber: -3.1,
      gammaRegime: "NEGATIVE_GAMMA",
      bandSignal: null,
      impulseChi: 0.36,
      impulsePeclet: -3.1,
    },
    historicalSessions: [],
    baseRegime: "NEG_GAMMA_TREND",
    basePreferredDte: "0DTE",
  });
  assert.equal(iwmChop.mode, "SIT_OUT");
  assert.ok(iwmChop.standAsideVetoReason?.includes("Zero Toll Gate"));
});

test("Pillar 2.4: Zero Shadow Ledger prices Ask-in / Bid-out and remains 100% isolated from live trade ledger", () => {
  const sessionDate = "2026-11-24";
  const openTs = Math.floor(Date.parse("2026-11-24T15:00:00Z") / 1000); // 10:00 AM EST
  const closeTs = openTs + 900; // 10:15 AM EST

  const contractsAtEntry: NormalizedOptionContract[] = [
    {
      symbol: "SPY261124C00720000",
      expiration: "2026-11-24",
      optionType: "C",
      strike: 720,
      openInterest: 8500,
      volume: 12400,
      iv: 0.16,
      delta: 0.34,
      gamma: 0.08,
      vega: 0.05,
      percentChange: 0,
      bid: 0.56,
      ask: 0.60, // Ask-in must equal $0.60 (never $0.58 mid!)
      last: 0.58,
    },
    {
      symbol: "SPY261125C00721000",
      expiration: "2026-11-25",
      optionType: "C",
      strike: 721,
      openInterest: 4200,
      volume: 3100,
      iv: 0.15,
      delta: 0.31,
      gamma: 0.05,
      vega: 0.08,
      percentChange: 0,
      bid: 0.68,
      ask: 0.72,
      last: 0.70,
    },
  ];

  evaluateZeroShadowTick({
    ticker: "SPY",
    sessionDate,
    nowTsSec: openTs,
    spotPrice: 719.6,
    openPrice: 718.9,
    flowVwap: 718.5,
    sigma: 1.2,
    compositeScore: 52,
    entryLagMins: 10,
    contracts: contractsAtEntry,
  });

  const midSummary = readZeroShadowSummary("SPY", sessionDate);
  assert.equal(midSummary.entriesToday.length, 2, "FOLLOW and 1DTE shadow modes should arm on breakout");
  const followOpen = midSummary.entriesToday.find((e) => e.mode === "SHADOW_FOLLOW")!;
  assert.equal(followOpen.entryAsk, 0.60, "Shadow entry must pay full Ask ($0.60), never Mid ($0.58)");
  assert.equal(followOpen.currentBid, 0.56, "Initial mark must use real Bid ($0.56)");
  assert.equal(followOpen.status, "OPEN");

  // Rally contracts so Bid reaches +60% ($0.96 >= +55% target lock)
  const contractsAtExit: NormalizedOptionContract[] = [
    { ...contractsAtEntry[0], bid: 0.96, ask: 1.00, last: 0.98 },
    { ...contractsAtEntry[1], bid: 1.12, ask: 1.16, last: 1.14 },
  ];

  evaluateZeroShadowTick({
    ticker: "SPY",
    sessionDate,
    nowTsSec: closeTs,
    spotPrice: 721.4,
    openPrice: 720.8,
    flowVwap: 719.1,
    sigma: 1.3,
    compositeScore: 64,
    entryLagMins: 25,
    contracts: contractsAtExit,
  });

  const finalSummary = readZeroShadowSummary("SPY", sessionDate);
  const followClosed = finalSummary.entriesToday.find((e) => e.mode === "SHADOW_FOLLOW")!;
  assert.equal(followClosed.status, "RIGHT");
  assert.equal(followClosed.exitBid, 0.96, "Shadow exit must fill at real Bid ($0.96)");
  assert.equal(followClosed.pnlOptionPct, 60.0);

  // Verify live session ledger remained 100% untouched
  const liveLedger = readSessionLedgerSync(sessionDate);
  assert.equal(Object.keys(liveLedger?.activePositions ?? {}).length, 0);
  assert.equal((liveLedger?.closedPositions ?? []).length, 0);
});

test("Bug 1c, 1d, 1e & Hard Scope Boundary: Zero HUD source invariants & 0-diff GaiaView.tsx", () => {
  const hudSrc = fs.readFileSync(
    path.join(process.cwd(), "components/gaia/GaiaCallPutBiasHud.tsx"),
    "utf8"
  );
  const tacticalSrc = fs.readFileSync(
    path.join(process.cwd(), "components/gaia/PrzmTacticalHud.tsx"),
    "utf8"
  );

  // 1. PrzmTheCallStrip duplication completely eliminated
  assert.doesNotMatch(hudSrc, /PrzmTheCallStrip/, "Duplicate bottom PrzmTheCallStrip must be removed");
  assert.doesNotMatch(tacticalSrc, /export const PrzmTheCallStrip/, "PrzmTheCallStrip export must be retired");

  // 2. Canonical THE CALL strip strictly mutes unelapsed slots to rgba(30, 41, 59, 0.35) and respects getSessionBoundsEt
  assert.match(hudSrc, /rgba\(30,\s*41,\s*59,\s*0\.35\)/, "Unelapsed RTH slots must mute to rgba(30, 41, 59, 0.35)");
  assert.match(hudSrc, /getSessionBoundsEt\(effectiveSessionDate\)/, "Zero HUD must respect half-day session bounds");

  // 3. Single deduplicated [ TICKER · ZERO ] header rail (no EVERY CALL TODAY duplicate stack)
  assert.doesNotMatch(hudSrc, /EVERY CALL TODAY/, "Redundant EVERY CALL TODAY headers must be merged into ZERO rail");
  assert.match(hudSrc, /ZERO<\/span>/, "Single Zero control rail badge must be present");
  assert.match(hudSrc, /RTH CLOSE/, "Off-hours spot header must display RTH CLOSE instead of $0.00 LIVE TICK");

  // 4. Hard Scope Boundary: git diff on components/views/GaiaView.tsx must be 0 bytes
  const gaiaDiff = execSync("git diff -- components/views/GaiaView.tsx", {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(gaiaDiff.trim(), "", "components/views/GaiaView.tsx Flux Fields MUST have 0 lines modified");
});
