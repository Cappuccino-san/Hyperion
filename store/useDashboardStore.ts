import { create } from "zustand";
import type {
  ComputedStrikeRow,
  DataSourceType,
  ExpirationColumnSpec,
  OptionsAnalyticsPayload,
} from "@/lib/optionsExposure";

export type ActiveView = "Heatmap" | "Quad" | "Antaeus" | "Scanner" | "Charts";
export type TickerSymbol = string;
export type ExposureMetric = "GEX" | "VEX" | "DEX" | "Charm";
export type ExpirationFilter = "ALL" | "0DTE" | "THIS_WEEK" | "OPEX";
export type AlertType = "call" | "put" | "zero" | "king";

export interface NetMetrics {
  netGex: number; // in Billions ($B)
  netVex: number; // in Millions ($M)
}

export interface GammaLevels {
  putWall: number;   // Strike <= spot with highest put gamma (Pink)
  callWall: number;  // Strike >= spot with highest call gamma (Cyan)
  zeroGamma: number; // Price where total dealer gamma flips sign (closest crossing within ±15%)
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
  kingValue: number;          // $M at allExpKing
  secondLargestStrike: number;
  secondLargestValue: number; // $M at second-biggest strike
  totalBoardGamma: number;    // Total absolute gamma across the board ($M)
  kingStrength: number;       // 0-100 Hyperion King Strength score
  isContested: boolean;       // True if secondLargest is within 10% of kingValue
}

export interface GridFilters {
  metric: ExposureMetric;
  expiration: string;
}

export interface AlertItem {
  id: string;
  timestamp: string;
  message: string;
  type: AlertType;
}

export interface IntradayPoint {
  time: string;
  spot: number;
  callWall: number;
  putWall: number;
  zeroGamma: number;
}

export interface TickerPreset {
  ticker: string;
  name: string;
  spotPrice: number;
  previousClose: number;
  impliedVolatility: number; // decimal, e.g. 0.218 = 21.8%
  netMetrics: NetMetrics;
  gammaLevels: GammaLevels;
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
  const zeroDteDate = overrideDates?.zeroDteDate ?? "10-16";
  const weeklyDate = overrideDates?.weeklyDate ?? "10-16";
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

export const ROW1_TICKERS: string[] = [
  "SPY",
  "QQQ",
  "SPX",
  "SPXW",
  "IWM",
  "NDX",
  "NDXP",
  "DIA",
  "META",
  "COIN",
  "PLTR",
  "GME",
];

export const ROW2_TICKERS: string[] = [
  "SMH",
  "TLT",
  "GLD",
  "SLV",
  "XLE",
  "TQQQ",
  "SOXL",
  "IBIT",
  "NVDA",
  "AAPL",
  "TSLA",
  "MSFT",
  "AMZN",
];

export const ROW3_TICKERS: string[] = [
  "GOOGL",
  "AVGO",
  "NFLX",
  "ORCL",
  "AMD",
  "MU",
  "INTC",
  "TSM",
  "ARM",
  "MSTR",
  "HOOD",
  "SOFI",
];

export const ROW4_TICKERS: string[] = [
  "SMCI",
  "CRWD",
  "UBER",
  "SHOP",
  "RBLX",
  "JPM",
  "BAC",
  "WMT",
  "COST",
  "XOM",
  "BA",
  "LLY",
  "RIVN",
];

export const ROW5_TICKERS: string[] = ["MARA", "BABA", "SPCX"];

export const TICKER_PILL_ROWS: string[][] = [
  ROW1_TICKERS,
  ROW2_TICKERS,
  ROW3_TICKERS,
  ROW4_TICKERS,
  ROW5_TICKERS,
];

export const SUPPORTED_TICKERS: string[] = Array.from(
  new Set([
    ...ROW1_TICKERS,
    ...ROW2_TICKERS,
    ...ROW3_TICKERS,
    ...ROW4_TICKERS,
    ...ROW5_TICKERS,
  ])
);

export const TICKER_PRESETS: Record<string, TickerPreset> = {
  SPY: {
    ticker: "SPY",
    name: "SPDR S&P 500 ETF Trust",
    spotPrice: 761.64,
    previousClose: 771.79,
    impliedVolatility: 0.146,
    netMetrics: { netGex: -4.82, netVex: 642.5 },
    gammaLevels: { putWall: 755.0, zeroGamma: 768.0, callWall: 770.0 },
    kingPreset: {
      allExpKing: 760.0,
      zeroDteKing: 760.0,
      weeklyKing: 765.0,
      opexKing: 760.0,
      kingValue: 523.5,
      secondLargestStrike: 765.0,
      secondLargestValue: 340.0,
      totalBoardGamma: 2150.0,
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

export function getTickerPreset(rawTicker: string): TickerPreset {
  const clean = rawTicker.trim().toUpperCase();
  if (TICKER_PRESETS[clean]) {
    return TICKER_PRESETS[clean];
  }
  const hash = clean
    .split("")
    .reduce((acc, ch, idx) => acc + ch.charCodeAt(0) * (idx + 3), 0);
  const baseSpot = Number((60 + (hash % 340) + ((hash % 10) * 0.25)).toFixed(2));
  const step = baseSpot >= 250 ? 5 : baseSpot >= 100 ? 2.5 : 1;
  const centerStrike = Math.round(baseSpot / step) * step;
  const isPos = hash % 3 !== 0;

  return {
    ticker: clean,
    name: `${clean} Options Chain`,
    spotPrice: baseSpot,
    previousClose: Number((baseSpot * (isPos ? 0.988 : 1.012)).toFixed(2)),
    impliedVolatility: Number((0.26 + (hash % 35) * 0.01).toFixed(2)),
    netMetrics: {
      netGex: isPos ? Number((0.65 + (hash % 25) * 0.08).toFixed(2)) : Number((-0.45 - (hash % 20) * 0.07).toFixed(2)),
      netVex: isPos ? Number((95 + (hash % 180)).toFixed(1)) : Number((-80 - (hash % 140)).toFixed(1)),
    },
    gammaLevels: {
      putWall: centerStrike - step * 3,
      zeroGamma: isPos ? centerStrike - step : centerStrike + step,
      callWall: centerStrike + step * 3,
    },
    kingPreset: {
      allExpKing: centerStrike + step,
      zeroDteKing: centerStrike,
      weeklyKing: centerStrike + step,
      opexKing: centerStrike + step * 2,
      kingValue: 135.0,
      secondLargestStrike: centerStrike - step,
      secondLargestValue: 78.0,
      totalBoardGamma: 510.0,
    },
    strikeStep: step,
  };
}

function seededNoise(seed: number): number {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

export function generateIntradayTrajectory(params: {
  ticker: string;
  spotPrice: number;
  previousClose: number;
  gammaLevels: GammaLevels;
  strikeStep: number;
}): IntradayPoint[] {
  const { ticker, spotPrice, previousClose, gammaLevels, strikeStep } = params;
  const points: IntradayPoint[] = [];
  const totalPoints = 32;
  const startSpot = previousClose > 0 ? previousClose : spotPrice * 0.995;
  const endSpot = spotPrice;
  const range = Math.max(
    strikeStep * 4,
    Math.abs(gammaLevels.callWall - gammaLevels.putWall)
  );
  const tickerSeed = ticker
    .split("")
    .reduce((acc, ch) => acc + ch.charCodeAt(0), 0);

  let hour = 9;
  let minute = 30;

  for (let i = 0; i < totalPoints; i++) {
    const progress = i / (totalPoints - 1);
    const noise = (seededNoise(tickerSeed + i * 7) - 0.5) * range * 0.1;
    const interpolated =
      i === totalPoints - 1
        ? endSpot
        : startSpot + (endSpot - startSpot) * progress + noise;

    const wallShiftFactor = i < 8 ? -strikeStep : 0;

    const hh = String(hour).padStart(2, "0");
    const mm = String(minute).padStart(2, "0");

    points.push({
      time: `${hh}:${mm}:00`,
      spot: Number(interpolated.toFixed(2)),
      callWall: gammaLevels.callWall + wallShiftFactor,
      putWall: gammaLevels.putWall + wallShiftFactor,
      zeroGamma: gammaLevels.zeroGamma,
    });

    minute += 5;
    if (minute >= 60) {
      minute -= 60;
      hour += 1;
    }
  }

  return points;
}

function generateInitialAlerts(preset: TickerPreset): AlertItem[] {
  const { ticker, gammaLevels, strikeStep } = preset;
  const kingInfo = buildKingNodeMetrics(preset, "0DTE");
  const prevCall = gammaLevels.callWall + strikeStep * 5;
  const prevPut = gammaLevels.putWall + strikeStep * 3;
  const prevKing = kingInfo.allExpKing + strikeStep * 5;

  return [
    {
      id: `${ticker}-init-1`,
      timestamp: "10:15 AM",
      type: "king",
      message: `${ticker} King moved ${prevKing.toFixed(0)} → ${kingInfo.allExpKing.toFixed(0)}`,
    },
    {
      id: `${ticker}-init-2`,
      timestamp: "11:42 AM",
      type: "zero",
      message: `${ticker} Zero γ flipped at ${gammaLevels.zeroGamma.toFixed(0)}`,
    },
    {
      id: `${ticker}-init-3`,
      timestamp: "1:54 PM",
      type: "put",
      message: `${ticker} Put wall moved ${prevPut.toFixed(0)} → ${gammaLevels.putWall.toFixed(0)}`,
    },
    {
      id: `${ticker}-init-4`,
      timestamp: "3:45 PM",
      type: "call",
      message: `${ticker} Call wall moved ${prevCall.toFixed(0)} → ${gammaLevels.callWall.toFixed(0)}`,
    },
  ];
}

export function computeFilteredSummaryMetrics(params: {
  expirationFilter: string;
  preset: TickerPreset;
  expirations: ExpirationColumnSpec[];
  strikes: ComputedStrikeRow[];
  allExpNetMetrics: NetMetrics;
  allExpKingNode: KingNodeMetrics;
}): { netMetrics: NetMetrics; kingNode: KingNodeMetrics } {
  const {
    expirationFilter,
    preset,
    expirations,
    strikes,
    allExpNetMetrics,
    allExpKingNode,
  } = params;

  if (expirations.length > 0 && strikes.length > 0) {
    // 1. Determine 0DTE / Next-Exp columns and presence
    const zeroDteCols = expirations.filter(
      (c) => c.filterGroup === "0DTE" || c.tag === "0DTE"
    );
    const hasZeroDte = expirations.some((c) => c.tag === "0DTE");
    const zeroDteColsToUse =
      zeroDteCols.length > 0 ? zeroDteCols : expirations.slice(0, 1);
    const zeroDteDate =
      zeroDteColsToUse[0]?.dateLabel ?? allExpKingNode.zeroDteDate ?? "10-19";

    // 2. Determine Week columns: all columns within next 7 calendar days inclusive of today (0 <= dte <= 7)
    const weekCols = expirations.filter((c) =>
      c.dteDays !== undefined
        ? c.dteDays >= 0 && c.dteDays <= 7
        : c.filterGroup === "0DTE" || c.filterGroup === "THIS_WEEK"
    );
    const weekColsToUse =
      weekCols.length > 0
        ? weekCols
        : expirations.slice(0, Math.min(5, expirations.length));

    // 3. Find 0DTE King and Week King from strikes
    let best0DteStrike = allExpKingNode.zeroDteKing ?? preset.kingPreset.zeroDteKing;
    let max0DteGamma = -1;

    let bestWeekStrike = allExpKingNode.weeklyKing ?? preset.kingPreset.weeklyKing;
    let maxWeekGamma = -1;
    let bestWeekPeakDate = weekColsToUse[0]?.dateLabel ?? zeroDteDate;

    for (const row of strikes) {
      let row0DteSum = 0;
      for (const col of zeroDteColsToUse) {
        row0DteSum += row.gex[col.id] ?? 0;
      }
      if (Math.abs(row0DteSum) > max0DteGamma) {
        max0DteGamma = Math.abs(row0DteSum);
        best0DteStrike = row.strike;
      }

      let rowWeekSum = 0;
      let rowPeakAbs = -1;
      let rowPeakDate = weekColsToUse[0]?.dateLabel ?? zeroDteDate;

      for (const col of weekColsToUse) {
        const g = row.gex[col.id] ?? 0;
        rowWeekSum += g;
        if (Math.abs(g) > rowPeakAbs) {
          rowPeakAbs = Math.abs(g);
          rowPeakDate = col.dateLabel;
        }
      }

      if (Math.abs(rowWeekSum) > maxWeekGamma) {
        maxWeekGamma = Math.abs(rowWeekSum);
        bestWeekStrike = row.strike;
        bestWeekPeakDate = rowPeakDate;
      }
    }

    const weeklyDate = bestWeekPeakDate;

    if (expirationFilter === "ALL") {
      return {
        netMetrics: { ...allExpNetMetrics },
        kingNode: {
          ...allExpKingNode,
          zeroDteKing: best0DteStrike,
          zeroDteDate,
          hasZeroDte,
          weeklyKing: bestWeekStrike,
          weeklyDate,
        },
      };
    }

    let matchingCols: ExpirationColumnSpec[] = [];
    if (expirationFilter === "0DTE") {
      matchingCols = zeroDteColsToUse.slice(0, 1);
    } else if (expirationFilter === "THIS_WEEK") {
      matchingCols = weekColsToUse;
    } else if (expirationFilter === "OPEX") {
      matchingCols = expirations.filter((c) => c.filterGroup === "OPEX");
    } else {
      // Specific date selected from Date ▾ dropdown (e.g. "10-16", "10-23")
      matchingCols = expirations.filter(
        (c) => c.dateLabel === expirationFilter || c.id === expirationFilter
      );
    }

    if (matchingCols.length === 0) {
      matchingCols = expirations;
    }

    let sumGexM = 0;
    let sumVexM = 0;

    interface StrikeGammaBucket {
      strike: number;
      absGamma: number;
      peakDateLabel: string;
    }

    const rowBuckets: StrikeGammaBucket[] = [];

    for (const row of strikes) {
      let rowGexSum = 0;
      let peakColAbs = -1;
      let peakDateLabel = matchingCols[0]?.dateLabel ?? "10-16";

      for (const col of matchingCols) {
        const gVal = row.gex[col.id] ?? 0;
        const vVal = row.vex[col.id] ?? 0;
        sumGexM += gVal;
        sumVexM += vVal;
        rowGexSum += gVal;

        if (Math.abs(gVal) > peakColAbs) {
          peakColAbs = Math.abs(gVal);
          peakDateLabel = col.dateLabel;
        }
      }

      rowBuckets.push({
        strike: row.strike,
        absGamma: Math.abs(rowGexSum),
        peakDateLabel,
      });
    }

    rowBuckets.sort((a, b) => b.absGamma - a.absGamma);
    const best = rowBuckets[0] ?? {
      strike: allExpKingNode.allExpKing,
      absGamma: allExpKingNode.kingValue,
      peakDateLabel: matchingCols[0]?.dateLabel ?? "10-16",
    };
    const second = rowBuckets[1] ?? {
      strike: allExpKingNode.secondLargestStrike,
      absGamma: best.absGamma * 0.6,
      peakDateLabel: best.peakDateLabel,
    };
    const totalFilteredGamma = rowBuckets.reduce(
      (acc, item) => acc + item.absGamma,
      0
    );

    const kingStrength = calculateKingStrength(
      best.absGamma,
      second.absGamma,
      Math.max(best.absGamma, totalFilteredGamma)
    );
    const isContested =
      best.absGamma > 0 &&
      (best.absGamma - second.absGamma) / best.absGamma <= 0.1;

    const prefix =
      expirationFilter === "0DTE"
        ? "0DTE King"
        : expirationFilter === "OPEX"
          ? "OPEX King"
          : "Week King";

    return {
      netMetrics: {
        netGex: Number((sumGexM / 1000).toFixed(2)),
        netVex: Number(sumVexM.toFixed(1)),
      },
      kingNode: {
        allExpKing: allExpKingNode.allExpKing,
        filteredKing: best.strike,
        filteredLabel: `${prefix} (${best.peakDateLabel})`,
        zeroDteKing: best0DteStrike,
        zeroDteDate,
        hasZeroDte,
        weeklyKing: bestWeekStrike,
        weeklyDate,
        kingValue: Number(best.absGamma.toFixed(1)),
        secondLargestStrike: second.strike,
        secondLargestValue: Number(second.absGamma.toFixed(1)),
        totalBoardGamma: Number(totalFilteredGamma.toFixed(1)),
        kingStrength,
        isContested,
      },
    };
  }

  // Fallback calculation when strikes are not yet hydrated
  const scaleFactor =
    expirationFilter === "ALL"
      ? 1
      : expirationFilter === "0DTE"
        ? 0.38
        : 0.68;

  return {
    netMetrics: {
      netGex: Number((allExpNetMetrics.netGex * scaleFactor).toFixed(2)),
      netVex: Number((allExpNetMetrics.netVex * scaleFactor).toFixed(1)),
    },
    kingNode: buildKingNodeMetrics(
      preset,
      expirationFilter,
      allExpKingNode.allExpKing,
      Number((allExpKingNode.kingValue * scaleFactor).toFixed(1)),
      Number((allExpKingNode.secondLargestValue * scaleFactor).toFixed(1)),
      Number((allExpKingNode.totalBoardGamma * scaleFactor).toFixed(1)),
      allExpKingNode.zeroDteKing,
      allExpKingNode.weeklyKing,
      {
        zeroDteDate: allExpKingNode.zeroDteDate,
        weeklyDate: allExpKingNode.weeklyDate,
        hasZeroDte: allExpKingNode.hasZeroDte,
      }
    ),
  };
}

export interface DiscordConfig {
  webhookUrl: string;
  enabled: boolean;
  notifyWalls: boolean;
  notifyZeroGamma: boolean;
  notifyKing: boolean;
}

export const DEFAULT_DISCORD_CONFIG: DiscordConfig = {
  webhookUrl: "",
  enabled: true,
  notifyWalls: true,
  notifyZeroGamma: true,
  notifyKing: true,
};

const DISCORD_STORAGE_KEY = "hyperion_discord_config";
const LEGACY_DISCORD_STORAGE_KEY = ["terra", "shade_discord_config"].join("");

function getInitialDiscordConfig(): DiscordConfig {
  if (typeof window === "undefined") return DEFAULT_DISCORD_CONFIG;
  try {
    const saved =
      localStorage.getItem(DISCORD_STORAGE_KEY) ??
      localStorage.getItem(LEGACY_DISCORD_STORAGE_KEY);
    if (saved) return { ...DEFAULT_DISCORD_CONFIG, ...JSON.parse(saved) };
  } catch {}
  return DEFAULT_DISCORD_CONFIG;
}

let lastDiscordPostTime = 0;

export interface DashboardState {
  activeView: ActiveView;
  activeTicker: string;
  dataSource: DataSourceType;
  isLoadingChain: boolean;
  toastMessage: string | null;
  lastUpdated: string;
  spotPrice: number;
  previousClose: number;
  impliedVolatility: number;
  strikeStep: number;
  netMetrics: NetMetrics;
  allExpNetMetrics: NetMetrics;
  gammaLevels: GammaLevels;
  kingNode: KingNodeMetrics;
  allExpKingNode: KingNodeMetrics;
  kingByFilter: OptionsAnalyticsPayload["kingByFilter"] | null;
  chainExpirations: ExpirationColumnSpec[];
  chainStrikes: ComputedStrikeRow[];
  gridFilters: GridFilters;
  alerts: AlertItem[];
  intradayData: IntradayPoint[];
  discordConfig: DiscordConfig;
  isSetupModalOpen: boolean;
  setActiveView: (view: ActiveView) => void;
  setToastMessage: (msg: string | null) => void;
  setTicker: (ticker: string) => void;
  updateSpot: (newSpot: number, timeLabel?: string) => void;
  updateGammaWalls: (walls: Partial<GammaLevels>) => void;
  updateKingNode: (partial: Partial<KingNodeMetrics>) => void;
  addAlert: (alert: { message: string; type: AlertType; timestamp?: string }) => void;
  setFilters: (filters: Partial<GridFilters>) => void;
  setSetupModalOpen: (open: boolean) => void;
  updateDiscordConfig: (cfg: Partial<DiscordConfig>) => void;
  hydrateFromMarketData: (payload: OptionsAnalyticsPayload) => void;
  fetchOptionsChain: (
    ticker?: string,
    force?: boolean,
    showToastOnSimulated?: boolean
  ) => Promise<void>;
}

const defaultPreset = TICKER_PRESETS.SPY;
const defaultKing = buildKingNodeMetrics(defaultPreset, "0DTE");

export const useDashboardStore = create<DashboardState>((set, get) => ({
  activeView: "Heatmap",
  activeTicker: defaultPreset.ticker,
  dataSource: "SIMULATED",
  isLoadingChain: false,
  toastMessage: null,
  lastUpdated: "19:04 UTC",
  spotPrice: defaultPreset.spotPrice,
  previousClose: defaultPreset.previousClose,
  impliedVolatility: defaultPreset.impliedVolatility,
  strikeStep: defaultPreset.strikeStep,
  netMetrics: { ...defaultPreset.netMetrics },
  allExpNetMetrics: { ...defaultPreset.netMetrics },
  gammaLevels: { ...defaultPreset.gammaLevels },
  kingNode: defaultKing,
  allExpKingNode: defaultKing,
  kingByFilter: null,
  chainExpirations: [],
  chainStrikes: [],
  gridFilters: {
    metric: "GEX",
    expiration: "ALL",
  },
  alerts: generateInitialAlerts(defaultPreset),
  intradayData: generateIntradayTrajectory({
    ticker: defaultPreset.ticker,
    spotPrice: defaultPreset.spotPrice,
    previousClose: defaultPreset.previousClose,
    gammaLevels: defaultPreset.gammaLevels,
    strikeStep: defaultPreset.strikeStep,
  }),
  discordConfig: getInitialDiscordConfig(),
  isSetupModalOpen: false,

  setActiveView: (view) => set({ activeView: view }),
  setSetupModalOpen: (open) => set({ isSetupModalOpen: open }),
  updateDiscordConfig: (cfg) => {
    set((state) => {
      const next = { ...state.discordConfig, ...cfg };
      if (typeof window !== "undefined") {
        try {
          localStorage.setItem(DISCORD_STORAGE_KEY, JSON.stringify(next));
        } catch {}
      }
      return { discordConfig: next };
    });
  },

  setToastMessage: (msg) => set({ toastMessage: msg }),

  setTicker: (rawTicker) => {
    const preset = getTickerPreset(rawTicker);
    set((state) => {
      const baseKing = buildKingNodeMetrics(preset, state.gridFilters.expiration);
      const filtered = computeFilteredSummaryMetrics({
        expirationFilter: state.gridFilters.expiration,
        preset,
        expirations: [],
        strikes: [],
        allExpNetMetrics: preset.netMetrics,
        allExpKingNode: baseKing,
      });

      return {
        activeTicker: preset.ticker,
        isLoadingChain: true,
        spotPrice: preset.spotPrice,
        previousClose: preset.previousClose,
        impliedVolatility: preset.impliedVolatility,
        strikeStep: preset.strikeStep,
        netMetrics: filtered.netMetrics,
        allExpNetMetrics: { ...preset.netMetrics },
        gammaLevels: { ...preset.gammaLevels },
        kingNode: filtered.kingNode,
        allExpKingNode: baseKing,
        kingByFilter: null,
        chainExpirations: [],
        chainStrikes: [],
        gridFilters: {
          ...state.gridFilters,
        },
        alerts: generateInitialAlerts(preset),
        intradayData: generateIntradayTrajectory({
          ticker: preset.ticker,
          spotPrice: preset.spotPrice,
          previousClose: preset.previousClose,
          gammaLevels: preset.gammaLevels,
          strikeStep: preset.strikeStep,
        }),
      };
    });
  },

  updateSpot: (newSpot, timeLabel) => {
    const roundedSpot = Number(newSpot.toFixed(2));
    const nowLabel =
      timeLabel ??
      new Date().toLocaleTimeString("en-US", {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });

    set((state) => {
      const spotDelta = roundedSpot - state.spotPrice;
      const gexDrift = Number((state.netMetrics.netGex + spotDelta * 0.015).toFixed(2));
      const vexDrift = Number((state.netMetrics.netVex + spotDelta * 2.1).toFixed(1));

      const updatedKingValue = Math.max(
        1,
        Number((state.kingNode.kingValue + spotDelta * 0.6).toFixed(1))
      );
      const updatedStrength = calculateKingStrength(
        updatedKingValue,
        state.kingNode.secondLargestValue,
        state.kingNode.totalBoardGamma
      );
      const isContested =
        updatedKingValue > 0 &&
        (updatedKingValue - state.kingNode.secondLargestValue) /
          updatedKingValue <=
          0.1;

      const nextPoint: IntradayPoint = {
        time: nowLabel,
        spot: roundedSpot,
        callWall: state.gammaLevels.callWall,
        putWall: state.gammaLevels.putWall,
        zeroGamma: state.gammaLevels.zeroGamma,
      };

      const nextIntraday = [...state.intradayData.slice(-59), nextPoint];

      return {
        spotPrice: roundedSpot,
        netMetrics: {
          netGex: gexDrift,
          netVex: vexDrift,
        },
        kingNode: {
          ...state.kingNode,
          kingValue: updatedKingValue,
          kingStrength: updatedStrength,
          isContested,
        },
        intradayData: nextIntraday,
      };
    });
  },

  updateGammaWalls: (walls) => {
    set((state) => {
      const updatedWalls: GammaLevels = {
        ...state.gammaLevels,
        ...walls,
      };

      const updatedIntraday =
        state.intradayData.length > 0
          ? [
              ...state.intradayData.slice(0, -1),
              {
                ...state.intradayData[state.intradayData.length - 1],
                callWall: updatedWalls.callWall,
                putWall: updatedWalls.putWall,
                zeroGamma: updatedWalls.zeroGamma,
              },
            ]
          : state.intradayData;

      return {
        gammaLevels: updatedWalls,
        intradayData: updatedIntraday,
      };
    });
  },

  updateKingNode: (partial) => {
    set((state) => {
      const merged = { ...state.kingNode, ...partial };
      const kingStrength = calculateKingStrength(
        merged.kingValue,
        merged.secondLargestValue,
        merged.totalBoardGamma
      );
      const isContested =
        merged.kingValue > 0 &&
        (merged.kingValue - merged.secondLargestValue) / merged.kingValue <=
          0.1;
      return {
        kingNode: {
          ...merged,
          kingStrength,
          isContested,
        },
      };
    });
  },

  addAlert: ({ message, type, timestamp }) => {
    const nowLabel =
      timestamp ??
      new Date().toLocaleTimeString("en-US", {
        hour12: true,
        hour: "numeric",
        minute: "2-digit",
      });

    set((state) => ({
      alerts: [
        ...state.alerts.slice(-49),
        {
          id: `alert-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          timestamp: nowLabel,
          message,
          type,
        },
      ],
    }));

    // Non-blocking throttled Discord Webhook notification (max 1 per 10s)
    const config = get().discordConfig;
    if (config?.enabled && config?.webhookUrl) {
      const shouldNotify =
        ((type === "call" || type === "put") && config.notifyWalls) ||
        (type === "zero" && config.notifyZeroGamma) ||
        (type === "king" && config.notifyKing);

      if (shouldNotify) {
        const now = Date.now();
        if (now - lastDiscordPostTime >= 10000) {
          lastDiscordPostTime = now;
          fetch("/api/discord", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              webhookUrl: config.webhookUrl,
              ticker: get().activeTicker,
              spotPrice: get().spotPrice,
              eventType: type,
              message,
              callWall: get().gammaLevels.callWall,
              putWall: get().gammaLevels.putWall,
              zeroGamma: get().gammaLevels.zeroGamma,
              allExpKing: get().kingNode.allExpKing,
            }),
          }).catch(() => {});
        }
      }
    }
  },

  setFilters: (filters) => {
    set((state) => {
      const nextFilters = {
        ...state.gridFilters,
        ...filters,
      };

      if (filters.expiration === undefined) {
        return { gridFilters: nextFilters };
      }

      const preset = getTickerPreset(state.activeTicker);
      const filtered = computeFilteredSummaryMetrics({
        expirationFilter: nextFilters.expiration,
        preset,
        expirations: state.chainExpirations,
        strikes: state.chainStrikes,
        allExpNetMetrics: state.allExpNetMetrics,
        allExpKingNode: state.allExpKingNode,
      });

      return {
        gridFilters: nextFilters,
        netMetrics: filtered.netMetrics,
        kingNode: filtered.kingNode,
      };
    });
  },

  hydrateFromMarketData: (payload) => {
    set((state) => {
      if (payload.ticker !== state.activeTicker) {
        return state;
      }

      const preset = getTickerPreset(payload.ticker);
      const baseAllExpKingNode: KingNodeMetrics = {
        ...payload.kingNode,
        zeroDteKing:
          payload.kingNode.zeroDteKing ??
          payload.kingByFilter?.["0DTE"]?.strike ??
          preset.kingPreset.zeroDteKing,
        zeroDteDate:
          payload.kingNode.zeroDteDate ??
          payload.kingByFilter?.["0DTE"]?.label?.match(/\(([^)]+)\)/)?.[1] ??
          "10-16",
        hasZeroDte: payload.kingNode.hasZeroDte ?? true,
        weeklyKing:
          payload.kingNode.weeklyKing ??
          payload.kingByFilter?.THIS_WEEK?.strike ??
          preset.kingPreset.weeklyKing,
        weeklyDate:
          payload.kingNode.weeklyDate ??
          payload.kingByFilter?.THIS_WEEK?.label?.match(/\(([^)]+)\)/)?.[1] ??
          "10-16",
      };

      const filtered = computeFilteredSummaryMetrics({
        expirationFilter: state.gridFilters.expiration,
        preset,
        expirations: payload.expirations,
        strikes: payload.strikes,
        allExpNetMetrics: payload.netMetrics,
        allExpKingNode: baseAllExpKingNode,
      });

      const isInitialChainHydration = state.chainStrikes.length === 0;
      const nextAlerts = [...state.alerts];

      const formattedTime = new Date().toLocaleTimeString("en-US", {
        hour12: true,
        hour: "numeric",
        minute: "2-digit",
      });

      if (isInitialChainHydration) {
        const prevCall =
          payload.gammaLevels.callWall + payload.strikeStep * 5;
        nextAlerts.push({
          id: `${payload.ticker}-sync-cwall-${Date.now()}`,
          timestamp: formattedTime,
          type: "call",
          message: `${payload.ticker} Call wall moved ${prevCall.toFixed(0)} → ${payload.gammaLevels.callWall.toFixed(0)}`,
        });
      } else {
        if (payload.gammaLevels.callWall !== state.gammaLevels.callWall) {
          nextAlerts.push({
            id: `${payload.ticker}-cwall-${Date.now()}`,
            timestamp: formattedTime,
            type: "call",
            message: `${payload.ticker} Call wall moved ${state.gammaLevels.callWall.toFixed(0)} → ${payload.gammaLevels.callWall.toFixed(0)}`,
          });
        }
        if (payload.gammaLevels.putWall !== state.gammaLevels.putWall) {
          nextAlerts.push({
            id: `${payload.ticker}-pwall-${Date.now() + 1}`,
            timestamp: formattedTime,
            type: "put",
            message: `${payload.ticker} Put wall moved ${state.gammaLevels.putWall.toFixed(0)} → ${payload.gammaLevels.putWall.toFixed(0)}`,
          });
        }
      }

      const nextIntraday =
        isInitialChainHydration ||
        Math.abs(payload.spotPrice - state.spotPrice) > payload.strikeStep * 10
          ? generateIntradayTrajectory({
              ticker: payload.ticker,
              spotPrice: payload.spotPrice,
              previousClose: payload.previousClose,
              gammaLevels: payload.gammaLevels,
              strikeStep: payload.strikeStep,
            })
          : [
              ...state.intradayData.slice(-59),
              {
                time: payload.lastUpdated,
                spot: payload.spotPrice,
                callWall: payload.gammaLevels.callWall,
                putWall: payload.gammaLevels.putWall,
                zeroGamma: payload.gammaLevels.zeroGamma,
              },
            ];

      return {
        dataSource: payload.dataSource,
        isLoadingChain: false,
        lastUpdated: payload.lastUpdated,
        spotPrice: payload.spotPrice,
        previousClose: payload.previousClose,
        impliedVolatility: payload.impliedVolatility,
        strikeStep: payload.strikeStep,
        netMetrics: filtered.netMetrics,
        allExpNetMetrics: payload.netMetrics,
        gammaLevels: payload.gammaLevels,
        kingNode: filtered.kingNode,
        allExpKingNode: baseAllExpKingNode,
        kingByFilter: payload.kingByFilter,
        chainExpirations: payload.expirations,
        chainStrikes: payload.strikes,
        alerts: nextAlerts.slice(-50),
        intradayData: nextIntraday,
      };
    });
  },

  fetchOptionsChain: async (ticker, force = false, showToastOnError = false) => {
    const targetTicker = (ticker ?? get().activeTicker).trim().toUpperCase();
    set({ isLoadingChain: true });
    try {
      const res = await fetch(
        `/api/options?ticker=${encodeURIComponent(targetTicker)}${force ? "&force=true" : ""}`,
        { cache: "no-store" }
      );
      if (!res.ok) {
        set({
          isLoadingChain: false,
          ...(showToastOnError
            ? { toastMessage: `Live options feed unavailable for ${targetTicker}` }
            : {}),
        });
        return;
      }
      const payload: OptionsAnalyticsPayload = await res.json();
      get().hydrateFromMarketData(payload);
      if (showToastOnError) {
        set({ toastMessage: null });
      }
    } catch {
      set({
        isLoadingChain: false,
        ...(showToastOnError
          ? { toastMessage: `Live options feed unavailable for ${targetTicker}` }
          : {}),
      });
    }
  },
}));
