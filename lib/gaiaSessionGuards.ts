/**
 * Gaia Session Guards — single source of truth for RTH time gates and candle provenance.
 *
 * Shared by the server engine (tradeSignalEngine.ts), the FSM (gaiaSignalFsm.ts),
 * and the HUD ledger (GaiaCallPutBiasHud.tsx / PrzmTacticalHud.tsx) so that all
 * three evaluators enforce identical boundaries.
 */

// Minutes from midnight ET
export const RTH_OPEN_MINS = 570; // 09:30 ET
export const ENTRY_START_MINS = 575; // 09:35 ET (first 5m candle closed)
export const ENTRY_CUTOFF_MINS = 870; // 14:30 ET (no late-day chasing)
export const EOD_FORCE_FLAT_MINS = 955; // 15:55 ET (hard MOC flat)
export const RTH_CLOSE_MINS = 960; // 16:00 ET (after-hours firewall)

export const HOLIDAYS_2026: ReadonlySet<string> = new Set([
  "2026-01-01",
  "2026-01-19",
  "2026-02-16",
  "2026-04-03",
  "2026-05-25",
  "2026-06-19",
  "2026-07-03",
  "2026-09-07",
  "2026-11-26",
  "2026-12-25",
]);

export const EARLY_CLOSES_2026: Readonly<Record<string, number>> = {
  "2026-11-27": 780, // Day after Thanksgiving: 13:00 ET close
  "2026-12-24": 780, // Christmas Eve: 13:00 ET close
};

export interface SessionBoundsEt {
  sessionDate: string;
  isTradingDay: boolean;
  isEarlyClose: boolean;
  rthOpenMins: number;
  entryStartMins: number;
  entryCutoffMins: number;
  eodFlatMins: number;
  rthCloseMins: number;
}

export function getTodayEt(now: Date = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

/**
 * Returns session calendar and intraday RTH cutoff bounds for a given ET date (YYYY-MM-DD).
 * Early-close sessions (13:00 ET close) enforce an 11:30 ET entry cutoff and 12:55 ET MOC flat.
 */
export function getSessionBoundsEt(etDate?: string): SessionBoundsEt {
  const sessionDate =
    etDate && /^\d{4}-\d{2}-\d{2}$/.test(etDate) ? etDate : getTodayEt();
  const [y, m, d] = sessionDate.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const isHoliday = HOLIDAYS_2026.has(sessionDate);
  const isTradingDay = dow !== 0 && dow !== 6 && !isHoliday;
  const earlyCloseMins = EARLY_CLOSES_2026[sessionDate];
  const isEarlyClose = typeof earlyCloseMins === "number";

  if (isEarlyClose) {
    return {
      sessionDate,
      isTradingDay,
      isEarlyClose: true,
      rthOpenMins: RTH_OPEN_MINS,
      entryStartMins: ENTRY_START_MINS,
      entryCutoffMins: Math.min(ENTRY_CUTOFF_MINS, earlyCloseMins - 90), // 11:30 ET (690)
      eodFlatMins: earlyCloseMins - 5, // 12:55 ET (775)
      rthCloseMins: earlyCloseMins, // 13:00 ET (780)
    };
  }

  return {
    sessionDate,
    isTradingDay,
    isEarlyClose: false,
    rthOpenMins: RTH_OPEN_MINS,
    entryStartMins: ENTRY_START_MINS,
    entryCutoffMins: ENTRY_CUTOFF_MINS,
    eodFlatMins: EOD_FORCE_FLAT_MINS,
    rthCloseMins: RTH_CLOSE_MINS,
  };
}

export function formatEtMinsAsTimeString(mins: number): string {
  const hh = Math.floor(mins / 60);
  const mm = mins % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00`;
}

const EOD_FORCE_FLAT_SECS = EOD_FORCE_FLAT_MINS * 60;

const ET_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour12: false,
  hourCycle: "h23",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** Normalizes seconds-or-milliseconds epoch to epoch seconds. */
export function toEpochSec(ts: number): number {
  return ts > 1e11 ? Math.floor(ts / 1000) : Math.floor(ts);
}

/** Seconds since midnight ET for an epoch timestamp (seconds or ms). */
export function etSecondsOfDay(ts: number): number {
  const parts = ET_PARTS.formatToParts(new Date(toEpochSec(ts) * 1000));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return (get("hour") % 24) * 3600 + get("minute") * 60 + get("second");
}

/** Minutes since midnight ET for an epoch timestamp (seconds or ms). */
export function etMinutesOfDay(ts: number): number {
  return Math.floor(etSecondsOfDay(ts) / 60);
}

export function isWithinRth(etMins: number, etDate?: string): boolean {
  const bounds = getSessionBoundsEt(etDate);
  return etMins >= bounds.rthOpenMins && etMins < bounds.rthCloseMins;
}

export function isWithinEntryWindow(etMins: number, etDate?: string): boolean {
  const bounds = getSessionBoundsEt(etDate);
  return etMins >= bounds.entryStartMins && etMins <= bounds.entryCutoffMins;
}

export function isAtOrPastEodFlat(etMins: number, etDate?: string): boolean {
  const bounds = getSessionBoundsEt(etDate);
  return etMins >= bounds.eodFlatMins;
}

/**
 * Caps an exit timestamp to 15:55:00 ET (or 12:55:00 ET on early-close sessions).
 * - At/after MOC cutoff -> that day's MOC cutoff.
 * - Before 09:30 ET (overnight carry) -> the prior session's MOC cutoff.
 * Returns the original timestamp when it is already inside the tradable window.
 */
export function capExitTsToEodFlat(tsSec: number, etDate?: string): { ts: number; capped: boolean } {
  const ts = toEpochSec(tsSec);
  const sod = etSecondsOfDay(ts);
  const dateStr = etDate || getTodayEt(new Date(ts * 1000));
  const bounds = getSessionBoundsEt(dateStr);
  const eodFlatSecs = bounds.eodFlatMins * 60;
  if (sod >= eodFlatSecs) {
    return { ts: ts - (sod - eodFlatSecs), capped: true };
  }
  if (sod < bounds.rthOpenMins * 60) {
    const prevDateStr = getTodayEt(new Date((ts - sod - 43200) * 1000));
    const prevEodFlatSecs = getSessionBoundsEt(prevDateStr).eodFlatMins * 60;
    return { ts: ts - sod - (86400 - prevEodFlatSecs), capped: true };
  }
  return { ts, capped: false };
}

/**
 * Candle provenance guard: returns the real market candles, or an empty array.
 * NEVER synthesizes placeholder candles — a synthetic series once produced a
 * fake $761.82 LONG that was synced to the live trade engine (2026-11-10).
 */
export function resolveRealCandles<T>(candles?: T[] | null, bars?: T[] | null): T[] {
  if (Array.isArray(candles) && candles.length > 0) return candles;
  if (Array.isArray(bars) && bars.length > 0) return bars;
  return [];
}

