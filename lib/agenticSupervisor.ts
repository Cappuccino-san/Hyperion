import {
  classifyMarketRegime,
  computeDailyOptionTheta,
  estimateRemainingYears,
  MarketRegimeClassification,
  scoreSetupExpectancy,
} from "@/lib/alphaScorer";
import { FlowGammaVwapSnapshot } from "@/lib/flowGammaVwap";
import { etMinutesOfDay, getTodayEt } from "@/lib/gaiaSessionGuards";
import {
  AlphaFeatureWeights,
  AlphaPriorsState,
  CounterfactualEvalRecord,
  FeatureIcMap,
  MarketRegimeId,
  PostMarketAttributionReport,
  SessionPlaybookPolicy,
  cloneDefaultAlphaPriors,
  readAlphaPriorsSync,
  readPostMarketAttribution,
  readSupervisorPolicySync,
  writeAlphaPriors,
  writeAlphaPriorsSync,
  writePostMarketAttribution,
  writeSupervisorPolicy,
  writeSupervisorPolicySync,
} from "@/lib/persistenceStore";
import type { DailyTradeStore } from "@/lib/tradeSignalEngine";

export interface SessionPlaybookInput {
  sessionDate: string;
  ticker: string;
  nowMs?: number;
  spotPrice: number;
  prevSpotPrice?: number;
  callWall: number;
  putWall: number;
  zeroGamma: number;
  zeroDteKing?: number;
  allExpKing?: number;
  bookCenter?: number;
  netGex?: number;
  flowSnapshot?: FlowGammaVwapSnapshot | null;
  historicalSessions?: DailyTradeStore[];
  directionHint?: "CALL" | "PUT";
}

export interface AttributionBar {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  sma34?: number;
}

export interface AttributionCandidateSetup {
  timestamp: number;
  direction: "CALL" | "PUT";
  setupName: string;
  regime: MarketRegimeId;
  entrySpot: number;
  target1Spot: number;
  stopLossSpot: number;
  wasExecuted: boolean;
  skipReason?: string;
  realizedOptionR?: number;
}

export interface FeatureIcSample {
  features: FeatureIcMap;
  mfeR: number;
  maeR: number;
}

export interface RunPostMarketAttributionInput {
  sessionDate: string;
  ticker: string;
  bars: AttributionBar[];
  flowSeries?: FlowGammaVwapSnapshot[];
  callWall?: number;
  putWall?: number;
  zeroGamma?: number;
  zeroDteKing?: number;
  executedTrades?: DailyTradeStore["closedPositions"];
  candidateSetups?: AttributionCandidateSetup[];
  featureSamples?: FeatureIcSample[];
  atmIv?: number;
  force?: boolean;
  persist?: boolean;
  priorsOverride?: AlphaPriorsState;
}

function formatEtTimeShort(tsSec: number): string {
  try {
    return new Date(tsSec * 1000).toLocaleTimeString("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "16:05 ET";
  }
}

export function resolveSupervisorCheckpoint(
  etMins: number,
  zeroGammaFlipped: boolean
): SessionPlaybookPolicy["checkpoint"] {
  if (zeroGammaFlipped) return "ZERO_GAMMA_FLIP";
  if (etMins >= 780) return "AFTERNOON_1300";
  if (etMins >= 630) return "MID_MORNING_1030";
  if (etMins >= 575 && etMins < 600) return "OPEN_0935";
  return "INTRADAY";
}

/**
 * Computes trailing 5-day equity drawdown & net dollar P&L from durable session ledgers.
 */
export function computeTrailing5dEquityStats(
  sessions: DailyTradeStore[],
  excludeSessionDate?: string
): { trailing5dDrawdownDollars: number; trailing5dPnlDollars: number } {
  const prior = sessions
    .filter((s) => s && s.date && (!excludeSessionDate || s.date < excludeSessionDate))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-5);

  let equity = 0;
  let peak = 0;
  let maxDd = 0;

  for (const s of prior) {
    for (const p of s.closedPositions || []) {
      const entry = p.optionAsk || p.btoOptionMid || 0.5;
      const exit = p.closedOptionMid ?? entry;
      const qty = p.contractsQty || 1;
      const pnl = Number(((exit - entry) * 100 * qty).toFixed(2));
      equity += pnl;
      if (equity > peak) peak = equity;
      maxDd = Math.max(maxDd, peak - equity);
    }
  }

  return {
    trailing5dDrawdownDollars: Number(maxDd.toFixed(2)),
    trailing5dPnlDollars: Number(equity.toFixed(2)),
  };
}

/**
 * Evaluates and updates the intraday SessionPlaybookPolicy at scheduled checkpoints
 * (09:35, 10:30, 13:00 ET) or whenever Zero Gamma flips.
 */
export function evaluateSessionPlaybook(
  input: SessionPlaybookInput
): SessionPlaybookPolicy {
  const nowMs = input.nowMs ?? Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const etMins = etMinutesOfDay(nowSec);
  const sym = input.ticker.trim().toUpperCase();
  const sessionDate = input.sessionDate || getTodayEt(new Date(nowSec * 1000));

  const zeroGammaFlipped = Boolean(
    input.zeroGamma > 0 &&
      typeof input.prevSpotPrice === "number" &&
      input.prevSpotPrice > 0 &&
      ((input.prevSpotPrice <= input.zeroGamma && input.spotPrice > input.zeroGamma) ||
        (input.prevSpotPrice >= input.zeroGamma && input.spotPrice < input.zeroGamma))
  );

  const regimeInfo: MarketRegimeClassification = classifyMarketRegime({
    spotPrice: input.spotPrice,
    callWall: input.callWall,
    putWall: input.putWall,
    zeroGamma: input.zeroGamma,
    zeroDteKing: input.zeroDteKing,
    bookCenter: input.bookCenter,
    flowVwap: input.flowSnapshot?.flowVwap,
    netGex: input.netGex,
    flowSnapshot: input.flowSnapshot,
    directionHint: input.directionHint,
  });

  const kingDivPct =
    input.zeroDteKing &&
    input.allExpKing &&
    input.zeroDteKing > 0 &&
    input.allExpKing > 0
      ? Number(
          (
            (Math.abs(input.zeroDteKing - input.allExpKing) / Math.max(0.01, input.spotPrice)) *
            100
          ).toFixed(2)
        )
      : 0;

  const { trailing5dDrawdownDollars, trailing5dPnlDollars } = computeTrailing5dEquityStats(
    input.historicalSessions ?? [],
    sessionDate
  );

  let minExpectancyR = 0.35;
  let minWinRatePct = 58.0;
  let allowedRegimes: MarketRegimeId[] =
    regimeInfo.regime === "POS_GAMMA_PIN"
      ? ["POS_GAMMA_PIN", "ZERO_GAMMA_FLIP"]
      : regimeInfo.regime === "LOW_EDGE_CHOP"
        ? []
        : ["NEG_GAMMA_TREND", "ZERO_GAMMA_FLIP", "POS_GAMMA_PIN"];
  let preferredDte: SessionPlaybookPolicy["preferredDte"] = regimeInfo.preferredDte;
  let standAsideVetoReason: string | null = null;

  if (regimeInfo.shouldStandAside || regimeInfo.regime === "LOW_EDGE_CHOP") {
    standAsideVetoReason = regimeInfo.reason;
    allowedRegimes = [];
    preferredDte = "NONE";
  } else if (kingDivPct >= 0.8 && regimeInfo.absPeclet < 1.2) {
    standAsideVetoReason = `0DTE/All-Exp King conflict (${kingDivPct.toFixed(2)}%) with weak advection (|Pe|=${regimeInfo.absPeclet.toFixed(2)})`;
    allowedRegimes = [];
    preferredDte = "NONE";
  }

  // Drawdown protection governor: if 5d drawdown exceeds $150, raise required E[R] & win rate
  if (trailing5dDrawdownDollars >= 150 && !standAsideVetoReason) {
    minExpectancyR = 0.5;
    minWinRatePct = 62.0;
    allowedRegimes = allowedRegimes.filter((r) => r === regimeInfo.regime);
  }

  const zeroGammaSide: SessionPlaybookPolicy["zeroGammaSide"] =
    input.zeroGamma <= 0
      ? "AT"
      : input.spotPrice > input.zeroGamma * 1.0005
        ? "ABOVE"
        : input.spotPrice < input.zeroGamma * 0.9995
          ? "BELOW"
          : "AT";

  const checkpoint = resolveSupervisorCheckpoint(etMins, zeroGammaFlipped);
  const evaluatedAtEt = formatEtTimeShort(nowSec);
  const summary = standAsideVetoReason
    ? `STAND ASIDE · ${standAsideVetoReason}`
    : `${regimeInfo.regime} · Pref ${preferredDte} · Min E[R] +${minExpectancyR.toFixed(2)}R (${minWinRatePct.toFixed(0)}% WR)`;

  return {
    sessionDate,
    ticker: sym,
    checkpoint,
    evaluatedAtEt,
    evaluatedAtTs: nowSec,
    regime: regimeInfo.regime,
    allowedRegimes,
    preferredDte,
    minExpectancyR,
    minWinRatePct,
    standAsideVetoReason,
    kingDivergencePct: kingDivPct,
    trailing5dDrawdownDollars,
    trailing5dPnlDollars,
    zeroGammaSide,
    wallCorridorPct: regimeInfo.wallCorridorPct,
    absPeclet: regimeInfo.absPeclet,
    summary,
  };
}

export function shouldRefreshSupervisorCheckpoint(
  existing: SessionPlaybookPolicy | null,
  etMins: number,
  zeroGammaFlipped: boolean,
  currentAbsPeclet?: number
): boolean {
  if (!existing) return true;
  if (zeroGammaFlipped) return true;
  if (
    existing.standAsideVetoReason &&
    typeof currentAbsPeclet === "number" &&
    Math.abs(currentAbsPeclet) >= 1.2
  ) {
    return true;
  }
  const targetCheckpoint = resolveSupervisorCheckpoint(etMins, false);
  if (existing.checkpoint !== targetCheckpoint) return true;
  return false;
}

export function evaluateAndPersistSessionPlaybookSync(
  input: SessionPlaybookInput
): SessionPlaybookPolicy {
  const policy = evaluateSessionPlaybook(input);
  writeSupervisorPolicySync(policy);
  return policy;
}

export async function evaluateAndPersistSessionPlaybook(
  input: SessionPlaybookInput
): Promise<SessionPlaybookPolicy> {
  const policy = evaluateSessionPlaybook(input);
  await writeSupervisorPolicy(policy);
  return policy;
}

export function getLatestSupervisorPolicy(
  sessionDate: string,
  ticker: string = "SPY"
): SessionPlaybookPolicy | null {
  return readSupervisorPolicySync(sessionDate, ticker);
}

/**
 * Evaluates MFE/MAE & Black-Scholes theta-adjusted counterfactual R-multiple
 * with pessimistic adverse-wick-first ordering across up to `maxHorizonBars` future 5m bars.
 */
function simulateCounterfactualSetup(params: {
  bars: AttributionBar[];
  startIdx: number;
  direction: "CALL" | "PUT";
  entrySpot: number;
  target1Spot: number;
  stopLossSpot: number;
  atmIv: number;
  maxHorizonBars?: number;
}): { outcomeR: number; mfeR: number; maeR: number; thetaAdjustedPnlPct: number } {
  const {
    bars,
    startIdx,
    direction,
    entrySpot,
    target1Spot,
    stopLossSpot,
    atmIv,
    maxHorizonBars = 12,
  } = params;

  const isCall = direction === "CALL";
  const risk = Math.max(0.1, Math.abs(entrySpot - stopLossSpot));
  const targetDist = Math.abs(target1Spot - entrySpot);
  const targetR = Number((targetDist / risk).toFixed(2));

  let mfe = 0;
  let mae = 0;
  let realizedR = 0;
  let hitTerminal = false;
  let exitSpot = bars[startIdx]?.close ?? entrySpot;
  let exitIdx = startIdx;

  const endIdx = Math.min(bars.length - 1, startIdx + maxHorizonBars);
  for (let j = startIdx + 1; j <= endIdx; j++) {
    const b = bars[j];
    const barFav = isCall ? b.high - entrySpot : entrySpot - b.low;
    const barAdv = isCall ? entrySpot - b.low : b.high - entrySpot;
    mfe = Math.max(mfe, barFav);
    mae = Math.max(mae, barAdv);

    // Pessimistic intrabar ordering: check stop-loss adverse extreme first
    if ((isCall && b.low <= stopLossSpot) || (!isCall && b.high >= stopLossSpot)) {
      realizedR = -1.0;
      exitSpot = stopLossSpot;
      exitIdx = j;
      hitTerminal = true;
      break;
    }
    if ((isCall && b.high >= target1Spot) || (!isCall && b.low <= target1Spot)) {
      realizedR = targetR;
      exitSpot = target1Spot;
      exitIdx = j;
      hitTerminal = true;
      break;
    }
    exitSpot = b.close;
    exitIdx = j;
  }

  if (!hitTerminal) {
    const dirMove = isCall ? exitSpot - entrySpot : entrySpot - exitSpot;
    realizedR = Number((dirMove / risk).toFixed(2));
  }

  // Approximate Black-Scholes theta-adjusted option % return assuming ~0.40 delta sub-$1 contract
  const entryTsMs = (bars[startIdx]?.ts ?? 0) * 1000;
  const heldDays = Math.max(1 / 78, (exitIdx - startIdx) / 78);
  const tYears = estimateRemainingYears(entryTsMs || Date.now(), 0);
  const dailyTheta = Math.abs(
    computeDailyOptionTheta(entrySpot, Math.round(entrySpot), tYears, atmIv, isCall)
  );
  const estOptionBase = 0.65;
  const deltaGain = (isCall ? exitSpot - entrySpot : entrySpot - exitSpot) * 0.4;
  const thetaDecay = dailyTheta * heldDays;
  const thetaAdjustedPnlPct = Number(
    (Math.max(-25, ((deltaGain - thetaDecay) / estOptionBase) * 100)).toFixed(1)
  );

  // If directional move didn't cover theta decay on a flat horizon hold, adjust R downward
  const adjustedR =
    !hitTerminal && thetaAdjustedPnlPct < 0 && realizedR >= 0
      ? Number((realizedR - 0.15).toFixed(2))
      : realizedR;

  return {
    outcomeR: adjustedR,
    mfeR: Number((mfe / risk).toFixed(2)),
    maeR: Number((mae / risk).toFixed(2)),
    thetaAdjustedPnlPct,
  };
}

const FEATURE_KEYS: Array<keyof AlphaFeatureWeights> = [
  "fluxAlignment",
  "flowVwapBand",
  "wallRoom",
  "kingMagnet",
  "mtfDivergence",
  "regimeFit",
];

function zeroFeatureIc(): FeatureIcMap {
  return {
    fluxAlignment: 0,
    flowVwapBand: 0,
    wallRoom: 0,
    kingMagnet: 0,
    mtfDivergence: 0,
    regimeFit: 0,
  };
}

function pearsonCorrelation(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return 0;
  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < n; i++) {
    sumX += xs[i];
    sumY += ys[i];
  }
  const meanX = sumX / n;
  const meanY = sumY / n;
  let cov = 0;
  let varX = 0;
  let varY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }
  if (varX <= 1e-9 || varY <= 1e-9) return 0;
  const r = cov / Math.sqrt(varX * varY);
  if (!Number.isFinite(r)) return 0;
  return Number(Math.max(-1, Math.min(1, r)).toFixed(4));
}

/**
 * Computes out-of-sample Information Coefficient (IC) for each alpha feature against
 * forward 6-bar directional payoff asymmetry (mfeR - maeR).
 */
export function computeFeatureInformationCoefficients(input: {
  bars?: AttributionBar[];
  flowSeries?: FlowGammaVwapSnapshot[];
  callWall?: number;
  putWall?: number;
  zeroGamma?: number;
  zeroDteKing?: number;
  priors?: AlphaPriorsState;
  samples?: FeatureIcSample[];
}): FeatureIcMap {
  let samples: FeatureIcSample[] = input.samples ? [...input.samples] : [];

  if (samples.length === 0 && Array.isArray(input.bars) && input.bars.length >= 13) {
    const bars = [...input.bars].sort((a, b) => a.ts - b.ts);
    const flowSeries = input.flowSeries ?? [];
    for (let i = 6; i < bars.length - 6; i++) {
      const b = bars[i];
      const flow = flowSeries[i];
      const priorSlice = bars.slice(0, i + 1);
      const cw =
        input.callWall && input.callWall > 0
          ? input.callWall
          : Math.ceil(Math.max(...priorSlice.map((x) => x.high)));
      const pw =
        input.putWall && input.putWall > 0
          ? input.putWall
          : Math.floor(Math.min(...priorSlice.map((x) => x.low)));
      const zg = input.zeroGamma && input.zeroGamma > 0 ? input.zeroGamma : flow?.flowVwap ?? b.close;
      const direction: "CALL" | "PUT" =
        (flow?.netFluxJ ?? (b.close - b.open)) >= 0 ? "CALL" : "PUT";
      const isCall = direction === "CALL";
      const risk = Math.max(0.2, b.close * 0.0014);
      const stopLossSpot = isCall ? b.close - risk : b.close + risk;
      const target1Spot = isCall ? b.close + risk * 1.5 : b.close - risk * 1.5;
      const target2Spot = isCall ? b.close + risk * 2.5 : b.close - risk * 2.5;

      const regimeInfo = classifyMarketRegime({
        spotPrice: b.close,
        callWall: cw,
        putWall: pw,
        zeroGamma: zg,
        zeroDteKing: input.zeroDteKing,
        flowSnapshot: flow,
        directionHint: direction,
      });
      const scored = scoreSetupExpectancy({
        direction,
        setupName: isCall ? "Impulse Flux Reclaim" : "Bearish Zero-Gamma Flush",
        spotPrice: b.close,
        stopLossSpot,
        target1Spot,
        target2Spot,
        callWall: cw,
        putWall: pw,
        zeroGamma: zg,
        zeroDteKing: input.zeroDteKing,
        flowSnapshot: flow,
        regimeClassification: regimeInfo,
        priors: input.priors,
      });

      let mfe = 0;
      let mae = 0;
      const endIdx = Math.min(bars.length - 1, i + 6);
      for (let j = i + 1; j <= endIdx; j++) {
        const fb = bars[j];
        const fav = isCall ? fb.high - b.close : b.close - fb.low;
        const adv = isCall ? b.close - fb.low : fb.high - b.close;
        mfe = Math.max(mfe, fav);
        mae = Math.max(mae, adv);
      }

      samples.push({
        features: scored.featureBreakdown,
        mfeR: mfe / risk,
        maeR: mae / risk,
      });
    }
  }

  if (samples.length < 3) {
    return zeroFeatureIc();
  }

  const netR = samples.map((s) => s.mfeR - s.maeR);
  const out = zeroFeatureIc();
  for (const key of FEATURE_KEYS) {
    out[key] = pearsonCorrelation(
      samples.map((s) => s.features[key]),
      netR
    );
  }
  return out;
}

/**
 * Post-Market Counterfactual Attribution Engine (16:05 ET)
 * Replays the day's 5m bars, evaluates executed + skipped setups with pessimistic fills
 * and theta decay, computes rolling Feature ICs, and adapts Empirical Bayes priors for [D+1].
 */
export async function runPostMarketAttribution(
  input: RunPostMarketAttributionInput
): Promise<PostMarketAttributionReport> {
  const sym = input.ticker.trim().toUpperCase();
  const priors: AlphaPriorsState = input.priorsOverride
    ? JSON.parse(JSON.stringify(input.priorsOverride))
    : JSON.parse(JSON.stringify(readAlphaPriorsSync()));

  if (!input.force && priors.lastAttributionDate === input.sessionDate) {
    const existing = await readPostMarketAttribution(input.sessionDate, sym);
    if (existing) return existing;
  }

  const bars = [...input.bars].sort((a, b) => a.ts - b.ts);
  const flowSeries = input.flowSeries ?? [];
  const atmIv = input.atmIv ?? 0.18;
  const records: CounterfactualEvalRecord[] = [];

  // 1. Score executed closed trades
  for (const pos of input.executedTrades ?? []) {
    const entryAsk = pos.optionAsk || pos.btoOptionMid || 0.5;
    const exitBid = pos.closedOptionMid ?? entryAsk;
    const pnlPct =
      typeof pos.pnlOptionPct === "number"
        ? pos.pnlOptionPct
        : Number((((exitBid - entryAsk) / Math.max(0.01, entryAsk)) * 100).toFixed(1));
    const realizedR = Number((pnlPct / 25).toFixed(2));
    const idx = bars.findIndex((b) => b.ts >= (pos.openedTs || 0));
    const flow = idx >= 0 ? flowSeries[idx] : undefined;
    const regimeInfo = classifyMarketRegime({
      spotPrice: pos.btoSpotPrice,
      callWall: input.callWall ?? pos.target2Spot,
      putWall: input.putWall ?? pos.stopLossSpot,
      zeroGamma: input.zeroGamma ?? pos.btoSpotPrice,
      zeroDteKing: input.zeroDteKing,
      flowSnapshot: flow,
      directionHint: pos.contractType,
    });
    const sim =
      idx >= 0
        ? simulateCounterfactualSetup({
            bars,
            startIdx: idx,
            direction: pos.contractType,
            entrySpot: pos.btoSpotPrice,
            target1Spot: pos.target1Spot,
            stopLossSpot: pos.stopLossSpot,
            atmIv,
          })
        : { outcomeR: realizedR, mfeR: Math.max(0, realizedR), maeR: realizedR < 0 ? 1 : 0, thetaAdjustedPnlPct: pnlPct };

    records.push({
      timestamp: pos.openedTs || 0,
      timeEt: pos.openedAt || formatEtTimeShort(pos.openedTs || 0),
      direction: pos.contractType,
      setupName: pos.setupName,
      regime: regimeInfo.regime,
      wasExecuted: true,
      entrySpot: pos.btoSpotPrice,
      target1Spot: pos.target1Spot,
      stopLossSpot: pos.stopLossSpot,
      realizedOptionR: realizedR,
      mfeR: sim.mfeR,
      maeR: sim.maeR,
      thetaAdjustedPnlPct: pnlPct,
    });
  }

  // 2. Evaluate explicit or automatically discovered skipped candidate setups
  const candidates: AttributionCandidateSetup[] = [...(input.candidateSetups ?? [])];
  if (candidates.length === 0 && bars.length >= 12) {
    for (let i = 6; i < bars.length - 4; i += 6) {
      const b = bars[i];
      const flow = flowSeries[i];
      const regimeInfo = classifyMarketRegime({
        spotPrice: b.close,
        callWall: input.callWall ?? Math.ceil(b.high + 2),
        putWall: input.putWall ?? Math.floor(b.low - 2),
        zeroGamma: input.zeroGamma ?? flow?.flowVwap ?? b.close,
        zeroDteKing: input.zeroDteKing,
        flowSnapshot: flow,
      });
      if (regimeInfo.shouldStandAside || (flow && Math.abs(flow.pecletNumber ?? 0) < 1.2)) {
        const dir: "CALL" | "PUT" = b.close >= b.open ? "CALL" : "PUT";
        const risk = Math.max(0.5, b.close * 0.0014);
        candidates.push({
          timestamp: b.ts,
          direction: dir,
          setupName: "Skipped Chop Setup",
          regime: regimeInfo.regime,
          entrySpot: b.close,
          target1Spot: dir === "CALL" ? b.close + risk * 1.5 : b.close - risk * 1.5,
          stopLossSpot: dir === "CALL" ? b.close - risk : b.close + risk,
          wasExecuted: false,
          skipReason: regimeInfo.reason,
        });
      }
    }
  }

  for (const cand of candidates) {
    if (cand.wasExecuted) continue;
    const idx = Math.max(
      0,
      bars.findIndex((b) => b.ts >= cand.timestamp)
    );
    const sim = simulateCounterfactualSetup({
      bars,
      startIdx: idx,
      direction: cand.direction,
      entrySpot: cand.entrySpot,
      target1Spot: cand.target1Spot,
      stopLossSpot: cand.stopLossSpot,
      atmIv,
    });
    records.push({
      timestamp: cand.timestamp,
      timeEt: formatEtTimeShort(cand.timestamp),
      direction: cand.direction,
      setupName: cand.setupName,
      regime: cand.regime,
      wasExecuted: false,
      skipReason: cand.skipReason,
      entrySpot: cand.entrySpot,
      target1Spot: cand.target1Spot,
      stopLossSpot: cand.stopLossSpot,
      realizedOptionR: sim.outcomeR,
      mfeR: sim.mfeR,
      maeR: sim.maeR,
      thetaAdjustedPnlPct: sim.thetaAdjustedPnlPct,
    });
  }

  // 3. Update Empirical Bayes Regime Stats & Bounded Feature Weights
  const executed = records.filter((r) => r.wasExecuted);
  const skipped = records.filter((r) => !r.wasExecuted);
  const executedAvgR =
    executed.length > 0
      ? Number((executed.reduce((s, r) => s + r.realizedOptionR, 0) / executed.length).toFixed(2))
      : 0;
  const skippedCounterfactualAvgR =
    skipped.length > 0
      ? Number((skipped.reduce((s, r) => s + r.realizedOptionR, 0) / skipped.length).toFixed(2))
      : 0;
  const missedAlphaCount = skipped.filter((r) => r.realizedOptionR > 0.35).length;
  const savedChopCount = skipped.filter((r) => r.realizedOptionR <= 0).length;

  for (const rec of executed) {
    const stat = priors.regimeStats[rec.regime] ?? {
      wins: 0,
      losses: 0,
      sumR: 0,
      avgR: 0,
      winRatePct: 50,
    };
    if (rec.realizedOptionR > 0) stat.wins += 1;
    else stat.losses += 1;
    stat.sumR = Number((stat.sumR + rec.realizedOptionR).toFixed(2));
    const n = Math.max(1, stat.wins + stat.losses);
    stat.avgR = Number((stat.sumR / n).toFixed(2));
    stat.winRatePct = Number(((stat.wins / n) * 100).toFixed(1));
    stat.lastUpdatedDate = input.sessionDate;
    priors.regimeStats[rec.regime] = stat;
  }

  // Gentle weight update + Information Coefficient decay:
  // Compute out-of-sample Feature IC against forward 6-bar MFE/MAE; decay weights with negative IC toward 0.60 floor.
  const clampWeight = (val: number) => Number(Math.max(0.6, Math.min(1.6, val)).toFixed(3));
  const sessionIc = computeFeatureInformationCoefficients({
    bars,
    flowSeries,
    callWall: input.callWall,
    putWall: input.putWall,
    zeroGamma: input.zeroGamma,
    zeroDteKing: input.zeroDteKing,
    priors,
    samples: input.featureSamples,
  });

  const prevRollingIc = priors.rollingFeatureIc ?? zeroFeatureIc();
  const nextRollingIc = zeroFeatureIc();
  for (const key of FEATURE_KEYS) {
    nextRollingIc[key] = Number(
      (priors.rollingFeatureIc
        ? prevRollingIc[key] * 0.65 + sessionIc[key] * 0.35
        : sessionIc[key]
      ).toFixed(4)
    );
    const effectiveIc = sessionIc[key] < 0 ? sessionIc[key] : nextRollingIc[key];
    if (effectiveIc < 0) {
      const decayMagnitude = Math.max(0.03, Math.min(0.25, Math.abs(effectiveIc) * 0.35));
      priors.featureWeights[key] = clampWeight(priors.featureWeights[key] - decayMagnitude);
    } else if (sessionIc[key] > 0.15 && nextRollingIc[key] > 0.1) {
      priors.featureWeights[key] = clampWeight(priors.featureWeights[key] + 0.02);
    }
  }
  priors.rollingFeatureIc = nextRollingIc;

  if (executed.length > 0) {
    if (executedAvgR > 0.3) {
      if (sessionIc.fluxAlignment >= 0) {
        priors.featureWeights.fluxAlignment = clampWeight(priors.featureWeights.fluxAlignment + 0.03);
      }
      if (sessionIc.wallRoom >= 0) {
        priors.featureWeights.wallRoom = clampWeight(priors.featureWeights.wallRoom + 0.02);
      }
    } else if (executedAvgR < 0) {
      if (sessionIc.regimeFit >= 0) {
        priors.featureWeights.regimeFit = clampWeight(priors.featureWeights.regimeFit + 0.04);
      }
      if (sessionIc.kingMagnet >= 0) {
        priors.featureWeights.kingMagnet = clampWeight(priors.featureWeights.kingMagnet + 0.03);
      }
    }
  }
  if (missedAlphaCount > savedChopCount) {
    priors.baselineExpectancyR = Number(
      Math.max(0.28, Math.min(0.6, priors.baselineExpectancyR - 0.01)).toFixed(3)
    );
  } else if (savedChopCount > missedAlphaCount && sessionIc.regimeFit >= 0) {
    priors.featureWeights.regimeFit = clampWeight(priors.featureWeights.regimeFit + 0.03);
  }

  priors.updatedAt = new Date().toISOString();
  priors.lastAttributionDate = input.sessionDate;

  const updatedPriorsSummary =
    `RegimeFit=${priors.featureWeights.regimeFit.toFixed(2)} Flux=${priors.featureWeights.fluxAlignment.toFixed(2)} ` +
    `IC(Flux=${sessionIc.fluxAlignment.toFixed(2)},Regime=${sessionIc.regimeFit.toFixed(2)}) ` +
    `SavedChop=${savedChopCount} MissedAlpha=${missedAlphaCount}`;

  const report: PostMarketAttributionReport = {
    sessionDate: input.sessionDate,
    ticker: sym,
    evaluatedAtEt: bars.length > 0 ? formatEtTimeShort(bars[bars.length - 1].ts) : "4:05 PM",
    executedCount: executed.length,
    executedAvgR,
    skippedCount: skipped.length,
    skippedCounterfactualAvgR,
    missedAlphaCount,
    savedChopCount,
    featureIc: sessionIc,
    updatedPriorsSummary,
    records,
  };

  if (input.persist !== false) {
    writeAlphaPriorsSync(priors);
    await writeAlphaPriors(priors);
    await writePostMarketAttribution(report);
  }

  return report;
}

export { cloneDefaultAlphaPriors };
