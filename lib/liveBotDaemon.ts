import { isMarketOpen } from "@/lib/marketDataService";
import { getTickerPreset } from "@/lib/tickerPresets";
import {
  evaluateTradeSignals,
  evaluateAllActivePositions,
  fetchLiveCboeOptions,
  fetchLive5mCandleAndDivergence,
  flushPendingDiscordAlerts,
  getCachedSpotPrice,
  loadTradeStore,
} from "@/lib/tradeSignalEngine";
import {
  computeOptionsAnalytics,
  deriveTacticalStructuralLevels,
  type NormalizedOptionContract,
} from "@/lib/optionsExposure";
import {
  evaluateAndPersistSessionPlaybook,
  runPostMarketAttribution,
  shouldRefreshSupervisorCheckpoint,
} from "@/lib/agenticSupervisor";
import {
  readAlphaPriorsSync,
  readHistoricalSessions,
  readSupervisorPolicySync,
} from "@/lib/persistenceStore";
import { getMergedIntradayHistory } from "@/lib/intradayHistory";
import { computeBarFlowGammaVwapSeries } from "@/lib/flowGammaVwap";
import { getSessionBoundsEt } from "@/lib/gaiaSessionGuards";
import {
  acquireCrossProcessExecutionLease,
  getExecutionRole,
  releaseCrossProcessExecutionLease,
} from "@/lib/executionLease";

const POLL_INTERVAL_MS = 20_000; // 20 seconds during RTH
const DEFAULT_WATCH_TICKERS = ["SPY"] as const;
const MAX_TRACKED_TICKERS = 8;
const TRACKED_TICKER_TTL_MS = 4 * 60 * 60_000;

interface LiveBotGlobalState {
  intervalId: ReturnType<typeof setInterval> | null;
  mocTimerId: ReturnType<typeof setTimeout> | null;
  isPolling: boolean;
  inFlightTickPromise: Promise<void> | null;
  activeController: AbortController | null;
  isStopped: boolean;
  isEvaluatingLiveBar: boolean;
  lockAcquiredAtMs: number;
  lockToken: number;
  lockWaiters?: Set<() => void>;
  startedAtMs: number;
  lastPollAtMs: number;
  lastStatus: string;
  pollCount: number;
  sessionDateEt: string;
  dispatchedCount: number;
  activeTrackedTickers: Map<string, number>;
}

declare global {
  // eslint-disable-next-line no-var
  var __hyperionLiveBotState: LiveBotGlobalState | undefined;
}

export function getEtClockNow(nowMs: number = Date.now()): {
  etDate: string;
  etMins: number;
  isWeekday: boolean;
} {
  const dt = new Date(nowMs);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = fmt.formatToParts(dt);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const hour = Number(get("hour") || 0) % 24;
  const minute = Number(get("minute") || 0);
  const weekday = get("weekday");
  return {
    etDate: `${get("year") || "1970"}-${get("month") || "01"}-${get("day") || "01"}`,
    etMins: hour * 60 + minute,
    isWeekday: weekday !== "Sat" && weekday !== "Sun",
  };
}

function getEtDateString(nowMs: number = Date.now()): string {
  return getEtClockNow(nowMs).etDate;
}

function isWithinRthWindow(nowMs: number = Date.now()): boolean {
  const dt = new Date(nowMs);
  const { isWeekday, etMins, etDate } = getEtClockNow(nowMs);
  if (!isWeekday) return false;

  const mkt = isMarketOpen(dt);
  if (!mkt.open) return false;

  const bounds = getSessionBoundsEt(etDate);
  return etMins >= bounds.rthOpenMins && etMins < bounds.rthCloseMins;
}

function getBotState(): LiveBotGlobalState {
  const now = Date.now();
  if (!globalThis.__hyperionLiveBotState) {
    globalThis.__hyperionLiveBotState = {
      intervalId: null,
      mocTimerId: null,
      isPolling: false,
      inFlightTickPromise: null,
      activeController: null,
      isStopped: false,
      isEvaluatingLiveBar: false,
      lockAcquiredAtMs: 0,
      lockToken: 0,
      startedAtMs: now,
      lastPollAtMs: 0,
      lastStatus: "IDLE",
      pollCount: 0,
      sessionDateEt: getEtDateString(),
      dispatchedCount: 0,
      activeTrackedTickers: new Map<string, number>([["SPY", now]]),
    };
  } else if (!globalThis.__hyperionLiveBotState.activeTrackedTickers) {
    globalThis.__hyperionLiveBotState.activeTrackedTickers = new Map<string, number>([["SPY", now]]);
  }
  return globalThis.__hyperionLiveBotState;
}

function scheduleAlignedMocTick(): void {
  const botState = getBotState();
  if (botState.isStopped || getExecutionRole() === "observer") return;

  if (botState.mocTimerId) {
    clearTimeout(botState.mocTimerId);
    botState.mocTimerId = null;
  }

  const nowMs = Date.now();
  const clock = getEtClockNow(nowMs);
  if (!clock.isWeekday) return;

  const bounds = getSessionBoundsEt(clock.etDate);
  if (clock.etMins >= bounds.eodFlatMins) return;

  // Align precisely to the start of eodFlatMins (15:55:00 ET or 12:55:00 ET on early close)
  const minsUntilMoc = bounds.eodFlatMins - clock.etMins;
  const dtNow = new Date(nowMs);
  const secRemainderMs = (60 - dtNow.getSeconds()) * 1000 - dtNow.getMilliseconds();
  const delayMs = Math.max(250, (minsUntilMoc - 1) * 60_000 + secRemainderMs + 150);

  if (delayMs > 8 * 60 * 60_000) return;

  botState.mocTimerId = setTimeout(() => {
    botState.mocTimerId = null;
    if (!botState.isStopped) {
      void runLiveBotTick();
    }
  }, delayMs);

  if (typeof botState.mocTimerId === "object" && "unref" in botState.mocTimerId) {
    botState.mocTimerId.unref();
  }
}

export function normalizeTrackedTicker(raw?: string): string {
  const cleaned = (raw || "").trim().toUpperCase().replace(/^\$/, "");
  if (!cleaned || !/^[A-Z0-9._-]{1,10}$/.test(cleaned)) return "";
  return cleaned === "SPX" ? "SPXW" : cleaned;
}

export function registerActiveTrackedTicker(rawTicker?: string): string[] {
  const sym = normalizeTrackedTicker(rawTicker);
  const botState = getBotState();
  const now = Date.now();
  if (!botState.activeTrackedTickers) {
    botState.activeTrackedTickers = new Map([["SPY", now]]);
  }
  if (sym) {
    botState.activeTrackedTickers.set(sym, now);
  }
  const openTickers = new Set(Object.keys(loadTradeStore().activePositions || {}));
  for (const [k, ts] of Array.from(botState.activeTrackedTickers.entries())) {
    if (k !== "SPY" && !openTickers.has(k) && now - ts > TRACKED_TICKER_TTL_MS) {
      botState.activeTrackedTickers.delete(k);
    }
  }
  const nonPinned = Array.from(botState.activeTrackedTickers.entries())
    .filter(([k]) => k !== "SPY" && !openTickers.has(k))
    .sort((a, b) => b[1] - a[1]);
  for (const [k] of nonPinned.slice(Math.max(0, MAX_TRACKED_TICKERS - DEFAULT_WATCH_TICKERS.length))) {
    botState.activeTrackedTickers.delete(k);
  }
  return getActiveTrackedTickers();
}

export function getActiveTrackedTickers(): string[] {
  const botState = getBotState();
  const now = Date.now();
  const store = loadTradeStore();
  if (!botState.activeTrackedTickers) {
    botState.activeTrackedTickers = new Map([["SPY", now]]);
  }
  const ordered = new Set<string>(DEFAULT_WATCH_TICKERS);
  for (const k of Object.keys(store.activePositions || {})) {
    const norm = normalizeTrackedTicker(k);
    if (norm) ordered.add(norm);
  }
  const recent = Array.from(botState.activeTrackedTickers.entries())
    .filter(([k, ts]) => k === "SPY" || now - ts <= TRACKED_TICKER_TTL_MS)
    .sort((a, b) => b[1] - a[1]);
  for (const [k] of recent) ordered.add(k);
  return Array.from(ordered);
}

function computeLiveLevelsForTicker(
  ticker: string,
  resolvedSpot: number,
  contracts: NormalizedOptionContract[],
  previousClose: number
) {
  const refSpot = ticker === "SPXW" || ticker === "SPX" ? resolvedSpot / 10 : resolvedSpot;
  const atmContracts = contracts.filter(
    (c) => c.iv > 0.01 && c.iv < 3 && Math.abs(c.strike - refSpot) <= refSpot * 0.03
  );
  const atmIv =
    atmContracts.length > 0
      ? atmContracts.reduce((s, c) => s + c.iv, 0) / atmContracts.length
      : getTickerPreset(ticker, resolvedSpot).impliedVolatility;
  const analytics = computeOptionsAnalytics({
    ticker,
    dataSource: "CBOE_MARKET_DATA",
    spotPrice: resolvedSpot,
    previousClose: previousClose > 0 ? previousClose : resolvedSpot,
    impliedVolatility: atmIv,
    contracts,
  });
  const levels = deriveTacticalStructuralLevels(analytics);
  return {
    ...levels,
    kingNode: analytics.kingNode,
  };
}

export function isEvaluatingLiveBar(): boolean {
  return Boolean(globalThis.__hyperionLiveBotState?.isEvaluatingLiveBar);
}

export function acquireBarEvaluationLock(): number {
  const state = getBotState();
  if (getExecutionRole() === "observer") {
    state.lastStatus = "OBSERVER_MODE";
    return 0;
  }

  const nowMs = Date.now();
  if (state.isEvaluatingLiveBar && nowMs - state.lockAcquiredAtMs < 30_000) {
    return 0;
  }
  if (state.inFlightTickPromise) {
    if (nowMs - state.lockAcquiredAtMs < 30_000) {
      return 0;
    }
    try {
      state.activeController?.abort();
    } catch {}
    state.inFlightTickPromise = null;
    state.isPolling = false;
  }

  const lease = acquireCrossProcessExecutionLease({ nowMs });
  if (!lease.acquired) {
    state.lastStatus = lease.role === "observer" ? "OBSERVER_MODE" : "LEASE_HELD_BY_PEER";
    return 0;
  }

  state.isEvaluatingLiveBar = true;
  state.lockAcquiredAtMs = nowMs;
  state.lockToken = (state.lockToken || 0) + 1;
  return state.lockToken;
}

export async function acquireBarEvaluationLockWithWait(
  timeoutMs: number = 2500,
  signal?: AbortSignal
): Promise<number> {
  if (getExecutionRole() === "observer") {
    return 0;
  }
  const immediate = acquireBarEvaluationLock();
  if (immediate) return immediate;

  const state = getBotState();
  if (!state.lockWaiters) {
    state.lockWaiters = new Set<() => void>();
  }

  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    if (signal?.aborted) return 0;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        state.lockWaiters?.delete(done);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, Math.min(50, remaining));
      state.lockWaiters?.add(done);
      signal?.addEventListener("abort", done, { once: true });
    });

    if (signal?.aborted) return 0;
    const tok = acquireBarEvaluationLock();
    if (tok) return tok;
  }
  return 0;
}

export function refreshBarEvaluationLock(token?: number): void {
  const state = getBotState();
  if (typeof token === "number" && token > 0 && state.lockToken === token && state.isEvaluatingLiveBar) {
    const nowMs = Date.now();
    state.lockAcquiredAtMs = nowMs;
    acquireCrossProcessExecutionLease({ nowMs });
  }
}

export function releaseBarEvaluationLock(token?: number): void {
  const state = getBotState();
  if (
    typeof token !== "number" ||
    !Number.isFinite(token) ||
    token <= 0 ||
    state.lockToken !== token
  ) {
    return;
  }
  state.isEvaluatingLiveBar = false;
  state.lockAcquiredAtMs = 0;
  if (state.lockWaiters && state.lockWaiters.size > 0) {
    for (const wake of Array.from(state.lockWaiters)) {
      wake();
    }
  }
}

/**
 * Fail-Closed Hard MOC Force-Liquidation Fallback (15:55:00 ET / 12:55:00 ET early close):
 * Closes still-open positions using cached spot + synthetic contract when upstream feeds stall/abort.
 * Caller must hold acquireBarEvaluationLock().
 */
export async function ensureMocCutoffForRemainingPositions(
  webhookUrl?: string,
  clock: { etDate: string; etMins: number } = getEtClockNow()
): Promise<number> {
  const bounds = getSessionBoundsEt(clock.etDate);
  if (clock.etMins < bounds.eodFlatMins) return 0;
  const store = loadTradeStore();
  const openEntries = Object.entries(store.activePositions || {}).filter(
    ([, pos]) => Boolean(pos && (pos.status === "OPEN" || pos.status === "PARTIAL_TP1"))
  );
  if (openEntries.length === 0) return 0;

  const mocController = new AbortController();
  const mocTimeout = setTimeout(() => mocController.abort(), 6_000);
  let dispatched = 0;
  try {
    for (const [ticker, pos] of openEntries) {
      if (mocController.signal.aborted) break;
      if (!pos) continue;
      const cachedSpot = Number(
        getCachedSpotPrice(ticker) ||
          store.prevSpotPrices?.[ticker] ||
          store.prevSpotPrices?.[pos.ticker] ||
          pos.btoSpotPrice ||
          0
      );
      if (cachedSpot <= 0) continue;
      const syntheticContract: NormalizedOptionContract = {
        symbol: pos.contractLabel || ticker,
        strike: pos.strike,
        expiration: pos.expiration,
        optionType: pos.contractType === "CALL" ? "C" : "P",
        bid: pos.optionBid ?? pos.btoOptionMid,
        ask: pos.optionAsk ?? pos.btoOptionMid,
        last: pos.btoOptionMid,
        volume: 1,
        openInterest: 1,
        delta: pos.contractType === "CALL" ? 0.5 : -0.5,
        gamma: 0,
        vega: 0,
        iv: pos.entryIv ?? 0.25,
        percentChange: 0,
      };
      const res = await evaluateTradeSignals({
        ticker,
        spotPrice: cachedSpot,
        callWall: 0,
        putWall: 0,
        zeroGamma: 0,
        contracts: [syntheticContract],
        latest5mCandle: {
          open: cachedSpot,
          high: cachedSpot,
          low: cachedSpot,
          close: cachedSpot,
          sma34: cachedSpot,
        },
        divergence5m: "NO",
        divergence30m: "NO",
        webhookUrl,
        isHistoricalBackfill: false,
        signal: mocController.signal,
      });
      dispatched += res.emittedAlerts.filter(
        (a) => !a.isHistoricalBackfill && Boolean(webhookUrl?.trim())
      ).length;
    }
  } finally {
    clearTimeout(mocTimeout);
  }
  return dispatched;
}

export async function runLiveBotTick(): Promise<void> {
  const botState = getBotState();
  if (getExecutionRole() === "observer") {
    botState.lastStatus = "OBSERVER_MODE";
    return;
  }
  if (botState.isStopped || botState.isPolling || botState.inFlightTickPromise) return;

  const lockToken = acquireBarEvaluationLock();
  if (!lockToken) return;

  const rthOpen = isWithinRthWindow();
  const startClock = getEtClockNow();
  const startBounds = getSessionBoundsEt(startClock.etDate);
  const initialStore = loadTradeStore();
  const hasStrandedOpen = Object.keys(initialStore.activePositions || {}).length > 0;
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  const hasWebhook = Boolean(webhookUrl?.trim());

  if (!rthOpen && !hasStrandedOpen) {
    if (
      startClock.isWeekday &&
      startClock.etMins >= startBounds.rthCloseMins &&
      startClock.etMins <= startBounds.rthCloseMins + 20 &&
      hasWebhook
    ) {
      await flushPendingDiscordAlerts({ webhookUrl }).catch(() => 0);
    }

    if (
      startClock.isWeekday &&
      startClock.etMins >= startBounds.rthCloseMins + 5 &&
      readAlphaPriorsSync().lastAttributionDate !== startClock.etDate
    ) {
      try {
        const ticks = getMergedIntradayHistory("SPY", startClock.etDate);
        if (ticks.length >= 6) {
          const bucketMap = new Map<number, typeof ticks>();
          for (const tick of ticks) {
            const bucket = Math.floor(tick.ts / 300) * 300;
            if (!bucketMap.has(bucket)) bucketMap.set(bucket, []);
            bucketMap.get(bucket)!.push(tick);
          }
          const bars = Array.from(bucketMap.entries())
            .sort((a, b) => a[0] - b[0])
            .map(([bucketTs, group]) => ({
              ts: bucketTs,
              open: group[0].spot,
              high: Math.max(...group.map((g) => g.spot)),
              low: Math.min(...group.map((g) => g.spot)),
              close: group[group.length - 1].spot,
            }));
          if (bars.length >= 6) {
            const flowSeries = computeBarFlowGammaVwapSeries(
              bars.map((b) => ({
                timestamp: b.ts,
                open: b.open,
                high: b.high,
                low: b.low,
                close: b.close,
              }))
            );
            const lastTick = ticks[ticks.length - 1];
            await runPostMarketAttribution({
              sessionDate: startClock.etDate,
              ticker: "SPY",
              bars,
              flowSeries,
              callWall: lastTick?.callWall || lastTick?.cw,
              putWall: lastTick?.putWall || lastTick?.pw,
              zeroGamma: lastTick?.zeroGamma || lastTick?.zg,
              zeroDteKing: lastTick?.king,
              executedTrades: initialStore.closedPositions,
            });
            if (!botState.isStopped) botState.lastStatus = "POST_MARKET_ATTRIBUTED";
          }
        }
      } catch (attrErr) {
        console.warn("[LiveBotDaemon] Post-market attribution failed:", attrErr);
      }
    }
    releaseBarEvaluationLock(lockToken);
    if (!botState.isStopped && botState.lastStatus !== "POST_MARKET_ATTRIBUTED") {
      botState.lastStatus = "OUTSIDE_RTH";
    }
    return;
  }

  if (rthOpen && !hasStrandedOpen && startClock.etMins > startBounds.entryCutoffMins) {
    if (hasWebhook) {
      await flushPendingDiscordAlerts({ webhookUrl }).catch(() => 0);
    }
    releaseBarEvaluationLock(lockToken);
    if (!botState.isStopped) botState.lastStatus = "OUTSIDE_ENTRY_WINDOW";
    return;
  }

  scheduleAlignedMocTick();
  botState.isPolling = true;
  botState.lastPollAtMs = Date.now();
  botState.pollCount += 1;
  if (!botState.isStopped) {
    botState.lastStatus = rthOpen ? "POLLING_RTH" : "EOD_STRANDED_CLEANUP";
  }

  const controller = new AbortController();
  botState.activeController = controller;
  const timeoutId = setTimeout(() => controller.abort(), 12_000);

  let tickWork: Promise<void> | null = null;
  tickWork = (async () => {
    // Yield microtask so `botState.inFlightTickPromise = tickWork` is assigned before cleanup
    await Promise.resolve();
    try {
      const todayStr = getEtDateString();
      const todayBounds = getSessionBoundsEt(todayStr);
      if (botState.sessionDateEt !== todayStr) {
        botState.sessionDateEt = todayStr;
        botState.dispatchedCount = 0;
      }

      const store = loadTradeStore();
      const activeKeys = Object.keys(store.activePositions || {});

      if (activeKeys.length > 0) {
        if (!botState.isStopped) botState.lastStatus = "ACTIVE_EVAL_STC";
        try {
          const activeAlerts = await evaluateAllActivePositions({
            webhookUrl,
            signal: controller.signal,
          });
          if (activeAlerts && activeAlerts.length > 0) {
            botState.dispatchedCount += activeAlerts.filter(
              (a) => !a.isHistoricalBackfill && hasWebhook
            ).length;
          }
        } finally {
          refreshBarEvaluationLock(lockToken);
          const mocClock = getEtClockNow();
          const mocBounds = getSessionBoundsEt(mocClock.etDate);
          if (mocClock.etMins >= mocBounds.eodFlatMins) {
            botState.dispatchedCount += await ensureMocCutoffForRemainingPositions(
              webhookUrl,
              mocClock
            );
          }
          if (hasWebhook) {
            await flushPendingDiscordAlerts({ webhookUrl, signal: controller.signal }).catch(() => 0);
          }
        }
        return;
      }

      if (controller.signal.aborted || botState.isStopped) return;
      if (!isWithinRthWindow()) {
        if (!botState.isStopped) botState.lastStatus = "OUTSIDE_RTH";
        return;
      }

      const nowClock = getEtClockNow();
      if (nowClock.etMins > todayBounds.entryCutoffMins) {
        if (hasWebhook) {
          await flushPendingDiscordAlerts({ webhookUrl, signal: controller.signal }).catch(() => 0);
        }
        if (!botState.isStopped) botState.lastStatus = "OUTSIDE_ENTRY_WINDOW";
        return;
      }
      if (!botState.isStopped) botState.lastStatus = "FLAT_EVAL_BTO";
      const nowTs = Math.floor(Date.now() / 1000);
      const trackedTickers = getActiveTrackedTickers();
      let evaluatedAny = false;
      for (const ticker of trackedTickers) {
        if (controller.signal.aborted || botState.isStopped) break;
        refreshBarEvaluationLock(lockToken);
        const currentStore = loadTradeStore();
        if (Object.keys(currentStore.activePositions || {}).length > 0) break;
        const posKey = ticker === "SPXW" || ticker === "SPX" ? "SPY" : ticker;
        const sameTickerClosed = (currentStore.closedPositions || []).filter(
          (p) => p.ticker === ticker || p.ticker === posKey
        );
        if (sameTickerClosed.length >= 2) continue;
        if (sameTickerClosed.length === 1) {
          const lastClosed = sameTickerClosed.reduce((a, b) => ((b.closedTs ?? 0) >= (a.closedTs ?? 0) ? b : a));
          if (!lastClosed?.closedTs || nowTs - lastClosed.closedTs < 1800 || nowClock.etMins < 630) {
            continue;
          }
        }
        evaluatedAny = true;

        const contracts = await fetchLiveCboeOptions(ticker, controller.signal);
        if (controller.signal.aborted || botState.isStopped) break;

        const cachedLiveSpot =
          getCachedSpotPrice(ticker) ??
          currentStore.prevSpotPrices?.[ticker] ??
          currentStore.prevSpotPrices?.[posKey] ??
          0;
        const initialLevels =
          cachedLiveSpot > 0 && contracts.length > 0
            ? computeLiveLevelsForTicker(
                ticker,
                cachedLiveSpot,
                contracts,
                currentStore.prevSpotPrices?.[ticker] || cachedLiveSpot
              )
            : null;

        const candleResult = await fetchLive5mCandleAndDivergence(
          ticker,
          controller.signal,
          contracts.length > 0 || initialLevels
            ? {
                contracts,
                structuralNodes: initialLevels
                  ? {
                      floorNode: initialLevels.putWall,
                      ceilingNode: initialLevels.callWall,
                      zeroGamma: initialLevels.zeroGamma,
                      netGex: initialLevels.netGexMillions,
                    }
                  : undefined,
              }
            : undefined
        );
        let enrichedCandle = candleResult.candle;
        const divergence5m = candleResult.divergence5m;
        const divergence30m = candleResult.divergence30m;
        const resolvedSpot = cachedLiveSpot > 0 ? cachedLiveSpot : enrichedCandle?.close ?? 0;

        let resolvedLevels = initialLevels;
        if (!resolvedLevels && resolvedSpot > 0 && contracts.length > 0) {
          resolvedLevels = computeLiveLevelsForTicker(
            ticker,
            resolvedSpot,
            contracts,
            currentStore.prevSpotPrices?.[ticker] || resolvedSpot
          );
          const reanchored = await fetchLive5mCandleAndDivergence(ticker, controller.signal, {
            contracts,
            structuralNodes: {
              floorNode: resolvedLevels.putWall,
              ceilingNode: resolvedLevels.callWall,
              zeroGamma: resolvedLevels.zeroGamma,
              netGex: resolvedLevels.netGexMillions,
            },
          });
          if (reanchored.candle) enrichedCandle = reanchored.candle;
        }

        const existingPolicy = readSupervisorPolicySync(todayStr, ticker);
        const prevSpotForZg = currentStore.prevSpotPrices?.[ticker] ?? 0;
        const zgLevel = resolvedLevels?.zeroGamma ?? 0;
        const zeroGammaFlipped = Boolean(
          zgLevel > 0 &&
            prevSpotForZg > 0 &&
            resolvedSpot > 0 &&
            ((prevSpotForZg <= zgLevel && resolvedSpot > zgLevel) ||
              (prevSpotForZg >= zgLevel && resolvedSpot < zgLevel))
        );
        const curAbsPe = Math.abs(
          enrichedCandle?.flowSnapshot?.impulsePeclet ??
            enrichedCandle?.flowSnapshot?.pecletNumber ??
            0
        );

        let effectivePolicy = existingPolicy;
        if (
          resolvedSpot > 0 &&
          shouldRefreshSupervisorCheckpoint(existingPolicy, nowClock.etMins, zeroGammaFlipped, curAbsPe)
        ) {
          const historicalSessions = await readHistoricalSessions(5);
          effectivePolicy = await evaluateAndPersistSessionPlaybook({
            sessionDate: todayStr,
            ticker,
            nowMs: Date.now(),
            spotPrice: resolvedSpot,
            prevSpotPrice: prevSpotForZg || resolvedSpot,
            callWall: resolvedLevels?.callWall ?? 0,
            putWall: resolvedLevels?.putWall ?? 0,
            zeroGamma: zgLevel,
            zeroDteKing: resolvedLevels?.kingNode?.zeroDteKing,
            allExpKing: resolvedLevels?.kingNode?.allExpKing ?? resolvedLevels?.tacticalKing,
            bookCenter: zgLevel,
            netGex: resolvedLevels?.netGexMillions,
            flowSnapshot: enrichedCandle?.flowSnapshot ?? null,
            historicalSessions,
          });
        }

        if (effectivePolicy?.standAsideVetoReason) {
          if (!botState.isStopped) {
            botState.lastStatus = "SUPERVISOR_STAND_ASIDE";
          }
          continue;
        }

        const res = await evaluateTradeSignals({
          ticker,
          spotPrice: resolvedSpot,
          callWall: resolvedLevels?.callWall ?? 0,
          putWall: resolvedLevels?.putWall ?? 0,
          zeroGamma: resolvedLevels?.zeroGamma ?? 0,
          zeroDteCallWall: resolvedLevels?.callWall ?? 0,
          zeroDtePutWall: resolvedLevels?.putWall ?? 0,
          zeroDteZeroGamma: resolvedLevels?.zeroGamma ?? 0,
          dailyExpectedMove: resolvedLevels?.dailyExpectedMove ?? null,
          kingNode: resolvedLevels?.kingNode,
          filteredKing: resolvedLevels?.tacticalKing,
          allExpKing: resolvedLevels?.kingNode?.allExpKing,
          bookCenter: resolvedLevels?.zeroGamma ?? 0,
          netGex: resolvedLevels?.netGexMillions,
          contracts,
          contractsAlreadyAnchored: true,
          latest5mCandle: enrichedCandle,
          divergence5m,
          divergence30m,
          webhookUrl,
          signal: controller.signal,
        });

        if (res.emittedAlerts && res.emittedAlerts.length > 0) {
          botState.dispatchedCount += res.emittedAlerts.filter(
            (a) => !a.isHistoricalBackfill && hasWebhook
          ).length;
        }

        const refreshedStore = loadTradeStore();
        if (Object.keys(refreshedStore.activePositions || {}).length > 0) {
          break;
        }
      }

      if (hasWebhook) {
        await flushPendingDiscordAlerts({ webhookUrl, signal: controller.signal }).catch(() => 0);
      }

      if (!botState.isStopped) {
        botState.lastStatus = controller.signal.aborted
          ? "TIMEOUT_ABORTED"
          : !evaluatedAny
            ? "LOCKED_FOR_DAY"
            : "ACTIVE_OK";
      }
    } catch (err) {
      if (!botState.isStopped) {
        botState.lastStatus = `ERROR: ${err instanceof Error ? err.message : "unknown"}`;
      }
    } finally {
      clearTimeout(timeoutId);
      if (botState.activeController === controller) botState.activeController = null;
      if (botState.inFlightTickPromise === tickWork) botState.inFlightTickPromise = null;
      if (botState.lockToken === lockToken) {
        botState.isPolling = false;
      }
      releaseBarEvaluationLock(lockToken);
    }
  })();

  botState.inFlightTickPromise = tickWork;
  const timeoutPromise = new Promise<void>((_, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => reject(new Error("Live bot tick aborted after 12s timeout")),
      { once: true }
    );
  });

  try {
    await Promise.race([tickWork, timeoutPromise]);
  } catch (err) {
    if (!botState.isStopped) {
      botState.lastStatus = `ERROR: ${err instanceof Error ? err.message : "unknown"}`;
    }
  }
}

export function ensureLiveBotRunning(): { running: boolean; pollCount: number; lastStatus: string } {
  const botState = getBotState();
  if (getExecutionRole() === "observer") {
    botState.lastStatus = "OBSERVER_MODE";
    return {
      running: false,
      pollCount: botState.pollCount,
      lastStatus: botState.lastStatus,
    };
  }
  botState.isStopped = false;
  if (!botState.intervalId) {
    botState.intervalId = setInterval(() => {
      void runLiveBotTick();
    }, POLL_INTERVAL_MS);

    if (typeof botState.intervalId === "object" && "unref" in botState.intervalId) {
      botState.intervalId.unref();
    }
    scheduleAlignedMocTick();
    void runLiveBotTick();
  }
  return {
    running: Boolean(botState.intervalId),
    pollCount: botState.pollCount,
    lastStatus: botState.lastStatus,
  };
}

export function stopLiveBot(): void {
  const botState = getBotState();
  botState.isStopped = true;
  if (botState.intervalId) {
    clearInterval(botState.intervalId);
    botState.intervalId = null;
  }
  if (botState.mocTimerId) {
    clearTimeout(botState.mocTimerId);
    botState.mocTimerId = null;
  }
  botState.activeController?.abort();
  releaseCrossProcessExecutionLease();
  if (!botState.inFlightTickPromise) {
    botState.isPolling = false;
    botState.isEvaluatingLiveBar = false;
    botState.lockAcquiredAtMs = 0;
    botState.lockToken = (botState.lockToken || 0) + 1;
    if (botState.lockWaiters && botState.lockWaiters.size > 0) {
      for (const wake of Array.from(botState.lockWaiters)) {
        wake();
      }
    }
  }
  botState.lastStatus = "STOPPED";
}

const globalForShutdownHooks = globalThis as unknown as {
  __hyperionShutdownHooksRegistered?: boolean;
};
const isTestOrCliRun =
  typeof process !== "undefined" &&
  (process.env.NODE_ENV === "test" ||
    (Array.isArray(process.argv) &&
      process.argv.some((arg) =>
        /\.(test|spec)\.|verifyExecutionInvariants|audit10DayBacktest|verifyLiveRoutes/.test(arg)
      )));

if (
  typeof process !== "undefined" &&
  typeof window === "undefined" &&
  !isTestOrCliRun &&
  !globalForShutdownHooks.__hyperionShutdownHooksRegistered
) {
  globalForShutdownHooks.__hyperionShutdownHooksRegistered = true;
  const handleSignal = (signal: string) => {
    stopLiveBot();
    console.log(`[LIVE-BOT-DAEMON] Cleanly halted background poller on ${signal}.`);
  };

  process.once("SIGTERM", () => handleSignal("SIGTERM"));
  process.once("SIGINT", () => handleSignal("SIGINT"));
}

export function getLiveBotStatus() {
  const botState = getBotState();
  return {
    running: Boolean(botState.intervalId),
    role: getExecutionRole(),
    isPolling: botState.isPolling,
    isEvaluatingLiveBar: botState.isEvaluatingLiveBar,
    startedAtMs: botState.startedAtMs,
    lastPollAtMs: botState.lastPollAtMs,
    lastStatus: botState.lastStatus,
    pollCount: botState.pollCount,
    sessionDateEt: botState.sessionDateEt,
    dispatchedCount: botState.dispatchedCount,
    trackedTickers: getActiveTrackedTickers(),
  };
}
