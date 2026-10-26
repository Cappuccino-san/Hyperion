/**
 * High-Performance Flow VWAP × Gamma Quantitative Engine
 *
 * Implements Dollar-Gamma Trade Weighting, Incremental Weighted Mean (Flow VWAP),
 * and Running Weighted Variance with dynamic ±1σ and ±2σ dispersion bands,
 * matching the Skylit Atlas microstructure chart specification.
 */

export type AggressorSide =
  | "BUY_ASK"
  | "SELL_BID"
  | "CROSS_MID"
  | "UNKNOWN";

export type OptionContractType = "CALL" | "PUT" | "C" | "P";

export interface OptionFlowTradeInput {
  timestamp?: number;
  strike: number;
  optionType: OptionContractType;
  size: number;
  premium: number; // Option premium per share (e.g. $2.50)
  spot: number; // Underlying spot price St
  gamma: number; // Contract Black-Scholes gamma
  aggressorSide?: AggressorSide;
}

export interface FlowGammaVwapSnapshot {
  timestamp: number;
  spot: number;
  flowVwap: number;
  upper1s: number;
  lower1s: number;
  upper2s: number;
  lower2s: number;
  upper1Sigma: number;
  lower1Sigma: number;
  upper2Sigma: number;
  lower2Sigma: number;
  sigma: number;
  variance: number;
  cumGammaWeight: number;
  totalWeight: number;
  signedGammaAcceleration: number;
  count: number;
}

/**
 * Computes Dollar-Gamma Trade Weighting for an option trade print:
 * Weight_i = | Pi_i * Gamma_i * S_t^2 * 0.01 |
 * Where Pi_i = size * premium * 100 (total dollar premium transacted)
 */
export function calculateDollarGammaWeight(trade: OptionFlowTradeInput): {
  weight: number;
  signedWeight: number;
  premiumDollars: number;
} {
  const { size, premium, spot, gamma, optionType, aggressorSide } = trade;

  const validSize = Number.isFinite(size) && size > 0 ? size : 0;
  const validPremium = Number.isFinite(premium) && premium > 0 ? premium : 0;
  const validSpot = Number.isFinite(spot) && spot > 0 ? spot : 0;
  const validGamma = Number.isFinite(gamma) && gamma > 0 ? gamma : 0;

  const premiumDollars = validSize * validPremium * 100;
  const rawWeight = Math.abs(premiumDollars * validGamma * (validSpot * validSpot) * 0.01);
  const weight = Number.isFinite(rawWeight) ? rawWeight : 0;

  // Directional acceleration:
  // Calls lifting ask: Bullish (+Weight)
  // Calls hitting bid or Puts lifting ask: Bearish (-Weight)
  const isCall = optionType === "CALL" || optionType === "C";
  let sign = 1;

  if (aggressorSide === "BUY_ASK") {
    sign = isCall ? 1 : -1;
  } else if (aggressorSide === "SELL_BID") {
    sign = isCall ? -1 : 1;
  } else {
    sign = isCall ? 1 : -1;
  }

  return {
    weight,
    signedWeight: sign * weight,
    premiumDollars,
  };
}

/**
 * Stateful incremental calculator for Flow VWAP × Gamma and dynamic dispersion bands.
 */
export class FlowGammaVwapEngine {
  private sumWeight = 0;
  private sumWeightedSpot = 0;
  private sumWeightedSpotSq = 0;
  private runningSignedAccel = 0;
  private tradeCount = 0;
  private lastKnownSpot = 0;
  private lastTimestamp = 0;
  private sessionResetTimestamp = 0;

  constructor(initialSpot = 0) {
    if (initialSpot > 0) {
      this.lastKnownSpot = initialSpot;
    }
  }

  /**
   * Resets session accumulators to zero (at 9:30 AM ET or on demand).
   */
  public reset(currentSpot?: number): void {
    this.sumWeight = 0;
    this.sumWeightedSpot = 0;
    this.sumWeightedSpotSq = 0;
    this.runningSignedAccel = 0;
    this.tradeCount = 0;
    if (typeof currentSpot === "number" && currentSpot > 0) {
      this.lastKnownSpot = currentSpot;
    }
    this.sessionResetTimestamp = Date.now();
  }

  /**
   * Adds an incoming option trade print and updates running state.
   */
  public addTrade(trade: OptionFlowTradeInput): FlowGammaVwapSnapshot {
    if (trade.spot > 0) {
      this.lastKnownSpot = trade.spot;
    }
    const ts = trade.timestamp || Date.now();
    this.lastTimestamp = ts;

    const { weight, signedWeight } = calculateDollarGammaWeight(trade);
    return this.addPoint(this.lastKnownSpot, weight, ts, signedWeight);
  }

  /**
   * Adds a spot tick with a specified gamma weight (or 0 for zero-flow quote ticks).
   */
  public addSpotTick(
    spot: number,
    weight = 0,
    timestamp?: number
  ): FlowGammaVwapSnapshot {
    if (spot > 0) {
      this.lastKnownSpot = spot;
    }
    const ts = timestamp || (this.lastTimestamp > 0 ? this.lastTimestamp : Date.now());
    this.lastTimestamp = ts;
    return this.addPoint(this.lastKnownSpot, weight, ts);
  }

  /**
   * Core weighted incremental update.
   */
  public addPoint(
    spot: number,
    weight: number,
    timestamp?: number,
    signedWeight?: number
  ): FlowGammaVwapSnapshot {
    const validSpot = Number.isFinite(spot) && spot > 0 ? spot : this.lastKnownSpot;
    const validWeight = Number.isFinite(weight) && weight >= 0 ? weight : 0;
    const ts = timestamp ?? (this.lastTimestamp > 0 ? this.lastTimestamp : Date.now());

    this.lastKnownSpot = validSpot;
    this.lastTimestamp = ts;

    if (validWeight > 0) {
      this.sumWeight += validWeight;
      this.sumWeightedSpot += validSpot * validWeight;
      this.sumWeightedSpotSq += validSpot * validSpot * validWeight;
      this.runningSignedAccel += signedWeight ?? validWeight;
      this.tradeCount += 1;
    }

    return this.getSnapshot();
  }

  /**
   * Returns current snapshot of Flow VWAP, sigma, and dispersion bands.
   */
  public getSnapshot(): FlowGammaVwapSnapshot {
    const spot = this.lastKnownSpot > 0 ? this.lastKnownSpot : 0;
    const ts = this.lastTimestamp > 0 ? this.lastTimestamp : Date.now();

    // Zero flow prints default gracefully to spot without NaN or divide-by-zero errors
    if (this.sumWeight <= 0) {
      const defaultSigma = Math.sqrt(0.10);
      return {
        timestamp: ts,
        spot,
        flowVwap: spot,
        upper1s: spot + defaultSigma,
        lower1s: spot - defaultSigma,
        upper2s: spot + 2 * defaultSigma,
        lower2s: spot - 2 * defaultSigma,
        upper1Sigma: spot + defaultSigma,
        lower1Sigma: spot - defaultSigma,
        upper2Sigma: spot + 2 * defaultSigma,
        lower2Sigma: spot - 2 * defaultSigma,
        sigma: defaultSigma,
        variance: 0.10,
        cumGammaWeight: 0,
        totalWeight: 0,
        signedGammaAcceleration: this.runningSignedAccel,
        count: this.tradeCount,
      };
    }

    // Weighted mean: VWAP_gamma = (sum W_i * S_i) / (sum W_i)
    const flowVwap = this.sumWeightedSpot / this.sumWeight;

    // Running sample variance: sigma^2 = (sum W_i * (S_i - VWAP)^2) / (sum W_i)
    // Numerically: (sum W_i * S_i^2 / sum W_i) - VWAP^2
    const meanOfSquares = this.sumWeightedSpotSq / this.sumWeight;
    const rawVariance = meanOfSquares - (flowVwap * flowVwap);
    const clampedVariance = Math.max(0.10, Number.isFinite(rawVariance) ? rawVariance : 0.10);
    const sigma = Math.sqrt(clampedVariance);

    const upper1 = flowVwap + sigma;
    const lower1 = flowVwap - sigma;
    const upper2 = flowVwap + 2 * sigma;
    const lower2 = flowVwap - 2 * sigma;

    return {
      timestamp: ts,
      spot,
      flowVwap,
      upper1s: upper1,
      lower1s: lower1,
      upper2s: upper2,
      lower2s: lower2,
      upper1Sigma: upper1,
      lower1Sigma: lower1,
      upper2Sigma: upper2,
      lower2Sigma: lower2,
      sigma,
      variance: clampedVariance,
      cumGammaWeight: this.sumWeight,
      totalWeight: this.sumWeight,
      signedGammaAcceleration: this.runningSignedAccel,
      count: this.tradeCount,
    };
  }
}

/**
 * Aggregates a series of intraday bars and option contracts into bar-by-bar
 * Flow VWAP points.
 */
export function computeBarFlowGammaVwapSeries(
  candles: Array<{
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume?: number;
  }>,
  optionsBook?: Array<{
    strike: number;
    gamma: number;
    volume?: number;
    openInterest?: number;
    last?: number;
    bid?: number;
    ask?: number;
  }>
): FlowGammaVwapSnapshot[] {
  if (!candles || candles.length === 0) return [];

  const engine = new FlowGammaVwapEngine(candles[0].close);
  const results: FlowGammaVwapSnapshot[] = [];

  // Pre-calculate aggregate dollar-gamma distribution across strikes if book is provided
  const strikeGammaWeights: Array<{ strike: number; weight: number }> = [];
  if (optionsBook && optionsBook.length > 0) {
    for (const opt of optionsBook) {
      const gamma = Math.max(0, Number(opt.gamma) || 0);
      const vol = Math.max(1, Number(opt.volume) || (Number(opt.openInterest) || 0) * 0.05);
      const prem = Math.max(
        0.5,
        Number(opt.last) || (Number(opt.bid || 0) + Number(opt.ask || 0)) / 2 || 1.0
      );
      const spotApprox = candles[0].close;
      const weight = Math.abs(vol * prem * 100 * gamma * (spotApprox * spotApprox) * 0.01);
      if (weight > 0) {
        strikeGammaWeights.push({ strike: opt.strike, weight });
      }
    }
  }

  const totalBookWeight = strikeGammaWeights.reduce((s, w) => s + w.weight, 0);

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const spot = c.close;
    const barVol = Math.max(1, c.volume || 100);

    let barWeight = 0;
    if (strikeGammaWeights.length > 0 && totalBookWeight > 0) {
      // Weight distributed across nearby strikes using Gaussian proximity to candle range
      for (const sw of strikeGammaWeights) {
        const dist = Math.abs(sw.strike - spot);
        const prox = Math.exp(-(dist * dist) / (2 * 16)); // ~4 pt sigma
        barWeight += sw.weight * prox * (barVol / (candles.length * 100));
      }
    } else {
      // Baseline synthetic gamma weighting from candle range volatility
      const range = Math.max(0.2, c.high - c.low);
      barWeight = barVol * range * 10;
    }

    const snapshot = engine.addPoint(spot, barWeight, c.timestamp);
    results.push(snapshot);
  }

  return results;
}
