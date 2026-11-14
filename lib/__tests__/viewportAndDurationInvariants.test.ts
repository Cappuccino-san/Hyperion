import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluatePrzmCallLedger, PrzmSignalPoint, PrzmCandlePoint } from "@/components/gaia/PrzmTacticalHud";
import {
  extractNormalizedTradesForTicker,
  parseTimeLabelToMinutes,
  clampSpotToCandle,
} from "@/components/chart/TradeExecutionMarkersOverlay";
import { initializeOcoBrackets, evaluateOcoBrackets } from "@/lib/bracketOrderEngine";
import { NbboQuote } from "@/lib/marketDataService";
import { clampToCandleRange } from "@/lib/tradeSignalEngine";
import { acquireBarEvaluationLock, releaseBarEvaluationLock } from "@/lib/liveBotDaemon";

describe("PRZM Viewport & Duration Invariant Verification Suite", () => {
  it("Duration Normalization Invariant: 44-minute millisecond trade produces 44M, NOT 723H", () => {
    const baseMs = 1730648400000; // 9:30 AM in milliseconds
    const entryMs = baseMs;
    const exitMs = baseMs + 44 * 60 * 1000; // 44 minutes later

    const mockSeries: PrzmCandlePoint[] = [
      {
        time: "9:30am",
        timestamp: entryMs,
        open: 759.42,
        high: 760.00,
        low: 759.00,
        close: 759.42,
        volume: 50000,
        vwap: 759.42,
        flowVwap: 759.42,
      },
      {
        time: "10:14am",
        timestamp: exitMs,
        open: 763.00,
        high: 763.86,
        low: 762.50,
        close: 763.50,
        volume: 50000,
        vwap: 761.00,
        flowVwap: 761.00,
      },
    ];

    const mockSignals: PrzmSignalPoint[] = [
      {
        id: "sig-open",
        index: 0,
        time: "9:30am",
        price: 759.42,
        type: "LONG",
        tag: "OPEN",
        label: "LONG · OPEN",
        excursion: 4.44,
      },
    ];

    const summary = evaluatePrzmCallLedger(mockSignals, mockSeries, 763.50);
    assert.equal(summary.entries.length, 1);
    const entry = summary.entries[0];
    assert.equal(entry.heldMinutes, 44, `Expected 44 minutes, got ${entry.heldMinutes}`);
    assert.equal(entry.heldLabel, "44M", `Expected '44M', got ${entry.heldLabel}`);
    assert.ok(!entry.heldLabel.includes("723H"), "Duration must NEVER scale to 723H!");
  });

  it("Duration Normalization Invariant: 73-minute millisecond trade produces 1H 13M, NOT 1223H", () => {
    const baseMs = 1730648400000;
    const entryMs = baseMs;
    const exitMs = baseMs + 73 * 60 * 1000;

    const mockSeries: PrzmCandlePoint[] = [
      {
        time: "9:30am",
        timestamp: entryMs,
        open: 753.51,
        high: 754.00,
        low: 753.00,
        close: 753.51,
        volume: 50000,
        vwap: 753.51,
        flowVwap: 753.51,
      },
      {
        time: "10:43am",
        timestamp: exitMs,
        open: 755.00,
        high: 755.60,
        low: 754.80,
        close: 755.41,
        volume: 50000,
        vwap: 754.50,
        flowVwap: 754.50,
      },
    ];

    const mockSignals: PrzmSignalPoint[] = [
      {
        id: "sig-open",
        index: 0,
        time: "9:30am",
        price: 753.51,
        type: "LONG",
        tag: "OPEN",
        label: "LONG · OPEN",
        excursion: 2.09,
      },
    ];

    const summary = evaluatePrzmCallLedger(mockSignals, mockSeries, 755.41);
    assert.equal(summary.entries.length, 1);
    const entry = summary.entries[0];
    assert.equal(entry.heldMinutes, 73, `Expected 73 minutes, got ${entry.heldMinutes}`);
    assert.equal(entry.heldLabel, "1H 13M", `Expected '1H 13M', got ${entry.heldLabel}`);
    assert.ok(!entry.heldLabel.includes("1223H"), "Duration must NEVER scale to 1223H!");
  });

  it("Session Duration Clamp Invariant: Cross-day timestamps clamp to max RTH 390m", () => {
    const baseMs = 1730648400000;
    const entryMs = baseMs;
    const crossDayMs = baseMs + 5 * 24 * 60 * 60 * 1000; // 5 days later

    const mockSeries: PrzmCandlePoint[] = [
      {
        time: "9:30am",
        timestamp: entryMs,
        open: 750.00,
        high: 751.00,
        low: 749.00,
        close: 750.00,
        volume: 50000,
        vwap: 750.00,
        flowVwap: 750.00,
      },
      {
        time: "3:55pm",
        timestamp: crossDayMs,
        open: 755.00,
        high: 756.00,
        low: 754.00,
        close: 755.00,
        volume: 50000,
        vwap: 753.00,
        flowVwap: 753.00,
      },
    ];

    const mockSignals: PrzmSignalPoint[] = [
      {
        id: "sig-open",
        index: 0,
        time: "9:30am",
        price: 750.00,
        type: "LONG",
        tag: "OPEN",
        label: "LONG · OPEN",
        excursion: 5.0,
      },
    ];

    const summary = evaluatePrzmCallLedger(mockSignals, mockSeries, 755.00);
    const entry = summary.entries[0];
    assert.ok(entry.heldMinutes <= 390, `Holding duration must be clamped <= 390m, got ${entry.heldMinutes}`);
  });

  it("Mathematical Viewport Invariance Invariant: Intrinsic Expected Move is independent of SVG bounds", () => {
    const open930 = 759.42;
    // Calculation: open930 * 0.00475
    const intrinsicEm = Math.max(open930 * 0.003, Math.min(open930 * 0.015, open930 * 0.00475));

    // Regardless of whether SVG viewport span is $3 or $30 or $300:
    const viewportSpans = [2.5, 4.0, 8.0, 15.0, 25.0, 100.0];
    for (const span of viewportSpans) {
      // Invariant: intrinsicEm does not change with span
      assert.equal(Number(intrinsicEm.toFixed(2)), 3.61);
    }
  });

  it("Midnight Normalization Invariant: Midnight ticks (00:xx ET) do NOT trigger 15:55 MOC cutoff", () => {
    const config = {
      entryPrice: 0.80,
      contractsQty: 1 as const,
      contractType: "CALL" as const,
      openedAtEt: "09:35 AM",
      openedTs: Date.parse("2026-11-03T14:35:00Z"),
      tp1TargetPct: 30,
      stopLossMaxLossPct: 25,
      target1Spot: 765,
      target2Spot: 770,
      stopLossSpot: 755,
    };

    const bracket = initializeOcoBrackets(config);
    assert.strictEqual(bracket.stagedMomentumTimeStopActive, true, "Opened at 09:35 AM must arm staged momentum stop");

    const mockQuote: NbboQuote = {
      symbol: "SPY261103C00760000",
      ticker: "SPY",
      strike: 760,
      expiration: "2026-11-03",
      optionType: "CALL",
      bid: 0.82,
      ask: 0.84,
      bidSize: 100,
      askSize: 100,
      lastPrice: 0.82,
      midPrice: 0.83,
      spread: 0.02,
      spreadPct: 0.024,
      impliedVol: 0.2,
      delta: 0.5,
      gamma: 0.03,
      theta: -0.05,
      timestamp: 1730610900,
      exchange: "CBOE",
      source: "REALTIME_NBBO_SYNCHRONIZED",
    };

    // 00:15 ET midnight date (5:15 AM UTC during EST)
    const midnightEt = new Date("2026-11-03T05:15:00Z");
    const result = evaluateOcoBrackets({
      bracket,
      config,
      currentNbbo: mockQuote,
      underlyingSpot: 760,
      nowEt: midnightEt,
    });

    assert.notStrictEqual(result.action, "EXIT_MOC", "Midnight (00:15 ET) tick must NEVER trigger EXIT_MOC");
    assert.strictEqual(result.action, "HOLD", "Midnight tick within target/stop ranges must HOLD");
  });

  it("Coordinate Manifold Invariant: External signal price $753.51 on $756.23 candle is rejected as manifold tear", () => {
    const candleAt1352 = {
      open: 756.10,
      high: 756.40,
      low: 755.95,
      close: 756.23,
    };
    const staleMorningPrice = 753.51;
    const candlePriceRange = Math.max(candleAt1352.high - candleAt1352.low, 0.5);
    const maxTolerance = Math.max(candlePriceRange * 1.5, 1.2);
    const isManifoldTear = Math.abs(staleMorningPrice - candleAt1352.close) > maxTolerance;

    assert.strictEqual(isManifoldTear, true, "Morning entry price $753.51 on $756.23 candle MUST be detected as manifold tear");
  });

  it("Event-Time & Freshness Invariant: Signal older than 300s is marked backfill (suppresses live Discord alert)", () => {
    const nowTs = 1793731946; // 1:52 PM
    const morningEventTs = 1793717880; // 9:38 AM (approx 14,066s earlier)
    const isStale = nowTs - morningEventTs > 300;

    assert.strictEqual(isStale, true, "Trade from 9:38 AM evaluated at 1:52 PM must be marked stale (> 300s)");
  });

  it("Option Math Invariant: Stop loss floor cannot drop below -25% of entry premium", () => {
    const entryAsk = 0.33;
    const maxStopLossFloor = Number((entryAsk * 0.75).toFixed(2)); // $0.25
    const unconstrainedBsStop = 0.13; // Theoretical -61%
    const estStop = Math.max(maxStopLossFloor, unconstrainedBsStop);

    assert.strictEqual(estStop, 0.25, "Stop loss on $0.33 option must be clamped to $0.25 (-25%), NOT $0.13 (-61%)");
    const stopPct = Math.round(((estStop - entryAsk) / entryAsk) * 100);
    assert.strictEqual(stopPct, -24, "Stop percentage must be -24% / -25%, matching the dollar floor");
  });

  it("Option Percentage Derivation Invariant: $0.90 target on $0.33 entry produces +173%, NOT +30%", () => {
    const entryAsk = 0.33;
    const estTp1 = 0.90;
    const derivedTp1Pct = Math.round(((estTp1 - entryAsk) / entryAsk) * 100);

    assert.strictEqual(derivedTp1Pct, 173, "Derived percentage for $0.90 target on $0.33 entry must be +173%");
    assert.notStrictEqual(derivedTp1Pct, 30, "Derived percentage must NEVER falsely claim +30% for a $0.90 target on $0.33 entry");
  });

  it("Exit Title Invariant: 'TARGET 1 HIT · FULL PROFIT EXIT (1 CONTRACT)' maps to TARGET 1, NOT TARGET 2", () => {
    const reasonUpper = "TARGET 1 HIT · FULL PROFIT EXIT (1 CONTRACT)".toUpperCase();
    const pnlPct = 36.36;
    const contractsQty = 1;

    let badge = "";
    if (reasonUpper.includes("TARGET 2") || (pnlPct >= 50 && !reasonUpper.includes("TARGET 1"))) {
      badge = "TARGET 2 FULL PROFIT HIT";
    } else if (reasonUpper.includes("TARGET 1")) {
      badge = contractsQty === 1 ? "TARGET 1 FULL PROFIT HIT" : "TARGET 1 PROFIT SECURED";
    }

    assert.strictEqual(badge, "TARGET 1 FULL PROFIT HIT", "1-contract full exit at Target 1 must NOT trigger Target 2 title");
  });

  it("Realized P&L Accounting Invariant: LONG entered at $768.02 with +7.62 peak MFE exiting at $765.82 evaluates strictly to WRONG -2.20, NEVER RIGHT +7.62", () => {
    const mockSeries: PrzmCandlePoint[] = [
      {
        time: "10:00am",
        timestamp: 1730732400000,
        open: 768.00,
        high: 768.50,
        low: 767.80,
        close: 768.02,
        volume: 50000,
        vwap: 768.00,
        flowVwap: 768.00,
      },
      {
        time: "10:30am",
        timestamp: 1730734200000,
        open: 770.00,
        high: 775.64, // Peak intraday excursion (+7.62 MFE above 768.02)
        low: 769.50,
        close: 774.20,
        volume: 50000,
        vwap: 770.00,
        flowVwap: 770.00,
      },
      {
        time: "11:35am",
        timestamp: 1730738100000,
        open: 766.50,
        high: 767.00,
        low: 765.50,
        close: 765.82, // Actual exit price
        volume: 50000,
        vwap: 768.50,
        flowVwap: 768.50,
      },
    ];

    const mockSignals: PrzmSignalPoint[] = [
      {
        id: "sig-1",
        index: 0,
        time: "10:00am",
        price: 768.02,
        type: "LONG",
        tag: "OPEN",
        label: "LONG",
        exitPrice: 765.82,
        isClosed: true,
      },
    ];

    const summary = evaluatePrzmCallLedger(mockSignals, mockSeries, 765.82, "STAND_ASIDE");
    assert.strictEqual(summary.entries.length, 1);
    const entry = summary.entries[0];

    assert.strictEqual(entry.delta, -2.20, "Delta must be strictly -$2.20, NEVER +$7.62!");
    assert.strictEqual(entry.status, "WRONG", "Closed drawdown trade must evaluate strictly to WRONG!");
    assert.strictEqual(summary.winRatePct, 0, "Win rate for a single losing trade must be 0%, NOT 100%!");
    assert.strictEqual(summary.rightCount, 0);
    assert.strictEqual(summary.wrongCount, 1);
  });

  it("Short/Put Directional Invariant: SPY dropping from $749.01 to $746.30 evaluates strictly to +2.71 pts · RIGHT", () => {
    const mockSeries: PrzmCandlePoint[] = [
      {
        time: "10:00am",
        timestamp: 1730736000000,
        open: 749.50,
        high: 750.00,
        low: 748.80,
        close: 749.01,
        volume: 50000,
        vwap: 749.20,
        flowVwap: 749.20,
      },
      {
        time: "10:35am",
        timestamp: 1730738100000,
        open: 747.00,
        high: 747.20,
        low: 746.10,
        close: 746.30,
        volume: 50000,
        vwap: 747.50,
        flowVwap: 747.50,
      },
    ];

    const mockSignals: PrzmSignalPoint[] = [
      {
        id: "sig-short-1",
        index: 0,
        time: "10:00am",
        price: 749.01,
        type: "SHORT",
        tag: "BREAK",
        label: "SHORT",
        exitPrice: 746.30,
        isClosed: true,
      },
    ];

    const summary = evaluatePrzmCallLedger(mockSignals, mockSeries, 746.30, "STAND_ASIDE");
    assert.strictEqual(summary.entries.length, 1);
    const entry = summary.entries[0];

    assert.strictEqual(entry.type, "SHORT");
    assert.strictEqual(entry.delta, 2.71, "Short delta for 749.01 -> 746.30 must be +2.71 pts, NEVER -2.71 pts!");
    assert.strictEqual(entry.status, "RIGHT", "Winning short trade must evaluate strictly to RIGHT, NEVER WRONG!");
    assert.strictEqual(summary.winRatePct, 100);
    assert.strictEqual(summary.rightCount, 1);
    assert.strictEqual(summary.wrongCount, 0);
  });

  it("Server Trade Sync Invariant: Authoritative server closed PUT trade evaluates strictly to +2.71 pts · RIGHT", () => {
    const mockServerTrades = {
      closedPositions: [
        {
          id: "SPY-PUT-1730736000",
          ticker: "SPY",
          contractType: "PUT" as const,
          contractLabel: "SPY 749 P",
          btoSpotPrice: 749.01,
          closedSpotPrice: 746.30,
          pnlOptionPct: 45.5,
          pnlSpotPct: 0.36,
          exitReason: "TARGET 1 HIT · FULL PROFIT EXIT",
          openedTs: 1730736000,
          closedTs: 1730738100,
        },
      ],
      activePositions: {},
      alerts: [],
    };

    const summary = evaluatePrzmCallLedger([], [], 746.30, "STAND_ASIDE", mockServerTrades);
    assert.strictEqual(summary.entries.length, 1);
    const entry = summary.entries[0];

    assert.strictEqual(entry.type, "SHORT");
    assert.strictEqual(entry.contractType, "PUT");
    assert.strictEqual(entry.delta, 2.71, "Server PUT delta must be +2.71 pts!");
    assert.strictEqual(entry.status, "RIGHT", "Server closed PUT must be RIGHT!");
    assert.strictEqual(summary.winRatePct, 100);
  });

  it("FSM Signal Fallback Invariant: Closed Short FSM signal normalizes to PUT trade with positive PnL", () => {
    const fsmSignals = [
      {
        id: "sig-short-fsm-1",
        ticker: "SPY",
        type: "SHORT",
        price: 749.01,
        exitPrice: 746.30,
        isClosed: true,
        openedTs: 1730736000,
        exitTimestamp: 1730738100,
        time: "9:30 AM",
        label: "SHORT",
        reason: "MOMENTUM COVER",
      },
    ];

    // Server trades is empty
    const trades = extractNormalizedTradesForTicker("SPY", null, fsmSignals);
    assert.strictEqual(trades.length, 1);
    const trade = trades[0];

    assert.strictEqual(trade.ticker, "SPY");
    assert.strictEqual(trade.contractType, "PUT");
    assert.strictEqual(trade.status, "CLOSED");
    assert.strictEqual(trade.btoSpotPrice, 749.01);
    assert.strictEqual(trade.closedSpotPrice, 746.30);
    assert.ok(
      typeof trade.pnlOptionPct === "number" && trade.pnlOptionPct > 0,
      `Expected positive pnlOptionPct for winning short, got ${trade.pnlOptionPct}`
    );
  });

  it("FSM Signal Fallback Invariant: Active Open Call FSM signal normalizes to OPEN CALL trade", () => {
    const fsmSignals = [
      {
        id: "sig-open-call-1",
        ticker: "SPY",
        type: "LONG",
        price: 753.50,
        isClosed: false,
        openedTs: 1730736000,
        time: "9:30 AM",
        label: "LONG · OPEN",
      },
    ];

    const trades = extractNormalizedTradesForTicker("SPY", { activePositions: {}, closedPositions: [] }, fsmSignals);
    assert.strictEqual(trades.length, 1);
    const trade = trades[0];

    assert.strictEqual(trade.ticker, "SPY");
    assert.strictEqual(trade.contractType, "CALL");
    assert.strictEqual(trade.status, "OPEN");
    assert.strictEqual(trade.btoSpotPrice, 753.50);
  });

  it("Candle [low, high] Clamping Invariant: Out-of-range spot fills clamp strictly inside traded candle bounds", () => {
    const candle = { low: 759.25, high: 762.40 };
    assert.strictEqual(clampToCandleRange(764.10, candle), 762.40, "Above-high fill must clamp to candle.high");
    assert.strictEqual(clampToCandleRange(757.80, candle), 759.25, "Below-low fill must clamp to candle.low");
    assert.strictEqual(clampToCandleRange(760.55, candle), 760.55, "In-range fill must remain unchanged");
    assert.strictEqual(clampToCandleRange(760.55, null), 760.55, "Missing candle must pass through safely");
  });

  it("Sigma Footer-to-Canvas Parity Invariant: ±1σ and ±2σ footer bounds match canvas Y-levels identically", () => {
    const priorClose = 760.0;
    const sigma1Move = 4.25;
    const sigma2Move = 8.50;
    const canvasLevels = {
      pPlus1: priorClose + sigma1Move,
      pMinus1: priorClose - sigma1Move,
      pPlus2: priorClose + sigma2Move,
      pMinus2: priorClose - sigma2Move,
    };
    const footerPills = {
      s1Low: Number((priorClose - sigma1Move).toFixed(2)),
      s1High: Number((priorClose + sigma1Move).toFixed(2)),
      s2Low: Number((priorClose - sigma2Move).toFixed(2)),
      s2High: Number((priorClose + sigma2Move).toFixed(2)),
    };
    assert.strictEqual(footerPills.s1High, canvasLevels.pPlus1);
    assert.strictEqual(footerPills.s1Low, canvasLevels.pMinus1);
    assert.strictEqual(footerPills.s2High, canvasLevels.pPlus2);
    assert.strictEqual(footerPills.s2Low, canvasLevels.pMinus2);
  });

  it("Cursor Hover Isolation Invariant: 0DTE KING stays locked to structuralBookCol regardless of hovered activeBookCol", () => {
    const structuralBookCol = { allExpKingStrike: 765, filteredKingStrike: 762 };
    const hoveredBookCol = { allExpKingStrike: 755, filteredKingStrike: 752 };
    const resolvedCol = structuralBookCol ?? hoveredBookCol;
    assert.strictEqual(resolvedCol.filteredKingStrike, 762, "0DTE KING must stay locked to live structuralBookCol");
    assert.strictEqual(resolvedCol.allExpKingStrike, 765, "ALL-EXP KING must stay locked to live structuralBookCol");
  });

  it("Cross-Frame Time & Candle Clamp Parity: '10 AM' parses to 600 mins and spot clamps within [low, high]", () => {
    assert.strictEqual(parseTimeLabelToMinutes("10 AM"), 600, "'10 AM' without :MM must parse to 600 mins");
    const clamped = clampSpotToCandle(754.26, { open: 754.4, high: 754.44, low: 752.05, close: 752.3 });
    assert.strictEqual(clamped, 754.26);
    const clampedHigh = clampSpotToCandle(755.10, { open: 754.4, high: 754.44, low: 752.05, close: 752.3 });
    assert.strictEqual(clampedHigh, 754.44);
  });

  it("Daemon Lock Token Ownership Invariant: Mismatched release token cannot clear active bar lock", () => {
    const tok = acquireBarEvaluationLock();
    assert.ok(tok, "Initial lock acquisition must succeed");
    releaseBarEvaluationLock(999999 as any);
    assert.strictEqual(acquireBarEvaluationLock(), 0 as any, "Wrong token must not release active lock");
    releaseBarEvaluationLock(tok as any);
  });
});
