/**
 * High-Performance Flow VWAP × Gamma & Flux Field PDE Quantitative Engine
 *
 * Implements:
 * 1. Dollar-Gamma Trade Weighting, Incremental Weighted Mean (Flow VWAP),
 *    and Running Weighted Variance with dynamic ±1σ and ±2σ dispersion bands.
 * 2. Spectral Flow VWAP Diffusion PDE V(p, t) over p in [0, P] (Floor p_F to Ceiling p_C):
 *      dV/dt = kappa * d^2V/dp^2,  V(0, t) = V(P, t) = 0,  V(p, 0) = Pi(p)
 *      A_n = (2 / P) * integral_0^P Pi(p) sin(n * pi * p / P) dp
 *      VWAP_flow(t) = p_F + (P / 2) * [ sum_{n=1}^N ((-1)^(n+1) / n) A_n e^{-kappa (n pi / P)^2 t} ]
 *                                   / [ sum_{n odd} (1 / n) A_n e^{-kappa (n pi / P)^2 t} ]
 * 3. Advection-Diffusion-Reaction Flux Field PDE Phi_c(x, tau) (x = p - p_F, W = p_C - p_F):
 *      dPhi/dtau = Gamma * d^2Phi/dx^2 - mu_Delta * dPhi/dx + sigma_c
 *      Pe = (mu_Delta * W) / Gamma
 *      chi = 1 / (1 - e^{-Pe}) - 1 / Pe
 *      lambda_n = Gamma * (n * pi / W)^2 + mu_Delta^2 / (4 * Gamma)
 *      J_c(tau) = chi * sigma_c * W + (Gamma * pi / W) * e^{Pe/2} * sum_{n=1}^N (-1)^{n+1} n B_{c,n} e^{-lambda_n tau}
 *      A(T) = alpha * integral_0^T sum_c J_c(tau) dtau
 */

export type AggressorSide =
  | "BUY_ASK"
  | "SELL_BID"
  | "CROSS_MID"
  | "UNKNOWN";

export type OptionContractType = "CALL" | "PUT" | "C" | "P";

export type FluxRegime = "CEILING_MAGNET" | "FLOOR_MAGNET" | "EQUILIBRIUM";

export type FlowBandSignal =
  | "UPPER_2S_REJECT"
  | "UPPER_1S_REJECT"
  | "LOWER_1S_BOUNCE"
  | "LOWER_2S_BOUNCE"
  | null;

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
  spectralFlowVwap?: number;
  floorNode?: number;
  ceilingNode?: number;
  midpointNode?: number;
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
  // Flux Field PDE Telemetry
  pecletNumber?: number;      // Pe = (mu_Delta * W) / Gamma
  ceilingShareChi?: number;   // chi = 1 / (1 - e^{-Pe}) - 1 / Pe in (0, 1)
  ceilingFluxJ?: number;      // J_c(tau) = -Gamma * dPhi/dx |_{x=W}
  floorFluxJ?: number;        // J_f(tau) = +Gamma * dPhi/dx |_{x=0}
  netFluxJ?: number;          // J_c(tau) - J_f(tau)
  fluxAlpha?: number;         // A(T) cumulative integrated ceiling flux
  fluxRegime?: FluxRegime;
  bandSignal?: FlowBandSignal;
  candleHigh?: number;
  candleLow?: number;
  candleOpen?: number;
  candleClose?: number;
}

/**
 * Evaluates the Ceiling Share function chi(Pe):
 *   chi(Pe) = 1 / (1 - e^{-Pe}) - 1 / Pe
 * Strictly bounded in (0, 1) for all finite Pe != 0, with smooth Taylor limit chi(0) = 0.5.
 */
export function computeCeilingShareChi(pe: number): number {
  if (!Number.isFinite(pe) || Math.abs(pe) < 1e-5) {
    // Taylor expansion around Pe = 0: chi(Pe) ≈ 1/2 + Pe/12 - Pe^3/720
    return 0.5 + (Number.isFinite(pe) ? pe / 12 : 0);
  }
  if (pe > 40) {
    return Math.min(0.9999, 1 - 1 / pe);
  }
  if (pe < -40) {
    return Math.max(0.0001, -1 / pe);
  }
  const val = 1 / (1 - Math.exp(-pe)) - 1 / pe;
  return Math.max(0.0001, Math.min(0.9999, val));
}

/**
 * Evaluates the steady-state Flux Field profile Phi_bar(x) on x in [0, W]:
 *   Phi_bar(x) = (sigma_c / mu_Delta) * [ x - W * (1 - e^{mu_Delta * x / Gamma}) / (1 - e^{Pe}) ]
 * With smooth diffusive parabola limit when |Pe| -> 0:
 *   Phi_bar(x) -> (sigma_c / (2 * Gamma)) * x * (W - x)
 */
export function evaluateSteadyFluxProfile(
  x: number,
  W: number,
  sigmaC: number,
  muDelta: number,
  gammaDiff: number
): number {
  if (W <= 0 || x <= 0 || x >= W || gammaDiff <= 0) return 0;
  const pe = (muDelta * W) / gammaDiff;
  if (Math.abs(pe) < 1e-4 || Math.abs(muDelta) < 1e-7) {
    return (sigmaC / (2 * gammaDiff)) * x * (W - x);
  }
  const u = Math.max(-50, Math.min(50, (muDelta * x) / gammaDiff));
  const peClamped = Math.max(-50, Math.min(50, pe));
  const ratio = (1 - Math.exp(u)) / (1 - Math.exp(peClamped));
  return (sigmaC / muDelta) * (x - W * ratio);
}

/**
 * Computes Fourier sine coefficients A_n (for Flow VWAP PDE) and B_n (for Flux Field PDE)
 * via composite trapezoidal quadrature over M interior grid nodes on [0, W].
 */
export function computeSpectralModes(params: {
  openingProfile: (x: number) => number;
  W: number;
  sigmaC: number;
  muDelta: number;
  gammaDiff: number;
  numModes?: number;
  gridPoints?: number;
}): { A: number[]; B: number[] } {
  const {
    openingProfile,
    W,
    sigmaC,
    muDelta,
    gammaDiff,
    numModes = 20,
    gridPoints = 64,
  } = params;

  const A = new Array<number>(numModes).fill(0);
  const B = new Array<number>(numModes).fill(0);
  if (W <= 0) return { A, B };

  const dx = W / gridPoints;
  const xs: number[] = [];
  const piVals: number[] = [];
  const gaugeDiffVals: number[] = [];

  for (let j = 1; j < gridPoints; j++) {
    const x = j * dx;
    const piX = Math.max(0, openingProfile(x));
    const phiBar = evaluateSteadyFluxProfile(x, W, sigmaC, muDelta, gammaDiff);
    const gaugeExp = Math.exp(
      Math.max(-35, Math.min(35, -(muDelta * x) / (2 * Math.max(1e-6, gammaDiff))))
    );
    xs.push(x);
    piVals.push(piX);
    gaugeDiffVals.push((piX - phiBar) * gaugeExp);
  }

  const scale = (2 / W) * dx;
  for (let n = 1; n <= numModes; n++) {
    let sumA = 0;
    let sumB = 0;
    const k = (n * Math.PI) / W;
    for (let idx = 0; idx < xs.length; idx++) {
      const s = Math.sin(k * xs[idx]);
      sumA += piVals[idx] * s;
      sumB += gaugeDiffVals[idx] * s;
    }
    A[n - 1] = sumA * scale;
    B[n - 1] = sumB * scale;
  }

  return { A, B };
}

/**
 * Evaluates the closed-form Spectral Flow VWAP (Image 2) and Flux Field (Image 1) at time tau (minutes since 9:30 open).
 */
export function evaluateSpectralFlowAndFluxAtTau(params: {
  tauMinutes: number;
  floorNode: number;
  ceilingNode: number;
  A: number[];
  B: number[];
  kappa: number;
  gammaDiff: number;
  muDelta: number;
  sigmaC: number;
  alphaScale?: number;
}): {
  spectralFlowVwap: number;
  spectralSigma: number;
  pecletNumber: number;
  ceilingShareChi: number;
  ceilingFluxJ: number;
  floorFluxJ: number;
  netFluxJ: number;
  fluxAlpha: number;
  fluxRegime: FluxRegime;
} {
  const {
    tauMinutes,
    floorNode,
    ceilingNode,
    A,
    B,
    kappa,
    gammaDiff,
    muDelta,
    sigmaC,
    alphaScale = 1.0,
  } = params;

  const W = Math.max(0.5, ceilingNode - floorNode);
  const midpoint = floorNode + W / 2;
  const tau = Math.max(0.05, tauMinutes);

  // 1. Flow VWAP Fourier Sine Ratio (Image 2):
  // VWAP_flow(t) = (P / 2) * [ sum_{n=1}^N ((-1)^{n+1} / n) A_n e^{-kappa (n pi / P)^2 t} ]
  //                        / [ sum_{n odd} (1 / n) A_n e^{-kappa (n pi / P)^2 t} ]
  let numVwap = 0;
  let denVwap = 0;
  let numSecondMoment = 0;

  for (let i = 0; i < A.length; i++) {
    const n = i + 1;
    const An = A[i];
    if (!Number.isFinite(An) || Math.abs(An) < 1e-12) continue;

    const kRatio = (n * Math.PI) / W;
    const decay = Math.exp(-Math.min(60, kappa * kRatio * kRatio * tau));
    const altSign = n % 2 === 1 ? 1 : -1; // (-1)^{n+1}

    numVwap += (altSign / n) * An * decay;
    if (n % 2 === 1) {
      denVwap += (1 / n) * An * decay;
    }

    // Integral_0^P p^2 sin(n pi p / P) dp = P^3 [ (-1)^{n+1} / (n pi) - 2 (1 - (-1)^n) / (n pi)^3 ]
    const nPi = n * Math.PI;
    const termP2 =
      altSign / nPi - (n % 2 === 1 ? 4 / (nPi * nPi * nPi) : 0);
    numSecondMoment += An * decay * termP2;
  }

  let relativeVwap = W / 2;
  if (Math.abs(denVwap) > 1e-9) {
    const rawRel = (W / 2) * (numVwap / denVwap);
    // Clamp strictly within (0.05 * W, 0.95 * W) so transient ringing never exits corridor
    relativeVwap = Math.max(0.05 * W, Math.min(0.95 * W, rawRel));
  }
  const spectralFlowVwap = floorNode + relativeVwap;

  // Spectral spatial dispersion sigma(t)
  const totalMassIntegral = (2 * W / Math.PI) * denVwap;
  let spectralSigma = W * 0.18;
  if (totalMassIntegral > 1e-9) {
    const eP2 = (W * W * W * numSecondMoment) / totalMassIntegral;
    const varP = eP2 - relativeVwap * relativeVwap;
    if (Number.isFinite(varP) && varP > 0.04) {
      spectralSigma = Math.min(W * 0.28, Math.max(W * 0.08, Math.sqrt(varP)));
    }
  }

  // 2. Flux Field Advection-Diffusion-Reaction Solution (Image 1):
  // Pe = mu_Delta * W / Gamma
  const safeGamma = Math.max(1e-4, gammaDiff);
  const pe = Math.max(-25, Math.min(25, (muDelta * W) / safeGamma));
  const chi = computeCeilingShareChi(pe);

  let transientCeilingSum = 0;
  let transientFloorSum = 0;
  let transientAlphaSum = 0;

  for (let i = 0; i < B.length; i++) {
    const n = i + 1;
    const Bn = B[i];
    if (!Number.isFinite(Bn) || Math.abs(Bn) < 1e-12) continue;

    const k = (n * Math.PI) / W;
    const lambdaN = safeGamma * k * k + (muDelta * muDelta) / (4 * safeGamma);
    const expLambda = Math.exp(-Math.min(60, lambdaN * tau));
    const altSign = n % 2 === 1 ? 1 : -1; // (-1)^{n+1}

    transientCeilingSum += altSign * n * Bn * expLambda;
    transientFloorSum += n * Bn * expLambda;
    if (lambdaN > 1e-8) {
      transientAlphaSum +=
        altSign * ((n * Bn) / lambdaN) * (1 - expLambda);
    }
  }

  const prefactor = (safeGamma * Math.PI) / W;
  const expHalfPePos = Math.exp(Math.max(-12, Math.min(12, pe / 2)));
  const expHalfPeNeg = Math.exp(Math.max(-12, Math.min(12, -pe / 2)));

  // J_c(tau) = chi * sigma_c * W + (Gamma * pi / W) * e^{Pe/2} * sum (-1)^{n+1} n B_n e^{-lambda_n tau}
  const ceilingFluxJ =
    chi * sigmaC * W + prefactor * expHalfPePos * transientCeilingSum;
  const floorFluxJ =
    (1 - chi) * sigmaC * W + prefactor * expHalfPeNeg * transientFloorSum;
  const netFluxJ = ceilingFluxJ - floorFluxJ;

  // Flux Alpha A(T) = alpha * { chi * W * T * sigma_c + (Gamma * pi / W) * e^{Pe/2} * sum (-1)^{n+1} (n B_n / lambda_n) (1 - e^{-lambda_n T}) }
  const fluxAlpha =
    alphaScale *
    (chi * W * tau * sigmaC + prefactor * expHalfPePos * transientAlphaSum);

  let fluxRegime: FluxRegime = "EQUILIBRIUM";
  if (chi >= 0.54) {
    fluxRegime = "CEILING_MAGNET";
  } else if (chi <= 0.46) {
    fluxRegime = "FLOOR_MAGNET";
  }

  return {
    spectralFlowVwap: Number(spectralFlowVwap.toFixed(2)),
    spectralSigma: Number(spectralSigma.toFixed(2)),
    pecletNumber: Number(pe.toFixed(3)),
    ceilingShareChi: Number(chi.toFixed(4)),
    ceilingFluxJ: Number(ceilingFluxJ.toFixed(2)),
    floorFluxJ: Number(floorFluxJ.toFixed(2)),
    netFluxJ: Number(netFluxJ.toFixed(2)),
    fluxAlpha: Number(fluxAlpha.toFixed(2)),
    fluxRegime,
  };
}

/**
 * Spectral Flow VWAP Flux decay with non-negative dt and clamped conviction.
 * Prevents negative time tick intervals from amplifying chi > 1.
 */
export function computeFluxDecay(chi: number, dtMs: number, halfLifeSeconds: number = 300): number {
  const safeHalfLife = Math.max(1, halfLifeSeconds);
  const safeDtMs = Math.max(0, Number.isFinite(dtMs) ? dtMs : 0);
  const clampedChi = Math.max(-1, Math.min(1, Number.isFinite(chi) ? chi : 0));
  const lambda = Math.LN2 / safeHalfLife;
  return clampedChi * Math.exp(-lambda * (safeDtMs / 1000));
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
  private runningMean = 0;
  private runningM2 = 0; // M_2 = sum w_i * (S_i - mean)^2 via West's (1979) algorithm
  private runningSignedAccel = 0;
  private tradeCount = 0;
  private lastKnownSpot = 0;
  private lastTimestamp = 0;
  private sessionResetTimestamp = 0;

  constructor(initialSpot = 0) {
    if (initialSpot > 0) {
      this.lastKnownSpot = initialSpot;
      this.runningMean = initialSpot;
    }
  }

  /**
   * Resets session accumulators to zero (at 9:30 AM ET or on demand).
   */
  public reset(currentSpot?: number): void {
    this.sumWeight = 0;
    this.runningMean = 0;
    this.runningM2 = 0;
    this.runningSignedAccel = 0;
    this.tradeCount = 0;
    if (typeof currentSpot === "number" && currentSpot > 0) {
      this.lastKnownSpot = currentSpot;
      this.runningMean = currentSpot;
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
      const oldWeight = this.sumWeight;
      const newWeight = oldWeight + validWeight;
      this.sumWeight = newWeight;

      const delta = validSpot - (this.runningMean || validSpot);
      const newMean = (this.runningMean || validSpot) + (validWeight / newWeight) * delta;
      this.runningM2 += validWeight * delta * (validSpot - newMean);
      this.runningMean = newMean;

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

    // Weighted mean: VWAP_gamma = mu_n
    const flowVwap = this.runningMean;

    // Running sample variance via West's recurrence: sigma^2 = M_2 / sumWeight
    const rawVariance = this.runningM2 / this.sumWeight;
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

export interface StructuralFlowNodes {
  floorNode?: number;   // Put Wall / p_F
  ceilingNode?: number; // Call Wall / p_C
}

/**
 * Aggregates a series of intraday bars and option contracts into bar-by-bar
 * Flow VWAP & Flux Field PDE points, including tick-level ±1σ / ±2σ band wick signals.
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
    optionType?: string;
    delta?: number;
  }>,
  structuralNodes?: StructuralFlowNodes
): FlowGammaVwapSnapshot[] {
  if (!candles || candles.length === 0) return [];

  const engine = new FlowGammaVwapEngine(candles[0].close);
  const results: FlowGammaVwapSnapshot[] = [];

  // 1. Pre-calculate aggregate dollar-gamma distribution across strikes if book is provided
  const strikeGammaWeights: Array<{ strike: number; weight: number; signedBias: number }> = [];
  let callWallCandidate = 0;
  let maxCallWeight = -1;
  let putWallCandidate = 0;
  let maxPutWeight = -1;
  const refOpenSpot = candles[0].open || candles[0].close;

  if (optionsBook && optionsBook.length > 0) {
  // RTH_SESSION_RESET_GUARD: Track RTH open transition (09:30 ET) to reset pre-market variance skew
  let hasResetForRth = false;
    for (const opt of optionsBook) {
      const gamma = Math.max(0, Number(opt.gamma) || 0);
      const vol = Math.max(1, Number(opt.volume) || (Number(opt.openInterest) || 0) * 0.05);
      const prem = Math.max(
        0.5,
        Number(opt.last) || (Number(opt.bid || 0) + Number(opt.ask || 0)) / 2 || 1.0
      );
      const weight = Math.abs(vol * prem * 100 * gamma * (refOpenSpot * refOpenSpot) * 0.01);
      if (weight > 0) {
        const isCall =
          opt.optionType === "C" ||
          opt.optionType === "CALL" ||
          (opt.optionType === undefined && opt.strike >= refOpenSpot);
        strikeGammaWeights.push({
          strike: opt.strike,
          weight,
          signedBias: isCall ? 1 : -1,
        });
        if (opt.strike >= refOpenSpot && weight > maxCallWeight) {
          maxCallWeight = weight;
          callWallCandidate = opt.strike;
        }
        if (opt.strike <= refOpenSpot && weight > maxPutWeight) {
          maxPutWeight = weight;
          putWallCandidate = opt.strike;
        }
      }
    }
  }

  // 2. Establish Causal Opening Anchor for the Base Profile [p_F, p_C]
  const openSlice = candles.slice(0, Math.min(3, candles.length));
  const openHigh = Math.max(...openSlice.map((c) => c.high));
  const openLow = Math.min(...openSlice.map((c) => c.low));
  const openRange = Math.max(refOpenSpot * 0.004, openHigh - openLow);

  const baseFloorNode =
    structuralNodes?.floorNode && structuralNodes.floorNode > 0 && structuralNodes.floorNode < openHigh
      ? structuralNodes.floorNode
      : putWallCandidate > 0 && Math.abs(refOpenSpot - putWallCandidate) <= openRange * 2.5
        ? Math.min(putWallCandidate, openLow - openRange * 0.08)
        : Number((openLow - openRange * 0.12).toFixed(2));

  const baseCeilingNode =
    structuralNodes?.ceilingNode && structuralNodes.ceilingNode > baseFloorNode
      ? structuralNodes.ceilingNode
      : callWallCandidate > baseFloorNode && Math.abs(callWallCandidate - refOpenSpot) <= openRange * 2.5
        ? Math.max(callWallCandidate, openHigh + openRange * 0.08)
        : Number((openHigh + openRange * 0.12).toFixed(2));

  const baseW = Math.max(1.0, baseCeilingNode - baseFloorNode);

  // 3. Construct Opening Aggressive Premium Profile Pi(x) on x in [0, baseW] (first 1-3 bars at 9:30 open)
  const openCenterPrice =
    openSlice.reduce((acc, c) => acc + (c.open + c.close + c.high + c.low) / 4, 0) /
    openSlice.length;
  const openCenterRel = Math.max(0.08 * baseW, Math.min(0.92 * baseW, openCenterPrice - baseFloorNode));
  const openSpread = Math.max(0.08 * baseW, Math.min(0.25 * baseW, (openSlice[0].high - openSlice[0].low) * 1.5 || 0.14 * baseW));

  const openingProfile = (x: number): number => {
    const distOpen = x - openCenterRel;
    let val = 100 * Math.exp(-(distOpen * distOpen) / (2 * openSpread * openSpread));
    if (strikeGammaWeights.length > 0) {
      const strikePrice = baseFloorNode + x;
      for (const sw of strikeGammaWeights) {
        const d = strikePrice - sw.strike;
        if (Math.abs(d) <= baseW * 0.25) {
          val += Math.min(80, Math.log1p(sw.weight) * 2.5) * Math.exp(-(d * d) / (2 * openSpread * openSpread));
        }
      }
    }
    return val;
  };

  // Diffusivity kappa & Gamma calibrated so higher modes relax over a ~180m session
  const gammaDiff = (baseW * baseW) / (Math.PI * Math.PI * 140);
  const kappa = gammaDiff;

  // Baseline Fourier Sine Coefficients at 9:30 open
  const baseModes = computeSpectralModes({
    openingProfile,
    W: baseW,
    sigmaC: 1.0,
    muDelta: 0,
    gammaDiff,
    numModes: 18,
  });

  const totalBookWeight = strikeGammaWeights.reduce((s, w) => s + w.weight, 0);

  // Causal F_{t_i}-adapted running state (Zero Lookahead Stefan Boundary)
  let runningHigh = -Infinity;
  let runningLow = +Infinity;
  let causalAtr = 0;
  const atrAlpha = 1 / 14;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const spot = c.close;
    const barVol = Math.max(1, c.volume || 100);

    // 1. Update causal running extrema using strictly history [0 .. i]
    if (c.high > runningHigh) runningHigh = c.high;
    if (c.low < runningLow) runningLow = c.low;

    // 2. Causal Wilder True Range
    const barRange = Math.max(0, c.high - c.low);
    const prevClose = i > 0 ? candles[i - 1].close : c.open;
    const trueRange =
      i === 0
        ? Math.max(barRange, c.close * 0.0015)
        : Math.max(barRange, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
    causalAtr = i === 0 ? trueRange : atrAlpha * trueRange + (1 - atrAlpha) * causalAtr;

    // 3. Causal absorbing domain buffers [p_F(t_i), p_C(t_i)]
    const causalBuffer = Math.max(0.5 * causalAtr, c.close * 0.001);
    const causalCeiling = runningHigh + causalBuffer;
    const causalFloor = Math.max(0.01, runningLow - causalBuffer);

    const floorNode =
      structuralNodes?.floorNode && structuralNodes.floorNode > 0 && structuralNodes.floorNode < runningHigh
        ? structuralNodes.floorNode
        : putWallCandidate > 0 && putWallCandidate < spot
          ? Math.min(putWallCandidate, causalFloor)
          : Number(causalFloor.toFixed(2));

    const ceilingNode =
      structuralNodes?.ceilingNode && structuralNodes.ceilingNode > floorNode
        ? structuralNodes.ceilingNode
        : callWallCandidate > floorNode && callWallCandidate > spot
          ? Math.max(callWallCandidate, causalCeiling)
          : Number(causalCeiling.toFixed(2));

    const W = Math.max(1.0, ceilingNode - floorNode);
    const midpointNode = Number((floorNode + W / 2).toFixed(2));

    let barWeight = 0;
    let barSignedBias = c.close >= c.open ? 1 : -1;

    if (strikeGammaWeights.length > 0 && totalBookWeight > 0) {
      let netSigned = 0;
      for (const sw of strikeGammaWeights) {
        const dist = Math.abs(sw.strike - spot);
        const prox = Math.exp(-(dist * dist) / (2 * 16)); // ~4 pt sigma
        const w = sw.weight * prox * (barVol / (candles.length * 100));
        barWeight += w;
        netSigned += w * sw.signedBias;
      }
      if (barWeight > 0) {
        barSignedBias = c.close >= c.open ? 1 : -1;
        if (Math.abs(netSigned) > 0) {
          barSignedBias = 0.65 * (c.close >= c.open ? 1 : -1) + 0.35 * Math.sign(netSigned);
        }
      }
    } else {
      const range = Math.max(0.2, c.high - c.low);
      barWeight = barVol * range * 10;
    }

    const baseSnap = engine.addPoint(
      spot,
      barWeight,
      c.timestamp,
      barWeight * barSignedBias
    );

    // Minutes elapsed since session open
    const tauMinutes = Math.max(
      1,
      c.timestamp > candles[0].timestamp
        ? (c.timestamp - candles[0].timestamp) / (c.timestamp > 1e11 ? 60000 : 60)
        : (i + 1) * 5
    );

    // Multi-Horizon Structural Advection Velocity (Session Open + VWAP + Momentum)
    const open930 = candles.find((b) => ((b as any).etMins ?? 0) >= 570)?.open ?? candles[0].open;
    const currentVwap = baseSnap.flowVwap || c.close;
    const atrEst = Math.max(0.40, (c.high - c.low) * 1.5);

    // 1. Session Macro Horizon: Distance from 9:30 AM Open
    const macroDrive = (c.close - open930) / (2.2 * atrEst);
    // 2. Structural Horizon: Distance from Flow VWAP
    const vwapDrive = (c.close - currentVwap) / (1.2 * atrEst);
    // 3. Short-Term Impulse Horizon (12-bar & 4-bar)
    const lb12 = Math.max(0, i - 12);
    const lb4 = Math.max(0, i - 4);
    const impulseDrive = (
      0.6 * ((c.close - candles[lb12].close) / atrEst) +
      0.4 * ((c.close - candles[lb4].close) / atrEst)
    );

    const combinedDrive = 0.45 * macroDrive + 0.35 * vwapDrive + 0.20 * impulseDrive;
    const muDelta = Math.max(-8.0, Math.min(8.0, combinedDrive * 2.8));
    const sigmaC = Math.max(0.1, Math.log1p(barWeight) * 0.25);

    const pdeState = evaluateSpectralFlowAndFluxAtTau({
      tauMinutes,
      floorNode,
      ceilingNode,
      A: baseModes.A,
      B: baseModes.B,
      kappa,
      gammaDiff,
      muDelta,
      sigmaC,
    });

    // Couple incremental empirical Flow VWAP with Spectral PDE Flow VWAP (smooth orange trajectory in Image 3)
    const empiricalVwap = baseSnap.flowVwap;
    const spectralWeight = candles.length > 3 ? 0.28 : 0.0;
    const blendedFlowVwap =
      spectralWeight > 0
        ? empiricalVwap * (1 - spectralWeight) + pdeState.spectralFlowVwap * spectralWeight
        : empiricalVwap;

    const effectiveSigma =
      candles.length > 3
        ? Math.max(baseSnap.sigma, pdeState.spectralSigma * 0.65)
        : baseSnap.sigma;

    const u1 = blendedFlowVwap + effectiveSigma;
    const l1 = blendedFlowVwap - effectiveSigma;
    const u2 = blendedFlowVwap + 2 * effectiveSigma;
    const l2 = blendedFlowVwap - 2 * effectiveSigma;

    // Tick-Level Band Wick Signal Detection (Image 3 arrows)
    let bandSignal: FlowBandSignal = null;
    if (i >= 1) {
      if (c.high >= u2 * 0.9997 && c.close < u2) {
        bandSignal = "UPPER_2S_REJECT";
      } else if (c.low <= l2 * 1.0003 && c.close > l2) {
        bandSignal = "LOWER_2S_BOUNCE";
      } else if (c.high >= u1 * 0.9998 && c.close <= u1 && c.close < c.open) {
        bandSignal = "UPPER_1S_REJECT";
      } else if (c.low <= l1 * 1.0002 && c.close >= l1 && c.close > c.open) {
        bandSignal = "LOWER_1S_BOUNCE";
      }
    }

    results.push({
      ...baseSnap,
      flowVwap: blendedFlowVwap,
      spectralFlowVwap: pdeState.spectralFlowVwap,
      floorNode,
      ceilingNode,
      midpointNode,
      sigma: effectiveSigma,
      variance: effectiveSigma * effectiveSigma,
      upper1s: u1,
      lower1s: l1,
      upper2s: u2,
      lower2s: l2,
      upper1Sigma: u1,
      lower1Sigma: l1,
      upper2Sigma: u2,
      lower2Sigma: l2,
      pecletNumber: pdeState.pecletNumber,
      ceilingShareChi: pdeState.ceilingShareChi,
      ceilingFluxJ: pdeState.ceilingFluxJ,
      floorFluxJ: pdeState.floorFluxJ,
      netFluxJ: pdeState.netFluxJ,
      fluxAlpha: pdeState.fluxAlpha,
      fluxRegime: pdeState.fluxRegime,
      bandSignal,
      candleHigh: c.high,
      candleLow: c.low,
      candleOpen: c.open,
      candleClose: c.close,
    });
  }

  return results;
}
