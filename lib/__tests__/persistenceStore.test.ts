import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DurableKvAdapter,
  appendIntradaySnapshot,
  cloneDefaultAlphaPriors,
  createEmptySessionLedger,
  hydratePersistenceOnBoot,
  readAlphaPriors,
  readHistoricalSessions,
  readIntradayStoreSync,
  readSessionLedger,
  readSupervisorPolicy,
  resetPersistenceMemCachesForTests,
  setDurableBackendAdapterForTests,
  writeAlphaPriors,
  writeSessionLedger,
  writeSupervisorPolicy,
} from "../persistenceStore";

const tempCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "hyperion-persist-test-"));
const prevCacheEnv = process.env.HYPERION_CACHE_DIR;
process.env.HYPERION_CACHE_DIR = tempCacheDir;

function createInMemoryKvAdapter(): { adapter: DurableKvAdapter; map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    adapter: {
      kind: "http-kv",
      async get(key: string) {
        return map.get(key) ?? null;
      },
      async set(key: string, value: string) {
        map.set(key, value);
      },
      async listKeys(prefix: string) {
        return Array.from(map.keys()).filter((k) => k.startsWith(prefix));
      },
    },
  };
}

function clearTempDir() {
  if (!fs.existsSync(tempCacheDir)) {
    fs.mkdirSync(tempCacheDir, { recursive: true });
    return;
  }
  for (const entry of fs.readdirSync(tempCacheDir)) {
    fs.rmSync(path.join(tempCacheDir, entry), { recursive: true, force: true });
  }
}

beforeEach(() => {
  clearTempDir();
  resetPersistenceMemCachesForTests();
  setDurableBackendAdapterForTests(null);
});

after(() => {
  setDurableBackendAdapterForTests(null);
  resetPersistenceMemCachesForTests();
  if (prevCacheEnv === undefined) delete process.env.HYPERION_CACHE_DIR;
  else process.env.HYPERION_CACHE_DIR = prevCacheEnv;
  try {
    fs.rmSync(tempCacheDir, { recursive: true, force: true });
  } catch {}
});

test("persistenceStore writes session ledgers atomically and reads multi-day history", async () => {
  const day1 = createEmptySessionLedger("2026-11-12");
  day1.closedPositions.push({
    id: "SPY-CALL-1",
    ticker: "SPY",
    contractType: "CALL",
    contractLabel: "SPY 758C",
    strike: 758,
    expiration: "2026-11-12",
    setupName: "Support Bounce",
    status: "CLOSED",
    btoSpotPrice: 755,
    btoOptionMid: 0.65,
    optionAsk: 0.65,
    contractsQty: 1,
    remainingQty: 0,
    totalOutlay: 65,
    target1Spot: 758,
    target2Spot: 760,
    stopLossSpot: 753.5,
    openedAt: "9:35 AM",
    openedTs: 1794494100,
    closedAt: "10:15 AM",
    closedTs: 1794496500,
    closedSpotPrice: 758.2,
    closedOptionMid: 1.45,
    exitReason: "TARGET 1 PROFIT SECURED",
    pnlSpotPct: 0.42,
    pnlOptionPct: 123.1,
    rrRatio: 2.0,
  });

  const day2 = createEmptySessionLedger("2026-11-13");
  day2.prevSpotPrices = { SPY: 754.25 };

  await writeSessionLedger(day1);
  await writeSessionLedger(day2);

  resetPersistenceMemCachesForTests();
  const sessions = await readHistoricalSessions(5);
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].date, "2026-11-12");
  assert.equal(sessions[0].closedPositions[0].id, "SPY-CALL-1");
  assert.equal(sessions[1].date, "2026-11-13");
});

test("hydratePersistenceOnBoot restores wiped .cache/ ledgers, intraday, policies, and priors from durable KV", async () => {
  const { adapter, map } = createInMemoryKvAdapter();
  setDurableBackendAdapterForTests(adapter);

  const ledger = createEmptySessionLedger("2026-11-13");
  ledger.prevSpotPrices = { SPY: 754.25 };
  await writeSessionLedger(ledger);

  await appendIntradaySnapshot("2026-11-13", {
    date: "2026-11-13",
    tickers: {
      SPY: {
        history: [
          {
            t: "09:35 AM",
            ts: 1794580500,
            time: "9:35 AM",
            spot: 756.92,
            cw: 764,
            pw: 750,
            zg: 757.5,
            callWall: 764,
            putWall: 750,
            zeroGamma: 757.5,
          },
        ],
        alerts: [],
      },
    },
  });

  const priors = cloneDefaultAlphaPriors();
  priors.lastAttributionDate = "2026-11-13";
  priors.featureWeights.fluxAlignment = 1.15;
  await writeAlphaPriors(priors);

  await writeSupervisorPolicy({
    sessionDate: "2026-11-13",
    ticker: "SPY",
    checkpoint: "OPEN_0935",
    evaluatedAtEt: "9:35 AM",
    evaluatedAtTs: 1794580500,
    regime: "NEG_GAMMA_TREND",
    allowedRegimes: ["NEG_GAMMA_TREND"],
    preferredDte: "0DTE",
    minExpectancyR: 0.35,
    minWinRatePct: 58,
    standAsideVetoReason: null,
    kingDivergencePct: 0.1,
    trailing5dDrawdownDollars: 0,
    trailing5dPnlDollars: 120,
    zeroGammaSide: "BELOW",
    wallCorridorPct: 1.85,
    absPeclet: 2.1,
    summary: "NEG_GAMMA_TREND",
  });

  assert.ok(map.size >= 4, "Durable KV should store ledger, intraday, priors, and policy");

  // Simulate container cold start: wipe local .cache/ files & memory caches
  clearTempDir();
  resetPersistenceMemCachesForTests();

  const hydration = await hydratePersistenceOnBoot();
  assert.equal(hydration.backend, "http-kv");
  assert.ok(hydration.hydratedKeys >= 4);

  const restoredLedger = await readSessionLedger("2026-11-13");
  assert.equal(restoredLedger.prevSpotPrices?.SPY, 754.25);

  const restoredIntraday = readIntradayStoreSync("2026-11-13");
  assert.equal(restoredIntraday.tickers.SPY?.history.length, 1);

  const restoredPriors = await readAlphaPriors();
  assert.equal(restoredPriors.lastAttributionDate, "2026-11-13");
  assert.equal(restoredPriors.featureWeights.fluxAlignment, 1.15);

  const restoredPolicy = await readSupervisorPolicy("2026-11-13", "SPY");
  assert.equal(restoredPolicy?.regime, "NEG_GAMMA_TREND");
});
