/**
 * Canonical Progressive Option-% Profit Ratchet & Flux-Flip MFE Harvest Engine.
 * Shared identically by live execution (`bracketStateMachine.ts`) and 10-day walk-forward replay
 * (`audit10DayBacktest.ts`) to guarantee zero live-vs-backtest split-brain.
 *
 * Strict Pessimistic Intrabar Ordering (Zero Lookahead):
 * 1. Compute existing armed ratchet floor strictly from `prevPeakOptionPnlPct` (bars < t).
 * 2. Evaluate bar t's adverse extreme against that existing floor FIRST before updating peak.
 * 3. Only if unstopped, update `nextPeakOptionPnlPct` from bar t's favorable extreme.
 * 4. On confirmed closed 5m bars, if peak >= +50% and `netFluxJ` flips against the position,
 *    exit at bar close (`FLUX_FLIP_MFE_HARVEST`).
 */

export type ProfitRatchetTier =
  | "NONE"
  | "BREAKEVEN_30"
  | "PROFIT_LOCK_60"
  | "PROFIT_TRAIL_100"
  | "RUNNER_TRAIL_100";

export interface ProfitRatchetInput {
  isCall: boolean;
  /** Peak option PnL % recorded strictly prior to the current bar/tick (< t) */
  prevPeakOptionPnlPct: number;
  /** Bar t adverse extreme option PnL % (bar low for CALL, bar high for PUT, or live bid PnL %) */
  adverseOptionPnlPct: number;
  /** Bar t close (or live bid) option PnL % */
  closeOptionPnlPct: number;
  /** Bar t favorable extreme option PnL % (bar high for CALL, bar low for PUT, or live bid PnL %) */
  favorableOptionPnlPct: number;
  /** Optional bar open option PnL % to capture adverse gap-through below armed stop floor */
  openOptionPnlPct?: number;
  /** Ceiling Share chi in [0, 1] */
  chi: number;
  /** PDE Boundary Net Flux J */
  netFluxJ: number;
  /** True once at least one post-entry 5m bar has elapsed/confirmed */
  hasPostEntryBarElapsed: boolean;
  /** True when confirmed 5m netFluxJ has flipped against position direction */
  fluxFlippedAgainst: boolean;
}

export interface ProfitRatchetEvaluation {
  triggered: boolean;
  reason: string | null;
  /** Realistic fill PnL % when triggered (never better than gap/close) */
  fillPnlPct: number | null;
  /** Tier that was armed entering bar t (from bars < t) */
  armedTier: ProfitRatchetTier;
  /** Option PnL % floor armed entering bar t (from bars < t) */
  armedFloorPct: number | null;
  /** Updated peak option PnL % after bar t */
  nextPeakOptionPnlPct: number;
  /** Tier armed for bar t+1 */
  nextArmedTier: ProfitRatchetTier;
  /** Option PnL % floor armed for bar t+1 */
  nextArmedFloorPct: number | null;
}

export function resolveRatchetFloorForPeak(params: {
  peakOptionPnlPct: number;
  isCall: boolean;
  chi: number;
  netFluxJ: number;
}): { tier: ProfitRatchetTier; floorPct: number | null } {
  const { peakOptionPnlPct, isCall, chi, netFluxJ } = params;
  const peak = Number.isFinite(peakOptionPnlPct) ? peakOptionPnlPct : 0;

  const isExtremeRunner =
    (isCall ? chi >= 0.88 && netFluxJ > 0 : chi <= 0.12 && netFluxJ < 0);

  if (peak >= 100) {
    const trailOffset = isExtremeRunner ? 35 : 25;
    const floorPct = Number(Math.max(55, peak - trailOffset).toFixed(2));
    return {
      tier: isExtremeRunner ? "RUNNER_TRAIL_100" : "PROFIT_TRAIL_100",
      floorPct,
    };
  }
  if (peak >= 60) {
    return { tier: "PROFIT_LOCK_60", floorPct: 25 };
  }
  if (peak >= 30) {
    return { tier: "BREAKEVEN_30", floorPct: 2 };
  }
  return { tier: "NONE", floorPct: null };
}

export function evaluateOptionProfitRatchet(
  input: ProfitRatchetInput
): ProfitRatchetEvaluation {
  const {
    isCall,
    prevPeakOptionPnlPct,
    adverseOptionPnlPct,
    closeOptionPnlPct,
    favorableOptionPnlPct,
    openOptionPnlPct,
    chi,
    netFluxJ,
    hasPostEntryBarElapsed,
    fluxFlippedAgainst,
  } = input;

  // Step 1: Resolve standing ratchet floor armed strictly BEFORE bar t (bars < t)
  const standing = resolveRatchetFloorForPeak({
    peakOptionPnlPct: prevPeakOptionPnlPct,
    isCall,
    chi,
    netFluxJ,
  });

  // Step 2: Pessimistic intrabar check — test adverse extreme against standing floor FIRST
  if (standing.floorPct !== null && adverseOptionPnlPct <= standing.floorPct) {
    // If open gapped worse than the standing stop floor (or on live tick where open === close),
    // fill strictly at the worse of floor vs open/adverse.
    const fillPnlPct =
      typeof openOptionPnlPct === "number" && Number.isFinite(openOptionPnlPct)
        ? Number(Math.min(standing.floorPct, openOptionPnlPct).toFixed(2))
        : Number(standing.floorPct.toFixed(2));

    const reason =
      standing.tier === "RUNNER_TRAIL_100"
        ? `OPTION PROFIT RATCHET (+100% RUNNER TRAIL LOCK @ +${standing.floorPct.toFixed(0)}%)`
        : standing.tier === "PROFIT_TRAIL_100"
          ? `OPTION PROFIT RATCHET (+100% TRAIL LOCK @ +${standing.floorPct.toFixed(0)}%)`
          : standing.tier === "PROFIT_LOCK_60"
            ? "OPTION PROFIT RATCHET (+60% -> +25% PROFIT LOCK)"
            : "OPTION PROFIT RATCHET (+30% -> BREAKEVEN LOCK)";

    return {
      triggered: true,
      reason,
      fillPnlPct,
      armedTier: standing.tier,
      armedFloorPct: standing.floorPct,
      nextPeakOptionPnlPct: prevPeakOptionPnlPct,
      nextArmedTier: standing.tier,
      nextArmedFloorPct: standing.floorPct,
    };
  }

  // Step 3: Update peak MFE ONLY AFTER surviving the adverse extreme check on bar t
  const nextPeakOptionPnlPct = Number(
    Math.max(prevPeakOptionPnlPct, favorableOptionPnlPct).toFixed(2)
  );
  const nextArmed = resolveRatchetFloorForPeak({
    peakOptionPnlPct: nextPeakOptionPnlPct,
    isCall,
    chi,
    netFluxJ,
  });

  // Step 4: Flux-Flip MFE Harvest on confirmed closed bar (once peak >= +50% and netFluxJ flips)
  if (hasPostEntryBarElapsed && nextPeakOptionPnlPct >= 50 && fluxFlippedAgainst) {
    return {
      triggered: true,
      reason: "FLUX_FLIP_MFE_HARVEST",
      fillPnlPct: Number(closeOptionPnlPct.toFixed(2)),
      armedTier: standing.tier,
      armedFloorPct: standing.floorPct,
      nextPeakOptionPnlPct,
      nextArmedTier: nextArmed.tier,
      nextArmedFloorPct: nextArmed.floorPct,
    };
  }

  return {
    triggered: false,
    reason: null,
    fillPnlPct: null,
    armedTier: standing.tier,
    armedFloorPct: standing.floorPct,
    nextPeakOptionPnlPct,
    nextArmedTier: nextArmed.tier,
    nextArmedFloorPct: nextArmed.floorPct,
  };
}
