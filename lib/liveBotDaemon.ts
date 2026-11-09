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

  return etMins >= 9 * 60 + 30 && etMins <= 16 * 60;
}

function getBotState(): LiveBotGlobalState {
  if (!globalThis.__hyperionLiveBotState) {
    globalThis.__hyperionLiveBotState = {
      intervalId: null,
      isPolling: false,
      isEvaluatingLiveBar: false,
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

export function acquireBarEvaluationLock(): boolean {
  const state = getBotState();
  if (state.isEvaluatingLiveBar) return false;
  state.isEvaluatingLiveBar = true;
  return true;
}

export function releaseBarEvaluationLock(): void {
  const state = getBotState();
  state.isEvaluatingLiveBar = false;
}

export async function runLiveBotTick(): Promise<void> {
  const botState = getBotState();
  if (botState.isPolling || botState.isEvaluatingLiveBar) return;

  if (!isWithinRthWindow()) {
    botState.lastStatus = "OUTSIDE_RTH";
    return;
  }

  // Atomic Memory Lock Acquisition
  botState.isPolling = true;
  botState.isEvaluatingLiveBar = true;
  botState.lastPollAtMs = Date.now();
  botState.pollCount += 1;
  botState.lastStatus = "POLLING_RTH";

  try {
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Live bot tick timed out after 15s")), 15_000)
    );

    await Promise.race([
      (async () => {
        const todayStr = getEtDateString();
        if (botState.sessionDateEt !== todayStr) {
          botState.sessionDateEt = todayStr;
          botState.dispatchedCount = 0;
        }

        const store = loadTradeStore();

        // Linear State Machine Invariant:
        // FLAT (0 trades) -> ACTIVE (1 contract) -> LOCKED_FOR_DAY (1 trade completed)
        if (store.closedPositions && store.closedPositions.length >= 1) {
          botState.lastStatus = "LOCKED_FOR_DAY";
          return;
        }

        const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
        const activeKeys = Object.keys(store.activePositions || {});

        // If an active position exists, evaluate exits ONLY. No new BTO entries allowed.
        if (activeKeys.length > 0) {
          botState.lastStatus = "ACTIVE_EVAL_STC";
          const activeAlerts = await evaluateAllActivePositions({ webhookUrl });
          if (activeAlerts && activeAlerts.length > 0) {
            botState.dispatchedCount += activeAlerts.length;
          }
          // Same-Bar Flip Guard: Exit immediately with no same-bar flip re-entries permitted
          return;
        }

        // Poll watchlist tickers for new BTO setups ONLY when strictly FLAT (0 active, 0 closed)
        botState.lastStatus = "FLAT_EVAL_BTO";
        for (const ticker of WATCH_TICKERS) {
          const res = await evaluateTradeSignals({
            ticker,
            spotPrice: 0, // Auto-fetches live spot
            callWall: 0,
            putWall: 0,
            zeroGamma: 0,
            webhookUrl,
          });

          if (res.emittedAlerts && res.emittedAlerts.length > 0) {
            botState.dispatchedCount += res.emittedAlerts.length;
          }

          // Single-Slot Guard: Stop polling further tickers if a position was opened
          const refreshedStore = loadTradeStore();
          if (
            Object.keys(refreshedStore.activePositions || {}).length > 0 ||
            (refreshedStore.closedPositions && refreshedStore.closedPositions.length >= 1)
          ) {
            break;
          }
        }

        botState.lastStatus = "ACTIVE_OK";
      })(),
      timeoutPromise,
    ]);
  } catch (err) {
    botState.lastStatus = `ERROR: ${err instanceof Error ? err.message : "unknown"}`;
  } finally {
    botState.isEvaluatingLiveBar = false;
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
