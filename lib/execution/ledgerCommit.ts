import {
  capExitTsToEodFlat,
  getSessionBoundsEt,
  getTodayEt,
} from "@/lib/gaiaSessionGuards";
import {
  readSessionLedgerSync,
  writeSessionLedgerSync,
} from "@/lib/persistenceStore";
import type {
  DailyTradeStore,
  OptionTradePosition,
  TradeLifecycleAlert,
} from "@/lib/execution/types";
import {
  clampOptionPriceToGreekEnvelope,
  computeRemainingYearsToExpiration,
  formatTimeEt,
  getCachedSpotPrice,
  repriceOptionBSExact,
  solveImpliedVol,
} from "@/lib/execution/optionPricing";

const globalForGaiaDiscord = globalThis as unknown as {
  __hyperionDispatchedGaiaKeys?: Set<string>;
  __hyperionDispatchedDate?: string;
};

export function getGaiaDiscordDedupState(): {
  dispatchedSet: Set<string>;
  syncDate: (resolvedDate: string) => Set<string>;
} {
  if (!globalForGaiaDiscord.__hyperionDispatchedGaiaKeys) {
    globalForGaiaDiscord.__hyperionDispatchedGaiaKeys = new Set<string>();
  }
  return {
    dispatchedSet: globalForGaiaDiscord.__hyperionDispatchedGaiaKeys,
    syncDate: (resolvedDate: string) => {
      if (!globalForGaiaDiscord.__hyperionDispatchedGaiaKeys) {
        globalForGaiaDiscord.__hyperionDispatchedGaiaKeys = new Set<string>();
      }
      if (globalForGaiaDiscord.__hyperionDispatchedDate !== resolvedDate) {
        globalForGaiaDiscord.__hyperionDispatchedDate = resolvedDate;
        globalForGaiaDiscord.__hyperionDispatchedGaiaKeys.clear();
      }
      return globalForGaiaDiscord.__hyperionDispatchedGaiaKeys;
    },
  };
}

export function clearGaiaDiscordDedupCache(): void {
  globalForGaiaDiscord.__hyperionDispatchedGaiaKeys?.clear();
  delete globalForGaiaDiscord.__hyperionDispatchedDate;
}

export function loadTradeStore(requestedDate?: string): DailyTradeStore {
  return readSessionLedgerSync(requestedDate);
}

export function saveTradeStore(store: DailyTradeStore): void {
  writeSessionLedgerSync(store);
}

export function getActivePositions(date?: string): Record<string, OptionTradePosition> {
  const store = loadTradeStore(date);
  return store.activePositions;
}

export function getClosedPositions(ticker?: string, date?: string): OptionTradePosition[] {
  const store = loadTradeStore(date);
  if (!ticker) return store.closedPositions;
  const sym = ticker.trim().toUpperCase();
  const normalizedSym = sym === "SPX" ? "SPXW" : sym;
  return store.closedPositions.filter(
    (p) => p.ticker === sym || p.ticker === normalizedSym
  );
}

export function getDailyTradeAlerts(ticker?: string, date?: string): TradeLifecycleAlert[] {
  const store = loadTradeStore(date);
  if (!ticker) return store.alerts;
  const sym = ticker.trim().toUpperCase();
  const normalizedSym = sym === "SPX" ? "SPXW" : sym;
  return store.alerts.filter(
    (a) => a.ticker === sym || a.ticker === normalizedSym
  );
}

export function clearDailyTrades(): void {
  const today = getTodayEt();
  const prev = loadTradeStore(today);
  const prevVersion = prev?.date === today ? (prev.version ?? 0) : 0;
  clearGaiaDiscordDedupCache();
  saveTradeStore({
    date: today,
    version: prevVersion,
    activePositions: {},
    closedPositions: [],
    alerts: [],
    prevSpotPrices: {},
    bouncedPutWalls: {},
    dailyRecapSent: false,
  });
}

/**
 * Transitions contradictory/zombie active positions cleanly into `closedPositions`
 * (with capped EOD timestamp) instead of silent deletion, preserving daily audit trail.
 */
export function purgeZombieToClosed(
  store: DailyTradeStore,
  ticker: string,
  reason: string,
  fallbackSpot?: number,
  nowDate = new Date()
): OptionTradePosition | null {
  const pos = store.activePositions[ticker];
  if (!pos) return null;

  const sessionDate = store.date || getTodayEt(nowDate);
  const bounds = getSessionBoundsEt(sessionDate);
  const rawNowTs = Math.floor(nowDate.getTime() / 1000);
  const cappedTs = capExitTsToEodFlat(rawNowTs, sessionDate).ts;
  const spotRef =
    typeof fallbackSpot === "number" && fallbackSpot > 0
      ? fallbackSpot
      : getCachedSpotPrice(ticker) ??
        store.prevSpotPrices[ticker] ??
        pos.btoSpotPrice;

  const isCall = pos.contractType === "CALL";
  const entryAsk = pos.btoOptionAsk ?? pos.optionAsk ?? pos.btoOptionMid ?? 0.5;
  const heldMin = Math.max(1, (cappedTs - (pos.openedTs || cappedTs)) / 60);
  const dirMove = isCall ? spotRef - pos.btoSpotPrice : pos.btoSpotPrice - spotRef;
  const spotMovePct = Number(((dirMove / Math.max(0.01, pos.btoSpotPrice)) * 100).toFixed(2));
  const dte =
    typeof pos.expiration === "string" && /^\d{4}-\d{2}-\d{2}$/.test(pos.expiration) && pos.expiration > sessionDate
      ? 1
      : 0;
  const tEntry =
    typeof pos.entryTYears === "number" && pos.entryTYears > 0
      ? pos.entryTYears
      : computeRemainingYearsToExpiration((pos.openedTs || cappedTs) * 1000, dte);
  const tRem = computeRemainingYearsToExpiration(cappedTs * 1000, dte);
  const entrySpread =
    typeof pos.optionAsk === "number" && typeof pos.optionBid === "number" && pos.optionAsk >= pos.optionBid
      ? Math.max(0.01, pos.optionAsk - pos.optionBid)
      : 0.02;
  const rawEstBid =
    pos.strike > 0 && pos.btoSpotPrice > 0 && spotRef > 0
      ? Number(
          Math.max(
            0.01,
            repriceOptionBSExact(
              spotRef,
              pos.strike,
              tRem,
              solveImpliedVol(entryAsk, pos.btoSpotPrice, pos.strike, tEntry, isCall),
              isCall
            ) - entrySpread
          ).toFixed(2)
        )
      : Math.max(0.05, Number((entryAsk + dirMove * 0.25 - entrySpread).toFixed(2)));
  const exitMid = clampOptionPriceToGreekEnvelope(
    pos.btoSpotPrice,
    spotRef,
    entryAsk,
    rawEstBid,
    isCall,
    heldMin,
    {
      strike: pos.strike > 0 ? pos.strike : undefined,
      tEntryYears: tEntry,
      tRemainingYears: tRem,
      allowFloor: false,
    }
  );
  const pnlOptPct = Number((((exitMid - entryAsk) / Math.max(0.01, entryAsk)) * 100).toFixed(2));

  pos.status = "CLOSED";
  pos.remainingQty = 0;
  pos.btoOptionAsk = entryAsk;
  pos.closedTs = cappedTs;
  pos.closedAt = formatTimeEt(cappedTs);
  pos.closedSpotPrice = Number(spotRef.toFixed(2));
  pos.closedOptionBid = exitMid;
  pos.closedOptionMid = exitMid;
  pos.exitQuoteSource = "BS_FALLBACK";
  pos.pnlSpotPct = spotMovePct;
  pos.pnlOptionPct = pnlOptPct;
  pos.exitReason = `${reason}${bounds.isEarlyClose ? " (EARLY CLOSE)" : ""}`;
  pos.originBackfill = pos.originBackfill ?? true;

  store.closedPositions.unshift(pos);
  delete store.activePositions[ticker];
  return pos;
}
