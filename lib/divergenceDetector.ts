/**
 * Shared Non-Repainting 3-Left / 3-Right RSI14 + MACD-Histogram Pivot Divergence Detector.
 * Strictly causal: each pivot requires 3 completed bars on each side; forming bars are never used.
 * A confirmed signal stays active (BULL or BEAR) for 30 bars after pivot 2 once bar (p2 + 3) closes.
 */

export type CausalDivergenceStatus = "BULL" | "BEAR" | "NO";

export interface OhlcBarInput {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface EnrichedOhlcBar<T extends OhlcBarInput = OhlcBarInput> {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  rsi14: number;
  macdHist: number;
  raw?: T;
}

export interface DetectedGlobalPivotSignal {
  type: "BULL" | "BEAR";
  p1GlobalIdx: number;
  p1Price: number;
  p2GlobalIdx: number;
  p2Price: number;
  confirmedGlobalIdx: number;
  p2Timestamp: number;
  confirmedTimestamp: number;
}

export function enrichBarsWithRsiAndMacd<T extends OhlcBarInput>(
  bars: T[]
): Array<T & { rsi14: number; macdHist: number }> {
  const n = bars.length;
  const rsi14 = new Array<number>(n).fill(50);
  const period = 14;

  if (n > period) {
    let avgGain = 0;
    let avgLoss = 0;
    for (let i = 1; i <= period; i++) {
      const diff = bars[i].close - bars[i - 1].close;
      if (diff > 0) avgGain += diff;
      else avgLoss -= diff;
    }
    avgGain /= period;
    avgLoss /= period;
    rsi14[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

    for (let i = period + 1; i < n; i++) {
      const diff = bars[i].close - bars[i - 1].close;
      const gain = diff > 0 ? diff : 0;
      const loss = diff < 0 ? -diff : 0;
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      rsi14[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
  }

  const k12 = 2 / 13;
  const k26 = 2 / 27;
  const k9 = 2 / 10;
  let ema12 = bars[0]?.close ?? 0;
  let ema26 = bars[0]?.close ?? 0;
  let signal = 0;

  return bars.map((b, i) => {
    ema12 = b.close * k12 + ema12 * (1 - k12);
    ema26 = b.close * k26 + ema26 * (1 - k26);
    const macd = ema12 - ema26;
    signal = i === 0 ? macd : macd * k9 + signal * (1 - k9);
    const macdHist = macd - signal;
    return {
      ...b,
      rsi14: rsi14[i],
      macdHist,
    };
  });
}

export function detectGlobalPivotSignals(
  bars: Array<OhlcBarInput & { rsi14: number; macdHist: number }>
): DetectedGlobalPivotSignal[] {
  const n = bars.length;
  const pivotLows: number[] = [];
  const pivotHighs: number[] = [];

  for (let i = 3; i <= n - 4; i++) {
    const l = bars[i].low;
    const isLow =
      l <= bars[i - 3].low &&
      l <= bars[i - 2].low &&
      l <= bars[i - 1].low &&
      l <= bars[i + 1].low &&
      l <= bars[i + 2].low &&
      l <= bars[i + 3].low &&
      (l < bars[i - 1].low || l < bars[i + 1].low);

    if (isLow) pivotLows.push(i);

    const h = bars[i].high;
    const isHigh =
      h >= bars[i - 3].high &&
      h >= bars[i - 2].high &&
      h >= bars[i - 1].high &&
      h >= bars[i + 1].high &&
      h >= bars[i + 2].high &&
      h >= bars[i + 3].high &&
      (h > bars[i - 1].high || h > bars[i + 1].high);

    if (isHigh) pivotHighs.push(i);
  }

  const signals: DetectedGlobalPivotSignal[] = [];

  for (let k = 1; k < pivotLows.length; k++) {
    const p1 = pivotLows[k - 1];
    const p2 = pivotLows[k];
    if (
      bars[p2].low < bars[p1].low &&
      bars[p2].rsi14 > bars[p1].rsi14 &&
      bars[p2].macdHist > bars[p1].macdHist
    ) {
      const confIdx = p2 + 3;
      signals.push({
        type: "BULL",
        p1GlobalIdx: p1,
        p1Price: bars[p1].low,
        p2GlobalIdx: p2,
        p2Price: bars[p2].low,
        confirmedGlobalIdx: confIdx,
        p2Timestamp: bars[p2].ts,
        confirmedTimestamp: bars[confIdx].ts,
      });
    }
  }

  for (let k = 1; k < pivotHighs.length; k++) {
    const p1 = pivotHighs[k - 1];
    const p2 = pivotHighs[k];
    if (
      bars[p2].high > bars[p1].high &&
      bars[p2].rsi14 < bars[p1].rsi14 &&
      bars[p2].macdHist < bars[p1].macdHist
    ) {
      const confIdx = p2 + 3;
      signals.push({
        type: "BEAR",
        p1GlobalIdx: p1,
        p1Price: bars[p1].high,
        p2GlobalIdx: p2,
        p2Price: bars[p2].high,
        confirmedGlobalIdx: confIdx,
        p2Timestamp: bars[p2].ts,
        confirmedTimestamp: bars[confIdx].ts,
      });
    }
  }

  return signals;
}

export function evaluateTfStatusAtTimestamp(
  bars: Array<OhlcBarInput & { rsi14: number; macdHist: number }>,
  signals: DetectedGlobalPivotSignal[],
  targetTs: number
): CausalDivergenceStatus {
  if (bars.length === 0 || signals.length === 0) return "NO";

  let currentIdx = -1;
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].ts <= targetTs) {
      currentIdx = i;
    } else {
      break;
    }
  }
  if (currentIdx < 3) return "NO";

  let activeSignal: DetectedGlobalPivotSignal | null = null;
  for (const sig of signals) {
    if (currentIdx >= sig.confirmedGlobalIdx && currentIdx - sig.p2GlobalIdx <= 30) {
      if (!activeSignal || sig.p2GlobalIdx >= activeSignal.p2GlobalIdx) {
        activeSignal = sig;
      }
    }
  }

  return activeSignal ? activeSignal.type : "NO";
}

/**
 * Causally resamples sorted 5-minute OHLC bars into completed 30-minute buckets (1800s boundaries).
 */
export function aggregateBarsTo30m(bars5m: OhlcBarInput[]): OhlcBarInput[] {
  if (bars5m.length === 0) return [];
  const buckets = new Map<number, OhlcBarInput>();
  for (const b of bars5m) {
    const bucketTs = Math.floor(b.ts / 1800) * 1800;
    const existing = buckets.get(bucketTs);
    if (!existing) {
      buckets.set(bucketTs, {
        ts: bucketTs,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume ?? 0,
      });
    } else {
      existing.high = Math.max(existing.high, b.high);
      existing.low = Math.min(existing.low, b.low);
      existing.close = b.close;
      existing.volume = (existing.volume ?? 0) + (b.volume ?? 0);
    }
  }
  return Array.from(buckets.values()).sort((a, b) => a.ts - b.ts);
}

/**
 * Evaluates causal 5m and 30m RSI+MACD pivot divergence purely from local bar history.
 */
export function computeLocalMtfDivergence(
  closedBars5m: OhlcBarInput[],
  targetTs?: number
): { divergence5m: CausalDivergenceStatus; divergence30m: CausalDivergenceStatus } {
  if (closedBars5m.length < 8) {
    return { divergence5m: "NO", divergence30m: "NO" };
  }
  const evalTs = targetTs ?? closedBars5m[closedBars5m.length - 1].ts;
  const causal5m = closedBars5m.filter((b) => b.ts <= evalTs);
  if (causal5m.length < 8) {
    return { divergence5m: "NO", divergence30m: "NO" };
  }

  const enriched5m = enrichBarsWithRsiAndMacd(causal5m);
  const sig5m = detectGlobalPivotSignals(enriched5m);
  const divergence5m = evaluateTfStatusAtTimestamp(enriched5m, sig5m, evalTs);

  const bars30m = aggregateBarsTo30m(causal5m);
  const enriched30m = enrichBarsWithRsiAndMacd(bars30m);
  const sig30m = detectGlobalPivotSignals(enriched30m);
  const divergence30m = evaluateTfStatusAtTimestamp(enriched30m, sig30m, evalTs);

  return { divergence5m, divergence30m };
}
