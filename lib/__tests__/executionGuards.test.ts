import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import {
  EARLY_CLOSES_2026,
  capExitTsToEodFlat,
  getSessionBoundsEt,
  isAtOrPastEodFlat,
  isWithinEntryWindow,
} from "../gaiaSessionGuards";
import {
  computeTaylorNetPayoff,
  resolveMinOptionDelta,
} from "../positionSizer";
import { reanchorDelayedContractsToSpot } from "../execution/optionPricing";
import {
  isAlertDispatchEligible,
  sendDiscordTradeAlert,
  syncGaiaTickerSignalsToDiscord,
} from "../execution/discordGateway";
import {
  loadTradeStore,
  purgeZombieToClosed,
  saveTradeStore,
} from "../execution/ledgerCommit";
import {
  acquireCrossProcessExecutionLease,
  isExecutionLeader,
  releaseCrossProcessExecutionLease,
} from "../executionLease";
import { resetPersistenceMemCachesForTests } from "../persistenceStore";
import { GET as getSignalsRoute, POST as postSignalsRoute } from "../../app/api/signals/route";
import type { OptionTradePosition } from "../execution/types";

const tempCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "hyperion-guards-test-"));
const prevCacheEnv = process.env.HYPERION_CACHE_DIR;
const prevAdminToken = process.env.HYPERION_ADMIN_TOKEN;
const prevExecRole = process.env.HYPERION_EXECUTION_ROLE;

process.env.HYPERION_CACHE_DIR = tempCacheDir;

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
  if (prevAdminToken === undefined) delete process.env.HYPERION_ADMIN_TOKEN;
  else process.env.HYPERION_ADMIN_TOKEN = prevAdminToken;
  if (prevExecRole === undefined) delete process.env.HYPERION_EXECUTION_ROLE;
  else process.env.HYPERION_EXECUTION_ROLE = prevExecRole;
});

after(() => {
  resetPersistenceMemCachesForTests();
  if (prevCacheEnv === undefined) delete process.env.HYPERION_CACHE_DIR;
  else process.env.HYPERION_CACHE_DIR = prevCacheEnv;
  if (prevAdminToken === undefined) delete process.env.HYPERION_ADMIN_TOKEN;
  else process.env.HYPERION_ADMIN_TOKEN = prevAdminToken;
  if (prevExecRole === undefined) delete process.env.HYPERION_EXECUTION_ROLE;
  else process.env.HYPERION_EXECUTION_ROLE = prevExecRole;
  try {
    fs.rmSync(tempCacheDir, { recursive: true, force: true });
  } catch {}
});

test("EARLY_CLOSES_2026 enforces 11:30 ET entry cutoff, 12:55 ET MOC flat, and caps post-close timestamps", () => {
  assert.equal(EARLY_CLOSES_2026["2026-11-27"], 780);
  const blackFriday = getSessionBoundsEt("2026-11-27");
  assert.equal(blackFriday.isEarlyClose, true);
  assert.equal(blackFriday.entryStartMins, 575);
  assert.equal(blackFriday.entryCutoffMins, 690); // 11:30 ET
  assert.equal(blackFriday.eodFlatMins, 775); // 12:55 ET
  assert.equal(blackFriday.rthCloseMins, 780); // 13:00 ET

  assert.equal(isWithinEntryWindow(690, "2026-11-27"), true);
  assert.equal(isWithinEntryWindow(691, "2026-11-27"), false);
  assert.equal(isAtOrPastEodFlat(775, "2026-11-27"), true);

  const regularDay = getSessionBoundsEt("2026-11-17");
  assert.equal(regularDay.isEarlyClose, false);
  assert.equal(regularDay.entryCutoffMins, 870);
  assert.equal(regularDay.eodFlatMins, 955);

  // Cap 13:20 ET on early close down to exact 12:55:00 ET (17:55:00 UTC in EST)
  const earlyClosePostTs = Math.floor(Date.parse("2026-11-27T18:20:00Z") / 1000);
  const earlyCloseTargetTs = Math.floor(Date.parse("2026-11-27T17:55:00Z") / 1000);
  const earlyCap = capExitTsToEodFlat(earlyClosePostTs, "2026-11-27");
  assert.equal(earlyCap.capped, true);
  assert.equal(earlyCap.ts, earlyCloseTargetTs);

  // Inside regular RTH (11:15 ET) remains uncapped
  const insideRthTs = Math.floor(Date.parse("2026-11-17T16:15:00Z") / 1000);
  const uncapped = capExitTsToEodFlat(insideRthTs, "2026-11-17");
  assert.equal(uncapped.capped, false);
  assert.equal(uncapped.ts, insideRthTs);
});

test("resolveMinOptionDelta and computeTaylorNetPayoff enforce regime floor, NetEV > 0, and 0.22 spread-to-edge veto", () => {
  assert.equal(resolveMinOptionDelta({ regime: "NEG_GAMMA_TREND", etMins: 800 }), 0.24);
  assert.equal(resolveMinOptionDelta({ regime: "POS_GAMMA_PIN", absImpulsePeclet: 2.0 }), 0.24);
  assert.equal(resolveMinOptionDelta({ regime: "POS_GAMMA_PIN", absImpulsePeclet: 0.7 }), 0.35);

  const wideSpread = computeTaylorNetPayoff({
    absDelta: 0.36,
    gamma: 0.05,
    dailyTheta: -0.1,
    bid: 0.54,
    ask: 0.7, // spread = $0.16; edge ~ 0.36*1.0 + 0.025 = $0.385 -> ratio ~0.416 > 0.22
    expectedUnderlyingMove: 1.0,
    minDelta: 0.35,
  });
  assert.equal(wideSpread.allowed, false);
  assert.equal(wideSpread.rejectionReason, "SPREAD_TO_EDGE_VETO");

  const thetaCrushed = computeTaylorNetPayoff({
    absDelta: 0.36,
    gamma: 0.04,
    dailyTheta: -1.8, // thetaDrag over 30m = $0.138 > edge ($0.073)
    bid: 0.64,
    ask: 0.65,
    expectedUnderlyingMove: 0.2,
    minDelta: 0.35,
  });
  assert.equal(thetaCrushed.allowed, false);
  assert.equal(thetaCrushed.rejectionReason, "NEGATIVE_NET_EV");

  const validConvex = computeTaylorNetPayoff({
    absDelta: 0.38,
    gamma: 0.05,
    dailyTheta: -0.12,
    bid: 0.78,
    ask: 0.8,
    expectedUnderlyingMove: 2.5,
    minDelta: 0.35,
  });
  assert.equal(validConvex.allowed, true);
  assert.ok(validConvex.netEvPerDollarAsk > 1.0);
  assert.ok(validConvex.spreadToEdgeRatio < 0.05);
});

test("reanchorDelayedContractsToSpot shifts delayed quotes & greeks toward live underlying spot", () => {
  const nowMs = Date.parse("2026-11-17T15:00:00Z"); // 10:00 AM ET
  const delayedChain = [
    {
      symbol: "SPY261118C00757000",
      strike: 757,
      expiration: "2026-11-18",
      optionType: "C" as const,
      bid: 0.62,
      ask: 0.64,
      last: 0.63,
      volume: 10_000,
      openInterest: 8_000,
      iv: 0.16,
      delta: 0.32,
      gamma: 0.04,
      vega: 0.08,
      percentChange: 0,
    },
  ];

  const shifted = reanchorDelayedContractsToSpot({
    contracts: delayedChain,
    referenceSpot: 755.0,
    liveSpot: 756.8,
    nowMs,
  });

  assert.equal(shifted.length, 1);
  assert.ok((shifted[0].ask ?? 0) > delayedChain[0].ask, `Expected call ask (${shifted[0].ask}) to increase when spot rallies +$1.80`);
  assert.ok(shifted[0].delta > delayedChain[0].delta, `Expected call delta (${shifted[0].delta}) to shift higher toward ATM`);
});

test("originBackfill STC Discord firewall blocks backfill alerts & purgeZombieToClosed preserves audit trail", async () => {
  const realNowTs = Math.floor(Date.parse("2026-11-17T16:15:00Z") / 1000); // 11:15 ET
  const rthBounds = getSessionBoundsEt("2026-11-17");

  const backfillPos: OptionTradePosition = {
    id: "gaia-spy-backfill-stc-1",
    ticker: "SPY",
    contractType: "CALL",
    contractLabel: "SPY 261117 757C",
    strike: 757,
    expiration: "2026-11-17",
    setupName: "Gaia Tactical HUD [LONG]",
    status: "OPEN",
    btoSpotPrice: 755.0,
    btoOptionMid: 0.72,
    optionBid: 0.7,
    optionAsk: 0.72,
    contractsQty: 1,
    remainingQty: 1,
    totalOutlay: 72,
    target1Spot: 757.5,
    target2Spot: 759.5,
    stopLossSpot: 753.8,
    openedAt: "10:00 AM",
    openedTs: realNowTs - 4500,
    originBackfill: true,
  };

  assert.equal(
    isAlertDispatchEligible(
      {
        id: "hist-1",
        timestamp: "10:00 AM",
        ts: realNowTs,
        ticker: "SPY",
        action: "SELL_TO_CLOSE",
        contractType: "CALL",
        contractLabel: backfillPos.contractLabel,
        strike: 757,
        expiration: "2026-11-17",
        setupName: backfillPos.setupName,
        reason: "Test",
        status: "CLOSED",
        spotPrice: 754,
        btoSpotPrice: 755,
        target1Spot: 757.5,
        target2Spot: 759.5,
        stopLossSpot: 753.8,
        optionMid: 0.5,
        btoOptionMid: 0.72,
        contractsQty: 1,
        remainingQty: 0,
        totalOutlay: 72,
        isHistoricalBackfill: true,
        message: "test",
      },
      realNowTs,
      rthBounds
    ),
    false
  );

  // Intercept global.fetch to assert Discord is NEVER called for originBackfill STC transitions
  let webhookHits = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    webhookHits++;
    return new Response(JSON.stringify({ id: "msg-1" }), { status: 200 });
  }) as typeof fetch;

  try {
    const directSent = await sendDiscordTradeAlert(
      {
        id: "hist-direct",
        timestamp: "11:15 AM",
        ts: realNowTs,
        ticker: "SPY",
        action: "SELL_TO_CLOSE",
        contractType: "CALL",
        contractLabel: backfillPos.contractLabel,
        strike: 757,
        expiration: "2026-11-17",
        setupName: backfillPos.setupName,
        reason: "Historical STC",
        status: "CLOSED",
        spotPrice: 753.5,
        btoSpotPrice: 755,
        target1Spot: 757.5,
        target2Spot: 759.5,
        stopLossSpot: 753.8,
        optionMid: 0.45,
        btoOptionMid: 0.72,
        contractsQty: 1,
        remainingQty: 0,
        totalOutlay: 72,
        isHistoricalBackfill: true,
        message: "blocked",
      },
      "https://discord.com/api/webhooks/test/token"
    );
    assert.equal(directSent, false);
    assert.equal(webhookHits, 0);

    // Save originBackfill active position and trigger STAND_ASIDE consistency exit
    const store = loadTradeStore("2026-11-17");
    store.date = "2026-11-17";
    store.activePositions = { SPY: { ...backfillPos } };
    store.closedPositions = [];
    store.alerts = [];
    saveTradeStore(store);

    await syncGaiaTickerSignalsToDiscord({
      ticker: "SPY",
      spotPrice: 753.5,
      sessionDate: "2026-11-17",
      activeFsmState: "STAND_ASIDE",
      macroRegime: "PUT",
      chiPct: 35,
      zeroGamma: 756,
      webhookUrl: "https://discord.com/api/webhooks/test/token",
      isHistoricalBackfill: false,
      signals: [],
    });
    assert.equal(webhookHits, 0, "originBackfill position STC must NEVER hit Discord webhook");

    // Verify purgeZombieToClosed preserves zombie positions inside closedPositions
    const zStore = loadTradeStore("2026-11-17");
    zStore.activePositions = { SPY: { ...backfillPos, id: "zombie-spy-1" } };
    const purged = purgeZombieToClosed(
      zStore,
      "SPY",
      "ZOMBIE_AUDIT_TEST",
      754.0,
      new Date("2026-11-17T18:20:00Z")
    );
    assert.ok(purged);
    assert.equal(purged.status, "CLOSED");
    assert.equal(zStore.activePositions.SPY, undefined);
    assert.ok(zStore.closedPositions.some((p) => p.id === "zombie-spy-1"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("/api/signals clear endpoints require HYPERION_ADMIN_TOKEN when configured", async () => {
  process.env.HYPERION_ADMIN_TOKEN = "super-secret-admin-token-42";

  const unauthGet = await getSignalsRoute(
    new NextRequest("http://localhost:3000/api/signals?action=clear")
  );
  assert.equal(unauthGet.status, 401);

  const wrongPost = await postSignalsRoute(
    new NextRequest("http://localhost:3000/api/signals", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-hyperion-admin-token": "wrong-token",
      },
      body: JSON.stringify({ action: "clear" }),
    })
  );
  assert.equal(wrongPost.status, 401);

  const validPost = await postSignalsRoute(
    new NextRequest("http://localhost:3000/api/signals", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-hyperion-admin-token": "super-secret-admin-token-42",
      },
      body: JSON.stringify({ action: "clear" }),
    })
  );
  assert.equal(validPost.status, 200);
});

test("cross-process execution lease guarantees mutual exclusion and observer role safety", () => {
  const baseNow = Date.now();
  const resA = acquireCrossProcessExecutionLease({
    instanceId: "worker-alpha",
    ttlMs: 30_000,
    nowMs: baseNow,
    forceRole: "leader",
  });
  assert.equal(resA.acquired, true);
  assert.equal(resA.holderInstanceId, "worker-alpha");
  assert.equal(isExecutionLeader({ instanceId: "worker-alpha", nowMs: baseNow + 1000 }), true);

  const resB = acquireCrossProcessExecutionLease({
    instanceId: "worker-beta",
    ttlMs: 30_000,
    nowMs: baseNow + 1000,
    forceRole: "auto",
  });
  assert.equal(resB.acquired, false);
  assert.equal(resB.holderInstanceId, "worker-alpha");

  const observer = acquireCrossProcessExecutionLease({
    instanceId: "worker-observer",
    nowMs: baseNow + 1000,
    forceRole: "observer",
  });
  assert.equal(observer.acquired, false);

  assert.equal(releaseCrossProcessExecutionLease("worker-beta"), false);
  assert.equal(releaseCrossProcessExecutionLease("worker-alpha"), true);

  const resBAfterRelease = acquireCrossProcessExecutionLease({
    instanceId: "worker-beta",
    ttlMs: 30_000,
    nowMs: baseNow + 2000,
    forceRole: "auto",
  });
  assert.equal(resBAfterRelease.acquired, true);
  assert.equal(resBAfterRelease.holderInstanceId, "worker-beta");
  releaseCrossProcessExecutionLease("worker-beta");
});
