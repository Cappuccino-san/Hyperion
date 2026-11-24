import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type CachedRawChainEntry,
  type NormalizedOptionContract,
  resolveOptionsQuoteProvider,
  resolveTradierAccessToken,
} from "../optionsExposure";
import {
  clampOptionPriceToGreekEnvelope,
  computeRemainingYearsToExpiration,
  repriceOptionBSExact,
  resolveContractsFromRawCacheEntry,
  solveImpliedVol,
} from "../execution/optionPricing";
import { evaluateActivePositionStepA } from "../execution/bracketStateMachine";
import { computeTradeRealizedPnl } from "../execution/pnlAccounting";
import type { DailyTradeStore, OptionTradePosition, TradeLifecycleAlert } from "../execution/types";
import { evaluateZeroShadowTick, readZeroShadowSummary } from "../zeroShadowLedger";
import { evaluatePrzmCallLedger } from "../../components/gaia/PrzmTacticalHud";

const tempCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "hyperion-phantom-exit-test-"));
const prevCacheEnv = process.env.HYPERION_CACHE_DIR;
process.env.HYPERION_CACHE_DIR = tempCacheDir;

process.on("exit", () => {
  if (prevCacheEnv === undefined) delete process.env.HYPERION_CACHE_DIR;
  else process.env.HYPERION_CACHE_DIR = prevCacheEnv;
  try {
    fs.rmSync(tempCacheDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup error
  }
});

function makeIncidentQqqPosition(overrides: Partial<OptionTradePosition> = {}): OptionTradePosition {
  return {
    id: "QQQ-CALL-1795541170",
    ticker: "QQQ",
    contractType: "CALL",
    contractLabel: "QQQ 261124 643C (Today, Nov 24 (0 DTE · Same-Day) · $0.88)",
    strike: 643,
    expiration: "2026-11-24",
    expHuman: "Today, Nov 24 (0 DTE · Same-Day)",
    robinhoodExp: "Nov 24, 2026",
    robinhoodTab: "November 24 (0d)",
    setupName: "Put Wall / King Node & Flux Extremity Reclaim [BTO CALL]",
    status: "OPEN",
    btoSpotPrice: 637.82,
    btoOptionMid: 0.87,
    btoOptionAsk: 0.88,
    optionBid: 0.86,
    optionAsk: 0.88,
    contractsQty: 1,
    remainingQty: 1,
    totalOutlay: 88,
    estTp1Mid: 1.72,
    estTp2Mid: 1.96,
    estStopMid: 0.50,
    tp1Pct: 95,
    tp2Pct: 123,
    target1Spot: 640.80,
    target2Spot: 641.55,
    stopLossSpot: 635.97,
    openedAt: "12:26 PM",
    openedTs: 1795541170,
    rrRatio: 1.61,
    initialRisk: 1.85,
    prevBarLow: 636.67,
    prevBarHigh: 638.17,
    lastCandleTs: 1795541100,
    atr5m: 2.1804,
    lastPrevClose: 637.94,
    entryIv: 0.473, // Inflated raw CBOE IV from incident
    entryTYears: 0.0021757563424230093,
    callWall: 645,
    putWall: 635,
    zeroGamma: 653.25,
    ...overrides,
  };
}

function makeEmptyStore(pos: OptionTradePosition): DailyTradeStore {
  return {
    date: "2026-11-24",
    activePositions: { QQQ: pos },
    closedPositions: [],
    alerts: [],
    prevSpotPrices: { QQQ: pos.btoSpotPrice },
  };
}

test("1. QQQ 261124 643C with LIVE_CHAIN_BID=$0.93: never inflates above $0.93 even on ratchet/limit exits", () => {
  const openedTs = 1795541170;
  const exitTs = 1795541423; // 12:30:23 PM ET (+4.22m)
  const tRem = computeRemainingYearsToExpiration(exitTs * 1000, 0);

  // Even on a large +$2.50 spot move where legacy minGainDelta would raise $0.93 -> $1.22+,
  // allowFloor: false strictly preserves <= $0.93.
  const clamped = clampOptionPriceToGreekEnvelope(
    637.82,
    640.32,
    0.88,
    0.93,
    true,
    4.22,
    {
      strike: 643,
      tEntryYears: 0.0021757563424230093,
      tRemainingYears: tRem,
      allowFloor: false,
    }
  );
  assert.equal(clamped, 0.93, "Matched LIVE_CHAIN_BID ($0.93) must never be raised upward by envelope");

  const liveContracts: NormalizedOptionContract[] = [
    {
      symbol: "QQQ261124C00643000",
      expiration: "2026-11-24",
      optionType: "C",
      strike: 643,
      openInterest: 12_400,
      volume: 48_000,
      iv: 0.21,
      delta: 0.21,
      gamma: 0.04,
      vega: 0.09,
      percentChange: 5,
      bid: 0.93,
      ask: 0.95,
      last: 0.94,
      quoteSource: "TRADIER_LIVE",
    },
  ];

  // Subcase A: At 12:30 PM ET (+1.12 spot move, $0.93 bid), must NOT fire phantom TARGET 2 HIT
  const posOpen = makeIncidentQqqPosition();
  const storeOpen = makeEmptyStore(posOpen);
  const emittedOpen: TradeLifecycleAlert[] = [];
  const resOpen = evaluateActivePositionStepA({
    activePos: posOpen,
    normalizedTicker: "QQQ",
    positionKey: "QQQ",
    isSpxw: false,
    spotPrice: 638.94,
    putWall: 635,
    callWall: 645,
    zeroGamma: 653.25,
    latest5mCandle: {
      open: 637.80,
      high: 638.94,
      low: 637.65,
      close: 638.94,
      sma34: 637.40,
      timestamp: 1795541100,
    },
    divergence5m: "NO",
    contracts: liveContracts,
    dataSource: "TRADIER_LIVE",
    nowTs: exitTs,
    timeStr: "12:30 PM",
    etHours: 12,
    etMinutes: 30,
    etTotalMinutes: 750,
    sessionDate: "2026-11-24",
    store: storeOpen,
    emittedAlerts: emittedOpen,
  });
  assert.ok(resOpen, "Position must remain OPEN at $638.94 / $0.93 bid (well below target1 $640.80 & tp2Pct 123%)");
  assert.equal(emittedOpen.length, 0);

  // Subcase B: Even if prior MFE armed a +25% ratchet floor ($1.10) and a new 5m bar closes with real bid $0.93,
  // exit fill is strictly Math.min(realizableBid $0.93, limitPrice $1.10) = $0.93 (NEVER $1.10 or $1.54).
  const posRatchet = makeIncidentQqqPosition({ peakOptionPnlPct: 68 });
  const storeRatchet = makeEmptyStore(posRatchet);
  const emittedRatchet: TradeLifecycleAlert[] = [];
  const resRatchet = evaluateActivePositionStepA({
    activePos: posRatchet,
    normalizedTicker: "QQQ",
    positionKey: "QQQ",
    isSpxw: false,
    spotPrice: 638.94,
    putWall: 635,
    callWall: 645,
    zeroGamma: 653.25,
    latest5mCandle: {
      open: 638.80,
      high: 638.94,
      low: 638.40,
      close: 638.94,
      sma34: 637.50,
      timestamp: openedTs + 300, // confirmed new 5m bar after entry
    },
    divergence5m: "NO",
    contracts: liveContracts,
    dataSource: "TRADIER_LIVE",
    nowTs: exitTs + 60,
    timeStr: "12:31 PM",
    etHours: 12,
    etMinutes: 31,
    etTotalMinutes: 751,
    sessionDate: "2026-11-24",
    store: storeRatchet,
    emittedAlerts: emittedRatchet,
  });
  assert.equal(resRatchet, null, "Ratchet stop should close position");
  const closed = storeRatchet.closedPositions[0];
  assert.ok(closed);
  assert.equal(closed.closedOptionBid, 0.93, "Must fill at real $0.93 bid, never $1.10 floor or $1.54");
  assert.equal(closed.closedOptionMid, 0.93);
  assert.equal(closed.btoOptionAsk, 0.88);
  assert.equal(closed.pnlOptionPct, 5.68);
  assert.equal(closed.exitQuoteSource, "LIVE_CHAIN_BID");
  assert.notEqual(closed.closedOptionBid, 1.54);
});

test("2. Immutable raw CBOE cache + differential BS shift ignores bogus raw.iv=0.473, avoids double-shift & blocks phantom TARGET 2", () => {
  const fetchedAtMs = 1795541170 * 1000;
  const evalAtMs = 1795541423 * 1000;
  const tRef = computeRemainingYearsToExpiration(fetchedAtMs, 0);

  // Guardrail 1: anchorIv solved from (rawMid=0.87, referenceSpot=637.82, strike=643, tRef) matches within < $0.005
  const anchorIv = solveImpliedVol(0.87, 637.82, 643, tRef, true);
  const bsAtRef = repriceOptionBSExact(637.82, 643, tRef, anchorIv, true);
  assert.ok(
    Math.abs(bsAtRef - 0.87) < 0.005,
    `Expected BS(refSpot, anchorIv) within $0.005 of $0.87, got ${bsAtRef.toFixed(5)} (anchorIv=${anchorIv})`
  );
  assert.ok(anchorIv < 0.30, `True IV for $0.87 0DTE $5.18 OTM call must be < 30%, got ${anchorIv}`);

  const rawContract: NormalizedOptionContract = {
    symbol: "QQQ261124C00643000",
    expiration: "2026-11-24",
    optionType: "C",
    strike: 643,
    openInterest: 12_400,
    volume: 48_000,
    iv: 0.473, // Bogus 47.3% CBOE delayed IV
    delta: 0.41,
    gamma: 0.04,
    vega: 0.09,
    percentChange: 0,
    bid: 0.86,
    ask: 0.88,
    last: 0.87,
    quoteSource: "DELAYED_CBOE",
  };
  const cacheEntry: CachedRawChainEntry = {
    rawContracts: [rawContract],
    referenceSpot: 637.82,
    fetchedAtMs,
    quoteSource: "DELAYED_CBOE",
  };

  const shiftedPass1 = resolveContractsFromRawCacheEntry(cacheEntry, 638.94, evalAtMs);
  const shiftedPass2 = resolveContractsFromRawCacheEntry(cacheEntry, 638.94, evalAtMs);
  const shiftedHigherSpot = resolveContractsFromRawCacheEntry(cacheEntry, 639.60, evalAtMs);

  // Raw cache entry remains 100% immutable
  assert.equal(cacheEntry.rawContracts[0].bid, 0.86);
  assert.equal(cacheEntry.rawContracts[0].ask, 0.88);
  assert.equal(cacheEntry.rawContracts[0].iv, 0.473);

  // Repeated reads at same spot give identical quote (zero double-shift) inside [$0.95, $1.12]
  const bid1 = shiftedPass1[0].bid!;
  assert.equal(bid1, shiftedPass2[0].bid, "Repeated cache resolution must never double-shift quotes");
  assert.ok(
    bid1 >= 0.95 && bid1 <= 1.12,
    `Expected differential CBOE bid on +$1.12 move in [$0.95, $1.12], got $${bid1}`
  );
  // Spot advancing further shifts fresh clones cleanly (zero frozen quotes)
  assert.ok(shiftedHigherSpot[0].bid! > bid1, "Subsequent live spot rally must shift fresh clones without freezing");

  // TRADIER_LIVE cache entries bypass re-anchoring completely
  const tradierEntry: CachedRawChainEntry = {
    rawContracts: [{ ...rawContract, bid: 0.93, ask: 0.95, quoteSource: "TRADIER_LIVE" }],
    referenceSpot: 637.82,
    fetchedAtMs,
    quoteSource: "TRADIER_LIVE",
  };
  const tradierResolved = resolveContractsFromRawCacheEntry(tradierEntry, 641.00, evalAtMs);
  assert.equal(tradierResolved[0].bid, 0.93, "TRADIER_LIVE quotes must never be synthetically re-anchored");

  // Passing DELAYED_CBOE quotes intrabar (even with spot tick 639.76 above 12:25 bar high 638.94)
  // must NOT latch intrabar peakOptionPnlPct or trigger TARGET 2 HIT while spot < target2Spot ($641.55)
  const posDelayed = makeIncidentQqqPosition();
  const storeDelayed = makeEmptyStore(posDelayed);
  const emittedDelayed: TradeLifecycleAlert[] = [];
  const shiftedIntrabar = resolveContractsFromRawCacheEntry(cacheEntry, 639.76, evalAtMs);
  const resDelayed = evaluateActivePositionStepA({
    activePos: posDelayed,
    normalizedTicker: "QQQ",
    positionKey: "QQQ",
    isSpxw: false,
    spotPrice: 639.76,
    putWall: 635,
    callWall: 645,
    zeroGamma: 653.25,
    latest5mCandle: {
      open: 637.80,
      high: 638.94,
      low: 637.65,
      close: 638.94,
      sma34: 637.40,
      timestamp: 1795541100, // same entry bar (intrabar tick)
    },
    divergence5m: "NO",
    contracts: shiftedIntrabar,
    dataSource: "CBOE_MARKET_DATA",
    nowTs: 1795541423,
    timeStr: "12:30 PM",
    etHours: 12,
    etMinutes: 30,
    etTotalMinutes: 750,
    sessionDate: "2026-11-24",
    store: storeDelayed,
    emittedAlerts: emittedDelayed,
  });
  assert.ok(resDelayed, "DELAYED_CBOE_BID must NOT fire phantom TARGET 2 HIT below target2Spot");
  assert.equal(
    resDelayed.peakOptionPnlPct ?? 0,
    0,
    "Intrabar DELAYED_CBOE_BID tick must not latch peakOptionPnlPct before 5m bar close"
  );
});

test("3. BS_FALLBACK (!matchedContract) calibrates entryIv honestly ($0.95-$1.10 on +$1.12 move, never $1.54)", () => {
  const posBs = makeIncidentQqqPosition({ entryIv: 0.473 });
  const storeBs = makeEmptyStore(posBs);
  const emittedBs: TradeLifecycleAlert[] = [];

  // Force an EOD cutoff close with empty contracts array (`!matchedContract` -> BS_FALLBACK) at spot $638.94 (+1.12)
  const resBs = evaluateActivePositionStepA({
    activePos: posBs,
    normalizedTicker: "QQQ",
    positionKey: "QQQ",
    isSpxw: false,
    spotPrice: 638.94,
    putWall: 635,
    callWall: 645,
    zeroGamma: 653.25,
    latest5mCandle: {
      open: 637.80,
      high: 638.94,
      low: 637.65,
      close: 638.94,
      sma34: 637.40,
      timestamp: 1795541400,
    },
    divergence5m: "NO",
    contracts: [],
    nowTs: 1795541423,
    timeStr: "3:55 PM",
    etHours: 15,
    etMinutes: 55,
    etTotalMinutes: 955, // trigger clean close to inspect BS_FALLBACK pricing at +4.22m / +$1.12
    sessionDate: "2026-11-24",
    store: storeBs,
    emittedAlerts: emittedBs,
  });

  assert.equal(resBs, null);
  const closed = storeBs.closedPositions[0];
  assert.ok(closed);
  assert.equal(closed.exitQuoteSource, "BS_FALLBACK");
  assert.ok(
    (closed.closedOptionBid ?? 0) >= 0.95 && (closed.closedOptionBid ?? 0) <= 1.10,
    `Expected honest BS_FALLBACK bid in [$0.95, $1.10] for +$1.12 move on $5.18 OTM 0DTE call, got $${closed.closedOptionBid}`
  );
  assert.notEqual(closed.closedOptionBid, 1.54);
});

test("4. [ CALL LOG ] & pnlAccounting reconcile optionAsk ($0.88) -> closedOptionBid ($0.93) to the penny", () => {
  const closedPos: OptionTradePosition = {
    ...makeIncidentQqqPosition(),
    status: "CLOSED",
    remainingQty: 0,
    closedAt: "12:30 PM",
    closedTs: 1795541423,
    closedSpotPrice: 638.94,
    closedOptionBid: 0.93,
    closedOptionMid: 0.93,
    exitQuoteSource: "LIVE_CHAIN_BID",
    exitReason: "MOMENTUM REVERSAL PROFIT LOCK",
    pnlSpotPct: 0.18,
    pnlOptionPct: 5.68,
  };

  const ledger = evaluatePrzmCallLedger(
    [],
    [
      { time: "12:25", timestamp: 1795541100, open: 637.6, high: 638.94, low: 637.5, close: 637.82 },
      { time: "12:30", timestamp: 1795541400, open: 637.82, high: 638.94, low: 637.8, close: 638.94 },
    ],
    638.94,
    "STAND_ASIDE",
    {
      activePositions: {},
      closedPositions: [closedPos],
      alerts: [],
      loaded: true,
    },
    "QQQ"
  );

  assert.equal(ledger.entries.length, 1);
  const row = ledger.entries[0];
  assert.equal(row.btoOptionPrice, 0.88, "[ CALL LOG ] must display entry optionAsk ($0.88), never btoOptionMid ($0.87)");
  assert.equal(row.stcOptionPrice, 0.93, "[ CALL LOG ] must display exit closedOptionBid ($0.93)");
  assert.equal(row.pnlOptionPct, 5.7, "Displayed STC % (+5.7%) must reconcile to the penny with ($0.93 - $0.88) / $0.88");
  assert.equal(row.exitQuoteSource, "LIVE_CHAIN_BID");

  const canonical = computeTradeRealizedPnl(closedPos);
  assert.equal(canonical.entryPrice, 0.88);
  assert.equal(canonical.exitPrice, 0.93);
  assert.equal(canonical.realizedDollarPnl, 5.0);
  assert.equal(canonical.pnlOptionPct, 5.7);
});

test("5. Zero Shadow Ledger blocks QQQ 636P phantom $2.43 (+182.6%) gain on adverse underlying rally ($638.99 -> $639.65)", () => {
  const sessionDate = "2026-11-24";
  const openTs = 1795545670; // 1:41:10 PM ET
  const exitTs = 1795545691; // 1:41:31 PM ET (+21s)

  const entryChain: NormalizedOptionContract[] = [
    {
      symbol: "QQQ261124P00636000",
      expiration: sessionDate,
      optionType: "P",
      strike: 636,
      openInterest: 9_000,
      volume: 24_000,
      iv: 0.24,
      delta: -0.26,
      gamma: 0.05,
      vega: 0.08,
      percentChange: 0,
      bid: 0.84,
      ask: 0.86,
      last: 0.85,
      quoteSource: "DELAYED_CBOE",
    },
  ];

  // Trigger SHADOW_FADE SHORT entry (zScore >= 1.25, compositeScore <= 18, bearish bar)
  evaluateZeroShadowTick({
    ticker: "QQQ",
    sessionDate,
    nowTsSec: openTs,
    spotPrice: 638.99,
    openPrice: 639.40,
    flowVwap: 636.80,
    sigma: 1.20,
    compositeScore: 10,
    entryLagMins: 5,
    contracts: entryChain,
  });

  const midSummary = readZeroShadowSummary("QQQ", sessionDate);
  const fadeOpen = midSummary.entriesToday.find((e) => e.mode === "SHADOW_FADE");
  assert.ok(fadeOpen, "Expected SHADOW_FADE put entry to open");
  assert.equal(fadeOpen.entryAsk, 0.86);

  // 21 seconds later, QQQ rallies AGAINST the put ($638.99 -> $639.65) while a corrupted feed reports bid=$2.43
  const corruptedChain: NormalizedOptionContract[] = [
    {
      ...entryChain[0],
      bid: 2.43,
      ask: 2.46,
      last: 2.44,
      quoteSource: "DELAYED_CBOE",
    },
  ];

  evaluateZeroShadowTick({
    ticker: "QQQ",
    sessionDate,
    nowTsSec: exitTs,
    spotPrice: 639.65,
    openPrice: 639.00,
    flowVwap: 636.90,
    sigma: 1.20,
    compositeScore: 22,
    entryLagMins: 6,
    contracts: corruptedChain,
  });

  const afterSummary = readZeroShadowSummary("QQQ", sessionDate);
  const fadeAfter = afterSummary.entriesToday.find((e) => e.id === fadeOpen.id)!;
  assert.ok(fadeAfter.currentBid < 0.86, `Adverse rally on PUT must price below entryAsk ($0.86), got $${fadeAfter.currentBid}`);
  assert.ok(fadeAfter.pnlOptionPct < 0, `Adverse rally on PUT must have negative PnL%, got ${fadeAfter.pnlOptionPct}%`);
  assert.notEqual(fadeAfter.exitReason, "SHADOW TARGET LOCK (+55%)");
  assert.notEqual(fadeAfter.exitBid, 2.43);

  assert.equal(resolveOptionsQuoteProvider({}), "DELAYED_CBOE");
  assert.equal(resolveOptionsQuoteProvider({ TRADIER_API_KEY: "test-key" }), "TRADIER_LIVE");
  assert.equal(resolveOptionsQuoteProvider({ TRADIER_ACCESS_TOKEN: "test-token" }), "TRADIER_LIVE");
  assert.equal(resolveTradierAccessToken({ TRADIER_ACCESS_TOKEN: "  tok  " }).length > 0, true);
});
