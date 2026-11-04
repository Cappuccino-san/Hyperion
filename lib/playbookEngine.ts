import { PlaybookPick, PlaybookPayload, PlaybookExecutionStatus } from "./types/playbook";
import { getTickerPreset, TickerPreset } from "@/lib/tickerPresets";
import { computeCeilingShareChi } from "@/lib/flowGammaVwap";

export const PLAYBOOK_TICKER_UNIVERSE = [
  "SPY",
  "QQQ",
  "IWM",
  "NVDA",
  "AAPL",
  "MSFT",
  "MU",
  "TSLA",
] as const;

export interface LiveTickerTelemetry {
  ticker: string;
  spotPrice: number;
  previousClose: number;
  expectedMoveDaily: number;
  atmCallMid?: number;
  atmPutMid?: number;
  netGex: number;
  netVex: number;
  gexKing: number;
  vexKing: number;
  kingStrength: number;
  strikeStep: number;
}

const f2 = (v: number): number => Number(v.toFixed(2));

/**
 * Derives ATM Straddle Expected Move:
 * EM_daily = 0.85 * (Call_ATM + Put_ATM)
 * Falls back to IV-based rule of 16 if ATM straddle quotes are not available.
 */
export function calculateExpectedMove(
  spotPrice: number,
  iv: number,
  atmCallMid?: number,
  atmPutMid?: number
): number {
  if (atmCallMid != null && atmPutMid != null && atmCallMid > 0 && atmPutMid > 0) {
    const straddleEm = 0.85 * (atmCallMid + atmPutMid);
    // Sanity-cap: Guard against corrupt after-hours quotes producing unphysical 0DTE expected move (>8% of spot)
    if (straddleEm > 0 && straddleEm <= spotPrice * 0.08) {
      return f2(straddleEm);
    }
  }
  // IV-based rule-of-16 daily move: Spot * IV / sqrt(252)
  const ruleOf16 = spotPrice * (iv / Math.sqrt(252));
  return f2(Math.max(0.25, ruleOf16));
}

/**
 * Computes execution status based on real-time spot vs trigger boundaries
 */
export function evaluateExecutionStatus(
  pick: PlaybookPick,
  currentSpot: number
): PlaybookExecutionStatus {
  if (pick.type === "CALL") {
    if (currentSpot <= pick.stopLossPrice) return "STOPPED";
    if (currentSpot >= pick.target2) return "T2 HIT";
    if (currentSpot >= pick.target1) return "T1 HIT";
    if (currentSpot >= pick.entryTriggerPrice) return "TRIGGERED";
    return "PENDING";
  } else {
    if (currentSpot >= pick.stopLossPrice) return "STOPPED";
    if (currentSpot <= pick.target2) return "T2 HIT";
    if (currentSpot <= pick.target1) return "T1 HIT";
    if (currentSpot <= pick.entryTriggerPrice) return "TRIGGERED";
    return "PENDING";
  }
}

/**
 * Computes percentage progress (0 - 100%) from Entry to Target 2
 */
export function computeTargetProgress(
  pick: PlaybookPick,
  currentSpot: number
): number {
  if (pick.type === "CALL") {
    if (currentSpot <= pick.entryTriggerPrice) return 0;
    const totalDist = pick.target2 - pick.entryTriggerPrice;
    if (totalDist <= 0) return 0;
    const progress = ((currentSpot - pick.entryTriggerPrice) / totalDist) * 100;
    return Math.min(100, Math.max(0, f2(progress)));
  } else {
    if (currentSpot >= pick.entryTriggerPrice) return 0;
    const totalDist = pick.entryTriggerPrice - pick.target2;
    if (totalDist <= 0) return 0;
    const progress = ((pick.entryTriggerPrice - currentSpot) / totalDist) * 100;
    return Math.min(100, Math.max(0, f2(progress)));
  }
}

/**
 * Generates a Bullish (Call) trade card for a ticker
 */
export function generateCallPick(telemetry: LiveTickerTelemetry): PlaybookPick {
  const {
    ticker,
    spotPrice,
    previousClose,
    expectedMoveDaily,
    netGex,
    gexKing,
    vexKing,
    kingStrength,
  } = telemetry;

  const edgeHigh = f2(spotPrice + expectedMoveDaily);
  const edgeLow = f2(spotPrice - expectedMoveDaily);

  // Entry: round to tick (spot + 0.10 * EM)
  const entryPrice = f2(spotPrice + 0.10 * expectedMoveDaily);

  // Stop loss: spot - 0.08 * EM
  const stopLossPrice = f2(spotPrice - 0.08 * expectedMoveDaily);

  // Target 2: Terminal Expected Move upper boundary (D↑ edge)
  const target2 = edgeHigh;

  // Target 1: Entry + 0.45 * (Edge_high - Entry)
  const target1 = f2(entryPrice + 0.45 * (target2 - entryPrice));

  // Determine if King node sits between Entry and Target 2
  const kingBetween = gexKing >= entryPrice && gexKing <= target2;

  // Compute Flux Field Péclet number Pe = mu_delta * W / Gamma and Ceiling Share chi
  const channelW = Math.max(0.5, edgeHigh - edgeLow);
  const driftNorm = (spotPrice - previousClose) / Math.max(0.25, expectedMoveDaily);
  const pecletNumber = f2(Math.max(-12, Math.min(12, driftNorm * 2.4 + (netGex >= 0 ? 0.55 : -0.35))));
  const ceilingShareChi = computeCeilingShareChi(pecletNumber);

  // Score bullish conviction
  let score = 50;
  if (netGex > 0) score += 20; // Positive gamma pin acceleration
  if (kingBetween) score += 15;
  score += Math.min(15, Math.round(kingStrength * 0.15));
  if (spotPrice > previousClose) score += 10;
  if (ceilingShareChi >= 0.55) score += 8;

  let why = `Scanner top bull pick. Coiling within ${(
    ((entryPrice - spotPrice) / expectedMoveDaily) *
    100
  ).toFixed(0)}% of daily EM breakout.`;

  if (netGex > 0) {
    why += ` Positive gamma regime (+$${netGex.toFixed(
      1
    )}B net GEX) provides dealer bid support on dips.`;
  }
  if (kingBetween) {
    why += ` GEX King node ($${gexKing}) sits between entry and Target 2, providing a massive dealer pinning magnet.`;
  } else {
    why += ` Clean breakout path toward 0DTE Expected Move upper boundary ($${target2.toFixed(
      2
    )}).`;
  }
  why += ` Flux Field ceiling share χ=${(ceilingShareChi * 100).toFixed(1)}% (Pe=${pecletNumber >= 0 ? "+" : ""}${pecletNumber.toFixed(2)}, W=$${channelW.toFixed(2)}) confirms upward advection toward ceiling node.`;

  const pick: PlaybookPick = {
    id: `call-${ticker.toLowerCase()}-0dte`,
    ticker,
    type: "CALL",
    priorClose: previousClose,
    entryTrigger: `Break above ${entryPrice.toFixed(2)}`,
    stopLoss: `Back below ${stopLossPrice.toFixed(2)}`,
    entryTriggerPrice: entryPrice,
    stopLossPrice,
    target1,
    target2,
    gexKing,
    vexKing,
    expectedMove: {
      value: expectedMoveDaily,
      low: edgeLow,
      high: edgeHigh,
    },
    why,
    currentSpot: spotPrice,
    score,
  };

  pick.status = evaluateExecutionStatus(pick, spotPrice);
  return pick;
}

/**
 * Generates a Bearish (Put) trade card for a ticker
 */
export function generatePutPick(telemetry: LiveTickerTelemetry): PlaybookPick {
  const {
    ticker,
    spotPrice,
    previousClose,
    expectedMoveDaily,
    netGex,
    gexKing,
    vexKing,
    kingStrength,
  } = telemetry;

  const edgeHigh = f2(spotPrice + expectedMoveDaily);
  const edgeLow = f2(spotPrice - expectedMoveDaily);

  // Entry: round to tick (spot - 0.10 * EM)
  const entryPrice = f2(spotPrice - 0.10 * expectedMoveDaily);

  // Stop loss: spot + 0.08 * EM
  const stopLossPrice = f2(spotPrice + 0.08 * expectedMoveDaily);

  // Target 2: Terminal Expected Move lower boundary (D↓ edge)
  const target2 = edgeLow;

  // Target 1: Entry - 0.45 * (Entry - Edge_low)
  const target1 = f2(entryPrice - 0.45 * (entryPrice - target2));

  // Determine if King node sits between Entry and Target 2 (below entry)
  const kingBetween = gexKing <= entryPrice && gexKing >= target2;

  // Compute Flux Field Péclet number Pe and Ceiling Share chi
  const channelW = Math.max(0.5, edgeHigh - edgeLow);
  const driftNorm = (spotPrice - previousClose) / Math.max(0.25, expectedMoveDaily);
  const pecletNumber = f2(Math.max(-12, Math.min(12, driftNorm * 2.4 + (netGex < 0 ? -0.65 : 0.25))));
  const ceilingShareChi = computeCeilingShareChi(pecletNumber);
  const floorShare = f2(1 - ceilingShareChi);

  // Score bearish conviction
  let score = 50;
  if (netGex < 0) score += 20; // Negative gamma dealer shorting accelerator
  if (kingBetween) score += 15;
  score += Math.min(15, Math.round(kingStrength * 0.15));
  if (spotPrice < previousClose) score += 10;
  if (ceilingShareChi <= 0.45) score += 8;

  let why = `Deep breakdown setup coiling within ${(
    ((spotPrice - entryPrice) / expectedMoveDaily) *
    100
  ).toFixed(0)}% of entry trigger.`;

  if (netGex < 0) {
    why += ` Negative gamma regime (${netGex.toFixed(
      1
    )}B net GEX) forces market makers to short delta aggressively into market weakness.`;
  }
  if (kingBetween) {
    why += ` GEX King node ($${gexKing}) sits below entry, acting as strong gravitational downside pull.`;
  } else {
    why += ` Unhedged support opens flush trajectory toward 0DTE Expected Move lower boundary ($${target2.toFixed(
      2
    )}).`;
  }
  why += ` Flux Field floor absorption (1-χ)=${(floorShare * 100).toFixed(1)}% (Pe=${pecletNumber >= 0 ? "+" : ""}${pecletNumber.toFixed(2)}, W=$${channelW.toFixed(2)}) confirms downward hedging drift toward floor node.`;

  const pick: PlaybookPick = {
    id: `put-${ticker.toLowerCase()}-0dte`,
    ticker,
    type: "PUT",
    priorClose: previousClose,
    entryTrigger: `Break below ${entryPrice.toFixed(2)}`,
    stopLoss: `Back above ${stopLossPrice.toFixed(2)}`,
    entryTriggerPrice: entryPrice,
    stopLossPrice,
    target1,
    target2,
    gexKing,
    vexKing,
    expectedMove: {
      value: expectedMoveDaily,
      low: edgeLow,
      high: edgeHigh,
    },
    why,
    currentSpot: spotPrice,
    score,
  };

  pick.status = evaluateExecutionStatus(pick, spotPrice);
  return pick;
}

/**
 * Builds live telemetry for a given ticker symbol using active presets or options caches
 */
export function buildLiveTelemetryForTicker(
  ticker: string,
  overrides?: Partial<LiveTickerTelemetry>
): LiveTickerTelemetry {
  const preset: TickerPreset = getTickerPreset(ticker);
  const spotPrice = overrides?.spotPrice ?? preset.spotPrice;
  const previousClose = overrides?.previousClose ?? preset.previousClose;
  const em =
    overrides?.expectedMoveDaily ??
    calculateExpectedMove(
      spotPrice,
      preset.impliedVolatility,
      overrides?.atmCallMid,
      overrides?.atmPutMid
    );

  return {
    ticker,
    spotPrice,
    previousClose,
    expectedMoveDaily: em,
    atmCallMid: overrides?.atmCallMid,
    atmPutMid: overrides?.atmPutMid,
    netGex: overrides?.netGex ?? preset.netMetrics.netGex,
    netVex: overrides?.netVex ?? preset.netMetrics.netVex,
    gexKing: overrides?.gexKing ?? preset.kingPreset.allExpKing,
    vexKing: overrides?.vexKing ?? preset.kingPreset.zeroDteKing,
    kingStrength:
      overrides?.kingStrength ??
      Math.round(
        Math.min(
          100,
          (preset.kingPreset.kingValue /
            (preset.kingPreset.totalBoardGamma || 1)) *
            100 *
            4
        )
      ),
    strikeStep: overrides?.strikeStep ?? preset.strikeStep,
  };
}

/**
 * Programmatically generates the full Daily Playbook:
 * Evaluates candidate universe, ranks setups, and extracts Top 3 Calls + Top 3 Puts.
 */
export function generateDailyPlaybook(
  customUniverse?: string[],
  telemetryOverrides?: Record<string, Partial<LiveTickerTelemetry>>
): PlaybookPayload {
  const universe = customUniverse || PLAYBOOK_TICKER_UNIVERSE;

  const allCalls: PlaybookPick[] = [];
  const allPuts: PlaybookPick[] = [];

  for (const t of universe) {
    const telemetry = buildLiveTelemetryForTicker(
      t,
      telemetryOverrides?.[t]
    );
    allCalls.push(generateCallPick(telemetry));
    allPuts.push(generatePutPick(telemetry));
  }

  // Sort descending by quantitative conviction score
  allCalls.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  allPuts.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  const topCalls = allCalls.slice(0, 3);
  const topPuts = allPuts.slice(0, 3);

  const nowEt = new Date().toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).toUpperCase();

  return {
    sessionTitle: `HYPERION 0DTE SCAN — ${nowEt}`,
    subtitle:
      "Top 3 calls + top 3 puts · Calls trigger on a break above · Puts on a break below",
    rules:
      "How to play it: Wait for the trigger in the first 15–30 min. Once confirmed by a 5-min candle close outside the trigger, take the ATM/first OTM strike contract. Scale 50% at Target 1, trail stop-loss to break-even, and aim for the 0DTE Expected Move boundary at Target 2.",
    topCalls,
    topPuts,
    picks: [...topCalls, ...topPuts],
    updatedAt: new Date().toISOString(),
  };
}
