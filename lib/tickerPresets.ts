export type TickerSymbol = string;

export interface NetMetrics {
  netGex: number; // in Billions ($B)
  netVex: number; // in Millions ($M)
  netDex?: number; // in Millions ($M)
  netCharm?: number; // in Millions ($M)
}

export interface GammaLevels {
  putWall: number; // Strike <= spot with highest put gamma (Pink)
  putWallGex?: number; // Put-only GEX in $M (negative)
  callWall: number; // Strike >= spot with highest call gamma (Cyan)
  callWallGex?: number; // Call-only GEX in $M (positive)
  zeroGamma: number; // Price where total dealer gamma flips sign (closest crossing within ±15%)
  hasZeroGammaFlip?: boolean;
}

export interface KingNodeMetrics {
  allExpKing: number;
  filteredKing: number;
  filteredLabel: string;
  zeroDteKing: number;
  zeroDteDate: string;
  hasZeroDte: boolean;
  weeklyKing: number;
  weeklyDate: string;
  kingValue: number; // $M at allExpKing
  secondLargestStrike: number;
  secondLargestValue: number; // $M at second-biggest strike
  totalBoardGamma: number; // Total absolute gamma across the board ($M)
  kingStrength: number; // 0-100 Hyperion King Strength score
  isContested: boolean; // True if secondLargest is within 10% of kingValue
}

export interface TickerPreset {
  ticker: string;
  name: string;
  spotPrice: number;
  previousClose: number;
  impliedVolatility: number; // decimal, e.g. 0.218 = 21.8%
  netMetrics: NetMetrics;
  gammaLevels: GammaLevels;
  gammaLevelsByFilter?: Record<string, GammaLevels>;
  kingPreset: {
    allExpKing: number;
    zeroDteKing: number;
    weeklyKing: number;
    opexKing: number;
    kingValue: number;
    secondLargestStrike: number;
    secondLargestValue: number;
    totalBoardGamma: number;
  };
  strikeStep: number;
}

export function calculateKingStrength(
  kingValue: number,
  secondLargest: number,
  totalBoardGamma: number
): number {
  if (kingValue <= 0 || totalBoardGamma <= 0) return 0;
  const leadScore = Math.max(0, (1 - secondLargest / kingValue) * 50);
  const shareScore = Math.min(1, kingValue / totalBoardGamma / 0.25) * 50;
  return Math.round(Math.min(100, Math.max(0, leadScore + shareScore)));
}

export function getTodayEtShort(): string {
  try {
    const d = new Date(
      new Date().toLocaleString("en-US", { timeZone: "America/New_York" })
    );
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${m}-${day}`;
  } catch {
    return "10-21";
  }
}

export function getFridayEtShort(): string {
  try {
    const d = new Date(
      new Date().toLocaleString("en-US", { timeZone: "America/New_York" })
    );
    const dayOfWeek = d.getDay();
    const diff = (5 - dayOfWeek + 7) % 7;
    const friday = new Date(d.getTime() + diff * 86400 * 1000);
    const m = String(friday.getMonth() + 1).padStart(2, "0");
    const day = String(friday.getDate()).padStart(2, "0");
    return `${m}-${day}`;
  } catch {
    return "10-23";
  }
}

export function buildKingNodeMetrics(
  preset: TickerPreset,
  expirationFilter: string,
  overrideAllExpKing?: number,
  overrideKingValue?: number,
  overrideSecondLargest?: number,
  overrideTotalBoard?: number,
  overrideZeroDteKing?: number,
  overrideWeeklyKing?: number,
  overrideDates?: { zeroDteDate?: string; weeklyDate?: string; hasZeroDte?: boolean }
): KingNodeMetrics {
  const allExpKing = overrideAllExpKing ?? preset.kingPreset.allExpKing;
  const kingValue = overrideKingValue ?? preset.kingPreset.kingValue;
  const secondLargestValue =
    overrideSecondLargest ?? preset.kingPreset.secondLargestValue;
  const totalBoardGamma =
    overrideTotalBoard ?? preset.kingPreset.totalBoardGamma;

  const zeroDteKing = overrideZeroDteKing ?? preset.kingPreset.zeroDteKing;
  const weeklyKing = overrideWeeklyKing ?? preset.kingPreset.weeklyKing;
  const zeroDteDate = overrideDates?.zeroDteDate ?? getTodayEtShort();
  const weeklyDate = overrideDates?.weeklyDate ?? getFridayEtShort();
  const hasZeroDte = overrideDates?.hasZeroDte ?? true;

  let filteredKing = zeroDteKing;
  let filteredLabel = `0DTE King (${zeroDteDate})`;

  if (expirationFilter === "THIS_WEEK") {
    filteredKing = weeklyKing;
    filteredLabel = `This Week King (${weeklyDate})`;
  } else if (expirationFilter === "OPEX") {
    filteredKing = preset.kingPreset.opexKing;
    filteredLabel = "OPEX King (11-20)";
  } else if (expirationFilter === "ALL") {
    filteredKing = allExpKing;
    filteredLabel = "All-exp King";
  } else {
    filteredKing = zeroDteKing;
    filteredLabel = `0DTE King (${zeroDteDate})`;
  }

  const kingStrength = calculateKingStrength(
    kingValue,
    secondLargestValue,
    totalBoardGamma
  );
  const isContested =
    kingValue > 0 && (kingValue - secondLargestValue) / kingValue <= 0.1;

  return {
    allExpKing,
    filteredKing,
    filteredLabel,
    zeroDteKing,
    zeroDteDate,
    hasZeroDte,
    weeklyKing,
    weeklyDate,
    kingValue,
    secondLargestStrike: preset.kingPreset.secondLargestStrike,
    secondLargestValue,
    totalBoardGamma,
    kingStrength,
    isContested,
  };
}

export const WATCH_LIST: string[] = [
  "SPY", "QQQ", "SPXW", "IWM", "NDXP", "DIA", "SMH", "TLT", "GLD", "SLV",
  "XLE", "TQQQ", "SOXL", "IBIT", "NVDA", "AAPL", "TSLA", "MSFT", "AMZN", "META",
  "GOOGL", "AVGO", "NFLX", "ORCL", "AMD", "MU", "INTC", "TSM", "ARM", "PLTR",
  "COIN", "MSTR", "HOOD", "SOFI", "SMCI", "CRWD", "UBER", "SHOP", "RBLX", "JPM",
  "BAC", "WMT", "COST", "XOM", "BA", "LLY", "GME", "RIVN", "MARA", "BABA", "SPCX",
];

export const WATCH_LEAD: string[] = ["SPY", "QQQ", "SPXW", "IWM", "NDXP", "DIA"];
export const WATCH_REST: string[] = WATCH_LIST.filter((t) => !WATCH_LEAD.includes(t));

export const ROW1_TICKERS: string[] = WATCH_LEAD;
export const ROW2_TICKERS: string[] = WATCH_REST;
export const ROW3_TICKERS: string[] = [];
export const ROW4_TICKERS: string[] = [];
export const ROW5_TICKERS: string[] = [];

export const TICKER_PILL_ROWS: string[][] = [WATCH_LEAD, WATCH_REST];
export const SUPPORTED_TICKERS: string[] = WATCH_LIST;

export const TICKER_PRESETS: Record<string, TickerPreset> = {
  SPY: {
    ticker: "SPY",
    name: "SPDR S&P 500 ETF Trust",
    spotPrice: 759.75,
    previousClose: 759.5,
    impliedVolatility: 0.146,
    netMetrics: { netGex: 1.66, netVex: 7220.0 },
    gammaLevels: { putWall: 760.0, putWallGex: -2074.07, zeroGamma: 772.9, callWall: 780.0, callWallGex: 1987.75, hasZeroGammaFlip: true },
    gammaLevelsByFilter: {
      ALL: { putWall: 760.0, putWallGex: -2074.07, zeroGamma: 772.9, callWall: 780.0, callWallGex: 1987.75, hasZeroGammaFlip: true },
      THIS_WEEK: { putWall: 769.0, putWallGex: -755.4, zeroGamma: 773.32, callWall: 780.0, callWallGex: 504.51, hasZeroGammaFlip: true },
      "0DTE": { putWall: 770.0, putWallGex: -134.44, zeroGamma: 765.81, callWall: 775.0, callWallGex: 269.8, hasZeroGammaFlip: true },
      OPEX: { putWall: 750.0, putWallGex: -735.05, zeroGamma: 771.65, callWall: 800.0, callWallGex: 1014.25, hasZeroGammaFlip: true },
    },
    kingPreset: {
      allExpKing: 760.0,
      zeroDteKing: 773.0,
      weeklyKing: 780.0,
      opexKing: 800.0,
      kingValue: 1780.0,
      secondLargestStrike: 780.0,
      secondLargestValue: 1590.0,
      totalBoardGamma: 30348.0,
    },
    strikeStep: 1,
  },
  QQQ: {
    ticker: "QQQ",
    name: "Invesco QQQ Trust",
    spotPrice: 709.33,
    previousClose: 728.0,
    impliedVolatility: 0.227,
    netMetrics: { netGex: -9.51, netVex: 892.3 },
    gammaLevels: { putWall: 705.0, zeroGamma: 730.43, callWall: 712.0 },
    kingPreset: {
      allExpKing: 710.0,
      zeroDteKing: 710.0,
      weeklyKing: 715.0,
      opexKing: 710.0,
      kingValue: 1790.5,
      secondLargestStrike: 705.0,
      secondLargestValue: 1269.8,
      totalBoardGamma: 12015.7,
    },
    strikeStep: 1,
  },
  SPX: {
    ticker: "SPX",
    name: "S&P 500 Index (CBOE)",
    spotPrice: 7648.34,
    previousClose: 7744.06,
    impliedVolatility: 0.144,
    netMetrics: { netGex: -11.45, netVex: 1640.8 },
    gammaLevels: { putWall: 7600.0, zeroGamma: 7710.0, callWall: 7700.0 },
    kingPreset: {
      allExpKing: 7650.0,
      zeroDteKing: 7650.0,
      weeklyKing: 7675.0,
      opexKing: 7700.0,
      kingValue: 840.0,
      secondLargestStrike: 7600.0,
      secondLargestValue: 510.0,
      totalBoardGamma: 3480.0,
    },
    strikeStep: 5,
  },
  SPXW: {
    ticker: "SPXW",
    name: "S&P 500 Weeklys (CBOE)",
    spotPrice: 7648.34,
    previousClose: 7744.06,
    impliedVolatility: 0.144,
    netMetrics: { netGex: -9.85, netVex: 1410.2 },
    gammaLevels: { putWall: 7600.0, zeroGamma: 7705.0, callWall: 7700.0 },
    kingPreset: {
      allExpKing: 7650.0,
      zeroDteKing: 7650.0,
      weeklyKing: 7650.0,
      opexKing: 7700.0,
      kingValue: 790.0,
      secondLargestStrike: 7600.0,
      secondLargestValue: 495.0,
      totalBoardGamma: 3120.0,
    },
    strikeStep: 5,
  },
  IWM: {
    ticker: "IWM",
    name: "iShares Russell 2000 ETF",
    spotPrice: 224.6,
    previousClose: 226.15,
    impliedVolatility: 0.245,
    netMetrics: { netGex: -0.94, netVex: -168.4 },
    gammaLevels: { putWall: 220.0, zeroGamma: 225.5, callWall: 228.0 },
    kingPreset: {
      allExpKing: 225.0,
      zeroDteKing: 224.0,
      weeklyKing: 225.0,
      opexKing: 225.0,
      kingValue: 136.4,
      secondLargestStrike: 220.0,
      secondLargestValue: 125.2,
      totalBoardGamma: 510.0,
    },
    strikeStep: 1,
  },
  NDX: {
    ticker: "NDX",
    name: "Nasdaq-100 Index",
    spotPrice: 29140.5,
    previousClose: 29680.0,
    impliedVolatility: 0.224,
    netMetrics: { netGex: -6.4, netVex: 520.0 },
    gammaLevels: { putWall: 29000.0, zeroGamma: 29450.0, callWall: 29500.0 },
    kingPreset: {
      allExpKing: 29200.0,
      zeroDteKing: 29150.0,
      weeklyKing: 29200.0,
      opexKing: 29500.0,
      kingValue: 460.0,
      secondLargestStrike: 29000.0,
      secondLargestValue: 265.0,
      totalBoardGamma: 1680.0,
    },
    strikeStep: 25,
  },
  NDXP: {
    ticker: "NDXP",
    name: "Nasdaq-100 PM-Settled",
    spotPrice: 29140.5,
    previousClose: 29680.0,
    impliedVolatility: 0.224,
    netMetrics: { netGex: -5.8, netVex: 485.0 },
    gammaLevels: { putWall: 29000.0, zeroGamma: 29425.0, callWall: 29500.0 },
    kingPreset: {
      allExpKing: 29150.0,
      zeroDteKing: 29150.0,
      weeklyKing: 29200.0,
      opexKing: 29400.0,
      kingValue: 410.0,
      secondLargestStrike: 29000.0,
      secondLargestValue: 245.0,
      totalBoardGamma: 1520.0,
    },
    strikeStep: 25,
  },
  DIA: {
    ticker: "DIA",
    name: "SPDR Dow Jones Industrial Average ETF",
    spotPrice: 432.15,
    previousClose: 434.8,
    impliedVolatility: 0.138,
    netMetrics: { netGex: 1.12, netVex: 142.0 },
    gammaLevels: { putWall: 428.0, zeroGamma: 430.5, callWall: 436.0 },
    kingPreset: {
      allExpKing: 435.0,
      zeroDteKing: 433.0,
      weeklyKing: 435.0,
      opexKing: 435.0,
      kingValue: 94.0,
      secondLargestStrike: 430.0,
      secondLargestValue: 61.0,
      totalBoardGamma: 390.0,
    },
    strikeStep: 1,
  },
  SMH: {
    ticker: "SMH",
    name: "VanEck Semiconductor ETF",
    spotPrice: 252.4,
    previousClose: 258.1,
    impliedVolatility: 0.365,
    netMetrics: { netGex: -1.42, netVex: -210.4 },
    gammaLevels: { putWall: 245.0, zeroGamma: 255.0, callWall: 260.0 },
    kingPreset: {
      allExpKing: 255.0,
      zeroDteKing: 252.0,
      weeklyKing: 255.0,
      opexKing: 260.0,
      kingValue: 148.0,
      secondLargestStrike: 250.0,
      secondLargestValue: 96.0,
      totalBoardGamma: 620.0,
    },
    strikeStep: 1,
  },
  TLT: {
    ticker: "TLT",
    name: "iShares 20+ Year Treasury Bond ETF",
    spotPrice: 92.85,
    previousClose: 92.1,
    impliedVolatility: 0.168,
    netMetrics: { netGex: 0.86, netVex: 95.4 },
    gammaLevels: { putWall: 90.0, zeroGamma: 91.5, callWall: 95.0 },
    kingPreset: {
      allExpKing: 93.0,
      zeroDteKing: 93.0,
      weeklyKing: 94.0,
      opexKing: 95.0,
      kingValue: 82.0,
      secondLargestStrike: 95.0,
      secondLargestValue: 54.0,
      totalBoardGamma: 320.0,
    },
    strikeStep: 1,
  },
  GLD: {
    ticker: "GLD",
    name: "SPDR Gold Shares",
    spotPrice: 251.2,
    previousClose: 249.4,
    impliedVolatility: 0.155,
    netMetrics: { netGex: 1.65, netVex: 188.0 },
    gammaLevels: { putWall: 246.0, zeroGamma: 248.5, callWall: 255.0 },
    kingPreset: {
      allExpKing: 250.0,
      zeroDteKing: 251.0,
      weeklyKing: 252.0,
      opexKing: 255.0,
      kingValue: 132.0,
      secondLargestStrike: 255.0,
      secondLargestValue: 84.0,
      totalBoardGamma: 510.0,
    },
    strikeStep: 1,
  },
  SLV: {
    ticker: "SLV",
    name: "iShares Silver Trust",
    spotPrice: 30.85,
    previousClose: 30.15,
    impliedVolatility: 0.295,
    netMetrics: { netGex: 0.64, netVex: 74.2 },
    gammaLevels: { putWall: 29.0, zeroGamma: 30.0, callWall: 32.0 },
    kingPreset: {
      allExpKing: 31.0,
      zeroDteKing: 31.0,
      weeklyKing: 31.5,
      opexKing: 32.0,
      kingValue: 68.0,
      secondLargestStrike: 30.0,
      secondLargestValue: 41.0,
      totalBoardGamma: 260.0,
    },
    strikeStep: 0.5,
  },
  XLE: {
    ticker: "XLE",
    name: "Energy Select Sector SPDR Fund",
    spotPrice: 89.4,
    previousClose: 90.25,
    impliedVolatility: 0.215,
    netMetrics: { netGex: -0.45, netVex: -62.0 },
    gammaLevels: { putWall: 87.0, zeroGamma: 90.0, callWall: 92.0 },
    kingPreset: {
      allExpKing: 90.0,
      zeroDteKing: 89.0,
      weeklyKing: 90.0,
      opexKing: 92.0,
      kingValue: 74.0,
      secondLargestStrike: 88.0,
      secondLargestValue: 49.0,
      totalBoardGamma: 295.0,
    },
    strikeStep: 1,
  },
  TQQQ: {
    ticker: "TQQQ",
    name: "ProShares UltraPro QQQ",
    spotPrice: 74.6,
    previousClose: 78.2,
    impliedVolatility: 0.645,
    netMetrics: { netGex: -1.15, netVex: -184.0 },
    gammaLevels: { putWall: 70.0, zeroGamma: 76.0, callWall: 78.0 },
    kingPreset: {
      allExpKing: 75.0,
      zeroDteKing: 75.0,
      weeklyKing: 76.0,
      opexKing: 80.0,
      kingValue: 112.0,
      secondLargestStrike: 70.0,
      secondLargestValue: 72.0,
      totalBoardGamma: 440.0,
    },
    strikeStep: 1,
  },
  SOXL: {
    ticker: "SOXL",
    name: "Direxion Daily Semiconductor Bull 3X",
    spotPrice: 34.8,
    previousClose: 36.9,
    impliedVolatility: 0.89,
    netMetrics: { netGex: -0.78, netVex: -128.0 },
    gammaLevels: { putWall: 32.0, zeroGamma: 36.0, callWall: 38.0 },
    kingPreset: {
      allExpKing: 35.0,
      zeroDteKing: 35.0,
      weeklyKing: 36.0,
      opexKing: 40.0,
      kingValue: 88.0,
      secondLargestStrike: 36.0,
      secondLargestValue: 56.0,
      totalBoardGamma: 340.0,
    },
    strikeStep: 0.5,
  },
  IBIT: {
    ticker: "IBIT",
    name: "iShares Bitcoin Trust ETF",
    spotPrice: 46.25,
    previousClose: 44.9,
    impliedVolatility: 0.54,
    netMetrics: { netGex: 1.38, netVex: 194.5 },
    gammaLevels: { putWall: 44.0, zeroGamma: 45.0, callWall: 48.0 },
    kingPreset: {
      allExpKing: 47.0,
      zeroDteKing: 47.0,
      weeklyKing: 47.0,
      opexKing: 50.0,
      kingValue: 164.0,
      secondLargestStrike: 45.0,
      secondLargestValue: 68.0,
      totalBoardGamma: 580.0,
    },
    strikeStep: 0.5,
  },
  NVDA: {
    ticker: "NVDA",
    name: "NVIDIA Corporation",
    spotPrice: 138.2,
    previousClose: 134.8,
    impliedVolatility: 0.482,
    netMetrics: { netGex: 1.92, netVex: 328.5 },
    gammaLevels: { putWall: 130.0, zeroGamma: 135.0, callWall: 145.0 },
    kingPreset: {
      allExpKing: 140.0,
      zeroDteKing: 139.0,
      weeklyKing: 140.0,
      opexKing: 145.0,
      kingValue: 228.0,
      secondLargestStrike: 145.0,
      secondLargestValue: 134.5,
      totalBoardGamma: 890.0,
    },
    strikeStep: 1,
  },
  AAPL: {
    ticker: "AAPL",
    name: "Apple Inc.",
    spotPrice: 231.75,
    previousClose: 229.9,
    impliedVolatility: 0.232,
    netMetrics: { netGex: 1.48, netVex: 215.9 },
    gammaLevels: { putWall: 225.0, zeroGamma: 229.5, callWall: 237.0 },
    kingPreset: {
      allExpKing: 235.0,
      zeroDteKing: 232.0,
      weeklyKing: 235.0,
      opexKing: 235.0,
      kingValue: 168.0,
      secondLargestStrike: 230.0,
      secondLargestValue: 82.0,
      totalBoardGamma: 610.0,
    },
    strikeStep: 1,
  },
  TSLA: {
    ticker: "TSLA",
    name: "Tesla, Inc.",
    spotPrice: 254.15,
    previousClose: 258.9,
    impliedVolatility: 0.564,
    netMetrics: { netGex: -1.35, netVex: -245.0 },
    gammaLevels: { putWall: 245.0, zeroGamma: 256.0, callWall: 265.0 },
    kingPreset: {
      allExpKing: 250.0,
      zeroDteKing: 255.0,
      weeklyKing: 252.0,
      opexKing: 250.0,
      kingValue: 172.0,
      secondLargestStrike: 260.0,
      secondLargestValue: 121.0,
      totalBoardGamma: 760.0,
    },
    strikeStep: 1,
  },
  MSFT: {
    ticker: "MSFT",
    name: "Microsoft Corporation",
    spotPrice: 428.5,
    previousClose: 425.2,
    impliedVolatility: 0.214,
    netMetrics: { netGex: 1.74, netVex: 242.0 },
    gammaLevels: { putWall: 420.0, zeroGamma: 424.0, callWall: 435.0 },
    kingPreset: {
      allExpKing: 430.0,
      zeroDteKing: 430.0,
      weeklyKing: 432.5,
      opexKing: 435.0,
      kingValue: 154.0,
      secondLargestStrike: 425.0,
      secondLargestValue: 98.0,
      totalBoardGamma: 590.0,
    },
    strikeStep: 2.5,
  },
  SMCI: {
    ticker: "SMCI",
    name: "Super Micro Computer, Inc.",
    spotPrice: 48.1,
    previousClose: 46.2,
    impliedVolatility: 0.78,
    netMetrics: { netGex: 0.92, netVex: 134.0 },
    gammaLevels: { putWall: 45.0, zeroGamma: 46.5, callWall: 50.0 },
    kingPreset: {
      allExpKing: 50.0,
      zeroDteKing: 49.0,
      weeklyKing: 50.0,
      opexKing: 50.0,
      kingValue: 145.0,
      secondLargestStrike: 45.0,
      secondLargestValue: 69.0,
      totalBoardGamma: 520.0,
    },
    strikeStep: 0.5,
  },
  ARM: {
    ticker: "ARM",
    name: "Arm Holdings plc",
    spotPrice: 152.4,
    previousClose: 149.1,
    impliedVolatility: 0.52,
    netMetrics: { netGex: 1.15, netVex: 162.0 },
    gammaLevels: { putWall: 145.0, zeroGamma: 149.0, callWall: 157.5 },
    kingPreset: {
      allExpKing: 155.0,
      zeroDteKing: 155.0,
      weeklyKing: 155.0,
      opexKing: 160.0,
      kingValue: 138.0,
      secondLargestStrike: 150.0,
      secondLargestValue: 78.0,
      totalBoardGamma: 540.0,
    },
    strikeStep: 2.5,
  },
  META: {
    ticker: "META",
    name: "Meta Platforms Inc.",
    spotPrice: 589.5,
    previousClose: 583.2,
    impliedVolatility: 0.34,
    netMetrics: { netGex: 2.45, netVex: 342.0 },
    gammaLevels: { putWall: 575.0, zeroGamma: 582.5, callWall: 600.0 },
    kingPreset: {
      allExpKing: 600.0,
      zeroDteKing: 590.0,
      weeklyKing: 600.0,
      opexKing: 600.0,
      kingValue: 268.0,
      secondLargestStrike: 585.0,
      secondLargestValue: 145.0,
      totalBoardGamma: 980.0,
    },
    strikeStep: 5,
  },
  COIN: {
    ticker: "COIN",
    name: "Coinbase Global Inc.",
    spotPrice: 214.8,
    previousClose: 208.4,
    impliedVolatility: 0.68,
    netMetrics: { netGex: 1.32, netVex: 198.0 },
    gammaLevels: { putWall: 200.0, zeroGamma: 210.0, callWall: 225.0 },
    kingPreset: {
      allExpKing: 220.0,
      zeroDteKing: 215.0,
      weeklyKing: 220.0,
      opexKing: 225.0,
      kingValue: 164.0,
      secondLargestStrike: 210.0,
      secondLargestValue: 96.0,
      totalBoardGamma: 610.0,
    },
    strikeStep: 2.5,
  },
  PLTR: {
    ticker: "PLTR",
    name: "Palantir Technologies Inc.",
    spotPrice: 43.2,
    previousClose: 42.1,
    impliedVolatility: 0.56,
    netMetrics: { netGex: 1.85, netVex: 230.0 },
    gammaLevels: { putWall: 40.0, zeroGamma: 42.0, callWall: 45.0 },
    kingPreset: {
      allExpKing: 45.0,
      zeroDteKing: 43.5,
      weeklyKing: 45.0,
      opexKing: 45.0,
      kingValue: 215.0,
      secondLargestStrike: 42.0,
      secondLargestValue: 112.0,
      totalBoardGamma: 780.0,
    },
    strikeStep: 0.5,
  },
  NFLX: {
    ticker: "NFLX",
    name: "Netflix Inc.",
    spotPrice: 722.4,
    previousClose: 714.8,
    impliedVolatility: 0.36,
    netMetrics: { netGex: 1.94, netVex: 274.0 },
    gammaLevels: { putWall: 700.0, zeroGamma: 715.0, callWall: 740.0 },
    kingPreset: {
      allExpKing: 730.0,
      zeroDteKing: 725.0,
      weeklyKing: 730.0,
      opexKing: 740.0,
      kingValue: 210.0,
      secondLargestStrike: 720.0,
      secondLargestValue: 128.0,
      totalBoardGamma: 810.0,
    },
    strikeStep: 5,
  },
  AMZN: {
    ticker: "AMZN",
    name: "Amazon.com Inc.",
    spotPrice: 188.6,
    previousClose: 186.9,
    impliedVolatility: 0.29,
    netMetrics: { netGex: 3.12, netVex: 428.0 },
    gammaLevels: { putWall: 182.5, zeroGamma: 185.0, callWall: 192.5 },
    kingPreset: {
      allExpKing: 190.0,
      zeroDteKing: 190.0,
      weeklyKing: 190.0,
      opexKing: 195.0,
      kingValue: 320.0,
      secondLargestStrike: 185.0,
      secondLargestValue: 184.0,
      totalBoardGamma: 1180.0,
    },
    strikeStep: 2.5,
  },
  GOOGL: {
    ticker: "GOOGL",
    name: "Alphabet Inc.",
    spotPrice: 166.8,
    previousClose: 165.2,
    impliedVolatility: 0.28,
    netMetrics: { netGex: 2.64, netVex: 356.0 },
    gammaLevels: { putWall: 162.5, zeroGamma: 165.0, callWall: 170.0 },
    kingPreset: {
      allExpKing: 170.0,
      zeroDteKing: 167.5,
      weeklyKing: 170.0,
      opexKing: 170.0,
      kingValue: 275.0,
      secondLargestStrike: 165.0,
      secondLargestValue: 160.0,
      totalBoardGamma: 990.0,
    },
    strikeStep: 2.5,
  },
};

export function getTickerPreset(rawTicker: string, liveSpot?: number): TickerPreset {
  const clean = rawTicker.trim().toUpperCase();

  // 1. Check live memory cache dynamically first
  const globalCache = (
    globalThis as unknown as {
      __hyperionOptionsMemoryCache?: Map<string, { timestamp: number; payload: any }>;
    }
  ).__hyperionOptionsMemoryCache;

  const cached = globalCache?.get(clean)?.payload;
  if (cached && cached.spotPrice > 0) {
    const spot = cached.spotPrice;
    const step = cached.strikeStep || (spot >= 250 ? 5 : spot >= 100 ? 2.5 : 1);
    const center = Math.round(spot / step) * step;
    return {
      ticker: clean,
      name: `${clean} Options Chain`,
      spotPrice: spot,
      previousClose: cached.previousClose ?? spot,
      impliedVolatility: cached.impliedVolatility ?? 0.25,
      netMetrics: cached.netMetrics ?? { netGex: 0, netVex: 0 },
      gammaLevels: cached.gammaLevels ?? {
        putWall: center - step * 3,
        zeroGamma: center,
        callWall: center + step * 3,
      },
      kingPreset: {
        allExpKing: cached.kingNode?.allExpKing ?? center,
        zeroDteKing: cached.kingNode?.zeroDteKing ?? cached.kingNode?.allExpKing ?? center,
        weeklyKing: cached.kingNode?.weeklyKing ?? cached.kingNode?.allExpKing ?? center,
        opexKing: cached.kingNode?.opexKing ?? cached.kingNode?.allExpKing ?? center,
        kingValue: cached.kingNode?.kingValue ?? 100,
        secondLargestStrike: cached.kingNode?.secondLargestStrike ?? center - step,
        secondLargestValue: cached.kingNode?.secondLargestValue ?? 50,
        totalBoardGamma: cached.kingNode?.totalBoardGamma ?? 500,
      },
      strikeStep: step,
    };
  }

  // 2. Check static presets (SPY, QQQ, etc. baseline fallbacks)
  if (TICKER_PRESETS[clean]) {
    const base = TICKER_PRESETS[clean];
    if (liveSpot && liveSpot > 0 && Math.abs(liveSpot - base.spotPrice) / base.spotPrice > 0.05) {
      // Dynamic scaling if liveSpot diverges from old static preset
      const step = base.strikeStep;
      const center = Math.round(liveSpot / step) * step;
      return {
        ...base,
        spotPrice: liveSpot,
        previousClose: liveSpot,
        gammaLevels: {
          putWall: center - step * 3,
          zeroGamma: center,
          callWall: center + step * 3,
        },
        kingPreset: {
          ...base.kingPreset,
          allExpKing: center,
          zeroDteKing: center,
          weeklyKing: center,
        },
      };
    }
    return base;
  }

  // 3. Dynamic synthesis for unlisted tickers (Zero hardcoded ASCII hash % 340)
  const baseSpot = liveSpot && liveSpot > 0 ? liveSpot : 100.0;
  const step = baseSpot >= 250 ? 5 : baseSpot >= 100 ? 2.5 : 1;
  const centerStrike = Math.round(baseSpot / step) * step;

  return {
    ticker: clean,
    name: `${clean} Options Chain`,
    spotPrice: baseSpot,
    previousClose: baseSpot,
    impliedVolatility: 0.25,
    netMetrics: {
      netGex: 0,
      netVex: 0,
    },
    gammaLevels: {
      putWall: centerStrike - step * 3,
      zeroGamma: centerStrike,
      callWall: centerStrike + step * 3,
    },
    kingPreset: {
      allExpKing: centerStrike,
      zeroDteKing: centerStrike,
      weeklyKing: centerStrike,
      opexKing: centerStrike + step,
      kingValue: 100.0,
      secondLargestStrike: centerStrike - step,
      secondLargestValue: 50.0,
      totalBoardGamma: 300.0,
    },
    strikeStep: step,
  };
}
