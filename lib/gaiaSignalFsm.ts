/**
 * Gaia Signal Finite State Machine (Non-Repainting Institutional Architecture)
 *
 * Implements strict online causal evaluation (Zero Lookahead):
 * 1. Dispersion around structural equilibrium: chi_0 = 0.50, flux_0 = 0.0 (No drifting-mean suicide)
 * 2. Strictly causal rolling volatility baseline (bars 0..i, using pre-market for 9:30 AM warm-up)
 * 3. Mutually exclusive macro regime gating (Bull Macro forbids SHORT; Bear Macro forbids LONG)
 * 4. Multi-bar exit hysteresis (requires 2 consecutive closed bars against position to exit)
 * 5. Dynamic bar duration inference and explicit RTH gating (9:30 AM - 4:00 PM ET)
 */

import {
  ENTRY_CUTOFF_MINS,
  ENTRY_START_MINS,
  EOD_FORCE_FLAT_MINS,
  RTH_CLOSE_MINS,
  RTH_OPEN_MINS,
  etMinutesOfDay,
} from "./gaiaSessionGuards";

export type GaiaFsmState = "STAND_ASIDE" | "LONG" | "SHORT";

/** Structural map supplied by the options book (all optional; omitted → equilibrium-only logic). */
export interface GaiaStructuralLevels {
  zeroGamma?: number;
  callWall?: number;
  putWall?: number;
  bookCenter?: number;
  priorClose?: number;
  pdh?: number;
  pdl?: number;
  sigma1dLower?: number;
  sigma1dUpper?: number;
}

export const GAIA_RTH_OPEN_MINS = RTH_OPEN_MINS;
export const GAIA_ENTRY_START_MINS = ENTRY_START_MINS;
export const GAIA_ENTRY_CUTOFF_MINS = ENTRY_CUTOFF_MINS;
export const GAIA_EOD_FORCE_FLAT_MINS = EOD_FORCE_FLAT_MINS;
export const GAIA_RTH_CLOSE_MINS = RTH_CLOSE_MINS;

/** Wall proximity: never buy into a wall closer than this (underlying $). */
const WALL_BLOCK_DOLLARS = 1.25;
/** Structural take-profit fires when price trades within this distance of the target wall. */
const TARGET_TOUCH_DOLLARS = 0.25;
/** Minimum hold before non-stop reversal exits (2 closed 5m bars = 10 min). */
const MIN_HOLD_BARS = 2;
/** Minimum underlying adverse move ($) for momentum reversal exit. */
const MIN_REVERSAL_ADVERSE_DOLLARS = 0.75;
/** Cooldown between Phase 1 exit and Phase 2 opposite-regime entry (30 min = 1800s). */
const PHASE2_COOLDOWN_SEC = 1800;
/** Minimum reward:risk to the structural target. */
const MIN_REWARD_RISK = 1.5;

export interface GaiaBarData {
  barTimestamp: number; // Bar open in epoch seconds
  barCloseTimestamp?: number;
  barSpanSeconds?: number;
  etMins?: number; // Minutes from midnight ET (570 = 9:30 AM, 960 = 16:00 ET)
  open: number;
  high: number;
  low: number;
  close: number;
  chi: number;
  bias: number;
  netFlux: number;
  peclet: number;
  flowVwap?: number;
  prevFlowVwap?: number;
  vwapSlope?: number;
  upperBand1?: number;
  lowerBand1?: number;
  upperBand2?: number;
  lowerBand2?: number;
  sma34?: number;
  prevSma34?: number;
  prevChi?: number;
  prevNetFlux?: number;
  recentHigh3?: number; // Max high over bars [i-3..i]
  recentLow4?: number; // Min low over bars [i-4..i]
  bullDiv5m?: boolean; // Confirmed 5m bullish divergence within the last few bars
  bearDiv5m?: boolean; // Confirmed 5m bearish divergence within the last few bars
  isClosed: boolean;
}

export interface GaiaMacroContext {
  macroRegime: "CALL" | "PUT";
  sessionBiasScore?: number; // SES driver (-99 to +99)
  callDominancePct?: number; // Header chi% (0 to 100)
  structuralLevels?: GaiaStructuralLevels;
}

/**
 * Resolves ET minutes-of-day for a bar. Uses bar.etMins when present, otherwise derives
 * it from a real epoch timestamp. Returns undefined for synthetic timestamps (legacy/test
 * bars without time info), in which case time gates are not applied.
 */
export function resolveGaiaBarEtMinutes(bar: Pick<GaiaBarData, "etMins" | "barTimestamp">): number | undefined {
  if (typeof bar.etMins === "number" && Number.isFinite(bar.etMins)) return bar.etMins;
  if (typeof bar.barTimestamp === "number" && bar.barTimestamp > 1e9) return etMinutesOfDay(bar.barTimestamp);
  return undefined;
}

interface TransitionResult {
  nextState: GaiaFsmState;
  reason?: string;
  /** Fill price for exits that occur at a level (target touch / stop) rather than the bar close. */
  fillPrice?: number;
  targetWall?: number;
  stopPrice?: number;
}

export interface GaiaEquilibriumDispersion {
  sigmaChi: number;
  sigmaFlux: number;
  barDurationSec: number;
  atr: number;
}

export interface GaiaCommittedSignal {
  id: string;
  idempotencyKey: string; // `${barTimestamp}_${toState}`
  sequence: number;
  barTimestamp: number;
  barCloseTimestamp: number;
  barSpanSeconds: number;
  fromState: GaiaFsmState;
  toState: GaiaFsmState;
  reason: string;
  price: number;
  chi: number;
  chiPct: number;
  bias: number;
  netFlux: number;
  peclet: number;
  isHistoricalBackfill: boolean;
  entryPrice?: number;
  exitPrice?: number;
  realizedPnl?: number;
  targetWallPrice?: number;
  stopLossPrice?: number;
}

export interface GaiaFsmSnapshot {
  committedState: GaiaFsmState;
  livePreviewState: GaiaFsmState;
  isPendingTransition: boolean;
  committedCallLog: GaiaCommittedSignal[];
}

/**
 * Computes causal dispersion around physical equilibrium (chi=0.5, flux=0.0)
 * using only historical bars up to the current evaluation index (zero lookahead).
 */
export function computeCausalEquilibriumDispersion(
  bars: GaiaBarData[],
  uptoIndex: number
): GaiaEquilibriumDispersion {
  const k = Math.min(bars.length, Math.max(1, uptoIndex + 1));
  const slice = bars.slice(0, k);

  // Compute dynamic bar duration from consecutive timestamps
  const intervals: number[] = [];
  for (let i = 1; i < slice.length; i++) {
    const dt = Math.abs(slice[i].barTimestamp - slice[i - 1].barTimestamp);
    if (dt >= 10 && dt <= 86400) {
      intervals.push(dt);
    }
  }
  intervals.sort((a, b) => a - b);
  const barDurationSec =
    intervals.length > 0 ? intervals[Math.floor(intervals.length / 2)] : 300;

  let sumSqChiDev = 0;
  let sumSqFluxDev = 0;
  let sumTr = 0;
  const atrPeriod = Math.min(14, slice.length);
  const atrStart = slice.length - atrPeriod;

  for (let j = 0; j < slice.length; j++) {
    const b = slice[j];
    const chiDev = b.chi - 0.50;
    const fluxDev = b.netFlux;
    sumSqChiDev += chiDev * chiDev;
    sumSqFluxDev += fluxDev * fluxDev;

    if (j >= atrStart) {
      const prevClose = j > 0 ? slice[j - 1].close : b.open;
      const tr = Math.max(
        b.high - b.low,
        Math.abs(b.high - prevClose),
        Math.abs(b.low - prevClose)
      );
      sumTr += tr;
    }
  }

  // Rolling RMS around structural equilibrium (chi=0.5, flux=0.0)
  const rmsChi = Math.sqrt(sumSqChiDev / slice.length);
  const rmsFlux = Math.sqrt(sumSqFluxDev / slice.length);
  const rawAtr = atrPeriod > 0 ? sumTr / atrPeriod : 0.5;
  const latestClose = slice[slice.length - 1]?.close || 100;
  const atr = Math.max(rawAtr, latestClose * 0.0008);

  return {
    sigmaChi: Math.max(rmsChi, 0.035),
    sigmaFlux: Math.max(rmsFlux, 0.045),
    barDurationSec,
    atr,
  };
}

export class GaiaSignalFsm {
  private committedState: GaiaFsmState = "STAND_ASIDE";
  private committedCallLog: GaiaCommittedSignal[] = [];
  private committedBarTimestamps = new Set<number>();
  private localExtremePrice: number = 0;
  private currentEntryPrice: number = 0;
  private activeTargetWall: number = 0;
  private activeStopPrice: number = 0;
  private activeSetupReason: string = "";
  private prevBarLow: number = 0;
  private prevBarHigh: number = 0;
  private barsHeld: number = 0;
  private closedTradesToday: number = 0;
  private lastClosedDirection: "LONG" | "SHORT" | null = null;
  private lastExitBarTs: number = 0;
  private phase1WinnerLocked: boolean = false;

  constructor(initialState: GaiaFsmState = "STAND_ASIDE") {
    this.committedState = initialState;
  }

  public reset(initialState: GaiaFsmState = "STAND_ASIDE"): void {
    this.committedState = initialState;
    this.committedCallLog = [];
    this.committedBarTimestamps.clear();
    this.localExtremePrice = 0;
    this.currentEntryPrice = 0;
    this.activeTargetWall = 0;
    this.activeStopPrice = 0;
    this.activeSetupReason = "";
    this.prevBarLow = 0;
    this.prevBarHigh = 0;
    this.barsHeld = 0;
    this.closedTradesToday = 0;
    this.lastClosedDirection = null;
    this.lastExitBarTs = 0;
    this.phase1WinnerLocked = false;
  }

  /**
   * Evaluates state transition strictly aligned with structural macro regime
   * and structural equilibrium dispersion.
   */
  public evaluateTransition(
    currentState: GaiaFsmState,
    bar: GaiaBarData,
    dispersion: GaiaEquilibriumDispersion,
    macro?: GaiaMacroContext,
    trackedLocalExtreme: number = 0,
    entryPriceRef: number = 0,
    targetWallRef: number = 0
  ): TransitionResult {
    const etMins = resolveGaiaBarEtMinutes(bar);

    // 1. Strict After-Hours & Pre-Market Firewall (< 09:30 ET or >= 16:00 ET)
    if (typeof etMins === "number" && (etMins < GAIA_RTH_OPEN_MINS || etMins >= GAIA_RTH_CLOSE_MINS)) {
      return { nextState: currentState };
    }

    // 2. Mandatory 15:55 ET Hard EOD Flat Liquidation
    if (typeof etMins === "number" && etMins >= GAIA_EOD_FORCE_FLAT_MINS) {
      if (currentState !== "STAND_ASIDE") {
        return { nextState: "STAND_ASIDE", reason: "EOD_1555_FORCE_CLOSE", fillPrice: bar.close };
      }
      return { nextState: "STAND_ASIDE" };
    }

    // 3. Strict Entry Window (09:30 open bar / 09:35 closed bar through 14:30 ET)
    const isWithinEntryWindow = typeof etMins === "number"
      ? (etMins >= GAIA_ENTRY_START_MINS && etMins <= GAIA_ENTRY_CUTOFF_MINS)
      : false;

    // Excursion from structural equilibrium (chi=0.5, flux=0.0)
    const eChi = (bar.chi - 0.50) / dispersion.sigmaChi;
    const eFlux = bar.netFlux / dispersion.sigmaFlux;

    // Mutually exclusive macro regime gating: chi >= 0.50 is strictly Bull Macro, < 0.50 is strictly Bear Macro
    const effectiveChi = typeof macro?.callDominancePct === "number" ? macro.callDominancePct / 100 : bar.chi;
    const isBullMacro = macro
      ? (macro.macroRegime === "CALL" || effectiveChi >= 0.50)
      : bar.chi >= 0.50;
    const isBearMacro = !isBullMacro;

    // Dynamic SNR Flux Threshold scaled by normalized session volatility
    const volRatio = dispersion.atr / Math.max(1, bar.close * 0.0035);
    const zFluxThreshold = Math.max(0.50, Math.min(1.20, 0.50 + volRatio * 0.25));

    // Dynamic VWAP slope calculation if not pre-computed
    const vwapSlope =
      bar.vwapSlope ??
      (bar.flowVwap !== undefined && bar.prevFlowVwap !== undefined
        ? bar.flowVwap - bar.prevFlowVwap
        : 0);

    const levels = macro?.structuralLevels;
    const zg = levels?.zeroGamma && levels.zeroGamma > 0 ? levels.zeroGamma : undefined;
    const callWall = levels?.callWall && levels.callWall > 0 ? levels.callWall : undefined;
    const putWall = levels?.putWall && levels.putWall > 0 ? levels.putWall : undefined;
    const bookCenter = levels?.bookCenter && levels.bookCenter > 0 ? levels.bookCenter : undefined;
    const pdh = levels?.pdh && levels.pdh > 0 ? levels.pdh : undefined;
    const pdl = levels?.pdl && levels.pdl > 0 ? levels.pdl : undefined;
    const sigma1dLower = levels?.sigma1dLower && levels.sigma1dLower > 0 ? levels.sigma1dLower : undefined;

    // Overhead & Underlying Wall Proximity Computation
    const overheadCandidates = [callWall, zg].filter(
      (lvl): lvl is number => typeof lvl === "number" && lvl > bar.close
    );
    const nearestOverheadWall =
      overheadCandidates.length > 0 ? Math.min(...overheadCandidates) : undefined;
    const callBlockedByWall =
      nearestOverheadWall !== undefined && nearestOverheadWall - bar.close < WALL_BLOCK_DOLLARS;

    const putBlockedByWall =
      putWall !== undefined && putWall < bar.close && bar.close - putWall < WALL_BLOCK_DOLLARS;

    const unitRisk = Math.max(0.90, 1.15 * dispersion.atr);

    if (currentState === "STAND_ASIDE") {
      if (!isWithinEntryWindow) {
        return { nextState: "STAND_ASIDE" };
      }
      if (this.closedTradesToday >= 2 || this.phase1WinnerLocked) {
        return { nextState: "STAND_ASIDE" };
      }
      if (this.closedTradesToday === 1) {
        const phase2WindowOk = typeof etMins === "number" ? etMins >= 645 && etMins <= 870 : true;
        const cooldownOk = this.lastExitBarTs > 0 ? bar.barTimestamp - this.lastExitBarTs >= PHASE2_COOLDOWN_SEC : false;
        if (!phase2WindowOk || !cooldownOk) {
          return { nextState: "STAND_ASIDE" };
        }
      }
      const allowShort = this.closedTradesToday === 0 || this.lastClosedDirection === "LONG";
      const allowLong = this.closedTradesToday === 0 || this.lastClosedDirection === "SHORT";

      // =========================================================================
      // HIGH-CONVICTION BTO PUT EVALUATION (Setups P-A & P-B)
      // =========================================================================
      if (allowShort && !putBlockedByWall && levels) {
        // Setup P-A (Upper Wall / Zero-Gamma / PDH Rejection)
        const testHigh = bar.recentHigh3 ?? Math.max(bar.high, bar.open);
        const nearUpper = [zg, callWall, pdh].some(
          (lvl) => typeof lvl === "number" && Math.abs(testHigh - lvl) / lvl <= 0.0020
        );
        const belowFlowAndSma =
          (bar.flowVwap === undefined || bar.close < bar.flowVwap) &&
          (bar.sma34 === undefined || bar.close < bar.sma34);
        const negativeFluxConfirm = bar.netFlux < 0 || bar.chi < 0.45 || Boolean(bar.bearDiv5m);
        const downsideTarget = putWall ?? bookCenter ?? bar.close - 2.50;
        const downsideRoom = (bar.close - downsideTarget) >= MIN_REWARD_RISK * unitRisk;

        if (nearUpper && belowFlowAndSma && negativeFluxConfirm && downsideRoom) {
          return {
            nextState: "SHORT",
            reason: "STRUCTURAL_PUT_UPPER_WALL_REJECTION",
            targetWall: putWall ?? downsideTarget,
            stopPrice: testHigh + 0.10,
          };
        }

        // Setup P-C (Pre-Market Upper Flux Field / Zero-Gamma Rejection + Bearish Opening Lean)
      if (!putBlockedByWall && typeof etMins === "number" && etMins >= GAIA_ENTRY_START_MINS && etMins <= 630) {
        const rejectedOverhead = (zg !== undefined && bar.close < zg) &&
          (callWall !== undefined && bar.close < callWall);
        const bearishLean = (bar.flowVwap !== undefined && bar.close < bar.flowVwap) &&
          bar.netFlux < 0 && bar.chi <= 0.45 && isBearMacro;
        const downsideRoom = (bar.close - (putWall ?? bar.close - 2.50)) >= MIN_REWARD_RISK * unitRisk;
        if (rejectedOverhead && bearishLean && downsideRoom) {
          return { nextState: "SHORT", reason: "PREMARKET_FLUX_REJECTION_PUT", targetWall: putWall };
        }
      }

      // Setup P-B (Zero-Gamma / Book Center Breakdown Flush)
        if (zg !== undefined && bar.close < zg && bookCenter !== undefined) {
          const brokeCenter = bar.close < bookCenter && (bar.sma34 === undefined || bar.close < bar.sma34);
          const downsideRoomFlush = (bar.close - (putWall ?? bar.close - 2.50)) >= MIN_REWARD_RISK * unitRisk;
          const expandingBearFlux = bar.netFlux < 0 && (bar.prevNetFlux === undefined || bar.netFlux <= bar.prevNetFlux || bar.chi < 0.48);
          if (brokeCenter && expandingBearFlux && downsideRoomFlush) {
            return {
              nextState: "SHORT",
              reason: "STRUCTURAL_PUT_BREAKDOWN_FLUSH",
              targetWall: putWall,
              stopPrice: bookCenter + 0.20,
            };
          }
        }
      }

      // =========================================================================
      // HIGH-CONVICTION BTO CALL EVALUATION (Setups C-A & C-B)
      // =========================================================================
      if (allowLong && !callBlockedByWall && levels) {
        // Primary Flux-Field Call Entry (Lower -1.5sigma Flux Exhaustion + Cyan Boundary Flux Flip & Flow VWAP Reclaim)
      if (!callBlockedByWall && !bar.bearDiv5m) {
        const vwapRef = bar.flowVwap ?? bookCenter ?? bar.sma34;
        const fluxDistSigma = vwapRef !== undefined && dispersion.atr > 0 ? (bar.close - vwapRef) / Math.max(0.75, dispersion.atr) : 0;
        const testLow = bar.recentLow4 ?? bar.low;
        const touchedLowerFluxOrWall =
          (bar.lowerBand2 !== undefined && testLow <= bar.lowerBand2 * 1.0008) ||
          (bar.lowerBand1 !== undefined && testLow <= bar.lowerBand1 && bar.close > bar.lowerBand1) ||
          (vwapRef !== undefined && (testLow - vwapRef) / Math.max(0.75, dispersion.atr) <= -1.25) ||
          [putWall, pdl].some((lvl) => typeof lvl === "number" && Math.abs(testLow - lvl) / lvl <= 0.0030);
        const cyanFluxFlip = bar.netFlux > 0 && (bar.peclet >= 0.40 || bar.chi >= 0.48 || (bar.prevChi !== undefined && bar.chi - bar.prevChi >= 0.06));
        const reclaimedEquilibrium = (vwapRef !== undefined && bar.close >= vwapRef) || (bar.sma34 !== undefined && bar.close > bar.sma34);
        const upsideRoom = ((callWall ?? zg ?? (vwapRef ? vwapRef + 2.0 * Math.max(0.85, dispersion.atr) : bar.close + 2.50)) - bar.close) >= MIN_REWARD_RISK * unitRisk;
        if (touchedLowerFluxOrWall && cyanFluxFlip && reclaimedEquilibrium && fluxDistSigma < 1.25 && upsideRoom) {
          const upperFluxTarget = vwapRef ? Number((vwapRef + 2.0 * Math.max(0.85, dispersion.atr)).toFixed(2)) : undefined;
          return {
            nextState: "LONG",
            reason: "FLUX_FIELD_EXTREMITY_RECLAIM_CALL",
            targetWall: callWall && callWall > bar.close + 1.0 ? callWall : upperFluxTarget,
          };
        }
      }

      // Setup C-A (Put Wall / PDL Reversal + Reclaim)
        const testLow = bar.recentLow4 ?? Math.min(bar.low, bar.open);
        const nearLower = [putWall, pdl, sigma1dLower].some(
          (lvl) => typeof lvl === "number" && Math.abs(testLow - lvl) / lvl <= 0.0025
        ) || Boolean(bar.bullDiv5m);
        const reclaimed =
          (bookCenter !== undefined && bar.close > bookCenter) ||
          (bar.sma34 !== undefined && bar.close > bar.sma34);
        const improvingFlux =
          (bar.prevChi !== undefined && bar.chi > bar.prevChi) ||
          bar.netFlux > 0 ||
          bar.close > bar.open;
        const upsideTarget = callWall ?? zg ?? bar.close + 2.50;
        const upsideRoom = (upsideTarget - bar.close) >= MIN_REWARD_RISK * unitRisk;

        if (nearLower && reclaimed && improvingFlux && upsideRoom) {
          return {
            nextState: "LONG",
            reason: "STRUCTURAL_CALL_WALL_BOUNCE_RECLAIM",
            targetWall: upsideTarget,
            stopPrice: testLow - 0.10,
          };
        }

        // Setup C-B (Zero-Gamma / Positive-Gamma Breakout)
        if (zg !== undefined && bar.close > zg) {
          const aboveVwap = bar.flowVwap === undefined || bar.close > bar.flowVwap;
          const upsideRoomBreakout = ((callWall ?? bar.close + 3.0) - bar.close) >= MIN_REWARD_RISK * unitRisk;
          if (aboveVwap && bar.netFlux > 0 && bar.chi >= 0.50 && upsideRoomBreakout) {
            return {
              nextState: "LONG",
              reason: "STRUCTURAL_CALL_WALL_BREAKOUT",
              targetWall: callWall,
              stopPrice: zg - 0.20,
            };
          }
        }
      }

      // Setup 1C: Jane Street Zero-Gamma Flip & Flux Field Reclaim (Post-10:15 AM V-Bottom Squeeze)
        const zgLevel = typeof zg === "number" && zg > 0 ? zg : 0;
        const vwapLevel = typeof bar.flowVwap === "number" && bar.flowVwap > 0 ? bar.flowVwap : 0;
        const reclaimedZeroGamma = zgLevel > 0 && bar.close > zgLevel && bar.close > vwapLevel && vwapLevel > 0;
        const fluxImpulseBull = (bar.chi >= 0.46 || eFlux >= 0.35) && bar.peclet >= 0.50 && vwapSlope >= 0;
        if (
          allowLong &&
          reclaimedZeroGamma &&
          fluxImpulseBull &&
          isBullMacro &&
          !callBlockedByWall
        ) {
          return {
            nextState: "LONG",
            reason: "ZERO_GAMMA_FLUX_RECLAIM_CALL",
            targetWall: callWall && callWall > bar.close + 1.0 ? callWall : Number((vwapLevel + 2.0 * Math.max(0.75, 1.25 * dispersion.atr)).toFixed(2))
          };
        }

        // Standard Equilibrium Dispersion Breakout Fallback
        // Jane Street Invariant: When structural gamma levels are supplied, never fire mid-range noise scalps;
        // execute strictly on Structural Wall + PDE Boundary Flux setups (P-A, P-B, C-A, C-B) above.
        const hasStructuralMap = Boolean(levels && (zg || callWall || putWall));
        if (hasStructuralMap) {
          return { nextState: "STAND_ASIDE" };
        }

        const vwapLongOk =
          bar.flowVwap === undefined || (bar.close >= bar.flowVwap && vwapSlope >= 0);
        if (
          allowLong &&
          eChi >= 0.85 &&
          eFlux >= zFluxThreshold &&
          bar.chi >= 0.50 &&
          isBullMacro &&
          vwapLongOk &&
          !callBlockedByWall
        ) {
          return { nextState: "LONG", reason: "EQUILIBRIUM_CALL_BREAKOUT", targetWall: callWall };
        }

        const vwapShortOk =
          bar.flowVwap === undefined || (bar.close <= bar.flowVwap && vwapSlope <= 0);
        if (
          allowShort &&
          eChi <= -0.85 &&
          eFlux <= -zFluxThreshold &&
          bar.chi < 0.50 &&
          isBearMacro &&
          !isBullMacro &&
          vwapShortOk &&
          !putBlockedByWall
        ) {
          return { nextState: "SHORT", reason: "EQUILIBRIUM_PUT_BREAKDOWN", targetWall: putWall };
        }

        return { nextState: "STAND_ASIDE" };
    }

    if (currentState === "LONG") {
      const entryP = entryPriceRef || this.currentEntryPrice || bar.close;
      const adverseMove = entryP - bar.close;
      const minHoldMet = this.barsHeld >= MIN_HOLD_BARS;
      const clampFill = (p: number) => Number(Math.max(bar.low, Math.min(bar.high, p)).toFixed(2));
      const solidBullFlux = bar.netFlux > 0 && bar.chi > 0.85;
      const fluxDecelerating = bar.prevNetFlux !== undefined && bar.netFlux <= bar.prevNetFlux;
      const upperFluxBand = bar.upperBand2 ?? (bar.flowVwap !== undefined ? bar.flowVwap + 1.95 * Math.max(0.85, dispersion.atr) : undefined);
      if (minHoldMet && ((upperFluxBand !== undefined && bar.high >= upperFluxBand && (fluxDecelerating || !solidBullFlux)) || (adverseMove >= MIN_REVERSAL_ADVERSE_DOLLARS && bar.netFlux < 0 && bar.peclet <= -0.75 && bar.flowVwap !== undefined && bar.close < bar.flowVwap))) {
        return { nextState: "STAND_ASIDE", reason: "UPPER_FLUX_FIELD_TARGET_OR_FLUX_FLIP", fillPrice: bar.close };
      }
      const targetW = targetWallRef || this.activeTargetWall;

      // 1. Structural Target Hit: High reaches within $0.25 of targetWall
      if (targetW > entryP && bar.high >= targetW - TARGET_TOUCH_DOLLARS) {
        return {
          nextState: "STAND_ASIDE",
          reason: "STRUCTURAL_TARGET_HIT",
          fillPrice: clampFill(targetW - TARGET_TOUCH_DOLLARS),
        };
      }

      // 2. Progressive Profit Ratchets
      if (targetW > entryP) {
        const totalDist = targetW - entryP;
        const peakGain = Math.max(0, (trackedLocalExtreme || bar.high) - entryP);
        const progress = peakGain / totalDist;
        const be10Stop = entryP + totalDist * 0.10;

        // Stage 2 Ratchet (75% progress): Trail under prior 5m low with Stage-1 BE+10% floor
        if (progress >= 0.75) {
          const refLow = this.prevBarLow > 0 ? this.prevBarLow : bar.open;
          const trailStop = Number(Math.max(be10Stop, refLow - 0.05).toFixed(2));
          if (bar.close < trailStop) {
            return {
              nextState: "STAND_ASIDE",
              reason: "PROFIT_RATCHET_STAGE2_TRAIL_STOP",
              fillPrice: clampFill(trailStop),
            };
          }
        } else if (progress >= 0.50) {
          // Stage 1 Ratchet (50% progress): Lock Breakeven + 10%
          if (bar.close < be10Stop) {
            return {
              nextState: "STAND_ASIDE",
              reason: "PROFIT_RATCHET_STAGE1_BE10",
              fillPrice: clampFill(be10Stop),
            };
          }
        }
      }

      // Direct flip disabled: must exit to STAND_ASIDE and respect 30-min Phase 2 cooldown

      // Structural Stop Check for Setup C-A / C-B
        if (this.activeStopPrice > 0 && bar.close < this.activeStopPrice) {
          return { nextState: "STAND_ASIDE", reason: "STRUCTURAL_STOP_LOSS", fillPrice: bar.close };
        }
        // If macro flips to BEAR, neutralize ONLY non-structural equilibrium trades
        const isStructuralLong = this.activeSetupReason.startsWith("STRUCTURAL_CALL") || this.activeSetupReason.includes("FLUX");
        if (minHoldMet && adverseMove >= MIN_REVERSAL_ADVERSE_DOLLARS && !isStructuralLong && !solidBullFlux && isBearMacro && !isBullMacro) {
          return { nextState: "STAND_ASIDE", reason: "MACRO_REGIME_BEAR_FLIP" };
        }

      // Trailing Volatility Envelope Exit: Breach of 1.5 * ATR from localHigh AND adverse flux confirmation
      const peakPrice = Math.max(trackedLocalExtreme || bar.close, bar.high);
      const atrStop = peakPrice - 1.5 * dispersion.atr;
      const adverseFluxConfirmed = bar.netFlux < 0 && bar.chi < 0.50;

      if (bar.close < atrStop && adverseFluxConfirmed) {
        return { nextState: "STAND_ASIDE", reason: "ATR_VOLATILITY_ENVELOPE_BREACH" };
      }

      return { nextState: "LONG" };
    }

    if (currentState === "SHORT") {
      const entryP = entryPriceRef || this.currentEntryPrice || bar.close;
      const adverseMove = bar.close - entryP;
      const minHoldMet = this.barsHeld >= MIN_HOLD_BARS;
      const clampFill = (p: number) => Number(Math.max(bar.low, Math.min(bar.high, p)).toFixed(2));
      const solidBearFlux = bar.netFlux < 0 && bar.chi < 0.15;
      const fluxDecelerating = bar.prevNetFlux !== undefined && bar.netFlux >= bar.prevNetFlux;
      const lowerFluxBand = bar.lowerBand2 ?? (bar.flowVwap !== undefined ? bar.flowVwap - 1.95 * Math.max(0.85, dispersion.atr) : undefined);
      if (minHoldMet && ((lowerFluxBand !== undefined && bar.low <= lowerFluxBand && (fluxDecelerating || !solidBearFlux)) || (adverseMove >= MIN_REVERSAL_ADVERSE_DOLLARS && bar.netFlux > 0 && bar.peclet >= 0.75 && bar.flowVwap !== undefined && bar.close > bar.flowVwap))) {
        return { nextState: "STAND_ASIDE", reason: "LOWER_FLUX_FIELD_TARGET_OR_FLUX_FLIP", fillPrice: bar.close };
      }
      const targetW = targetWallRef || this.activeTargetWall;

      // 1. Structural Target Hit: Low reaches within $0.25 of targetWall
      if (targetW > 0 && targetW < entryP && bar.low <= targetW + TARGET_TOUCH_DOLLARS) {
        return {
          nextState: "STAND_ASIDE",
          reason: "STRUCTURAL_TARGET_HIT",
          fillPrice: clampFill(targetW + TARGET_TOUCH_DOLLARS),
        };
      }

      // 2. Progressive Profit Ratchets
      if (targetW > 0 && targetW < entryP) {
        const totalDist = entryP - targetW;
        const peakGain = Math.max(0, entryP - (trackedLocalExtreme || bar.low));
        const progress = peakGain / totalDist;
        const be10Stop = entryP - totalDist * 0.10;

        // Stage 2 Ratchet (75% progress): Trail above prior 5m high with Stage-1 BE+10% floor
        if (progress >= 0.75) {
          const refHigh = this.prevBarHigh > 0 ? this.prevBarHigh : bar.open;
          const trailStop = Number(Math.min(be10Stop, refHigh + 0.05).toFixed(2));
          if (bar.close > trailStop) {
            return {
              nextState: "STAND_ASIDE",
              reason: "PROFIT_RATCHET_STAGE2_TRAIL_STOP",
              fillPrice: clampFill(trailStop),
            };
          }
        } else if (progress >= 0.50) {
          // Stage 1 Ratchet (50% progress): Lock Breakeven + 10%
          if (bar.close > be10Stop) {
            return {
              nextState: "STAND_ASIDE",
              reason: "PROFIT_RATCHET_STAGE1_BE10",
              fillPrice: clampFill(be10Stop),
            };
          }
        }
      }

      // Direct flip disabled: must exit to STAND_ASIDE and respect 30-min Phase 2 cooldown

      // Structural Stop Check for Setup P-A / P-B
        if (this.activeStopPrice > 0 && bar.close > this.activeStopPrice) {
          return { nextState: "STAND_ASIDE", reason: "STRUCTURAL_STOP_LOSS", fillPrice: bar.close };
        }
        // If macro flips to BULL, neutralize ONLY non-structural equilibrium trades
        const isStructuralShort = this.activeSetupReason.startsWith("STRUCTURAL_PUT") || this.activeSetupReason.includes("FLUX");
        if (minHoldMet && adverseMove >= MIN_REVERSAL_ADVERSE_DOLLARS && !isStructuralShort && !solidBearFlux && isBullMacro && !isBearMacro) {
          return { nextState: "STAND_ASIDE", reason: "MACRO_REGIME_BULL_FLIP" };
        }

      // Trailing Volatility Envelope Exit: Breach of 1.5 * ATR from localLow AND adverse flux confirmation
      const troughPrice = Math.min(trackedLocalExtreme || bar.close, bar.low);
      const atrStop = troughPrice + 1.5 * dispersion.atr;
      const adverseFluxConfirmed = bar.netFlux > 0 && bar.chi > 0.50;

      if (bar.close > atrStop && adverseFluxConfirmed) {
        return { nextState: "STAND_ASIDE", reason: "ATR_VOLATILITY_ENVELOPE_BREACH" };
      }

      return { nextState: "SHORT" };
    }

    return { nextState: currentState };
  }

  /**
   * Commits a closed bar into the append-only history.
   */
  public commitClosedBar(
    bar: GaiaBarData,
    dispersion?: GaiaEquilibriumDispersion,
    macro?: GaiaMacroContext,
    opts?: { isHistoricalBackfill: boolean }
  ): GaiaCommittedSignal | null {
    if (!bar.isClosed) return null;

    // RTH Gate: Pre-market (etMins < 570) and post-close (etMins >= 960) bars are strictly gated
    const resolvedEtMins = resolveGaiaBarEtMinutes(bar);
    if (
      typeof resolvedEtMins === "number" &&
      (resolvedEtMins < GAIA_RTH_OPEN_MINS || resolvedEtMins >= GAIA_RTH_CLOSE_MINS)
    ) {
      return null;
    }

    const disp = dispersion || {
      sigmaChi: 0.05,
      sigmaFlux: 0.05,
      barDurationSec: bar.barSpanSeconds || 300,
      atr: bar.close * 0.0015,
    };

    if (this.committedBarTimestamps.has(bar.barTimestamp)) return null;
    this.committedBarTimestamps.add(bar.barTimestamp);

    // Update localized extreme price before transition check
    if (this.committedState === "LONG") {
      this.barsHeld += 1;
      this.localExtremePrice = Math.max(this.localExtremePrice || bar.close, bar.high);
    } else if (this.committedState === "SHORT") {
      this.barsHeld += 1;
      this.localExtremePrice = Math.min(this.localExtremePrice || bar.close, bar.low);
    }

    const transition = this.evaluateTransition(
      this.committedState,
      bar,
      disp,
      macro,
      this.localExtremePrice,
      this.currentEntryPrice,
      this.activeTargetWall
    );
    this.prevBarLow = bar.low;
    this.prevBarHigh = bar.high;
    const { nextState, reason, fillPrice, targetWall, stopPrice } = transition;

    if (nextState === this.committedState) {
      return null;
    }

    const fromState = this.committedState;
    this.committedState = nextState;

    let entryPrice: number | undefined;
    let exitPrice: number | undefined;
    let realizedPnl: number | undefined;

    if (fromState === "STAND_ASIDE" && (nextState === "LONG" || nextState === "SHORT")) {
      this.barsHeld = 0;
      this.currentEntryPrice = bar.close;
      this.localExtremePrice = bar.close;
      this.activeTargetWall = targetWall || 0;
      this.activeStopPrice = stopPrice || 0;
      this.activeSetupReason = reason || "";
      entryPrice = bar.close;
    } else if ((fromState === "LONG" || fromState === "SHORT") && nextState === "STAND_ASIDE") {
      entryPrice = this.currentEntryPrice;
      exitPrice = fillPrice ?? bar.close;
      realizedPnl = fromState === "LONG" ? exitPrice - entryPrice : entryPrice - exitPrice;
      this.closedTradesToday += 1;
      this.lastClosedDirection = fromState;
      this.lastExitBarTs = bar.barTimestamp;
      if (this.closedTradesToday === 1 && entryPrice > 0 && realizedPnl / entryPrice > 0.0025) {
        this.phase1WinnerLocked = true; // Lock day on strong Phase 1 spot winner
      }
      this.barsHeld = 0;
      this.currentEntryPrice = 0;
      this.localExtremePrice = 0;
      this.activeTargetWall = 0;
      this.activeStopPrice = 0;
    } else if (fromState === "LONG" && nextState === "SHORT") {
      entryPrice = this.currentEntryPrice;
      exitPrice = fillPrice ?? bar.close;
      realizedPnl = exitPrice - entryPrice;
      this.currentEntryPrice = bar.close;
      this.localExtremePrice = bar.close;
      this.activeTargetWall = targetWall || 0;
      this.activeStopPrice = stopPrice || 0;
      this.activeSetupReason = reason || "";
    } else if (fromState === "SHORT" && nextState === "LONG") {
      entryPrice = this.currentEntryPrice;
      exitPrice = fillPrice ?? bar.close;
      realizedPnl = entryPrice - exitPrice;
      this.currentEntryPrice = bar.close;
      this.localExtremePrice = bar.close;
      this.activeTargetWall = targetWall || 0;
      this.activeStopPrice = stopPrice || 0;
      this.activeSetupReason = reason || "";
    } else {
      this.localExtremePrice = 0;
      this.activeTargetWall = 0;
      this.activeStopPrice = 0;
    }

    const barSpanSec = bar.barSpanSeconds || disp.barDurationSec;
    const signal: GaiaCommittedSignal = {
      id: `gaia-${bar.barTimestamp}-${nextState}`,
      idempotencyKey: `${bar.barTimestamp}_${nextState}`,
      sequence: this.committedCallLog.length + 1,
      barTimestamp: bar.barTimestamp,
      barCloseTimestamp: bar.barCloseTimestamp || bar.barTimestamp + barSpanSec,
      barSpanSeconds: barSpanSec,
      fromState,
      toState: nextState,
      reason: reason || `${fromState}->${nextState}`,
      price: exitPrice ?? bar.close,
      chi: bar.chi,
      chiPct: Math.round(bar.chi * 100),
      bias: bar.bias,
      netFlux: bar.netFlux,
      peclet: bar.peclet,
      isHistoricalBackfill: opts?.isHistoricalBackfill ?? false,
      entryPrice,
      exitPrice,
      realizedPnl,
      targetWallPrice: targetWall || (fromState !== "STAND_ASIDE" ? this.activeTargetWall : undefined),
      stopLossPrice: stopPrice,
    };

    this.committedCallLog.push(signal);
    return signal;
  }

  /**
   * Processes a full series of bars causally bar-by-bar.
   */
  public commitSeries(
    bars: GaiaBarData[],
    macro?: GaiaMacroContext,
    opts: { currentServerEpochSeconds?: number } = {}
  ): {
    newlyCommitted: GaiaCommittedSignal[];
    snapshot: GaiaFsmSnapshot;
  } {
    const newlyCommitted: GaiaCommittedSignal[] = [];
    const nowSec = opts.currentServerEpochSeconds ?? Math.floor(Date.now() / 1000);

    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i];
      if (bar.isClosed) {
        // Compute dispersion strictly causally using historical bars 0..i (Zero Lookahead)
        const dispersion = computeCausalEquilibriumDispersion(bars, i);
        const barSpan = bar.barSpanSeconds || dispersion.barDurationSec;
        const closeTs = bar.barCloseTimestamp || bar.barTimestamp + barSpan;
        const isBackfill = nowSec - closeTs > Math.round(barSpan * 1.5);

        const sig = this.commitClosedBar(bar, dispersion, macro, {
          isHistoricalBackfill: isBackfill,
        });
        if (sig) {
          newlyCommitted.push(sig);
        }
      }
    }

    const lastIdx = bars.length - 1;
    const unclosedBar = bars.length > 0 && !bars[lastIdx].isClosed ? bars[lastIdx] : undefined;
    const latestDispersion = computeCausalEquilibriumDispersion(bars, lastIdx);

    return {
      newlyCommitted,
      snapshot: this.getSnapshot(unclosedBar, latestDispersion, macro),
    };
  }

  public getSnapshot(
    liveUnclosedBar?: GaiaBarData,
    dispersion?: GaiaEquilibriumDispersion,
    macro?: GaiaMacroContext
  ): GaiaFsmSnapshot {
    let livePreviewState = this.committedState;
    if (liveUnclosedBar && !liveUnclosedBar.isClosed && dispersion) {
      const liveExtreme =
        this.committedState === "LONG"
          ? Math.max(this.localExtremePrice || liveUnclosedBar.close, liveUnclosedBar.high)
          : this.committedState === "SHORT"
          ? Math.min(this.localExtremePrice || liveUnclosedBar.close, liveUnclosedBar.low)
          : 0;

      livePreviewState = this.evaluateTransition(
        this.committedState,
        liveUnclosedBar,
        dispersion,
        macro,
        liveExtreme,
        this.currentEntryPrice,
        this.activeTargetWall
      ).nextState;
    }

    return {
      committedState: this.committedState,
      livePreviewState,
      isPendingTransition: livePreviewState !== this.committedState,
      committedCallLog: [...this.committedCallLog],
    };
  }
}
