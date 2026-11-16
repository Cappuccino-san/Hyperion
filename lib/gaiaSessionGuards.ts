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

export function getTodayEt(now: Date = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
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

export function isWithinRth(etMins: number): boolean {
  return etMins >= RTH_OPEN_MINS && etMins < RTH_CLOSE_MINS;
}

export function isWithinEntryWindow(etMins: number): boolean {
  return etMins >= ENTRY_START_MINS && etMins <= ENTRY_CUTOFF_MINS;
}

export function isAtOrPastEodFlat(etMins: number): boolean {
  return etMins >= EOD_FORCE_FLAT_MINS;
}

/**
 * Caps an exit timestamp to 15:55:00 ET of the session it belongs to.
 * - At/after 15:55 ET → that day's 15:55:00 ET.
 * - Before 09:30 ET (overnight carry) → the prior day's 15:55:00 ET.
 * Returns the original timestamp when it is already inside the tradable window.
 */
export function capExitTsToEodFlat(tsSec: number): { ts: number; capped: boolean } {
  const ts = toEpochSec(tsSec);
  const sod = etSecondsOfDay(ts);
  if (sod >= EOD_FORCE_FLAT_SECS) {
    return { ts: ts - (sod - EOD_FORCE_FLAT_SECS), capped: true };
  }
  if (sod < RTH_OPEN_MINS * 60) {
    return { ts: ts - sod - (86400 - EOD_FORCE_FLAT_SECS), capped: true };
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

