import { isMarketOpen } from "@/lib/marketDataService";
import {
  evaluateTradeSignals,
  evaluateAllActivePositions,
  loadTradeStore,
} from "@/lib/tradeSignalEngine";
import type { NormalizedOptionContract } from "@/lib/optionsExposure";

const POLL_INTERVAL_MS = 20_000; // 20 seconds during RTH
const WATCH_TICKERS = ["SPY"];

interface LiveBotGlobalState {
  intervalId: ReturnType<typeof setInterval> | null;
  isPolling: boolean;
  inFlightTickPromise: Promise<void> | null;
  activeController: AbortController | null;
  isStopped: boolean;
  isEvaluatingLiveBar: boolean;
  lockAcquiredAtMs: number;
  lockToken: number;
  startedAtMs: number;
  lastPollAtMs: number;
  lastStatus: string;
  pollCount: number;
  sessionDateEt: string;
  dispatchedCount: number;
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
      startedAtMs: Date.now(),
      lastPollAtMs: 0,
      lastStatus: "IDLE",
      pollCount: 0,
      sessionDateEt: getEtDateString(),
      dispatchedCount: 0,
    };
  }
  return globalThis.__hyperionLiveBotState;
}

export function isEvaluatingLiveBar(): boolean {
  return Boolean(globalThis.__hyperionLiveBotState?.isEvaluatingLiveBar);
}

export function acquireBarEvaluationLock(): number {
  const state = getBotState();
  const nowMs = Date.now();
  if (state.inFlightTickPromise) {
    return 0;
  }
  if (state.isEvaluatingLiveBar && nowMs - state.lockAcquiredAtMs < 30_000) {
    return 0;
  }
  state.isEvaluatingLiveBar = true;
  state.lockAcquiredAtMs = nowMs;
  state.lockToken = (state.lockToken || 0) + 1;
  return state.lockToken;
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

  let dispatched = 0;
  for (const [ticker, pos] of openEntries) {
    if (!pos) continue;
    const cachedSpot = Number(
      store.prevSpotPrices?.[ticker] || store.prevSpotPrices?.[pos.ticker] || pos.btoSpotPrice || 0
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
    });
    dispatched += res.emittedAlerts.filter(
      (a) => !a.isHistoricalBackfill && Boolean(webhookUrl?.trim())
    ).length;
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
  const initialStore = loadTradeStore();
  const hasStrandedOpen = Object.keys(initialStore.activePositions || {}).length > 0;
  if (!rthOpen && !hasStrandedOpen) {
    releaseBarEvaluationLock(lockToken);
    botState.lastStatus = "OUTSIDE_RTH";
    return;
  }

  botState.isPolling = true;
  botState.lastPollAtMs = Date.now();
  botState.pollCount += 1;
  botState.lastStatus = rthOpen ? "POLLING_RTH" : "EOD_STRANDED_CLEANUP";

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
        botState.lastStatus = "ACTIVE_EVAL_STC";
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
        botState.lastStatus = "OUTSIDE_RTH";
        return;
      }

      // 2. Hard daily ceiling: max 2 closed trades/day (1 primary + 1 gated opposite-direction Leg-2)
      const closedLen = store.closedPositions?.length ?? 0;
      if (closedLen >= 2) {
        botState.lastStatus = "LOCKED_FOR_DAY";
        return;
      }

      // Poll watchlist tickers for new BTO setups when flat (or Phase-2 Call reclaim eligible)
      botState.lastStatus = "FLAT_EVAL_BTO";
      for (const ticker of WATCH_TICKERS) {
        if (controller.signal.aborted || botState.isStopped) break;
        const res = await evaluateTradeSignals({
          ticker,
          spotPrice: 0, // Auto-fetches live spot
          callWall: 0,
          putWall: 0,
          zeroGamma: 0,
          webhookUrl,
          signal: controller.signal,
        });

        if (res.emittedAlerts && res.emittedAlerts.length > 0) {
          botState.dispatchedCount += res.emittedAlerts.filter(
            (a) => !a.isHistoricalBackfill && hasWebhook
          ).length;
        }

        // Single-Slot Guard: Stop polling further tickers if a position was opened or daily limit reached
        const refreshedStore = loadTradeStore();
        if (
          Object.keys(refreshedStore.activePositions || {}).length > 0 ||
          (refreshedStore.closedPositions && refreshedStore.closedPositions.length >= 2)
        ) {
          break;
        }
      }

      botState.lastStatus = controller.signal.aborted ? "TIMEOUT_ABORTED" : "ACTIVE_OK";
    } catch (err) {
      botState.lastStatus = `ERROR: ${err instanceof Error ? err.message : "unknown"}`;
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
    botState.lastStatus = `ERROR: ${err instanceof Error ? err.message : "unknown"}`;
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
  }
  botState.lastStatus = "STOPPED";
}

// Register graceful shutdown hooks for container lifecycles
if (typeof process !== "undefined" && typeof window === "undefined") {
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
  };
}
