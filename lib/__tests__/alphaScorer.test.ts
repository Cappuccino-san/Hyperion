import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyMicrostructuralRegime,
  computeBoundedExpectedMove,
  resolveMinOptionDelta,
  scoreContractTaylorPayoff,
} from "../alphaScorer";
import {
  reanchorDelayedOptionContract,
  selectSmallAccountContract,
  priceOptionWithSkew,
  computeRemainingYearsToExpiration,
} from "../tradeSignalEngine";
import type { NormalizedOptionContract } from "../optionsExposure";

describe("AlphaScorer: Regime-Conditioned Delta Router & Second-Order Taylor Payoff", () => {
  it("resolveMinOptionDelta routes on regime and |impulsePeclet| without any etMins < 630 clock cutoff", () => {
    const negGamma = resolveMinOptionDelta({
      regime: "NEG_GAMMA_TREND",
      impulsePeclet: -2.1,
    });
    assert.equal(negGamma.minDelta, 0.24);
    assert.equal(negGamma.maxDelta, 0.50);
    assert.equal(negGamma.preferZeroDte, true);

    const zeroFlipHighAdv = resolveMinOptionDelta({
      regime: "ZERO_GAMMA_FLIP",
      impulsePeclet: 1.85,
    });
    assert.equal(zeroFlipHighAdv.minDelta, 0.24);
    assert.equal(zeroFlipHighAdv.maxDelta, 0.50);

    const zeroFlipLowAdv = resolveMinOptionDelta({
      regime: "ZERO_GAMMA_FLIP",
      impulsePeclet: 1.2,
    });
    assert.equal(zeroFlipLowAdv.minDelta, 0.35);

    const posGammaPin = resolveMinOptionDelta({
      regime: "POS_GAMMA_PIN",
      impulsePeclet: 0.4,
    });
    assert.equal(posGammaPin.minDelta, 0.35);
    assert.equal(posGammaPin.maxDelta, 0.50);

    // Infer ZERO_GAMMA_FLIP when spot is near zeroGamma and |impulsePeclet| >= 1.8
    const inferredFlip = classifyMicrostructuralRegime({
      spotPrice: 750.5,
      zeroGamma: 750.0,
      impulsePeclet: 1.9,
    });
    assert.equal(inferredFlip, "ZERO_GAMMA_FLIP");

    const lowEdgeChop = resolveMinOptionDelta({
      spotPrice: 755.0,
      zeroGamma: 750.0,
      gammaRegime: "POSITIVE_GAMMA",
      impulsePeclet: 0.15,
      impulseChi: 0.51,
    });
    assert.equal(lowEdgeChop.regime, "LOW_EDGE_CHOP");
    assert.equal(lowEdgeChop.chopVeto, true);
  });

  it("computeBoundedExpectedMove bounds move by structural wall room and remaining IV expected move", () => {
    // Tight structural wall ($1.40 room) bounds large IV move ($6+)
    const wallBounded = computeBoundedExpectedMove({
      spotPrice: 750,
      isCall: true,
      target1Spot: 753,
      zeroDteCallWall: 751.4,
      atmIv: 0.18,
      remainingRthMinutes: 240,
    });
    assert.ok(Math.abs(wallBounded - 1.4) < 1e-6, `Expected 1.40 wall cap, got ${wallBounded}`);

    // Late-session remaining IV move bounds distant structural wall
    const ivBounded = computeBoundedExpectedMove({
      spotPrice: 750,
      isCall: true,
      target1Spot: 758,
      zeroDteCallWall: 760,
      atmIv: 0.14,
      remainingRthMinutes: 30,
    });
    assert.ok(ivBounded < 3.0, `Expected late-day remaining IV move < 3.0, got ${ivBounded}`);
  });

  it("scoreContractTaylorPayoff matches formula and rejects spread / max(0.05, absDelta * expectedMove) > 0.22", () => {
    const valid = scoreContractTaylorPayoff({
      absDelta: 0.36,
      gamma: 0.05,
      absTheta: 0.14,
      holdDays: 0.4,
      spread: 0.04,
      ask: 0.80,
      expectedMove: 2.0,
    });
    assert.equal(valid.eligible, true);
    const expectedScore =
      (0.36 * 2.0 + 0.5 * 0.05 * 4.0 - 0.14 * 0.4 - 0.5 * 0.04) / 0.80;
    assert.ok(
      Math.abs(valid.score - expectedScore) < 1e-9,
      `Expected score ${expectedScore}, got ${valid.score}`
    );

    // Spread $0.16 on $0.80 ask is 20% <= 24% spreadPct, yet 0.16 / (0.25 * 2.0) = 0.32 > 0.22 -> REJECTED
    const highFriction = scoreContractTaylorPayoff({
      absDelta: 0.25,
      gamma: 0.04,
      absTheta: 0.10,
      holdDays: 0.3,
      spread: 0.16,
      ask: 0.80,
      expectedMove: 2.0,
    });
    assert.equal(highFriction.eligible, false);
    assert.equal(highFriction.rejectionReason, "SPREAD_EXCEEDS_22PCT_EXPECTED_PAYOFF");
  });

  it("selectSmallAccountContract prefers 0DTE 0.24..0.50 delta at afternoon RTH in NEG_GAMMA_TREND and ZERO_GAMMA_FLIP", async () => {
    const afternoonEt = new Date("2026-11-16T13:35:00-05:00");
    const chain: NormalizedOptionContract[] = [
      {
        symbol: "SPY261116C00753000",
        strike: 753,
        expiration: "2026-11-16", // 0DTE
        optionType: "C",
        bid: 0.58,
        ask: 0.60,
        last: 0.59,
        volume: 15000,
        openInterest: 12000,
        iv: 0.16,
        delta: 0.26, // allowed in NEG_GAMMA_TREND / ZERO_GAMMA_FLIP (>= 0.24)
        gamma: 0.06,
        vega: 0.04,
        theta: -0.18,
        percentChange: 0,
      },
      {
        symbol: "SPY261117C00753000",
        strike: 753,
        expiration: "2026-11-17", // 1DTE
        optionType: "C",
        bid: 0.88,
        ask: 0.90,
        last: 0.89,
        volume: 9000,
        openInterest: 8000,
        iv: 0.16,
        delta: 0.36,
        gamma: 0.04,
        vega: 0.08,
        theta: -0.10,
        percentChange: 0,
      },
    ];

    const negPick = await selectSmallAccountContract({
      ticker: "SPY",
      contractType: "CALL",
      spotPrice: 750.5,
      target1Spot: 753.0,
      target2Spot: 755.0,
      stopLossSpot: 749.0,
      contracts: chain,
      nowEt: afternoonEt,
      zeroDteCallWall: 755.0,
      zeroDtePutWall: 747.0,
      regime: "NEG_GAMMA_TREND",
      impulsePeclet: 2.1,
    });
    assert.ok(negPick, "Expected 0DTE contract in afternoon NEG_GAMMA_TREND");
    assert.equal(negPick?.dte, 0);
    assert.equal(negPick?.strike, 753);

    const flipPick = await selectSmallAccountContract({
      ticker: "SPY",
      contractType: "CALL",
      spotPrice: 750.5,
      target1Spot: 753.0,
      target2Spot: 755.0,
      stopLossSpot: 749.0,
      contracts: chain,
      nowEt: afternoonEt,
      zeroDteCallWall: 755.0,
      zeroDtePutWall: 747.0,
      regime: "ZERO_GAMMA_FLIP",
      impulsePeclet: 1.9,
    });
    assert.equal(flipPick?.dte, 0);
  });

  it("POS_GAMMA_PIN enforces 0.35 <= |delta| <= 0.50 and falls back to 1-2 DTE when 0DTE exceeds $0.99", async () => {
    const middayEt = new Date("2026-11-16T11:15:00-05:00");
    const chain: NormalizedOptionContract[] = [
      // 0DTE over $0.99
      {
        symbol: "SPY261116C00751000",
        strike: 751,
        expiration: "2026-11-16",
        optionType: "C",
        bid: 1.10,
        ask: 1.14,
        last: 1.12,
        volume: 14000,
        openInterest: 10000,
        iv: 0.16,
        delta: 0.42,
        gamma: 0.06,
        vega: 0.04,
        theta: -0.20,
        percentChange: 0,
      },
      // 0DTE affordable but |delta| = 0.30 < 0.35 in POS_GAMMA_PIN -> MUST BE REJECTED
      {
        symbol: "SPY261116C00752000",
        strike: 752,
        expiration: "2026-11-16",
        optionType: "C",
        bid: 0.68,
        ask: 0.70,
        last: 0.69,
        volume: 12000,
        openInterest: 9000,
        iv: 0.16,
        delta: 0.30,
        gamma: 0.05,
        vega: 0.04,
        theta: -0.18,
        percentChange: 0,
      },
      // 1DTE fallback with |delta| = 0.39 and ask = $0.88 <= $0.99
      {
        symbol: "SPY261117C00752000",
        strike: 752,
        expiration: "2026-11-17",
        optionType: "C",
        bid: 0.85,
        ask: 0.88,
        last: 0.87,
        volume: 11000,
        openInterest: 9500,
        iv: 0.16,
        delta: 0.39,
        gamma: 0.04,
        vega: 0.07,
        theta: -0.11,
        percentChange: 0,
      },
    ];

    const pinPick = await selectSmallAccountContract({
      ticker: "SPY",
      contractType: "CALL",
      spotPrice: 750.0,
      target1Spot: 753.0,
      target2Spot: 755.0,
      stopLossSpot: 748.5,
      contracts: chain,
      nowEt: middayEt,
      zeroDteCallWall: 755.0,
      zeroDtePutWall: 747.0,
      regime: "POS_GAMMA_PIN",
      impulsePeclet: 0.5,
    });
    assert.ok(pinPick, "Expected 1-2 DTE fallback in POS_GAMMA_PIN");
    assert.equal(pinPick?.dte, 1);
    assert.ok((pinPick?.delta ?? 0) >= 0.35 && (pinPick?.delta ?? 1) <= 0.50);
  });

  it("Live-spot BS re-anchoring rejects stale delayed sub-$0.99 quotes when live spot moves ITM, while honoring Tradier directly", async () => {
    const evalEt = new Date("2026-11-16T10:30:00-05:00");
    // Stale CBOE quote recorded when spot was $750 ($0.75 ask for 752C)
    const staleDelayedContract: NormalizedOptionContract = {
      symbol: "SPY261116C00752000",
      strike: 752,
      expiration: "2026-11-16",
      optionType: "C",
      bid: 0.72,
      ask: 0.75,
      last: 0.74,
      volume: 12000,
      openInterest: 9000,
      iv: 0.16,
      delta: 0.36,
      gamma: 0.05,
      vega: 0.04,
      percentChange: 0,
    };

    // Live /api/tick spot jumped to $753.20 (752C is now ITM > $1.20 -> exceeds $0.99!)
    const reanchored = reanchorDelayedOptionContract({
      contract: staleDelayedContract,
      liveSpotPrice: 753.2,
      dataSource: "CBOE_MARKET_DATA",
      todayEt: "2026-11-16",
      nowMs: evalEt.getTime(),
    });
    const expectedBs = priceOptionWithSkew({
      spot: 753.2,
      strike: 752,
      direction: "LONG",
      remainingYears: computeRemainingYearsToExpiration(evalEt.getTime(), 0),
      atmIv: 0.16,
      skewSlope: 0,
      smileConvexity: 0,
      halfSpreadPct: (0.75 - 0.72) / (2 * 0.735),
    });
    assert.equal(reanchored.ask, expectedBs.ask);
    assert.ok((reanchored.ask ?? 0) > 0.99, `Expected re-anchored ask > $0.99, got ${reanchored.ask}`);

    const delayedReject = await selectSmallAccountContract({
      ticker: "SPY",
      contractType: "CALL",
      spotPrice: 753.2,
      target1Spot: 755.5,
      target2Spot: 757.0,
      stopLossSpot: 751.8,
      contracts: [staleDelayedContract],
      nowEt: evalEt,
      dataSource: "CBOE_MARKET_DATA",
      regime: "NEG_GAMMA_TREND",
      impulsePeclet: 2.0,
    });
    assert.equal(delayedReject, null, "Stale delayed quote re-anchored > $0.99 must be rejected");

    // When dataSource is "tradier", quotes are live NBBO and not re-anchored
    const tradierPassThrough = reanchorDelayedOptionContract({
      contract: staleDelayedContract,
      liveSpotPrice: 753.2,
      dataSource: "tradier",
      todayEt: "2026-11-16",
      nowMs: evalEt.getTime(),
    });
    assert.equal(tradierPassThrough.ask, 0.75);
  });
});
