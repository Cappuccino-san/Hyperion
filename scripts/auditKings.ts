import { parseOccSymbol, computeOptionsAnalytics } from "../lib/optionsExposure";

function normPDF(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

async function testComparison() {
  const url = "https://cdn.cboe.com/api/global/delayed_quotes/options/SPY.json";
  const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" } });
  const json = await res.json();
  const data = json.data;
  const spotPrice = Number(data.current_price ?? data.close ?? 0);
  const previousClose = Number(data.prev_day_close ?? data.close ?? spotPrice);
  const rawIv30 = Number(data.iv30 ?? 0);
  const impliedVolatility = rawIv30 > 0 ? (rawIv30 > 2 ? rawIv30 / 100 : rawIv30) : 0.18;

  const contracts: any[] = [];
  for (const rawOpt of data.options) {
    const occSymbol = String(rawOpt.option ?? "");
    const parsed = parseOccSymbol(occSymbol);
    if (!parsed) continue;
    const openInterest = Number(rawOpt.open_interest ?? 0);
    const volume = Number(rawOpt.volume ?? 0);
    if (openInterest <= 0 && volume <= 0) continue;
    contracts.push({
      symbol: occSymbol,
      expiration: parsed.expiration,
      optionType: parsed.optionType,
      strike: parsed.strike,
      openInterest,
      volume,
      iv: Number(rawOpt.iv ?? 0),
      delta: Number(rawOpt.delta ?? 0),
      gamma: Number(rawOpt.gamma ?? 0),
      vega: Number(rawOpt.vega ?? 0),
      percentChange: Number(rawOpt.percent_change ?? 0),
    });
  }

  // 1. Run computeOptionsAnalytics from optionsExposure.ts (Heatmap math)
  const heatmapPayload = computeOptionsAnalytics({
    ticker: "SPY",
    dataSource: "CBOE_MARKET_DATA",
    spotPrice,
    previousClose,
    impliedVolatility,
    contracts,
  });

  console.log("=== HEATMAP (optionsExposure.ts) ===");
  console.log("All-exp King:", heatmapPayload.kingNode.allExpKing);
  console.log("0DTE King:", heatmapPayload.kingNode.zeroDteKing);
  console.log("King Value:", heatmapPayload.kingNode.kingValue);
  const king750 = heatmapPayload.strikes.find(s => s.strike === 750);
  const king760 = heatmapPayload.strikes.find(s => s.strike === 760);
  console.log("Strike 750 totalNetGex:", king750?.totalNetGex);
  console.log("Strike 760 totalNetGex:", king760?.totalNetGex);

  // 2. Simulate Gaia buckets created with harmonized formula
  const refTimeMs = new Date(`${heatmapPayload.expirations[0].isoDate}T00:00:00Z`).getTime();
  const bucketMap = new Map<string, any>();

  for (const c of contracts) {
    const key = `${c.strike}_${c.expiration}`;
    let b = bucketMap.get(key);
    if (!b) {
      const expTimeMs = new Date(`${c.expiration}T00:00:00Z`).getTime();
      const dteDays = Math.max(0, (expTimeMs - refTimeMs) / (1000 * 86400));
      b = {
        strike: c.strike,
        expiration: c.expiration,
        dteDays,
        callOI: 0,
        putOI: 0,
        callIvWeighted: 0,
        putIvWeighted: 0,
      };
      bucketMap.set(key, b);
    }
    const iv = c.iv > 0.02 ? (c.iv > 4 ? c.iv / 100 : c.iv) : impliedVolatility;
    if (c.optionType === "C") {
      b.callOI += c.openInterest;
      b.callIvWeighted += c.openInterest * iv;
    } else {
      b.putOI += c.openInterest;
      b.putIvWeighted += c.openInterest * iv;
    }
  }

  const buckets = Array.from(bucketMap.values()).map(b => ({
    strike: b.strike,
    expiration: b.expiration,
    dteDays: b.dteDays,
    callOI: b.callOI,
    putOI: b.putOI,
    callIv: b.callOI > 0 ? b.callIvWeighted / b.callOI : impliedVolatility,
    putIv: b.putOI > 0 ? b.putIvWeighted / b.putOI : impliedVolatility,
  }));

  // Test both GEX and Combined (Polarity)
  function evalBucket(spot: number, bucket: any, mode: "GEX" | "Combined") {
    const days = bucket.dteDays;
    const T = Math.max(1 / 365, days / 365);
    const sqrtT = Math.sqrt(T);

    let callGexM = 0;
    let callVexM = 0;
    if (bucket.callOI > 0) {
      const iv = Math.max(0.02, Math.min(3.5, bucket.callIv));
      const d1 = (Math.log(spot / bucket.strike) + (0.046 + 0.5 * iv * iv) * T) / (iv * sqrtT);
      const pdf = normPDF(d1);
      const gamma = pdf / (spot * iv * sqrtT);
      callGexM = (bucket.callOI * gamma * 100 * (spot * spot) * 0.01) / 1e6;

      const T_vex = Math.max(1 / 365, (days + 0.5) / 365);
      const sqrtT_vex = Math.sqrt(T_vex);
      const d1_vex = (Math.log(spot / bucket.strike) + (0.045 - 0.012 + 0.5 * iv * iv) * T_vex) / (iv * sqrtT_vex);
      const d2_vex = d1_vex - iv * sqrtT_vex;
      const pdf_vex = normPDF(d1_vex);
      const discountQ_vex = Math.exp(-0.012 * T_vex);
      const vanna = -discountQ_vex * pdf_vex * (d2_vex / iv);
      callVexM = (bucket.callOI * vanna * 100 * spot * 0.01) / 1e6;
    }

    let putGexM = 0;
    let putVexM = 0;
    if (bucket.putOI > 0) {
      const iv = Math.max(0.02, Math.min(3.5, bucket.putIv));
      const d1 = (Math.log(spot / bucket.strike) + (0.046 + 0.5 * iv * iv) * T) / (iv * sqrtT);
      const pdf = normPDF(d1);
      const gamma = pdf / (spot * iv * sqrtT);
      putGexM = (bucket.putOI * gamma * 100 * (spot * spot) * 0.01) / 1e6;

      const T_vex = Math.max(1 / 365, (days + 0.5) / 365);
      const sqrtT_vex = Math.sqrt(T_vex);
      const d1_vex = (Math.log(spot / bucket.strike) + (0.045 - 0.012 + 0.5 * iv * iv) * T_vex) / (iv * sqrtT_vex);
      const d2_vex = d1_vex - iv * sqrtT_vex;
      const pdf_vex = normPDF(d1_vex);
      const discountQ_vex = Math.exp(-0.012 * T_vex);
      const vanna = -discountQ_vex * pdf_vex * (d2_vex / iv);
      putVexM = (bucket.putOI * vanna * 100 * spot * 0.01) / 1e6;
    }

    const netGexM = callGexM - putGexM;
    const netVexM = callVexM - putVexM;
    return mode === "GEX" ? netGexM : netGexM + netVexM;
  }

  for (const mode of ["GEX", "Combined"] as const) {
    const allExpTotals = new Map<number, number>();
    const zeroDteTotals = new Map<number, number>();
    const zeroDteIso = heatmapPayload.expirations[0].isoDate;

    for (const b of buckets) {
      const valM = evalBucket(spotPrice, b, mode);
      allExpTotals.set(b.strike, (allExpTotals.get(b.strike) ?? 0) + valM);
      if (b.expiration === zeroDteIso) {
        zeroDteTotals.set(b.strike, (zeroDteTotals.get(b.strike) ?? 0) + valM);
      }
    }

    const sortedAll = Array.from(allExpTotals.entries()).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    const sorted0Dte = Array.from(zeroDteTotals.entries()).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));

    console.log(`\n=== GAIA HARMONIZED (Mode: ${mode}) ===`);
    console.log("All-exp King:", sortedAll[0][0], "Value:", (sortedAll[0][1]/1000).toFixed(2) + "B (" + sortedAll[0][1].toFixed(1) + "M)");
    console.log("All-exp #2:", sortedAll[1][0], "Value:", (sortedAll[1][1]/1000).toFixed(2) + "B (" + sortedAll[1][1].toFixed(1) + "M)");
    console.log("0DTE King:", sorted0Dte[0][0], "Value:", (sorted0Dte[0][1]/1000).toFixed(2) + "B (" + sorted0Dte[0][1].toFixed(1) + "M)");
    console.log("0DTE #2:", sorted0Dte[1][0], "Value:", (sorted0Dte[1][1]/1000).toFixed(2) + "B (" + sorted0Dte[1][1].toFixed(1) + "M)");
  }

  // Also query live localhost:3000 endpoints
  console.log("\n=== LOCALHOST ENDPOINT VERIFICATION ===");
  try {
    const oRes = await fetch("http://localhost:3000/api/options?ticker=SPY");
    const oData = await oRes.json();
    console.log("Heatmap API (/api/options):");
    console.log("  All-exp King:", oData.kingNode?.allExpKing);
    console.log("  0DTE King:   ", oData.kingNode?.zeroDteKing);
    console.log("  King Value:  ", oData.kingNode?.kingValue);

    const gRes = await fetch("http://localhost:3000/api/gaia?ticker=SPY");
    const gData = await gRes.json();
    console.log("Gaia API (/api/gaia):");
    console.log("  Spot:        ", gData.spotPrice);
    console.log("  Buckets:     ", gData.optionBuckets?.length);
  } catch (e: any) {
    console.error("Localhost fetch error:", e?.message);
  }
}

testComparison().catch(console.error);
