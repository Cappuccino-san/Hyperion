import { toEpochSec, etMinutesOfDay } from "@/lib/gaiaSessionGuards";

export type ZeroDataMode = "OPRA_PRINT_STREAM" | "CHAIN_SNAPSHOT_PDE";
export type ZeroCallVerdict = "LONG" | "SHORT" | "STAND_ASIDE";
export type ZeroDominanceRegime = "CALL" | "PUT" | "NEUTRAL";

/**
 * Optional future plug-in interface for tick-level OPRA time-and-sales streams.
 * Default in Hyperion is `null` (`dataMode: "CHAIN_SNAPSHOT_PDE"`), ensuring zero
 * fabricated sweeps or synthetic prints.
 */
export interface OpraPrintSummary {
  windowStartTs: number;
  windowEndTs: number;
  totalContracts: number;
  askSideContracts: number;
  bidSideContracts: number;
  midOrCrossContracts: number;
  sweepContracts: number;
  callAskPremiumDollars: number;
  putAskPremiumDollars: number;
  callBidPremiumDollars: number;
  putBidPremiumDollars: number;
}

export interface OpraPrintAdapter {
  readonly providerName: string;
  getWindowSummary(params: {
    ticker: string;
    startTsSec: number;
    endTsSec: number;
    spotPrice: number;
  }): OpraPrintSummary | null;
}

export interface ZeroFlowCandlePoint {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  flowVwap?: number;
  vwap?: number;
  sigma?: number;
  chi?: number;
  impulseChi?: number;
  pe?: number;
  impulsePe?: number;
  netFluxJ?: number;
  deltaNetFlux6Bar?: number;
}

export interface ZeroDriverItem {
  key: "SES" | "30M" | "10M" | "STDY" | "PX";
  value: number;
  rawValue: number;
  display: string;
  isPct: boolean;
}

export interface EvaluateZeroFlowFilterInput {
  ticker: string;
  candles: ZeroFlowCandlePoint[];
  liveSpot?: number | null;
  open930?: number | null;
  priorClose?: number | null;
  straddleEm?: number | null;
  zeroGamma0Dte?: number | null;
  callWall0Dte?: number | null;
  putWall0Dte?: number | null;
  netGex?: number | null;
  medianNearAtmSpreadPct?: number | null;
  activeCallDirection?: "LONG" | "SHORT" | null;
  activeCallEntryPrice?: number | null;
  regimeMode?: "FOLLOW" | "FADE" | "SIT_OUT";
  standAsideVetoReason?: string | null;
  opraAdapter?: OpraPrintAdapter | null;
}

export interface ZeroFlowFilterResult {
  dataMode: ZeroDataMode;
  drivers: ZeroDriverItem[];
  compositeScore: number;
  verdict: ZeroCallVerdict;
  verdictReason: string;
  dominance: ZeroDominanceRegime;
  chiPct: number;
  dominancePct: number;
  dominanceLabel: string;
  turnLagMins: number;
  vwapCrossLagMins: number;
  stageTelemetry: {
    aggressorWeight: number;
    urgencyWeight: number;
    putSeatbeltDiscounted: boolean;
    counterTrendBounceDiscounted: boolean;
    amCallClarityBoost: boolean;
    outlierScrubbed: boolean;
    wideSpreadDampened: boolean;
  };
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function fmtSignedInt(v: number): string {
  const r = Math.round(v);
  return r > 0 ? `+${r}` : `${r}`;
}

export function computeDominanceReadout(
  chiRaw: number | undefined,
  impulseChiRaw?: number | undefined
): {
  dominance: ZeroDominanceRegime;
  chiPct: number;
  dominancePct: number;
  dominanceLabel: string;
} {
  const baseChi =
    typeof chiRaw === "number" && Number.isFinite(chiRaw) ? clamp(chiRaw, 0, 1) : 0.5;
  const impChi =
    typeof impulseChiRaw === "number" && Number.isFinite(impulseChiRaw)
      ? clamp(impulseChiRaw, 0, 1)
      : baseChi;
  const blended =
    Math.abs(impChi - 0.5) > Math.abs(baseChi - 0.5) + 0.08
      ? 0.72 * baseChi + 0.28 * impChi
      : baseChi;
  const chiPct = clamp(Math.round(blended * 100), 0, 100);

  if (chiPct >= 55) {
    return {
      dominance: "CALL",
      chiPct,
      dominancePct: chiPct,
      dominanceLabel: `CALL DOMINANCE ${chiPct}%`,
    };
  }
  if (chiPct <= 45) {
    const putDom = 100 - chiPct;
    return {
      dominance: "PUT",
      chiPct,
      dominancePct: putDom,
      dominanceLabel: `PUT DOMINANCE ${putDom}% (χ=${chiPct}%)`,
    };
  }
  return {
    dominance: "NEUTRAL",
    chiPct,
    dominancePct: chiPct,
    dominanceLabel: `NEUTRAL BALANCE (χ=${chiPct}%)`,
  };
}

/**
 * 4-Stage `@karmaoptions` Pre-Vote Flow Laundering Engine:
 * 1. Side / Aggressor Weighting (Lee-Ready / Bar-CLV displacement; OPRA ask/bid when plugged in)
 * 2. Urgency Weighting (`impulseChi`, `deltaNetFlux6Bar`, `Pe` velocity, turn-lag awareness)
 * 3. Bet vs. Insurance ("Seatbelt" put-hedge discounting & counter-trend micro-bounce filtering)
 * 4. Outlier / Cross / Wide-Spread Scrubbing
 */
export function evaluateZeroFlowFilter(
  input: EvaluateZeroFlowFilterInput
): ZeroFlowFilterResult {
  const n = input.candles.length;
  if (n === 0) {
    const emptyDom = computeDominanceReadout(0.5);
    return {
      dataMode: "CHAIN_SNAPSHOT_PDE",
      drivers: [
        { key: "SES", value: 0, rawValue: 0, display: "0", isPct: false },
        { key: "30M", value: 0, rawValue: 0, display: "0", isPct: false },
        { key: "10M", value: 0, rawValue: 0, display: "0", isPct: false },
        { key: "STDY", value: 50, rawValue: 50, display: "50%", isPct: true },
        { key: "PX", value: 0, rawValue: 0, display: "0", isPct: false },
      ],
      compositeScore: 0,
      verdict: "STAND_ASIDE",
      verdictReason: "AWAITING LIVE RTH TAPE",
      ...emptyDom,
      turnLagMins: 0,
      vwapCrossLagMins: 0,
      stageTelemetry: {
        aggressorWeight: 1,
        urgencyWeight: 1,
        putSeatbeltDiscounted: false,
        counterTrendBounceDiscounted: false,
        amCallClarityBoost: false,
        outlierScrubbed: false,
        wideSpreadDampened: false,
      },
    };
  }

  const last = input.candles[n - 1];
  const lastTsSec = toEpochSec(last.timestamp || Date.now());
  const etMins = lastTsSec > 0 ? etMinutesOfDay(lastTsSec) : 600;
  const spot =
    typeof input.liveSpot === "number" && Number.isFinite(input.liveSpot) && input.liveSpot > 0
      ? input.liveSpot
      : last.close;
  const em = Math.max(
    Math.max(0.05, spot * 0.0005),
    typeof input.straddleEm === "number" && input.straddleEm > 0
      ? input.straddleEm
      : spot * 0.0048
  );

  // Optional OPRA print adapter query (strictly null unless real print feed plugged in)
  const opraSummary =
    input.opraAdapter && lastTsSec > 0
      ? input.opraAdapter.getWindowSummary({
          ticker: input.ticker,
          startTsSec: Math.max(0, lastTsSec - 600),
          endTsSec: lastTsSec,
          spotPrice: spot,
        })
      : null;
  const dataMode: ZeroDataMode = opraSummary ? "OPRA_PRINT_STREAM" : "CHAIN_SNAPSHOT_PDE";

  // Median True Range over recent 14 bars for Stage 1 & Stage 4
  const trLookback = Math.max(0, n - 15);
  const trs: number[] = [];
  for (let i = trLookback; i < n; i++) {
    const c = input.candles[i];
    const prevC = i > 0 ? input.candles[i - 1].close : c.open;
    trs.push(Math.max(c.high - c.low, Math.abs(c.close - prevC)));
  }
  const sortedTrs = [...trs].sort((a, b) => a - b);
  const medianTr =
    sortedTrs.length > 0
      ? Math.max(0.02, sortedTrs[Math.floor(sortedTrs.length / 2)])
      : Math.max(0.05, spot * 0.0008);

  // --- STAGE 4 PRE-SCRUB: Single-bar outlier spike & wide option spread dampening ---
  const prevCloseBar = n >= 2 ? input.candles[n - 2].close : last.open;
  const lastTr = Math.max(last.high - last.low, Math.abs(spot - prevCloseBar));
  const bodyRatio = lastTr > 1e-5 ? Math.abs(spot - last.open) / lastTr : 0.5;
  const outlierScrubbed = n >= 3 && lastTr > 3.2 * medianTr && bodyRatio < 0.32;
  const scrubbedSpot = outlierScrubbed
    ? prevCloseBar + clamp(spot - prevCloseBar, -1.5 * medianTr, 1.5 * medianTr)
    : spot;
  const wideSpreadDampened =
    typeof input.medianNearAtmSpreadPct === "number" &&
    Number.isFinite(input.medianNearAtmSpreadPct) &&
    input.medianNearAtmSpreadPct > 0.24;
  const spreadMult = wideSpreadDampened ? 0.65 : 1.0;

  // Raw 5 drivers before laundering
  const baseOpen =
    typeof input.open930 === "number" && input.open930 > 0
      ? input.open930
      : input.candles[0]?.open || scrubbedSpot;
  const priorClose =
    typeof input.priorClose === "number" && input.priorClose > 0 ? input.priorClose : 0;
  const fVwap = last.flowVwap || last.vwap || scrubbedSpot;

  // Blend 9:30 open with overnight/VWAP anchor when a pre-market gap sits on the same side of Flow VWAP
  const sesAnchor =
    priorClose > 0 &&
    ((scrubbedSpot < fVwap && priorClose > baseOpen) ||
      (scrubbedSpot > fVwap && priorClose < baseOpen))
      ? 0.72 * baseOpen + 0.28 * priorClose
      : baseOpen;
  const sesRaw = clamp(Math.round(((scrubbedSpot - sesAnchor) / em) * 65), -99, 99);

  const bar30m = input.candles[Math.max(0, n - 7)];
  const m30Raw = clamp(Math.round(((scrubbedSpot - bar30m.close) / (em * 0.45)) * 75), -99, 99);

  const bar10m = input.candles[Math.max(0, n - 3)];
  const m10Raw = clamp(Math.round(((scrubbedSpot - bar10m.close) / (em * 0.22)) * 80), -99, 99);

  const lookbackStdy = Math.min(8, Math.max(1, n - 1));
  let pathSum = 0;
  for (let i = Math.max(1, n - lookbackStdy); i < n; i++) {
    const pC = input.candles[i - 1].close;
    const cC = i === n - 1 ? scrubbedSpot : input.candles[i].close;
    pathSum += Math.abs(cC - pC);
  }
  const netChange8 = Math.abs(
    scrubbedSpot - input.candles[Math.max(0, n - 1 - lookbackStdy)].close
  );
  const er = pathSum > 1e-5 ? clamp(netChange8 / pathSum, 0, 1) : 0.5;
  const stdyRaw = clamp(Math.round((0.42 + 0.56 * er) * 100), 20, 98);

  const pxRaw = clamp(Math.round(((scrubbedSpot - fVwap) / (em * 0.35)) * 70), -99, 99);

  // --- STAGE 1: Side / Aggressor Weighting (Lee-Ready / CLV) ---
  let aggressorWeight = 1.0;
  if (opraSummary && opraSummary.totalContracts > 0) {
    const aggressiveShare =
      (opraSummary.askSideContracts + opraSummary.bidSideContracts * 0.5) /
      Math.max(1, opraSummary.totalContracts);
    const sweepShare = opraSummary.sweepContracts / Math.max(1, opraSummary.totalContracts);
    aggressorWeight = clamp(0.45 + aggressiveShare * 0.65 + sweepShare * 0.35, 0.4, 1.35);
  } else {
    // 2-bar range-weighted CLV + range expansion ratio
    const recent2 = input.candles.slice(Math.max(0, n - 2));
    let clvMagAcc = 0;
    let trRatioAcc = 0;
    for (let k = 0; k < recent2.length; k++) {
      const b = recent2[k];
      const cVal = k === recent2.length - 1 ? scrubbedSpot : b.close;
      const hi = Math.max(b.high, cVal);
      const lo = Math.min(b.low, cVal);
      const span = Math.max(0.01, hi - lo);
      const clv = Math.abs((2 * cVal - hi - lo) / span);
      clvMagAcc += clv;
      trRatioAcc += span / medianTr;
    }
    const avgClvMag = clvMagAcc / recent2.length;
    const avgTrRatio = trRatioAcc / recent2.length;
    if (avgClvMag < 0.25 && avgTrRatio < 0.7) {
      aggressorWeight = 0.45; // polite mid-spread drift discounted
    } else if (avgClvMag >= 0.6 && avgTrRatio >= 0.9) {
      aggressorWeight = clamp(1.0 + (avgClvMag - 0.6) * 0.6, 1.0, 1.28);
    } else {
      aggressorWeight = clamp(0.65 + avgClvMag * 0.45, 0.55, 1.15);
    }
  }

  // --- STAGE 2: Urgency & Entry-Lag Measurement ---
  const pe = typeof last.pe === "number" && Number.isFinite(last.pe) ? last.pe : 0;
  const impPe =
    typeof last.impulsePe === "number" && Number.isFinite(last.impulsePe) ? last.impulsePe : pe;
  const dFlux6 =
    typeof last.deltaNetFlux6Bar === "number" && Number.isFinite(last.deltaNetFlux6Bar)
      ? last.deltaNetFlux6Bar
      : 0;

  // Measure causal turn lag (minutes since 90m swing extremum) & Flow VWAP cross lag
  const lookStart = Math.max(0, n - 19);
  const leanBull = pxRaw >= 0;
  let extIdx = n - 1;
  for (let k = lookStart; k < n; k++) {
    if (leanBull && input.candles[k].low <= input.candles[extIdx].low) extIdx = k;
    if (!leanBull && input.candles[k].high >= input.candles[extIdx].high) extIdx = k;
  }
  const extSec = toEpochSec(input.candles[extIdx]?.timestamp || lastTsSec);
  const turnLagMins =
    lastTsSec > 0 && extSec > 0 ? Math.max(0, Math.round((lastTsSec - extSec) / 60)) : 0;

  let crossIdx = n - 1;
  for (let k = n - 1; k > lookStart; k--) {
    const curV = input.candles[k].flowVwap || input.candles[k].vwap || input.candles[k].close;
    const prevV =
      input.candles[k - 1].flowVwap || input.candles[k - 1].vwap || input.candles[k - 1].close;
    const curD = (k === n - 1 ? scrubbedSpot : input.candles[k].close) - curV;
    const prevD = input.candles[k - 1].close - prevV;
    if ((leanBull && curD >= 0 && prevD < 0) || (!leanBull && curD <= 0 && prevD > 0)) {
      crossIdx = k;
      break;
    }
  }
  const crossSec = toEpochSec(input.candles[crossIdx]?.timestamp || lastTsSec);
  const vwapCrossLagMins =
    lastTsSec > 0 && crossSec > 0 ? Math.max(0, Math.round((lastTsSec - crossSec) / 60)) : 0;

  const absImpPe = Math.abs(impPe);
  let urgencyWeight = clamp(
    0.72 + Math.min(0.45, absImpPe * 0.14) + Math.min(0.18, Math.abs(dFlux6) * 0.008),
    0.55,
    1.32
  );
  if (turnLagMins > 50 && absImpPe < 1.8) {
    urgencyWeight *= 0.72; // late-chase penalty
  }

  // --- STAGE 3: Bet vs. Insurance (Put-Hedge Seatbelt Discounting & Counter-Trend Bounce Guard) ---
  const zg0 =
    typeof input.zeroGamma0Dte === "number" && input.zeroGamma0Dte > 0 ? input.zeroGamma0Dte : 0;
  const netFlux =
    typeof last.netFluxJ === "number" && Number.isFinite(last.netFluxJ) ? last.netFluxJ : 0;
  const netGex =
    typeof input.netGex === "number" && Number.isFinite(input.netGex) ? input.netGex : 0;

  const hasBearishStructure =
    scrubbedSpot < fVwap &&
    ((zg0 > 0 && scrubbedSpot < zg0) ||
      netFlux < -4 ||
      pxRaw <= -20 ||
      (priorClose > 0 && scrubbedSpot < priorClose * 0.996));

  const hasBullishStructure =
    scrubbedSpot > fVwap &&
    ((zg0 <= 0 || scrubbedSpot >= zg0 * 0.999) || netFlux > 4 || pxRaw >= 20);

  let putSeatbeltDiscounted = false;
  let counterTrendBounceDiscounted = false;
  let amCallClarityBoost = false;

  let sesLaundered = sesRaw;
  let m30Laundered = m30Raw * spreadMult;
  let m10Laundered = m10Raw * aggressorWeight * urgencyWeight * spreadMult;
  let pxLaundered = pxRaw;

  // 3A. Unconfirmed put-hedge "seatbelt" noise above Flow VWAP / Zero-Gamma -> discount 0.45x
  if (!hasBearishStructure) {
    if (m10Laundered < 0) {
      m10Laundered *= 0.45;
      putSeatbeltDiscounted = true;
    }
    if (m30Laundered < 0 && scrubbedSpot >= fVwap) {
      m30Laundered *= 0.55;
      putSeatbeltDiscounted = true;
    }
  }

  // 3B. Counter-trend 10M dead-cat bounce inside deep bearish structure (e.g. SPY 10:54 AM: spot $3.43 below VWAP, PX=-63, NetGEX < 0)
  if (hasBearishStructure && pxRaw <= -30 && m10Laundered > 0 && (netGex <= 0 || netFlux < 0)) {
    m10Laundered *= 0.32;
    counterTrendBounceDiscounted = true;
  }
  // Symmetric: counter-trend 10M dip inside strong bullish structure above VWAP
  if (hasBullishStructure && pxRaw >= 30 && m10Laundered < 0 && netFlux > 0) {
    m10Laundered *= 0.42;
  }

  // 3C. Pre-noon (< 12:00 ET) bullish call burst clarity vs afternoon 0DTE call chase decay
  if (etMins >= 570 && etMins < 720 && hasBullishStructure && m10Laundered > 0 && m30Laundered >= 0) {
    m10Laundered *= 1.12;
    m30Laundered *= 1.08;
    amCallClarityBoost = true;
  } else if (etMins >= 720 && m10Laundered > 0 && !hasBullishStructure) {
    m10Laundered *= 0.55;
  }

  sesLaundered = clamp(Math.round(sesLaundered), -99, 99);
  m30Laundered = clamp(Math.round(m30Laundered), -99, 99);
  m10Laundered = clamp(Math.round(m10Laundered), -99, 99);
  pxLaundered = clamp(Math.round(pxLaundered * spreadMult), -99, 99);
  const stdyLaundered = outlierScrubbed ? Math.max(20, stdyRaw - 12) : stdyRaw;

  const drivers: ZeroDriverItem[] = [
    { key: "SES", value: sesLaundered, rawValue: sesRaw, display: fmtSignedInt(sesLaundered), isPct: false },
    { key: "30M", value: m30Laundered, rawValue: m30Raw, display: fmtSignedInt(m30Laundered), isPct: false },
    { key: "10M", value: m10Laundered, rawValue: m10Raw, display: fmtSignedInt(m10Laundered), isPct: false },
    { key: "STDY", value: stdyLaundered, rawValue: stdyRaw, display: `${stdyLaundered}%`, isPct: true },
    { key: "PX", value: pxLaundered, rawValue: pxRaw, display: fmtSignedInt(pxLaundered), isPct: false },
  ];

  // Dominance & chi readout (never labels 50% tie as CALL)
  const dom = computeDominanceReadout(last.chi, last.impulseChi);
  const fluxScore = clamp(((dom.chiPct - 50) * 1.6) + pe * 5.0, -90, 90);

  // Multi-driver laundered composite score (-100..+100)
  let compositeScore: number;
  if (
    input.activeCallDirection &&
    typeof input.activeCallEntryPrice === "number" &&
    input.activeCallEntryPrice > 0
  ) {
    const dir = input.activeCallDirection === "LONG" ? 1 : -1;
    const deltaPts = (scrubbedSpot - input.activeCallEntryPrice) * dir;
    const pnlTerm = ((deltaPts / (em * 0.4)) * 45) * dir;
    const flowTerm =
      0.20 * sesLaundered +
      0.25 * m30Laundered +
      0.20 * m10Laundered +
      0.25 * pxLaundered +
      0.10 * fluxScore;
    compositeScore = clamp(Math.round(0.55 * pnlTerm + 0.45 * flowTerm), -99, 99);
    if (compositeScore === 0) compositeScore = 10 * dir;
  } else {
    const stdyScale = 0.72 + (stdyLaundered / 100) * 0.36;
    const weighted =
      (0.20 * sesLaundered +
        0.24 * m30Laundered +
        0.16 * m10Laundered +
        0.28 * pxLaundered +
        0.12 * fluxScore) *
      stdyScale;
    compositeScore = clamp(Math.round(weighted), -99, 99);
  }

  // Authoritative Zero Call Card Verdict:
  // 1. If a live authoritative server trade is open, reflect it 1:1.
  // 2. Otherwise require regime clearance AND multi-driver alignment — never mirror raw 10M!
  let verdict: ZeroCallVerdict = "STAND_ASIDE";
  let verdictReason = "AWAITING MULTI-DRIVER CONFLUENCE";

  if (input.activeCallDirection === "LONG" || input.activeCallDirection === "SHORT") {
    verdict = input.activeCallDirection;
    verdictReason = `ACTIVE ${input.activeCallDirection} POSITION`;
  } else if (input.regimeMode === "SIT_OUT" || input.standAsideVetoReason) {
    verdict = "STAND_ASIDE";
    verdictReason = input.standAsideVetoReason
      ? `SIT OUT · ${input.standAsideVetoReason.slice(0, 44).toUpperCase()}`
      : "SIT OUT · TOLL GATE BLOCKED";
  } else if (counterTrendBounceDiscounted) {
    verdict = "STAND_ASIDE";
    verdictReason = "CHOP · 10M BOUNCE BELOW FLOW VWAP";
  } else if (putSeatbeltDiscounted && compositeScore < 28) {
    verdict = "STAND_ASIDE";
    verdictReason = "PUT HEDGE SEATBELT FILTERED";
  } else if (
    (pxLaundered <= -25 && m10Raw >= 20) ||
    (pxLaundered >= 25 && m10Raw <= -20) ||
    (m30Laundered * pxLaundered < -400)
  ) {
    verdict = "STAND_ASIDE";
    verdictReason = "CHOP · CONFLICTING DRIVERS";
  } else if (turnLagMins > 55 && Math.abs(compositeScore) < 55) {
    verdict = "STAND_ASIDE";
    verdictReason = `LATE CHASE VETO (${turnLagMins}M TURN LAG)`;
  } else if (compositeScore >= 32 && hasBullishStructure && dom.dominance !== "PUT") {
    verdict = "LONG";
    verdictReason =
      input.regimeMode === "FADE" ? "FADE · BULLISH RECLAIM CONFIRMED" : "FOLLOW · BULLISH FLOW ALIGNED";
  } else if (compositeScore <= -32 && hasBearishStructure && dom.dominance !== "CALL") {
    verdict = "SHORT";
    verdictReason =
      input.regimeMode === "FADE" ? "FADE · WALL REJECTION CONFIRMED" : "FOLLOW · BEARISH FLUSH ALIGNED";
  } else {
    verdict = "STAND_ASIDE";
    verdictReason =
      Math.abs(compositeScore) < 32
        ? "STAND ASIDE · SUB-THRESHOLD EDGE"
        : "STAND ASIDE · STRUCTURE UNCONFIRMED";
  }

  return {
    dataMode,
    drivers,
    compositeScore,
    verdict,
    verdictReason,
    ...dom,
    turnLagMins,
    vwapCrossLagMins,
    stageTelemetry: {
      aggressorWeight: Number(aggressorWeight.toFixed(2)),
      urgencyWeight: Number(urgencyWeight.toFixed(2)),
      putSeatbeltDiscounted,
      counterTrendBounceDiscounted,
      amCallClarityBoost,
      outlierScrubbed,
      wideSpreadDampened,
    },
  };
}
