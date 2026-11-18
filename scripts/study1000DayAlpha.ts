/**
 * 1,000-Day Historical Microstructure, Stop-Survival (MAE/MFE) & Alpha Study
 *
 * Strictly read-only against live trading engines — outputs empirical IS/OOS metrics across:
 *   1. 1,000+ trading days of SPY, QQQ & ^VIX daily OHLC (700d IS / 300d OOS)
 *   2. ~480 trading days of intraday 1h SPY & QQQ bars (330d IS / 150d OOS)
 *   3. 60 trading days of intraday 5m SPY & QQQ bars (40d IS / 20d OOS) for exact 5m-60m MAE/MFE
 *   4. All cached .cache/intraday-*.json GEX/Boundary-Flux sessions
 */

import fs from "fs";
import path from "path";
import { computeBarFlowGammaVwapSeries, type FlowGammaVwapSnapshot } from "../lib/flowGammaVwap";
import {
  computeRemainingYearsToExpiration,
  estimateDynamicAtmIv,
  priceOptionWithSkew,
} from "../lib/execution/optionPricing";
import { etMinutesOfDay, getTodayEt } from "../lib/gaiaSessionGuards";

interface OhlcvBar {
  ts: number; // epoch seconds
  dateEt: string;
  etMins: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface DailyVixBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  vix: number;
}

interface CachedTick {
  ts: number;
  spot: number;
  cw?: number;
  pw?: number;
  zg?: number;
}

type StopMode = "BASELINE_COUPLED" | "STRUCT_WICK" | "STRUCT_CLOSE";
type EntryTiming = "IMMEDIATE" | "PULLBACK_RETEST" | "TWO_BAR_CONFIRM";
type DeltaBucket = "DELTA_024_CAP100" | "DELTA_BEST_CAP100" | "DELTA_040_CAP175" | "DELTA_042_CAP250";
type ProfitMode = "FIXED_15R" | "RATCHET_CHOP_20R";

interface StrategyConfig {
  id: string;
  label: string;
  atrMult: number;
  stopMode: StopMode;
  entryTiming: EntryTiming;
  deltaBucket: DeltaBucket;
  profitMode: ProfitMode;
}

interface SimulatedTrade {
  ticker: string;
  dateEt: string;
  entryTimeMin: number;
  direction: "CALL" | "PUT";
  entrySpot: number;
  stopSpot: number;
  atr: number;
  optionAsk: number;
  optionExitBid: number;
  delta: number;
  dte: number;
  heldMinutes: number;
  exitReason: string;
  pnlPct: number;
  pnlDollars: number;
  rMultiple: number;
  maeAtr5m: number;
  maeAtr10m: number;
  maeAtr15m: number;
  maeAtr30m: number;
  maeAtr60m: number;
  mfeAtr5m: number;
  mfeAtr10m: number;
  mfeAtr15m: number;
  mfeAtr30m: number;
  mfeAtr60m: number;
}

interface PerformanceSummary {
  trades: number;
  skippedBudget: number;
  earlyStop10mPct: number;
  winRatePct: number;
  avgWinR: number;
  avgWinPct: number;
  avgLossR: number;
  avgLossPct: number;
  profitFactor: number;
  maxDrawdownDollars: number;
  netDollars: number;
  expectancyR: number;
  exitReasons: Record<string, number>;
}

async function fetchYahooSeries(
  symbol: string,
  interval: "1d" | "1h" | "5m",
  range: string
): Promise<OhlcvBar[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?interval=${interval}&range=${range}&includePrePost=false`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) HyperionResearch/1.0",
    },
  });
  if (!res.ok) {
    throw new Error(`Yahoo fetch failed for ${symbol} (${interval}/${range}): HTTP ${res.status}`);
  }
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  const timestamps: number[] = result?.timestamp ?? [];
  const quote = result?.indicators?.quote?.[0];
  if (!quote || timestamps.length === 0) return [];

  const out: OhlcvBar[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const o = quote.open?.[i];
    const h = quote.high?.[i];
    const l = quote.low?.[i];
    const c = quote.close?.[i];
    const v = quote.volume?.[i] ?? 1000;
    const ts = timestamps[i];
    if (
      typeof o !== "number" ||
      typeof h !== "number" ||
      typeof l !== "number" ||
      typeof c !== "number" ||
      !Number.isFinite(c) ||
      c <= 0
    ) {
      continue;
    }
    const dateEt = getTodayEt(new Date(ts * 1000));
    const etMins = etMinutesOfDay(ts);
    out.push({
      ts,
      dateEt,
      etMins,
      open: Number(o.toFixed(2)),
      high: Number(h.toFixed(2)),
      low: Number(l.toFixed(2)),
      close: Number(c.toFixed(2)),
      volume: Math.max(1, typeof v === "number" && Number.isFinite(v) ? v : 1000),
    });
  }
  return out;
}

function groupBySession(bars: OhlcvBar[]): Map<string, OhlcvBar[]> {
  const map = new Map<string, OhlcvBar[]>();
  for (const b of bars) {
    if (b.etMins < 570 || b.etMins >= 960) continue;
    const list = map.get(b.dateEt);
    if (list) list.push(b);
    else map.set(b.dateEt, [b]);
  }
  Array.from(map.values()).forEach((list) => {
    list.sort((a, b) => a.ts - b.ts);
  });
  return map;
}

function selectSyntheticOption(params: {
  spot: number;
  direction: "CALL" | "PUT";
  iv: number;
  tsSec: number;
  deltaBucket: DeltaBucket;
  ignoreBudgetOnSwing?: boolean;
}): {
  strike: number;
  dte: number;
  ask: number;
  bid: number;
  mid: number;
  delta: number;
  tYears: number;
} | null {
  const { spot, direction, iv, tsSec, deltaBucket, ignoreBudgetOnSwing } = params;
  const isCall = direction === "CALL";
  const maxAsk = ignoreBudgetOnSwing
    ? 99
    : deltaBucket === "DELTA_042_CAP250"
    ? 2.5
    : deltaBucket === "DELTA_040_CAP175"
    ? 1.75
    : 0.99;
  const minDelta =
    deltaBucket === "DELTA_024_CAP100"
      ? 0.22
      : deltaBucket === "DELTA_BEST_CAP100"
      ? 0.16
      : 0.35;
  const maxDelta =
    deltaBucket === "DELTA_024_CAP100"
      ? 0.28
      : deltaBucket === "DELTA_BEST_CAP100"
      ? 0.48
      : 0.48;
  const deltaTarget =
    deltaBucket === "DELTA_024_CAP100"
      ? 0.25
      : deltaBucket === "DELTA_BEST_CAP100"
      ? 0.40
      : 0.42;
  const halfSpreadPct = deltaBucket === "DELTA_024_CAP100" || deltaBucket === "DELTA_BEST_CAP100" ? 0.025 : 0.02;
  const stepUnit = spot >= 400 ? 1 : 0.5;
  const dtePool = ignoreBudgetOnSwing ? [1, 2] : [0, 1, 2];

  let best: {
    strike: number;
    dte: number;
    ask: number;
    bid: number;
    mid: number;
    delta: number;
    tYears: number;
    score: number;
  } | null = null;

  for (const dte of dtePool) {
    const tYears = computeRemainingYearsToExpiration(tsSec * 1000, dte);
    for (let step = 0; step <= 14; step++) {
      const strike = isCall
        ? Math.ceil(spot / stepUnit) * stepUnit + step * stepUnit
        : Math.floor(spot / stepUnit) * stepUnit - step * stepUnit;
      const quote = priceOptionWithSkew({
        spot,
        strike,
        direction: isCall ? "LONG" : "SHORT",
        remainingYears: tYears,
        atmIv: iv,
        halfSpreadPct,
      });
      const absDelta = Math.abs(quote.delta);
      const spreadPct = quote.ask > 0 ? (quote.ask - quote.bid) / quote.ask : 1;
      if (
        quote.ask >= 0.15 &&
        quote.ask <= maxAsk &&
        absDelta >= minDelta &&
        absDelta <= maxDelta &&
        quote.bid > 0 &&
        spreadPct <= 0.24
      ) {
        const dtePenalty = dte * 0.15;
        const score = 1 - Math.abs(absDelta - deltaTarget) - dtePenalty;
        if (!best || score > best.score) {
          best = {
            strike,
            dte,
            ask: quote.ask,
            bid: quote.bid,
            mid: quote.mid,
            delta: absDelta,
            tYears,
            score,
          };
        }
      }
    }
  }
  return best;
}

function summarizePerformance(trades: SimulatedTrade[], skippedBudget: number): PerformanceSummary {
  if (trades.length === 0) {
    return {
      trades: 0,
      skippedBudget,
      earlyStop10mPct: 0,
      winRatePct: 0,
      avgWinR: 0,
      avgWinPct: 0,
      avgLossR: 0,
      avgLossPct: 0,
      profitFactor: 0,
      maxDrawdownDollars: 0,
      netDollars: 0,
      expectancyR: 0,
      exitReasons: {},
    };
  }
  const wins = trades.filter((t) => t.pnlDollars > 0);
  const losses = trades.filter((t) => t.pnlDollars <= 0);
  const earlyStops = trades.filter((t) => t.pnlDollars <= 0 && t.heldMinutes <= 10);
  const grossWin = wins.reduce((s, t) => s + t.pnlDollars, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlDollars, 0));

  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  const exitReasons: Record<string, number> = {};
  for (const t of trades) {
    equity += t.pnlDollars;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
    exitReasons[t.exitReason] = (exitReasons[t.exitReason] ?? 0) + 1;
  }

  return {
    trades: trades.length,
    skippedBudget,
    earlyStop10mPct: Number(((earlyStops.length / trades.length) * 100).toFixed(1)),
    winRatePct: Number(((wins.length / trades.length) * 100).toFixed(1)),
    avgWinR: wins.length
      ? Number((wins.reduce((s, t) => s + t.rMultiple, 0) / wins.length).toFixed(2))
      : 0,
    avgWinPct: wins.length
      ? Number((wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length).toFixed(1))
      : 0,
    avgLossR: losses.length
      ? Number((losses.reduce((s, t) => s + t.rMultiple, 0) / losses.length).toFixed(2))
      : 0,
    avgLossPct: losses.length
      ? Number((losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length).toFixed(1))
      : 0,
    profitFactor: grossLoss > 0 ? Number((grossWin / grossLoss).toFixed(2)) : grossWin > 0 ? 99 : 0,
    maxDrawdownDollars: Number(maxDd.toFixed(2)),
    netDollars: Number(equity.toFixed(2)),
    expectancyR: Number((trades.reduce((s, t) => s + t.rMultiple, 0) / trades.length).toFixed(3)),
    exitReasons,
  };
}

function simulateIntradaySessions(params: {
  ticker: string;
  sessions: Array<{ dateEt: string; bars: OhlcvBar[]; vix: number; levels?: { pw?: number; cw?: number; zg?: number } }>;
  barMinutes: number;
  config: StrategyConfig;
}): { trades: SimulatedTrade[]; skippedBudget: number } {
  const { ticker, sessions, barMinutes, config } = params;
  const trades: SimulatedTrade[] = [];
  let skippedBudget = 0;

  let rollingEma9: number | null = null;
  const rollingCloses34: number[] = [];
  const rollingTr14: number[] = [];

  for (const sess of sessions) {
    const bars = sess.bars;
    if (bars.length < (barMinutes === 5 ? 12 : 4)) continue;
    const flowSeries: FlowGammaVwapSnapshot[] = computeBarFlowGammaVwapSeries(
      bars.map((b) => ({
        timestamp: b.ts,
        etMins: b.etMins,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
      }))
    );

    const iv = Math.max(0.11, Math.min(0.65, sess.vix / 100));
    let enteredToday = false;

    for (let i = 0; i < bars.length - 1; i++) {
      const b = bars[i];
      rollingEma9 = rollingEma9 === null ? b.close : rollingEma9 * 0.8 + b.close * 0.2;
      rollingCloses34.push(b.close);
      if (rollingCloses34.length > 34) rollingCloses34.shift();
      const sma34 = rollingCloses34.reduce((s, x) => s + x, 0) / rollingCloses34.length;

      const prevC = i > 0 ? bars[i - 1].close : b.open;
      const tr = Math.max(b.high - b.low, Math.abs(b.high - prevC), Math.abs(b.low - prevC));
      rollingTr14.push(tr);
      if (rollingTr14.length > 14) rollingTr14.shift();
      const atr = Math.max(
        b.close * 0.0008,
        rollingTr14.reduce((s, x) => s + x, 0) / rollingTr14.length
      );
      const ema9 = rollingEma9;

      if (enteredToday) continue;
      if (b.etMins < 575 || b.etMins > 870) continue;

      const snap = flowSeries[i];
      if (!snap) continue;

      // Signal trigger (causal expansion with strict polarity outside neutral chop)
      const prevSnap = i > 0 ? flowSeries[i - 1] : null;
      const chi = snap.ceilingShareChi ?? 0.5;
      const fluxJ = snap.netFluxJ ?? 0;
      const pe = snap.pecletNumber ?? 0;
      const minPeclet = barMinutes === 5 ? 0.85 : 0.45;
      const isBullSignal =
        chi >= 0.56 &&
        fluxJ > 0 &&
        pe >= minPeclet &&
        b.close > snap.flowVwap &&
        b.close > sma34 &&
        b.close > b.open;
      const isBearSignal =
        chi <= 0.44 &&
        fluxJ < 0 &&
        pe <= -minPeclet &&
        b.close < snap.flowVwap &&
        b.close < sma34 &&
        b.close < b.open;

      if (!isBullSignal && !isBearSignal) continue;
      const direction: "CALL" | "PUT" = isBullSignal ? "CALL" : "PUT";

      // Cached GEX wall clearance firewall when walls exist
      if (sess.levels) {
        const minClear = b.close >= 400 ? Math.max(2.25, b.close * 0.0032) : b.close * 0.0032;
        if (direction === "PUT" && sess.levels.pw && b.close >= sess.levels.pw && b.close - sess.levels.pw < minClear) {
          continue;
        }
        if (direction === "CALL" && sess.levels.cw && b.close <= sess.levels.cw && sess.levels.cw - b.close < minClear) {
          continue;
        }
      }

      // Entry Timing check
      let entryIdx = i;
      let entrySpot = b.close;
      if (config.entryTiming === "TWO_BAR_CONFIRM") {
        const prevB = bars[i - 1];
        if (!prevB || !prevSnap) continue;
        const prevChi = prevSnap.ceilingShareChi ?? 0.5;
        const prevAligned =
          direction === "CALL"
            ? prevB.close > prevSnap.flowVwap && prevChi >= 0.54
            : prevB.close < prevSnap.flowVwap && prevChi <= 0.46;
        if (!prevAligned) continue;
      } else if (config.entryTiming === "PULLBACK_RETEST") {
        const anchor = (snap.flowVwap + ema9) / 2;
        const limitTarget =
          direction === "CALL"
            ? Math.max(anchor, b.close - atr * 0.35)
            : Math.min(anchor, b.close + atr * 0.35);
        let filled = false;
        const maxWait = Math.min(bars.length - 2, i + (barMinutes === 5 ? 3 : 1));
        for (let w = i + 1; w <= maxWait; w++) {
          const wb = bars[w];
          if (wb.etMins > 870) break;
          if (direction === "CALL" && wb.low <= limitTarget && wb.close >= limitTarget - atr * 0.45) {
            entryIdx = w;
            entrySpot = Number(Math.max(wb.low, Math.min(wb.high, limitTarget)).toFixed(2));
            filled = true;
            break;
          }
          if (direction === "PUT" && wb.high >= limitTarget && wb.close <= limitTarget + atr * 0.45) {
            entryIdx = w;
            entrySpot = Number(Math.min(wb.high, Math.max(wb.low, limitTarget)).toFixed(2));
            filled = true;
            break;
          }
        }
        if (!filled) continue;
      }

      const entryBar = bars[entryIdx];
      const swingWindowStart = Math.max(0, entryIdx - 2);
      const swingLow = Math.min(...bars.slice(swingWindowStart, entryIdx + 1).map((x) => x.low));
      const swingHigh = Math.max(...bars.slice(swingWindowStart, entryIdx + 1).map((x) => x.high));

      const rawStopDist =
        config.atrMult <= 0.40
          ? Math.max(atr * config.atrMult, entrySpot * 0.0005)
          : Math.max(
              atr * config.atrMult,
              direction === "CALL" ? entrySpot - swingLow + atr * 0.1 : swingHigh - entrySpot + atr * 0.1
            );
      const cappedStopDist = Math.min(rawStopDist, atr * Math.max(config.atrMult, 1.5));
      const stopSpot =
        direction === "CALL"
          ? Number((entrySpot - cappedStopDist).toFixed(2))
          : Number((entrySpot + cappedStopDist).toFixed(2));
      const riskSpot = Math.max(0.1, Math.abs(entrySpot - stopSpot));

      const opt = selectSyntheticOption({
        spot: entrySpot,
        direction,
        iv,
        tsSec: entryBar.ts,
        deltaBucket: config.deltaBucket,
        ignoreBudgetOnSwing: barMinutes === 60,
      });
      if (!opt) {
        skippedBudget++;
        continue;
      }

      enteredToday = true;
      let activeStopSpot = stopSpot;
      let exitSpot = entrySpot;
      let exitTs = entryBar.ts;
      let exitReason = "MOC_1555";
      let peakOptPct = 0;
      let beArmed = false;

      // Measure unconstrained forward MAE & MFE across 5m..60m horizons (independent of trade exit)
      const maeByMin = { 5: 0, 10: 0, 15: 0, 30: 0, 60: 0 };
      const mfeByMin = { 5: 0, 10: 0, 15: 0, 30: 0, 60: 0 };
      let unconsMae = 0;
      let unconsMfe = 0;
      for (let m = entryIdx + 1; m < bars.length; m++) {
        const fb = bars[m];
        const elapsedMin = Math.max(barMinutes, Math.round((fb.ts - entryBar.ts) / 60));
        const barFav = direction === "CALL" ? fb.high - entrySpot : entrySpot - fb.low;
        const barAdv = direction === "CALL" ? entrySpot - fb.low : fb.high - entrySpot;
        unconsMae = Math.max(unconsMae, barAdv / atr);
        unconsMfe = Math.max(unconsMfe, barFav / atr);
        for (const h of [5, 10, 15, 30, 60] as const) {
          if (elapsedMin <= h) {
            maeByMin[h] = unconsMae;
            mfeByMin[h] = unconsMfe;
          }
        }
        if (elapsedMin >= 60) break;
      }
      // Monotonically carry forward shorter buckets if sparse
      maeByMin[10] = Math.max(maeByMin[10], maeByMin[5]);
      maeByMin[15] = Math.max(maeByMin[15], maeByMin[10]);
      maeByMin[30] = Math.max(maeByMin[30], maeByMin[15]);
      maeByMin[60] = Math.max(maeByMin[60], maeByMin[30], unconsMae);
      mfeByMin[10] = Math.max(mfeByMin[10], mfeByMin[5]);
      mfeByMin[15] = Math.max(mfeByMin[15], mfeByMin[10]);
      mfeByMin[30] = Math.max(mfeByMin[30], mfeByMin[15]);
      mfeByMin[60] = Math.max(mfeByMin[60], mfeByMin[30], unconsMfe);

      for (let j = entryIdx + 1; j < bars.length; j++) {
        const fb = bars[j];
        const elapsedMin = Math.max(barMinutes, Math.round((fb.ts - entryBar.ts) / 60));

        const tRem = computeRemainingYearsToExpiration(fb.ts * 1000, opt.dte);
        const qAtClose = priceOptionWithSkew({
          spot: fb.close,
          strike: opt.strike,
          direction: direction === "CALL" ? "LONG" : "SHORT",
          remainingYears: tRem,
          atmIv: iv,
          halfSpreadPct: config.deltaBucket === "DELTA_024_CAP100" ? 0.03 : 0.02,
        });
        const optPnlAtClose = ((qAtClose.bid - opt.ask) / opt.ask) * 100;
        peakOptPct = Math.max(peakOptPct, optPnlAtClose);

        // Worst intra-bar option mark for baseline/catastrophic checks
        const worstSpot = direction === "CALL" ? fb.low : fb.high;
        const qWorst = priceOptionWithSkew({
          spot: worstSpot,
          strike: opt.strike,
          direction: direction === "CALL" ? "LONG" : "SHORT",
          remainingYears: tRem,
          atmIv: iv,
          halfSpreadPct: config.deltaBucket === "DELTA_024_CAP100" ? 0.03 : 0.02,
        });
        const optPnlWorst = ((qWorst.bid - opt.ask) / opt.ask) * 100;

        // 1. EOD 15:55 MOC cutoff
        if (fb.etMins >= 955 || j === bars.length - 1) {
          exitSpot = fb.close;
          exitTs = fb.ts;
          exitReason = "MOC_1555";
          break;
        }

        // 2. Profit Management & Breakeven Ratchet
        const favAtClose = direction === "CALL" ? fb.close - entrySpot : entrySpot - fb.close;
        const favAtBest = direction === "CALL" ? fb.high - entrySpot : entrySpot - fb.low;
        const rBest = favAtBest / riskSpot;

        if (config.profitMode === "FIXED_15R") {
          const targetSpot =
            direction === "CALL" ? entrySpot + riskSpot * 1.5 : entrySpot - riskSpot * 1.5;
          if ((direction === "CALL" && fb.high >= targetSpot) || (direction === "PUT" && fb.low <= targetSpot)) {
            exitSpot = targetSpot;
            exitTs = fb.ts;
            exitReason = "TARGET_15R";
            break;
          }
        } else {
          // BE_115_TP_20R: BE at +1.15R or +40% option, 75m stagnant chop exit on 5m, runner to +2.0R
          if (!beArmed && (rBest >= 1.15 || peakOptPct >= 40)) {
            beArmed = true;
            activeStopSpot =
              direction === "CALL"
                ? Math.max(activeStopSpot, Number((entrySpot + riskSpot * 0.1).toFixed(2)))
                : Math.min(activeStopSpot, Number((entrySpot - riskSpot * 0.1).toFixed(2)));
          }
          if (barMinutes === 5 && elapsedMin >= 75 && !beArmed && favAtClose < riskSpot * 0.25) {
            exitSpot = fb.close;
            exitTs = fb.ts;
            exitReason = "CHOP_TIMEOUT_75M";
            break;
          }
          const runnerTarget =
            direction === "CALL" ? entrySpot + riskSpot * 2.0 : entrySpot - riskSpot * 2.0;
          if ((direction === "CALL" && fb.high >= runnerTarget) || (direction === "PUT" && fb.low <= runnerTarget)) {
            exitSpot = runnerTarget;
            exitTs = fb.ts;
            exitReason = "RUNNER_20R";
            break;
          }
        }

        // 3. Stop Evaluation
        if (config.stopMode === "BASELINE_COUPLED") {
          // Intra-bar wick stop OR 10m 0.50*ATR scratch OR 20m -25% stall OR -45% hard stop
          if ((direction === "CALL" && fb.low <= activeStopSpot) || (direction === "PUT" && fb.high >= activeStopSpot)) {
            exitSpot = activeStopSpot;
            exitTs = fb.ts;
            exitReason = "SPOT_WICK_STOP";
            break;
          }
          if (optPnlWorst <= -45) {
            exitSpot = worstSpot;
            exitTs = fb.ts;
            exitReason = "OPTION_HARD_STOP_45";
            break;
          }
          if (elapsedMin >= 20 && peakOptPct < 20 && optPnlWorst <= -25) {
            exitSpot = worstSpot;
            exitTs = fb.ts;
            exitReason = "OPTION_STALL_STOP_25";
            break;
          }
          const advAtClose = direction === "CALL" ? entrySpot - fb.close : fb.close - entrySpot;
          if (elapsedMin >= 10 && advAtClose >= atr * 0.5) {
            exitSpot = fb.close;
            exitTs = fb.ts;
            exitReason = "MIN_REVERSAL_SCRATCH";
            break;
          }
        } else if (config.stopMode === "STRUCT_WICK") {
          if ((direction === "CALL" && fb.low <= activeStopSpot) || (direction === "PUT" && fb.high >= activeStopSpot)) {
            exitSpot = activeStopSpot;
            exitTs = fb.ts;
            exitReason = "STRUCT_WICK_STOP";
            break;
          }
          if (optPnlWorst <= -45) {
            exitSpot = worstSpot;
            exitTs = fb.ts;
            exitReason = "CATASTROPHIC_45";
            break;
          }
        } else {
          // STRUCT_CLOSE: 5m/1h bar-close stop (wick-immune) + -45% catastrophic circuit breaker
          if ((direction === "CALL" && fb.close <= activeStopSpot) || (direction === "PUT" && fb.close >= activeStopSpot)) {
            exitSpot = fb.close;
            exitTs = fb.ts;
            exitReason = "STRUCT_CLOSE_STOP";
            break;
          }
          if (optPnlAtClose <= -45) {
            exitSpot = fb.close;
            exitTs = fb.ts;
            exitReason = "CATASTROPHIC_45";
            break;
          }
        }
      }

      const tExit = computeRemainingYearsToExpiration(exitTs * 1000, opt.dte);
      const qExit = priceOptionWithSkew({
        spot: exitSpot,
        strike: opt.strike,
        direction: direction === "CALL" ? "LONG" : "SHORT",
        remainingYears: tExit,
        atmIv: iv,
        halfSpreadPct: config.deltaBucket === "DELTA_024_CAP100" ? 0.03 : 0.02,
      });
      const exitBid = Math.max(0.01, qExit.bid);
      const pnlPct = ((exitBid - opt.ask) / opt.ask) * 100;
      const pnlDollars = (exitBid - opt.ask) * 100;
      const rMultiple = (direction === "CALL" ? exitSpot - entrySpot : entrySpot - exitSpot) / riskSpot;

      trades.push({
        ticker,
        dateEt: sess.dateEt,
        entryTimeMin: entryBar.etMins,
        direction,
        entrySpot,
        stopSpot,
        atr,
        optionAsk: opt.ask,
        optionExitBid: exitBid,
        delta: opt.delta,
        dte: opt.dte,
        heldMinutes: Math.max(barMinutes, Math.round((exitTs - entryBar.ts) / 60)),
        exitReason,
        pnlPct,
        pnlDollars,
        rMultiple,
        maeAtr5m: maeByMin[5],
        maeAtr10m: maeByMin[10],
        maeAtr15m: maeByMin[15],
        maeAtr30m: maeByMin[30],
        maeAtr60m: maeByMin[60],
        mfeAtr5m: mfeByMin[5],
        mfeAtr10m: mfeByMin[10],
        mfeAtr15m: mfeByMin[15],
        mfeAtr30m: mfeByMin[30],
        mfeAtr60m: mfeByMin[60],
      });
    }
  }
  return { trades, skippedBudget };
}

function loadCachedIntradaySessions(vixMap?: Map<string, number>): Array<{
  dateEt: string;
  bars: OhlcvBar[];
  vix: number;
  levels?: { pw?: number; cw?: number; zg?: number };
}> {
  const cacheDir = path.join(process.cwd(), ".cache");
  if (!fs.existsSync(cacheDir)) return [];
  const files = fs.readdirSync(cacheDir).filter((f) => f.startsWith("intraday-") && f.endsWith(".json")).sort();
  const out: Array<{
    dateEt: string;
    bars: OhlcvBar[];
    vix: number;
    levels?: { pw?: number; cw?: number; zg?: number };
  }> = [];

  for (const file of files) {
    const raw = JSON.parse(fs.readFileSync(path.join(cacheDir, file), "utf8"));
    const spy = raw.tickers?.SPY;
    if (!spy || !Array.isArray(spy.history)) continue;
    const byDateAndBucket = new Map<string, Map<number, OhlcvBar>>();
    for (const h of spy.history as CachedTick[]) {
      if (!h.ts || !h.spot) continue;
      const d = getTodayEt(new Date(h.ts * 1000));
      const em = etMinutesOfDay(h.ts);
      if (em < 570 || em >= 960) continue;
      const bTs = Math.floor(h.ts / 300) * 300;
      let dMap = byDateAndBucket.get(d);
      if (!dMap) {
        dMap = new Map();
        byDateAndBucket.set(d, dMap);
      }
      const existing = dMap.get(bTs);
      if (!existing) {
        dMap.set(bTs, {
          ts: bTs,
          dateEt: d,
          etMins: etMinutesOfDay(bTs),
          open: h.spot,
          high: h.spot,
          low: h.spot,
          close: h.spot,
          volume: 1000,
        });
      } else {
        existing.high = Math.max(existing.high, h.spot);
        existing.low = Math.min(existing.low, h.spot);
        existing.close = h.spot;
        existing.volume += 200;
      }
    }
    Array.from(byDateAndBucket.entries()).forEach(([dateEt, bMap]) => {
      const bars = Array.from(bMap.values()).sort((a, b) => a.ts - b.ts);
      if (bars.length >= 6) {
        const dynIv = estimateDynamicAtmIv(
          bars.map((b) => ({ close: b.close, high: b.high, low: b.low, timestamp: b.ts })),
          Math.min(bars.length - 1, 20),
          0.11
        );
        const derivedVix = Number((dynIv * 100).toFixed(1));
        out.push({
          dateEt,
          bars,
          vix: vixMap?.get(dateEt) ?? derivedVix,
          levels: spy.officialLevels
            ? {
                pw: spy.officialLevels.putWall,
                cw: spy.officialLevels.callWall,
                zg: spy.officialLevels.zeroGamma,
              }
            : undefined,
        });
      }
    });
  }
  return out;
}

function summarizeDaily1000Day(bars: DailyVixBar[], vixMap: Map<string, number>) {
  // Measures 1,000-day IS (700d) vs OOS (300d) intraday range vs ATR14 & VIX open-drive survival
  const slice = bars.slice(-1000);
  const isDays = slice.slice(0, 700);
  const oosDays = slice.slice(700);
  const calc = (days: DailyVixBar[]) => {
    let totalRangePct = 0;
    let closeTrendWin = 0;
    let valid = 0;
    for (let i = 14; i < days.length; i++) {
      const d = days[i];
      const vix = vixMap.get(d.date) ?? d.vix;
      const bodyPct = Math.abs(d.close - d.open) / d.open;
      const wickAgainst = d.close >= d.open ? (d.open - d.low) / d.open : (d.high - d.open) / d.open;
      totalRangePct += (d.high - d.low) / d.open;
      if (wickAgainst <= (vix / 100 / Math.sqrt(252)) * 0.45 && bodyPct > 0.002) {
        closeTrendWin++;
      }
      valid++;
    }
    return {
      days: days.length,
      avgRangePct: ((totalRangePct / Math.max(1, valid)) * 100).toFixed(2),
      cleanTrendPct: ((closeTrendWin / Math.max(1, valid)) * 100).toFixed(1),
    };
  };
  return { is: calc(isDays), oos: calc(oosDays) };
}

async function main() {
  console.log("================================================================================");
  console.log("   HYPERION 1,000-DAY MICROSTRUCTURE, MAE/MFE & ALPHA OPTIMIZATION STUDY       ");
  console.log("================================================================================\n");

  const [spy1d, qqq1d, vix1d, spy1h, qqq1h, spy5m, qqq5m] = await Promise.all([
    fetchYahooSeries("SPY", "1d", "5y"),
    fetchYahooSeries("QQQ", "1d", "5y"),
    fetchYahooSeries("^VIX", "1d", "5y"),
    fetchYahooSeries("SPY", "1h", "730d"),
    fetchYahooSeries("QQQ", "1h", "730d"),
    fetchYahooSeries("SPY", "5m", "60d"),
    fetchYahooSeries("QQQ", "5m", "60d"),
  ]);

  const vixMap = new Map<string, number>();
  for (const v of vix1d) vixMap.set(v.dateEt, v.close);

  const spyDailyVix: DailyVixBar[] = spy1d.map((b) => ({
    date: b.dateEt,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    vix: vixMap.get(b.dateEt) ?? 18,
  }));
  const qqqDailyVix: DailyVixBar[] = qqq1d.map((b) => ({
    date: b.dateEt,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    vix: vixMap.get(b.dateEt) ?? 20,
  }));

  const spyDailyStats = summarizeDaily1000Day(spyDailyVix, vixMap);
  const qqqDailyStats = summarizeDaily1000Day(qqqDailyVix, vixMap);
  console.log(`1,000-Day Daily+VIX Macro Split (700d IS / 300d OOS):`);
  console.log(`  SPY: IS(${spyDailyStats.is.days}d avgRange=${spyDailyStats.is.avgRangePct}%) | OOS(${spyDailyStats.oos.days}d avgRange=${spyDailyStats.oos.avgRangePct}%)`);
  console.log(`  QQQ: IS(${qqqDailyStats.is.days}d avgRange=${qqqDailyStats.is.avgRangePct}%) | OOS(${qqqDailyStats.oos.days}d avgRange=${qqqDailyStats.oos.avgRangePct}%)\n`);

  const buildSessions = (bars: OhlcvBar[], defaultVix: number) => {
    const grouped = groupBySession(bars);
    return Array.from(grouped.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([dateEt, sBars]) => ({
        dateEt,
        bars: sBars,
        vix: vixMap.get(dateEt) ?? defaultVix,
      }));
  };

  const spy1hSessions = buildSessions(spy1h, 17);
  const qqq1hSessions = buildSessions(qqq1h, 21);
  const spy5mSessions = buildSessions(spy5m, 17);
  const qqq5mSessions = buildSessions(qqq5m, 21);
  const cachedSessions = loadCachedIntradaySessions(vixMap);

  const splitIndex1h = Math.floor(spy1hSessions.length * 0.69); // ~335 IS / ~150 OOS
  const splitIndex5m = Math.floor(spy5mSessions.length * 0.67); // ~40 IS / ~20 OOS

  console.log(
    `Intraday Horizons Loaded: 1h=${spy1hSessions.length}d (${splitIndex1h}d IS / ${spy1hSessions.length - splitIndex1h}d OOS) | ` +
    `5m=${spy5mSessions.length}d (${splitIndex5m}d IS / ${spy5mSessions.length - splitIndex5m}d OOS) | ` +
    `Cached GEX/Flux=${cachedSessions.length} sessions\n`
  );

  // Build candidate grid
  const baselineConfig: StrategyConfig = {
    id: "BASELINE",
    label: "Baseline (0.35x ATR, Wick+25%Stall, Imm, 0.24Δ/$100, Fixed 1.5R)",
    atrMult: 0.35,
    stopMode: "BASELINE_COUPLED",
    entryTiming: "IMMEDIATE",
    deltaBucket: "DELTA_024_CAP100",
    profitMode: "FIXED_15R",
  };

  const candidates: StrategyConfig[] = [baselineConfig];
  for (const atrMult of [0.75, 1.0, 1.25]) {
    for (const stopMode of ["STRUCT_WICK", "STRUCT_CLOSE"] as const) {
      for (const entryTiming of ["IMMEDIATE", "PULLBACK_RETEST", "TWO_BAR_CONFIRM"] as const) {
        for (const deltaBucket of [
          "DELTA_024_CAP100",
          "DELTA_BEST_CAP100",
          "DELTA_040_CAP175",
          "DELTA_042_CAP250",
        ] as const) {
          for (const profitMode of ["FIXED_15R", "RATCHET_CHOP_20R"] as const) {
            candidates.push({
              id: `${atrMult}ATR_${stopMode}_${entryTiming}_${deltaBucket}_${profitMode}`,
              label: `${atrMult}x ATR · ${stopMode} · ${entryTiming} · ${deltaBucket} · ${profitMode}`,
              atrMult,
              stopMode,
              entryTiming,
              deltaBucket,
              profitMode,
            });
          }
        }
      }
    }
  }

  // Evaluate In-Sample (5m 40d IS + 1h 330d IS) strictly to rank Top 3 (zero OOS peeking)
  const isScores: Array<{
    config: StrategyConfig;
    validSample: boolean;
    score: number;
    is5m: PerformanceSummary;
    is1h: PerformanceSummary;
  }> = [];

  for (const cfg of candidates) {
    const r5Spy = simulateIntradaySessions({ ticker: "SPY", sessions: spy5mSessions.slice(0, splitIndex5m), barMinutes: 5, config: cfg });
    const r5Qqq = simulateIntradaySessions({ ticker: "QQQ", sessions: qqq5mSessions.slice(0, splitIndex5m), barMinutes: 5, config: cfg });
    const is5m = summarizePerformance([...r5Spy.trades, ...r5Qqq.trades], r5Spy.skippedBudget + r5Qqq.skippedBudget);

    const r1hSpy = simulateIntradaySessions({ ticker: "SPY", sessions: spy1hSessions.slice(0, splitIndex1h), barMinutes: 60, config: cfg });
    const r1hQqq = simulateIntradaySessions({ ticker: "QQQ", sessions: qqq1hSessions.slice(0, splitIndex1h), barMinutes: 60, config: cfg });
    const is1h = summarizePerformance([...r1hSpy.trades, ...r1hQqq.trades], r1hSpy.skippedBudget + r1hQqq.skippedBudget);

    const validSample = is5m.trades >= 12 && is1h.trades >= 25;
    const score = validSample
      ? (is5m.profitFactor - 0.5) * 3.0 +
        (is1h.profitFactor - 0.5) * 1.5 +
        (is5m.expectancyR * 2.0 + is1h.expectancyR * 1.0) -
        is5m.earlyStop10mPct * 0.02
      : -1e6 + is5m.trades + is1h.trades * 0.1;
    isScores.push({ config: cfg, validSample, score, is5m, is1h });
  }

  const sortRanked = (a: (typeof isScores)[number], b: (typeof isScores)[number]) => {
    if (a.validSample !== b.validSample) return a.validSample ? -1 : 1;
    return b.score - a.score;
  };

  const nonBaselineCap100 = isScores
    .filter(
      (s) =>
        s.config.id !== "BASELINE" &&
        (s.config.deltaBucket === "DELTA_024_CAP100" || s.config.deltaBucket === "DELTA_BEST_CAP100")
    )
    .sort(sortRanked);
  const top3Cap100 = nonBaselineCap100.slice(0, 3).map((s) => s.config);
  const bestCap175 = isScores
    .filter((s) => s.config.deltaBucket === "DELTA_040_CAP175")
    .sort(sortRanked)[0]?.config;
  const bestCap250 = isScores
    .filter((s) => s.config.deltaBucket === "DELTA_042_CAP250")
    .sort(sortRanked)[0]?.config;

  // Report 5m-60m MAE vs MFE distribution on OOS 5m bars under Baseline vs Best Candidate
  const evalMaeMfe = (cfg: StrategyConfig) => {
    const oosTrades = [
      ...simulateIntradaySessions({ ticker: "SPY", sessions: spy5mSessions.slice(splitIndex5m), barMinutes: 5, config: cfg }).trades,
      ...simulateIntradaySessions({ ticker: "QQQ", sessions: qqq5mSessions.slice(splitIndex5m), barMinutes: 5, config: cfg }).trades,
    ];
    const avg = (fn: (t: SimulatedTrade) => number) =>
      oosTrades.length ? (oosTrades.reduce((s, t) => s + fn(t), 0) / oosTrades.length).toFixed(2) : "0.00";
    const pctStop = (mult: number) =>
      oosTrades.length
        ? ((oosTrades.filter((t) => t.maeAtr10m >= mult).length / oosTrades.length) * 100).toFixed(1)
        : "0.0";
    return {
      n: oosTrades.length,
      mae5: avg((t) => t.maeAtr5m),
      mfe5: avg((t) => t.mfeAtr5m),
      mae10: avg((t) => t.maeAtr10m),
      mfe10: avg((t) => t.mfeAtr10m),
      mae15: avg((t) => t.maeAtr15m),
      mfe15: avg((t) => t.mfeAtr15m),
      mae30: avg((t) => t.maeAtr30m),
      mfe30: avg((t) => t.mfeAtr30m),
      mae60: avg((t) => t.maeAtr60m),
      mfe60: avg((t) => t.mfeAtr60m),
      breach035: pctStop(0.35),
      breach075: pctStop(0.75),
      breach100: pctStop(1.0),
      breach125: pctStop(1.25),
    };
  };

  console.log("=== 5m-60m OOS MAE vs MFE (in ATR5m multiples) ===");
  for (const cfg of [baselineConfig, ...top3Cap100.slice(0, 1), ...(bestCap175 ? [bestCap175] : [])]) {
    const mm = evalMaeMfe(cfg);
    console.log(`[${cfg.label}] (N=${mm.n})`);
    console.log(`  5m : MAE=${mm.mae5}x / MFE=${mm.mfe5}x | 10m: MAE=${mm.mae10}x / MFE=${mm.mfe10}x | 15m: MAE=${mm.mae15}x / MFE=${mm.mfe15}x`);
    console.log(`  30m: MAE=${mm.mae30}x / MFE=${mm.mfe30}x | 60m: MAE=${mm.mae60}x / MFE=${mm.mfe60}x`);
    console.log(`  10m Stop-Breach Rate: 0.35x=${mm.breach035}% | 0.75x=${mm.breach075}% | 1.00x=${mm.breach100}% | 1.25x=${mm.breach125}%\n`);
  }

  const evalRows = [
    baselineConfig,
    ...top3Cap100,
    ...(bestCap175 ? [bestCap175] : []),
    ...(bestCap250 ? [bestCap250] : []),
  ];

  console.log("=== IN-SAMPLE SELECTION SCORES ===");
  for (const row of [
    isScores.find((x) => x.config.id === "BASELINE"),
    ...nonBaselineCap100.slice(0, 3),
    isScores.filter((s) => s.config.deltaBucket === "DELTA_040_CAP175").sort(sortRanked)[0],
    isScores.filter((s) => s.config.deltaBucket === "DELTA_042_CAP250").sort(sortRanked)[0],
  ]) {
    if (!row) continue;
    console.log(
      JSON.stringify({
        id: row.config.id,
        valid: row.validSample,
        score: Number(row.score.toFixed(3)),
        is5mTrades: row.is5m.trades,
        is5mExpR: row.is5m.expectancyR,
        is5mPF: row.is5m.profitFactor,
        is5mNet: row.is5m.netDollars,
        is1hTrades: row.is1h.trades,
        is1hExpR: row.is1h.expectancyR,
        is1hPF: row.is1h.profitFactor,
      })
    );
  }

  console.log("\n=== OUT-OF-SAMPLE 1H INTRADAY (~150 DAYS SPY+QQQ, 1-2 DTE Swing Proxy) ===");
  for (const cfg of evalRows) {
    const s = simulateIntradaySessions({ ticker: "SPY", sessions: spy1hSessions.slice(splitIndex1h), barMinutes: 60, config: cfg });
    const q = simulateIntradaySessions({ ticker: "QQQ", sessions: qqq1hSessions.slice(splitIndex1h), barMinutes: 60, config: cfg });
    const perf = summarizePerformance([...s.trades, ...q.trades], s.skippedBudget + q.skippedBudget);
    console.log(JSON.stringify({ id: cfg.id, label: cfg.label, ...perf }));
  }

  console.log("\n=== OUT-OF-SAMPLE 5M INTRADAY (20 DAYS SPY+QQQ) ===");
  for (const cfg of evalRows) {
    const s = simulateIntradaySessions({ ticker: "SPY", sessions: spy5mSessions.slice(splitIndex5m), barMinutes: 5, config: cfg });
    const q = simulateIntradaySessions({ ticker: "QQQ", sessions: qqq5mSessions.slice(splitIndex5m), barMinutes: 5, config: cfg });
    const perf = summarizePerformance([...s.trades, ...q.trades], s.skippedBudget + q.skippedBudget);
    console.log(JSON.stringify({ id: cfg.id, label: cfg.label, ...perf }));
  }

  console.log("\n=== CACHED GEX/FLUX SESSIONS (.cache/intraday-*.json) ===");
  for (const cfg of evalRows) {
    const c = simulateIntradaySessions({ ticker: "SPY", sessions: cachedSessions, barMinutes: 5, config: cfg });
    const perf = summarizePerformance(c.trades, c.skippedBudget);
    console.log(JSON.stringify({ id: cfg.id, label: cfg.label, ...perf, tradeDetails: c.trades }));
  }
}

main().catch((err) => {
  console.error("Study failed:", err);
  process.exit(1);
});
