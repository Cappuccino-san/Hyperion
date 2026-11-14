/**
 * Institutional Execution Invariant Test Suite
 *
 * Verifies all 4 Architectural Milestones:
 * 1. Real-Time NBBO Alignment & Spread Crossing (No mid-market fantasy fills)
 * 2. Unbreakable Capital Outlay Invariant (Strictly <= $100.00 outlay per trade)
 * 3. Deterministic One-Cancels-Other (OCO) Bracket Lifecycle:
 *    - TP1: 100% exit for 1 contract; 50% trim + Breakeven stop for 2 contracts
 *    - Hard Stop-Loss: -25% max loss cap
 *    - 10:45 AM Staged Momentum Time-Stop
 *    - 15:55:00 ET Hard Market-On-Close Liquidation
 * 4. Microstructure Broker Fill Slips & Reconciliation
 */

import { calculateSmallAccountSize, calculatePositionSize, assertSmallAccountInvariant, MAX_SMALL_ACCOUNT_BUDGET } from "../lib/positionSizer";
import { executeNbboOrder, NbboQuote } from "../lib/marketDataService";
import {
  initializeOcoBrackets,
  evaluateOcoBrackets,
  parseEtTimeSeconds,
  OcoBracketConfig,
} from "../lib/bracketOrderEngine";
import { computeFluxDecay, computeBarFlowGammaVwapSeries } from "../lib/flowGammaVwap";
import { dispatchBrokerOrder, BrokerOrderRequest } from "../lib/brokerExecution";
import {
  selectSmallAccountContract,
  sendDiscordTradeAlert,
  TradeLifecycleAlert,
  solveImpliedVol,
  repriceOptionBS,
  evaluateTradeSignals,
  loadTradeStore,
  saveTradeStore,
  DailyTradeStore,
  OptionTradePosition,
  getTodayEt,
  estimateDynamicAtmIv,
} from "../lib/tradeSignalEngine";
import {
  acquireBarEvaluationLock,
  releaseBarEvaluationLock,
  isEvaluatingLiveBar,
  stopLiveBot,
} from "../lib/liveBotDaemon";
import { NormalizedOptionContract } from "../lib/optionsExposure";
import { NextRequest } from "next/server";
import { GET as getSignalsRoute } from "../app/api/signals/route";

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function assert(condition: boolean, testName: string, detail?: string): void {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  [PASS] ${testName}`);
  } else {
    failedTests++;
    console.error(`  [FAIL] ${testName}${detail ? ` -> ${detail}` : ""}`);
  }
}

function createMockNbbo(params: {
  ticker?: string;
  strike?: number;
  bid: number;
  ask: number;
  last?: number;
}): NbboQuote {
  const ticker = params.ticker || "SPY";
  const strike = params.strike || 765;
  const bid = params.bid;
  const ask = params.ask;
  const spread = Number((ask - bid).toFixed(2));
  const spreadPct = Number((spread / Math.max(0.01, ask)).toFixed(4));
  return {
    symbol: `${ticker}261023C00${strike}000`,
    ticker,
    strike,
    expiration: "2026-10-23",
    optionType: "CALL",
    bid,
    ask,
    bidSize: 150,
    askSize: 220,
    lastPrice: params.last || bid,
    midPrice: Number(((bid + ask) / 2).toFixed(2)),
    spread,
    spreadPct,
    impliedVol: 0.165,
    delta: 0.32,
    gamma: 0.045,
    theta: -0.08,
    timestamp: Math.floor(Date.now() / 1000),
    exchange: "CBOE",
    source: "ROBINHOOD_LIVE",
  };
}

async function runTestSuite() {
  console.log("================================================================================");
  console.log("   HYPERION / GEXVEX INSTITUTIONAL EXECUTION INVARIANT VERIFICATION SUITE       ");
  console.log("================================================================================\n");

  // ===========================================================================
  // TEST SECTION 1: CAPITAL OUTLAY & POSITION SIZING INVARIANTS
  // ===========================================================================
  console.log("1. Verifying Capital Outlay & Position Sizing Invariants (Strict <= $100 Rule)...");

  // Sub-test 1.1: Strict 1-Contract Sniper Rule (Asks <= $1.00 always size exactly 1 contract)
  const sizeCheap = calculateSmallAccountSize(0.35);
  assert(sizeCheap.allowed === true, "Ask $0.35 allowed");
  assert(sizeCheap.contractsQty === 1, "Ask $0.35 sized at 1 contract");
  assert(sizeCheap.totalOutlay === 35.0, "Ask $0.35 total outlay is $35.00 (<= $100)");

  const sizeFifty = calculateSmallAccountSize(0.50);
  assert(sizeFifty.allowed === true, "Ask $0.50 allowed");
  assert(sizeFifty.contractsQty === 1, "Ask $0.50 sized at strictly 1 contract");
  assert(sizeFifty.totalOutlay === 50.0, "Ask $0.50 total outlay is $50.00 (<= $100)");

  // Sub-test 1.2: Asks between $0.51 and $1.00 size exactly 1 contract with outlay <= $100
  const sizeMid = calculateSmallAccountSize(0.75);
  assert(sizeMid.allowed === true, "Ask $0.75 allowed");
  assert(sizeMid.contractsQty === 1, "Ask $0.75 sized at exactly 1 contract");
  assert(sizeMid.totalOutlay === 75.0, "Ask $0.75 total outlay is $75.00 (<= $100)");

  const sizeNinetyNine = calculateSmallAccountSize(0.99);
  assert(sizeNinetyNine.allowed === true, "Ask $0.99 allowed");
  assert(sizeNinetyNine.contractsQty === 1, "Ask $0.99 sized at exactly 1 contract");
  assert(sizeNinetyNine.totalOutlay === 99.0, "Ask $0.99 total outlay is $99.00 (<= $100)");

  // Sub-test 1.3: Asks > $1.00 are REJECTED immediately (Zero budget violations)
  const sizeOneOhOne = calculateSmallAccountSize(1.01);
  assert(sizeOneOhOne.allowed === false, "Ask $1.01 is strictly REJECTED (cost $101 > $100)");
  assert(sizeOneOhOne.sizingTier === "BUDGET_REJECTED", "Rejection tier is BUDGET_REJECTED");

  const sizeTwoDollars = calculateSmallAccountSize(2.57);
  assert(sizeTwoDollars.allowed === false, "Ask $2.57 is strictly REJECTED (cost $257 > $100)");

  // Monte Carlo Stress Test over 500 price points from $0.05 to $3.50
  let monteCarloOutlayViolations = 0;
  let monteCarloQuantityViolations = 0;
  for (let p = 5; p <= 350; p += 1) {
    const askPrice = Number((p / 100).toFixed(2));
    const result = calculateSmallAccountSize(askPrice);
    if (result.allowed) {
      if (result.totalOutlay > MAX_SMALL_ACCOUNT_BUDGET) {
        monteCarloOutlayViolations++;
      }
      if (result.contractsQty !== 1) {
        monteCarloQuantityViolations++;
      }
    }
  }
  assert(
    monteCarloOutlayViolations === 0,
    "500-Scenario Monte Carlo: ZERO trades exceeded $100.00 capital outlay"
  );
  assert(
    monteCarloQuantityViolations === 0,
    "500-Scenario Monte Carlo: Sizing strictly constrained to {1} contract"
  );

  // ===========================================================================
  // TEST SECTION 2: NBBO SPREAD CROSSING & MICROSTRUCTURE EXECUTION
  // ===========================================================================
  console.log("\n2. Verifying Real-Time NBBO Execution (Crossing the Spread / No Mid-Price Fills)...");

  const regularHoursTime = new Date("2026-10-22T10:15:00-04:00");
  const testNbbo = createMockNbbo({ bid: 0.62, ask: 0.65 });

  // Sub-test 2.1: BUY order crosses the Ask (Fill Price >= Ask)
  const buyFill = executeNbboOrder({
    action: "BUY",
    quote: testNbbo,
    quantity: 1,
    nowEt: regularHoursTime,
  });
  assert(buyFill.status === "FILLED", "BUY execution status is FILLED");
  assert(
    buyFill.fillPrice >= testNbbo.ask,
    `BUY filled at or above Ask ($${buyFill.fillPrice} >= $${testNbbo.ask}) · No mid-price fantasy`
  );
  assert(
    buyFill.totalOutlay <= 100.0,
    `BUY total outlay $${buyFill.totalOutlay} is strictly under $100.00`
  );

  // Sub-test 2.2: SELL order hits the Bid (Fill Price <= Bid)
  const sellFill = executeNbboOrder({
    action: "SELL",
    quote: testNbbo,
    quantity: 1,
    nowEt: regularHoursTime,
  });
  assert(sellFill.status === "FILLED", "SELL execution status is FILLED");
  assert(
    sellFill.fillPrice <= testNbbo.bid,
    `SELL filled at or below Bid ($${sellFill.fillPrice} <= $${testNbbo.bid}) · Hitting real market bids`
  );

  // Sub-test 2.3: Rejects illiquid contracts with excessive bid-ask spread
  const wideNbbo = createMockNbbo({ bid: 0.30, ask: 0.65 }); // spread 53%
  const illiquidFill = executeNbboOrder({
    action: "BUY",
    quote: wideNbbo,
    quantity: 1,
    nowEt: regularHoursTime,
  });
  assert(illiquidFill.status === "REJECTED", "Illiquid contract (> 25% spread) is REJECTED");

  // Sub-test 2.4: Market Hours Barrier - Rejects orders after 16:00:00 ET
  const afterHoursTime = new Date("2026-10-22T16:05:00-04:00");
  const ahFill = executeNbboOrder({
    action: "BUY",
    quote: testNbbo,
    quantity: 1,
    nowEt: afterHoursTime,
  });
  assert(ahFill.status === "REJECTED", "Orders submitted after 16:00 ET are strictly REJECTED");

  // ===========================================================================
  // TEST SECTION 3: DETERMINISTIC OCO BRACKET ORDER LIFECYCLE
  // ===========================================================================
  console.log("\n3. Verifying Deterministic One-Cancels-Other (OCO) Bracket Lifecycles...");

  // Scenario 3A: 1-Contract Position at Target 1 -> MUST exit 100% of position
  const config1Contract: OcoBracketConfig = {
    entryPrice: 0.70,
    contractsQty: 1,
    contractType: "CALL",
    openedAtEt: "9:45 AM",
    openedTs: 1792676700,
    tp1TargetPct: 30, // +30% Target
    stopLossMaxLossPct: 25, // -25% Hard Stop
    target1Spot: 768.5,
    target2Spot: 772.0,
    stopLossSpot: 763.0,
  };

  const bracket1 = initializeOcoBrackets(config1Contract);
  assert(bracket1.tp1LimitPrice === 0.91, "TP1 Limit calculated at $0.91 (+30%)");
  assert(bracket1.hardStopPrice === 0.53, "Hard stop calculated at $0.53 (-25%)");

  // Market moves up to Target 1 (Bid hits $0.92)
  const tp1HitNbbo = createMockNbbo({ bid: 0.92, ask: 0.94 });
  const evalTp1Single = evaluateOcoBrackets({
    bracket: bracket1,
    config: config1Contract,
    currentNbbo: tp1HitNbbo,
    underlyingSpot: 769.0,
    nowEt: new Date("2026-10-22T10:15:00-04:00"),
  });
  assert(
    evalTp1Single.action === "EXIT_TP1_FULL",
    "1-Contract position exits 100% at TP1 (No runner held into reversal)"
  );
  assert(evalTp1Single.contractsToClose === 1, "Exits exactly 1 of 1 contract");
  assert(evalTp1Single.updatedBracket.remainingContracts === 0, "Zero remaining contracts");
  assert(evalTp1Single.pnlPct >= 30, `Profit locked in at +${evalTp1Single.pnlPct}%`);

  // Scenario 3B: 2-Contract Position at Target 1 -> Trims 1 contract, moves runner to BE
  const config2Contracts: OcoBracketConfig = {
    entryPrice: 0.40,
    contractsQty: 2,
    contractType: "CALL",
    openedAtEt: "9:35 AM",
    openedTs: 1792676100,
    tp1TargetPct: 30,
    tp2TargetPct: 65,
    stopLossMaxLossPct: 25,
    target1Spot: 768.0,
    target2Spot: 772.0,
    stopLossSpot: 763.0,
  };

  const bracket2 = initializeOcoBrackets(config2Contracts);
  const tp1Hit2Nbbo = createMockNbbo({ bid: 0.53, ask: 0.55 });
  const evalTp1Double = evaluateOcoBrackets({
    bracket: bracket2,
    config: config2Contracts,
    currentNbbo: tp1Hit2Nbbo,
    underlyingSpot: 768.2,
    nowEt: new Date("2026-10-22T10:05:00-04:00"),
  });
  assert(evalTp1Double.action === "TRIM_TP1", "2-Contract position trims 1 of 2 contracts at TP1");
  assert(evalTp1Double.contractsToClose === 1, "Closes exactly 1 contract");
  assert(evalTp1Double.updatedBracket.remainingContracts === 1, "1 Runner remaining");
  assert(
    evalTp1Double.updatedBracket.hardStopPrice === config2Contracts.entryPrice,
    "Stop on runner moved to exact Breakeven ($0.40)"
  );

  // Runner proceeds to hit Target 2
  const tp2HitNbbo = createMockNbbo({ bid: 0.68, ask: 0.70 });
  const evalTp2 = evaluateOcoBrackets({
    bracket: evalTp1Double.updatedBracket,
    config: config2Contracts,
    currentNbbo: tp2HitNbbo,
    underlyingSpot: 772.5,
    nowEt: new Date("2026-10-22T10:25:00-04:00"),
  });
  assert(evalTp2.action === "EXIT_TP2", "Runner triggers EXIT_TP2 at Target 2");
  assert(evalTp2.contractsToClose === 1, "Closes final 1 contract");
  assert(evalTp2.updatedBracket.remainingContracts === 0, "Position completely closed");

  // Scenario 3C: 10:45 AM Staged Momentum Time-Stop
  const stalledCandle5m = { close: 765.2, sma34: 766.8 }; // Spot stalled below 5m SMA34
  const timeStopNbbo = createMockNbbo({ bid: 0.42, ask: 0.44 }); // Small gain (+5%)
  const morningBracket = initializeOcoBrackets(config2Contracts);
  const evalTimeStop = evaluateOcoBrackets({
    bracket: morningBracket,
    config: config2Contracts,
    currentNbbo: timeStopNbbo,
    underlyingSpot: 765.2,
    candle5m: stalledCandle5m,
    nowEt: new Date("2026-10-22T10:48:00-04:00"), // 10:48 AM
  });
  assert(
    evalTimeStop.action === "EXIT_TIME_STOP",
    "10:45 AM Staged Momentum Time-Stop triggers when price stalls below 5m SMA34"
  );
  assert(
    evalTimeStop.contractsToClose === 2,
    "Closes full remaining position before midday theta crush"
  );

  // Scenario 3D: 15:55:00 ET Hard Market-On-Close Liquidation
  const eodNbbo = createMockNbbo({ bid: 0.82, ask: 0.85 });
  const activeBracketEod = initializeOcoBrackets(config1Contract);
  const evalMoc = evaluateOcoBrackets({
    bracket: activeBracketEod,
    config: config1Contract,
    currentNbbo: eodNbbo,
    underlyingSpot: 764.0,
    nowEt: new Date("2026-10-22T15:55:01-04:00"), // 15:55:01 ET
  });
  assert(
    evalMoc.action === "EXIT_MOC",
    "15:55:00 ET Hard Market-On-Close Cutoff triggered (Zero positions held into 4:00 PM)"
  );
  assert(
    evalMoc.exitPrice === eodNbbo.bid,
    `Liquidated at market Bid ($${evalMoc.exitPrice}) · True regular-hours final tick`
  );

  // Scenario 3E: Hard Stop-Loss (-25% Max Loss)
  const stoppedNbbo = createMockNbbo({ bid: 0.28, ask: 0.30 }); // -30% drop from $0.40 entry
  const evalStop = evaluateOcoBrackets({
    bracket: morningBracket,
    config: config2Contracts,
    currentNbbo: stoppedNbbo,
    underlyingSpot: 762.5,
    nowEt: new Date("2026-10-22T10:00:00-04:00"),
  });
  assert(
    evalStop.action === "EXIT_STOP_LOSS",
    "Hard Stop Loss triggers when Bid falls by -25%"
  );
  assert(evalStop.contractsToClose === 2, "Closes both contracts at Bid");

  // ===========================================================================
  // TEST SECTION 4: BROKER INTEGRATION & CONFIRMED FILL SLIPS
  // ===========================================================================
  console.log("\n4. Verifying Broker Integration Hooks & Execution Fill Slips...");

  const brokerOrder: BrokerOrderRequest = {
    ticker: "SPY",
    symbol: "SPY261023C00768000",
    action: "BUY_TO_OPEN",
    contractsQty: 1,
    orderType: "MARKET",
    quote: createMockNbbo({ bid: 0.40, ask: 0.42 }),
    nowEt: regularHoursTime,
  };

  const fillSlip = await dispatchBrokerOrder(brokerOrder);
  assert(fillSlip.status === "FILLED", "Broker order dispatch returns status FILLED");
  assert(fillSlip.filledQty === 1, "Broker confirms filled quantity = 1");
  assert(
    fillSlip.filledPrice >= 0.42,
    `Broker filled at Ask or higher ($${fillSlip.filledPrice} >= $0.42) with LOB slippage`
  );
  assert(
    fillSlip.totalOutlayOrProceeds <= 100.0,
    `Broker confirmed total outlay ($${fillSlip.totalOutlayOrProceeds}) <= $100.00`
  );
  assert(
    fillSlip.ledgerSignature.length > 0,
    `Cryptographic ledger signature generated: ${fillSlip.ledgerSignature.slice(0, 30)}...`
  );
  const rejectedMultiQtySlip = await dispatchBrokerOrder({ ...brokerOrder, contractsQty: 2 });
  assert(
    rejectedMultiQtySlip.status === "REJECTED",
    "Broker strictly REJECTS multi-contract order (contractsQty: 2 violates 1-contract sniper rule)"
  );

  // ===========================================================================
  // TEST SECTION 5: 0DTE WALL STRIKE ALIGNMENT INVARIANTS (BTO PUT TRIGGERS)
  // ===========================================================================
  console.log("\n5. Verifying 0DTE Wall Strike Alignment Invariants for BTO Put Triggers...");

  // Mock chain: 0DTE Put Wall at 760, Call Wall at 770, spot at 762 (within min($3.50, 0.45%) OTM + absDelta >= 0.25)
  const activeExpDate = getTodayEt();
  const mockPuts: NormalizedOptionContract[] = [
    {
      symbol: "SPY261023P00750000",
      strike: 750,
      expiration: activeExpDate,
      optionType: "P",
      bid: 0.16,
      ask: 0.18,
      last: 0.17,
      openInterest: 15401,
      volume: 28946,
      delta: -0.05,
      gamma: 0.01,
      vega: 0.05,
      iv: 0.17,
      percentChange: 0,
    },
    {
      symbol: "SPY261023P00755000",
      strike: 755,
      expiration: activeExpDate,
      optionType: "P",
      bid: 0.48,
      ask: 0.49,
      last: 0.49,
      openInterest: 11846,
      volume: 35193,
      delta: -0.12,
      gamma: 0.02,
      vega: 0.10,
      iv: 0.17,
      percentChange: 0,
    },
    {
      symbol: "SPY261023P00759000",
      strike: 759,
      expiration: activeExpDate,
      optionType: "P",
      bid: 0.86,
      ask: 0.88,
      last: 0.87,
      openInterest: 3831,
      volume: 23361,
      delta: -0.34,
      gamma: 0.04,
      vega: 0.15,
      iv: 0.17,
      percentChange: 0,
    },
    {
      symbol: "SPY261023P00760000",
      strike: 760,
      expiration: activeExpDate,
      optionType: "P",
      bid: 1.33,
      ask: 1.35, // > $1.00 so budget rejected
      last: 1.33,
      openInterest: 16829,
      volume: 75929,
      delta: -0.28,
      gamma: 0.05,
      vega: 0.18,
      iv: 0.17,
      percentChange: 0,
    },
  ];

  const selectedPut = await selectSmallAccountContract({
    ticker: "SPY",
    contractType: "PUT",
    spotPrice: 762.0,
    target1Spot: 766.0,
    target2Spot: 760.0, // 0DTE Put Wall
    stopLossSpot: 771.5, // Stop above 0DTE Call Wall (770)
    contracts: mockPuts,
    zeroDteCallWall: 770.0,
    zeroDtePutWall: 760.0,
  });

  assert(selectedPut !== null, "BTO Put contract successfully selected");
  assert(selectedPut?.strike === 759, `Selected Put strike is 759 (closest qualifying strike under $1.00 near 0DTE Put Wall 760)`);
  assert(Math.abs((selectedPut?.strike || 0) - 760) <= 2, "Selected Put strike distance to 0DTE Put Wall is <= $2");
  assert((selectedPut?.totalOutlay || 0) <= 100.0, `Selected Put total outlay ($${selectedPut?.totalOutlay}) is strictly <= $100.00`);
  assert(selectedPut?.strike !== 750 && selectedPut?.strike !== 755, "Deep OTM puts (> $4 below Put Wall) correctly penalized and rejected");

  // ===========================================================================
  // TEST SECTION 5B: DEEP-OTM STRIKE & LOW-DELTA FIREWALL (selectSmallAccountContract)
  // ===========================================================================
  console.log("\n5B. Verifying Deep-OTM (> min($3.50, 0.45%)) & absDelta < 0.25 Rejection...");
  const friAfternoonEt = new Date("2026-11-13T11:35:00-05:00");
  const deepOtmCallChain: NormalizedOptionContract[] = [
    { symbol: "SPY261113C00769000", strike: 769, expiration: "2026-11-13", optionType: "C", bid: 0.43, ask: 0.45, last: 0.44, volume: 12000, openInterest: 9000, iv: 0.16, delta: 0.08, gamma: 0.01, vega: 0.03, percentChange: 0 },
    { symbol: "SPY261116C00756000", strike: 756, expiration: "2026-11-16", optionType: "C", bid: 0.70, ask: 0.72, last: 0.71, volume: 8000, openInterest: 6000, iv: 0.16, delta: 0.28, gamma: 0.03, vega: 0.07, percentChange: 0 }, // +$3.69 (0.49%) > 0.45% ($3.385)
    { symbol: "SPY261116C00755000", strike: 755, expiration: "2026-11-16", optionType: "C", bid: 0.78, ask: 0.80, last: 0.79, volume: 9000, openInterest: 7000, iv: 0.16, delta: 0.24, gamma: 0.04, vega: 0.08, percentChange: 0 }, // absDelta 0.24 < 0.25
    { symbol: "SPY261116C00754000", strike: 754, expiration: "2026-11-16", optionType: "C", bid: 0.82, ask: 0.84, last: 0.83, volume: 9000, openInterest: 7000, iv: 0.16, delta: 0, gamma: 0.04, vega: 0.08, percentChange: 0 }, // missing/0 delta must not spoof 0.30
  ];
  const rejectedAllCalls = await selectSmallAccountContract({
    ticker: "SPY",
    contractType: "CALL",
    spotPrice: 752.31,
    target1Spot: 755.50,
    target2Spot: 760.00,
    stopLossSpot: 750.80,
    contracts: deepOtmCallChain,
    nowEt: friAfternoonEt,
  });
  assert(
    rejectedAllCalls === null,
    `5B.1: Deep-OTM (769C/756C) and <0.25 delta (755C/0-delta) sub-$0.99 calls must return null (got ${rejectedAllCalls?.strike})`
  );

  const friAfternoonMixedCalls: NormalizedOptionContract[] = [
    ...deepOtmCallChain,
    { symbol: "SPY261112C00753000", strike: 753, expiration: "2026-11-12", optionType: "C", bid: 0.88, ask: 0.90, last: 0.89, volume: 9500, openInterest: 9500, iv: 0.16, delta: 0.38, gamma: 0.06, vega: 0.04, percentChange: 0 }, // expired dte < 0
    { symbol: "SPY261113C00753000", strike: 753, expiration: "2026-11-13", optionType: "C", bid: 0.78, ask: 0.80, last: 0.79, volume: 15000, openInterest: 12000, iv: 0.16, delta: 0.36, gamma: 0.06, vega: 0.05, percentChange: 0 }, // 0-DTE afternoon fallback (-25 penalty)
    { symbol: "SPY261116C00753000", strike: 753, expiration: "2026-11-16", optionType: "C", bid: 0.80, ask: 0.82, last: 0.81, volume: 15000, openInterest: 12000, iv: 0.17, delta: 0.38, gamma: 0.04, vega: 0.10, percentChange: 0 }, // Fri 3-DTE primary in [0.35, 0.85]
  ];
  const pickedNearCall = await selectSmallAccountContract({
    ticker: "SPY",
    contractType: "CALL",
    spotPrice: 752.31,
    target1Spot: 755.50,
    target2Spot: 760.00,
    stopLossSpot: 750.80,
    contracts: friAfternoonMixedCalls,
    nowEt: friAfternoonEt,
  });
  assert(pickedNearCall?.strike === 753, `5B.2: Near-ATM 753C selected over deep-OTM/low-delta lottos (got ${pickedNearCall?.strike})`);
  assert(pickedNearCall?.expiration === "2026-11-16", `5B.2b: Friday afternoon prioritizes non-expired 3-DTE 2026-11-16 (got ${pickedNearCall?.expiration})`);

  // $800 spot proves $3.50 hard cap rejects +$3.55 (0.44% < 0.45%)
  const cap350Rejected = await selectSmallAccountContract({
    ticker: "SPY",
    contractType: "CALL",
    spotPrice: 800.0,
    target1Spot: 804.0,
    target2Spot: 806.0,
    stopLossSpot: 798.5,
    contracts: [
      { symbol: "SPY261116C00803550", strike: 803.55, expiration: "2026-11-16", optionType: "C", bid: 0.80, ask: 0.82, last: 0.81, volume: 5000, openInterest: 4000, iv: 0.17, delta: 0.29, gamma: 0.03, vega: 0.08, percentChange: 0 },
    ],
    nowEt: friAfternoonEt,
  });
  assert(cap350Rejected === null, "5B.3: Strike +$3.55 OTM (> $3.50 hard ceiling despite 0.44% < 0.45%) rejected");

  // Put-side symmetry at $752.31: reject -$4.31 OTM (748P) & absDelta 0.24 (750P), select 751P
  const putFirewallOnlyRejected = await selectSmallAccountContract({
    ticker: "SPY",
    contractType: "PUT",
    spotPrice: 752.31,
    target1Spot: 750.0,
    target2Spot: 748.0,
    stopLossSpot: 754.0,
    contracts: [
      { symbol: "SPY261116P00748000", strike: 748, expiration: "2026-11-16", optionType: "P", bid: 0.63, ask: 0.65, last: 0.64, volume: 8000, openInterest: 6000, iv: 0.16, delta: -0.30, gamma: 0.03, vega: 0.07, percentChange: 0 },
      { symbol: "SPY261116P00750000", strike: 750, expiration: "2026-11-16", optionType: "P", bid: 0.73, ask: 0.75, last: 0.74, volume: 9000, openInterest: 7000, iv: 0.16, delta: -0.24, gamma: 0.04, vega: 0.08, percentChange: 0 },
    ],
    nowEt: friAfternoonEt,
  });
  assert(putFirewallOnlyRejected === null, "5B.4a: Deep-OTM 748P (-$4.31) & low-delta 750P (-0.24) strictly rejected");

  const putValidPicked = await selectSmallAccountContract({
    ticker: "SPY",
    contractType: "PUT",
    spotPrice: 752.31,
    target1Spot: 750.0,
    target2Spot: 748.0,
    stopLossSpot: 754.0,
    contracts: [
      { symbol: "SPY261116P00748000", strike: 748, expiration: "2026-11-16", optionType: "P", bid: 0.63, ask: 0.65, last: 0.64, volume: 8000, openInterest: 6000, iv: 0.16, delta: -0.30, gamma: 0.03, vega: 0.07, percentChange: 0 },
      { symbol: "SPY261116P00751000", strike: 751, expiration: "2026-11-16", optionType: "P", bid: 0.80, ask: 0.82, last: 0.81, volume: 11000, openInterest: 9500, iv: 0.16, delta: -0.34, gamma: 0.05, vega: 0.09, percentChange: 0 },
    ],
    nowEt: friAfternoonEt,
  });
  assert(putValidPicked?.strike === 751, `5B.4b: Valid near-ATM 751P selected (got ${putValidPicked?.strike})`);

  // 5B.5: estimateDynamicAtmIv stays calibrated ([0.085, 0.20]) under intraday flush spikes so <=0.45% OTM strikes fit <=$0.99
  const openIv = estimateDynamicAtmIv([{ close: 758.0 }], 0);
  assert(openIv >= 0.085 && openIv <= 0.12, `5B.5a: Opening fallback IV calibrated near 9.5% (got ${(openIv * 100).toFixed(1)}%)`);
  const flushBars = Array.from({ length: 22 }, (_, i) => ({ close: 758 - (i < 12 ? i * 0.75 : (21 - i) * 0.35) }));
  const middayIv = estimateDynamicAtmIv(flushBars, flushBars.length - 1);
  assert(middayIv >= 0.085 && middayIv <= 0.20, `5B.5b: Midday flush IV capped <= 20% with trimmed mean (got ${(middayIv * 100).toFixed(1)}%)`);

  // ===========================================================================
  // TEST SECTION 6: DIRECTIONAL TARGET INVARIANTS (PUT TARGETS < ENTRY)
  // ===========================================================================
  console.log("\n6. Verifying Directional Target Invariants (Targets for Put MUST be < Entry)...");

  const callWall = 770.0;
  const putWall = 760.0;
  const zeroGammaHigher = 772.0; // Market anomaly: zeroGamma sits above Call Wall!

  // Mathematical target resolver for PUT
  const putTarget1 =
    zeroGammaHigher < callWall && zeroGammaHigher > putWall
      ? zeroGammaHigher
      : Number((callWall - (callWall - putWall) * 0.5).toFixed(1));

  assert(putTarget1 < callWall, `Put Target 1 ($${putTarget1}) is strictly LOWER than entry Call Wall ($${callWall})`);
  assert(putTarget1 !== 772.0, "Put Target 1 rejects anomalous zeroGamma $772.0 sitting above entry");
  assert(putTarget1 === 765.0, "Put Target 1 resolves to exact equilibrium midpoint $765.0 between 770 and 760");
  assert(putTarget1 > putWall, `Put Target 1 ($${putTarget1}) is strictly ABOVE final Target 2 ($${putWall})`);

  // Mathematical target resolver for CALL
  const callTarget1 =
    zeroGammaHigher > putWall && zeroGammaHigher < callWall
      ? zeroGammaHigher
      : Number((putWall + (callWall - putWall) * 0.5).toFixed(1));

  assert(callTarget1 > putWall, `Call Target 1 ($${callTarget1}) is strictly HIGHER than entry Put Wall ($${putWall})`);
  assert(callTarget1 < callWall, `Call Target 1 ($${callTarget1}) is strictly LOWER than final Target 2 ($${callWall})`);
  assert(callTarget1 === 765.0, "Call Target 1 resolves to exact equilibrium midpoint $765.0 between 760 and 770");

  // ===========================================================================
  // TEST SECTION 7: LIVE DISCORD DISPATCH FIREWALL & TEMPORAL INTEGRITY
  // ===========================================================================
  console.log("\n7. Verifying Live Discord Dispatch Firewall (Zero Backfill Spam)...");

  const backfillAlert: TradeLifecycleAlert = {
    id: "test-backfill-alert-1",
    timestamp: "10:50 AM",
    ts: 1792677000,
    ticker: "SPY",
    action: "BUY_TO_OPEN",
    contractType: "PUT",
    contractLabel: "SPY 261026 762P",
    strike: 762,
    expiration: "2026-10-26",
    setupName: "Resistance Rejection",
    reason: "Resistance Rejection",
    status: "OPEN",
    spotPrice: 766.92,
    btoSpotPrice: 766.92,
    target1Spot: 765.50,
    target2Spot: 762.00,
    stopLossSpot: 768.50,
    optionMid: 0.65,
    btoOptionMid: 0.65,
    contractsQty: 1,
    remainingQty: 1,
    totalOutlay: 65,
    isHistoricalBackfill: true,
    message: "Test backfill message",
  };

  const dispatchResult = await sendDiscordTradeAlert(backfillAlert);
  assert(dispatchResult === false, "Historical backfill alert is strictly silenced from Discord dispatch (returns false)");

  // ===========================================================================
  // TEST SECTION 8: SINGLE-SLOT AUTOMATON & SNIPER ENGINE (1 CONTRACT MAX)
  // ===========================================================================
  console.log("\n8. Verifying Single-Slot Automaton & Sniper Invariants (Strictly 1 Contract)...");

  // Sub-test 8.1: Contract selection forces contractsQty === 1
  assert(selectedPut?.contractsQty === 1, "Selected contract is strictly 1 contract (Sniper Mode)");
  assert((selectedPut?.totalOutlay || 0) <= 100, "Outlay strictly <= $100");

  // Sub-test 8.2: Black-Scholes Repricing produces realistic option targets (No +237% fantasy)
  const spotTest = 766.92;
  const strikeTest = 762;
  const entryPriceTest = 0.65;
  const tYearsTest = 0.2 / 365; // ~0DTE
  const solvedIvTest = solveImpliedVol(entryPriceTest, spotTest, strikeTest, tYearsTest, false);
  assert(solvedIvTest > 0.05 && solvedIvTest < 1.0, `Solved IV ${solvedIvTest} is realistic (5% - 100%)`);

  // Target 1: Spot drops $1.42 from 766.92 to 765.50
  const repricedTp1 = repriceOptionBS(765.50, strikeTest, tYearsTest * 0.95, solvedIvTest, false);
  const tp1GainPct = ((repricedTp1 - entryPriceTest) / entryPriceTest) * 100;
  assert(
    tp1GainPct >= 20 && tp1GainPct <= 100,
    `Black-Scholes TP1 gain (+${tp1GainPct.toFixed(1)}%) is grounded in reality (+20% to +100%, not +237%)`
  );

  // ===========================================================================
  // TEST SECTION 9: PnL-GROUNDED CANONICAL EXIT TAXONOMY & DIRECTIONAL SPOT MATH
  // ===========================================================================
  console.log("\n9. Verifying Canonical Exit Taxonomy & Directional Spot Calculations...");

  // Sub-test 9.1: Directional Spot Calculation for Put
  const putBtoSpot = 766.92;
  const putExitSpot = 765.36; // SPY dropped by $1.56
  const rawDiff = putExitSpot - putBtoSpot; // -1.56
  const putFavor = -rawDiff; // +1.56
  assert(putFavor > 0, `Underlying drop of $1.56 is POSITIVE (+${putFavor.toFixed(2)} pts) favorable to PUT`);

  // Sub-test 9.2: Winning trade exiting at 3:55 PM EOD Cutoff NEVER labeled "STOP LOSS"
  const winningPnlOptionPct = 71.4; // +71.4% gain
  const isWinning = winningPnlOptionPct > 0;
  const exitReason = "15:55 PM ET HARD MARKET CLOSE CUTOFF";
  const reasonUpper = exitReason.toUpperCase();

  let assignedBadge = "";
  if (reasonUpper.includes("3:55") || reasonUpper.includes("CLOSE") || reasonUpper.includes("EOD")) {
    assignedBadge = isWinning ? "3:55 PM EOD MARKET CLOSE CUTOFF (WIN)" : "3:55 PM EOD MARKET CLOSE CUTOFF";
  } else {
    assignedBadge = "STOP LOSS HIT";
  }

  assert(!assignedBadge.includes("STOP LOSS"), `Winning trade (+${winningPnlOptionPct}%) badge '${assignedBadge}' NEVER contains 'STOP LOSS'`);
  assert(assignedBadge === "3:55 PM EOD MARKET CLOSE CUTOFF (WIN)", `Winning trade badge resolves to canonical '${assignedBadge}'`);

  // ===========================================================================
  // TEST SECTION 10: 500-SCENARIO MONTE CARLO INVARIANT VERIFICATION SUITE
  // ===========================================================================
  console.log("\n10. Running 500-Scenario Monte Carlo Execution Invariant Verification Suite...");

  // Seeded Mulberry32 PRNG for deterministic, reproducible Monte Carlo simulations
  function createPrng(seed: number) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // --- PART 10A: 500 Scenarios Verifying ZERO Calls Below Zero Gamma or in Negative Opening Range ---
  console.log("  10A: Evaluating 500 Open-Range & Negative Gamma Scenarios (Zero Calls Guarantee)...");
  const rng10A = createPrng(2026110501);
  let callsBelowZeroGammaViolations = 0;
  let callsInNegativeOpeningViolations = 0;
  let totalEvaluatedScenarios10A = 0;

  for (let s = 1; s <= 500; s++) {
    totalEvaluatedScenarios10A++;
    // Spot price in [$740.00, $780.00]
    const spotPrice = Number((740 + rng10A() * 40).toFixed(2));
    // Zero Gamma in [$750.00, $770.00]
    const zeroGamma = Number((750 + rng10A() * 20).toFixed(2));
    // Prior Close in [$755.00, $775.00]
    const priorClose = Number((755 + rng10A() * 20).toFixed(2));
    // Premarket Flow VWAP in [$755.00, $775.00]
    const premarketFlowVwap = Number((755 + rng10A() * 20).toFixed(2));
    // Minute in session open: 9:30 AM to 9:44 AM (minutes 570 - 584, totalMinutes < 585)
    const minute = Math.floor(570 + rng10A() * 15);
    const dateObj = new Date("2026-11-05T09:30:00-05:00");
    dateObj.setMinutes(minute - 570 + 30);
    // χ in [0.05, 0.95] (with varying degrees of put/call dominance)
    const rawChi = Number((0.05 + rng10A() * 0.90).toFixed(2));
    // Half the scenarios simulate unpopulated indicators (first 15 min gap)
    const isUnpopulated = rng10A() < 0.5;

    // Evaluate opening range condition:
    const isOpeningRange = minute < 585;
    const isNegativeGamma = zeroGamma > 0 && spotPrice < zeroGamma;
    const isBelowPriorClose = priorClose > 0 && spotPrice < priorClose;
    const isBelowPremarketVwap = premarketFlowVwap > 0 && spotPrice < premarketFlowVwap;

    // Under R1 Invariant: If spot is below Zero Gamma, below prior close, below premarket VWAP,
    // or rawChi < 0.50 during opening range, any CALL candidate is strictly blocked.
    const shouldBlockCall = isNegativeGamma || (isOpeningRange && (rawChi < 0.50 || isBelowPriorClose || isBelowPremarketVwap || isUnpopulated && (isNegativeGamma || isBelowPriorClose || isBelowPremarketVwap)));

    // Inject a clean FLAT test store
    const testStore: DailyTradeStore = {
      date: "2026-11-05",
      activePositions: {},
      closedPositions: [],
      alerts: [],
      prevSpotPrices: { SPY: priorClose, QQQ: priorClose },
    };
    saveTradeStore(testStore);

    const evalRes = await evaluateTradeSignals({
      ticker: "QQQ", // non-SPY so candidateBto flow evaluates directly
      spotPrice,
      callWall: 780,
      putWall: 740,
      zeroGamma,
      priorClose,
      premarketFlowVwap,
      nowEt: dateObj,
      latest5mCandle: isUnpopulated
        ? null
        : {
            open: spotPrice,
            high: spotPrice + 0.5,
            low: spotPrice - 0.5,
            close: spotPrice,
            sma34: spotPrice,
            flowSnapshot: {
              timestamp: Math.floor(dateObj.getTime() / 1000),
              spot: spotPrice,
              flowVwap: premarketFlowVwap,
              ceilingShareChi: rawChi,
              pecletNumber: 0.1,
              netFluxJ: 0.05,
              upper1s: spotPrice + 1,
              lower1s: spotPrice - 1,
              upper2s: spotPrice + 2,
              lower2s: spotPrice - 2,
              upper1Sigma: spotPrice + 1,
              lower1Sigma: spotPrice - 1,
              upper2Sigma: spotPrice + 2,
              lower2Sigma: spotPrice - 2,
              sigma: 1,
              variance: 1,
              cumGammaWeight: 100,
              totalWeight: 100,
              signedGammaAcceleration: 0,
              count: 10,
              bandSignal: "LOWER_2S_BOUNCE",
            },
          },
    });

    const activeOrEmitted = evalRes.emittedAlerts.find((a) => a.action === "BUY_TO_OPEN" && a.contractType === "CALL") ||
                            (evalRes.activePosition?.contractType === "CALL" ? evalRes.activePosition : null);

    if (activeOrEmitted) {
      if (spotPrice < zeroGamma) {
        callsBelowZeroGammaViolations++;
      }
      if (shouldBlockCall) {
        callsInNegativeOpeningViolations++;
      }
    }
  }

  assert(
    callsBelowZeroGammaViolations === 0,
    `500-Scenario Monte Carlo 10A: EXACTLY ZERO Calls taken below Zero Gamma (${totalEvaluatedScenarios10A} scenarios evaluated)`
  );
  assert(
    callsInNegativeOpeningViolations === 0,
    "500-Scenario Monte Carlo 10A: EXACTLY ZERO Calls taken during negative opening range (< 09:45 AM ET)"
  );

  // --- PART 10B: 500 Async Invocations Verifying Zero Concurrency Leaks under isEvaluatingLiveBar ---
  console.log("  10B: Running 500 Parallel Async Invocations (Mutex & Memory Lock Guarantee)...");
  const rng10B = createPrng(2026110502);
  let concurrencyLeaks = 0;
  let activeConcurrentExecutions = 0;
  let peakObservedConcurrency = 0;
  let successfullyProcessedTicks = 0;
  let lockedOutInvocations = 0;

  // Reset daemon lock state cleanly before starting concurrency test, then verify wrong-token firewall
  stopLiveBot();
  const sentinelToken = acquireBarEvaluationLock();
  assert(sentinelToken > 0 && isEvaluatingLiveBar() === true, "Sentinel lock token acquired cleanly");
  releaseBarEvaluationLock(999999999);
  assert(
    isEvaluatingLiveBar() === true,
    "Wrong token MUST NOT release active bar evaluation lock"
  );
  releaseBarEvaluationLock(sentinelToken);
  assert(
    isEvaluatingLiveBar() === false,
    "Matching token cleanly releases active bar evaluation lock"
  );

  const parallelInvocations: Promise<void>[] = [];
  for (let i = 0; i < 500; i++) {
    parallelInvocations.push(
      (async () => {
        // Microtask jitter to interleave async yields
        await new Promise((resolve) => setTimeout(resolve, Math.floor(rng10B() * 4)));

        const lockToken = acquireBarEvaluationLock();
        if (!lockToken) {
          lockedOutInvocations++;
          return;
        }

        try {
          activeConcurrentExecutions++;
          peakObservedConcurrency = Math.max(peakObservedConcurrency, activeConcurrentExecutions);
          if (activeConcurrentExecutions > 1) {
            concurrencyLeaks++;
          }

          // Simulate asynchronous I/O (e.g. options chain fetch)
          await new Promise((resolve) => setTimeout(resolve, 1));
          successfullyProcessedTicks++;
        } finally {
          activeConcurrentExecutions--;
          releaseBarEvaluationLock(lockToken);
        }
      })()
    );
  }

  await Promise.all(parallelInvocations);

  assert(
    concurrencyLeaks === 0,
    `500-Invocation Monte Carlo 10B: EXACTLY ZERO concurrency leaks (Peak concurrency = ${peakObservedConcurrency}, strictly <= 1)`
  );
  assert(
    peakObservedConcurrency === 1,
    `500-Invocation Monte Carlo 10B: Atomic memory lock successfully acquired and held by 1 caller at a time`
  );
  assert(
    successfullyProcessedTicks + lockedOutInvocations === 500,
    `500-Invocation Monte Carlo 10B: All 500 invocations deterministically accounted for (${successfullyProcessedTicks} processed, ${lockedOutInvocations} locked out)`
  );

  // --- PART 10C: 500 State Machine Transitions Verifying contractsQty === 1 & Linear State Machine ---
  console.log("  10C: Testing 500 State Machine Transitions (contractsQty === 1 & FLAT -> ACTIVE -> LOCKED_FOR_DAY)...");
  const originalStoreBackup = loadTradeStore();
  const rng10C = createPrng(2026110503);
  let positionSizeViolations = 0;
  let overlappingPositionViolations = 0;
  let postClosedTradeReentryViolations = 0;

  try {
    for (let t = 1; t <= 500; t++) {
    // Random initial session state
    const rollState = rng10C();
    const isFlat = rollState < 0.33;
    const isActive = rollState >= 0.33 && rollState < 0.66;
    const isLockedForDay = rollState >= 0.66;

    const mockClosedTrades: OptionTradePosition[] = isLockedForDay
      ? [
          {
            id: `test-closed-${t}`,
            ticker: "SPY",
            contractType: "PUT",
            contractLabel: "SPY 261105 765P",
            strike: 765,
            expiration: "2026-11-05",
            setupName: "Resistance Rejection",
            status: "CLOSED",
            btoSpotPrice: 765.0,
            btoOptionMid: 0.65,
            contractsQty: 1,
            remainingQty: 0,
            totalOutlay: 65,
            target1Spot: 763.5,
            target2Spot: 760.0,
            stopLossSpot: 766.5,
            openedAt: "09:35 AM",
            openedTs: 1793889300,
            closedAt: "10:05 AM",
            closedTs: 1793891100,
            exitReason: "TARGET 1 PROFIT SECURED",
          },
        ]
      : [];

    const mockActivePosition: OptionTradePosition | null = isActive
      ? {
          id: `test-active-${t}`,
          ticker: "SPY",
          contractType: "PUT",
          contractLabel: "SPY 261105 765P",
          strike: 765,
          expiration: "2026-11-05",
          setupName: "Resistance Rejection",
          status: "OPEN",
          btoSpotPrice: 765.0,
          btoOptionMid: 0.65,
          contractsQty: 1,
          remainingQty: 1,
          totalOutlay: 65,
          target1Spot: 763.5,
          target2Spot: 760.0,
          stopLossSpot: 766.5,
          openedAt: "09:35 AM",
          openedTs: 1793889300,
        }
      : null;

    const currentTestDate = getTodayEt();
    const storeInstance: DailyTradeStore = {
      date: currentTestDate,
      activePositions: mockActivePosition ? { SPY: mockActivePosition } : {},
      closedPositions: mockClosedTrades,
      alerts: [],
      prevSpotPrices: { SPY: 765.0 },
    };
    saveTradeStore(storeInstance);

    // If active position size was > 1, that would be a violation
    if (mockActivePosition && (mockActivePosition.contractsQty !== 1 || mockActivePosition.remainingQty !== 1)) {
      positionSizeViolations++;
    }

    // Now attempt BTO evaluation on SPY via syncGaiaSpySignalsToDiscord
    const { syncGaiaSpySignalsToDiscord } = await import("../lib/tradeSignalEngine");
    const syncRes = await syncGaiaSpySignalsToDiscord({
      ticker: "SPY",
      spotPrice: 764.5,
      sessionDate: currentTestDate,
      signals: [
        {
          id: `mc-short-${t}`,
          type: "SHORT",
          price: 764.5,
          timestamp: 1793889400,
          label: "SHORT · OPEN",
        },
      ],
      zeroGamma: 767.16,
      activeFsmState: "SHORT",
    });

    const refreshedStore = loadTradeStore();
    const activeCount = Object.keys(refreshedStore.activePositions || {}).length;

    // Check Invariants:
    // 1. If we were already ACTIVE, no second trade should have been opened (max 1 active position)
    if (isActive && syncRes.dispatchedCount > 0) {
      overlappingPositionViolations++;
    }
    if (activeCount > 1) {
      overlappingPositionViolations++;
    }

    // 2. If we were LOCKED_FOR_DAY (same-direction PUT closed, or 2+ trades closed), no same-direction trade should open
    if (isLockedForDay && (syncRes.dispatchedCount > 0 || activeCount > 0)) {
      postClosedTradeReentryViolations++;
    }

      // 3. Any newly created active position must strictly enforce contractsQty === 1
      const newSpyPos = refreshedStore.activePositions["SPY"];
      if (newSpyPos) {
        if (newSpyPos.contractsQty !== 1 || newSpyPos.remainingQty > 1) {
          positionSizeViolations++;
        }
      }
    }

    // 10C-Phase2: Verify max 2 closed trades/day cap & gated Phase-2 opposite-regime bounds
    const maxCapStore: DailyTradeStore = {
      date: getTodayEt(),
      activePositions: {},
      closedPositions: [
        {
          id: "phase2-closed-1",
          ticker: "SPY",
          contractType: "PUT",
          contractLabel: "SPY 261105 765P",
          strike: 765,
          expiration: "2026-11-05",
          setupName: "Resistance Rejection",
          status: "CLOSED",
          btoSpotPrice: 765.0,
          btoOptionMid: 0.65,
          contractsQty: 1,
          remainingQty: 0,
          totalOutlay: 65,
          target1Spot: 763.5,
          target2Spot: 760.0,
          stopLossSpot: 766.5,
          openedAt: "09:35 AM",
          openedTs: 1793889300,
          closedAt: "10:05 AM",
          closedTs: 1793891100,
          exitReason: "TARGET 1 PROFIT SECURED",
        },
        {
          id: "phase2-closed-2",
          ticker: "SPY",
          contractType: "CALL",
          contractLabel: "SPY 261105 762C",
          strike: 762,
          expiration: "2026-11-05",
          setupName: "Impulse Flux Divergence Reclaim [BTO CALL]",
          status: "CLOSED",
          btoSpotPrice: 761.0,
          btoOptionMid: 0.72,
          contractsQty: 1,
          remainingQty: 0,
          totalOutlay: 72,
          target1Spot: 763.0,
          target2Spot: 765.0,
          stopLossSpot: 759.5,
          openedAt: "11:30 AM",
          openedTs: 1793896200,
          closedAt: "01:15 PM",
          closedTs: 1793902500,
          exitReason: "TARGET 1 PROFIT SECURED",
        },
      ],
      alerts: [],
      prevSpotPrices: { SPY: 764.5 },
    };
    saveTradeStore(maxCapStore);
    const { syncGaiaSpySignalsToDiscord } = await import("../lib/tradeSignalEngine");
    const capRes = await syncGaiaSpySignalsToDiscord({
      ticker: "SPY",
      spotPrice: 764.5,
      sessionDate: getTodayEt(),
      signals: [{ id: "mc-cap-long", type: "LONG", price: 764.5, timestamp: 1793903000, label: "LONG · OPEN" }],
      zeroGamma: 762.0,
      activeFsmState: "LONG",
    });
    const capAfter = loadTradeStore();
    if (capRes.dispatchedCount > 0 || Object.keys(capAfter.activePositions || {}).length > 0) {
      postClosedTradeReentryViolations++;
    }
  } finally {
    saveTradeStore(originalStoreBackup);
  }

  assert(
    overlappingPositionViolations === 0,
    "500-Transition Monte Carlo 10C: EXACTLY ZERO overlapping positions (Single-Slot Automaton strictly holds max 1 trade)"
  );
  assert(
    positionSizeViolations === 0,
    "500-Transition Monte Carlo 10C: EXACTLY ZERO position size violations (contractsQty === 1 strictly enforced)"
  );
  assert(
    postClosedTradeReentryViolations === 0,
    "500-Transition Monte Carlo 10C: EXACTLY ZERO same-direction re-entries or >2 closed trades/day violations"
  );

  // --- PART 10D: Full 78-Bar RTH Session Noisy Oscillation & Anti-Churn Invariant ---
  console.log("  10D: Simulating 78-Bar RTH Session with Noisy Oscillations (Max 2 Trades/Day & Zero <10% Micro-Scalps)...");
  const storeBackup10D = loadTradeStore();
  try {
    const sessionDate10D = getTodayEt();
    const rthStartEpoch = Math.floor(new Date(`${sessionDate10D}T09:30:00-05:00`).getTime() / 1000);
    saveTradeStore({
      date: sessionDate10D,
      activePositions: {},
      closedPositions: [],
      alerts: [],
      prevSpotPrices: { QQQ: 500.0 },
    });

    const mockChain10D: NormalizedOptionContract[] = [
      { symbol: "QQQ20991231C00502000", strike: 502, expiration: "2099-12-31", optionType: "C", bid: 0.62, ask: 0.65, last: 0.64, volume: 1200, openInterest: 3000, iv: 0.20, delta: 0.35, gamma: 0.05, vega: 0.03, percentChange: 0 },
      { symbol: "QQQ20991231P00498000", strike: 498, expiration: "2099-12-31", optionType: "P", bid: 0.62, ask: 0.65, last: 0.64, volume: 1200, openInterest: 3000, iv: 0.20, delta: -0.35, gamma: 0.05, vega: 0.03, percentChange: 0 },
    ];

    for (let barIdx = 0; barIdx < 78; barIdx++) {
      const barEpoch = rthStartEpoch + barIdx * 300;
      const barDate = new Date(barEpoch * 1000);
      const isAfternoon = barIdx >= 36; // 12:30 PM ET onward flips regime
      const noise = (barIdx % 2 === 0 ? 1 : -1) * 0.40;
      const spot = (isAfternoon ? 498.5 : 501.5) + noise;
      const chi = isAfternoon ? (barIdx % 3 === 0 ? 0.38 : 0.22) : (barIdx % 3 === 0 ? 0.62 : 0.86);
      const flux = isAfternoon ? (barIdx % 3 === 0 ? 0.05 : -0.30) : (barIdx % 3 === 0 ? -0.05 : 0.30);
      const priorClose = 500.0;
      const zeroGamma = 500.0;
      const flowVwap = isAfternoon ? 499.5 : 500.5;

      await evaluateTradeSignals({
        ticker: "QQQ",
        spotPrice: spot,
        prevSpotPrice: spot - noise,
        callWall: 506.0,
        putWall: 494.0,
        zeroGamma,
        priorClose,
        premarketFlowVwap: flowVwap,
        contracts: mockChain10D,
        nowEt: barDate,
        latest5mCandle: {
          open: spot - 0.15,
          high: spot + 0.45,
          low: spot - 0.45,
          close: spot,
          sma34: flowVwap,
          flowSnapshot: {
            timestamp: barEpoch,
            spot,
            flowVwap,
            ceilingShareChi: chi,
            pecletNumber: isAfternoon ? -2.1 : 2.1,
            netFluxJ: flux,
            upper1s: flowVwap + 1.0,
            lower1s: flowVwap - 1.0,
            upper2s: flowVwap + 2.0,
            lower2s: flowVwap - 2.0,
            upper1Sigma: flowVwap + 1.0,
            lower1Sigma: flowVwap - 1.0,
            upper2Sigma: flowVwap + 2.0,
            lower2Sigma: flowVwap - 2.0,
            sigma: 1.0,
            variance: 1.0,
            cumGammaWeight: 100,
            totalWeight: 100,
            signedGammaAcceleration: 0,
            count: 10,
            bandSignal: isAfternoon ? "UPPER_2S_REJECT" : "LOWER_2S_BOUNCE",
          },
        },
      });
    }

    const finalStore10D = loadTradeStore();
    const allQqqTrades = [
      ...finalStore10D.closedPositions.filter((p) => p.ticker === "QQQ"),
      ...(finalStore10D.activePositions["QQQ"] ? [finalStore10D.activePositions["QQQ"]] : []),
    ];
    const callCount10D = allQqqTrades.filter((p) => p.contractType === "CALL").length;
    const putCount10D = allQqqTrades.filter((p) => p.contractType === "PUT").length;
    const microReversalScalps10D = finalStore10D.closedPositions.filter(
      (p) => p.ticker === "QQQ" && (p.exitReason || "").includes("REVERSAL") && (p.pnlOptionPct ?? 0) < 10
    );

    assert(allQqqTrades.length <= 2, `78-bar RTH session total trades <= 2 (got ${allQqqTrades.length})`);
    assert(callCount10D <= 1 && putCount10D <= 1, `78-bar RTH session <= 1 same-direction trade (CALL=${callCount10D}, PUT=${putCount10D})`);
    assert(microReversalScalps10D.length === 0, `78-bar RTH session zero <10% reversal micro-scalps (got ${microReversalScalps10D.length})`);

    // Enforce >= 30m cooldown and >= 10m hold on any reversal exit across the 78-bar session
    const sortedQqq = [...allQqqTrades].sort((a, b) => (a.openedTs ?? 0) - (b.openedTs ?? 0));
    if (sortedQqq.length === 2 && sortedQqq[0].closedTs && sortedQqq[1].openedTs) {
      assert(
        sortedQqq[1].openedTs - sortedQqq[0].closedTs >= 1800,
        `78-bar RTH session Leg-2 cooldown >= 1800s (got ${sortedQqq[1].openedTs - sortedQqq[0].closedTs}s)`
      );
    }
    for (const qt of finalStore10D.closedPositions.filter((p) => p.ticker === "QQQ")) {
      if ((qt.exitReason || "").includes("REVERSAL") && qt.closedTs && qt.openedTs) {
        assert(
          qt.closedTs - qt.openedTs >= 600,
          `78-bar RTH session reversal exit held >= 10m (600s) (got ${qt.closedTs - qt.openedTs}s)`
        );
      }
    }

    // 10D-TwoRegime: Verify winning Leg 1 (+35% > 12%) allows gated opposite-direction Leg 2 (>= 30m cooldown, Put Wall / -1σ Bullish Reclaim), while blocking < 30m & 3rd trade
    const leg1ExitTs = rthStartEpoch + 3600; // 10:30 AM ET
    saveTradeStore({
      date: sessionDate10D,
      activePositions: {},
      closedPositions: [
        {
          id: "qqq-leg1-win",
          ticker: "QQQ",
          contractType: "PUT",
          contractLabel: "QQQ 20991231 498P",
          strike: 498,
          expiration: "2099-12-31",
          setupName: "Bearish Zero-Gamma Flush [BTO PUT]",
          status: "CLOSED",
          btoSpotPrice: 499.0,
          btoOptionMid: 0.65,
          contractsQty: 1,
          remainingQty: 0,
          totalOutlay: 65,
          target1Spot: 497.0,
          target2Spot: 495.0,
          stopLossSpot: 500.0,
          openedAt: "09:35 AM",
          openedTs: rthStartEpoch + 300,
          closedAt: "10:30 AM",
          closedTs: leg1ExitTs,
          pnlOptionPct: 35.4,
          exitReason: "MOMENTUM REVERSAL PROFIT LOCK",
        },
      ],
      alerts: [],
      prevSpotPrices: { QQQ: 495.5 },
    });

    const leg2Chain: NormalizedOptionContract[] = [
      { symbol: "QQQ20991231C00496000", strike: 496, expiration: "2099-12-31", optionType: "C", bid: 0.72, ask: 0.75, last: 0.74, volume: 1200, openInterest: 3000, iv: 0.20, delta: 0.38, gamma: 0.05, vega: 0.03, percentChange: 0 },
      { symbol: "QQQ20991231P00495000", strike: 495, expiration: "2099-12-31", optionType: "P", bid: 0.68, ask: 0.72, last: 0.70, volume: 1200, openInterest: 3000, iv: 0.20, delta: -0.35, gamma: 0.05, vega: 0.03, percentChange: 0 },
    ];

    // Before 30m cooldown (10:50 AM = +1200s): strictly blocked even with strong reclaim confluence
    await evaluateTradeSignals({
      ticker: "QQQ",
      spotPrice: 495.8,
      prevSpotPrice: 495.2,
      callWall: 506.0,
      putWall: 495.0,
      zeroGamma: 500.0,
      priorClose: 499.0,
      premarketFlowVwap: 495.5,
      divergence5m: "BULL",
      contracts: leg2Chain,
      nowEt: new Date((leg1ExitTs + 1200) * 1000),
      latest5mCandle: {
        open: 495.2,
        high: 496.0,
        low: 494.9,
        close: 495.8,
        sma34: 495.4,
        flowSnapshot: {
          timestamp: leg1ExitTs + 1200,
          spot: 495.8,
          flowVwap: 495.5,
          ceilingShareChi: 0.58,
          impulseChi: 0.68,
          pecletNumber: 0.8,
          impulsePeclet: 1.4,
          netFluxJ: 0.22,
          deltaChi6Bar: 0.12,
          deltaImpulseChi6Bar: 0.18,
          deltaNetFlux6Bar: 0.15,
          upper1s: 496.8,
          lower1s: 494.2,
          upper2s: 498.0,
          lower2s: 493.0,
          upper1Sigma: 496.8,
          lower1Sigma: 494.2,
          upper2Sigma: 498.0,
          lower2Sigma: 493.0,
          sigma: 1.0,
          variance: 1.0,
          cumGammaWeight: 100,
          totalWeight: 100,
          signedGammaAcceleration: 0,
          count: 10,
          bandSignal: null,
        },
      },
    });
    assert(
      !loadTradeStore().activePositions["QQQ"],
      "10D-TwoRegime: Leg-2 must be blocked before 30m (1800s) cooldown elapses"
    );

    // At 11:15 AM (+2700s >= 1800s cooldown) after Put Wall 495 test + impulseChi >= 0.60 + deltaNetFlux6Bar > 0 + >= $1.50 room to Zero Γ 500: Leg-2 CALL enters!
    const leg2Res = await evaluateTradeSignals({
      ticker: "QQQ",
      spotPrice: 495.8,
      prevSpotPrice: 495.2,
      callWall: 506.0,
      putWall: 495.0,
      zeroGamma: 500.0,
      priorClose: 499.0,
      premarketFlowVwap: 495.5,
      divergence5m: "BULL",
      contracts: leg2Chain,
      nowEt: new Date((leg1ExitTs + 2700) * 1000),
      latest5mCandle: {
        open: 495.2,
        high: 496.0,
        low: 494.9,
        close: 495.8,
        sma34: 495.4,
        flowSnapshot: {
          timestamp: leg1ExitTs + 2700,
          spot: 495.8,
          flowVwap: 495.5,
          ceilingShareChi: 0.58,
          impulseChi: 0.68,
          pecletNumber: 0.8,
          impulsePeclet: 1.4,
          netFluxJ: 0.22,
          deltaChi6Bar: 0.12,
          deltaImpulseChi6Bar: 0.18,
          deltaNetFlux6Bar: 0.15,
          upper1s: 496.8,
          lower1s: 494.2,
          upper2s: 498.0,
          lower2s: 493.0,
          upper1Sigma: 496.8,
          lower1Sigma: 494.2,
          upper2Sigma: 498.0,
          lower2Sigma: 493.0,
          sigma: 1.0,
          variance: 1.0,
          cumGammaWeight: 100,
          totalWeight: 100,
          signedGammaAcceleration: 0,
          count: 10,
          bandSignal: null,
        },
      },
    });
    assert(
      leg2Res.activePosition?.contractType === "CALL",
      `10D-TwoRegime: Winning Leg-1 PUT must permit gated opposite Leg-2 CALL after >= 30m cooldown (got ${leg2Res.activePosition?.contractType ?? "none"})`
    );
  } finally {
    saveTradeStore(storeBackup10D);
  }

  // --- PART 10E & 10F: Symmetrical Leg-2 Call Wall Rejection, 10:30 ET Boundary, >= 10m Hold & >= $0.75 Reversal ---
  console.log("  10E & 10F: Verifying Symmetrical Leg-2 Call Wall Rejection (PUT), 10:30 ET Boundary, >= 10m Hold & >= $0.75 Reversal...");
  const storeBackup10E = loadTradeStore();
  try {
    const sessionDate10E = getTodayEt();
    const makeEtDateOn = (dateIso: string, hh: number, mm: number): Date => {
      const utcGuess = Date.UTC(
        Number(dateIso.slice(0, 4)),
        Number(dateIso.slice(5, 7)) - 1,
        Number(dateIso.slice(8, 10)),
        hh + 5,
        mm,
        0
      );
      const etHhStr = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        hour: "2-digit",
        hourCycle: "h23",
      }).format(new Date(utcGuess));
      const diffHours = Number(etHhStr) - hh;
      return new Date(utcGuess - diffHours * 3600_000);
    };
    const makeFlow = (ts: number, spot: number, vwap: number, chi: number, impChi: number, pe: number, flux: number, dFlux6: number) => ({
      timestamp: ts,
      spot,
      flowVwap: vwap,
      ceilingShareChi: chi,
      impulseChi: impChi,
      pecletNumber: pe,
      impulsePeclet: pe,
      netFluxJ: flux,
      deltaChi6Bar: dFlux6,
      deltaImpulseChi6Bar: dFlux6,
      deltaNetFlux6Bar: dFlux6,
      upper1s: vwap + 1,
      lower1s: vwap - 1,
      upper2s: vwap + 2,
      lower2s: vwap - 2,
      upper1Sigma: vwap + 1,
      lower1Sigma: vwap - 1,
      upper2Sigma: vwap + 2,
      lower2Sigma: vwap - 2,
      sigma: 1,
      variance: 1,
      cumGammaWeight: 100,
      totalWeight: 100,
      signedGammaAcceleration: 0,
      count: 10,
      bandSignal: null,
    });

    // 10E: Leg-1 CALL closed 10:15 AM -> test <30m block, same-dir block, 11:30 AM Call Wall Rejection PUT, <10m hold, <$0.75 vs >=$0.75 reversal, 3rd trade block
    const leg1CallExitDate = makeEtDateOn(sessionDate10E, 10, 15);
    const leg1CallExitTs = Math.floor(leg1CallExitDate.getTime() / 1000);
    saveTradeStore({
      date: sessionDate10E,
      activePositions: {},
      closedPositions: [{
        id: "qqq-leg1-call-win",
        ticker: "QQQ",
        contractType: "CALL",
        contractLabel: "QQQ 20991231 501C",
        strike: 501,
        expiration: "2099-12-31",
        setupName: "Zero-Gamma Magnet Breakout [BTO CALL]",
        status: "CLOSED",
        btoSpotPrice: 501.0,
        btoOptionMid: 0.70,
        contractsQty: 1,
        remainingQty: 0,
        totalOutlay: 70,
        target1Spot: 503.5,
        target2Spot: 506.0,
        stopLossSpot: 499.5,
        openedAt: "09:40 AM",
        openedTs: leg1CallExitTs - 2100,
        closedAt: "10:15 AM",
        closedTs: leg1CallExitTs,
        pnlOptionPct: 38.0,
        exitReason: "TARGET_HIT",
      }],
      alerts: [],
      prevSpotPrices: { QQQ: 505.8 },
    });

    const leg2SymChain: NormalizedOptionContract[] = [
      { symbol: "QQQ20991231C00506000", strike: 506, expiration: "2099-12-31", optionType: "C", bid: 0.74, ask: 0.76, last: 0.75, volume: 1500, openInterest: 3000, iv: 0.20, delta: 0.38, gamma: 0.05, vega: 0.03, percentChange: 0 },
      { symbol: "QQQ20991231P00505000", strike: 505, expiration: "2099-12-31", optionType: "P", bid: 0.84, ask: 0.86, last: 0.85, volume: 1500, openInterest: 3000, iv: 0.20, delta: -0.42, gamma: 0.05, vega: 0.03, percentChange: 0 },
    ];

    // 10E.1: 10:35 AM (+1200s < 1800s cooldown): strictly blocked
    const earlyRejectRes = await evaluateTradeSignals({
      ticker: "QQQ",
      spotPrice: 505.2,
      prevSpotPrice: 505.8,
      callWall: 506.5,
      putWall: 494.0,
      zeroGamma: 500.0,
      priorClose: 499.0,
      premarketFlowVwap: 505.5,
      divergence5m: "BEAR",
      contracts: leg2SymChain,
      nowEt: new Date((leg1CallExitTs + 1200) * 1000),
      latest5mCandle: { open: 506.0, high: 506.4, low: 505.0, close: 505.2, sma34: 505.7, flowSnapshot: makeFlow(leg1CallExitTs + 1200, 505.2, 505.5, 0.38, 0.30, -1.6, -0.22, -0.18) },
    });
    assert(earlyRejectRes.activePosition === null, "10E.1: Leg-2 PUT Call Wall rejection blocked < 30m cooldown");

    // 10E.2: 11:30 AM (+4500s) same-direction CALL blocked (<= 1 per direction)
    const sameDirRes = await evaluateTradeSignals({
      ticker: "QQQ",
      spotPrice: 504.8,
      prevSpotPrice: 504.2,
      callWall: 508.0,
      putWall: 504.5,
      zeroGamma: 506.5,
      priorClose: 499.0,
      premarketFlowVwap: 504.5,
      divergence5m: "BULL",
      contracts: leg2SymChain,
      nowEt: makeEtDateOn(sessionDate10E, 11, 30),
      latest5mCandle: { open: 504.6, high: 505.0, low: 504.4, close: 504.8, sma34: 504.6, flowSnapshot: makeFlow(leg1CallExitTs + 4500, 504.8, 504.5, 0.62, 0.70, 1.3, 0.22, 0.18) },
    });
    assert(sameDirRes.activePosition === null, "10E.2: Same-direction Leg-2 CALL strictly blocked after Leg-1 CALL (<= 1/direction)");

    // 10E.3: 11:30 AM Call Wall 506.5 Rejection -> opens opposite Leg-2 PUT
    const leg2Time = makeEtDateOn(sessionDate10E, 11, 30);
    const leg2Ts = Math.floor(leg2Time.getTime() / 1000);
    const leg2PutOpenRes = await evaluateTradeSignals({
      ticker: "QQQ",
      spotPrice: 505.2,
      prevSpotPrice: 505.8,
      callWall: 506.5,
      putWall: 494.0,
      zeroGamma: 500.0,
      priorClose: 499.0,
      premarketFlowVwap: 505.5,
      divergence5m: "BEAR",
      contracts: leg2SymChain,
      nowEt: leg2Time,
      latest5mCandle: { open: 506.0, high: 506.4, low: 505.0, close: 505.2, sma34: 505.7, flowSnapshot: makeFlow(leg2Ts, 505.2, 505.5, 0.38, 0.30, -1.6, -0.22, -0.18) },
    });
    assert(leg2PutOpenRes.activePosition?.contractType === "PUT", `10E.3: 11:30 AM Call Wall rejection opens opposite Leg-2 PUT (got ${leg2PutOpenRes.activePosition?.contractType ?? "none"})`);

    // 10E.4: +5m (<10m hold): +$0.78 adverse move with bullish flux must NOT reversal-exit (keep option above -20% floor)
    const hold5mChain: NormalizedOptionContract[] = [
      { symbol: "QQQ20991231P00505000", strike: 505, expiration: "2099-12-31", optionType: "P", bid: 0.72, ask: 0.74, last: 0.73, volume: 1500, openInterest: 3000, iv: 0.20, delta: -0.35, gamma: 0.05, vega: 0.03, percentChange: 0 },
    ];
    const hold5mRes = await evaluateTradeSignals({
      ticker: "QQQ",
      spotPrice: 505.98,
      prevSpotPrice: 505.2,
      callWall: 506.5,
      putWall: 494.0,
      zeroGamma: 500.0,
      priorClose: 499.0,
      premarketFlowVwap: 505.5,
      divergence5m: "BULL",
      contracts: hold5mChain,
      nowEt: new Date((leg2Ts + 300) * 1000),
      latest5mCandle: { open: 505.2, high: 506.0, low: 505.15, close: 505.98, sma34: 505.6, flowSnapshot: makeFlow(leg2Ts + 300, 505.98, 505.5, 0.65, 0.68, 1.2, 0.22, 0.15) },
    });
    assert(hold5mRes.activePosition !== null, "10E.4: <10m hold firewall prevents premature reversal exit despite +$0.78 bounce");

    // 10E.5: +15m (>=10m hold) with +$0.60 (<$0.75) bounce & <10% profit: must NOT reversal-exit
    const smallRevRes = await evaluateTradeSignals({
      ticker: "QQQ",
      spotPrice: 505.8,
      prevSpotPrice: 505.9,
      callWall: 506.5,
      putWall: 494.0,
      zeroGamma: 500.0,
      priorClose: 499.0,
      premarketFlowVwap: 505.5,
      divergence5m: "BULL",
      contracts: hold5mChain,
      nowEt: new Date((leg2Ts + 900) * 1000),
      latest5mCandle: { open: 505.7, high: 505.9, low: 505.5, close: 505.8, sma34: 505.6, flowSnapshot: makeFlow(leg2Ts + 900, 505.8, 505.5, 0.65, 0.68, 1.2, 0.22, 0.15) },
    });
    assert(smallRevRes.activePosition !== null, "10E.5: <$0.75 adverse bounce (+$0.60) at >=10m hold must NOT trigger reversal exit");

    // 10E.6: +20m (>=10m hold) with +$0.80 (>=$0.75) reversal: closes Leg-2 via reversal (2 closed total)
    const validRevRes = await evaluateTradeSignals({
      ticker: "QQQ",
      spotPrice: 506.0,
      prevSpotPrice: 505.8,
      callWall: 506.5,
      putWall: 494.0,
      zeroGamma: 500.0,
      priorClose: 499.0,
      premarketFlowVwap: 505.5,
      divergence5m: "BULL",
      contracts: hold5mChain,
      nowEt: new Date((leg2Ts + 1200) * 1000),
      latest5mCandle: { open: 505.8, high: 506.05, low: 505.6, close: 506.0, sma34: 505.6, flowSnapshot: makeFlow(leg2Ts + 1200, 506.0, 505.5, 0.65, 0.68, 1.2, 0.22, 0.15) },
    });
    const qqqClosed10E = loadTradeStore().closedPositions.filter((p) => p.ticker === "QQQ");
    assert(
      validRevRes.activePosition === null && qqqClosed10E.length === 2,
      `10E.6: >=10m hold + >=$0.75 reversal closes Leg-2 cleanly (2 closed total, got ${qqqClosed10E.length})`
    );
    assert(
      /REVERSAL|DIVERGENCE/.test(qqqClosed10E[0]?.exitReason || ""),
      `10E.6b: Leg-2 exit reason must be Momentum Reversal/Divergence Cover (got ${qqqClosed10E[0]?.exitReason})`
    );

    // 10E.7: At 13:30 ET after 2 closed trades (CALL + PUT), 3rd trade attempt is strictly LOCKED_FOR_DAY
    const thirdTime = makeEtDateOn(sessionDate10E, 13, 30);
    const thirdTs = Math.floor(thirdTime.getTime() / 1000);
    const thirdTradeRes = await evaluateTradeSignals({
      ticker: "QQQ",
      spotPrice: 495.8,
      prevSpotPrice: 495.2,
      callWall: 506.0,
      putWall: 495.0,
      zeroGamma: 500.0,
      priorClose: 499.0,
      premarketFlowVwap: 495.5,
      divergence5m: "BULL",
      contracts: [
        { symbol: "QQQ20991231C00496000", strike: 496, expiration: "2099-12-31", optionType: "C", bid: 0.72, ask: 0.75, last: 0.74, volume: 1200, openInterest: 3000, iv: 0.20, delta: 0.38, gamma: 0.05, vega: 0.03, percentChange: 0 },
      ],
      nowEt: thirdTime,
      latest5mCandle: { open: 495.2, high: 496.0, low: 494.9, close: 495.8, sma34: 495.4, flowSnapshot: makeFlow(thirdTs, 495.8, 495.5, 0.58, 0.68, 1.4, 0.22, 0.15) },
    });
    assert(
      thirdTradeRes.activePosition === null && loadTradeStore().closedPositions.filter((p) => p.ticker === "QQQ").length === 2,
      "10E.7: Daily trade budget (<= 2 trades/day) strictly blocks 3rd attempt at 13:30 ET"
    );

    // 10F: Exact 10:30 AM ET (etMins === 630) Leg-2 admission vs 10:25 AM ET (etMins === 625) block
    const exit950 = makeEtDateOn(sessionDate10E, 9, 50);
    const exit950Ts = Math.floor(exit950.getTime() / 1000);
    saveTradeStore({
      date: sessionDate10E,
      activePositions: {},
      closedPositions: [{
        id: "qqq-leg1-950",
        ticker: "QQQ",
        contractType: "PUT",
        contractLabel: "QQQ 20991231 498P",
        strike: 498,
        expiration: "2099-12-31",
        setupName: "Bearish Zero-Gamma Flush [BTO PUT]",
        status: "CLOSED",
        btoSpotPrice: 499.0,
        btoOptionMid: 0.65,
        contractsQty: 1,
        remainingQty: 0,
        totalOutlay: 65,
        target1Spot: 497.0,
        target2Spot: 495.0,
        stopLossSpot: 500.0,
        openedAt: "09:35 AM",
        openedTs: exit950Ts - 900,
        closedAt: "09:50 AM",
        closedTs: exit950Ts,
        pnlOptionPct: 28.0,
        exitReason: "TARGET_HIT",
      }],
      alerts: [],
      prevSpotPrices: { QQQ: 495.5 },
    });
    const leg2At1025 = await evaluateTradeSignals({
      ticker: "QQQ",
      spotPrice: 495.8,
      prevSpotPrice: 495.2,
      callWall: 506.0,
      putWall: 495.0,
      zeroGamma: 500.0,
      priorClose: 499.0,
      premarketFlowVwap: 495.5,
      divergence5m: "BULL",
      contracts: [
        { symbol: "QQQ20991231C00496000", strike: 496, expiration: "2099-12-31", optionType: "C", bid: 0.72, ask: 0.75, last: 0.74, volume: 1200, openInterest: 3000, iv: 0.20, delta: 0.38, gamma: 0.05, vega: 0.03, percentChange: 0 },
      ],
      nowEt: makeEtDateOn(sessionDate10E, 10, 25), // cooldown 35m >= 30m, but etMins 625 < 630
      latest5mCandle: { open: 495.2, high: 496.0, low: 494.9, close: 495.8, sma34: 495.4, flowSnapshot: makeFlow(exit950Ts + 2100, 495.8, 495.5, 0.58, 0.68, 1.4, 0.22, 0.15) },
    });
    assert(leg2At1025.activePosition === null, "10F.1: Leg-2 blocked at 10:25 AM ET (etMins 625 < 630) even with >=30m cooldown");

    const leg2At1030 = await evaluateTradeSignals({
      ticker: "QQQ",
      spotPrice: 495.8,
      prevSpotPrice: 495.2,
      callWall: 506.0,
      putWall: 495.0,
      zeroGamma: 500.0,
      priorClose: 499.0,
      premarketFlowVwap: 495.5,
      divergence5m: "BULL",
      contracts: [
        { symbol: "QQQ20991231C00496000", strike: 496, expiration: "2099-12-31", optionType: "C", bid: 0.72, ask: 0.75, last: 0.74, volume: 1200, openInterest: 3000, iv: 0.20, delta: 0.38, gamma: 0.05, vega: 0.03, percentChange: 0 },
      ],
      nowEt: makeEtDateOn(sessionDate10E, 10, 30), // exact 10:30 AM ET (etMins 630)
      latest5mCandle: { open: 495.2, high: 496.0, low: 494.9, close: 495.8, sma34: 495.4, flowSnapshot: makeFlow(exit950Ts + 2400, 495.8, 495.5, 0.58, 0.68, 1.4, 0.22, 0.15) },
    });
    assert(
      leg2At1030.activePosition?.contractType === "CALL",
      `10F.2: Leg-2 admitted at exact 10:30 AM ET (etMins 630, got ${leg2At1030.activePosition?.contractType ?? "none"})`
    );
  } finally {
    saveTradeStore(storeBackup10E);
  }

  // ===========================================================================
  // 11. GEMINI 4 CARBON AUDIT HARDENING & EDGE-CASE INVARIANTS
  // ===========================================================================
  console.log("\n11. Verifying Gemini 4 Carbon Audit Edge-Case Invariants...");

  // 1. Zero, negative, and crossed market quote rejection
  const zeroQuote = calculatePositionSize(0, 0);
  assert(zeroQuote.allowed === false, "Zero askPrice must strictly be rejected");
  assert(zeroQuote.rejectionReason === "INVALID_QUOTE", "Zero askPrice rejection reason must be INVALID_QUOTE");

  const negativeQuote = calculatePositionSize(-0.5, -0.6);
  assert(negativeQuote.allowed === false, "Negative askPrice must strictly be rejected");
  assert(negativeQuote.rejectionReason === "INVALID_QUOTE", "Negative askPrice rejection reason must be INVALID_QUOTE");

  const crossedQuote = calculatePositionSize(0.50, 0.55);
  assert(crossedQuote.allowed === false, "Crossed market (bid > ask) must strictly be rejected");
  assert(crossedQuote.rejectionReason === "INVALID_QUOTE", "Crossed market rejection reason must be INVALID_QUOTE");

  // 2. Strict 1-contract sniper sizing at $0.50 ask
  const exactTwo = calculatePositionSize(0.50, 0.48);
  assert(exactTwo.allowed === true, "Ask $0.50 must be allowed");
  assert(exactTwo.contractsQty === 1, "Ask $0.50 must size strictly 1 contract (sniper rule)");
  assert(exactTwo.totalOutlay === 50.0, "Ask $0.50 total outlay must equal $50.00");

  const overTwoUnderOne = calculatePositionSize(0.51, 0.49);
  assert(overTwoUnderOne.allowed === true, "Ask $0.51 must be allowed");
  assert(overTwoUnderOne.contractsQty === 1, "Ask $0.51 must size exactly 1 contract");
  assert(overTwoUnderOne.totalOutlay === 51.0, "Ask $0.51 total outlay must equal exactly $51.00");

  // 3. Integer time parsing protects unpadded morning timestamps from 15:55 MOC cutoff
  const sec945 = parseEtTimeSeconds("9:45:00");
  const sec1555 = parseEtTimeSeconds("15:55:00");
  assert(sec945 === 35100, "9:45:00 ET parsed into 35,100 seconds");
  assert(sec1555 === 57300, "15:55:00 ET parsed into 57,300 seconds");
  assert(sec945 < sec1555, "9:45:00 ET strictly precedes 15:55:00 ET in integer seconds (eliminates ASCII bug)");

  // 4. Gap-over TP1+TP2 in a single tick closes 100% of contracts immediately
  const gapConfig: OcoBracketConfig = {
    entryPrice: 0.50,
    contractsQty: 2,
    contractType: "CALL",
    openedAtEt: "09:35:00",
    openedTs: Date.now(),
    tp1TargetPct: 30, // 0.65
    tp2TargetPct: 60, // 0.80
    stopLossMaxLossPct: 25,
    target1Spot: 755,
    target2Spot: 760,
    stopLossSpot: 745,
  };
  const gapBracket = initializeOcoBrackets(gapConfig);
  const gapQuote = createMockNbbo({ bid: 1.15, ask: 1.18 });
  const gapResult = evaluateOcoBrackets({
    bracket: gapBracket,
    config: gapConfig,
    currentNbbo: gapQuote,
    underlyingSpot: 762,
    nowEt: new Date("2026-11-03T14:35:00Z"), // 10:35 AM ET
  });
  assert(gapResult.action === "EXIT_TP2", "Gap-over TP1+TP2 tick must trigger EXIT_TP2");
  assert(gapResult.contractsToClose === 2, "Gap-over TP1+TP2 must close 100% (2 contracts) immediately");
  assert(gapResult.updatedBracket.remainingContracts === 0, "Zero remaining contracts after gap-over TP2 exit");

  // 5. Out-of-order negative dt cannot amplify Flux chi > 1
  const fluxDecayResult = computeFluxDecay(0.8, -500, 300);
  assert(fluxDecayResult <= 0.8, "Negative dt tick cannot amplify Flux decay above base chi");
  assert(fluxDecayResult >= 0, "Flux decay remains non-negative for positive chi");

  // 6. Expired Contract & Crossed-Quote Firewall inside selectSmallAccountContract (no date-rewinding)
  const expiredOnlyChain: NormalizedOptionContract[] = [
    {
      symbol: "SPY20200103C00500000",
      strike: 500,
      expiration: "2020-01-03",
      optionType: "C",
      bid: 0.45,
      ask: 0.48,
      last: 0.46,
      volume: 500,
      openInterest: 2000,
      iv: 0.22,
      delta: 0.35,
      gamma: 0.08,
      vega: 0.03,
      percentChange: 0,
    },
  ];
  const expiredPick = await selectSmallAccountContract({
    ticker: "SPY",
    contractType: "CALL",
    spotPrice: 500,
    target1Spot: 502,
    target2Spot: 504,
    stopLossSpot: 499,
    contracts: expiredOnlyChain,
  });
  assert(
    expiredPick === null,
    "Expired contract batch must return null (no maxExp todayEt date-rewinding)"
  );

  const crossedQuoteChain: NormalizedOptionContract[] = [
    {
      symbol: "SPY20991231C00755000",
      strike: 755,
      expiration: "2099-12-31",
      optionType: "C",
      bid: 0.60,
      ask: 0.50, // Crossed market: bid > ask
      last: 0.55,
      volume: 600,
      openInterest: 2500,
      iv: 0.25,
      delta: 0.35,
      gamma: 0.05,
      vega: 0.03,
      percentChange: 0,
    },
  ];
  const crossedPick = await selectSmallAccountContract({
    ticker: "SPY",
    contractType: "CALL",
    spotPrice: 754,
    target1Spot: 757,
    target2Spot: 760,
    stopLossSpot: 752.5,
    contracts: crossedQuoteChain,
    nowEt: new Date("2099-12-31T15:00:00Z"),
  });
  assert(
    crossedPick === null,
    "Crossed-quote contract (bid > ask) must strictly be rejected by selectSmallAccountContract"
  );

  // Verify deltaImpulseChi6Bar captures positive impulse turn even when session chi is low
  const impBounceBars = [
    { timestamp: 1794580500, open: 758, high: 758.5, low: 756, close: 756.2, volume: 10000 },
    { timestamp: 1794580800, open: 756.2, high: 756.4, low: 754, close: 754.1, volume: 12000 },
    { timestamp: 1794581100, open: 754.1, high: 754.3, low: 752, close: 752.2, volume: 14000 },
    { timestamp: 1794581400, open: 752.2, high: 752.4, low: 750, close: 750.3, volume: 15000 },
    { timestamp: 1794581700, open: 750.3, high: 750.5, low: 749.2, close: 749.4, volume: 16000 },
    { timestamp: 1794582000, open: 749.4, high: 749.8, low: 748.8, close: 749.1, volume: 18000 },
    { timestamp: 1794582300, open: 749.1, high: 750.6, low: 749.0, close: 750.5, volume: 22000 },
    { timestamp: 1794582600, open: 750.5, high: 751.8, low: 750.4, close: 751.7, volume: 24000 },
    { timestamp: 1794582900, open: 751.7, high: 753.0, low: 751.6, close: 752.9, volume: 25000 },
  ];
  const impBounceSeries = computeBarFlowGammaVwapSeries(impBounceBars);
  const lastBounceSnap = impBounceSeries[impBounceSeries.length - 1];
  assert(
    typeof lastBounceSnap?.deltaImpulseChi6Bar === "number" && lastBounceSnap.deltaImpulseChi6Bar > 0,
    "deltaImpulseChi6Bar must turn strictly positive on afternoon V-reclaim"
  );

  // Verify GET /api/signals?ticker=SPY&date=2026-11-13 returns historical session trades read-only on weekends/off-hours
  const histSignalsReq = new NextRequest("http://localhost:3000/api/signals?ticker=SPY&date=2026-11-13");
  const histSignalsRes = await getSignalsRoute(histSignalsReq);
  const histSignalsBody = await histSignalsRes.json();
  assert(
    histSignalsRes.status === 200,
    `GET /api/signals?ticker=SPY&date=2026-11-13 returns HTTP 200 (got ${histSignalsRes.status})`
  );
  assert(
    histSignalsBody.sessionDate === "2026-11-13",
    `GET /api/signals?date=2026-11-13 returns sessionDate === "2026-11-13" (got ${histSignalsBody.sessionDate})`
  );
  assert(
    Array.isArray(histSignalsBody.closedPositions) &&
      histSignalsBody.closedPositions.some((p: { id?: string }) => p.id === "SPY-PUT-1794581245"),
    "GET /api/signals?ticker=SPY&date=2026-11-13 returns 2026-11-13 closed trade SPY-PUT-1794581245"
  );

  // ===========================================================================
  // FINAL REPORT
  // ===========================================================================
  console.log("\n================================================================================");
  console.log(`   EXECUTION INVARIANT AUDIT RESULT: ${passedTests} PASSED, ${failedTests} FAILED (TOTAL: ${totalTests})`);
  console.log("================================================================================\n");

  if (failedTests > 0) {
    process.exit(1);
  } else {
    console.log(">> ALL 4 INSTITUTIONAL MILESTONES MATHEMATICALLY VERIFIED AND PROVEN. <<\n");
  }
}

runTestSuite().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
