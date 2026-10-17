import {
  calculateKingStrength,
  getTickerPreset,
  KingNodeMetrics,
  TickerSymbol,
} from "@/store/useDashboardStore";

export type DataSourceType = "TRADIER_LIVE" | "CBOE_MARKET_DATA" | "SIMULATED";

export interface NormalizedOptionContract {
  symbol: string;
  expiration: string; // YYYY-MM-DD
  optionType: "C" | "P";
  strike: number;
  openInterest: number;
  volume: number;
  iv: number; // decimal, e.g. 0.22
  delta: number;
  gamma: number;
  vega: number;
  percentChange: number;
}

export interface ExpirationColumnSpec {
  id: string;
  isoDate: string;
  tag: string;
  filterGroup: "0DTE" | "THIS_WEEK" | "OPEX";
  dateLabel: string;
  dteDays: number;
}

export interface ComputedStrikeRow {
  strike: number;
  totalNetGex: number;
  totalAbsGex: number;
  totalCallGamma: number;
  totalPutGamma: number;
  kingPeakColId: string;
  gex: Record<string, number>;
  vex: Record<string, number>;
  dex: Record<string, number>;
  charm: Record<string, number>;
  openPctChange: Record<string, number>;
}

export interface OptionsAnalyticsPayload {
  ticker: TickerSymbol;
  dataSource: DataSourceType;
  lastUpdated: string;
  spotPrice: number;
  previousClose: number;
  impliedVolatility: number;
  strikeStep: number;
  netMetrics: {
    netGex: number; // $B
    netVex: number; // $M
  };
  gammaLevels: {
    callWall: number;
    putWall: number;
    zeroGamma: number;
  };
  kingNode: KingNodeMetrics;
  kingByFilter: {
    ALL: { strike: number; label: string };
    "0DTE": { strike: number; label: string };
    THIS_WEEK: { strike: number; label: string };
    OPEX: { strike: number; label: string };
  };
  expirations: ExpirationColumnSpec[];
  strikes: ComputedStrikeRow[];
}

export const normPDF = (x: number): number =>
  Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

export const normCDF = (x: number): number => {
  const a1 = 0.254829592,
    a2 = -0.284496736,
    a3 = 1.421413741,
    a4 = -1.453152027,
    a5 = 1.061405429,
    p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x) / Math.sqrt(2);
  const t = 1.0 / (1.0 + p * absX);
  const y =
    1.0 -
    ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);
  return 0.5 * (1.0 + sign * y);
};

// Prevent divide-by-zero on 0DTE by clamping minimum time to 5 trading minutes
export const getFractionalYearT = (
  dteDays: number,
  minutesLeftToday = 120
): number => {
  const minTradingYear = 5 / (252 * 390);
  if (dteDays <= 0) return Math.max(minTradingYear, minutesLeftToday / (252 * 390));
  return (dteDays + minutesLeftToday / 390) / 252;
};

/**
 * Shared helper to auto-scale exposure numbers in $B, $M, or $K
 */
export function formatExposure(
  valInMillions: number,
  options?: { includeSign?: boolean; showPlus?: boolean }
): string {
  const { includeSign = true, showPlus = true } = options ?? {};
  const absVal = Math.abs(valInMillions);
  const sign = valInMillions < 0 ? "-" : showPlus ? "+" : "";

  let numStr = "";
  if (absVal >= 1000) {
    numStr = `$${(absVal / 1000).toFixed(2)}B`;
  } else if (absVal >= 1) {
    numStr = `$${absVal.toFixed(1)}M`;
  } else {
    numStr = `$${(absVal * 1000).toFixed(0)}K`;
  }

  return includeSign ? `${sign}${numStr}` : numStr;
}

/**
 * Exact Black-Scholes Greeks (Gamma, Vanna, Charm, Delta)
 * r = 0.045, q = 0.012
 */
export function computeBlackScholesGreeks(
  S: number,
  K: number,
  T: number,
  sigma: number,
  r = 0.045,
  q = 0.012
) {
  const effectiveT = Math.max(5 / (252 * 390), T);
  const effectiveSigma = Math.max(0.02, Math.min(3.5, sigma));
  const sqrtT = Math.sqrt(effectiveT);

  const d1 =
    (Math.log(Math.max(1e-4, S / K)) +
      (r - q + 0.5 * effectiveSigma * effectiveSigma) * effectiveT) /
    (effectiveSigma * sqrtT);
  const d2 = d1 - effectiveSigma * sqrtT;

  const pdfD1 = normPDF(d1);
  const discountQ = Math.exp(-q * effectiveT);

  const gamma = (discountQ * pdfD1) / (S * effectiveSigma * sqrtT);
  const vanna = -discountQ * pdfD1 * (d2 / effectiveSigma); // dDelta / dVol

  const charmCall =
    q * discountQ * normCDF(d1) -
    discountQ *
      pdfD1 *
      ((2 * (r - q) * effectiveT - d2 * effectiveSigma * sqrtT) /
        (2 * effectiveT * effectiveSigma * sqrtT));
  const charmPut = charmCall - q * discountQ;

  const deltaCall = discountQ * normCDF(d1);
  const deltaPut = -discountQ * normCDF(-d1);

  return {
    gamma,
    vanna,
    charmCall,
    charmPut,
    deltaCall,
    deltaPut,
  };
}

/**
 * Parses OCC Option Symbol, e.g. "QQQ261016C00485000" or "SPXW261016P05850000"
 */
export function parseOccSymbol(occ: string): {
  root: string;
  expiration: string;
  optionType: "C" | "P";
  strike: number;
} | null {
  const cleaned = occ.trim().toUpperCase();
  const match = cleaned.match(/^([A-Z0-9_]+?)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
  if (!match) return null;

  const [, root, yy, mm, dd, typeChar, strikeRaw] = match;
  const expiration = `20${yy}-${mm}-${dd}`;
  const optionType = typeChar as "C" | "P";
  const strike = parseInt(strikeRaw, 10) / 1000;

  if (!Number.isFinite(strike) || strike <= 0) return null;
  return { root, expiration, optionType, strike };
}

export function getActiveExpirationSelection(allRawExpirations: string[]): {
  referenceDate: string;
  hasZeroDte: boolean;
  activeExpirations: string[];
} {
  const sorted = Array.from(new Set(allRawExpirations)).sort();
  if (sorted.length === 0) {
    const fallbackToday = new Date().toLocaleDateString("en-CA", {
      timeZone: "America/New_York",
    });
    return {
      referenceDate: fallbackToday,
      hasZeroDte: false,
      activeExpirations: [],
    };
  }

  const nowEt = new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/New_York" })
  );
  const nowEtIso = new Date().toLocaleDateString("en-CA", {
    timeZone: "America/New_York",
  });
  const dayOfWeek = nowEt.getDay();
  const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;
  const isBeforeClose =
    nowEt.getHours() < 16 ||
    (nowEt.getHours() === 16 && nowEt.getMinutes() === 0);

  const earliest = sorted[0];
  const hasZeroDte =
    earliest === nowEtIso && isWeekday && isBeforeClose;

  if (hasZeroDte) {
    const active = sorted.filter((exp) => exp >= nowEtIso);
    return {
      referenceDate: earliest,
      hasZeroDte: true,
      activeExpirations: active.length > 0 ? active : sorted,
    };
  }

  // After 4:00 PM ET close or on weekends, any expiration <= earliest (if earliest <= nowEtIso) is already settled
  const settledCutoff = earliest <= nowEtIso ? earliest : nowEtIso;
  const postCloseActive = sorted.filter((exp) => exp > settledCutoff);
  return {
    referenceDate: settledCutoff,
    hasZeroDte: false,
    activeExpirations: postCloseActive.length > 0 ? postCloseActive : sorted,
  };
}

function formatExpirationColumn(
  isoDate: string,
  index: number,
  referenceDateStr: string,
  hasZeroDte: boolean
): ExpirationColumnSpec {
  const refTime = new Date(`${referenceDateStr}T00:00:00Z`).getTime();
  const expTime = new Date(`${isoDate}T00:00:00Z`).getTime();
  const diffDays = Math.max(
    0,
    Math.round((expTime - refTime) / (1000 * 60 * 60 * 24))
  );

  const dateObj = new Date(`${isoDate}T12:00:00Z`);
  const dayNum = dateObj.getUTCDate();
  const dayOfWeek = dateObj.getUTCDay(); // 5 = Friday
  const isThirdFriday = dayOfWeek === 5 && dayNum >= 15 && dayNum <= 21;
  const mmdd = isoDate.slice(5);

  let tag = "WKLY";
  let filterGroup: "0DTE" | "THIS_WEEK" | "OPEX" = "THIS_WEEK";

  if (diffDays === 0 && hasZeroDte) {
    tag = "0DTE";
    filterGroup = "0DTE";
  } else if (index === 0) {
    tag = diffDays <= 7 ? `${diffDays}D` : "NEXT";
    filterGroup = "0DTE";
  } else if (diffDays <= 7) {
    tag = `${diffDays}D`;
    filterGroup = "THIS_WEEK";
  } else if (isThirdFriday || diffDays >= 25) {
    tag = "OPEX";
    filterGroup = "OPEX";
  } else {
    tag = "WKLY";
    filterGroup = "THIS_WEEK";
  }

  return {
    id: `exp_${index}`,
    isoDate,
    tag,
    filterGroup,
    dateLabel: mmdd,
    dteDays: diffDays,
  };
}

/**
 * Evaluates dealer exposure & structural walls from a list of normalized option contracts.
 */
export function computeOptionsAnalytics(params: {
  ticker: TickerSymbol;
  dataSource: DataSourceType;
  spotPrice: number;
  previousClose: number;
  impliedVolatility: number; // decimal
  contracts: NormalizedOptionContract[];
  activeExpirationFilter?: string;
}): OptionsAnalyticsPayload {
  const {
    ticker,
    dataSource,
    spotPrice,
    previousClose,
    impliedVolatility,
    contracts,
    activeExpirationFilter = "0DTE",
  } = params;

  const preset = getTickerPreset(ticker);
  const minStrike = spotPrice * 0.85;
  const maxStrike = spotPrice * 1.15;

  // Filter contracts to valid strikes within ±15% of spotPrice
  const validContracts = contracts.filter(
    (c) =>
      c.strike >= minStrike &&
      c.strike <= maxStrike &&
      (c.openInterest > 0 || c.volume > 0)
  );

  // Collect active (unsettled) expirations using unified ET market-hours check
  const rawExpirations = Array.from(
    new Set(validContracts.map((c) => c.expiration))
  ).sort();

  const { referenceDate, hasZeroDte, activeExpirations: allExpirations } =
    getActiveExpirationSelection(rawExpirations);

  // Pick 13 expiration columns: nearest 8 active dates + 5 highest-OI medium/OPEX dates
  const targetColCount = 13;
  let selectedIsoDates = allExpirations.slice(0, targetColCount);
  if (allExpirations.length > targetColCount) {
    const immediateEight = allExpirations.slice(0, 8);
    const remaining = allExpirations.slice(8);
    const oiByExp = new Map<string, number>();
    for (const c of validContracts) {
      const weight = c.openInterest > 0 ? c.openInterest : Math.round(c.volume * 0.5);
      oiByExp.set(c.expiration, (oiByExp.get(c.expiration) ?? 0) + weight);
    }
    const topFiveLiquid = remaining
      .sort((a, b) => (oiByExp.get(b) ?? 0) - (oiByExp.get(a) ?? 0))
      .slice(0, 5)
      .sort();
    selectedIsoDates = [...immediateEight, ...topFiveLiquid];
  }

  const expirations: ExpirationColumnSpec[] = selectedIsoDates.map((iso, idx) =>
    formatExpirationColumn(iso, idx, referenceDate, hasZeroDte)
  );

  const isoToColId = new Map<string, string>();
  const isoToDays = new Map<string, number>();
  const refTime = new Date(`${referenceDate}T00:00:00Z`).getTime();

  expirations.forEach((exp) => {
    isoToColId.set(exp.isoDate, exp.id);
    const expTime = new Date(`${exp.isoDate}T00:00:00Z`).getTime();
    const days = Math.max(0, (expTime - refTime) / (1000 * 60 * 60 * 24));
    isoToDays.set(exp.isoDate, days);
  });

  // Group contracts by strike across the 13 selected expirations
  const selectedContracts = validContracts.filter((c) =>
    isoToColId.has(c.expiration)
  );

  // Determine strike step from available strikes near spot
  const uniqueStrikesAsc = Array.from(
    new Set(selectedContracts.map((c) => Number(c.strike.toFixed(2))))
  ).sort((a, b) => a - b);

  let detectedStep = preset.strikeStep;
  const atmStrikes = uniqueStrikesAsc.filter(
    (s) => Math.abs(s - spotPrice) <= spotPrice * 0.03
  );
  if (atmStrikes.length >= 3) {
    const diffs: number[] = [];
    for (let i = 1; i < atmStrikes.length; i++) {
      const d = Number((atmStrikes[i] - atmStrikes[i - 1]).toFixed(2));
      if (d >= 0.5) diffs.push(d);
    }
    if (diffs.length > 0) {
      diffs.sort((a, b) => a - b);
      detectedStep = diffs[Math.floor(diffs.length / 2)];
    }
  }

  // Accumulate per-strike, per-expiration metrics
  interface BucketCell {
    callOI: number;
    putOI: number;
    callGammaOI: number;
    putGammaOI: number;
    callDeltaOI: number;
    putDeltaOI: number;
    callVannaOI: number;
    putVannaOI: number;
    callCharmOI: number;
    putCharmOI: number;
    weightedPctChange: number;
    totalWeight: number;
  }

  const strikeMap = new Map<number, Map<string, BucketCell>>();

  for (const strike of uniqueStrikesAsc) {
    const expMap = new Map<string, BucketCell>();
    for (const exp of expirations) {
      expMap.set(exp.id, {
        callOI: 0,
        putOI: 0,
        callGammaOI: 0,
        putGammaOI: 0,
        callDeltaOI: 0,
        putDeltaOI: 0,
        callVannaOI: 0,
        putVannaOI: 0,
        callCharmOI: 0,
        putCharmOI: 0,
        weightedPctChange: 0,
        totalWeight: 0,
      });
    }
    strikeMap.set(strike, expMap);
  }

  for (const contract of selectedContracts) {
    const strikeKey = Number(contract.strike.toFixed(2));
    const colId = isoToColId.get(contract.expiration);
    if (!colId) continue;

    const expMap = strikeMap.get(strikeKey);
    const cell = expMap?.get(colId);
    if (!cell) continue;

    const days = isoToDays.get(contract.expiration) ?? 0;
    const T = Math.max(1 / 365, (days + 0.5) / 365);
    const contractIv =
      contract.iv > 0.02
        ? contract.iv > 4
          ? contract.iv / 100
          : contract.iv
        : impliedVolatility;

    const bs = computeBlackScholesGreeks(
      spotPrice,
      strikeKey,
      T,
      contractIv,
      0.045,
      0.012
    );

    // Use effective OI (with small volume fallback if 0DTE newly opened strike has 0 prior OI)
    const oi =
      contract.openInterest > 0
        ? contract.openInterest
        : Math.round(contract.volume * 0.35);

    if (contract.optionType === "C") {
      cell.callOI += oi;
      cell.callGammaOI += oi * bs.gamma;
      cell.callDeltaOI += oi * bs.deltaCall;
      cell.callVannaOI += oi * bs.vanna;
      cell.callCharmOI += oi * bs.charmCall;
    } else {
      cell.putOI += oi;
      cell.putGammaOI += oi * bs.gamma;
      cell.putDeltaOI += oi * bs.deltaPut;
      cell.putVannaOI += oi * bs.vanna;
      cell.putCharmOI += oi * bs.charmPut;
    }

    if (oi > 0 && Number.isFinite(contract.percentChange)) {
      cell.weightedPctChange += oi * contract.percentChange;
      cell.totalWeight += oi;
    }
  }

  let totalNetGexMillions = 0;
  let totalNetVexMillions = 0;

  let bestCallWallStrike = spotPrice + detectedStep * 5;
  let bestCallWallGamma = -1;

  let bestPutWallStrike = spotPrice - detectedStep * 5;
  let bestPutWallGamma = -1;

  const computedRowsAsc: ComputedStrikeRow[] = [];

  for (const strike of uniqueStrikesAsc) {
    const expMap = strikeMap.get(strike)!;
    const gex: Record<string, number> = {};
    const vex: Record<string, number> = {};
    const dex: Record<string, number> = {};
    const charm: Record<string, number> = {};
    const openPctChange: Record<string, number> = {};

    let rowNetGex = 0;
    let rowAbsGex = 0;
    let rowCallGamma = 0;
    let rowPutGamma = 0;
    let kingPeakColId = expirations[0]?.id ?? "exp_0";
    let maxColAbsGex = -1;

    for (const exp of expirations) {
      const cell = expMap.get(exp.id)!;

      // GEX ($M per 1% Spot Move): ((callOI * callGamma) - (putOI * putGamma)) * 100 * (S * S) * 0.01 / 1e6
      const callGexM =
        (cell.callGammaOI * 100 * (spotPrice * spotPrice) * 0.01) / 1e6;
      const putGexM =
        (cell.putGammaOI * 100 * (spotPrice * spotPrice) * 0.01) / 1e6;
      const cellGexM = callGexM - putGexM;

      // VEX ($M per 1% IV Point Move): ((callOI * callVanna) - (putOI * putVanna)) * 100 * S * 0.01 / 1e6
      const cellVexM =
        ((cell.callVannaOI - cell.putVannaOI) * 100 * spotPrice * 0.01) / 1e6;

      // DEX ($M Delta Notional): ((callOI * callDelta) + (putOI * putDelta)) * 100 * S / 1e6
      const cellDexM =
        ((cell.callDeltaOI + cell.putDeltaOI) * 100 * spotPrice) / 1e6;

      // Charm ($M Daily Delta Decay): ((callOI * charmCall) - (putOI * charmPut)) * 100 * S * (1 / 252) / 1e6
      const cellCharmM =
        ((cell.callCharmOI - cell.putCharmOI) * 100 * spotPrice * (1 / 252)) / 1e6;

      gex[exp.id] = Number(cellGexM.toFixed(2));
      vex[exp.id] = Number(cellVexM.toFixed(2));
      dex[exp.id] = Number(cellDexM.toFixed(2));
      charm[exp.id] = Number(cellCharmM.toFixed(2));

      const avgPct =
        cell.totalWeight > 0
          ? Math.max(-99, Math.min(199, Math.round(cell.weightedPctChange / cell.totalWeight)))
          : 0;
      openPctChange[exp.id] = avgPct;

      rowNetGex += cellGexM;
      rowAbsGex += Math.abs(cellGexM);
      rowCallGamma += callGexM;
      rowPutGamma += putGexM;

      totalNetGexMillions += cellGexM;
      totalNetVexMillions += cellVexM;

      if (Math.abs(cellGexM) > maxColAbsGex) {
        maxColAbsGex = Math.abs(cellGexM);
        kingPeakColId = exp.id;
      }
    }

    // Call Wall: Strike >= spotPrice with largest positive Call-only Gamma across active expirations
    if (strike >= spotPrice && rowCallGamma > bestCallWallGamma) {
      bestCallWallGamma = rowCallGamma;
      bestCallWallStrike = strike;
    }

    // Put Wall: Strike <= spotPrice with largest Put-only Gamma across active expirations
    if (strike <= spotPrice && rowPutGamma > bestPutWallGamma) {
      bestPutWallGamma = rowPutGamma;
      bestPutWallStrike = strike;
    }

    computedRowsAsc.push({
      strike,
      totalNetGex: Number(rowNetGex.toFixed(2)),
      totalAbsGex: Number(rowAbsGex.toFixed(2)),
      totalCallGamma: Number(rowCallGamma.toFixed(2)),
      totalPutGamma: Number(rowPutGamma.toFixed(2)),
      kingPeakColId,
      gex,
      vex,
      dex,
      charm,
      openPctChange,
    });
  }

  // 1. All-Exp King: largest absolute net GEX across all expiration columns
  let totalBoardGamma = 0;
  for (const row of computedRowsAsc) {
    totalBoardGamma += Math.abs(row.totalNetGex);
  }

  const sortedByAllExpGex = [...computedRowsAsc].sort(
    (a, b) => Math.abs(b.totalNetGex) - Math.abs(a.totalNetGex)
  );
  const kingRow = sortedByAllExpGex[0];
  const secondRow = sortedByAllExpGex[1] ?? sortedByAllExpGex[0];

  const allExpKing = kingRow ? kingRow.strike : preset.kingPreset.allExpKing;
  const kingValue = kingRow
    ? Math.max(0.1, Math.abs(kingRow.totalNetGex))
    : preset.kingPreset.kingValue;
  const secondLargestStrike = secondRow
    ? secondRow.strike
    : preset.kingPreset.secondLargestStrike;
  const secondLargestValue = secondRow
    ? Math.abs(secondRow.totalNetGex)
    : preset.kingPreset.secondLargestValue;

  // 2. 0DTE / Next-Exp King: nearest active session column (expirationIndex === 0 or dte === 0)
  const zeroDteCols = expirations.filter(
    (c, idx) => c.dteDays === 0 || idx === 0 || c.filterGroup === "0DTE"
  );
  const zeroDteCol = zeroDteCols[0] ?? expirations[0];
  const zeroDteDate = zeroDteCol?.dateLabel ?? referenceDate.slice(5);

  let best0DteStrike = allExpKing;
  let best0DteAbsVal = -1;
  for (const row of computedRowsAsc) {
    const val = Math.abs(row.gex[zeroDteCol.id] ?? 0);
    if (val > best0DteAbsVal) {
      best0DteAbsVal = val;
      best0DteStrike = row.strike;
    }
  }

  // 3. Week King: All expiration columns within next 7 calendar days inclusive of today (0 <= dte <= 7)
  const weekCols = expirations.filter((c) => c.dteDays >= 0 && c.dteDays <= 7);
  const weekColsToUse =
    weekCols.length > 0
      ? weekCols
      : expirations.slice(0, Math.min(5, expirations.length));

  let bestWeekStrike = allExpKing;
  let bestWeekAbsSum = -1;
  let bestWeekPeakColDate = weekColsToUse[0]?.dateLabel ?? zeroDteDate;

  for (const row of computedRowsAsc) {
    let weekSum = 0;
    let rowPeakAbs = -1;
    let rowPeakDate = weekColsToUse[0]?.dateLabel ?? zeroDteDate;

    for (const col of weekColsToUse) {
      const g = row.gex[col.id] ?? 0;
      weekSum += g;
      if (Math.abs(g) > rowPeakAbs) {
        rowPeakAbs = Math.abs(g);
        rowPeakDate = col.dateLabel;
      }
    }

    if (Math.abs(weekSum) > bestWeekAbsSum) {
      bestWeekAbsSum = Math.abs(weekSum);
      bestWeekStrike = row.strike;
      bestWeekPeakColDate = rowPeakDate;
    }
  }

  // 4. OPEX King: monthly expiration columns
  const opexCols = expirations.filter((c) => c.filterGroup === "OPEX");
  const opexColsToUse = opexCols.length > 0 ? opexCols : expirations.slice(-3);
  let bestOpexStrike = allExpKing;
  let bestOpexAbsSum = -1;
  let bestOpexPeakDate = opexColsToUse[0]?.dateLabel ?? "11-20";
  for (const row of computedRowsAsc) {
    let sum = 0;
    let rowPeak = -1;
    let peakD = opexColsToUse[0]?.dateLabel ?? "11-20";
    for (const col of opexColsToUse) {
      const g = row.gex[col.id] ?? 0;
      sum += g;
      if (Math.abs(g) > rowPeak) {
        rowPeak = Math.abs(g);
        peakD = col.dateLabel;
      }
    }
    if (Math.abs(sum) > bestOpexAbsSum) {
      bestOpexAbsSum = Math.abs(sum);
      bestOpexStrike = row.strike;
      bestOpexPeakDate = peakD;
    }
  }

  const zeroDteKingObj = {
    strike: best0DteStrike,
    label: `0DTE King (${zeroDteDate})`,
  };
  const thisWeekKingObj = {
    strike: bestWeekStrike,
    label: `Week King (${bestWeekPeakColDate})`,
  };
  const opexKingObj = {
    strike: bestOpexStrike,
    label: `OPEX King (${bestOpexPeakDate})`,
  };

  const kingByFilter = {
    ALL: { strike: allExpKing, label: "All-exp King" },
    "0DTE": zeroDteKingObj,
    THIS_WEEK: thisWeekKingObj,
    OPEX: opexKingObj,
  };

  const activeFilterObj =
    activeExpirationFilter === "THIS_WEEK"
      ? thisWeekKingObj
      : activeExpirationFilter === "OPEX"
        ? opexKingObj
        : zeroDteKingObj;

  const weeklyDate = bestWeekPeakColDate;

  // 5. King Strength (0–100)
  const leadScore = (1 - secondLargestValue / kingValue) * 50;
  const shareScore =
    Math.min(1, (kingValue / Math.max(0.1, totalBoardGamma)) / 0.25) * 50;
  const kingStrength = Math.round(
    Math.min(100, Math.max(0, leadScore + shareScore))
  );
  const isContested =
    kingValue > 0 && (kingValue - secondLargestValue) / kingValue <= 0.1;

  // 6. True Interpolated Zero γ (Gamma Flip) Solver
  // Group contracts by (strike, expiration) to speed up 41-point solver
  interface AggregatedContract {
    strike: number;
    T: number;
    iv: number;
    callOI: number;
    putOI: number;
  }
  const aggMap = new Map<string, AggregatedContract>();
  for (const c of selectedContracts) {
    const oi =
      c.openInterest > 0 ? c.openInterest : Math.round(c.volume * 0.35);
    if (oi <= 0) continue;
    const key = `${c.strike.toFixed(2)}_${c.expiration}`;
    let entry = aggMap.get(key);
    if (!entry) {
      const days = isoToDays.get(c.expiration) ?? 0;
      const iv =
        c.iv > 0.02
          ? c.iv > 4
            ? c.iv / 100
            : c.iv
          : impliedVolatility;
      entry = {
        strike: c.strike,
        T: getFractionalYearT(days),
        iv,
        callOI: 0,
        putOI: 0,
      };
      aggMap.set(key, entry);
    }
    if (c.optionType === "C") {
      entry.callOI += oi;
    } else {
      entry.putOI += oi;
    }
  }
  const aggList = Array.from(aggMap.values());

  // Test 41 hypothetical spot prices from 0.88 * spotPrice to 1.12 * spotPrice
  const testSpotCount = 41;
  const minSpot = 0.88 * spotPrice;
  const maxSpot = 1.12 * spotPrice;
  const spotStepSize = (maxSpot - minSpot) / (testSpotCount - 1);

  const curve: { s: number; netGex: number }[] = [];
  for (let i = 0; i < testSpotCount; i++) {
    const s = minSpot + i * spotStepSize;
    let totalGexAtS = 0;
    for (const item of aggList) {
      if (item.callOI === 0 && item.putOI === 0) continue;
      const sqrtT = Math.sqrt(item.T);
      const d1 =
        (Math.log(s / item.strike) +
          (0.045 - 0.012 + 0.5 * item.iv * item.iv) * item.T) /
        (item.iv * sqrtT);
      const pdfD1 = normPDF(d1);
      const discountQ = Math.exp(-0.012 * item.T);
      const gamma = (discountQ * pdfD1) / (s * item.iv * sqrtT);

      const netOi = item.callOI - item.putOI;
      totalGexAtS += (netOi * gamma * 100 * (s * s) * 0.01) / 1e6;
    }
    curve.push({ s, netGex: totalGexAtS });
  }

  // Find adjacent (S1, S2) closest to spotPrice with opposite signs and linearly interpolate
  interface ZeroCrossing {
    zeroPrice: number;
    distToSpot: number;
  }
  const crossings: ZeroCrossing[] = [];
  for (let i = 0; i < curve.length - 1; i++) {
    const p1 = curve[i];
    const p2 = curve[i + 1];
    if (
      (p1.netGex <= 0 && p2.netGex >= 0) ||
      (p1.netGex >= 0 && p2.netGex <= 0)
    ) {
      const denom = p2.netGex - p1.netGex;
      const zeroPrice =
        Math.abs(denom) > 1e-12
          ? p1.s - p1.netGex * ((p2.s - p1.s) / denom)
          : (p1.s + p2.s) / 2;
      crossings.push({
        zeroPrice,
        distToSpot: Math.abs(zeroPrice - spotPrice),
      });
    }
  }

  let zeroGammaPrice = spotPrice;
  if (crossings.length > 0) {
    crossings.sort((a, b) => a.distToSpot - b.distToSpot);
    zeroGammaPrice = Number(crossings[0].zeroPrice.toFixed(2));
  } else {
    // Fallback to minimum absolute GEX point within ±12%
    const minPoint = [...curve].sort(
      (a, b) => Math.abs(a.netGex) - Math.abs(b.netGex)
    )[0];
    zeroGammaPrice = Number(minPoint.s.toFixed(2));
  }

  // Sort strikes descending (highest strike at top of heatmap)
  const strikesDesc = [...computedRowsAsc].sort((a, b) => b.strike - a.strike);

  return {
    ticker,
    dataSource,
    lastUpdated: new Date().toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }),
    spotPrice: Number(spotPrice.toFixed(2)),
    previousClose: Number(previousClose.toFixed(2)),
    impliedVolatility: Number(impliedVolatility.toFixed(4)),
    strikeStep: detectedStep,
    netMetrics: {
      netGex: Number((totalNetGexMillions / 1000).toFixed(2)),
      netVex: Number(totalNetVexMillions.toFixed(1)),
    },
    gammaLevels: {
      callWall: bestCallWallStrike,
      putWall: bestPutWallStrike,
      zeroGamma: zeroGammaPrice,
    },
    kingNode: {
      allExpKing,
      filteredKing: activeFilterObj.strike,
      filteredLabel: activeFilterObj.label,
      zeroDteKing: zeroDteKingObj.strike,
      zeroDteDate,
      hasZeroDte,
      weeklyKing: thisWeekKingObj.strike,
      weeklyDate,
      kingValue: Number(kingValue.toFixed(1)),
      secondLargestStrike,
      secondLargestValue: Number(secondLargestValue.toFixed(1)),
      totalBoardGamma: Number(totalBoardGamma.toFixed(1)),
      kingStrength,
      isContested,
    },
    kingByFilter,
    expirations,
    strikes: strikesDesc,
  };
}

/**
 * Tier 3: Deterministic Fallback generator when offline or rate-limited
 */
export function buildSimulatedAnalyticsPayload(
  ticker: TickerSymbol,
  activeExpirationFilter = "0DTE"
): OptionsAnalyticsPayload {
  const preset = getTickerPreset(ticker);
  const step = preset.strikeStep;
  const centerStrike = Math.round(preset.spotPrice / step) * step;
  const halfRows = Math.min(110, Math.max(40, Math.round((preset.spotPrice * 0.15) / step)));

  const simExpirations = [
    "2026-10-16",
    "2026-10-19",
    "2026-10-20",
    "2026-10-21",
    "2026-10-22",
    "2026-10-23",
    "2026-10-26",
    "2026-10-30",
    "2026-11-06",
    "2026-11-13",
    "2026-11-20",
    "2026-12-18",
    "2027-01-15",
  ];

  const contracts: NormalizedOptionContract[] = [];
  for (let i = -halfRows; i <= halfRows; i++) {
    const strike = centerStrike + i * step;
    if (strike <= 0) continue;

    simExpirations.forEach((exp, expIdx) => {
      const distCall = Math.abs(strike - preset.gammaLevels.callWall) / (step * 8);
      const distPut = Math.abs(strike - preset.gammaLevels.putWall) / (step * 8);
      const callBell = Math.exp(-distCall * distCall);
      const putBell = Math.exp(-distPut * distPut);
      const dteScale = expIdx === 0 ? 1.4 : expIdx === 4 ? 1.7 : 0.9;

      const callOI = Math.round((800 + callBell * 18000) * dteScale);
      const putOI = Math.round((800 + putBell * 17000) * dteScale);

      contracts.push({
        symbol: `${ticker}_${exp}_C_${strike}`,
        expiration: exp,
        optionType: "C",
        strike,
        openInterest: callOI,
        volume: Math.round(callOI * 0.4),
        iv: preset.impliedVolatility,
        delta: 0,
        gamma: 0,
        vega: 0,
        percentChange: Math.round((callBell - 0.3) * 28),
      });

      contracts.push({
        symbol: `${ticker}_${exp}_P_${strike}`,
        expiration: exp,
        optionType: "P",
        strike,
        openInterest: putOI,
        volume: Math.round(putOI * 0.4),
        iv: preset.impliedVolatility,
        delta: 0,
        gamma: 0,
        vega: 0,
        percentChange: Math.round((putBell - 0.3) * 24),
      });
    });
  }

  return computeOptionsAnalytics({
    ticker,
    dataSource: "SIMULATED",
    spotPrice: preset.spotPrice,
    previousClose: preset.previousClose,
    impliedVolatility: preset.impliedVolatility,
    contracts,
    activeExpirationFilter,
  });
}
