import fs from "fs";
import path from "path";
import type { DailyTradeStore } from "@/lib/execution/types";
import type { DailyStore } from "@/lib/intradayHistory";
import { getTodayEt } from "@/lib/gaiaSessionGuards";

export type DurableBackendKind = "upstash-redis" | "turso-libsql" | "postgres" | "http-kv" | "local-cache";

export type MarketRegimeId =
  | "POS_GAMMA_PIN"
  | "NEG_GAMMA_TREND"
  | "ZERO_GAMMA_FLIP"
  | "LOW_EDGE_CHOP";

export interface RegimeAlphaStats {
  wins: number;
  losses: number;
  sumR: number;
  avgR: number;
  winRatePct: number;
  lastUpdatedDate?: string;
}

export type AlphaFeatureWeights = {
  fluxAlignment: number;
  flowVwapBand: number;
  wallRoom: number;
  kingMagnet: number;
  mtfDivergence: number;
  regimeFit: number;
};

export type FeatureIcMap = AlphaFeatureWeights;

export interface AlphaPriorsState {
  version: number;
  updatedAt: string;
  priorStrengthM: number;
  baselineWinRate: number; // e.g. 0.58
  baselineExpectancyR: number; // e.g. 0.35
  featureWeights: AlphaFeatureWeights;
  rollingFeatureIc?: FeatureIcMap;
  regimeStats: Record<MarketRegimeId, RegimeAlphaStats>;
  setupStats: Record<string, RegimeAlphaStats>;
  lastAttributionDate?: string;
}

export interface SessionPlaybookPolicy {
  sessionDate: string;
  ticker: string;
  checkpoint: "OPEN_0935" | "MID_MORNING_1030" | "AFTERNOON_1300" | "ZERO_GAMMA_FLIP" | "INTRADAY";
  evaluatedAtEt: string;
  evaluatedAtTs: number;
  regime: MarketRegimeId;
  allowedRegimes: MarketRegimeId[];
  preferredDte: "0DTE" | "1-2DTE" | "NONE";
  minExpectancyR: number;
  minWinRatePct: number;
  standAsideVetoReason: string | null;
  kingDivergencePct: number;
  trailing5dDrawdownDollars: number;
  trailing5dPnlDollars: number;
  zeroGammaSide: "ABOVE" | "BELOW" | "AT";
  wallCorridorPct: number;
  absPeclet: number;
  summary: string;
}

export interface CounterfactualEvalRecord {
  timestamp: number;
  timeEt: string;
  direction: "CALL" | "PUT";
  setupName: string;
  regime: MarketRegimeId;
  wasExecuted: boolean;
  skipReason?: string;
  entrySpot: number;
  target1Spot: number;
  stopLossSpot: number;
  realizedOptionR: number;
  mfeR: number;
  maeR: number;
  thetaAdjustedPnlPct: number;
}

export interface ShadowParityReport {
  liveTradeCount: number;
  replayTradeCount: number;
  matchedCount: number;
  directionMatchPct: number;
  meanEntrySpotDrift: number;
  meanOutcomeRDrift: number;
  maxPnlPctDrift: number;
  parityStatus: "PASS" | "DRIFT_WARN" | "NO_DATA";
}

export interface PostMarketAttributionReport {
  sessionDate: string;
  ticker: string;
  evaluatedAtEt: string;
  executedCount: number;
  executedAvgR: number;
  skippedCount: number;
  skippedCounterfactualAvgR: number;
  missedAlphaCount: number;
  savedChopCount: number;
  featureIc?: FeatureIcMap;
  shadowParityReport?: ShadowParityReport;
  updatedPriorsSummary: string;
  records: CounterfactualEvalRecord[];
}

export interface DurableKvAdapter {
  kind: DurableBackendKind;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  listKeys(prefix: string): Promise<string[]>;
}

const KEY_PREFIX = "hyperion:v1:";
const RETENTION_DAYS = 14;

const DEFAULT_ALPHA_PRIORS: AlphaPriorsState = {
  version: 1,
  updatedAt: new Date(0).toISOString(),
  priorStrengthM: 10,
  baselineWinRate: 0.62,
  baselineExpectancyR: 0.42,
  featureWeights: {
    fluxAlignment: 1.0,
    flowVwapBand: 1.0,
    wallRoom: 1.0,
    kingMagnet: 1.0,
    mtfDivergence: 1.0,
    regimeFit: 1.0,
  },
  regimeStats: {
    POS_GAMMA_PIN: { wins: 6, losses: 3, sumR: 4.5, avgR: 0.5, winRatePct: 66.7 },
    NEG_GAMMA_TREND: { wins: 7, losses: 3, sumR: 5.8, avgR: 0.58, winRatePct: 70.0 },
    ZERO_GAMMA_FLIP: { wins: 6, losses: 3, sumR: 4.9, avgR: 0.54, winRatePct: 66.7 },
    LOW_EDGE_CHOP: { wins: 2, losses: 8, sumR: -4.2, avgR: -0.42, winRatePct: 20.0 },
  },
  setupStats: {},
};

const globalForPersistence = globalThis as unknown as {
  __hyperionLedgerMemCache?: Map<string, { store: DailyTradeStore; mtimeMs: number }>;
  __hyperionIntradayMemCache?: Map<string, { store: DailyStore; mtimeMs: number }>;
  __hyperionPolicyMemCache?: Map<string, SessionPlaybookPolicy>;
  __hyperionPriorsMemCache?: AlphaPriorsState | null;
  __hyperionWriteSeq?: number;
  __hyperionCustomAdapter?: DurableKvAdapter | null;
  __hyperionBootHydrated?: boolean;
  __hyperionHydratePromise?: Promise<{ hydratedKeys: number; backend: DurableBackendKind }> | null;
  __hyperionPendingRemoteWrites?: Set<Promise<void>>;
  __hyperionWarnedPgFallback?: boolean;
  __hyperionTursoSchemaReady?: boolean;
};

function getLedgerMemMap(): Map<string, { store: DailyTradeStore; mtimeMs: number }> {
  return (globalForPersistence.__hyperionLedgerMemCache ??= new Map());
}

function getIntradayMemMap(): Map<string, { store: DailyStore; mtimeMs: number }> {
  return (globalForPersistence.__hyperionIntradayMemCache ??= new Map());
}

function getPolicyMemMap(): Map<string, SessionPlaybookPolicy> {
  return (globalForPersistence.__hyperionPolicyMemCache ??= new Map());
}

function getPendingWritesSet(): Set<Promise<void>> {
  return (globalForPersistence.__hyperionPendingRemoteWrites ??= new Set());
}

export function getPersistenceCacheDir(): string {
  const custom = process.env.HYPERION_CACHE_DIR?.trim();
  const dir = custom ? path.resolve(custom) : path.join(process.cwd(), ".cache");
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // Read-only or serverless fallback
    }
  }
  return dir;
}

export function createEmptySessionLedger(sessionDate: string): DailyTradeStore {
  return {
    date: sessionDate,
    version: 1,
    updatedAtMs: Date.now(),
    activePositions: {},
    closedPositions: [],
    alerts: [],
    prevSpotPrices: {},
  };
}

export function cloneDefaultAlphaPriors(): AlphaPriorsState {
  return JSON.parse(JSON.stringify(DEFAULT_ALPHA_PRIORS)) as AlphaPriorsState;
}

export function setDurableBackendAdapterForTests(adapter: DurableKvAdapter | null): void {
  globalForPersistence.__hyperionCustomAdapter = adapter;
  globalForPersistence.__hyperionBootHydrated = false;
  globalForPersistence.__hyperionHydratePromise = null;
}

export function resetPersistenceMemCachesForTests(): void {
  getLedgerMemMap().clear();
  getIntradayMemMap().clear();
  getPolicyMemMap().clear();
  globalForPersistence.__hyperionPriorsMemCache = null;
  globalForPersistence.__hyperionBootHydrated = false;
  globalForPersistence.__hyperionHydratePromise = null;
}

export async function flushPersistenceWritesForTests(): Promise<void> {
  const pending = Array.from(getPendingWritesSet());
  if (pending.length > 0) {
    await Promise.allSettled(pending);
  }
}

function atomicWriteJsonSync(filePath: string, payload: unknown): number {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      return 0;
    }
  }
  const writeSeq = (globalForPersistence.__hyperionWriteSeq =
    (globalForPersistence.__hyperionWriteSeq ?? 0) + 1);
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${writeSeq}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), "utf-8");
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        fs.renameSync(tmpPath, filePath);
        try {
          return fs.statSync(filePath).mtimeMs;
        } catch {
          return Date.now();
        }
      } catch (err: any) {
        const code = err?.code;
        if (attempt < 2 && (code === "EPERM" || code === "EACCES" || code === "EBUSY")) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
          continue;
        }
        throw err;
      }
    }
  } catch {
    return 0;
  } finally {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup error
    }
  }
  return 0;
}

function reapStaleFiles(cacheDir: string, prefix: string, keepDays: number): void {
  try {
    const files = fs.readdirSync(cacheDir);
    const validDates = new Set<string>();
    for (let offset = 0; offset < keepDays; offset++) {
      const dt = new Date();
      dt.setDate(dt.getDate() - offset);
      validDates.add(dt.toLocaleDateString("en-CA", { timeZone: "America/New_York" }));
    }
    const staleTmpCutoffMs = Date.now() - 5 * 60_000;
    for (const f of files) {
      if (f.startsWith(prefix) && f.includes(".json.tmp.")) {
        try {
          const full = path.join(cacheDir, f);
          if (fs.statSync(full).mtimeMs < staleTmpCutoffMs) fs.unlinkSync(full);
        } catch {}
        continue;
      }
      if (f.startsWith(prefix) && f.endsWith(".json")) {
        const match = f.match(/(\d{4}-\d{2}-\d{2})/);
        if (match && !validDates.has(match[1])) {
          try {
            fs.unlinkSync(path.join(cacheDir, f));
          } catch {}
        }
      }
    }
  } catch {
    // Non-fatal
  }
}

function resolveDurableAdapter(): DurableKvAdapter | null {
  if (globalForPersistence.__hyperionCustomAdapter !== undefined) {
    return globalForPersistence.__hyperionCustomAdapter;
  }

  // 1. Upstash Redis REST
  const upstashUrl = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (upstashUrl && upstashToken) {
    const base = upstashUrl.replace(/\/+$/, "");
    return {
      kind: "upstash-redis",
      async get(key: string) {
        try {
          const res = await fetch(`${base}/get/${encodeURIComponent(key)}`, {
            headers: { Authorization: `Bearer ${upstashToken}` },
            cache: "no-store",
            signal: AbortSignal.timeout(4000),
          });
          if (!res.ok) return null;
          const json = (await res.json()) as { result?: string | null };
          return typeof json.result === "string" ? json.result : null;
        } catch {
          return null;
        }
      },
      async set(key: string, value: string) {
        try {
          await fetch(base, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${upstashToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(["SET", key, value]),
            cache: "no-store",
            signal: AbortSignal.timeout(4000),
          });
        } catch {
          // Non-fatal durable write fallback
        }
      },
      async listKeys(prefix: string) {
        try {
          const res = await fetch(`${base}/keys/${encodeURIComponent(`${prefix}*`)}`, {
            headers: { Authorization: `Bearer ${upstashToken}` },
            cache: "no-store",
            signal: AbortSignal.timeout(4000),
          });
          if (!res.ok) return [];
          const json = (await res.json()) as { result?: string[] };
          return Array.isArray(json.result) ? json.result : [];
        } catch {
          return [];
        }
      },
    };
  }

  // 2. Turso LibSQL HTTP Pipeline
  const rawTursoUrl =
    process.env.TURSO_DATABASE_URL?.trim() ||
    (process.env.DATABASE_URL?.trim().startsWith("libsql://") ? process.env.DATABASE_URL.trim() : "");
  if (rawTursoUrl) {
    const httpUrl = rawTursoUrl.replace(/^libsql:\/\//i, "https://").replace(/\/+$/, "");
    const tursoToken = process.env.TURSO_AUTH_TOKEN?.trim() || "";
    const execPipeline = async (statements: Array<{ sql: string; args?: Array<{ type: string; value: string }> }>) => {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (tursoToken) headers.Authorization = `Bearer ${tursoToken}`;
      const requests = statements.map((st) => ({
        type: "execute",
        stmt: st.args ? { sql: st.sql, args: st.args } : { sql: st.sql },
      }));
      const res = await fetch(`${httpUrl}/v2/pipeline`, {
        method: "POST",
        headers,
        body: JSON.stringify({ requests: [...requests, { type: "close" }] }),
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return null;
      return (await res.json()) as { results?: Array<{ response?: { result?: { rows?: any[][] } } }> };
    };
    const ensureTursoTable = async () => {
      if (globalForPersistence.__hyperionTursoSchemaReady) return;
      await execPipeline([
        {
          sql: "CREATE TABLE IF NOT EXISTS hyperion_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)",
        },
      ]);
      globalForPersistence.__hyperionTursoSchemaReady = true;
    };
    return {
      kind: "turso-libsql",
      async get(key: string) {
        try {
          await ensureTursoTable();
          const data = await execPipeline([
            {
              sql: "SELECT value FROM hyperion_kv WHERE key = ? LIMIT 1",
              args: [{ type: "text", value: key }],
            },
          ]);
          const val = data?.results?.[0]?.response?.result?.rows?.[0]?.[0]?.value;
          return typeof val === "string" ? val : null;
        } catch {
          return null;
        }
      },
      async set(key: string, value: string) {
        try {
          await ensureTursoTable();
          await execPipeline([
            {
              sql: "INSERT INTO hyperion_kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
              args: [
                { type: "text", value: key },
                { type: "text", value: value },
                { type: "integer", value: String(Date.now()) },
              ],
            },
          ]);
        } catch {}
      },
      async listKeys(prefix: string) {
        try {
          await ensureTursoTable();
          const data = await execPipeline([
            {
              sql: "SELECT key FROM hyperion_kv WHERE key LIKE ? ORDER BY key ASC",
              args: [{ type: "text", value: `${prefix}%` }],
            },
          ]);
          const rows = data?.results?.[0]?.response?.result?.rows ?? [];
          return rows
            .map((r) => r?.[0]?.value)
            .filter((k): k is string => typeof k === "string");
        } catch {
          return [];
        }
      },
    };
  }

  // 3. Generic HTTP KV Proxy or HTTP DATABASE_URL
  const httpKvUrl =
    process.env.HYPERION_DB_HTTP_URL?.trim() ||
    (process.env.DATABASE_URL?.trim().startsWith("http") ? process.env.DATABASE_URL.trim() : "");
  if (httpKvUrl) {
    const base = httpKvUrl.replace(/\/+$/, "");
    const token = process.env.HYPERION_DB_HTTP_TOKEN?.trim() || "";
    const authHeader: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    return {
      kind: "http-kv",
      async get(key: string) {
        try {
          const res = await fetch(`${base}?key=${encodeURIComponent(key)}`, {
            headers: authHeader,
            cache: "no-store",
            signal: AbortSignal.timeout(4000),
          });
          if (!res.ok) return null;
          const json = (await res.json()) as { value?: string | null };
          return typeof json.value === "string" ? json.value : null;
        } catch {
          return null;
        }
      },
      async set(key: string, value: string) {
        try {
          await fetch(base, {
            method: "POST",
            headers: { ...authHeader, "Content-Type": "application/json" },
            body: JSON.stringify({ key, value }),
            cache: "no-store",
            signal: AbortSignal.timeout(4000),
          });
        } catch {}
      },
      async listKeys(prefix: string) {
        try {
          const res = await fetch(`${base}?prefix=${encodeURIComponent(prefix)}`, {
            headers: authHeader,
            cache: "no-store",
            signal: AbortSignal.timeout(4000),
          });
          if (!res.ok) return [];
          const json = (await res.json()) as { keys?: string[] };
          return Array.isArray(json.keys) ? json.keys : [];
        } catch {
          return [];
        }
      },
    };
  }

  // 4. Optional Postgres DATABASE_URL when `pg` is installed at runtime
  const pgUrl = process.env.DATABASE_URL?.trim();
  if (pgUrl && /^postgres(ql)?:\/\//i.test(pgUrl)) {
    let pgPoolPromise: Promise<any | null> | null = null;
    const getPgPool = async () => {
      if (!pgPoolPromise) {
        pgPoolPromise = (async () => {
          try {
            const dynImport = new Function("m", "return import(m)") as (m: string) => Promise<any>;
            const pgMod = await dynImport("pg");
            const PoolCtor = pgMod.Pool || pgMod.default?.Pool;
            if (!PoolCtor) return null;
            const pool = new PoolCtor({ connectionString: pgUrl, max: 3, connectionTimeoutMillis: 3000 });
            await pool.query(
              "CREATE TABLE IF NOT EXISTS hyperion_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at BIGINT NOT NULL)"
            );
            return pool;
          } catch {
            if (!globalForPersistence.__hyperionWarnedPgFallback) {
              globalForPersistence.__hyperionWarnedPgFallback = true;
              console.warn("[PersistenceStore] Postgres DATABASE_URL set without runtime pg driver/connectivity; falling back to local .cache/");
            }
            return null;
          }
        })();
      }
      return pgPoolPromise;
    };
    return {
      kind: "postgres",
      async get(key: string) {
        try {
          const pool = await getPgPool();
          if (!pool) return null;
          const res = await pool.query("SELECT value FROM hyperion_kv WHERE key = $1 LIMIT 1", [key]);
          return typeof res.rows?.[0]?.value === "string" ? res.rows[0].value : null;
        } catch {
          return null;
        }
      },
      async set(key: string, value: string) {
        try {
          const pool = await getPgPool();
          if (!pool) return;
          await pool.query(
            "INSERT INTO hyperion_kv (key, value, updated_at) VALUES ($1, $2, $3) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at",
            [key, value, Date.now()]
          );
        } catch {}
      },
      async listKeys(prefix: string) {
        try {
          const pool = await getPgPool();
          if (!pool) return [];
          const res = await pool.query("SELECT key FROM hyperion_kv WHERE key LIKE $1 ORDER BY key ASC", [`${prefix}%`]);
          return (res.rows ?? []).map((r: any) => String(r.key));
        } catch {
          return [];
        }
      },
    };
  }

  return null;
}

export function getActiveDurableBackendKind(): DurableBackendKind {
  return resolveDurableAdapter()?.kind ?? "local-cache";
}

function scheduleRemoteWrite(key: string, payload: unknown): void {
  const adapter = resolveDurableAdapter();
  if (!adapter) return;
  const serialized = JSON.stringify(payload);
  const pendingSet = getPendingWritesSet();
  const task = adapter
    .set(key, serialized)
    .catch(() => {})
    .finally(() => {
      pendingSet.delete(task);
    });
  pendingSet.add(task);
}

async function writeRemoteNow(key: string, payload: unknown): Promise<void> {
  const adapter = resolveDurableAdapter();
  if (!adapter) return;
  const serialized = JSON.stringify(payload);
  await adapter.set(key, serialized).catch(() => {});
}

// ============================================================================
// SESSION TRADE LEDGER (active-trades-YYYY-MM-DD.json)
// ============================================================================

export function readSessionLedgerSync(sessionDate?: string): DailyTradeStore {
  const today = getTodayEt();
  const targetDate =
    sessionDate && /^\d{4}-\d{2}-\d{2}$/.test(sessionDate) ? sessionDate : today;
  const cacheDir = getPersistenceCacheDir();
  const memMap = getLedgerMemMap();
  const memEntry = memMap.get(targetDate);
  const filePath = path.join(cacheDir, `active-trades-${targetDate}.json`);

  if (memEntry && memEntry.store.date === targetDate) {
    if (fs.existsSync(filePath)) {
      try {
        const stat = fs.statSync(filePath);
        const raw = fs.readFileSync(filePath, "utf-8");
        const parsed = JSON.parse(raw) as DailyTradeStore;
        if (
          parsed &&
          parsed.date === targetDate &&
          parsed.activePositions &&
          (stat.mtimeMs > memEntry.mtimeMs ||
            (parsed.version ?? 0) > (memEntry.store.version ?? 0) ||
            (Array.isArray(parsed.alerts) && parsed.alerts.length > (memEntry.store.alerts?.length ?? 0)))
        ) {
          memMap.set(targetDate, { store: parsed, mtimeMs: stat.mtimeMs });
          return parsed;
        }
      } catch {
        // Ignore transient read race
      }
    }
    return memEntry.store;
  }

  reapStaleFiles(cacheDir, "active-trades-", RETENTION_DAYS);

  if (fs.existsSync(filePath)) {
    try {
      const stat = fs.statSync(filePath);
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as DailyTradeStore;
      if (parsed && parsed.date === targetDate && parsed.activePositions) {
        memMap.set(targetDate, { store: parsed, mtimeMs: stat.mtimeMs });
        return parsed;
      }
    } catch {
      // Malformed file fallback
    }
  }

  const fresh = createEmptySessionLedger(targetDate);
  if (targetDate === today) {
    memMap.set(targetDate, { store: fresh, mtimeMs: 0 });
  }
  return fresh;
}

export function writeSessionLedgerSync(store: DailyTradeStore): void {
  const cacheDir = getPersistenceCacheDir();
  const filePath = path.join(cacheDir, `active-trades-${store.date}.json`);
  store.version = (store.version ?? 0) + 1;
  store.updatedAtMs = Date.now();
  const mtimeMs = atomicWriteJsonSync(filePath, store);
  if (mtimeMs === 0) {
    getLedgerMemMap().delete(store.date);
    throw new Error(`LEDGER_WRITE_FAILED: Failed to atomically write ${filePath}`);
  }
  getLedgerMemMap().set(store.date, { store, mtimeMs });
  scheduleRemoteWrite(`${KEY_PREFIX}ledger:${store.date}`, store);
}

export async function readSessionLedger(sessionDate?: string): Promise<DailyTradeStore> {
  const targetDate =
    sessionDate && /^\d{4}-\d{2}-\d{2}$/.test(sessionDate) ? sessionDate : getTodayEt();
  const cacheDir = getPersistenceCacheDir();
  const filePath = path.join(cacheDir, `active-trades-${targetDate}.json`);
  const local = readSessionLedgerSync(targetDate);

  const hasLocalTrades =
    Object.keys(local.activePositions || {}).length > 0 ||
    (local.closedPositions?.length ?? 0) > 0 ||
    (local.alerts?.length ?? 0) > 0;

  if (!hasLocalTrades && !fs.existsSync(filePath)) {
    const adapter = resolveDurableAdapter();
    if (adapter) {
      const raw = await adapter.get(`${KEY_PREFIX}ledger:${targetDate}`);
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as DailyTradeStore;
          if (parsed && parsed.date === targetDate && parsed.activePositions) {
            const mtimeMs = atomicWriteJsonSync(filePath, parsed);
            getLedgerMemMap().set(targetDate, { store: parsed, mtimeMs });
            return parsed;
          }
        } catch {
          // Ignore malformed remote entry
        }
      }
    }
  }

  return local;
}

export async function writeSessionLedger(store: DailyTradeStore): Promise<void> {
  const cacheDir = getPersistenceCacheDir();
  const filePath = path.join(cacheDir, `active-trades-${store.date}.json`);
  store.version = (store.version ?? 0) + 1;
  store.updatedAtMs = Date.now();
  const mtimeMs = atomicWriteJsonSync(filePath, store);
  if (mtimeMs === 0) {
    getLedgerMemMap().delete(store.date);
    throw new Error(`LEDGER_WRITE_FAILED: Failed to atomically write ${filePath}`);
  }
  getLedgerMemMap().set(store.date, { store, mtimeMs });
  await writeRemoteNow(`${KEY_PREFIX}ledger:${store.date}`, store);
}

// ============================================================================
// INTRADAY SNAPSHOT STORE (intraday-YYYY-MM-DD.json)
// ============================================================================

export function readIntradayStoreSync(sessionDate?: string): DailyStore {
  const today = getTodayEt();
  const targetDate =
    sessionDate && /^\d{4}-\d{2}-\d{2}$/.test(sessionDate) ? sessionDate : today;
  const cacheDir = getPersistenceCacheDir();
  const memMap = getIntradayMemMap();
  const memEntry = memMap.get(targetDate);
  const filePath = path.join(cacheDir, `intraday-${targetDate}.json`);

  if (memEntry && memEntry.store.date === targetDate) {
    if (fs.existsSync(filePath)) {
      try {
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs > memEntry.mtimeMs) {
          const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as DailyStore;
          if (parsed && parsed.date === targetDate && parsed.tickers) {
            memMap.set(targetDate, { store: parsed, mtimeMs: stat.mtimeMs });
            return parsed;
          }
        }
      } catch {}
    }
    return memEntry.store;
  }

  reapStaleFiles(cacheDir, "intraday-", RETENTION_DAYS);

  if (fs.existsSync(filePath)) {
    try {
      const stat = fs.statSync(filePath);
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as DailyStore;
      if (parsed && parsed.date === targetDate && parsed.tickers) {
        memMap.set(targetDate, { store: parsed, mtimeMs: stat.mtimeMs });
        return parsed;
      }
    } catch {}
  }

  const fresh: DailyStore = { date: targetDate, tickers: {} };
  if (targetDate === today) {
    memMap.set(targetDate, { store: fresh, mtimeMs: 0 });
  }
  return fresh;
}

export function appendIntradaySnapshotSync(date: string, store: DailyStore): void {
  const cacheDir = getPersistenceCacheDir();
  const filePath = path.join(cacheDir, `intraday-${date}.json`);
  const mtimeMs = atomicWriteJsonSync(filePath, store);
  getIntradayMemMap().set(date, { store, mtimeMs });
  scheduleRemoteWrite(`${KEY_PREFIX}intraday:${date}`, store);
}

export async function appendIntradaySnapshot(date: string, store: DailyStore): Promise<void> {
  const cacheDir = getPersistenceCacheDir();
  const filePath = path.join(cacheDir, `intraday-${date}.json`);
  const mtimeMs = atomicWriteJsonSync(filePath, store);
  getIntradayMemMap().set(date, { store, mtimeMs });
  await writeRemoteNow(`${KEY_PREFIX}intraday:${date}`, store);
}

// ============================================================================
// SUPERVISOR POLICY, ALPHA PRIORS & POST-MORTEM ATTRIBUTION
// ============================================================================

export function readSupervisorPolicySync(
  sessionDate?: string,
  ticker: string = "SPY"
): SessionPlaybookPolicy | null {
  const targetDate =
    sessionDate && /^\d{4}-\d{2}-\d{2}$/.test(sessionDate) ? sessionDate : getTodayEt();
  const sym = ticker.trim().toUpperCase();
  const memKey = `${targetDate}:${sym}`;
  const cached = getPolicyMemMap().get(memKey);
  if (cached) return cached;

  const cacheDir = getPersistenceCacheDir();
  const filePath = path.join(cacheDir, `supervisor-policy-${targetDate}-${sym}.json`);
  if (fs.existsSync(filePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as SessionPlaybookPolicy;
      if (parsed && parsed.sessionDate === targetDate) {
        getPolicyMemMap().set(memKey, parsed);
        return parsed;
      }
    } catch {}
  }
  return null;
}

export function writeSupervisorPolicySync(policy: SessionPlaybookPolicy): void {
  const sym = policy.ticker.trim().toUpperCase();
  const cacheDir = getPersistenceCacheDir();
  reapStaleFiles(cacheDir, "supervisor-policy-", RETENTION_DAYS);
  const filePath = path.join(cacheDir, `supervisor-policy-${policy.sessionDate}-${sym}.json`);
  atomicWriteJsonSync(filePath, policy);
  getPolicyMemMap().set(`${policy.sessionDate}:${sym}`, policy);
  scheduleRemoteWrite(`${KEY_PREFIX}policy:${policy.sessionDate}:${sym}`, policy);
}

export async function readSupervisorPolicy(
  sessionDate?: string,
  ticker: string = "SPY"
): Promise<SessionPlaybookPolicy | null> {
  const targetDate =
    sessionDate && /^\d{4}-\d{2}-\d{2}$/.test(sessionDate) ? sessionDate : getTodayEt();
  const sym = ticker.trim().toUpperCase();
  const local = readSupervisorPolicySync(targetDate, sym);
  if (local) return local;

  const adapter = resolveDurableAdapter();
  if (adapter) {
    const raw = await adapter.get(`${KEY_PREFIX}policy:${targetDate}:${sym}`);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as SessionPlaybookPolicy;
        if (parsed && parsed.sessionDate === targetDate) {
          const filePath = path.join(getPersistenceCacheDir(), `supervisor-policy-${targetDate}-${sym}.json`);
          atomicWriteJsonSync(filePath, parsed);
          getPolicyMemMap().set(`${targetDate}:${sym}`, parsed);
          return parsed;
        }
      } catch {}
    }
  }
  return null;
}

export async function writeSupervisorPolicy(policy: SessionPlaybookPolicy): Promise<void> {
  const sym = policy.ticker.trim().toUpperCase();
  const cacheDir = getPersistenceCacheDir();
  reapStaleFiles(cacheDir, "supervisor-policy-", RETENTION_DAYS);
  const filePath = path.join(cacheDir, `supervisor-policy-${policy.sessionDate}-${sym}.json`);
  atomicWriteJsonSync(filePath, policy);
  getPolicyMemMap().set(`${policy.sessionDate}:${sym}`, policy);
  await writeRemoteNow(`${KEY_PREFIX}policy:${policy.sessionDate}:${sym}`, policy);
}

export function readAlphaPriorsSync(): AlphaPriorsState {
  if (globalForPersistence.__hyperionPriorsMemCache) {
    return globalForPersistence.__hyperionPriorsMemCache;
  }
  const filePath = path.join(getPersistenceCacheDir(), "alpha-priors.json");
  if (fs.existsSync(filePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as AlphaPriorsState;
      if (parsed && parsed.regimeStats) {
        globalForPersistence.__hyperionPriorsMemCache = parsed;
        return parsed;
      }
    } catch {}
  }
  const def = cloneDefaultAlphaPriors();
  globalForPersistence.__hyperionPriorsMemCache = def;
  return def;
}

export function writeAlphaPriorsSync(priors: AlphaPriorsState): void {
  const filePath = path.join(getPersistenceCacheDir(), "alpha-priors.json");
  atomicWriteJsonSync(filePath, priors);
  globalForPersistence.__hyperionPriorsMemCache = priors;
  scheduleRemoteWrite(`${KEY_PREFIX}alpha-priors`, priors);
}

export async function readAlphaPriors(): Promise<AlphaPriorsState> {
  const filePath = path.join(getPersistenceCacheDir(), "alpha-priors.json");
  if (fs.existsSync(filePath) || globalForPersistence.__hyperionPriorsMemCache) {
    return readAlphaPriorsSync();
  }
  const adapter = resolveDurableAdapter();
  if (adapter) {
    const raw = await adapter.get(`${KEY_PREFIX}alpha-priors`);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as AlphaPriorsState;
        if (parsed && parsed.regimeStats) {
          atomicWriteJsonSync(filePath, parsed);
          globalForPersistence.__hyperionPriorsMemCache = parsed;
          return parsed;
        }
      } catch {}
    }
  }
  return readAlphaPriorsSync();
}

export async function writeAlphaPriors(priors: AlphaPriorsState): Promise<void> {
  const filePath = path.join(getPersistenceCacheDir(), "alpha-priors.json");
  atomicWriteJsonSync(filePath, priors);
  globalForPersistence.__hyperionPriorsMemCache = priors;
  await writeRemoteNow(`${KEY_PREFIX}alpha-priors`, priors);
}

export async function readPostMarketAttribution(
  sessionDate?: string,
  ticker: string = "SPY"
): Promise<PostMarketAttributionReport | null> {
  const targetDate =
    sessionDate && /^\d{4}-\d{2}-\d{2}$/.test(sessionDate) ? sessionDate : getTodayEt();
  const sym = ticker.trim().toUpperCase();
  const filePath = path.join(getPersistenceCacheDir(), `post-mortem-${targetDate}-${sym}.json`);
  if (fs.existsSync(filePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as PostMarketAttributionReport;
      if (parsed && parsed.sessionDate === targetDate) return parsed;
    } catch {}
  }
  const adapter = resolveDurableAdapter();
  if (adapter) {
    const raw = await adapter.get(`${KEY_PREFIX}post-mortem:${targetDate}:${sym}`);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as PostMarketAttributionReport;
        if (parsed && parsed.sessionDate === targetDate) {
          atomicWriteJsonSync(filePath, parsed);
          return parsed;
        }
      } catch {}
    }
  }
  return null;
}

export async function writePostMarketAttribution(report: PostMarketAttributionReport): Promise<void> {
  const sym = report.ticker.trim().toUpperCase();
  const cacheDir = getPersistenceCacheDir();
  reapStaleFiles(cacheDir, "post-mortem-", RETENTION_DAYS);
  const filePath = path.join(cacheDir, `post-mortem-${report.sessionDate}-${sym}.json`);
  atomicWriteJsonSync(filePath, report);
  await writeRemoteNow(`${KEY_PREFIX}post-mortem:${report.sessionDate}:${sym}`, report);
}

// ============================================================================
// HISTORICAL SESSIONS & COLD-START BOOT HYDRATION
// ============================================================================

export async function hydratePersistenceOnBoot(): Promise<{
  hydratedKeys: number;
  backend: DurableBackendKind;
}> {
  if (globalForPersistence.__hyperionBootHydrated) {
    return { hydratedKeys: 0, backend: getActiveDurableBackendKind() };
  }
  if (globalForPersistence.__hyperionHydratePromise) {
    return globalForPersistence.__hyperionHydratePromise;
  }

  const task = (async () => {
    const adapter = resolveDurableAdapter();
    if (!adapter) {
      globalForPersistence.__hyperionBootHydrated = true;
      return { hydratedKeys: 0, backend: "local-cache" as DurableBackendKind };
    }

    const cacheDir = getPersistenceCacheDir();
    let hydratedKeys = 0;

    // 1. Hydrate alpha-priors if missing locally
    const priorsPath = path.join(cacheDir, "alpha-priors.json");
    if (!fs.existsSync(priorsPath)) {
      const rawPriors = await adapter.get(`${KEY_PREFIX}alpha-priors`);
      if (rawPriors) {
        try {
          const parsed = JSON.parse(rawPriors) as AlphaPriorsState;
          if (parsed && parsed.regimeStats) {
            atomicWriteJsonSync(priorsPath, parsed);
            globalForPersistence.__hyperionPriorsMemCache = parsed;
            hydratedKeys++;
          }
        } catch {}
      }
    }

    // 2. Hydrate missing session ledgers, intraday files, policies, and post-mortem reports
    const remoteKeys = await adapter.listKeys(KEY_PREFIX);
    for (const fullKey of remoteKeys) {
      if (!fullKey.startsWith(KEY_PREFIX)) continue;
      const rel = fullKey.slice(KEY_PREFIX.length);
      if (rel.startsWith("ledger:")) {
        const date = rel.slice("ledger:".length);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
        const target = path.join(cacheDir, `active-trades-${date}.json`);
        if (!fs.existsSync(target)) {
          const raw = await adapter.get(fullKey);
          if (raw) {
            try {
              const parsed = JSON.parse(raw) as DailyTradeStore;
              if (parsed && parsed.date === date) {
                const mtimeMs = atomicWriteJsonSync(target, parsed);
                getLedgerMemMap().set(date, { store: parsed, mtimeMs });
                hydratedKeys++;
              }
            } catch {}
          }
        }
      } else if (rel.startsWith("intraday:")) {
        const date = rel.slice("intraday:".length);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
        const target = path.join(cacheDir, `intraday-${date}.json`);
        if (!fs.existsSync(target)) {
          const raw = await adapter.get(fullKey);
          if (raw) {
            try {
              const parsed = JSON.parse(raw) as DailyStore;
              if (parsed && parsed.date === date) {
                const mtimeMs = atomicWriteJsonSync(target, parsed);
                getIntradayMemMap().set(date, { store: parsed, mtimeMs });
                hydratedKeys++;
              }
            } catch {}
          }
        }
      } else if (rel.startsWith("policy:")) {
        const rest = rel.slice("policy:".length);
        const [date, sym = "SPY"] = rest.split(":");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
        const target = path.join(cacheDir, `supervisor-policy-${date}-${sym.toUpperCase()}.json`);
        if (!fs.existsSync(target)) {
          const raw = await adapter.get(fullKey);
          if (raw) {
            try {
              const parsed = JSON.parse(raw) as SessionPlaybookPolicy;
              if (parsed && parsed.sessionDate === date) {
                atomicWriteJsonSync(target, parsed);
                getPolicyMemMap().set(`${date}:${sym.toUpperCase()}`, parsed);
                hydratedKeys++;
              }
            } catch {}
          }
        }
      } else if (rel.startsWith("post-mortem:")) {
        const rest = rel.slice("post-mortem:".length);
        const [date, sym = "SPY"] = rest.split(":");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
        const target = path.join(cacheDir, `post-mortem-${date}-${sym.toUpperCase()}.json`);
        if (!fs.existsSync(target)) {
          const raw = await adapter.get(fullKey);
          if (raw) {
            try {
              const parsed = JSON.parse(raw) as PostMarketAttributionReport;
              if (parsed && parsed.sessionDate === date) {
                atomicWriteJsonSync(target, parsed);
                hydratedKeys++;
              }
            } catch {}
          }
        }
      }
    }

    globalForPersistence.__hyperionBootHydrated = true;
    return { hydratedKeys, backend: adapter.kind };
  })().finally(() => {
    globalForPersistence.__hyperionHydratePromise = null;
  });

  globalForPersistence.__hyperionHydratePromise = task;
  return task;
}

export async function readHistoricalSessions(limitDays: number = 7): Promise<DailyTradeStore[]> {
  await hydratePersistenceOnBoot();

  const cacheDir = getPersistenceCacheDir();
  const byDate = new Map<string, DailyTradeStore>();

  if (fs.existsSync(cacheDir)) {
    const files = fs
      .readdirSync(cacheDir)
      .filter((f) => /^active-trades-\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort()
      .slice(-Math.max(1, limitDays));

    for (const file of files) {
      const fileDate = file.slice("active-trades-".length, "active-trades-".length + 10);
      try {
        const parsed = JSON.parse(
          fs.readFileSync(path.join(cacheDir, file), "utf-8")
        ) as DailyTradeStore;
        if (parsed && parsed.activePositions) {
          byDate.set(fileDate, { ...parsed, date: parsed.date || fileDate });
        }
      } catch {
        // Skip malformed session file
      }
    }
  }

  return Array.from(byDate.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-Math.max(1, limitDays))
    .map(([, store]) => store);
}
