import fs from "fs";
import path from "path";

export interface IntradayHistoryPoint {
  t: string;
  ts: number;
  time: string;
  spot: number;
  cw: number;
  pw: number;
  zg: number;
  callWall: number;
  putWall: number;
  zeroGamma: number;
  king?: number;
}

export interface IntradayAlert {
  id: string;
  ts: number;
  timestamp: string;
  time: string;
  symbol: string;
  message: string;
  msg: string;
  type: "call" | "put" | "zero" | "king";
}

const RTH_START_MINS = 9 * 60 + 30; // 09:30 ET
const RTH_END_MINS = 16 * 60;       // 16:00 ET (exclusive)
const MAX_RTH_SNAPSHOTS = 1600;     // Covers full 6.5h RTH session at 15s cadence
const MAX_EXT_SNAPSHOTS = 250;      // Rolling extended-hours ring buffer

export interface TickerIntradayData {
  history: IntradayHistoryPoint[];
  rthHistory?: IntradayHistoryPoint[];
  extHistory?: IntradayHistoryPoint[];
  alerts: IntradayAlert[];
  lastBackfillAttempt?: number;
  officialLevels?: {
    callWall: number;
    callWallGex?: number;
    putWall: number;
    putWallGex?: number;
    zeroGamma: number;
    hasZeroGammaFlip?: boolean;
  };
}

export interface DailyStore {
  date: string;
  tickers: Record<string, TickerIntradayData>;
}

let inMemoryStore: DailyStore | null = null;

function getCacheDir(): string {
  const dir = path.join(process.cwd(), ".cache");
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // In read-only or serverless environments
    }
  }
  return dir;
}

export function getTodayEt(): string {
  try {
    return new Date().toLocaleDateString("en-CA", {
      timeZone: "America/New_York",
    });
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

export function formatTimeEt(dateOrTs: Date | number): string {
  const d = typeof dateOrTs === "number" ? new Date(dateOrTs * 1000) : dateOrTs;
  try {
    return d.toLocaleTimeString("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
}

export function getEtMinutesFromTs(tsSec: number): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date(tsSec * 1000));
    const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
    const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
    return hour * 60 + minute;
  } catch {
    const d = new Date(tsSec * 1000);
    return d.getHours() * 60 + d.getMinutes();
  }
}

export function isRthTimestampEt(tsSec: number): boolean {
  const etMins = getEtMinutesFromTs(tsSec);
  return etMins >= RTH_START_MINS && etMins < RTH_END_MINS;
}

function ensurePartitionedHistory(tickerData: TickerIntradayData): {
  rth: IntradayHistoryPoint[];
  ext: IntradayHistoryPoint[];
} {
  if (Array.isArray(tickerData.rthHistory) && Array.isArray(tickerData.extHistory)) {
    return { rth: tickerData.rthHistory, ext: tickerData.extHistory };
  }
  const rth: IntradayHistoryPoint[] = [];
  const ext: IntradayHistoryPoint[] = [];
  for (const pt of tickerData.history ?? []) {
    if (isRthTimestampEt(pt.ts)) rth.push(pt);
    else ext.push(pt);
  }
  tickerData.rthHistory = rth.slice(-MAX_RTH_SNAPSHOTS);
  tickerData.extHistory = ext.slice(-MAX_EXT_SNAPSHOTS);
  tickerData.history = [...tickerData.rthHistory, ...tickerData.extHistory].sort(
    (a, b) => a.ts - b.ts
  );
  return { rth: tickerData.rthHistory, ext: tickerData.extHistory };
}

function loadStore(): DailyStore {
  const today = getTodayEt();
  if (inMemoryStore && inMemoryStore.date === today) {
    return inMemoryStore;
  }

  const cacheDir = getCacheDir();
  try {
    const files = fs.readdirSync(cacheDir);
    for (const f of files) {
      if (f.startsWith("intraday-") && !f.includes(today)) {
        try {
          fs.unlinkSync(path.join(cacheDir, f));
        } catch {}
      }
    }
  } catch {}

  const filePath = path.join(cacheDir, `intraday-${today}.json`);

  if (fs.existsSync(filePath)) {
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw) as DailyStore;
      if (parsed && parsed.date === today && parsed.tickers) {
        inMemoryStore = parsed;
        return inMemoryStore;
      }
    } catch {
      // Failed to parse, initialize new
    }
  }

  inMemoryStore = {
    date: today,
    tickers: {},
  };
  return inMemoryStore;
}

function saveStore(store: DailyStore): void {
  try {
    const cacheDir = getCacheDir();
    const filePath = path.join(cacheDir, `intraday-${store.date}.json`);
    fs.writeFileSync(filePath, JSON.stringify(store, null, 2), "utf-8");
  } catch {
    // Non-fatal if filesystem write fails
  }
}

async function backfillFromTerraShade(
  ticker: string,
  store: DailyStore
): Promise<void> {
  const sym = ticker.trim().toUpperCase();
  const tickerData = store.tickers[sym] ?? {
    history: [],
    alerts: [],
    lastBackfillAttempt: 0,
  };

  const now = Date.now();
  if (now - (tickerData.lastBackfillAttempt ?? 0) < 60_000) {
    return;
  }
  tickerData.lastBackfillAttempt = now;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);

    const res = await fetch(
      `https://terrashade.onrender.com/api?symbol=${encodeURIComponent(sym)}`,
      {
        signal: controller.signal,
        headers: { Accept: "application/json" },
        cache: "no-store",
      }
    );
    clearTimeout(timeout);

    if (!res.ok) return;
    const data = await res.json();

    if (Array.isArray(data.history) && data.history.length > 0) {
      const backfilledHistory: IntradayHistoryPoint[] = data.history.map(
        (h: any) => {
          const ts =
            typeof h.ts === "number" ? h.ts : Math.floor(Date.now() / 1000);
          const time = formatTimeEt(ts);
          const spot = Number(h.spot ?? 0);
          const cw = Number(h.cw ?? h.call_wall ?? 0);
          const pw = Number(h.pw ?? h.put_wall ?? 0);
          const zg = Number(h.zg ?? h.zero_gamma ?? 0);
          return {
            t:
              h.t ??
              new Date(ts * 1000).toISOString().replace("T", " ").slice(0, 16) +
                " UTC",
            ts,
            time,
            spot,
            cw,
            pw,
            zg,
            callWall: cw,
            putWall: pw,
            zeroGamma: zg,
          };
        }
      );

      // Merge avoiding duplicate timestamps into partitioned RTH vs Extended-Hours arrays
      const { rth, ext } = ensurePartitionedHistory(tickerData);
      const existingTs = new Set([...rth, ...ext].map((item) => item.ts));
      for (const item of backfilledHistory) {
        if (!existingTs.has(item.ts)) {
          if (isRthTimestampEt(item.ts)) rth.push(item);
          else ext.push(item);
          existingTs.add(item.ts);
        }
      }
      rth.sort((a, b) => a.ts - b.ts);
      ext.sort((a, b) => a.ts - b.ts);
      tickerData.rthHistory = rth.slice(-MAX_RTH_SNAPSHOTS);
      tickerData.extHistory = ext.slice(-MAX_EXT_SNAPSHOTS);
      tickerData.history = [
        ...tickerData.rthHistory,
        ...tickerData.extHistory,
      ].sort((a, b) => a.ts - b.ts);
    }

    if (Array.isArray(data.alerts) && data.alerts.length > 0) {
      const existingMsgs = new Set(tickerData.alerts.map((a) => a.message));
      data.alerts.forEach((a: any, idx: number) => {
        const ts =
          typeof a.ts === "number" ? a.ts : Math.floor(Date.now() / 1000);
        const time = formatTimeEt(ts);
        const msg = String(a.msg ?? a.message ?? "");
        if (!msg || existingMsgs.has(msg)) return;

        const type: "call" | "put" | "zero" | "king" = msg.includes("Call wall")
          ? "call"
          : msg.includes("Put wall")
            ? "put"
            : msg.includes("zero gamma")
              ? "zero"
              : "king";

        tickerData.alerts.push({
          id: `${sym}-${ts}-${idx}`,
          ts,
          timestamp: time,
          time,
          symbol: sym,
          message: msg,
          msg,
          type,
        });
        existingMsgs.add(msg);
      });
      tickerData.alerts.sort((a, b) => a.ts - b.ts);
    }

    if (data.levels) {
      tickerData.officialLevels = {
        callWall: Number(data.levels.call_wall?.strike ?? 0),
        callWallGex: Number(
          ((data.levels.call_wall?.gex ?? 0) / 1e6).toFixed(2)
        ),
        putWall: Number(data.levels.put_wall?.strike ?? 0),
        putWallGex: Number(
          ((data.levels.put_wall?.gex ?? 0) / 1e6).toFixed(2)
        ),
        zeroGamma: Number((data.levels.zero_gamma ?? 0).toFixed(2)),
        hasZeroGammaFlip: true,
      };
    }

    store.tickers[sym] = tickerData;
    saveStore(store);
  } catch {
    // Non-fatal if TerraShade API is unreachable or times out
  }
}

export async function recordIntradaySnapshot(params: {
  ticker: string;
  spotPrice: number;
  callWall: number;
  putWall: number;
  zeroGamma: number;
  allExpKing?: number;
  nowMs?: number;
}): Promise<{
  history: IntradayHistoryPoint[];
  rthHistory?: IntradayHistoryPoint[];
  extHistory?: IntradayHistoryPoint[];
  alerts: IntradayAlert[];
  officialLevels?: {
    callWall: number;
    callWallGex?: number;
    putWall: number;
    putWallGex?: number;
    zeroGamma: number;
    hasZeroGammaFlip?: boolean;
  };
}> {
  const { ticker, spotPrice, callWall, putWall, zeroGamma, allExpKing } = params;
  const sym = ticker.trim().toUpperCase();
  const store = loadStore();

  if (
    !store.tickers[sym] ||
    store.tickers[sym].history.length < 2 ||
    Date.now() - (store.tickers[sym].lastBackfillAttempt ?? 0) > 300_000
  ) {
    await backfillFromTerraShade(sym, store);
  }

  const tickerData = store.tickers[sym] ?? {
    history: [],
    rthHistory: [],
    extHistory: [],
    alerts: [],
    lastBackfillAttempt: 0,
  };
  const { rth, ext } = ensurePartitionedHistory(tickerData);

  const now = params.nowMs ?? Date.now();
  const nowSec = Math.floor(now / 1000);
  const isRthTick = isRthTimestampEt(nowSec);
  const targetBucket = isRthTick ? rth : ext;
  const timeStr = formatTimeEt(nowSec);
  const tStr =
    new Date(now).toISOString().replace("T", " ").slice(0, 16) + " UTC";

  const prev = tickerData.history[tickerData.history.length - 1];
  const bucketPrev = targetBucket[targetBucket.length - 1];

  // 1. Detect transition alerts
  if (prev) {
    if (
      prev.king &&
      prev.king > 0 &&
      allExpKing &&
      allExpKing > 0 &&
      prev.king !== allExpKing
    ) {
      const msg = `${sym} King moved ${prev.king.toFixed(0)} → ${allExpKing.toFixed(0)}`;
      if (!tickerData.alerts.some((a) => a.message === msg)) {
        tickerData.alerts.push({
          id: `${sym}-king-${nowSec}`,
          ts: nowSec,
          timestamp: timeStr,
          time: timeStr,
          symbol: sym,
          message: msg,
          msg,
          type: "king",
        });
      }
    }

    if (prev.cw > 0 && callWall > 0 && prev.cw !== callWall) {
      const msg = `${sym} Call wall moved ${prev.cw.toFixed(0)} → ${callWall.toFixed(0)}`;
      if (!tickerData.alerts.some((a) => a.message === msg)) {
        tickerData.alerts.push({
          id: `${sym}-cw-${nowSec}`,
          ts: nowSec,
          timestamp: timeStr,
          time: timeStr,
          symbol: sym,
          message: msg,
          msg,
          type: "call",
        });
      }
    }

    if (prev.pw > 0 && putWall > 0 && prev.pw !== putWall) {
      const msg = `${sym} Put wall moved ${prev.pw.toFixed(0)} → ${putWall.toFixed(0)}`;
      if (!tickerData.alerts.some((a) => a.message === msg)) {
        tickerData.alerts.push({
          id: `${sym}-pw-${nowSec}`,
          ts: nowSec,
          timestamp: timeStr,
          time: timeStr,
          symbol: sym,
          message: msg,
          msg,
          type: "put",
        });
      }
    }

    if (prev.spot >= prev.zg && spotPrice < zeroGamma) {
      const msg = `${sym} crossed BELOW zero gamma ${Math.round(zeroGamma)} (spot ${spotPrice.toFixed(2)}) · negative gamma`;
      if (!tickerData.alerts.some((a) => a.message === msg)) {
        tickerData.alerts.push({
          id: `${sym}-zg-${nowSec}`,
          ts: nowSec,
          timestamp: timeStr,
          time: timeStr,
          symbol: sym,
          message: msg,
          msg,
          type: "zero",
        });
      }
    } else if (prev.spot < prev.zg && spotPrice >= zeroGamma) {
      const msg = `${sym} crossed ABOVE zero gamma ${Math.round(zeroGamma)} (spot ${spotPrice.toFixed(2)}) · positive gamma`;
      if (!tickerData.alerts.some((a) => a.message === msg)) {
        tickerData.alerts.push({
          id: `${sym}-zg-${nowSec}`,
          ts: nowSec,
          timestamp: timeStr,
          time: timeStr,
          symbol: sym,
          message: msg,
          msg,
          type: "zero",
        });
      }
    }
  }

  // 2. Append snapshot if 15s passed in target session partition or values changed
  const shouldAppend =
    !bucketPrev ||
    nowSec - bucketPrev.ts >= 15 ||
    Math.abs(bucketPrev.spot - spotPrice) >= 0.05 ||
    bucketPrev.cw !== callWall ||
    bucketPrev.pw !== putWall ||
    (allExpKing !== undefined && bucketPrev.king !== allExpKing);

  if (shouldAppend) {
    const newPoint: IntradayHistoryPoint = {
      t: tStr,
      ts: nowSec,
      time: timeStr,
      spot: Number(spotPrice.toFixed(2)),
      cw: callWall,
      pw: putWall,
      zg: Number(zeroGamma.toFixed(2)),
      callWall,
      putWall,
      zeroGamma: Number(zeroGamma.toFixed(2)),
      king: allExpKing,
    };
    targetBucket.push(newPoint);

    if (isRthTick && rth.length > MAX_RTH_SNAPSHOTS) {
      tickerData.rthHistory = rth.slice(-MAX_RTH_SNAPSHOTS);
    } else if (!isRthTick && ext.length > MAX_EXT_SNAPSHOTS) {
      tickerData.extHistory = ext.slice(-MAX_EXT_SNAPSHOTS);
    }
    tickerData.history = [
      ...(tickerData.rthHistory ?? rth),
      ...(tickerData.extHistory ?? ext),
    ].sort((a, b) => a.ts - b.ts);
  }

  store.tickers[sym] = tickerData;
  saveStore(store);

  return {
    history: tickerData.history,
    rthHistory: tickerData.rthHistory,
    extHistory: tickerData.extHistory,
    alerts: tickerData.alerts,
    officialLevels: tickerData.officialLevels,
  };
}
