import type { DailyTradeStore, OptionTradePosition } from "@/lib/execution/types";
import type { FlowGammaVwapSnapshot } from "@/lib/flowGammaVwap";
import { DEFAULT_HARD_OPTION_STOP_LOSS_PCT } from "@/lib/bracketOrderEngine";

export type ZeroOperatingMode = "FOLLOW" | "FADE" | "SIT_OUT";

export interface ZeroModePerformanceBucket {
  trades: number;
  wins: number;
  winRatePct: number;
  avgR: number;
}

export interface EvaluateZeroRegimeSwitcherInput {
  sessionDate: string;
  ticker: string;
  etMins: number;
  spotPrice: number;
  callWall: number;
  putWall: number;
  zeroGamma: number;
  netGex?: number;
  flowSnapshot?: FlowGammaVwapSnapshot | null;
  historicalSessions?: DailyTradeStore[];
  baseRegime: "POS_GAMMA_PIN" | "NEG_GAMMA_TREND" | "ZERO_GAMMA_FLIP" | "LOW_EDGE_CHOP";
  baseShouldStandAside?: boolean;
  basePreferredDte: "0DTE" | "1-2DTE" | "NONE";
}

export interface ZeroRegimeSwitcherDecision {
  mode: ZeroOperatingMode;
  modeReason: string;
  preferredDte: "0DTE" | "1-2DTE" | "NONE";
  tollShieldActive: boolean;
  tollGateCleared: boolean;
  strikeStepPct: number;
  followStats: ZeroModePerformanceBucket;
  fadeStats: ZeroModePerformanceBucket;
  dte0Stats: ZeroModePerformanceBucket;
  dte1Stats: ZeroModePerformanceBucket;
  standAsideVetoReason: string | null;
}

function inferOptionStrikeStep(ticker: string, spotPrice: number): number {
  const sym = ticker.trim().toUpperCase();
  if (sym === "SPX" || sym === "SPXW" || sym === "^SPX" || sym === "NDX" || sym === "NDXP") {
    return 5;
  }
  if (sym === "SPY" || sym === "QQQ" || sym === "IWM") {
    return 1;
  }
  if (spotPrice >= 500) return 5;
  if (spotPrice >= 200) return 2.5;
  return 1;
}

function isFadeSetupName(setupName: string): boolean {
  return /bounce|reclaim|reject|reversion|fade|wall|oversold|overbought|div/i.test(setupName || "");
}

function computePositionR(pos: OptionTradePosition): number {
  if (typeof pos.pnlOptionPct === "number" && Number.isFinite(pos.pnlOptionPct)) {
    return pos.pnlOptionPct / DEFAULT_HARD_OPTION_STOP_LOSS_PCT;
  }
  const entry = pos.optionAsk ?? pos.btoOptionMid ?? 0;
  const exit = pos.closedOptionMid ?? entry;
  if (entry > 0) {
    return (((exit - entry) / entry) * 100) / DEFAULT_HARD_OPTION_STOP_LOSS_PCT;
  }
  return 0;
}

function buildBucket(rs: number[]): ZeroModePerformanceBucket {
  if (rs.length === 0) {
    return { trades: 0, wins: 0, winRatePct: 0, avgR: 0 };
  }
  const wins = rs.filter((r) => r > 0).length;
  const sum = rs.reduce((a, b) => a + b, 0);
  return {
    trades: rs.length,
    wins,
    winRatePct: Number(((wins / rs.length) * 100).toFixed(1)),
    avgR: Number((sum / rs.length).toFixed(2)),
  };
}

/**
 * Strictly Causal Adaptive Regime Switcher (`[D-10, D-1]` + live intraday snapshot).
 * Evaluates out-of-sample `FOLLOW` vs. `FADE` performance and spread+theta toll clearance
 * without peeking past the current timestamp or current session date.
 */
export function evaluateZeroRegimeSwitcher(
  input: EvaluateZeroRegimeSwitcherInput
): ZeroRegimeSwitcherDecision {
  const sym = input.ticker.trim().toUpperCase();
  const safeSpot = Math.max(0.01, input.spotPrice);
  const strikeStep = inferOptionStrikeStep(sym, safeSpot);
  const strikeStepPct = Number(((strikeStep / safeSpot) * 100).toFixed(3));

  // Strictly causal [D-10, D-1] filter: never read current or future dates
  const priorSessions = (input.historicalSessions ?? [])
    .filter((s) => s && s.date && (!input.sessionDate || s.date < input.sessionDate))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-10);

  const followRs: number[] = [];
  const fadeRs: number[] = [];
  const dte0Rs: number[] = [];
  const dte1Rs: number[] = [];

  for (const sess of priorSessions) {
    for (const p of sess.closedPositions || []) {
      if (p.ticker && p.ticker.trim().toUpperCase() !== sym) continue;
      const r = computePositionR(p);
      if (isFadeSetupName(p.setupName)) {
        fadeRs.push(r);
      } else {
        followRs.push(r);
      }
      if (p.expiration && p.expiration === sess.date) {
        dte0Rs.push(r);
      } else {
        dte1Rs.push(r);
      }
    }
  }

  const followStats = buildBucket(followRs);
  const fadeStats = buildBucket(fadeRs);
  const dte0Stats = buildBucket(dte0Rs);
  const dte1Stats = buildBucket(dte1Rs);

  const rawPe = input.flowSnapshot?.pecletNumber ?? 0;
  const impPe = input.flowSnapshot?.impulsePeclet ?? rawPe;
  const absPeclet = Math.max(Math.abs(rawPe), Math.abs(impPe));
  const impChi = input.flowSnapshot?.impulseChi ?? input.flowSnapshot?.ceilingShareChi ?? 0.5;
  const impulseConviction = Math.abs(2 * impChi - 1); // 0 = neutral 50%, 1 = extreme 0%/100%
  const isCoarseStrikeGrid = strikeStepPct >= 0.28; // e.g., $1 strike grid on sub-$355 ETFs (IWM ~0.38%)

  if (input.baseShouldStandAside || input.baseRegime === "LOW_EDGE_CHOP") {
    return {
      mode: "SIT_OUT",
      modeReason: "Compressed corridor / sub-threshold advection",
      preferredDte: "NONE",
      tollShieldActive: false,
      tollGateCleared: false,
      strikeStepPct,
      followStats,
      fadeStats,
      dte0Stats,
      dte1Stats,
      standAsideVetoReason: null,
    };
  }

  // Toll-Booth Horizon & Chop Gate:
  // Coarse strike-grid underlyings (>= 0.28% per strike) after the initial 09:35-10:10 ET opening drive
  // suffer steep OTM strike-step + 0DTE theta decay unless impulse conviction is extreme (>= 0.72 & |Pe| >= 8.0).
  if (isCoarseStrikeGrid && input.etMins >= 615 && (impulseConviction < 0.72 || absPeclet < 8.0)) {
    const vetoReason = `Zero Toll Gate: coarse strike grid (${strikeStepPct.toFixed(2)}%) + post-10:15 theta toll exceeds impulse edge (χ_imp=${Math.round(impChi * 100)}%, |Pe|=${absPeclet.toFixed(2)})`;
    return {
      mode: "SIT_OUT",
      modeReason: vetoReason,
      preferredDte: "NONE",
      tollShieldActive: true,
      tollGateCleared: false,
      strikeStepPct,
      followStats,
      fadeStats,
      dte0Stats,
      dte1Stats,
      standAsideVetoReason: vetoReason,
    };
  }

  // Rolling [D-10, D-1] Toll Gate: if >= 3 prior trades exist with negative total expectancy AND weak current advection (< 2.0) after 10:15 ET
  const totalPriorTrades = followStats.trades + fadeStats.trades;
  const combinedAvgR =
    totalPriorTrades > 0
      ? (followStats.avgR * followStats.trades + fadeStats.avgR * fadeStats.trades) /
        totalPriorTrades
      : 0;
  if (totalPriorTrades >= 3 && combinedAvgR < -0.15 && input.etMins >= 615 && absPeclet < 2.0) {
    const vetoReason = `Zero Toll Gate: trailing [D-10,D-1] E[R]=${combinedAvgR.toFixed(2)}R with weak advection (|Pe|=${absPeclet.toFixed(2)})`;
    return {
      mode: "SIT_OUT",
      modeReason: vetoReason,
      preferredDte: "NONE",
      tollShieldActive: true,
      tollGateCleared: false,
      strikeStepPct,
      followStats,
      fadeStats,
      dte0Stats,
      dte1Stats,
      standAsideVetoReason: vetoReason,
    };
  }

  // 1DTE Decay Shield routing
  let preferredDte: "0DTE" | "1-2DTE" | "NONE" = input.basePreferredDte;
  let tollShieldActive = false;
  if (preferredDte === "0DTE") {
    if (isCoarseStrikeGrid && input.etMins >= 605 && absPeclet < 3.2) {
      preferredDte = "1-2DTE";
      tollShieldActive = true;
    } else if (dte0Stats.trades >= 2 && dte0Stats.avgR < -0.1 && input.etMins >= 660 && absPeclet < 2.4) {
      preferredDte = "1-2DTE";
      tollShieldActive = true;
    }
  }

  // Adaptive Mode Selection (`FOLLOW` vs `FADE`)
  let mode: ZeroOperatingMode =
    input.baseRegime === "POS_GAMMA_PIN" ? "FADE" : "FOLLOW";
  let modeReason =
    mode === "FADE"
      ? "Positive-Gamma Pin · Fade Wall / Band Extremes"
      : "Negative-Gamma / Flip · Follow Structural Breaks";

  if (fadeStats.trades >= 2 && fadeStats.avgR >= 0.25 && fadeStats.avgR > followStats.avgR + 0.35 && absPeclet < 2.2) {
    mode = "FADE";
    modeReason = `Rolling [D-10,D-1] Fade Edge (+${fadeStats.avgR.toFixed(2)}R vs ${followStats.avgR.toFixed(2)}R)`;
  } else if (followStats.trades >= 2 && followStats.avgR >= 0.25 && followStats.avgR >= fadeStats.avgR) {
    mode = "FOLLOW";
    modeReason = `Rolling [D-10,D-1] Follow Edge (+${followStats.avgR.toFixed(2)}R · ${followStats.winRatePct.toFixed(0)}% WR)`;
  }

  if (tollShieldActive) {
    modeReason = `${modeReason} · 1DTE Toll Shield`;
  }

  return {
    mode,
    modeReason,
    preferredDte,
    tollShieldActive,
    tollGateCleared: true,
    strikeStepPct,
    followStats,
    fadeStats,
    dte0Stats,
    dte1Stats,
    standAsideVetoReason: null,
  };
}
