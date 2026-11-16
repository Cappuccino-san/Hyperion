import { isMarketOpen } from "@/lib/marketDataService";
import { getTickerPreset } from "@/lib/tickerPresets";
import {
  evaluateTradeSignals,
  evaluateAllActivePositions,
  fetchLiveCboeOptions,
  fetchLive5mCandleAndDivergence,
  getCachedSpotPrice,
  loadTradeStore,
} from "@/lib/tradeSignalEngine";
import {
  computeOptionsAnalytics,
  deriveTacticalStructuralLevels,
  type NormalizedOptionContract,
} from "@/lib/optionsExposure";

const POLL_INTERVAL_MS = 20_000; // 20 seconds during RTH
const DEFAULT_WATCH_TICKERS = ["SPY"] as const;
const MAX_TRACKED_TICKERS = 8;
const TRACKED_TICKER_TTL_MS = 4 * 60 * 60_000;

interface LiveBotGlobalState {
  intervalId: ReturnType<typeof setInterval> | null;
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
  const { isWeekday, etMins } = getEtClockNow(nowMs);
  if (!isWeekday) return false;

  const mkt = isMarketOpen(dt);
  if (!mkt.open) return false;

  return etMins >= 9 * 60 + 30 && etMins < 16 * 60;
}

function getBotState(): LiveBotGlobalState {
  const now = Date.now();
  if (!globalThis.__hyperionLiveBotState) {
    globalThis.__hyperionLiveBotState = {
      intervalId: null,
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
  state.isEvaluatingLiveBar = true;
  state.lockAcquiredAtMs = nowMs;
  state.lockToken = (state.lockToken || 0) + 1;
  return state.lockToken;
}

export async function acquireBarEvaluationLockWithWait(
  timeoutMs: number = 2500,
  signal?: AbortSignal
): Promise<number> {
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
    state.lockAcquiredAtMs = Date.now();
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
 * Fail-Closed 15:55:00 ET MOC Force-Liquidation Fallback:
 * Closes still-open positions using cached spot + synthetic contract when upstream feeds stall/abort.
 * Caller must hold acquireBarEvaluationLock().
 */
export async function ensureMocCutoffForRemainingPositions(
  webhookUrl?: string,
  clock: { etDate: string; etMins: number } = getEtClockNow()
): Promise<number> {
  if (clock.etMins < 955) return 0;
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
  if (botState.isStopped || botState.isPolling || botState.inFlightTickPromise) return;

  // Acquire token-owned lock BEFORE inspecting mutable trade store
  const lockToken = acquireBarEvaluationLock();
  if (!lockToken) return;

  const rthOpen = isWithinRthWindow();
  const startClock = getEtClockNow();
  const initialStore = loadTradeStore();
  const hasStrandedOpen = Object.keys(initialStore.activePositions || {}).length > 0;
  if (!rthOpen && !hasStrandedOpen) {
    releaseBarEvaluationLock(lockToken);
    if (!botState.isStopped) botState.lastStatus = "OUTSIDE_RTH";
    return;
  }
  if (rthOpen && !hasStrandedOpen && startClock.etMins > 870) {
    releaseBarEvaluationLock(lockToken);
    if (!botState.isStopped) botState.lastStatus = "OUTSIDE_ENTRY_WINDOW";
    return;
  }

  botState.isPolling = true;
  botState.lastPollAtMs = Date.now();
  botState.pollCount += 1;
  if (!botState.isStopped) {
    botState.lastStatus = rthOpen ? "POLLING_RTH" : "EOD_STRANDED_CLEANUP";
  }

  const controller = new AbortController();
  botState.activeController = controller;
  const timeoutId = setTimeout(() => controller.abort(), 12_000);

  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  const hasWebhook = Boolean(webhookUrl?.trim());

  // Keep lockToken & inFlightTickPromise held until tickWork settles (prevents Promise.race split-brain)
  let tickWork: Promise<void> | null = null;
  tickWork = (async () => {
    try {
      const todayStr = getEtDateString();
      if (botState.sessionDateEt !== todayStr) {
        botState.sessionDateEt = todayStr;
        botState.dispatchedCount = 0;
      }

      const store = loadTradeStore();
      const activeKeys = Object.keys(store.activePositions || {});

      // 1. Always evaluate active positions for STC / 15:55 ET MOC exit first (even after 16:00 ET if stranded)
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
          if (mocClock.etMins >= 955) {
            botState.dispatchedCount += await ensureMocCutoffForRemainingPositions(
              webhookUrl,
              mocClock
            );
          }
        }
        // Same-Bar Flip Guard: Exit immediately with no same-bar flip re-entries permitted
        return;
      }

      if (controller.signal.aborted || botState.isStopped) return;
      if (!isWithinRthWindow()) {
        if (!botState.isStopped) botState.lastStatus = "OUTSIDE_RTH";
        return;
      }

      // Poll tracked tickers for new BTO setups when flat (or Phase-2 opposite reclaim eligible)
      const nowClock = getEtClockNow();
      if (nowClock.etMins > 870) {
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
          bookCenter: resolvedLevels?.zeroGamma ?? 0,
          netGex: resolvedLevels?.netGexMillions,
          contracts,
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

        // Single-Slot Guard: Stop polling further tickers if a position was opened
        const refreshedStore = loadTradeStore();
        if (Object.keys(refreshedStore.activePositions || {}).length > 0) {
          break;
        }
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
      botState.isPolling = false;
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
  botState.isStopped = false;
  if (!botState.intervalId) {
    botState.intervalId = setInterval(() => {
      void runLiveBotTick();
    }, POLL_INTERVAL_MS);

    if (typeof botState.intervalId === "object" && "unref" in botState.intervalId) {
      botState.intervalId.unref();
    }
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
  botState.activeController?.abort();
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

// Register graceful shutdown hooks for container lifecycles (guarded against HMR & test/CLI runs)
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
