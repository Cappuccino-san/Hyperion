import { isMarketOpen } from "@/lib/marketDataService";
import {
  evaluateTradeSignals,
  evaluateAllActivePositions,
  loadTradeStore,
} from "@/lib/tradeSignalEngine";

const POLL_INTERVAL_MS = 20_000; // 20 seconds during RTH
const WATCH_TICKERS = ["SPY"];

interface LiveBotGlobalState {
  intervalId: ReturnType<typeof setInterval> | null;
  isPolling: boolean;
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

function getEtDateString(nowMs: number = Date.now()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(nowMs));
}

function isWithinRthWindow(nowMs: number = Date.now()): boolean {
  const dt = new Date(nowMs);
  const dayOfWeek = dt.toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short" });
  if (dayOfWeek === "Sat" || dayOfWeek === "Sun") return false;

  const mkt = isMarketOpen(dt);
  if (!mkt.open) return false;

  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(dt);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  const etMins = hour * 60 + minute;

  return etMins >= 9 * 60 + 30 && etMins < 16 * 60;
}

function getBotState(): LiveBotGlobalState {
  if (!globalThis.__hyperionLiveBotState) {
    globalThis.__hyperionLiveBotState = {
      intervalId: null,
      isPolling: false,
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
  if (state.isEvaluatingLiveBar && nowMs - state.lockAcquiredAtMs < 30_000) {
    return 0;
  }
  state.isEvaluatingLiveBar = true;
  state.lockAcquiredAtMs = nowMs;
  state.lockToken = (state.lockToken || 0) + 1;
  return state.lockToken;
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

export async function runLiveBotTick(): Promise<void> {
  const botState = getBotState();
  if (botState.isPolling) return;

  const rthOpen = isWithinRthWindow();
  const initialStore = loadTradeStore();
  const hasStrandedOpen = Object.keys(initialStore.activePositions || {}).length > 0;
  if (!rthOpen && !hasStrandedOpen) {
    botState.lastStatus = "OUTSIDE_RTH";
    return;
  }

  // Atomic Token-Owned Lock Acquisition
  const lockToken = acquireBarEvaluationLock();
  if (!lockToken) return;
  botState.isPolling = true;
  botState.lastPollAtMs = Date.now();
  botState.pollCount += 1;
  botState.lastStatus = rthOpen ? "POLLING_RTH" : "EOD_STRANDED_CLEANUP";

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12_000);

  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => reject(new Error("Live bot tick aborted after 12s timeout")),
        { once: true }
      );
    });

    await Promise.race([
      (async () => {
        if (controller.signal.aborted) return;
        const todayStr = getEtDateString();
        if (botState.sessionDateEt !== todayStr) {
          botState.sessionDateEt = todayStr;
          botState.dispatchedCount = 0;
        }

        const store = loadTradeStore();
        const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
        const activeKeys = Object.keys(store.activePositions || {});

        // 1. Always evaluate active positions for STC / 15:55 ET MOC exit first (even after 16:00 ET if stranded)
        if (activeKeys.length > 0) {
          botState.lastStatus = "ACTIVE_EVAL_STC";
          const activeAlerts = await evaluateAllActivePositions({
            webhookUrl,
            signal: controller.signal,
          });
          if (controller.signal.aborted) return;
          if (activeAlerts && activeAlerts.length > 0) {
            botState.dispatchedCount += activeAlerts.length;
          }
          // Same-Bar Flip Guard: Exit immediately with no same-bar flip re-entries permitted
          return;
        }

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
          if (controller.signal.aborted) break;
          const res = await evaluateTradeSignals({
            ticker,
            spotPrice: 0, // Auto-fetches live spot
            callWall: 0,
            putWall: 0,
            zeroGamma: 0,
            webhookUrl,
            signal: controller.signal,
          });
          if (controller.signal.aborted) break;

          if (res.emittedAlerts && res.emittedAlerts.length > 0) {
            botState.dispatchedCount += res.emittedAlerts.length;
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
      })(),
      timeoutPromise,
    ]);
  } catch (err) {
    botState.lastStatus = `ERROR: ${err instanceof Error ? err.message : "unknown"}`;
  } finally {
    clearTimeout(timeoutId);
    releaseBarEvaluationLock(lockToken);
    botState.isPolling = false;
  }
}

export function ensureLiveBotRunning(): { running: boolean; pollCount: number; lastStatus: string } {
  const botState = getBotState();
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
  if (botState.intervalId) {
    clearInterval(botState.intervalId);
    botState.intervalId = null;
  }
  botState.isPolling = false;
  botState.isEvaluatingLiveBar = false;
  botState.lockAcquiredAtMs = 0;
  botState.lockToken = (botState.lockToken || 0) + 1;
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
