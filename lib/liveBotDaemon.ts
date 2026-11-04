import { isMarketOpen } from "@/lib/marketDataService";
import {
  evaluateTradeSignals,
  evaluateAllActivePositions,
} from "@/lib/tradeSignalEngine";

const POLL_INTERVAL_MS = 20_000; // 20 seconds during RTH
const WATCH_TICKERS = ["SPY"];

interface LiveBotGlobalState {
  intervalId: ReturnType<typeof setInterval> | null;
  isPolling: boolean;
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

async function runLiveBotTick(): Promise<void> {
  const botState = getBotState();
  if (botState.isPolling) return;

  if (!isWithinRthWindow()) {
    botState.lastStatus = "OUTSIDE_RTH";
    return;
  }

  botState.isPolling = true;
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

        const webhookUrl = process.env.DISCORD_WEBHOOK_URL;

        // 1. Evaluate all active positions first (STC target/stop/MOC checks)
        const activeAlerts = await evaluateAllActivePositions({ webhookUrl });
        if (activeAlerts && activeAlerts.length > 0) {
          botState.dispatchedCount += activeAlerts.length;
        }

        // 2. Poll watchlist tickers for new BTO setups
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
        }

        botState.lastStatus = "ACTIVE_OK";
      })(),
      timeoutPromise,
    ]);
  } catch (err) {
    botState.lastStatus = `ERROR: ${err instanceof Error ? err.message : "unknown"}`;
  } finally {
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
    startedAtMs: botState.startedAtMs,
    lastPollAtMs: botState.lastPollAtMs,
    lastStatus: botState.lastStatus,
    pollCount: botState.pollCount,
    sessionDateEt: botState.sessionDateEt,
    dispatchedCount: botState.dispatchedCount,
  };
}
