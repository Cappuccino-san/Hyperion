import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
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
} from "@/lib/liveBotDaemon";
import { sanitizeTickerSymbol } from "@/lib/marketCache";
import {
  readAlphaPriors,
  readPostMarketAttribution,
  readSupervisorPolicy,
} from "@/lib/persistenceStore";

export const dynamic = "force-dynamic";

const globalForSignals = globalThis as unknown as {
  __hyperionLastGetEvalAtMs?: number;
};

function isLoopbackHostname(host: string): boolean {
  const clean = host.trim().toLowerCase().replace(/^\[|\]$/g, "").split(":")[0];
  return clean === "localhost" || clean === "127.0.0.1" || clean === "::1";
}

function authorizeAdminRequest(req: NextRequest): NextResponse | null {
  const configuredToken = process.env.HYPERION_ADMIN_TOKEN?.trim();
  if (configuredToken) {
    const headerToken = req.headers.get("x-hyperion-admin-token")?.trim();
    const authHeader = req.headers.get("authorization")?.trim() ?? "";
    const bearerToken = authHeader.toLowerCase().startsWith("bearer ")
      ? authHeader.slice(7).trim()
      : "";
    const provided = headerToken || bearerToken;
    if (!provided) {
      return NextResponse.json({ error: "Unauthorized admin request" }, { status: 401 });
    }
    const providedBuf = Buffer.from(provided, "utf-8");
    const expectedBuf = Buffer.from(configuredToken, "utf-8");
    if (
      providedBuf.length !== expectedBuf.length ||
      !crypto.timingSafeEqual(providedBuf, expectedBuf)
    ) {
      return NextResponse.json({ error: "Unauthorized admin request" }, { status: 401 });
    }
    return null;
  }

  if (process.env.NODE_ENV === "production") {
    const reqHost = req.headers.get("host") ?? req.nextUrl.hostname ?? "";
    const forwardedFor = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
    const isLocalHost = isLoopbackHostname(reqHost) && (!forwardedFor || isLoopbackHostname(forwardedFor));
    if (!isLocalHost) {
      return NextResponse.json(
        { error: "HYPERION_ADMIN_TOKEN is required for non-loopback admin actions in production." },
        { status: 403 }
      );
    }
  }
  return null;
}

function sanitizeWebhookUrl(raw: unknown): { url?: string; invalid: boolean } {
  if (raw == null) return { url: undefined, invalid: false };
  if (typeof raw !== "string") return { url: undefined, invalid: true };
  const trimmed = raw.trim();
  if (!trimmed) return { url: undefined, invalid: false };
  if (!/^https:\/\//i.test(trimmed)) return { url: undefined, invalid: true };
  return { url: trimmed, invalid: false };
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
    const webhookValidation = sanitizeWebhookUrl(searchParams.get("webhookUrl"));
    if (webhookValidation.invalid) {
      return NextResponse.json(
        { error: "Invalid Discord Webhook URL protocol; HTTPS required." },
        { status: 400 }
      );
    }
    const webhookUrl = webhookValidation.url;

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
      const tickers = Array.from(new Set([...getActiveTrackedTickers(), "SPY", "QQQ", "IWM"]));
      const scanController = new AbortController();
      const scanTimeout = setTimeout(() => scanController.abort(), 12_000);
      try {
        for (const sym of tickers) {
          if (scanController.signal.aborted) break;
          try {
            await fetch(`${baseUrl}/api/options?ticker=${sym}&force=true`, {
              cache: "no-store",
              signal: scanController.signal,
            }).then((r) => r.json());
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

    if (searchParams.get("action") === "send_radar") {
      if (
        isHistoricalBackfillRequest({
          explicitFlag: searchParams.get("isHistoricalBackfill"),
          requestedDate: requestedDate ?? parseIsoDateParam(searchParams.get("sessionDate")),
          nowEt: searchParams.get("nowEt"),
        })
      ) {
        return NextResponse.json({
          success: false,
          suppressed: true,
          reason: "DISCORD_SILENCED_HISTORICAL_BACKFILL",
        });
      }
      const lockToken = acquireBarEvaluationLock();
      if (!lockToken) {
        return NextResponse.json({ error: "Evaluation lock busy" }, { status: 409 });
      }
      const radarController = new AbortController();
      const work = sendPreTradeRadarDiscordCard(webhookUrl, {
        signal: radarController.signal,
      }).finally(() => releaseBarEvaluationLock(lockToken));
      const sent = await withBoundedWait(work, 15_000, radarController);
      return NextResponse.json({ success: sent, message: "Pre-trade radar dispatched to Discord." });
    }

    if (searchParams.get("action") === "send_recap") {
      const recapDate = requestedDate ?? parseIsoDateParam(searchParams.get("sessionDate"));
      if (
        isHistoricalBackfillRequest({
          explicitFlag: searchParams.get("isHistoricalBackfill"),
          requestedDate: recapDate,
          nowEt: searchParams.get("nowEt"),
        })
      ) {
        return NextResponse.json({
          success: false,
          suppressed: true,
          reason: "DISCORD_SILENCED_HISTORICAL_BACKFILL",
        });
      }
      const lockToken = acquireBarEvaluationLock();
      if (!lockToken) {
        return NextResponse.json({ error: "Evaluation lock busy" }, { status: 409 });
      }
      const recapController = new AbortController();
      const work = checkAndSendMarketCloseRecap({
        force: true,
        webhookUrl,
        date: recapDate,
        signal: recapController.signal,
      }).finally(() => releaseBarEvaluationLock(lockToken));
      const report = await withBoundedWait(work, 15_000, recapController);
      return NextResponse.json({ success: true, message: "Daily recap sent to Discord.", report });
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
      return NextResponse.json({
        activePositions: getActivePositions(requestedDate),
        closedPositions: getClosedPositions(ticker, requestedDate),
        alerts: getDailyTradeAlerts(ticker, requestedDate),
        supervisorPolicy,
        postMarketAttribution,
        alphaPriors,
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
        await evaluateAllActivePositions({ webhookUrl, signal: evalController.signal });
      } finally {
        const clock = getEtClockNow();
        const bounds = getSessionBoundsEt(clock.etDate);
        if (clock.etMins >= bounds.eodFlatMins) {
          await ensureMocCutoffForRemainingPositions(webhookUrl, clock).catch(() => {});
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

    return NextResponse.json({
      activePositions,
      closedPositions,
      alerts,
      supervisorPolicy,
      postMarketAttribution,
      alphaPriors,
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
    const webhookValidation = sanitizeWebhookUrl(body.webhookUrl);
    if (webhookValidation.invalid) {
      return NextResponse.json(
        { error: "Invalid Discord Webhook URL protocol; HTTPS required." },
        { status: 400 }
      );
    }
    const validWebhookUrl = webhookValidation.url;

    if (body.action === "REGISTER_TRACKED_TICKER") {
      const trackedTickers = registerActiveTrackedTicker(body.ticker);
      return NextResponse.json({ success: true, trackedTickers });
    }

    if (body.action === "SYNC_GAIA_TICKER_SIGNALS" || body.action === "SYNC_GAIA_SPY_SIGNALS") {
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
          webhookUrl: backfill ? undefined : validWebhookUrl,
          isHistoricalBackfill: backfill,
          signal: syncController.signal,
        });
        const clock = getEtClockNow();
        const syncBounds = getSessionBoundsEt(clock.etDate);
        if (!backfill && clock.etMins >= syncBounds.eodFlatMins) {
          await ensureMocCutoffForRemainingPositions(validWebhookUrl, clock);
        }
        return NextResponse.json({ success: true, ...res });
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
