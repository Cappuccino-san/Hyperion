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
import { evaluateBtoCandidateSetup } from "../execution/signalScoring";
import { selectSmallAccountContract } from "../execution/contractRouter";
import { GaiaSignalFsm, computeCausalEquilibriumDispersion, type GaiaBarData } from "../gaiaSignalFsm";
import { GET as getSignalsRoute, POST as postSignalsRoute } from "../../app/api/signals/route";
import { POST as postDiscordRoute } from "../../app/api/discord/route";
import { authorizeAdminRequest } from "../adminAuth";
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

test("authorizeAdminRequest fails closed in production even with spoofed loopback headers", () => {
  const prevNodeEnv = process.env.NODE_ENV;
  delete process.env.HYPERION_ADMIN_TOKEN;
  (process.env as Record<string, string | undefined>).NODE_ENV = "production";
  try {
    const spoofedReq = new NextRequest("http://localhost:3000/api/signals", {
      headers: {
        host: "localhost:3000",
        "x-forwarded-for": "127.0.0.1",
      },
    });
    const res = authorizeAdminRequest(spoofedReq);
    assert.ok(res, "Expected 403 NextResponse when HYPERION_ADMIN_TOKEN is unset in production");
    assert.equal(res.status, 403);
  } finally {
    (process.env as Record<string, string | undefined>).NODE_ENV = prevNodeEnv;
  }
});

test("privileged /api/signals actions and /api/discord require admin auth and block prod webhookUrl overrides", async () => {
  process.env.HYPERION_ADMIN_TOKEN = "super-secret-admin-token-42";

  for (const action of [
    "EMERGENCY_LOCK",
    "UNLOCK_EXECUTION",
    "FLATTEN_PAPER_POSITIONS",
    "send_daily_recap",
    "send_radar",
  ]) {
    const res = await postSignalsRoute(
      new NextRequest("http://localhost:3000/api/signals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      })
    );
    assert.equal(res.status, 401, `Expected 401 for unauthenticated POST /api/signals action=${action}`);
  }

  const unauthScan = await getSignalsRoute(
    new NextRequest("http://localhost:3000/api/signals?scan=true")
  );
  assert.equal(unauthScan.status, 401);

  const unauthDiscord = await postDiscordRoute(
    new NextRequest("http://localhost:3000/api/discord", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dryRun: true, eventType: "test" }),
    })
  );
  assert.equal(unauthDiscord.status, 401);

  const prevNodeEnv = process.env.NODE_ENV;
  (process.env as Record<string, string | undefined>).NODE_ENV = "production";
  try {
    const prodOverrideRes = await postDiscordRoute(
      new NextRequest("http://localhost:3000/api/discord", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer super-secret-admin-token-42",
        },
        body: JSON.stringify({
          dryRun: true,
          eventType: "test",
          webhookUrl: "https://discord.com/api/webhooks/123456789012345678/abc123",
        }),
      })
    );
    assert.equal(prodOverrideRes.status, 403);
  } finally {
    (process.env as Record<string, string | undefined>).NODE_ENV = prevNodeEnv;
  }
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

test("forensic 2026-11-18 guardrails block $731.36 post-bounce mid-range Put above PUT WALL 730 at chi=48% & persist bouncedPutWalls", () => {
  const sessionDate = "2026-11-18";
  const evalTs = Math.floor(new Date("2026-11-18T10:05:00-05:00").getTime() / 1000);
  const store = loadTradeStore(sessionDate);
  store.bouncedPutWalls = {};

  const makeFlow = (spot: number, vwap: number, chi: number, pe: number, flux: number) => ({
    timestamp: evalTs,
    spot,
    flowVwap: vwap,
    ceilingShareChi: chi,
    impulseChi: chi,
    pecletNumber: pe,
    impulsePeclet: pe,
    netFluxJ: flux,
    deltaChi6Bar: -0.04,
    deltaImpulseChi6Bar: -0.04,
    deltaNetFlux6Bar: flux,
    upper1s: vwap + 1.8,
    lower1s: vwap - 1.8,
    upper2s: vwap + 3.6,
    lower2s: vwap - 3.6,
    upper1Sigma: vwap + 1.8,
    lower1Sigma: vwap - 1.8,
    upper2Sigma: vwap + 3.6,
    lower2Sigma: vwap - 3.6,
    sigma: 1.8,
    variance: 3.24,
    cumGammaWeight: 100,
    totalWeight: 100,
    signedGammaAcceleration: 0,
    count: 10,
    bandSignal: null,
    atr5m: 2.42,
    gammaRegime: "NEGATIVE_GAMMA" as const,
  });

  // Bar 1 (9:45 AM): SPY tests PUT WALL 730 (low 730.10) and bounces above 730
  evaluateBtoCandidateSetup({
    normalizedTicker: "SPY",
    spotPrice: 731.56,
    prevSpotPrice: 730.84,
    params: {
      ticker: "SPY",
      spotPrice: 731.56,
      callWall: 750,
      putWall: 730,
      zeroGamma: 751.29,
      zeroDtePutWall: 730,
      zeroDteCallWall: 750,
      priorClose: 731.85,
      netGex: -1757.79,
    },
    store,
    latest5mCandle: {
      open: 730.84,
      high: 731.7,
      low: 730.1,
      close: 731.56,
      sma34: 732.1,
      timestamp: evalTs - 1200,
      flowSnapshot: makeFlow(731.56, 731.9, 0.42, -1.0, -0.05),
    },
    divergence5m: "NO",
    divergence30m: "NO",
    etTotalMinutes: 585,
    nowTs: evalTs - 1200,
    sessionDate,
    isPhase2ReclaimWindow: false,
    sameTickerClosedCount: 0,
  });
  assert.equal(store.bouncedPutWalls?.SPY, 730);
  saveTradeStore(store);

  // Simulate container restart / disk reload
  resetPersistenceMemCachesForTests();
  const reloadedStore = loadTradeStore(sessionDate);
  assert.equal(reloadedStore.bouncedPutWalls?.SPY, 730);

  // 10:05 AM neutral flux (chi = 48%) at $731.36 above PUT WALL 730 -> BLOCKED
  const neutralBlocked = evaluateBtoCandidateSetup({
    normalizedTicker: "SPY",
    spotPrice: 731.36,
    prevSpotPrice: 732.57,
    params: {
      ticker: "SPY",
      spotPrice: 731.36,
      callWall: 750,
      putWall: 730,
      zeroGamma: 751.29,
      zeroDtePutWall: 730,
      zeroDteCallWall: 750,
      priorClose: 731.85,
      netGex: -1757.79,
    },
    store: reloadedStore,
    latest5mCandle: {
      open: 732.45,
      high: 732.69,
      low: 731.2,
      close: 731.36,
      sma34: 732.1,
      timestamp: evalTs,
      flowSnapshot: makeFlow(731.36, 731.82, 0.48, -1.0, -0.05),
    },
    divergence5m: "NO",
    divergence30m: "NO",
    etTotalMinutes: 605,
    nowTs: evalTs,
    sessionDate,
    isPhase2ReclaimWindow: false,
    sameTickerClosedCount: 0,
  });
  assert.equal(neutralBlocked.candidateBto, null);

  // 10:05 AM even at chi = 41.78% at $731.36 above PUT WALL 730 -> BLOCKED (< $2.34 clearance & post-bounce mid-range)
  const clearanceBlocked = evaluateBtoCandidateSetup({
    normalizedTicker: "SPY",
    spotPrice: 731.36,
    prevSpotPrice: 732.57,
    params: {
      ticker: "SPY",
      spotPrice: 731.36,
      callWall: 750,
      putWall: 730,
      zeroGamma: 751.29,
      zeroDtePutWall: 730,
      zeroDteCallWall: 750,
      priorClose: 731.85,
      netGex: -1757.79,
    },
    store: reloadedStore,
    latest5mCandle: {
      open: 732.45,
      high: 732.69,
      low: 731.2,
      close: 731.36,
      sma34: 732.1,
      timestamp: evalTs,
      flowSnapshot: makeFlow(731.36, 731.82, 0.4178, -1.002, -0.05),
    },
    divergence5m: "NO",
    divergence30m: "NO",
    etTotalMinutes: 605,
    nowTs: evalTs,
    sessionDate,
    isPhase2ReclaimWindow: false,
    sameTickerClosedCount: 0,
  });
  assert.equal(clearanceBlocked.candidateBto, null);

  // Even at $733.50 (>= $2.34 clearance) mid-range without upper resistance rejection -> still BLOCKED post-bounce
  const postBounceMidRangeBlocked = evaluateBtoCandidateSetup({
    normalizedTicker: "SPY",
    spotPrice: 733.5,
    prevSpotPrice: 734.0,
    params: {
      ticker: "SPY",
      spotPrice: 733.5,
      callWall: 750,
      putWall: 730,
      zeroGamma: 751.29,
      zeroDtePutWall: 730,
      zeroDteCallWall: 750,
      priorClose: 731.85,
      netGex: -1757.79,
    },
    store: reloadedStore,
    latest5mCandle: {
      open: 734.0,
      high: 734.1,
      low: 733.4,
      close: 733.5,
      sma34: 734.2,
      timestamp: evalTs + 300,
      flowSnapshot: makeFlow(733.5, 734.2, 0.36, -1.6, -0.18),
    },
    divergence5m: "NO",
    divergence30m: "NO",
    etTotalMinutes: 610,
    nowTs: evalTs + 300,
    sessionDate,
    isPhase2ReclaimWindow: false,
    sameTickerClosedCount: 0,
  });
  assert.equal(postBounceMidRangeBlocked.candidateBto, null);

  // Decisive close BELOW PUT WALL 730 with chi <= 0.44 & Pe <= -1.5 -> ALLOWED
  const decisiveBreakdownAllowed = evaluateBtoCandidateSetup({
    normalizedTicker: "SPY",
    spotPrice: 729.4,
    prevSpotPrice: 730.2,
    params: {
      ticker: "SPY",
      spotPrice: 729.4,
      callWall: 750,
      putWall: 730,
      zeroGamma: 751.29,
      zeroDtePutWall: 730,
      zeroDteCallWall: 750,
      priorClose: 731.85,
      netGex: -1757.79,
    },
    store: reloadedStore,
    latest5mCandle: {
      open: 730.2,
      high: 730.3,
      low: 729.3,
      close: 729.4,
      sma34: 731.0,
      timestamp: evalTs + 600,
      flowSnapshot: makeFlow(729.4, 730.6, 0.38, -1.8, -0.22),
    },
    divergence5m: "BEAR",
    divergence30m: "NO",
    etTotalMinutes: 615,
    nowTs: evalTs + 600,
    sessionDate,
    isPhase2ReclaimWindow: false,
    sameTickerClosedCount: 0,
  });
  assert.equal(decisiveBreakdownAllowed.candidateBto?.contractType, "PUT");

  // GaiaSignalFsm parity: neutral chop chi=48% & post-bounce mid-range above PUT WALL 730 stay STAND_ASIDE
  const fsm = new GaiaSignalFsm("STAND_ASIDE");
  const bounceBar: GaiaBarData = {
    barTimestamp: evalTs - 1200,
    etMins: 585,
    open: 730.84,
    high: 731.7,
    low: 730.1,
    close: 731.56,
    chi: 0.42,
    bias: -15,
    netFlux: -0.05,
    peclet: -1.0,
    flowVwap: 731.9,
    sma34: 732.1,
    isClosed: true,
  };
  const disp = computeCausalEquilibriumDispersion([bounceBar], 0);
  const macro = {
    macroRegime: "PUT" as const,
    callDominancePct: 48,
    netGex: -1757.79,
    structuralLevels: { putWall: 730, callWall: 750, zeroGamma: 751.29, bookCenter: 735 },
  };
  fsm.commitClosedBar(bounceBar, disp, macro, { isHistoricalBackfill: false });
  const midRangePutBar: GaiaBarData = {
    ...bounceBar,
    barTimestamp: evalTs,
    etMins: 605,
    open: 732.45,
    high: 732.69,
    low: 731.2,
    close: 731.36,
    chi: 0.48,
    peclet: -1.0,
  };
  const sig = fsm.commitClosedBar(midRangePutBar, disp, macro, { isHistoricalBackfill: false });
  assert.equal(sig, null);
});

test("universal VWAP stretch cap blocks >0.90x ATR bottom-tick chases and 0DTE enforces >= $0.45 ask floor", async () => {
  const sessionDate = "2026-11-18";
  const evalTs = Math.floor(new Date("2026-11-18T11:15:00-05:00").getTime() / 1000);
  const store = loadTradeStore(sessionDate);
  store.date = sessionDate;
  store.activePositions = {};
  store.closedPositions = [];
  store.bouncedPutWalls = {};

  const makeFlow = (spot: number, vwap: number, chi: number, pe: number, flux: number) => ({
    timestamp: evalTs,
    spot,
    flowVwap: vwap,
    ceilingShareChi: chi,
    impulseChi: chi,
    pecletNumber: pe,
    impulsePeclet: pe,
    netFluxJ: flux,
    deltaChi6Bar: -0.05,
    deltaImpulseChi6Bar: -0.05,
    deltaNetFlux6Bar: flux,
    upper1s: vwap + 1.8,
    lower1s: vwap - 1.8,
    upper2s: vwap + 3.6,
    lower2s: vwap - 3.6,
    upper1Sigma: vwap + 1.8,
    lower1Sigma: vwap - 1.8,
    upper2Sigma: vwap + 3.6,
    lower2Sigma: vwap - 3.6,
    sigma: 1.8,
    variance: 3.24,
    cumGammaWeight: 100,
    totalWeight: 100,
    signedGammaAcceleration: 0,
    count: 10,
    bandSignal: null,
    atr5m: 2.0,
    gammaRegime: "NEGATIVE_GAMMA" as const,
  });

  // 11:15 AM bottom-tick chase at $728.25 when Flow VWAP is $731.00 (|spot - vwap| = $2.75 > 0.90 * $2.00 = $1.80) -> BLOCKED
  const overStretchedFlush = evaluateBtoCandidateSetup({
    normalizedTicker: "SPY",
    spotPrice: 728.25,
    prevSpotPrice: 729.0,
    params: {
      ticker: "SPY",
      spotPrice: 728.25,
      callWall: 750,
      putWall: 720,
      zeroGamma: 751.29,
      zeroDtePutWall: 720,
      zeroDteCallWall: 750,
      priorClose: 731.85,
      netGex: -1757.79,
    },
    store,
    latest5mCandle: {
      open: 729.1,
      high: 729.2,
      low: 728.1,
      close: 728.25,
      sma34: 730.2,
      timestamp: evalTs,
      flowSnapshot: makeFlow(728.25, 731.0, 0.25, -2.4, -0.35),
    },
    divergence5m: "NO",
    divergence30m: "NO",
    etTotalMinutes: 675,
    nowTs: evalTs,
    sessionDate,
    isPhase2ReclaimWindow: false,
    sameTickerClosedCount: 0,
  });
  assert.equal(overStretchedFlush.candidateBto, null);

  // Explicit mean-reversion Flow Bounce setup remains exempt from trend VWAP stretch cap
  const explicitBounceFlow = {
    ...makeFlow(727.3, 731.0, 0.64, 0.9, 0.14),
    bandSignal: "LOWER_2S_BOUNCE" as const,
  };
  const explicitBounceAllowed = evaluateBtoCandidateSetup({
    normalizedTicker: "SPY",
    spotPrice: 727.3,
    prevSpotPrice: 726.9,
    params: {
      ticker: "SPY",
      spotPrice: 727.3,
      callWall: 750,
      putWall: 726,
      zeroGamma: 751.29,
      zeroDtePutWall: 726,
      zeroDteCallWall: 750,
      priorClose: 731.85,
      netGex: -1757.79,
    },
    store,
    latest5mCandle: {
      open: 726.9,
      high: 727.4,
      low: 726.8,
      close: 727.3,
      sma34: 728.0,
      timestamp: evalTs,
      flowSnapshot: explicitBounceFlow,
    },
    divergence5m: "BULL",
    divergence30m: "NO",
    etTotalMinutes: 675,
    nowTs: evalTs,
    sessionDate,
    isPhase2ReclaimWindow: false,
    sameTickerClosedCount: 0,
  });
  assert.ok(
    explicitBounceAllowed.candidateBto !== null &&
      /Flow Bounce|Support Bounce|Extremity Reclaim/i.test(explicitBounceAllowed.candidateBto.setupName)
  );

  // 0DTE $0.28 ultra-cheap OTM Put strictly rejected (< $0.45 floor); $0.52 0DTE and $0.28 1DTE remain eligible
  const nowEt = new Date("2026-11-18T11:15:00-05:00");
  const zeroDteCheapOnly = await selectSmallAccountContract({
    ticker: "SPY",
    contractType: "PUT",
    spotPrice: 728.25,
    target1Spot: 724.5,
    target2Spot: 722.0,
    stopLossSpot: 730.25,
    contracts: [
      {
        symbol: "SPY261118P00726000",
        strike: 726,
        expiration: "2026-11-18",
        optionType: "P",
        bid: 0.25,
        ask: 0.28,
        last: 0.27,
        volume: 15000,
        openInterest: 10000,
        iv: 0.24,
        delta: -0.25,
        gamma: 0.04,
        vega: 0.03,
        percentChange: 0,
      },
    ],
    nowEt,
    regime: "NEG_GAMMA_TREND",
    absImpulsePeclet: 2.1,
  });
  assert.equal(zeroDteCheapOnly, null);

  const oneDteCheapAllowed = await selectSmallAccountContract({
    ticker: "SPY",
    contractType: "PUT",
    spotPrice: 728.25,
    target1Spot: 724.5,
    target2Spot: 722.0,
    stopLossSpot: 730.25,
    contracts: [
      {
        symbol: "SPY261118P00726000",
        strike: 726,
        expiration: "2026-11-18",
        optionType: "P",
        bid: 0.25,
        ask: 0.28,
        last: 0.27,
        volume: 15000,
        openInterest: 10000,
        iv: 0.24,
        delta: -0.25,
        gamma: 0.04,
        vega: 0.03,
        percentChange: 0,
      },
      {
        symbol: "SPY261119P00726000",
        strike: 726,
        expiration: "2026-11-19",
        optionType: "P",
        bid: 0.26,
        ask: 0.28,
        last: 0.27,
        volume: 15000,
        openInterest: 10000,
        iv: 0.24,
        delta: -0.26,
        gamma: 0.04,
        vega: 0.05,
        percentChange: 0,
      },
    ],
    nowEt,
    regime: "NEG_GAMMA_TREND",
    absImpulsePeclet: 2.1,
  });
  assert.equal(oneDteCheapAllowed?.expiration, "2026-11-19");
});

test("afternoon 0DTE OTM ban (>= 12:30 ET), +2σ target1Spot cap, BOUNDARY_FLUX_REVERSAL_LOCK, and 52m 0DTE theta decay", async () => {
  const sessionDate = "2026-11-18";
  // 1. Afternoon 0DTE OTM Ban (1:20 PM ET -> etMins = 800 >= 750)
  const afternoon120PmEt = new Date("2026-11-18T13:20:00-05:00");
  const otm0DteCallOnly = await selectSmallAccountContract({
    ticker: "SPY",
    contractType: "CALL",
    spotPrice: 731.12,
    target1Spot: 733.65,
    target2Spot: 735.0,
    stopLossSpot: 729.6,
    contracts: [
      {
        symbol: "SPY261118C00734000",
        strike: 734,
        expiration: "2026-11-18",
        optionType: "C",
        bid: 0.48,
        ask: 0.50,
        last: 0.49,
        volume: 15000,
        openInterest: 10000,
        iv: 0.16,
        delta: 0.28,
        gamma: 0.04,
        vega: 0.05,
        percentChange: 0,
      },
    ],
    nowEt: afternoon120PmEt,
    regime: "NEG_GAMMA_TREND",
    absImpulsePeclet: 2.1,
  });
  assert.equal(otm0DteCallOnly, null, "1:20 PM ET must ban OTM 0DTE 734C at spot $731.12");

  const afternoon1DteAndAtmAllowed = await selectSmallAccountContract({
    ticker: "SPY",
    contractType: "CALL",
    spotPrice: 731.12,
    target1Spot: 733.65,
    target2Spot: 735.0,
    stopLossSpot: 729.6,
    contracts: [
      {
        symbol: "SPY261118C00734000",
        strike: 734,
        expiration: "2026-11-18",
        optionType: "C",
        bid: 0.48,
        ask: 0.50,
        last: 0.49,
        volume: 15000,
        openInterest: 10000,
        iv: 0.16,
        delta: 0.28,
        gamma: 0.04,
        vega: 0.05,
        percentChange: 0,
      },
      {
        symbol: "SPY261119C00734000",
        strike: 734,
        expiration: "2026-11-19",
        optionType: "C",
        bid: 0.80,
        ask: 0.83,
        last: 0.82,
        volume: 15000,
        openInterest: 10000,
        iv: 0.16,
        delta: 0.36,
        gamma: 0.04,
        vega: 0.08,
        percentChange: 0,
      },
    ],
    nowEt: afternoon120PmEt,
    regime: "NEG_GAMMA_TREND",
    absImpulsePeclet: 2.1,
  });
  assert.equal(afternoon1DteAndAtmAllowed?.dte, 1, "1:20 PM ET allows 1DTE OTM 734C");

  const afternoonAtm0DteCall = await selectSmallAccountContract({
    ticker: "SPY",
    contractType: "CALL",
    spotPrice: 731.12,
    target1Spot: 733.65,
    target2Spot: 735.0,
    stopLossSpot: 729.6,
    contracts: [
      {
        symbol: "SPY261118C00732000",
        strike: 732, // <= Math.ceil(731.12) = 732
        expiration: "2026-11-18",
        optionType: "C",
        bid: 0.78,
        ask: 0.82,
        last: 0.80,
        volume: 15000,
        openInterest: 10000,
        iv: 0.16,
        delta: 0.42,
        gamma: 0.06,
        vega: 0.05,
        percentChange: 0,
      },
    ],
    nowEt: afternoon120PmEt,
    regime: "NEG_GAMMA_TREND",
    absImpulsePeclet: 2.1,
  });
  assert.equal(afternoonAtm0DteCall?.strike, 732, "1:20 PM ET allows ATM 0DTE strike <= Math.ceil(spot)");

  const afternoonOtm0DtePutRejected = await selectSmallAccountContract({
    ticker: "SPY",
    contractType: "PUT",
    spotPrice: 731.12,
    target1Spot: 728.5,
    target2Spot: 727.0,
    stopLossSpot: 732.5,
    contracts: [
      {
        symbol: "SPY261118P00729000",
        strike: 729, // < Math.floor(731.12) = 731
        expiration: "2026-11-18",
        optionType: "P",
        bid: 0.48,
        ask: 0.50,
        last: 0.49,
        volume: 15000,
        openInterest: 10000,
        iv: 0.16,
        delta: -0.28,
        gamma: 0.04,
        vega: 0.05,
        percentChange: 0,
      },
    ],
    nowEt: afternoon120PmEt,
    regime: "NEG_GAMMA_TREND",
    absImpulsePeclet: 2.1,
  });
  assert.equal(afternoonOtm0DtePutRejected, null, "1:20 PM ET must ban OTM 0DTE 729P at spot $731.12");

  // 2. Cap target1Spot at +2σ Flux Field boundary when tacticalCw is > 1.5 * entryAtr5m away
  const evalTs = Math.floor(afternoon120PmEt.getTime() / 1000);
  const store = loadTradeStore(sessionDate);
  store.date = sessionDate;
  store.activePositions = {};
  store.closedPositions = [];
  store.alerts = [];
  store.bouncedPutWalls = {};

  const setupWithFarMacroWall = evaluateBtoCandidateSetup({
    normalizedTicker: "SPY",
    spotPrice: 731.12,
    prevSpotPrice: 730.8,
    params: {
      ticker: "SPY",
      spotPrice: 731.12,
      callWall: 750,
      putWall: 728,
      zeroGamma: 730.5,
      zeroDteCallWall: 750,
      zeroDtePutWall: 728,
      priorClose: 730.2,
      netGex: -1200,
    },
    store,
    latest5mCandle: {
      open: 730.6,
      high: 731.25,
      low: 730.4,
      close: 731.12,
      sma34: 730.4,
      timestamp: evalTs,
      flowSnapshot: {
        timestamp: evalTs,
        spot: 731.12,
        flowVwap: 730.55,
        ceilingShareChi: 0.64,
        impulseChi: 0.68,
        pecletNumber: 1.6,
        impulsePeclet: 1.8,
        netFluxJ: 0.25,
        deltaChi6Bar: 0.08,
        deltaImpulseChi6Bar: 0.1,
        deltaNetFlux6Bar: 0.2,
        upper1s: 732.1,
        lower1s: 729.0,
        upper2s: 733.65,
        lower2s: 727.45,
        upper1Sigma: 732.1,
        lower1Sigma: 729.0,
        upper2Sigma: 733.65,
        lower2Sigma: 727.45,
        sigma: 1.55,
        variance: 2.4,
        cumGammaWeight: 100,
        totalWeight: 100,
        signedGammaAcceleration: 0,
        count: 10,
        bandSignal: null,
        atr5m: 1.2,
        gammaRegime: "NEGATIVE_GAMMA",
      },
    },
    divergence5m: "BULL",
    divergence30m: "NO",
    etTotalMinutes: 800,
    nowTs: evalTs,
    sessionDate,
    isPhase2ReclaimWindow: false,
    sameTickerClosedCount: 0,
  });
  assert.ok(setupWithFarMacroWall.candidateBto, "Expected valid CALL candidate");
  assert.ok(
    setupWithFarMacroWall.candidateBto.target1Spot <= 733.65,
    `Expected target1Spot capped <= +2σ ($733.65), got ${setupWithFarMacroWall.candidateBto.target1Spot}`
  );

  // 3. BOUNDARY_FLUX_REVERSAL_LOCK + 52m 0DTE Black-Scholes T_remaining theta decay
  const { evaluateTradeSignals } = await import("../tradeSignalEngine");
  const entryTs = Math.floor(new Date("2026-11-18T13:20:00-05:00").getTime() / 1000);
  const pos: OptionTradePosition = {
    id: "SPY-CALL-MFE-TEST",
    ticker: "SPY",
    contractType: "CALL",
    contractLabel: "SPY 261118 734C (0 DTE · $0.50)",
    strike: 734,
    expiration: sessionDate,
    setupName: "Zero-Gamma Flip & Flux Reclaim [BTO CALL]",
    status: "OPEN",
    btoSpotPrice: 731.12,
    btoOptionMid: 0.49,
    optionBid: 0.48,
    optionAsk: 0.50,
    contractsQty: 1,
    remainingQty: 1,
    totalOutlay: 50,
    target1Spot: 733.65,
    target2Spot: 745.0,
    stopLossSpot: 729.5,
    tp1Pct: 120,
    tp2Pct: 250,
    openedAt: "1:20 PM",
    openedTs: entryTs,
    lastCandleTs: entryTs,
  };
  saveTradeStore({
    date: sessionDate,
    activePositions: { SPY: { ...pos } },
    closedPositions: [],
    alerts: [],
    prevSpotPrices: { SPY: 731.12 },
  });

  // Bar +15m: SPY rallies +0.22% MFE ($732.73 >= +$1.45) with positive netFluxJ -> stays OPEN, records MFE
  await evaluateTradeSignals({
    ticker: "SPY",
    spotPrice: 732.7,
    callWall: 750,
    putWall: 728,
    zeroGamma: 730.5,
    contracts: [],
    nowEt: new Date((entryTs + 900) * 1000),
    isHistoricalBackfill: true,
    latest5mCandle: {
      open: 731.5,
      high: 732.75,
      low: 731.4,
      close: 732.7,
      sma34: 731.0,
      timestamp: entryTs + 900,
      flowSnapshot: {
        timestamp: entryTs + 900,
        spot: 732.7,
        flowVwap: 731.2,
        ceilingShareChi: 0.65,
        pecletNumber: 1.5,
        netFluxJ: 0.18,
        upper1s: 732.2,
        lower1s: 730.2,
        upper2s: 733.65,
        lower2s: 728.75,
        upper1Sigma: 732.2,
        lower1Sigma: 730.2,
        upper2Sigma: 733.65,
        lower2Sigma: 728.75,
        sigma: 1.2,
        variance: 1.44,
        cumGammaWeight: 100,
        totalWeight: 100,
        signedGammaAcceleration: 0,
        count: 10,
      },
    },
  });
  const midStore = loadTradeStore(sessionDate);
  assert.ok(midStore.activePositions.SPY, "Trade should stay open while boundary flux remains positive");
  assert.ok(
    (midStore.activePositions.SPY.peakFavorableSpotMfePct ?? 0) >= 0.2,
    "Should record >= 0.20% favorable spot MFE"
  );

  // Bar +52m (2:12 PM ET): spot pulls back to $731.07 (-0.05) and netFluxJ flips negative -> immediate BOUNDARY_FLUX_REVERSAL_LOCK with real BS theta loss
  const exitRes = await evaluateTradeSignals({
    ticker: "SPY",
    spotPrice: 731.07,
    callWall: 750,
    putWall: 728,
    zeroGamma: 730.5,
    contracts: [],
    nowEt: new Date((entryTs + 52 * 60) * 1000),
    isHistoricalBackfill: true,
    latest5mCandle: {
      open: 731.8,
      high: 731.9,
      low: 731.0,
      close: 731.07,
      sma34: 731.1,
      timestamp: entryTs + 52 * 60,
      flowSnapshot: {
        timestamp: entryTs + 52 * 60,
        spot: 731.07,
        flowVwap: 731.3,
        ceilingShareChi: 0.42,
        pecletNumber: -0.9,
        netFluxJ: -0.14,
        upper1s: 732.2,
        lower1s: 730.4,
        upper2s: 733.65,
        lower2s: 729.0,
        upper1Sigma: 732.2,
        lower1Sigma: 730.4,
        upper2Sigma: 733.65,
        lower2Sigma: 729.0,
        sigma: 1.2,
        variance: 1.44,
        cumGammaWeight: 100,
        totalWeight: 100,
        signedGammaAcceleration: 0,
        count: 10,
      },
    },
  });
  assert.equal(exitRes.activePosition, null, "BOUNDARY_FLUX_REVERSAL_LOCK must close position immediately");
  const afterStore = loadTradeStore(sessionDate);
  const closedTrade = afterStore.closedPositions[0];
  assert.equal(closedTrade?.exitReason, "BOUNDARY_FLUX_REVERSAL_LOCK");
  assert.ok(
    typeof closedTrade?.pnlOptionPct === "number" && closedTrade.pnlOptionPct < -10,
    `Expected real 52m afternoon 0DTE BS theta loss (< -10%), got ${closedTrade?.pnlOptionPct}%`
  );
});
