/**
 * Live Cross-View Parity & Latency Verification Script
 * Usage: node scripts/verifyLiveParity.mjs [baseUrl]
 */
const BASE = process.argv[2] || process.env.HYPERION_BASE_URL || "http://localhost:3000";
const TICKERS = ["SPY", "QQQ", "IWM", "SPXW"];

async function fetchTimed(path) {
  const t0 = performance.now();
  const res = await fetch(`${BASE}${path}`);
  const ms = performance.now() - t0;
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status, ms: Number(ms.toFixed(1)), json };
}

async function main() {
  console.log(`=== 1. CROSS-VIEW PARITY & LATENCY (${BASE}) ===`);
  const rows = [];
  for (const sym of TICKERS) {
    const optCold = await fetchTimed(`/api/options?ticker=${sym}`);
    const optWarm = await fetchTimed(`/api/options?ticker=${sym}`);
    const gaia = await fetchTimed(`/api/gaia?ticker=${sym}&start=9`);

    const opt = optWarm.json || {};
    const g = gaia.json || {};
    const optSpot = opt.spotPrice ?? null;
    const gaiaSpot = g.spotPrice ?? null;
    const optEm = opt.expectedMoves?.daily?.em ?? null;
    const gaiaEm = g.sigma1Move ?? null;
    const emDriftPct =
      typeof optEm === "number" && optEm > 0 && typeof gaiaEm === "number"
        ? Number(((Math.abs(optEm - gaiaEm) / optEm) * 100).toFixed(3))
        : null;
    const spotDiff =
      typeof optSpot === "number" && typeof gaiaSpot === "number"
        ? Number(Math.abs(optSpot - gaiaSpot).toFixed(2))
        : null;

    rows.push({
      ticker: sym,
      optStatus: optWarm.status,
      optColdMs: optCold.ms,
      optWarmMs: optWarm.ms,
      gaiaStatus: gaia.status,
      gaiaMs: gaia.ms,
      optSpot,
      gaiaSpot,
      spotDiff,
      optEm,
      gaiaEm,
      emDriftPct,
      callWall: opt.gammaLevels?.callWall ?? null,
      putWall: opt.gammaLevels?.putWall ?? null,
      zeroGamma: opt.gammaLevels?.zeroGamma ?? null,
      allExpKing: opt.kingByFilter?.ALL?.strike ?? null,
      zeroDteKing: opt.kingByFilter?.["0DTE"]?.strike ?? null,
      extendedQuote: opt.extendedQuote ?? null,
      dataSource: opt.dataSource ?? null,
    });
  }
  console.log(JSON.stringify(rows, null, 2));

  console.log("\n=== 2. /api/scanner (NON-BLOCKING CORE + SYNCING) ===");
  const scan = await fetchTimed("/api/scanner");
  const firstScan = scan.json?.scans?.[0] || {};
  const scanRows = Array.isArray(firstScan.rows) ? firstScan.rows : [];
  const statusCounts = {};
  for (const r of scanRows) {
    const st = r.dataStatus || "UNKNOWN";
    statusCounts[st] = (statusCounts[st] || 0) + 1;
  }
  const coreSummary = scanRows
    .filter((r) => ["SPY", "QQQ", "IWM", "SPXW"].includes(r.t))
    .map((r) => ({
      ticker: r.t,
      dataStatus: r.dataStatus,
      px: r.px,
      king: r.king,
      xem: r.xem,
      slot: firstScan.slot,
    }));
  console.log(
    JSON.stringify(
      {
        status: scan.status,
        ms: scan.ms,
        slot: firstScan.slot,
        liveCount: firstScan.liveCount,
        syncingCount: firstScan.syncingCount,
        totalRows: scanRows.length,
        statusCounts,
        coreSummary,
      },
      null,
      2
    )
  );

  console.log("\n=== 3. /api/scanner/playbook ===");
  const pb = await fetchTimed("/api/scanner/playbook");
  console.log(
    JSON.stringify(
      {
        status: pb.status,
        ms: pb.ms,
        topCalls: (pb.json?.topCalls || []).map((c) => ({
          ticker: c.ticker,
          entry: c.entryTrigger,
          t1: c.target1,
          t2: c.target2,
          sl: c.stopLoss,
        })),
        topPuts: (pb.json?.topPuts || []).map((p) => ({
          ticker: p.ticker,
          entry: p.entryTrigger,
          t1: p.target1,
          t2: p.target2,
          sl: p.stopLoss,
        })),
      },
      null,
      2
    )
  );

  console.log("\n=== 4. /api/session-recap ===");
  const recap = await fetchTimed("/api/session-recap");
  console.log(
    JSON.stringify(
      {
        status: recap.status,
        ms: recap.ms,
        day: recap.json?.day,
        days: recap.json?.days,
        portfolio: {
          totalTrades: recap.json?.portfolio?.totalTrades,
          wins: recap.json?.portfolio?.wins,
          losses: recap.json?.portfolio?.losses,
          expectancyR: recap.json?.portfolio?.expectancyR,
          profitFactor: recap.json?.portfolio?.profitFactor,
        },
        recapTickers: (recap.json?.recap?.tickers || []).map((t) => ({
          symbol: t.symbol,
          close: t.close,
          cw: t.next?.cw,
          pw: t.next?.pw,
          zg: t.next?.zg,
          emMove: t.next?.em?.move,
        })),
      },
      null,
      2
    )
  );

  console.log("\n=== 5. /api/health ===");
  const health = await fetchTimed("/api/health");
  console.log(JSON.stringify({ status: health.status, ms: health.ms, body: health.json }, null, 2));
}

main().catch((err) => {
  console.error("Parity script failed:", err);
  process.exit(1);
});
