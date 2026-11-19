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

function isoDateUtc(year: number, month1Based: number, day: number): string {
  const dt = new Date(Date.UTC(year, month1Based - 1, day));
  return dt.toISOString().slice(0, 10);
}

function nthWeekdayOfMonthUtc(year: number, month1Based: number, weekday: number, nth: number): string {
  const firstDow = new Date(Date.UTC(year, month1Based - 1, 1)).getUTCDay();
  const offset = (weekday - firstDow + 7) % 7;
  const day = 1 + offset + (nth - 1) * 7;
  return isoDateUtc(year, month1Based, day);
}

function lastWeekdayOfMonthUtc(year: number, month1Based: number, weekday: number): string {
  const lastDay = new Date(Date.UTC(year, month1Based, 0));
  const diff = (lastDay.getUTCDay() - weekday + 7) % 7;
  return isoDateUtc(year, month1Based, lastDay.getUTCDate() - diff);
}

/** Anonymous Gregorian Easter algorithm -> returns Good Friday (Easter Sunday - 2 days). */
function computeGoodFridayIso(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const easterMonth = Math.floor((h + l - 7 * m + 114) / 31);
  const easterDay = ((h + l - 7 * m + 114) % 31) + 1;
  const easterMs = Date.UTC(year, easterMonth - 1, easterDay);
  return new Date(easterMs - 2 * 86_400_000).toISOString().slice(0, 10);
}

function observedFixedHolidayIso(year: number, month1Based: number, day: number): string | null {
  const dt = new Date(Date.UTC(year, month1Based - 1, day));
  const dow = dt.getUTCDay();
  if (dow === 6) {
    // Saturday -> observed Friday (note: Jan 1 on Saturday is observed Dec 31 of prior year on NYSE,
    // which is handled by checking Dec 31 when year+1 Jan 1 is Saturday)
    if (month1Based === 1 && day === 1) return null;
    return new Date(dt.getTime() - 86_400_000).toISOString().slice(0, 10);
  }
  if (dow === 0) {
    return new Date(dt.getTime() + 86_400_000).toISOString().slice(0, 10);
  }
  return isoDateUtc(year, month1Based, day);
}

interface NyseYearCalendar {
  holidays: Set<string>;
  earlyCloses: Record<string, number>;
}

const nyseCalendarCache = new Map<number, NyseYearCalendar>();

/**
 * Multi-year algorithmic NYSE equity-options holiday & 13:00 ET early-close calendar (works for 2025-2035+).
 */
export function getNyseCalendarForYear(year: number): NyseYearCalendar {
  const cached = nyseCalendarCache.get(year);
  if (cached) return cached;

  const holidays = new Set<string>();
  const add = (iso: string | null) => {
    if (iso) holidays.add(iso);
  };

  // Fixed / observed holidays
  add(observedFixedHolidayIso(year, 1, 1)); // New Year's Day
  // If next year's Jan 1 falls on Saturday, NYSE closes Friday Dec 31 of current year
  if (new Date(Date.UTC(year + 1, 0, 1)).getUTCDay() === 6) {
    holidays.add(isoDateUtc(year, 12, 31));
  }
  add(nthWeekdayOfMonthUtc(year, 1, 1, 3)); // MLK Jr. Day (3rd Mon Jan)
  add(nthWeekdayOfMonthUtc(year, 2, 1, 3)); // Presidents' Day (3rd Mon Feb)
  add(computeGoodFridayIso(year)); // Good Friday
  add(lastWeekdayOfMonthUtc(year, 5, 1)); // Memorial Day (last Mon May)
  if (year >= 2022) add(observedFixedHolidayIso(year, 6, 19)); // Juneteenth
  add(observedFixedHolidayIso(year, 7, 4)); // Independence Day
  add(nthWeekdayOfMonthUtc(year, 9, 1, 1)); // Labor Day (1st Mon Sep)
  const thanksgivingIso = nthWeekdayOfMonthUtc(year, 11, 4, 4); // 4th Thu Nov
  add(thanksgivingIso);
  add(observedFixedHolidayIso(year, 12, 25)); // Christmas Day

  // 13:00 ET (780m) early closes
  const earlyCloses: Record<string, number> = {};
  const maybeAddEarlyClose = (iso: string) => {
    const [yy, mm, dd] = iso.split("-").map(Number);
    const dow = new Date(Date.UTC(yy, mm - 1, dd)).getUTCDay();
    if (dow >= 1 && dow <= 5 && !holidays.has(iso)) {
      earlyCloses[iso] = 780;
    }
  };

  // Day before Independence Day (July 3) if Mon-Fri and not already observed holiday
  maybeAddEarlyClose(isoDateUtc(year, 7, 3));
  // Day after Thanksgiving (Black Friday)
  const blackFridayMs = Date.parse(`${thanksgivingIso}T00:00:00Z`) + 86_400_000;
  maybeAddEarlyClose(new Date(blackFridayMs).toISOString().slice(0, 10));
  // Christmas Eve (Dec 24) if Mon-Fri and not already observed holiday
  maybeAddEarlyClose(isoDateUtc(year, 12, 24));

  const cal: NyseYearCalendar = { holidays, earlyCloses };
  nyseCalendarCache.set(year, cal);
  return cal;
}

export function isNyseHoliday(dateIso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateIso)) return false;
  const year = Number(dateIso.slice(0, 4));
  return getNyseCalendarForYear(year).holidays.has(dateIso);
}

export function getNyseEarlyCloseMins(dateIso: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateIso)) return null;
  const year = Number(dateIso.slice(0, 4));
  const mins = getNyseCalendarForYear(year).earlyCloses[dateIso];
  return typeof mins === "number" ? mins : null;
}

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
  const isHoliday = isNyseHoliday(sessionDate);
  const isTradingDay = dow !== 0 && dow !== 6 && !isHoliday;
  const earlyCloseMins = getNyseEarlyCloseMins(sessionDate);
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

