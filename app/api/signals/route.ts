import { NextRequest, NextResponse } from "next/server";
import {
  evaluateTradeSignals,
  evaluateAllActivePositions,
  getActivePositions,
  getClosedPositions,
  getDailyTradeAlerts,
  clearDailyTrades,
  selectOptimalContract,
  sendDiscordTradeAlert,
  generateDailyPerformanceReport,
  checkAndSendMarketCloseRecap,
  TradeLifecycleAlert,
  syncGaiaSpySignalsToDiscord,
} from "@/lib/tradeSignalEngine";
import {
  getPreTradeRadarData,
  sendPreTradeRadarDiscordCard,
} from "@/lib/tradeRadar";
import {
  acquireBarEvaluationLock,
  releaseBarEvaluationLock,
} from "@/lib/liveBotDaemon";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const rawTicker = searchParams.get("ticker") || searchParams.get("symbol") || "";
    const ticker = rawTicker ? rawTicker.trim().toUpperCase() : undefined;
    const testAction = searchParams.get("test");
    const webhookUrl = searchParams.get("webhookUrl") || undefined;

    // Manual inspection endpoint (Does NOT post simulations to Discord)
    if (testAction === "bto_call" || testAction === "bto_put") {
      const targetTicker = ticker || "SPY";
      const isCall = testAction === "bto_call";
      const spotPrice = targetTicker === "SPY" ? 764.0 : targetTicker === "QQQ" ? 705.0 : 276.5;
      const callWall = targetTicker === "SPY" ? 770.0 : 710.0;
      const putWall = targetTicker === "SPY" ? 760.0 : 700.0;
      const target1Spot = isCall ? spotPrice + 2.0 : spotPrice - 2.0;
      const target2Spot = isCall ? callWall : putWall;
      const stopLossSpot = isCall ? putWall * 0.998 : callWall * 1.002;

      const contract = await selectOptimalContract({
        ticker: targetTicker,
        contractType: isCall ? "CALL" : "PUT",
        spotPrice,
        target1Spot,
        target2Spot,
        stopLossSpot,
        zeroDteCallWall: callWall,
        zeroDtePutWall: putWall,
      });

      if (!contract) {
        return NextResponse.json(
          { error: "No qualifying liquid contract found under $1.00" },
          { status: 404 }
        );
      }

      const nowTs = Math.floor(Date.now() / 1000);
      const testAlert: TradeLifecycleAlert = {
        id: `preview-${targetTicker}-${isCall ? "call" : "put"}-${nowTs}`,
        timestamp: new Date().toLocaleTimeString("en-US", {
          timeZone: "America/New_York",
          hour: "numeric",
          minute: "2-digit",
        }),
        ts: nowTs,
        ticker: targetTicker,
        action: "BUY_TO_OPEN",
        contractType: isCall ? "CALL" : "PUT",
        contractLabel: contract.contractLabel,
        strike: contract.strike,
        expiration: contract.expiration,
        expHuman: contract.expHuman,
        robinhoodExp: contract.robinhoodExp,
        robinhoodTab: contract.robinhoodTab,
        setupName: isCall
          ? "Put Wall Bounce / Bullish Reversal"
          : "Call Wall Rejection / Bearish Reversal",
        reason: isCall
          ? "Put Wall Bounce / Bullish Reversal"
          : "Call Wall Rejection / Bearish Reversal",
        status: "OPEN",
        spotPrice,
        btoSpotPrice: spotPrice,
        target1Spot,
        target2Spot,
        stopLossSpot,
        optionMid: contract.optionMid,
        optionBid: contract.optionBid,
        optionAsk: contract.optionAsk,
        btoOptionMid: contract.optionMid,
        contractsQty: contract.contractsQty,
        remainingQty: contract.contractsQty,
        totalOutlay: contract.totalOutlay,
        estTp1Mid: contract.estTp1Mid,
        estTp2Mid: contract.estTp2Mid,
        estStopMid: contract.estStopMid,
        tp1Pct: contract.tp1Pct,
        tp2Pct: contract.tp2Pct,
        rrRatio: 2.0,
        altContractNote: contract.altContractNote,
        message: `${isCall ? "🟢" : "🟣"} BUY TO OPEN (${contract.contractsQty}x @ $${contract.optionMid.toFixed(
          2
        )}) · ${contract.contractLabel} @ $${spotPrice.toFixed(2)} · SL: $${stopLossSpot.toFixed(
          2
        )}, TP1: $${target1Spot.toFixed(2)} (R:R 2.00:1 · $${contract.totalOutlay} Outlay)`,
      };

      return NextResponse.json({
        success: true,
        previewAlert: testAlert,
      });
    }

    if (testAction === "stc_tp1" || testAction === "stc_full" || testAction === "stc_put") {
      const targetTicker = ticker || "SPY";
      const isTp1 = testAction === "stc_tp1";
      const isPut = testAction === "stc_put";
      const btoSpot = targetTicker === "SPY" ? 763.5 : targetTicker === "QQQ" ? 708.0 : 274.0;
      const spotPrice = isPut
        ? (targetTicker === "SPY" ? 760.5 : targetTicker === "QQQ" ? 705.0 : 271.0)
        : (targetTicker === "SPY" ? 766.5 : targetTicker === "QQQ" ? 711.0 : 277.0);

      const contract = await selectOptimalContract({
        ticker: targetTicker,
        contractType: isPut ? "PUT" : "CALL",
        spotPrice: btoSpot,
        target1Spot: spotPrice,
        target2Spot: isPut ? spotPrice - 3.0 : spotPrice + 3.0,
        stopLossSpot: isPut ? btoSpot + 1.5 : btoSpot - 1.5,
      });

      if (!contract) {
        return NextResponse.json(
          { error: "No qualifying liquid contract found under $1.00" },
          { status: 404 }
        );
      }

      const btoMid = contract.optionMid;
      const liveMid = Number((btoMid * 1.55).toFixed(2)); // estimated +55% gain at TP1
      const nowTs = Math.floor(Date.now() / 1000);
      const spotPctGain = isPut
        ? Number((((btoSpot - spotPrice) / btoSpot) * 100).toFixed(2))
        : Number((((spotPrice - btoSpot) / btoSpot) * 100).toFixed(2));
      const testAlert: TradeLifecycleAlert = {
        id: `preview-stc-${targetTicker}-${isPut ? "put" : "call"}-${nowTs}`,
        timestamp: new Date().toLocaleTimeString("en-US", {
          timeZone: "America/New_York",
          hour: "numeric",
          minute: "2-digit",
        }),
        ts: nowTs,
        ticker: targetTicker,
        action: "SELL_TO_CLOSE",
        contractType: isPut ? "PUT" : "CALL",
        contractLabel: contract.contractLabel,
        strike: contract.strike,
        expiration: contract.expiration,
        expHuman: contract.expHuman,
        robinhoodExp: contract.robinhoodExp,
        robinhoodTab: contract.robinhoodTab,
        setupName: isPut
          ? "Call Wall Rejection / Bearish Reversal"
          : "Put Wall Bounce / Bullish Reversal",
        reason: isTp1
          ? "TARGET 1 HIT · SELL 1 OF 2 CONTRACTS (LOCK PROFIT)"
          : isPut
          ? "TARGET 1 HIT · COVER 1 PUT (LOCK PROFIT)"
          : "TARGET 2 HIT · SELL FINAL 1 CONTRACT (FULL TARGET)",
        status: isTp1 ? "PARTIAL_TP1" : "CLOSED",
        spotPrice,
        btoSpotPrice: btoSpot,
        target1Spot: spotPrice,
        target2Spot: isPut ? spotPrice - 3.0 : spotPrice + 3.0,
        stopLossSpot: isPut ? btoSpot + 1.5 : (isTp1 ? btoSpot : btoSpot - 1.5),
        optionMid: liveMid,
        btoOptionMid: btoMid,
        contractsQty: contract.contractsQty,
        remainingQty: isTp1 ? 1 : 0,
        totalOutlay: contract.totalOutlay,
        estTp1Mid: contract.estTp1Mid,
        estTp2Mid: contract.estTp2Mid,
        estStopMid: contract.estStopMid,
        tp1Pct: contract.tp1Pct,
        tp2Pct: contract.tp2Pct,
        pnlSpotPct: spotPctGain,
        pnlOptionPct: Number((((liveMid - btoMid) / btoMid) * 100).toFixed(1)),
        rrRatio: 2.0,
        message: `${
          isTp1 ? "💰 SELL TO CLOSE 1 OF 2 CONTRACTS" : isPut ? "💰 COVER 1 PUT CONTRACT" : "🎯 SELL TO CLOSE FINAL 1 CONTRACT"
        } · ${contract.contractLabel} @ $${liveMid.toFixed(2)} (+${Number(
          (((liveMid - btoMid) / btoMid) * 100).toFixed(1)
        )}%) · Spot +${spotPctGain}%`,
      };

      return NextResponse.json({
        success: true,
        previewAlert: testAlert,
      });
    }

    if (searchParams.get("scan") === "true" || searchParams.get("poll") === "all") {
      const baseUrl = req.nextUrl.origin || "http://localhost:3000";
      const tickers = ["SPY", "QQQ", "IWM"];
      for (const sym of tickers) {
        try {
          await fetch(`${baseUrl}/api/options?ticker=${sym}&force=true`, {
            cache: "no-store",
          }).then((r) => r.json());
        } catch {
          // Non-fatal
        }
      }
      const activePositions = getActivePositions();
      const closedPositions = getClosedPositions();
      const alerts = getDailyTradeAlerts();
      return NextResponse.json({
        success: true,
        mode: "LIVE_SCAN",
        activePositions,
        closedPositions,
        alerts,
        timestamp: new Date().toISOString(),
      });
    }

    if (searchParams.get("action") === "clear") {
      const lockToken = acquireBarEvaluationLock();
      if (!lockToken) {
        return NextResponse.json({ error: "Evaluation lock busy" }, { status: 409 });
      }
      try {
        clearDailyTrades();
        return NextResponse.json({ success: true, message: "Daily trades cleared." });
      } finally {
        releaseBarEvaluationLock(lockToken);
      }
    }

    if (searchParams.get("performance") === "true") {
      const report = generateDailyPerformanceReport();
      return NextResponse.json({ success: true, report });
    }

    if (searchParams.get("radar") === "true") {
      const radar = await getPreTradeRadarData();
      return NextResponse.json({ success: true, radar });
    }

    if (searchParams.get("action") === "send_radar") {
      const lockToken = acquireBarEvaluationLock();
      if (!lockToken) {
        return NextResponse.json({ error: "Evaluation lock busy" }, { status: 409 });
      }
      try {
        const sent = await sendPreTradeRadarDiscordCard(webhookUrl);
        return NextResponse.json({ success: sent, message: "Pre-trade radar dispatched to Discord." });
      } finally {
        releaseBarEvaluationLock(lockToken);
      }
    }

    if (searchParams.get("action") === "send_recap") {
      const lockToken = acquireBarEvaluationLock();
      if (!lockToken) {
        return NextResponse.json({ error: "Evaluation lock busy" }, { status: 409 });
      }
      try {
        const report = await checkAndSendMarketCloseRecap({ force: true, webhookUrl });
        return NextResponse.json({ success: true, message: "Daily recap sent to Discord.", report });
      } finally {
        releaseBarEvaluationLock(lockToken);
      }
    }

    // Continuously evaluate all open positions across all tickers against live CBOE quotes
    const getLockToken = acquireBarEvaluationLock();
    if (getLockToken) {
      try {
        await evaluateAllActivePositions({ webhookUrl });
      } finally {
        releaseBarEvaluationLock(getLockToken);
      }
    }

    const activePositions = getActivePositions();
    const closedPositions = getClosedPositions(ticker);
    const alerts = getDailyTradeAlerts(ticker);

    return NextResponse.json({
      activePositions,
      closedPositions,
      alerts,
      timestamp: new Date().toISOString(),
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: errorMsg }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    if (body.action === "SYNC_GAIA_SPY_SIGNALS") {
      const lockToken = acquireBarEvaluationLock();
      if (!lockToken) {
        return NextResponse.json({ success: false, busy: true, dispatchedCount: 0, keys: [] }, { status: 409 });
      }
      try {
        const res = await syncGaiaSpySignalsToDiscord({
          ticker: body.ticker || "SPY",
          signals: Array.isArray(body.signals) ? body.signals : [],
          spotPrice: Number(body.spotPrice) || 0,
          activeFsmState: body.activeFsmState,
          macroRegime: body.macroRegime,
          chiPct: body.chiPct,
          zeroGamma: typeof body.zeroGamma === "number" ? body.zeroGamma : undefined,
          sessionDate: body.sessionDate,
          webhookUrl: body.webhookUrl,
          isHistoricalBackfill: Boolean(body.isHistoricalBackfill),
        });
        return NextResponse.json({ success: true, ...res });
      } finally {
        releaseBarEvaluationLock(lockToken);
      }
    }

    if (body.action === "clear") {
      const lockToken = acquireBarEvaluationLock();
      if (!lockToken) {
        return NextResponse.json({ error: "Evaluation lock busy" }, { status: 409 });
      }
      try {
        clearDailyTrades();
        return NextResponse.json({ success: true, message: "Daily trades reset." });
      } finally {
        releaseBarEvaluationLock(lockToken);
      }
    }

    if (body.action === "send_daily_recap") {
      const lockToken = acquireBarEvaluationLock();
      if (!lockToken) {
        return NextResponse.json({ error: "Evaluation lock busy" }, { status: 409 });
      }
      try {
        const report = await checkAndSendMarketCloseRecap({ force: true, webhookUrl: body.webhookUrl });
        return NextResponse.json({ success: true, message: "Daily recap sent to Discord.", report });
      } finally {
        releaseBarEvaluationLock(lockToken);
      }
    }

    if (body.action === "send_radar") {
      const lockToken = acquireBarEvaluationLock();
      if (!lockToken) {
        return NextResponse.json({ error: "Evaluation lock busy" }, { status: 409 });
      }
      try {
        const sent = await sendPreTradeRadarDiscordCard(body.webhookUrl);
        return NextResponse.json({ success: sent, message: "Pre-trade radar dispatched to Discord." });
      } finally {
        releaseBarEvaluationLock(lockToken);
      }
    }

    const lockToken = acquireBarEvaluationLock();
    if (!lockToken) {
      return NextResponse.json({ error: "Evaluation lock busy" }, { status: 409 });
    }
    try {
      const normalizedBody = {
        ...body,
        ...(body.nowEt
          ? { nowEt: new Date(body.nowEt), isHistoricalBackfill: body.isHistoricalBackfill ?? true }
          : {}),
      };
      const result = await evaluateTradeSignals(normalizedBody);
      return NextResponse.json(result);
    } finally {
      releaseBarEvaluationLock(lockToken);
    }
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: errorMsg }, { status: 500 });
  }
}
