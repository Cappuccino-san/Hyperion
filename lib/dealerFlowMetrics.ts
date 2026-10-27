// lib/dealerFlowMetrics.ts

export interface StrikeExposureSummary {
  strike: number;
  netGex: number;
  netVex?: number;
  netDex?: number;
  netCharm?: number;
}

export interface DealerFlowSummary {
  /** Net Dollar Gamma per 1% move ($M) */
  netGexM: number;
  /** Approximate Dealer Hedging Flow ($M) per $1.00 move in underlying spot */
  hedgingFlowPerPtM: number;
  /** Direction of dealer hedging relative to price movement */
  hedgingBehavior: 'COUNTER_TREND_ABSORB' | 'PRO_TREND_AMPLIFY' | 'NEUTRAL';
  /** Clean 2-word regime label for instant visual scanning */
  regimeLabel: string;
  /** Plain-English explanation of what dealers must do right now */
  plainEnglishThesis: string;
  /** Actionable posture for the trader */
  tacticalPlaybook: string;
  /** Effective Gamma Cushion Index [-100, +100] */
  cushionIndex: number;
  /** Center of Gamma Mass strike */
  centerOfGammaMass: number;
  /** Composite Pin Conviction Score [0..100] */
  pinConvictionScore: number;
  /** Distance from Spot to Zero-Gamma Flip (pts) */
  flipDistancePts: number | null;
  /** Distance from Spot to Primary King (pts) */
  kingDistancePts: number | null;
}

/**
 * Formats noisy dollar millions into calm, stabilized institutional strings
 * e.g. -1804.32 -> "-$1.80B", +482.1 -> "+$482M"
 */
export function formatStabilizedFlowM(valM: number, showPlus = true): string {
  if (!Number.isFinite(valM)) return '$0M';
  const sign = valM > 0 ? (showPlus ? '+' : '') : valM < 0 ? '-' : '';
  const abs = Math.abs(valM);
  if (abs >= 1000) {
    return `${sign}$${(abs / 1000).toFixed(2)}B`;
  }
  if (abs >= 100) {
    return `${sign}$${Math.round(abs)}M`;
  }
  return `${sign}$${abs.toFixed(1)}M`;
}

/**
 * Translates raw multi-strike exposure data into a calm, high-conviction Signal Summary.
 */
export function computeDealerFlowSummary(params: {
  spot: number;
  netGexM: number;
  zeroGammaFlip: number | null;
  kingStrike: number | null;
  allExpKingStrike?: number | null;
  callWall: number | null;
  putWall: number | null;
  strikes?: StrikeExposureSummary[];
}): DealerFlowSummary {
  const { spot, netGexM, zeroGammaFlip, kingStrike, allExpKingStrike, strikes = [] } = params;
  const safeSpot = spot > 0 ? spot : 1;

  // Since netGexM is scaled per 1% move (0.01 * S), per-$1.00 move flow is:
  // Flow_per_pt = NetGEX_1pct / (0.01 * S) = (NetGEX_1pct * 100) / S
  const hedgingFlowPerPtM = (netGexM * 100) / safeSpot;

  const absFlow = Math.abs(hedgingFlowPerPtM);
  const hedgingBehavior: DealerFlowSummary['hedgingBehavior'] =
    absFlow < 2.0
      ? 'NEUTRAL'
      : hedgingFlowPerPtM > 0
      ? 'COUNTER_TREND_ABSORB'
      : 'PRO_TREND_AMPLIFY';

  const cushionIndex = Math.max(
    -100,
    Math.min(100, Math.round(Math.tanh(hedgingFlowPerPtM / 120) * 100))
  );

  // Center of Gamma Mass (CoGM)
  let sumAbsGex = 0;
  let sumWeightedStrike = 0;
  for (const s of strikes) {
    const w = Math.abs(s.netGex);
    if (w > 0 && Number.isFinite(s.strike)) {
      sumAbsGex += w;
      sumWeightedStrike += s.strike * w;
    }
  }
  const centerOfGammaMass = sumAbsGex > 0 ? sumWeightedStrike / sumAbsGex : safeSpot;

  const flipDistancePts = zeroGammaFlip && zeroGammaFlip > 0 ? spot - zeroGammaFlip : null;
  const kingDistancePts = kingStrike && kingStrike > 0 ? kingStrike - spot : null;

  const kingStr = kingStrike ? `${kingStrike}` : 'King Node';
  const flowStr = formatStabilizedFlowM(Math.abs(hedgingFlowPerPtM), false);

  let regimeLabel = 'NEUTRAL TRANSITION';
  let plainEnglishThesis = 'Dealer gamma is balanced; market is driven primarily by directional volume.';
  let tacticalPlaybook = `Watch ${kingStr} pivot for directional breakout or rejection.`;

  if (hedgingBehavior === 'COUNTER_TREND_ABSORB') {
    regimeLabel = 'PIN & MEAN-REVERT';
    plainEnglishThesis = `Dealers absorb moves by buying dips & selling rips (~${flowStr}/pt), dampening volatility.`;
    tacticalPlaybook = `Fade range extremes back toward ${kingStr} magnet.`;
  } else if (hedgingBehavior === 'PRO_TREND_AMPLIFY') {
    regimeLabel = 'VOLATILITY EXPANSION';
    plainEnglishThesis = `Dealers amplify moves by selling into drops & buying into rips (~${flowStr}/pt).`;
    tacticalPlaybook =
      kingStrike && kingStrike < spot
        ? `Caution below flip — magnet at ${kingStr} pulls downward on weakness.`
        : `Momentum regime — ride directional trend toward ${kingStr}.`;
  }

  // Pin Conviction Score [0..100]
  const macroSplitPts = allExpKingStrike && kingStrike ? Math.abs(allExpKingStrike - kingStrike) : 0;
  const pinConvictionScore = Math.max(
    10,
    Math.min(98, Math.round(50 + cushionIndex * 0.4 - macroSplitPts * 1.5))
  );

  return {
    netGexM: Number(netGexM.toFixed(2)),
    hedgingFlowPerPtM: Number(hedgingFlowPerPtM.toFixed(2)),
    hedgingBehavior,
    regimeLabel,
    plainEnglishThesis,
    tacticalPlaybook,
    cushionIndex,
    centerOfGammaMass,
    pinConvictionScore,
    flipDistancePts,
    kingDistancePts,
  };
}

/**
 * Formats a comprehensive institutional Markdown/Slack/Discord Desk Brief.
 */
export function formatInstitutionalDeskBrief(params: {
  symbol: string;
  spot: number;
  regime: string;
  totalNetGex: number;
  totalNetVex?: number;
  totalNetDex?: number;
  kingStrike: number;
  allExpKingStrike?: number;
  callWall: number;
  putWall: number;
  zeroGammaLevel?: number;
  expectedMove?: number;
  flow?: DealerFlowSummary;
}): string {
  const {
    symbol,
    spot,
    regime,
    totalNetGex,
    totalNetVex = 0,
    totalNetDex = 0,
    kingStrike,
    allExpKingStrike,
    callWall,
    putWall,
    zeroGammaLevel,
    expectedMove,
    flow,
  } = params;

  const fmtM = (val: number) => {
    const m = Math.abs(val) > 1e6 ? val / 1e6 : val;
    const sign = m > 0 ? "+" : "";
    if (Math.abs(m) >= 1000) return `${sign}${(m / 1000).toFixed(2)}B`;
    return `${sign}${m.toFixed(1)}M`;
  };

  const ts = new Date().toLocaleTimeString("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const lines = [
    `⚡ **HYPERION QUANT DESK BRIEF — ${symbol.toUpperCase()} @ $${spot.toFixed(2)}** (${ts} ET)`,
    `• **Regime**: ${regime} | **Net GEX**: ${fmtM(totalNetGex)} | **Net VEX**: ${fmtM(totalNetVex)} | **Net DEX**: ${fmtM(totalNetDex)}`,
    `• **Key Nodes**: King **${kingStrike}**${
      allExpKingStrike && allExpKingStrike !== kingStrike ? ` | Macro King **${allExpKingStrike}**` : ""
    } | Flip **${zeroGammaLevel ? zeroGammaLevel.toFixed(2) : "N/A"}**`,
    `• **Structural Boundaries**: Call Ceiling **${callWall}** | Put Floor **${putWall}**${
      expectedMove ? ` | 1σ EM **±${expectedMove.toFixed(2)}**` : ""
    }`,
  ];

  if (flow) {
    lines.push(
      `• **Dealer Hedging Tide**: **${flow.hedgingFlowPerPtM >= 0 ? "+" : ""}${flow.hedgingFlowPerPtM.toFixed(1)}M/pt** (${
        flow.hedgingBehavior === 'COUNTER_TREND_ABSORB' ? 'Cushion/Buffer' : 'Acceleration'
      }) | **CoGM**: ${flow.centerOfGammaMass.toFixed(1)} | **Pin Conviction**: ${flow.pinConvictionScore}/100`
    );
  }

  return lines.join("\n");
}

/**
 * Zero-dependency Web Audio API acoustic synthesizer for institutional regime alerts.
 */
export function playTerminalAlertTone(type: "KING_SHIFT" | "GAMMA_FLIP" | "WALL_BREACH" | "CONFIRM"): void {
  if (typeof window === "undefined") return;
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    if (type === "CONFIRM") {
      osc.type = "sine";
      osc.frequency.setValueAtTime(880, now);
      osc.frequency.exponentialRampToValueAtTime(1318.5, now + 0.09);
      gain.gain.setValueAtTime(0.06, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
      osc.start(now);
      osc.stop(now + 0.12);
    } else if (type === "KING_SHIFT") {
      osc.type = "triangle";
      osc.frequency.setValueAtTime(587.33, now); // D5
      osc.frequency.setValueAtTime(880, now + 0.08); // A5
      gain.gain.setValueAtTime(0.08, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.24);
      osc.start(now);
      osc.stop(now + 0.24);
    } else if (type === "GAMMA_FLIP") {
      osc.type = "sine";
      osc.frequency.setValueAtTime(440, now);
      osc.frequency.exponentialRampToValueAtTime(220, now + 0.28);
      gain.gain.setValueAtTime(0.09, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
      osc.start(now);
      osc.stop(now + 0.3);
    } else if (type === "WALL_BREACH") {
      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(783.99, now); // G5
      osc.frequency.setValueAtTime(987.77, now + 0.1); // B5
      gain.gain.setValueAtTime(0.05, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
      osc.start(now);
      osc.stop(now + 0.25);
    }
  } catch {
    // Graceful fallback if audio context is restricted
  }
}
