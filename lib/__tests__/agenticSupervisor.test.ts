import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { NextRequest } from "next/server";
import {
  loadShadowParityReport,
  runDeterministicSnapshotReplay,
  runPostMarketAttribution,
  type IntradaySnapshotFile,
  type ReplayShadowTrade,
} from "../agenticSupervisor";
import { loadTradeStore, saveTradeStore, type OptionTradePosition } from "../tradeSignalEngine";
import { GET as getSignalsRoute } from "../../app/api/signals/route";

function buildBearishFlushSnapshot(dateIso: string): IntradaySnapshotFile {
  const startSec = Math.floor(new Date(`${dateIso}T09:30:00-05:00`).getTime() / 1000);
  const points: Array<{
    ts: number;
    spot: number;
    callWall: number;
    putWall: number;
    zeroGamma: number;
  }> = [];

  // 24 x 5-minute bars (09:30 AM - 11:25 AM ET) forming a clean negative-gamma breakdown & bounce
  const closes = [
    755.2, 754.8, 754.2, 753.4, 752.7, 751.9, 751.1, 750.3,
    749.6, 749.0, 748.5, 748.2, 748.4, 748.9, 749.5, 750.2,
    750.9, 751.6, 752.1, 752.5, 752.8, 753.1, 753.4, 753.7,
  ];

  closes.forEach((spot, idx) => {
    const barTs = startSec + idx * 300;
    points.push({ ts: barTs + 10, spot: Number((spot + 0.15).toFixed(2)), callWall: 758, putWall: 747, zeroGamma: 756 });
    points.push({ ts: barTs + 150, spot: Number((spot - 0.15).toFixed(2)), callWall: 758, putWall: 747, zeroGamma: 756 });
    points.push({ ts: barTs + 280, spot, callWall: 758, putWall: 747, zeroGamma: 756 });
  });

  return {
    date: dateIso,
    tickers: {
      SPY: {
        rthHistory: points,
        history: points,
      },
    },
  };
}

describe("AgenticSupervisor: 16:05 ET Post-Market Attribution & Live-vs-Replay Shadow Parity", () => {
  it("runDeterministicSnapshotReplay produces deterministic signals from intraday snapshot", () => {
    const snap = buildBearishFlushSnapshot("2026-11-16");
    const run1 = runDeterministicSnapshotReplay({ ticker: "SPY", snapshot: snap });
    const run2 = runDeterministicSnapshotReplay({ ticker: "SPY", snapshot: snap });
    assert.deepEqual(run1, run2, "Bar replay on intraday snapshot must be strictly deterministic");
    assert.ok(run1.length >= 1, `Expected at least 1 deterministic replay trade, got ${run1.length}`);
    assert.equal(run1[0].direction, "PUT");
  });

  it("runPostMarketAttribution computes matchedTrades, missedLiveTrades, and slippageDriftDollars accurately", () => {
    const testDate = "2099-01-15";
    const replayTrades: ReplayShadowTrade[] = [
      {
        ticker: "SPY",
        direction: "PUT",
        setupName: "Bearish Zero-Gamma Flush [BTO PUT]",
        strike: 752,
        openedTs: 4072172100,
        openedTimeEt: "09:35 AM",
        closedTs: 4072175700,
        closedTimeEt: "10:35 AM",
        entrySpot: 754.0,
        exitSpot: 749.5,
        entryAsk: 0.72,
        exitBid: 1.45,
        exitReason: "TARGET 1 PROFIT SECURED",
      },
      {
        ticker: "SPY",
        direction: "CALL",
        setupName: "Leg-2 Put Wall / -1σ Bullish Reclaim",
        strike: 751,
        openedTs: 4072181100,
        openedTimeEt: "12:05 PM",
        closedTs: 4072186500,
        closedTimeEt: "01:35 PM",
        entrySpot: 750.2,
        exitSpot: 752.8,
        entryAsk: 0.68,
        exitBid: 1.12,
        exitReason: "TARGET 1 PROFIT SECURED",
      },
    ];

    // Live session matched Trade #1 with +$0.05 entry slippage and -$0.04 exit slippage (+$9.00 drift), missed Trade #2
    const liveTrades: OptionTradePosition[] = [
      {
        id: "live-shadow-put-1",
        ticker: "SPY",
        contractType: "PUT",
        contractLabel: "SPY 752P",
        strike: 752,
        expiration: testDate,
        setupName: "Bearish Zero-Gamma Flush [BTO PUT]",
        status: "CLOSED",
        btoSpotPrice: 753.9,
        btoOptionMid: 0.75,
        optionAsk: 0.77, // +$5.00 worse entry fill vs $0.72 replay
        closedOptionMid: 1.41, // +$4.00 worse exit fill vs $1.45 replay
        contractsQty: 1,
        remainingQty: 0,
        totalOutlay: 77,
        target1Spot: 750.0,
        target2Spot: 748.0,
        stopLossSpot: 755.5,
        openedAt: "09:35 AM",
        openedTs: 4072172160, // 60s difference -> matched
        closedAt: "10:35 AM",
        closedTs: 4072175700,
        exitReason: "TARGET 1 PROFIT SECURED",
      },
    ];

    const report = runPostMarketAttribution({
      date: testDate,
      ticker: "SPY",
      liveTrades,
      replayTradesOverride: replayTrades,
      persist: false,
    });

    assert.equal(report.matchedTrades, 1);
    assert.equal(report.missedLiveTrades, 1);
    assert.equal(report.slippageDriftDollars, 9.0);
    assert.equal(report.parityScorePct, 50.0);
    assert.equal(report.status, "DRIFT_WARNING");
    assert.equal(report.details.length, 2);
  });

  it("persists shadowParityReport to .cache and exposes it via GET /api/signals", async () => {
    const testDate = "2099-01-16";
    const cacheDir = path.join(process.cwd(), ".cache");
    const parityFile = path.join(cacheDir, `shadow-parity-${testDate}.json`);
    const tradeFile = path.join(cacheDir, `active-trades-${testDate}.json`);
    const snapFile = path.join(cacheDir, `intraday-${testDate}.json`);
    const storeBackup = loadTradeStore();

    try {
      const snapshot = buildBearishFlushSnapshot(testDate);
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(snapFile, JSON.stringify(snapshot, null, 2), "utf-8");

      const replayTrades = runDeterministicSnapshotReplay({ ticker: "SPY", snapshot });
      assert.ok(replayTrades.length >= 1, "Snapshot must yield at least one replay trade");

      const matchingLiveTrades: OptionTradePosition[] = replayTrades.map((rt, idx) => ({
        id: `live-parity-${idx}`,
        ticker: "SPY",
        contractType: rt.direction,
        contractLabel: `SPY ${rt.strike}${rt.direction === "CALL" ? "C" : "P"}`,
        strike: rt.strike,
        expiration: testDate,
        setupName: rt.setupName,
        status: "CLOSED",
        btoSpotPrice: rt.entrySpot,
        btoOptionMid: rt.entryAsk,
        optionAsk: rt.entryAsk,
        closedOptionMid: rt.exitBid,
        contractsQty: 1,
        remainingQty: 0,
        totalOutlay: Number((rt.entryAsk * 100).toFixed(2)),
        target1Spot: rt.exitSpot,
        target2Spot: rt.exitSpot,
        stopLossSpot: rt.entrySpot,
        openedAt: rt.openedTimeEt,
        openedTs: rt.openedTs,
        closedAt: rt.closedTimeEt,
        closedTs: rt.closedTs,
        exitReason: rt.exitReason,
      }));

      fs.writeFileSync(
        tradeFile,
        JSON.stringify(
          {
            date: testDate,
            version: 1,
            activePositions: {},
            closedPositions: matchingLiveTrades,
            alerts: [],
            prevSpotPrices: {},
          },
          null,
          2
        ),
        "utf-8"
      );

      const report = runPostMarketAttribution({
        date: testDate,
        ticker: "SPY",
        persist: true,
      });

      assert.equal(report.matchedTrades, replayTrades.length);
      assert.equal(report.missedLiveTrades, 0);
      assert.equal(report.slippageDriftDollars, 0);
      assert.equal(report.status, "PASS");
      assert.ok(fs.existsSync(parityFile), "shadow-parity JSON file must be persisted in .cache");

      const loaded = loadShadowParityReport(testDate);
      assert.deepEqual(loaded?.matchedTrades, report.matchedTrades);

      const req = new NextRequest(`http://localhost:3000/api/signals?ticker=SPY&date=${testDate}`);
      const res = await getSignalsRoute(req);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.shadowParityReport?.matchedTrades, report.matchedTrades);
      assert.equal(body.shadowParityReport?.missedLiveTrades, 0);
      assert.equal(body.shadowParityReport?.slippageDriftDollars, 0);
    } finally {
      saveTradeStore(storeBackup);
      for (const f of [parityFile, tradeFile, snapFile]) {
        try {
          if (fs.existsSync(f)) fs.unlinkSync(f);
        } catch {}
      }
    }
  });
});
