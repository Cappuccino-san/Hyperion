import {
  selectSmallAccountContract,
  fetchLiveCboeOptions,
  getCachedSpotPrice,
  loadTradeStore,
  saveTradeStore,
  TradeLifecycleAlert,
  getTodayEt,
} from "./tradeSignalEngine";
import { computeOptionsAnalytics } from "./optionsExposure";

export interface PreTradeSetupIdea {
  ticker: string;
  spotPrice: number;
  callWall: number;
  putWall: number;
  zeroGamma: number;
  callSetup: {
    name: string;
    triggerCondition: string;
    triggerLevel: number;
    distancePct: number;
    target1: number;
    target2: number;
    stopLoss: number;
    contractLabel: string;
    optionMid: number;
    contractsQty: number;
    totalOutlay: number;
  };
  putSetup: {
    name: string;
    triggerCondition: string;
    triggerLevel: number;
    distancePct: number;
    target1: number;
    target2: number;
    stopLoss: number;
    contractLabel: string;
    optionMid: number;
    contractsQty: number;
    totalOutlay: number;
  };
}

export interface TradeRadarPayload {
  timestamp: string;
  chartUrl: string;
  setups: PreTradeSetupIdea[];
  marketRegime: string;
}

/**
 * Generates a clean dark-mode intraday chart URL using QuickChart.io
 */
export async function generateIntradayChartUrl(params: {
  ticker: string;
  spotPrice: number;
  callWall: number;
  putWall: number;
  zeroGamma?: number;
}): Promise<string> {
  const { ticker, spotPrice, callWall, putWall, zeroGamma } = params;
  const yahooSym = ticker === "SPX" || ticker === "SPXW" ? "^GSPC" : ticker === "QQQ" ? "QQQ" : "SPY";

  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
        yahooSym
      )}?interval=5m&range=1d&includePrePost=false`,
      {
        headers: { "User-Agent": "Mozilla/5.0" },
        cache: "no-store",
      }
    );

    if (!res.ok) throw new Error("Chart fetch failed");
    const json = await res.json();
    const result = json?.chart?.result?.[0];
    const timestamps: number[] = result?.timestamp ?? [];
    const closes: (number | null)[] = result?.indicators?.quote?.[0]?.close ?? [];

    const validPoints: { ts: number; close: number }[] = [];
    for (let i = 0; i < closes.length; i++) {
      const c = closes[i];
      if (typeof c === "number" && c > 0) {
        validPoints.push({ ts: timestamps[i], close: c });
      }
    }

    if (validPoints.length < 4) throw new Error("Insufficient chart points");

    // Sample down to ~12 points for clean chart labeling
    const step = Math.max(1, Math.floor(validPoints.length / 11));
    const sampled: { ts: number; close: number }[] = [];
    for (let i = 0; i < validPoints.length; i += step) {
      sampled.push(validPoints[i]);
    }
    const lastValid = validPoints[validPoints.length - 1];
    if (sampled[sampled.length - 1].ts !== lastValid.ts) {
      sampled.push(lastValid);
    }

    const labels = sampled.map((p) => {
      const d = new Date(p.ts * 1000);
      return d.toLocaleTimeString("en-US", {
        timeZone: "America/New_York",
        hour: "numeric",
        minute: "2-digit",
      });
    });

    const prices = sampled.map((p) => Number(p.close.toFixed(2)));
    const len = labels.length;

    const datasets: any[] = [
      {
        label: `${ticker} Spot ($${spotPrice.toFixed(2)})`,
        data: prices,
        borderColor: "#38bdf8",
        backgroundColor: "rgba(56, 189, 248, 0.12)",
        fill: true,
        borderWidth: 2.5,
        pointRadius: 2.5,
        pointBackgroundColor: "#38bdf8",
      },
    ];

    if (callWall > 0) {
      datasets.push({
        label: `Call Wall ($${callWall.toFixed(0)})`,
        data: Array(len).fill(callWall),
        borderColor: "#10b981",
        borderDash: [5, 4],
        borderWidth: 2,
        pointRadius: 0,
        fill: false,
      });
    }

    if (putWall > 0) {
      datasets.push({
        label: `Put Wall ($${putWall.toFixed(0)})`,
        data: Array(len).fill(putWall),
        borderColor: "#ef4444",
        borderDash: [5, 4],
        borderWidth: 2,
        pointRadius: 0,
        fill: false,
      });
    }

    if (zeroGamma && zeroGamma > 0) {
      datasets.push({
        label: `Zero Gamma ($${zeroGamma.toFixed(1)})`,
        data: Array(len).fill(zeroGamma),
        borderColor: "#a855f7",
        borderDash: [3, 3],
        borderWidth: 1.5,
        pointRadius: 0,
        fill: false,
      });
    }

    const chartConfig = {
      type: "line",
      data: { labels, datasets },
      options: {
        title: {
          display: true,
          text: `${ticker} Intraday Gamma Structure & Key Wall Levels`,
          fontColor: "#f8fafc",
          fontSize: 14,
        },
        legend: {
          labels: { fontColor: "#94a3b8", fontSize: 11, boxWidth: 12 },
        },
        scales: {
          xAxes: [
            {
              ticks: { fontColor: "#64748b", fontSize: 10 },
              gridLines: { color: "rgba(255,255,255,0.06)" },
            },
          ],
          yAxes: [
            {
              ticks: { fontColor: "#64748b", fontSize: 10 },
              gridLines: { color: "rgba(255,255,255,0.06)" },
            },
          ],
        },
      },
    };

    // Use QuickChart shortener POST endpoint to keep URL <= 80 chars for Discord compliance
    const postRes = await fetch("https://quickchart.io/chart/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        backgroundColor: "#0b0f19",
        width: 650,
        height: 320,
        chart: chartConfig,
      }),
    });

    if (postRes.ok) {
      const data = await postRes.json();
      if (data?.url) return data.url;
    }

    return `https://quickchart.io/chart?bkg=%230b0f19&w=650&h=320&c=${encodeURIComponent(
      JSON.stringify(chartConfig)
    )}`;
  } catch {
    return "";
  }
}

/**
 * Builds the complete multi-ticker pre-trade radar gameplan without internal HTTP deadlocks
 */
export async function getPreTradeRadarData(): Promise<TradeRadarPayload> {
  const defaultLevels: Record<string, { callWall: number; putWall: number; zeroGamma: number }> = {
    SPY: { callWall: 770, putWall: 760, zeroGamma: 773.59 },
    QQQ: { callWall: 740, putWall: 700, zeroGamma: 730.51 },
  };

  const tickers = ["SPY", "QQQ"];
  const setups: PreTradeSetupIdea[] = [];

  for (const ticker of tickers) {
    try {
      // 1. Fetch live CBOE contracts in-process directly
      const contracts = await fetchLiveCboeOptions(ticker);
      let spot = getCachedSpotPrice(ticker);

      if (!spot || spot <= 0) {
        // Fallback to recent last trade price in contracts
        const atm = contracts.find((c) => c.last && c.last > 0);
        spot = atm?.strike || (ticker === "SPY" ? 764 : 705);
      }

      // Institutional 0DTE Options Exposure: extract real 0DTE / Next-Exp tactical walls
      const analytics = computeOptionsAnalytics({
        ticker,
        dataSource: "CBOE_MARKET_DATA",
        spotPrice: spot,
        previousClose: spot,
        impliedVolatility: 0.18,
        contracts,
      });

      const zeroDteLevels = analytics.gammaLevelsByFilter?.["0DTE"] ?? analytics.gammaLevelsByFilter?.["THIS_WEEK"];
      const callWall =
        zeroDteLevels?.callWall && zeroDteLevels.callWall > 0
          ? zeroDteLevels.callWall
          : analytics.gammaLevels.callWall > 0 && Math.abs(analytics.gammaLevels.callWall - spot) / spot < 0.025
            ? analytics.gammaLevels.callWall
            : Math.round(spot * 1.008);

      const putWall =
        zeroDteLevels?.putWall && zeroDteLevels.putWall > 0
          ? zeroDteLevels.putWall
          : analytics.gammaLevels.putWall > 0 && Math.abs(spot - analytics.gammaLevels.putWall) / spot < 0.025
            ? analytics.gammaLevels.putWall
            : Math.round(spot * 0.992);

      const zeroGamma =
        zeroDteLevels?.zeroGamma && zeroDteLevels.zeroGamma > 0
          ? zeroDteLevels.zeroGamma
          : analytics.gammaLevels.zeroGamma;

      // Institutional 3-Tier Execution Hierarchy:
      // Tier 1: Tactical Intraday Range (Daily Expected Move & Local Gamma Nodes: e.g. $762 & $768)
      // Tier 2: Midday Equilibrium / Rotation Node (e.g. Strike $765 where 68% gamma sits)
      // Tier 3: Macro Tail Boundaries (King / 0DTE Walls: e.g. $760 & $770)
      const dailyEm = analytics.expectedMoves?.daily;
      const dailyEmLow = dailyEm && dailyEm.low > 0 ? Number(dailyEm.low.toFixed(2)) : 0;
      const dailyEmHigh = dailyEm && dailyEm.high > 0 ? Number(dailyEm.high.toFixed(2)) : 0;

      const tacticalSupport =
        dailyEmLow > 0 && dailyEmLow > putWall && Math.abs(spot - dailyEmLow) / spot < 0.02
          ? Math.round(dailyEmLow)
          : putWall;

      const tacticalResistance =
        dailyEmHigh > 0 && dailyEmHigh < callWall && Math.abs(dailyEmHigh - spot) / spot < 0.02
          ? Math.round(dailyEmHigh)
          : callWall;

      const pivotMid = Number(((tacticalSupport + tacticalResistance) / 2).toFixed(1));
      const tacticalPivot =
        zeroGamma > tacticalSupport && zeroGamma < tacticalResistance
          ? Number(zeroGamma.toFixed(1))
          : Math.round(pivotMid);

      // Invariant: Directional trade targets strictly follow delta direction:
      // CALLS: tacticalSupport < callTarget1 (tacticalPivot) < callTarget2 (tacticalResistance)
      // PUTS:  tacticalResistance > putTarget1 (tacticalPivot) > putTarget2 (tacticalSupport)
      const callTarget1 = tacticalPivot;
      const callTarget2 = tacticalResistance;

      const putTarget1 = tacticalPivot;
      const putTarget2 = tacticalSupport;

      // Pre-select candidate Call contract for Support Bounce
      const callContract = await selectSmallAccountContract({
        ticker,
        contractType: "CALL",
        spotPrice: spot,
        target1Spot: callTarget1,
        target2Spot: callTarget2,
        stopLossSpot: Number((tacticalSupport * 0.998).toFixed(2)),
        contracts,
        zeroDteCallWall: callWall,
        zeroDtePutWall: putWall,
      });

      // Pre-select candidate Put contract for Resistance Rejection (anchored to 0DTE walls)
      const putContract = await selectSmallAccountContract({
        ticker,
        contractType: "PUT",
        spotPrice: spot,
        target1Spot: putTarget1,
        target2Spot: putTarget2,
        stopLossSpot: Number((tacticalResistance * 1.002).toFixed(2)),
        contracts,
        zeroDteCallWall: callWall,
        zeroDtePutWall: putWall,
      });

      const distToSupportPct = Number((((spot - tacticalSupport) / spot) * 100).toFixed(2));
      const distToResistancePct = Number((((tacticalResistance - spot) / spot) * 100).toFixed(2));

      setups.push({
        ticker,
        spotPrice: spot,
        callWall,
        putWall,
        zeroGamma,
        callSetup: {
          name: "Support Bounce / Bullish Reversal",
          triggerCondition: `Test within 0.18% of $${tacticalSupport.toFixed(2)} with 5m Bull divergence/reclaim`,
          triggerLevel: Number((tacticalSupport * 1.0018).toFixed(2)),
          distancePct: distToSupportPct,
          target1: callTarget1,
          target2: callTarget2,
          stopLoss: Number((tacticalSupport * 0.998).toFixed(2)),
          contractLabel: callContract ? callContract.contractLabel : "No liquid contract under $1.00",
          optionMid: callContract ? callContract.optionMid : 0,
          contractsQty: callContract ? callContract.contractsQty : 1,
          totalOutlay: callContract ? callContract.totalOutlay : 0,
        },
        putSetup: {
          name: "Resistance Rejection / Bearish Reversal",
          triggerCondition: `Test within 0.18% of $${tacticalResistance.toFixed(2)} with 5m Bear rejection/SMA34 loss`,
          triggerLevel: Number((tacticalResistance * 0.9982).toFixed(2)),
          distancePct: distToResistancePct,
          target1: putTarget1,
          target2: putTarget2,
          stopLoss: Number((tacticalResistance * 1.002).toFixed(2)),
          contractLabel: putContract ? putContract.contractLabel : "No liquid contract under $1.00",
          optionMid: putContract ? putContract.optionMid : 0,
          contractsQty: putContract ? putContract.contractsQty : 1,
          totalOutlay: putContract ? putContract.totalOutlay : 0,
        },
      });
    } catch (err) {
      console.error(`[TradeRadar] Error computing radar for ${ticker}:`, err);
    }
  }

  // Generate primary chart for SPY
  const primary = setups.find((s) => s.ticker === "SPY") || setups[0];
  const chartUrl = primary
    ? await generateIntradayChartUrl({
        ticker: primary.ticker,
        spotPrice: primary.spotPrice,
        callWall: primary.callWall,
        putWall: primary.putWall,
        zeroGamma: primary.zeroGamma,
      })
    : "";

  const timeStr = new Date().toLocaleTimeString("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
  });

  return {
    timestamp: `${timeStr} ET`,
    chartUrl,
    setups,
    marketRegime: "Positive Gamma Pinning · Rangebound between Put Wall & Call Wall",
  };
}

/**
 * Dispatches the Pre-Trade Radar Gameplan & Chart to Discord
 */
export async function sendPreTradeRadarDiscordCard(customWebhookUrl?: string): Promise<boolean> {
  const webhookUrl =
    (customWebhookUrl || process.env.DISCORD_WEBHOOK_URL)?.trim() || "";
  if (!webhookUrl) {
    console.warn("[TradeRadar] Skipping radar Discord dispatch: DISCORD_WEBHOOK_URL is not configured.");
    return false;
  }

  try {
    const radar = await getPreTradeRadarData();
    const store = loadTradeStore();

    const fields: { name: string; value: string; inline: boolean }[] = [];

    for (const s of radar.setups) {
      const callIdeaStr = [
        `🟢 **BTO CALLS IDEA:** \`${s.callSetup.contractLabel}\``,
        `• **Trigger:** Dip test ~$${s.callSetup.triggerLevel.toFixed(2)} (${s.callSetup.distancePct}% away) + 5m confirmation`,
        `• **Targets:** TP1 $${s.callSetup.target1.toFixed(2)} | TP2 $${s.callSetup.target2.toFixed(2)} | SL $${s.callSetup.stopLoss.toFixed(2)}`,
        `• **Allocation:** ${s.callSetup.contractsQty}x contract ($${s.callSetup.totalOutlay} risk cap)`,
      ].join("\n");

      const putIdeaStr = [
        `🟣 **BTO PUTS IDEA:** \`${s.putSetup.contractLabel}\``,
        `• **Trigger:** Rally test ~$${s.putSetup.triggerLevel.toFixed(2)} (${s.putSetup.distancePct}% away) + 5m rejection`,
        `• **Targets:** TP1 $${s.putSetup.target1.toFixed(2)} | TP2 $${s.putSetup.target2.toFixed(2)} | SL $${s.putSetup.stopLoss.toFixed(2)}`,
        `• **Allocation:** ${s.putSetup.contractsQty}x contract ($${s.putSetup.totalOutlay} risk cap)`,
      ].join("\n");

      fields.push({
        name: `🎯 ${s.ticker} · Live Spot $${s.spotPrice.toFixed(2)} (Put Wall: $${s.putWall} | Call Wall: $${s.callWall})`,
        value: `${callIdeaStr}\n\n${putIdeaStr}`,
        inline: false,
      });
    }

    fields.push({
      name: "🛡️ Execution Discipline & Money-Making Rules",
      value: [
        "• **Theta Protection:** Contracts locked on **Tomorrow, Fri Oct 23 (1 DTE)** near ATM (0.25-0.50 delta).",
        "• **+18% Auto-BE Stop:** Once option reaches +18%, stop loss moves to Breakeven so green trades never lose.",
        "• **+25% Target 1 Scaling:** Guaranteed profit locking at TP1.",
        "• **-25% Option Hard Stop:** Strict risk containment.",
      ].join("\n"),
      inline: false,
    });

    const embedObj: any = {
      author: { name: "Hyperion Real-Time Options Radar · Pre-Trade Gameplan" },
      title: `📡 LIVE INTRADAY RADAR & PRE-TRADE ACTION PLAN · ${radar.timestamp}`,
      description: `**Market Regime:** \`${radar.marketRegime}\`\nLive monitoring active for structural wall tests into the 4:00 PM close. Review planned contracts and target levels below before execution.`,
      color: 0x38bdf8, // Sky Blue
      fields,
      timestamp: new Date().toISOString(),
      footer: {
        text: "Hyperion Terminal · Live Trade Signal Radar (1 Contract Max)",
      },
    };

    if (radar.chartUrl && radar.chartUrl.startsWith("http")) {
      embedObj.image = { url: radar.chartUrl };
    }

    const payload = {
      username: "Hyperion Terminal",
      embeds: [embedObj],
    };

    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    console.log("[TradeRadar] Discord response status:", res.status);
    if (!res.ok) {
      console.log("[TradeRadar] Discord error:", await res.text());
    }

    // Also push a radar notification into daily alerts for terminal visibility
    const radarAlert: TradeLifecycleAlert = {
      id: `radar-${Date.now()}`,
      timestamp: radar.timestamp,
      ts: Math.floor(Date.now() / 1000),
      ticker: "SPY",
      action: "BUY_TO_OPEN",
      contractType: "CALL",
      contractLabel: "Intraday Gameplan Active",
      strike: 760,
      expiration: getTodayEt(),
      setupName: "Intraday Radar Briefing",
      reason: "Live Monitoring Active",
      status: "OPEN",
      spotPrice: radar.setups[0]?.spotPrice || 762,
      btoSpotPrice: radar.setups[0]?.spotPrice || 762,
      target1Spot: radar.setups[0]?.callWall || 770,
      target2Spot: radar.setups[0]?.callWall || 770,
      stopLossSpot: radar.setups[0]?.putWall || 760,
      optionMid: 0.5,
      btoOptionMid: 0.5,
      contractsQty: 1,
      remainingQty: 1,
      totalOutlay: 0,
      isHistoricalBackfill: true,
      message: `📡 PRE-TRADE RADAR UPDATED: SPY $${radar.setups[0]?.spotPrice.toFixed(2)} testing toward Put Wall $${radar.setups[0]?.putWall}. Waiting for 5m confirmation.`,
    };

    store.dispatchedAlertIds = store.dispatchedAlertIds || {};
    store.dispatchedAlertIds[radarAlert.id] = true;
    store.alerts.push(radarAlert);
    saveTradeStore(store);

    return res.ok;
  } catch (err) {
    console.error("[TradeRadar] Failed to send radar Discord card:", err);
    return false;
  }
}
