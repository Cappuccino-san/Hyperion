import { NextRequest, NextResponse } from "next/server";
import { authorizeAdminRequest } from "@/lib/adminAuth";
import { GET as getOptionsRoute } from "@/app/api/options/route";
import {
  evaluateTradeSignals,
  evaluateAllActivePositions,
  getActivePositions,
  getClosedPositions,
  getDailyTradeAlerts,
  clearDailyTrades,
  getTodayEt,
  selectOptimalContract,
  TradeLifecycleAlert,
  syncGaiaTickerSignalsToDiscord,
} from "@/lib/tradeSignalEngine";
import {
  generateDailyPerformanceReport,
  checkAndSendMarketCloseRecap,
} from "@/lib/tradePerformanceEngine";
import { getSessionBoundsEt } from "@/lib/gaiaSessionGuards";
import {
  getPreTradeRadarData,
  sendPreTradeRadarDiscordCard,
} from "@/lib/tradeRadar";
import {
  acquireBarEvaluationLock,
  acquireBarEvaluationLockWithWait,
  releaseBarEvaluationLock,
  ensureLiveBotRunning,
  ensureMocCutoffForRemainingPositions,
  getActiveTrackedTickers,
  registerActiveTrackedTicker,
  getEtClockNow,
  getLiveBotStatus,
  isAllowedAutonomousTicker,
  isExecutionHalted,
  setExecutionHalted,
} from "@/lib/liveBotDaemon";
import {
  loadTradeStore,
  purgeZombieToClosed,
  saveTradeStore,
} from "@/lib/execution/ledgerCommit";
import { sanitizeTickerSymbol } from "@/lib/marketCache";
import { sanitizeDiscordWebhookUrl } from "@/lib/discordWebhook";
import {
  readAlphaPriors,
  readIntradayStoreSync,
  readPostMarketAttribution,
  readSupervisorPolicy,
  type SessionPlaybookPolicy,
} from "@/lib/persistenceStore";
import { computeBarFlowGammaVwapSeries } from "@/lib/flowGammaVwap";
import { globalContractsCache } from "@/lib/optionsExposure";
import { resolveContractsFromRawCacheEntry } from "@/lib/execution/optionPricing";
import { evaluateZeroFlowFilter } from "@/lib/zeroFlowFilter";
import { evaluateZeroShadowTick, readZeroShadowSummary } from "@/lib/zeroShadowLedger";

export const dynamic = "force-dynamic";

const globalForSignals = globalThis as unknown as {
  __hyperionLastGetEvalAtMs?: number;
};

function buildServerZeroTelemetry(
  sym: string,
  sessionDate: string,
  policy: SessionPlaybookPolicy | null,
  activePos?: { contractType?: "CALL" | "PUT"; btoSpotPrice?: number } | null
) {
  try {
    const intra = readIntradayStoreSync(sessionDate);
    const tData = intra?.tickers?.[sym];
    const pts = tData?.rthHistory?.length ? tData.rthHistory : tData?.history ?? [];
    const buckets = new Map<number, { ts: number; open: number; high: number; low: number; close: number }>();
    for (const p of pts) {
      if (!p || !(p.spot > 0) || !(p.ts > 0)) continue;
      const bTs = Math.floor(p.ts / 300) * 300;
      const cur = buckets.get(bTs);
      if (!cur) {
        buckets.set(bTs, { ts: bTs, open: p.spot, high: p.spot, low: p.spot, close: p.spot });
      } else {
        if (p.spot > cur.high) cur.high = p.spot;
        if (p.spot < cur.low) cur.low = p.spot;
        cur.close = p.spot;
      }
    }
    const bars = Array.from(buckets.values()).sort((a, b) => a.ts - b.ts);
    const levels = tData?.officialLevels;
    const pde =
      bars.length > 0
        ? computeBarFlowGammaVwapSeries(
            bars.map((b) => ({
              timestamp: b.ts,
              open: b.open,
              high: b.high,
              low: b.low,
              close: b.close,
            })),
            undefined,
            levels
              ? {
                  ceilingNode: levels.callWall > 0 ? levels.callWall : undefined,
                  floorNode: levels.putWall > 0 ? levels.putWall : undefined,
                  zeroGamma: levels.zeroGamma > 0 ? levels.zeroGamma : undefined,
                }
              : undefined
          )
        : [];
    const zeroEval = evaluateZeroFlowFilter({
      ticker: sym,
      candles: bars.map((b, idx) => ({
        timestamp: b.ts,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        flowVwap: pde[idx]?.flowVwap,
        sigma: pde[idx]?.sigma,
        chi: pde[idx]?.ceilingShareChi,
        impulseChi: pde[idx]?.impulseChi,
        pe: pde[idx]?.pecletNumber,
        impulsePe: pde[idx]?.impulsePeclet,
        netFluxJ: pde[idx]?.netFluxJ,
        deltaNetFlux6Bar: pde[idx]?.deltaNetFlux6Bar,
      })),
      liveSpot: bars[bars.length - 1]?.close ?? null,
      open930: bars[0]?.open ?? null,
      zeroGamma0Dte: levels?.zeroGamma ?? null,
      callWall0Dte: levels?.callWall ?? null,
      putWall0Dte: levels?.putWall ?? null,
      activeCallDirection: activePos
        ? activePos.contractType === "CALL"
          ? "LONG"
          : "SHORT"
        : null,
      activeCallEntryPrice: activePos?.btoSpotPrice ?? null,
      regimeMode: policy?.zeroMode ?? "FOLLOW",
      standAsideVetoReason: policy?.standAsideVetoReason ?? null,
    });
    return {
      mode: policy?.zeroMode ?? (policy?.standAsideVetoReason ? "SIT_OUT" : "FOLLOW"),
      modeReason: policy?.zeroModeReason ?? policy?.summary ?? "",
      preferredDte: policy?.preferredDte ?? "0DTE",
      tollShieldActive: Boolean(policy?.tollShieldActive),
      lastBar: bars[bars.length - 1] ?? null,
      lastFlowVwap: pde[pde.length - 1]?.flowVwap ?? null,
      lastSigma: pde[pde.length - 1]?.sigma ?? null,
      ...zeroEval,
    };
  } catch {
    return null;
  }
}

function parseIsoDateParam(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : undefined;
}

/**
 * Fail-Closed Historical Backfill Firewall:
 * Silences ALL Discord webhooks if explicit flag OR any date/sessionDate/nowEt/candle indicates replay.
 */
function isHistoricalBackfillRequest(opts: {
  explicitFlag?: unknown;
  requestedDate?: string;
  nowEt?: unknown;
  candleTimestamp?: unknown;
}): boolean {
  if (opts.explicitFlag === true || opts.explicitFlag === "true" || opts.explicitFlag === "1") {
    return true;
  }
  const todayEt = getTodayEt();
  if (opts.requestedDate && opts.requestedDate !== todayEt) {
    return true;
  }
  if (opts.nowEt != null) {
    const dt = opts.nowEt instanceof Date ? opts.nowEt : new Date(String(opts.nowEt));
    if (!Number.isFinite(dt.getTime())) return true;
    const dtEtDate = getEtClockNow(dt.getTime()).etDate;
    if (dtEtDate !== todayEt || Math.abs(Date.now() - dt.getTime()) > 180_000) {
      return true;
    }
  }
  if (
    typeof opts.candleTimestamp === "number" &&
    Number.isFinite(opts.candleTimestamp) &&
    opts.candleTimestamp > 0
  ) {
    const ms = opts.candleTimestamp > 1e11 ? opts.candleTimestamp : opts.candleTimestamp * 1000;
    if (getEtClockNow(ms).etDate !== todayEt) {
      return true;
    }
  }
  return false;
}

async function withBoundedWait<T>(
  work: Promise<T>,
  timeoutMs = 15_000,
  controller?: AbortController
): Promise<T> {
  work.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller?.abort();
          reject(new Error("Signal operation timed out"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const rawTicker = searchParams.get("ticker") || searchParams.get("symbol") || "";
    const ticker = rawTicker ? sanitizeTickerSymbol(rawTicker, "") || undefined : undefined;
    const rawDate = searchParams.get("date")?.trim();
    if (rawDate && !/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
      return NextResponse.json({ error: "Invalid date format. Expected YYYY-MM-DD." }, { status: 400 });
    }
    const requestedDate = rawDate || undefined;
    const testAction = searchParams.get("test");

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
      const authError = authorizeAdminRequest(req);
      if (authError) return authError;
      const tickers = Array.from(new Set([...getActiveTrackedTickers(), "SPY", "QQQ"]));
      const scanController = new AbortController();
      const scanTimeout = setTimeout(() => scanController.abort(), 12_000);
      try {
        for (const sym of tickers) {
          if (scanController.signal.aborted) break;
          const cleanSym = sanitizeTickerSymbol(sym, "");
          if (!cleanSym) continue;
          try {
            const internalReq = new NextRequest(
              `http://127.0.0.1/api/options?ticker=${encodeURIComponent(cleanSym)}&force=true`
            );
            await getOptionsRoute(internalReq);
          } catch {
            // Non-fatal
          }
        }
      } finally {
        clearTimeout(scanTimeout);
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
      const authError = authorizeAdminRequest(req);
      if (authError) return authError;
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
      const report = generateDailyPerformanceReport(requestedDate);
      return NextResponse.json({ success: true, report });
    }

    if (searchParams.get("radar") === "true") {
      const radarController = new AbortController();
      const radarTimeout = setTimeout(() => radarController.abort(), 12_000);
      try {
        const radar = await getPreTradeRadarData({ signal: radarController.signal });
        return NextResponse.json({ success: true, radar });
      } finally {
        clearTimeout(radarTimeout);
      }
    }

    // Continuously evaluate all open positions across all tickers against live CBOE quotes
    const todayEt = getTodayEt();
    const policyTicker = ticker || "SPY";
    if (requestedDate && requestedDate !== todayEt) {
      const [supervisorPolicy, postMarketAttribution, alphaPriors] = await Promise.all([
        readSupervisorPolicy(requestedDate, policyTicker).catch(() => null),
        readPostMarketAttribution(requestedDate, policyTicker).catch(() => null),
        readAlphaPriors().catch(() => null),
      ]);
      const histActive = getActivePositions(requestedDate);
      return NextResponse.json({
        activePositions: histActive,
        closedPositions: getClosedPositions(ticker, requestedDate),
        alerts: getDailyTradeAlerts(ticker, requestedDate),
        supervisorPolicy,
        postMarketAttribution,
        alphaPriors,
        zeroShadow: readZeroShadowSummary(policyTicker, requestedDate),
        zeroTelemetry: buildServerZeroTelemetry(
          policyTicker,
          requestedDate,
          supervisorPolicy,
          histActive?.[policyTicker] ?? null
        ),
        sessionDate: requestedDate,
        timestamp: new Date().toISOString(),
      });
    }

    ensureLiveBotRunning();
    if (ticker) registerActiveTrackedTicker(ticker);
    const botStatus = getLiveBotStatus();
    const nowMs = Date.now();
    const shouldThrottleEval =
      botStatus.isEvaluatingLiveBar ||
      (botStatus.lastPollAtMs > 0 && nowMs - botStatus.lastPollAtMs < 5_000) ||
      (globalForSignals.__hyperionLastGetEvalAtMs != null &&
        nowMs - globalForSignals.__hyperionLastGetEvalAtMs < 5_000);
    const getLockToken = shouldThrottleEval ? 0 : acquireBarEvaluationLock();
    const getClock = getEtClockNow();
    if (getLockToken && getClock.isWeekday) {
      globalForSignals.__hyperionLastGetEvalAtMs = nowMs;
      const evalController = new AbortController();
      const evalTimeout = setTimeout(() => evalController.abort(), 12_000);
      try {
        await evaluateAllActivePositions({ signal: evalController.signal });
        if (ticker && isAllowedAutonomousTicker(policyTicker)) {
          const curStore = loadTradeStore();
          const hasTickerHistory =
            Boolean(curStore.backfilledTickers?.[policyTicker]) ||
            Boolean(curStore.activePositions[policyTicker]) ||
            curStore.closedPositions.some((p) => p.ticker === policyTicker) ||
            curStore.alerts.some((a) => a.ticker === policyTicker);
          if (!hasTickerHistory) {
            await evaluateTradeSignals({
              ticker: policyTicker,
              spotPrice: 0,
              callWall: 0,
              putWall: 0,
              zeroGamma: 0,
              webhookUrl: undefined,
              isHistoricalBackfill: true,
              signal: evalController.signal,
            });
          }
        }
      } finally {
        const clock = getEtClockNow();
        const bounds = getSessionBoundsEt(clock.etDate);
        if (clock.etMins >= bounds.eodFlatMins) {
          await ensureMocCutoffForRemainingPositions(undefined, clock).catch(() => {});
        }
        clearTimeout(evalTimeout);
        releaseBarEvaluationLock(getLockToken);
      }
    } else if (getLockToken) {
      releaseBarEvaluationLock(getLockToken);
    }

    const activePositions = getActivePositions();
    const closedPositions = getClosedPositions(ticker);
    const alerts = getDailyTradeAlerts(ticker);
    const [supervisorPolicy, postMarketAttribution, alphaPriors] = await Promise.all([
      readSupervisorPolicy(todayEt, policyTicker).catch(() => null),
      readPostMarketAttribution(todayEt, policyTicker).catch(() => null),
      readAlphaPriors().catch(() => null),
    ]);

    const zeroTelemetry = buildServerZeroTelemetry(
      policyTicker,
      todayEt,
      supervisorPolicy,
      activePositions?.[policyTicker] ?? null
    );
    const rawCacheEntry = globalContractsCache.get(policyTicker);
    if (
      getClock.isWeekday &&
      rawCacheEntry &&
      rawCacheEntry.rawContracts.length > 0 &&
      zeroTelemetry?.lastBar &&
      zeroTelemetry.lastBar.close > 0
    ) {
      try {
        const liveSpotNow = zeroTelemetry.lastBar.close;
        const anchoredShadowContracts = resolveContractsFromRawCacheEntry(
          rawCacheEntry,
          liveSpotNow,
          Date.now()
        );
        evaluateZeroShadowTick({
          ticker: policyTicker,
          sessionDate: todayEt,
          nowTsSec: Math.floor(Date.now() / 1000),
          spotPrice: liveSpotNow,
          openPrice: zeroTelemetry.lastBar.open,
          flowVwap: zeroTelemetry.lastFlowVwap ?? liveSpotNow,
          sigma: zeroTelemetry.lastSigma ?? undefined,
          compositeScore: zeroTelemetry.compositeScore,
          entryLagMins: zeroTelemetry.turnLagMins,
          contracts: anchoredShadowContracts,
        });
      } catch {
        // Non-fatal
      }
    }

    return NextResponse.json({
      activePositions,
      closedPositions,
      alerts,
      supervisorPolicy,
      postMarketAttribution,
      alphaPriors,
      zeroShadow: readZeroShadowSummary(policyTicker, todayEt),
      zeroTelemetry,
      executionMode: "PAPER_SHADOW",
      executionLocked: isExecutionHalted(),
      sessionDate: todayEt,
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
    const webhookValidation = sanitizeDiscordWebhookUrl(body.webhookUrl);
    if (webhookValidation.invalid) {
      return NextResponse.json(
        { error: "Invalid Discord Webhook URL; official HTTPS discord.com webhook required." },
        { status: 400 }
      );
    }
    const validWebhookUrl =
      process.env.NODE_ENV === "production" ? undefined : webhookValidation.url;

    if (body.action === "EMERGENCY_LOCK" || body.action === "UNLOCK_EXECUTION" || body.action === "FLATTEN_PAPER_POSITIONS") {
      const authError = authorizeAdminRequest(req);
      if (authError) return authError;
      if (body.action === "UNLOCK_EXECUTION") {
        setExecutionHalted(false);
        return NextResponse.json({
          success: true,
          executionMode: "PAPER_SHADOW",
          executionLocked: false,
          flattenedTickers: [],
        });
      }

      setExecutionHalted(true);
      const flattenedTickers: string[] = [];
      if (body.action === "FLATTEN_PAPER_POSITIONS") {
        const lockToken = await acquireBarEvaluationLockWithWait(2500, req.signal);
        if (!lockToken) {
          return NextResponse.json({ error: "Evaluation lock busy" }, { status: 409 });
        }
        try {
          const store = loadTradeStore();
          const openTickers = Object.keys(store.activePositions || {});
          for (const sym of openTickers) {
            const closed = purgeZombieToClosed(
              store,
              sym,
              "PILOT EMERGENCY FLATTEN (PAPER/SHADOW)"
            );
            if (closed) flattenedTickers.push(sym);
          }
          if (flattenedTickers.length > 0) {
            saveTradeStore(store);
          }
        } finally {
          releaseBarEvaluationLock(lockToken);
        }
      }
      return NextResponse.json({
        success: true,
        executionMode: "PAPER_SHADOW",
        executionLocked: true,
        flattenedTickers,
      });
    }

    if (body.action === "REGISTER_TRACKED_TICKER") {
      const trackedTickers = registerActiveTrackedTicker(body.ticker);
      return NextResponse.json({ success: true, trackedTickers });
    }

    if (body.action === "SYNC_GAIA_TICKER_SIGNALS") {
      const sessionDate = parseIsoDateParam(body.sessionDate);
      const backfill = isHistoricalBackfillRequest({
        explicitFlag: body.isHistoricalBackfill,
        requestedDate: sessionDate,
        nowEt: body.nowEt,
      });
      if (sessionDate && sessionDate !== getTodayEt()) {
        return NextResponse.json({
          success: true,
          suppressed: true,
          isHistoricalBackfill: true,
          sessionDate,
          dispatchedCount: 0,
          keys: [],
        });
      }
      if (!backfill && typeof body.ticker === "string" && body.ticker.trim()) {
        registerActiveTrackedTicker(body.ticker);
      }
      const syncClock = getEtClockNow();
      if (!backfill && !syncClock.isWeekday) {
        return NextResponse.json({ success: true, skipped: true, reason: "Market closed (weekend)" });
      }
      if (!backfill && isExecutionHalted()) {
        return NextResponse.json({ success: true, skipped: true, executionLocked: true, reason: "Execution locked by pilot" });
      }
      const lockToken = await acquireBarEvaluationLockWithWait(2500, req.signal);
      if (!lockToken) {
        return NextResponse.json({ success: false, busy: true, dispatchedCount: 0, keys: [] }, { status: 409 });
      }
      const syncController = new AbortController();
      const onReqAbort = () => syncController.abort();
      req.signal?.addEventListener("abort", onReqAbort, { once: true });
      const syncTimeout = setTimeout(() => syncController.abort(), 12_000);
      try {
        const res = await syncGaiaTickerSignalsToDiscord({
          ticker: body.ticker || "SPY",
          signals: Array.isArray(body.signals) ? body.signals : [],
          spotPrice: Number(body.spotPrice) || 0,
          activeFsmState: body.activeFsmState,
          macroRegime: body.macroRegime,
          chiPct: body.chiPct,
          impulseChi: typeof body.impulseChi === "number" ? body.impulseChi : undefined,
          zeroGamma: typeof body.zeroGamma === "number" ? body.zeroGamma : undefined,
          sessionDate,
          webhookUrl: undefined,
          isHistoricalBackfill: backfill,
          signal: syncController.signal,
        });
        const clock = getEtClockNow();
        const syncBounds = getSessionBoundsEt(clock.etDate);
        if (!backfill && clock.etMins >= syncBounds.eodFlatMins) {
          await ensureMocCutoffForRemainingPositions(validWebhookUrl, clock);
        }
        return NextResponse.json({
          success: true,
          retiredClientLedgerWrite: true,
          authority: "liveBotDaemon",
          ...res,
        });
      } finally {
        clearTimeout(syncTimeout);
        req.signal?.removeEventListener("abort", onReqAbort);
        releaseBarEvaluationLock(lockToken);
      }
    }

    if (body.action === "clear") {
      const authError = authorizeAdminRequest(req);
      if (authError) return authError;
      const lockToken = await acquireBarEvaluationLockWithWait(2500, req.signal);
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
      const authError = authorizeAdminRequest(req);
      if (authError) return authError;
      const recapDate = parseIsoDateParam(body.date ?? body.sessionDate);
      if (
        isHistoricalBackfillRequest({
          explicitFlag: body.isHistoricalBackfill,
          requestedDate: recapDate,
          nowEt: body.nowEt,
        })
      ) {
        return NextResponse.json({
          success: false,
          suppressed: true,
          reason: "DISCORD_SILENCED_HISTORICAL_BACKFILL",
        });
      }
      const lockToken = await acquireBarEvaluationLockWithWait(2500, req.signal);
      if (!lockToken) {
        return NextResponse.json({ error: "Evaluation lock busy" }, { status: 409 });
      }
      const recapController = new AbortController();
      const work = checkAndSendMarketCloseRecap({
        force: true,
        webhookUrl: validWebhookUrl,
        date: recapDate,
        signal: recapController.signal,
      }).finally(() => releaseBarEvaluationLock(lockToken));
      const report = await withBoundedWait(work, 15_000, recapController);
      return NextResponse.json({ success: true, message: "Daily recap sent to Discord.", report });
    }

    if (body.action === "send_radar") {
      const authError = authorizeAdminRequest(req);
      if (authError) return authError;
      if (
        isHistoricalBackfillRequest({
          explicitFlag: body.isHistoricalBackfill,
          requestedDate: parseIsoDateParam(body.sessionDate ?? body.date),
          nowEt: body.nowEt,
        })
      ) {
        return NextResponse.json({
          success: false,
          suppressed: true,
          reason: "DISCORD_SILENCED_HISTORICAL_BACKFILL",
        });
      }
      const lockToken = await acquireBarEvaluationLockWithWait(2500, req.signal);
      if (!lockToken) {
        return NextResponse.json({ error: "Evaluation lock busy" }, { status: 409 });
      }
      const radarController = new AbortController();
      const work = sendPreTradeRadarDiscordCard(validWebhookUrl, {
        signal: radarController.signal,
      }).finally(() => releaseBarEvaluationLock(lockToken));
      const sent = await withBoundedWait(work, 15_000, radarController);
      return NextResponse.json({ success: sent, message: "Pre-trade radar dispatched to Discord." });
    }

    const lockToken = await acquireBarEvaluationLockWithWait(2500, req.signal);
    if (!lockToken) {
      return NextResponse.json({ error: "Evaluation lock busy" }, { status: 409 });
    }
    const postController = new AbortController();
    const onReqAbort = () => postController.abort();
    req.signal?.addEventListener("abort", onReqAbort, { once: true });
    const postTimeout = setTimeout(() => postController.abort(), 12_000);
    try {
      const backfill = isHistoricalBackfillRequest({
        explicitFlag: body.isHistoricalBackfill,
        requestedDate: parseIsoDateParam(body.sessionDate ?? body.date),
        nowEt: body.nowEt,
        candleTimestamp: body.latest5mCandle?.timestamp,
      });
      const postClock = getEtClockNow();
      if (!backfill && !postClock.isWeekday) {
        return NextResponse.json({ skipped: true, reason: "Market closed (weekend)", emittedAlerts: [] });
      }
      if (!backfill && typeof body.ticker === "string" && body.ticker.trim()) {
        registerActiveTrackedTicker(body.ticker);
      }
      const normalizedBody = {
        ...body,
        webhookUrl: backfill ? undefined : validWebhookUrl,
        isHistoricalBackfill: backfill,
        signal: postController.signal,
        ...(body.nowEt ? { nowEt: new Date(body.nowEt) } : {}),
      };
      const result = await evaluateTradeSignals(normalizedBody);
      const clock = getEtClockNow();
      const postBounds = getSessionBoundsEt(clock.etDate);
      if (!backfill && clock.etMins >= postBounds.eodFlatMins) {
        await ensureMocCutoffForRemainingPositions(validWebhookUrl, clock);
      }
      return NextResponse.json(result);
    } finally {
      clearTimeout(postTimeout);
      req.signal?.removeEventListener("abort", onReqAbort);
      releaseBarEvaluationLock(lockToken);
    }
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: errorMsg }, { status: 500 });
  }
}
