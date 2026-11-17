/**
 * Agentic Supervisor — Post-Market (16:05 ET) Attribution & Live-vs-Replay Shadow Parity Audit
 *
 * Compares live shadow trades recorded during the RTH session against deterministic
 * 5-minute bar-replay signals on that day's .cache/intraday-YYYY-MM-DD.json snapshot,
 * logging and persisting a ShadowParityReport into /api/signals and .cache/.
 */

import fs from "fs";
import path from "path";
import {
  computeRemainingYearsToExpiration,
  estimateDynamicAtmIv,
  evaluateUnifiedSniperSetup,
  getTodayEt,
  loadTradeStore,
  priceOptionWithSkew,
  saveTradeStore,
  type DailyTradeStore,
  type OptionTradePosition,
  type ShadowParityReport,
  type ShadowParityTradeDelta,
} from "@/lib/tradeSignalEngine";
import {
  computeBoundedExpectedMove,
  getMaxOtmDistance,
  resolveMinOptionDelta,
  scoreContractTaylorPayoff,
  type MicrostructuralRegime,
} from "@/lib/alphaScorer";
import {
  computeBarFlowGammaVwapSeries,
  type StructuralFlowNodes,
} from "@/lib/flowGammaVwap";
import { etMinutesOfDay, RTH_CLOSE_MINS, RTH_OPEN_MINS } from "@/lib/gaiaSessionGuards";

export type { ShadowParityReport, ShadowParityTradeDelta };

export interface IntradaySnapshotPoint {
  ts: number;
  time?: string;
  spot: number;
  callWall?: number;
  putWall?: number;
  zeroGamma?: number;
  cw?: number;
  pw?: number;
  zg?: number;
}

export interface IntradaySnapshotFile {
  date: string;
  tickers: Record<
    string,
    {
      history?: IntradaySnapshotPoint[];
      rthHistory?: IntradaySnapshotPoint[];
    }
  >;
}

export interface ReplayShadowTrade {
  ticker: string;
  direction: "CALL" | "PUT";
  setupName: string;
  strike: number;
  openedTs: number;
  openedTimeEt: string;
  closedTs: number;
  closedTimeEt: string;
  entrySpot: number;
  exitSpot: number;
  entryAsk: number;
  exitBid: number;
  exitReason: string;
}

export interface PostMarketAttributionParams {
  date?: string;
  ticker?: string;
  intradaySnapshot?: IntradaySnapshotFile | null;
  liveTrades?: OptionTradePosition[];
  replayTradesOverride?: ReplayShadowTrade[];
  persist?: boolean;
  matchWindowSec?: number;
}

interface ReplayBar5m {
  ts: number;
  timeEt: string;
  totalMinutes: number;
  open: number;
  high: number;
  low: number;
  close: number;
  sma34: number;
  callWall: number;
  putWall: number;
  zeroGamma: number;
}

function getCacheDir(): string {
  const dir = path.join(process.cwd(), ".cache");
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // ignore read-only runtime
    }
  }
  return dir;
}

function formatTimeEtFromSec(tsSec: number): string {
  return new Date(tsSec * 1000).toLocaleTimeString("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function normalizePosTicker(raw: string): string {
  const clean = raw.trim().toUpperCase().replace(/^\$/, "");
  return clean === "SPXW" || clean === "SPX" ? "SPY" : clean;
}

function inferStrikeStep(spot: number): number {
  if (spot >= 15000) return 25;
  if (spot >= 1500) return 5;
  if (spot >= 250) return 1;
  return 0.5;
}

function selectDeterministicReplayContract(params: {
  spot: number;
  direction: "LONG" | "SHORT";
  barTsSec: number;
  etMins: number;
  atmIv: number;
  target1Spot: number;
  callWall: number;
  putWall: number;
  zeroGamma: number;
  impulsePeclet?: number;
}) {
  const {
    spot,
    direction,
    barTsSec,
    etMins,
    atmIv,
    target1Spot,
    callWall,
    putWall,
    zeroGamma,
    impulsePeclet,
  } = params;
  const isCall = direction === "LONG";
  const maxOtmDist = getMaxOtmDistance(spot);
  const strikeStep = inferStrikeStep(spot);

  const deltaRoute = resolveMinOptionDelta({
    spotPrice: spot,
    zeroGamma,
    impulsePeclet,
  });
  const dteCandidates =
    deltaRoute.regime === "POS_GAMMA_PIN" ? [0, 1, 2] : [0, 1, 2];
  const remainingRthMins = Math.max(15, Math.min(390, RTH_CLOSE_MINS - etMins));
  const expectedMove = computeBoundedExpectedMove({
    spotPrice: spot,
    isCall,
    target1Spot,
    zeroDteCallWall: callWall > 0 ? callWall : undefined,
    zeroDtePutWall: putWall > 0 ? putWall : undefined,
    atmIv,
    remainingRthMinutes: remainingRthMins,
  });

  const stage1: Array<{
    strike: number;
    quote: ReturnType<typeof priceOptionWithSkew>;
    dteDays: number;
    remainingYears: number;
    score: number;
  }> = [];
  const stage2: typeof stage1 = [];

  for (const dteDays of dteCandidates) {
    const remainingYears = computeRemainingYearsToExpiration(barTsSec * 1000, dteDays);
    const holdDays = dteDays === 0 ? Math.max(0.15, remainingRthMins / 390) : 0.35;
    for (let step = 0; step <= 12; step++) {
      const baseStrike = isCall
        ? Math.ceil(spot / strikeStep) * strikeStep + step * strikeStep
        : Math.floor(spot / strikeStep) * strikeStep - step * strikeStep;
      const strike = Number(baseStrike.toFixed(2));
      if (Math.abs(strike - spot) > maxOtmDist) break;

      const quote = priceOptionWithSkew({
        spot,
        strike,
        direction,
        remainingYears,
        atmIv,
      });
      const absDelta = Math.abs(quote.delta);
      const spread = Math.max(0, quote.ask - quote.bid);
      const spreadPct = quote.ask > 0 ? spread / quote.ask : 1;
      if (
        quote.ask < 0.15 ||
        quote.ask > 0.99 ||
        spreadPct > 0.24 ||
        absDelta < deltaRoute.minDelta ||
        absDelta > deltaRoute.maxDelta
      ) {
        continue;
      }

      const taylor = scoreContractTaylorPayoff({
        absDelta,
        gamma: Math.max(0, quote.gamma),
        absTheta: Math.abs(quote.thetaPerDay),
        holdDays,
        spread,
        ask: quote.ask,
        expectedMove,
      });
      if (!taylor.eligible) continue;

      const cand = {
        strike,
        quote,
        dteDays,
        remainingYears,
        score: taylor.score,
      };
      if (dteDays === 0) stage1.push(cand);
      else stage2.push(cand);
    }
  }

  stage1.sort((a, b) => b.score - a.score);
  stage2.sort((a, b) => b.score - a.score);
  return stage1[0] ?? stage2[0] ?? null;
}

/**
 * Reconstructs deterministic 5-minute RTH bars and replays signals from an intraday snapshot.
 */
export function runDeterministicSnapshotReplay(params: {
  ticker: string;
  snapshot: IntradaySnapshotFile;
}): ReplayShadowTrade[] {
  const sym = params.ticker.trim().toUpperCase();
  const tickerBucket =
    params.snapshot.tickers?.[sym] ??
    params.snapshot.tickers?.[normalizePosTicker(sym)];
  if (!tickerBucket) return [];

  const rawPoints =
    Array.isArray(tickerBucket.rthHistory) && tickerBucket.rthHistory.length > 0
      ? tickerBucket.rthHistory
      : Array.isArray(tickerBucket.history)
        ? tickerBucket.history
        : [];
  if (rawPoints.length === 0) return [];

  const bucketMap = new Map<number, IntradaySnapshotPoint[]>();
  for (const pt of rawPoints) {
    if (!pt || typeof pt.ts !== "number" || typeof pt.spot !== "number" || pt.spot <= 0) continue;
    const etMins = etMinutesOfDay(pt.ts);
    if (etMins < RTH_OPEN_MINS || etMins > 955) continue;
    const bucket = Math.floor(pt.ts / 300) * 300;
    if (!bucketMap.has(bucket)) bucketMap.set(bucket, []);
    bucketMap.get(bucket)!.push(pt);
  }

  const bars: ReplayBar5m[] = [];
  for (const [bucketTs, ticks] of Array.from(bucketMap.entries()).sort((a, b) => a[0] - b[0])) {
    ticks.sort((a, b) => a.ts - b.ts);
    const lastPt = ticks[ticks.length - 1];
    const cw = lastPt.callWall ?? lastPt.cw ?? 0;
    const pw = lastPt.putWall ?? lastPt.pw ?? 0;
    const zg = lastPt.zeroGamma ?? lastPt.zg ?? 0;
    bars.push({
      ts: bucketTs,
      timeEt: formatTimeEtFromSec(bucketTs),
      totalMinutes: etMinutesOfDay(bucketTs),
      open: Number(ticks[0].spot.toFixed(2)),
      high: Number(Math.max(...ticks.map((t) => t.spot)).toFixed(2)),
      low: Number(Math.min(...ticks.map((t) => t.spot)).toFixed(2)),
      close: Number(lastPt.spot.toFixed(2)),
      sma34: Number(lastPt.spot.toFixed(2)),
      callWall: cw,
      putWall: pw,
      zeroGamma: zg,
    });
  }

  if (bars.length < 5) return [];

  for (let i = 0; i < bars.length; i++) {
    const startIdx = Math.max(0, i - 33);
    let sum = 0;
    for (let k = startIdx; k <= i; k++) sum += bars[k].close;
    bars[i].sma34 = Number((sum / (i - startIdx + 1)).toFixed(2));
  }

  const unifiedBars = bars.map((b) => ({
    timestampMs: b.ts * 1000,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: 10000,
  }));

  const refBar = bars[0];
  const structuralNodes: StructuralFlowNodes | undefined =
    refBar.callWall > 0 && refBar.putWall > 0
      ? {
          floorNode: refBar.putWall,
          ceilingNode: refBar.callWall,
          zeroGamma: refBar.zeroGamma > 0 ? refBar.zeroGamma : undefined,
        }
      : undefined;

  const sessionFlow = computeBarFlowGammaVwapSeries(
    bars.map((b) => ({
      timestamp: b.ts,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
    })),
    undefined,
    structuralNodes
  );

  const replayTrades: ReplayShadowTrade[] = [];
  const openingSlice = bars.slice(0, Math.min(3, bars.length));
  const openingLow = Math.min(...openingSlice.map((b) => b.low));
  const openingHigh = Math.max(...openingSlice.map((b) => b.high));

  let activePosition: {
    type: "CALL" | "PUT";
    setupName: string;
    strike: number;
    entrySpot: number;
    target1Spot: number;
    target2Spot: number;
    stopLossSpot: number;
    entryAsk: number;
    iv: number;
    dteDays: number;
    seenSmaSide: boolean;
    openedTimeEt: string;
    openedTs: number;
  } | null = null;

  let tradeCountToday = 0;
  let firstTradeType: "CALL" | "PUT" | null = null;
  let lastExitTs: number | null = null;

  for (let idx = 1; idx < bars.length; idx++) {
    const bar = bars[idx];

    if (activePosition) {
      const isCall = activePosition.type === "CALL";
      const isZeroGammaFlush = activePosition.setupName.includes("Bearish Zero-Gamma Flush");
      const heldMinutes = Math.round((bar.ts - activePosition.openedTs) / 60);
      if (isCall && bar.close >= bar.sma34) activePosition.seenSmaSide = true;
      if (!isCall && bar.close <= bar.sma34) activePosition.seenSmaSide = true;

      let exitTriggered = false;
      let exitReason = "";
      let exitSpot = bar.close;

      if (bar.totalMinutes >= 955 || idx === bars.length - 1) {
        exitTriggered = true;
        exitSpot = bar.close;
        exitReason = "3:55 PM EOD MARKET CLOSE CUTOFF";
      } else if (
        (isCall && bar.low <= activePosition.stopLossSpot) ||
        (!isCall && bar.high >= activePosition.stopLossSpot)
      ) {
        exitTriggered = true;
        exitSpot = activePosition.stopLossSpot;
        exitReason = "STOP LOSS HIT";
      } else if (
        heldMinutes >= 10 &&
        activePosition.seenSmaSide &&
        ((!isCall && bar.close > bar.sma34 && bar.close < activePosition.entrySpot) ||
          (isCall && bar.close < bar.sma34 && bar.close > activePosition.entrySpot))
      ) {
        exitTriggered = true;
        exitSpot = bar.close;
        exitReason = "MOMENTUM REVERSAL / DIVERGENCE COVER";
      } else if (
        (!isZeroGammaFlush &&
          ((isCall && bar.high >= activePosition.target1Spot) ||
            (!isCall && bar.low <= activePosition.target1Spot))) ||
        (isZeroGammaFlush && !isCall && bar.low <= activePosition.target2Spot && bar.close > bar.open)
      ) {
        exitTriggered = true;
        exitSpot = isZeroGammaFlush ? bar.close : activePosition.target1Spot;
        exitReason = isZeroGammaFlush
          ? "MOMENTUM REVERSAL / DIVERGENCE COVER"
          : "TARGET 1 PROFIT SECURED";
      }

      if (exitTriggered) {
        const remYears = computeRemainingYearsToExpiration(bar.ts * 1000, activePosition.dteDays);
        const exitQuote = priceOptionWithSkew({
          spot: exitSpot,
          strike: activePosition.strike,
          direction: isCall ? "LONG" : "SHORT",
          remainingYears: remYears,
          atmIv: activePosition.iv,
        });
        const stopFloor = Number((activePosition.entryAsk * 0.75).toFixed(2));
        let exitBid = Number(Math.max(0.05, exitQuote.bid).toFixed(2));
        if (exitReason.includes("STOP LOSS") && exitBid < stopFloor) {
          exitBid = stopFloor;
        }

        replayTrades.push({
          ticker: normalizePosTicker(sym),
          direction: activePosition.type,
          setupName: activePosition.setupName,
          strike: activePosition.strike,
          openedTs: activePosition.openedTs,
          openedTimeEt: activePosition.openedTimeEt,
          closedTs: bar.ts,
          closedTimeEt: bar.timeEt,
          entrySpot: activePosition.entrySpot,
          exitSpot,
          entryAsk: activePosition.entryAsk,
          exitBid,
          exitReason,
        });

        lastExitTs = bar.ts;
        activePosition = null;
      }
      continue;
    }

    const cooldownMet = lastExitTs !== null && bar.ts - lastExitTs >= 1800;
    const canLeg2Call =
      tradeCountToday === 1 &&
      firstTradeType === "PUT" &&
      cooldownMet &&
      bar.totalMinutes >= 630 &&
      bar.totalMinutes <= 870;
    const canLeg2Put =
      tradeCountToday === 1 &&
      firstTradeType === "CALL" &&
      cooldownMet &&
      bar.totalMinutes >= 630 &&
      bar.totalMinutes <= 870;

    if (
      (tradeCountToday === 0 || canLeg2Call || canLeg2Put) &&
      bar.totalMinutes >= 575 &&
      bar.totalMinutes <= 870
    ) {
      const flowSnap = sessionFlow[idx];
      if (tradeCountToday === 0) {
        const candidate = evaluateUnifiedSniperSetup(unifiedBars, idx);
        if (!candidate) continue;

        const isCall = candidate.direction === "LONG";
        const entrySpot = bar.close;
        const atmIv = candidate.features.atmIv;
        const rawStopSpot = isCall
          ? Math.min(bar.low, openingLow) * 0.9985
          : Math.max(bar.high, openingHigh) * 1.0015;
        const stopLossSpot = Number(rawStopSpot.toFixed(2));
        const risk = Math.max(0.65, Math.abs(entrySpot - stopLossSpot));
        const target1Spot = isCall
          ? Number((entrySpot + risk * 1.5).toFixed(2))
          : Number((entrySpot - risk * 1.5).toFixed(2));
        const target2Spot = isCall
          ? Number((entrySpot + risk * 2.5).toFixed(2))
          : Number((entrySpot - risk * 2.5).toFixed(2));

        const picked = selectDeterministicReplayContract({
          spot: entrySpot,
          direction: candidate.direction,
          barTsSec: bar.ts,
          etMins: bar.totalMinutes,
          atmIv,
          target1Spot,
          callWall: bar.callWall,
          putWall: bar.putWall,
          zeroGamma: bar.zeroGamma,
          impulsePeclet: flowSnap?.impulsePeclet,
        });
        if (!picked) continue;

        activePosition = {
          type: isCall ? "CALL" : "PUT",
          setupName: candidate.setupName,
          strike: picked.strike,
          entrySpot,
          target1Spot,
          target2Spot,
          stopLossSpot,
          entryAsk: picked.quote.ask,
          iv: atmIv,
          dteDays: picked.dteDays,
          seenSmaSide: isCall ? entrySpot >= bar.sma34 : entrySpot <= bar.sma34,
          openedTimeEt: bar.timeEt,
          openedTs: bar.ts,
        };
        firstTradeType = activePosition.type;
        tradeCountToday++;
      } else {
        const impChi = flowSnap?.impulseChi ?? 0.5;
        const dChi6 = flowSnap?.deltaChi6Bar ?? 0;
        const dImpChi6 = flowSnap?.deltaImpulseChi6Bar ?? 0;
        const dFlux6 = flowSnap?.deltaNetFlux6Bar ?? 0;
        const fvwap = flowSnap?.flowVwap ?? bar.close;
        const sigma = flowSnap?.sigma ?? Math.max(bar.close * 0.0015, 0.35);
        const lower1S = flowSnap?.lower1Sigma ?? 0;
        const upper1S = flowSnap?.upper1Sigma ?? 0;
        const recent4 = bars.slice(Math.max(0, idx - 3), idx + 1);
        const recentLow4 = Math.min(...recent4.map((b) => b.low));
        const recentHigh4 = Math.max(...recent4.map((b) => b.high));
        const priorBars = bars.slice(0, idx + 1);
        const causalPw = Math.floor(Math.min(...priorBars.map((b) => b.low)));
        const causalCw = Math.ceil(Math.max(...priorBars.map((b) => b.high)));
        const barBody = bar.close - bar.open;
        const maxBody = Math.max(0.45, bar.close * 0.003);
        const minRoom = Math.max(0.5, bar.close * 0.002);

        const testedPutWallOrMinus1S =
          (causalPw > 0 && Math.abs(recentLow4 - causalPw) / causalPw <= 0.0035) ||
          (lower1S > 0 && (Math.abs(recentLow4 - lower1S) / lower1S <= 0.0035 || recentLow4 <= lower1S));
        const testedCallWallOrPlus1S =
          (causalCw > 0 && Math.abs(recentHigh4 - causalCw) / causalCw <= 0.0035) ||
          (upper1S > 0 && (Math.abs(recentHigh4 - upper1S) / upper1S <= 0.0035 || recentHigh4 >= upper1S));

        let leg2Dir: "CALL" | "PUT" | null = null;
        let leg2Setup = "";
        let leg2Stop = 0;

        if (
          canLeg2Call &&
          testedPutWallOrMinus1S &&
          impChi >= 0.60 &&
          dFlux6 > 0 &&
          (dChi6 >= 0.03 || dImpChi6 >= 0.06) &&
          barBody <= maxBody &&
          causalCw - bar.close >= minRoom &&
          bar.close > bar.open &&
          bar.close >= fvwap &&
          bar.close >= bar.sma34
        ) {
          leg2Dir = "CALL";
          leg2Setup = "Leg-2 Put Wall / -1σ Bullish Reclaim";
          leg2Stop = Number(Math.min(recentLow4 - sigma * 0.15, bar.close - Math.max(0.4, bar.close * 0.0011)).toFixed(2));
        } else if (
          canLeg2Put &&
          testedCallWallOrPlus1S &&
          impChi <= 0.40 &&
          dFlux6 < 0 &&
          (dChi6 <= -0.03 || dImpChi6 <= -0.06) &&
          -barBody <= maxBody &&
          bar.close - causalPw >= minRoom &&
          bar.close < bar.open &&
          bar.close <= fvwap &&
          bar.close <= bar.sma34
        ) {
          leg2Dir = "PUT";
          leg2Setup = "Leg-2 Call Wall / +1σ Bearish Rejection";
          leg2Stop = Number(Math.max(recentHigh4 + sigma * 0.15, bar.close + Math.max(0.4, bar.close * 0.0011)).toFixed(2));
        }

        if (!leg2Dir) continue;
        const isCall = leg2Dir === "CALL";
        const entrySpot = bar.close;
        const atmIv = estimateDynamicAtmIv(unifiedBars, idx);
        const risk = Math.max(0.5, Math.abs(entrySpot - leg2Stop));
        const target1Spot = isCall
          ? Number((entrySpot + Math.max(bar.close * 0.0016, risk * 1.5)).toFixed(2))
          : Number((entrySpot - Math.max(bar.close * 0.0016, risk * 1.5)).toFixed(2));
        const target2Spot = isCall
          ? Number((target1Spot + risk).toFixed(2))
          : Number((target1Spot - risk).toFixed(2));

        const picked = selectDeterministicReplayContract({
          spot: entrySpot,
          direction: isCall ? "LONG" : "SHORT",
          barTsSec: bar.ts,
          etMins: bar.totalMinutes,
          atmIv,
          target1Spot,
          callWall: bar.callWall || causalCw,
          putWall: bar.putWall || causalPw,
          zeroGamma: bar.zeroGamma,
          impulsePeclet: flowSnap?.impulsePeclet,
        });
        if (!picked) continue;

        activePosition = {
          type: leg2Dir,
          setupName: leg2Setup,
          strike: picked.strike,
          entrySpot,
          target1Spot,
          target2Spot,
          stopLossSpot: leg2Stop,
          entryAsk: picked.quote.ask,
          iv: atmIv,
          dteDays: picked.dteDays,
          seenSmaSide: isCall ? entrySpot >= bar.sma34 : entrySpot <= bar.sma34,
          openedTimeEt: bar.timeEt,
          openedTs: bar.ts,
        };
        tradeCountToday++;
      }
    }
  }

  return replayTrades;
}

function saveShadowParityToDisk(report: ShadowParityReport): void {
  const dir = getCacheDir();
  const parityPath = path.join(dir, `shadow-parity-${report.date}.json`);
  const tmpPath = `${parityPath}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(report, null, 2), "utf-8");
    fs.renameSync(tmpPath, parityPath);
  } catch {
    // ignore read-only runtime errors
  } finally {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {}
  }

  const todayEt = getTodayEt();
  if (report.date === todayEt) {
    const store = loadTradeStore();
    store.shadowParityReport = report;
    saveTradeStore(store);
    return;
  }

  const histStorePath = path.join(dir, `active-trades-${report.date}.json`);
  if (fs.existsSync(histStorePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(histStorePath, "utf-8")) as DailyTradeStore;
      if (parsed && parsed.date === report.date) {
        parsed.shadowParityReport = report;
        const histTmp = `${histStorePath}.tmp.${process.pid}.${Date.now()}`;
        fs.writeFileSync(histTmp, JSON.stringify(parsed, null, 2), "utf-8");
        fs.renameSync(histTmp, histStorePath);
      }
    } catch {
      // non-fatal
    }
  }
}

/**
 * Loads the persisted ShadowParityReport for a given date if available.
 */
export function loadShadowParityReport(date?: string): ShadowParityReport | null {
  const targetDate = date || getTodayEt();
  const store = loadTradeStore(targetDate);
  if (store.shadowParityReport && store.shadowParityReport.date === targetDate) {
    return store.shadowParityReport;
  }
  const parityPath = path.join(getCacheDir(), `shadow-parity-${targetDate}.json`);
  if (fs.existsSync(parityPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(parityPath, "utf-8")) as ShadowParityReport;
      if (parsed && parsed.date === targetDate) return parsed;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 16:05 ET Post-Market Attribution & Live-vs-Replay Shadow Parity Audit.
 *
 * Compares live shadow trades recorded during the session against deterministic
 * bar-replay signals on that day's .cache/intraday-YYYY-MM-DD.json snapshot.
 */
export function runPostMarketAttribution(
  params?: PostMarketAttributionParams
): ShadowParityReport {
  const targetDate = params?.date || getTodayEt();
  const targetTicker = normalizePosTicker(params?.ticker || "SPY");
  const matchWindowSec = params?.matchWindowSec ?? 900;
  const shouldPersist = params?.persist !== false;

  let snapshot: IntradaySnapshotFile | null = params?.intradaySnapshot ?? null;
  if (!snapshot) {
    const snapshotPath = path.join(getCacheDir(), `intraday-${targetDate}.json`);
    if (fs.existsSync(snapshotPath)) {
      try {
        snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf-8")) as IntradaySnapshotFile;
      } catch {
        snapshot = null;
      }
    }
  }

  let liveTrades: OptionTradePosition[];
  if (Array.isArray(params?.liveTrades)) {
    liveTrades = params.liveTrades;
  } else {
    const store = loadTradeStore(targetDate);
    const mergedMap = new Map<string, OptionTradePosition>();
    for (const p of store.closedPositions || []) {
      if (p) mergedMap.set(p.id, p);
    }
    for (const p of Object.values(store.activePositions || {})) {
      if (p) mergedMap.set(p.id, p);
    }
    liveTrades = Array.from(mergedMap.values()).filter(
      (p) => !params?.ticker || normalizePosTicker(p.ticker) === targetTicker
    );
  }
  liveTrades = [...liveTrades].sort((a, b) => a.openedTs - b.openedTs);

  if (!snapshot && !params?.replayTradesOverride) {
    const noSnapReport: ShadowParityReport = {
      date: targetDate,
      ticker: targetTicker,
      generatedAt: new Date().toISOString(),
      replayTradeCount: 0,
      liveTradeCount: liveTrades.length,
      matchedTrades: 0,
      missedLiveTrades: 0,
      extraLiveTrades: liveTrades.length,
      slippageDriftDollars: 0,
      parityScorePct: liveTrades.length === 0 ? 100 : 0,
      status: "NO_SNAPSHOT",
      details: [],
    };
    if (shouldPersist) saveShadowParityToDisk(noSnapReport);
    console.log(
      `[AgenticSupervisor] 16:05 ET Attribution (${targetDate} ${targetTicker}): NO_SNAPSHOT (liveTrades=${liveTrades.length})`
    );
    return noSnapReport;
  }

  const replayTrades = (
    params?.replayTradesOverride ??
    runDeterministicSnapshotReplay({
      ticker: targetTicker,
      snapshot: snapshot!,
    })
  ).sort((a, b) => a.openedTs - b.openedTs);

  const usedLiveIds = new Set<string>();
  const details: ShadowParityTradeDelta[] = [];
  let matchedTrades = 0;
  let slippageDriftDollars = 0;

  for (const rep of replayTrades) {
    let bestMatch: OptionTradePosition | null = null;
    let bestDiff = Infinity;

    for (const live of liveTrades) {
      if (usedLiveIds.has(live.id)) continue;
      if (normalizePosTicker(live.ticker) !== normalizePosTicker(rep.ticker)) continue;
      if (live.contractType !== rep.direction) continue;
      const diff = Math.abs(live.openedTs - rep.openedTs);
      if (diff <= matchWindowSec && diff < bestDiff) {
        bestDiff = diff;
        bestMatch = live;
      }
    }

    if (bestMatch) {
      usedLiveIds.add(bestMatch.id);
      matchedTrades++;
      const qty = bestMatch.contractsQty || 1;
      const liveEntryAsk =
        typeof bestMatch.optionAsk === "number" && bestMatch.optionAsk > 0
          ? bestMatch.optionAsk
          : bestMatch.btoOptionMid;
      const entrySlippageDollars = Number(((liveEntryAsk - rep.entryAsk) * 100 * qty).toFixed(2));
      const hasLiveExit =
        typeof bestMatch.closedOptionMid === "number" &&
        Number.isFinite(bestMatch.closedOptionMid);
      const exitSlippageDollars = hasLiveExit
        ? Number(((rep.exitBid - (bestMatch.closedOptionMid as number)) * 100 * qty).toFixed(2))
        : 0;
      const totalSlippageDollars = Number((entrySlippageDollars + exitSlippageDollars).toFixed(2));
      slippageDriftDollars = Number((slippageDriftDollars + totalSlippageDollars).toFixed(2));

      details.push({
        ticker: rep.ticker,
        direction: rep.direction,
        replayTimeEt: rep.openedTimeEt,
        replayTs: rep.openedTs,
        replayStrike: rep.strike,
        replayEntryAsk: rep.entryAsk,
        replayExitPrice: rep.exitBid,
        liveTradeId: bestMatch.id,
        liveTimeEt: bestMatch.openedAt,
        liveTs: bestMatch.openedTs,
        liveStrike: bestMatch.strike,
        liveEntryAsk,
        liveExitPrice: hasLiveExit ? (bestMatch.closedOptionMid as number) : undefined,
        matched: true,
        entrySlippageDollars,
        totalSlippageDollars,
      });
    } else {
      details.push({
        ticker: rep.ticker,
        direction: rep.direction,
        replayTimeEt: rep.openedTimeEt,
        replayTs: rep.openedTs,
        replayStrike: rep.strike,
        replayEntryAsk: rep.entryAsk,
        replayExitPrice: rep.exitBid,
        matched: false,
        entrySlippageDollars: 0,
        totalSlippageDollars: 0,
      });
    }
  }

  const missedLiveTrades = replayTrades.length - matchedTrades;
  const extraLiveTrades = liveTrades.length - matchedTrades;
  const parityScorePct =
    replayTrades.length > 0
      ? Number(((matchedTrades / replayTrades.length) * 100).toFixed(1))
      : liveTrades.length === 0
        ? 100
        : 0;
  const status: ShadowParityReport["status"] =
    missedLiveTrades === 0 && Math.abs(slippageDriftDollars) <= 25 ? "PASS" : "DRIFT_WARNING";

  const report: ShadowParityReport = {
    date: targetDate,
    ticker: targetTicker,
    generatedAt: new Date().toISOString(),
    replayTradeCount: replayTrades.length,
    liveTradeCount: liveTrades.length,
    matchedTrades,
    missedLiveTrades,
    extraLiveTrades,
    slippageDriftDollars,
    parityScorePct,
    status,
    details,
  };

  if (shouldPersist) {
    saveShadowParityToDisk(report);
  }

  console.log(
    `[AgenticSupervisor] shadowParityReport (${targetDate} ${targetTicker}): matchedTrades=${matchedTrades}, missedLiveTrades=${missedLiveTrades}, slippageDriftDollars=$${slippageDriftDollars.toFixed(2)}, parity=${parityScorePct}% [${status}]`
  );

  return report;
}
