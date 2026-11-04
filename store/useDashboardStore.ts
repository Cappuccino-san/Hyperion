import { create } from "zustand";
import {
  buildSimulatedAnalyticsPayload,
  type ComputedStrikeRow,
  type DataSourceType,
  type ExpectedMovesPayload,
  type ExpirationColumnSpec,
  type ExtendedQuoteInfo,
  type OptionsAnalyticsPayload,
} from "@/lib/optionsExposure";
import type { PlaybookPayload, PlaybookPick } from "@/lib/types/playbook";
import { evaluateExecutionStatus } from "@/lib/playbookEngine";

export type ActiveView =
  | "Heatmap"
  | "Quad"
  | "Gaia"
  | "Atlas"
  | "Antaeus" // backward-compatible alias
  | "Scanner"
  | "Recap"
  | "Charts";
export * from "@/lib/tickerPresets";
import {
  type TickerSymbol,
  type NetMetrics,
  type GammaLevels,
  type KingNodeMetrics,
  type TickerPreset,
  calculateKingStrength,
  getTodayEtShort,
  getFridayEtShort,
  buildKingNodeMetrics,
  WATCH_LIST,
  WATCH_LEAD,
  WATCH_REST,
  ROW1_TICKERS,
  ROW2_TICKERS,
  ROW3_TICKERS,
  ROW4_TICKERS,
  ROW5_TICKERS,
  TICKER_PILL_ROWS,
  SUPPORTED_TICKERS,
  TICKER_PRESETS,
  getTickerPreset,
} from "@/lib/tickerPresets";

export type ExposureMetric = "GEX" | "VEX" | "DEX" | "Charm";
export type ExpirationFilter = "ALL" | "0DTE" | "THIS_WEEK" | "OPEX";
export type AlertType = "call" | "put" | "zero" | "king" | "bto" | "stc";

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

export interface FlowGammaVwapData {
  flowVwap: number;
  upper1s: number;
  lower1s: number;
  upper2s: number;
  lower2s: number;
  sigma: number;
}

export interface IntradayPoint {
  time: string;
  spot: number;
  callWall: number;
  putWall: number;
  zeroGamma: number;
  flowVwap?: number;
  upper1s?: number;
  lower1s?: number;
  upper2s?: number;
  lower2s?: number;
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
  allExpGammaLevels?: GammaLevels;
  gammaLevelsByFilter?: Record<string, GammaLevels> | null;
  spotPrice?: number;
}): { netMetrics: NetMetrics; kingNode: KingNodeMetrics; gammaLevels: GammaLevels } {
  const {
    expirationFilter,
    preset,
    expirations,
    strikes,
    allExpNetMetrics,
    allExpKingNode,
    allExpGammaLevels,
    gammaLevelsByFilter,
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
      zeroDteColsToUse[0]?.dateLabel ?? allExpKingNode.zeroDteDate ?? getTodayEtShort();

    // 2. Determine Week columns using TerraShade's exact inThisWeek (nearest exp through Friday of that week)
    const weekCols = expirations.filter((c) =>
      c.inThisWeek !== undefined
        ? c.inThisWeek
        : c.dteDays !== undefined
          ? c.dteDays >= 0 && c.dteDays <= 7
          : c.filterGroup === "0DTE" || c.filterGroup === "THIS_WEEK"
    );
    const weekColsToUse =
      weekCols.length > 0
        ? weekCols
        : expirations.slice(0, Math.min(5, expirations.length));

    // 3. Find 0DTE King, Week King, and All-Exp King directly from strikes
    let best0DteStrike = allExpKingNode.zeroDteKing ?? preset.kingPreset.zeroDteKing;
    let max0DteGamma = -1;

    let bestWeekStrike = allExpKingNode.weeklyKing ?? preset.kingPreset.weeklyKing;
    let maxWeekGamma = -1;
    let bestWeekPeakDate = weekColsToUse[0]?.dateLabel ?? zeroDteDate;

    const allRowBuckets: { strike: number; absGamma: number }[] = [];

    for (const row of strikes) {
      let rowAllSum = 0;
      for (const col of expirations) {
        rowAllSum += row.gex[col.id] ?? 0;
      }
      allRowBuckets.push({
        strike: row.strike,
        absGamma: Math.abs(rowAllSum),
      });

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

    allRowBuckets.sort((a, b) => b.absGamma - a.absGamma);
    const bestAll = allRowBuckets[0] ?? {
      strike: allExpKingNode.allExpKing,
      absGamma: allExpKingNode.kingValue,
    };
    const secondAll = allRowBuckets[1] ?? {
      strike: allExpKingNode.secondLargestStrike,
      absGamma: bestAll.absGamma * 0.6,
    };
    const totalAllGamma = allRowBuckets.reduce(
      (acc, item) => acc + item.absGamma,
      0
    );
    const allKingStrength = calculateKingStrength(
      bestAll.absGamma,
      secondAll.absGamma,
      Math.max(bestAll.absGamma, totalAllGamma)
    );
    const allIsContested =
      bestAll.absGamma >= 1 && secondAll.absGamma >= bestAll.absGamma * 0.9;

    const weeklyDate = bestWeekPeakDate;

    if (expirationFilter === "ALL") {
      return {
        netMetrics: { ...allExpNetMetrics },
        kingNode: {
          ...allExpKingNode,
          allExpKing: bestAll.strike,
          filteredKing: bestAll.strike,
          filteredLabel: "All-exp King",
          zeroDteKing: best0DteStrike,
          zeroDteDate,
          hasZeroDte,
          weeklyKing: bestWeekStrike,
          weeklyDate,
          kingValue: Number(bestAll.absGamma.toFixed(1)),
          secondLargestStrike: secondAll.strike,
          secondLargestValue: Number(secondAll.absGamma.toFixed(1)),
          totalBoardGamma: Number(totalAllGamma.toFixed(1)),
          kingStrength: allKingStrength,
          isContested: allIsContested,
        },
        gammaLevels: allExpGammaLevels ?? preset.gammaLevels,
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
      // Specific date selected from Date ▾ dropdown (e.g. "10-19", "10-23", or ISO date)
      matchingCols = expirations.filter(
        (c) =>
          c.dateLabel === expirationFilter ||
          c.id === expirationFilter ||
          c.isoDate === expirationFilter
      );
    }

    if (matchingCols.length === 0) {
      matchingCols = expirations;
    }

    let sumGexM = 0;
    let sumVexM = 0;
    let sumDexM = 0;
    let sumCharmM = 0;

    interface StrikeGammaBucket {
      strike: number;
      absGamma: number;
      peakDateLabel: string;
    }

    const rowBuckets: StrikeGammaBucket[] = [];

    for (const row of strikes) {
      let rowGexSum = 0;
      let peakColAbs = -1;
      let peakDateLabel = matchingCols[0]?.dateLabel ?? getTodayEtShort();

      for (const col of matchingCols) {
        const gVal = row.gex[col.id] ?? 0;
        const vVal = row.vex[col.id] ?? 0;
        const dVal = row.dex?.[col.id] ?? 0;
        const cVal = row.charm?.[col.id] ?? 0;
        sumGexM += gVal;
        sumVexM += vVal;
        sumDexM += dVal;
        sumCharmM += cVal;
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
      peakDateLabel: matchingCols[0]?.dateLabel ?? getTodayEtShort(),
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
      best.absGamma >= 1 && second.absGamma >= best.absGamma * 0.9;

    const prefix =
      expirationFilter === "0DTE"
        ? hasZeroDte
          ? "0DTE King"
          : "Next exp King"
        : expirationFilter === "THIS_WEEK"
          ? "Week King"
          : expirationFilter === "OPEX"
            ? "OPEX King"
            : `${best.peakDateLabel} King`;

    const spot = params.spotPrice ?? preset.spotPrice;

    // Resolve precomputed gamma levels for the active filter if present
    let filteredGammaLevels: GammaLevels | null = null;
    const byFilter = gammaLevelsByFilter ?? preset.gammaLevelsByFilter;
    if (byFilter) {
      if (expirationFilter === "THIS_WEEK" && byFilter.THIS_WEEK) {
        filteredGammaLevels = byFilter.THIS_WEEK;
      } else if (expirationFilter === "0DTE" && byFilter["0DTE"]) {
        filteredGammaLevels = byFilter["0DTE"];
      } else if (expirationFilter === "OPEX" && byFilter.OPEX) {
        filteredGammaLevels = byFilter.OPEX;
      } else if (byFilter[expirationFilter]) {
        filteredGammaLevels = byFilter[expirationFilter];
      }
    }

    if (!filteredGammaLevels) {
      let cw = spot;
      let maxCall = -1;
      let pw = spot;
      let maxPut = -1;

      for (const row of strikes) {
        let callSum = 0;
        let putSum = 0;
        for (const col of matchingCols) {
          callSum += row.callGex?.[col.id] ?? (row.gex[col.id] > 0 ? row.gex[col.id] : 0);
          putSum += row.putGex?.[col.id] ?? (row.gex[col.id] < 0 ? Math.abs(row.gex[col.id]) : 0);
        }
        if (row.strike >= spot && callSum > maxCall) {
          maxCall = callSum;
          cw = row.strike;
        }
        if (row.strike <= spot && putSum > maxPut) {
          maxPut = putSum;
          pw = row.strike;
        }
      }

      // Zero gamma interpolation
      const sortedStrikes = [...strikes].sort((a, b) => a.strike - b.strike);
      let zg = spot;
      let minDiff = Infinity;
      for (let i = 0; i < sortedStrikes.length - 1; i++) {
        const r1 = sortedStrikes[i];
        const r2 = sortedStrikes[i + 1];
        let net1 = 0;
        let net2 = 0;
        for (const col of matchingCols) {
          net1 += r1.gex[col.id] ?? 0;
          net2 += r2.gex[col.id] ?? 0;
        }
        if ((net1 < 0 && net2 >= 0) || (net1 >= 0 && net2 < 0)) {
          const denom = net2 - net1;
          const cross =
            Math.abs(denom) > 1e-12
              ? r1.strike - net1 * ((r2.strike - r1.strike) / denom)
              : (r1.strike + r2.strike) / 2;
          const diff = Math.abs(cross - spot);
          if (diff < minDiff) {
            minDiff = diff;
            zg = Number(cross.toFixed(1));
          }
        }
      }

      filteredGammaLevels = {
        callWall: cw,
        callWallGex: Number(Math.max(0, maxCall).toFixed(2)),
        putWall: pw,
        putWallGex: Number((-Math.max(0, maxPut)).toFixed(2)),
        zeroGamma: zg,
        hasZeroGammaFlip: minDiff < Infinity,
      };
    }

    return {
      netMetrics: {
        netGex: Number((sumGexM / 1000).toFixed(2)),
        netVex: Number(sumVexM.toFixed(1)),
        netDex: Number(sumDexM.toFixed(1)),
        netCharm: Number(sumCharmM.toFixed(1)),
      },
      kingNode: {
        allExpKing: bestAll.strike,
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
      gammaLevels: filteredGammaLevels,
    };
  }

  // Fallback calculation when strikes are not yet hydrated
  const scaleFactor =
    expirationFilter === "ALL"
      ? 1
      : expirationFilter === "0DTE"
        ? 0.38
        : 0.68;

  const fallbackLevels =
    (expirationFilter === "ALL"
      ? allExpGammaLevels
      : gammaLevelsByFilter?.[expirationFilter] ??
        preset.gammaLevelsByFilter?.[expirationFilter]) ??
    preset.gammaLevels;

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
    gammaLevels: fallbackLevels,
  };
}

export interface DiscordConfig {
  webhookUrl: string;
  enabled: boolean;
  notifyWalls: boolean;
  notifyZeroGamma: boolean;
  notifyKing: boolean;
}

export const DEFAULT_DISCORD_WEBHOOK_URL =
  "https://discord.com/api/webhooks/1562857850676449411/Qza12VWuPoBlek12-6o7V6fc2EscYDjIQrKw7KJyfB8Y3i9VAMvU7OJH0m7joqUH5arx";

export const DEFAULT_DISCORD_CONFIG: DiscordConfig = {
  webhookUrl: DEFAULT_DISCORD_WEBHOOK_URL,
  enabled: true,
  notifyWalls: false, // Silenced: Discord channel focuses exclusively on BTO/STC trade execution signals
  notifyZeroGamma: false, // Silenced
  notifyKing: false, // Silenced
};

const DISCORD_STORAGE_KEY = "hyperion_discord_config";
const LEGACY_DISCORD_STORAGE_KEY = ["terra", "shade_discord_config"].join("");

function getInitialDiscordConfig(): DiscordConfig {
  if (typeof window === "undefined") return DEFAULT_DISCORD_CONFIG;
  try {
    const saved =
      localStorage.getItem(DISCORD_STORAGE_KEY) ??
      localStorage.getItem(LEGACY_DISCORD_STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      return {
        ...DEFAULT_DISCORD_CONFIG,
        ...parsed,
        webhookUrl: parsed.webhookUrl?.trim() || DEFAULT_DISCORD_WEBHOOK_URL,
        enabled: parsed.enabled ?? true,
      };
    }
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
  bookTimestamp: string | null;
  spotPrice: number;
  previousClose: number;
  impliedVolatility: number;
  strikeStep: number;
  extendedQuote: ExtendedQuoteInfo | null;
  expectedMoves: ExpectedMovesPayload | null;
  netMetrics: NetMetrics;
  allExpNetMetrics: NetMetrics;
  gammaLevels: GammaLevels;
  allExpGammaLevels: GammaLevels;
  gammaLevelsByFilter: Record<string, GammaLevels> | null;
  kingNode: KingNodeMetrics;
  allExpKingNode: KingNodeMetrics;
  kingByFilter: OptionsAnalyticsPayload["kingByFilter"] | null;
  chainExpirations: ExpirationColumnSpec[];
  chainStrikes: ComputedStrikeRow[];
  gridFilters: GridFilters;
  alerts: AlertItem[];
  intradayData: IntradayPoint[];
  flowGammaVwapData: FlowGammaVwapData | null;
  discordConfig: DiscordConfig;
  isSetupModalOpen: boolean;
  gaiaMode: "classic" | "atlas";
  uiMode: "signal" | "quant";
  toggleUiMode: () => void;
  setUiMode: (mode: "signal" | "quant") => void;
  connectionStatus: "LIVE" | "SYNCING" | "RECONNECTING" | "OFFLINE";
  isStaleSnapshot: boolean;
  liveTickPrice: number | null;
  liveTickTimestamp: number;
  liveTickDirection: "up" | "down" | "flat";
  liveTickCount: number;
  setLiveTick: (ticker: string, price: number, timestamp?: number) => void;
  playbookPayload: PlaybookPayload | null;
  setPlaybookPayload: (payload: PlaybookPayload) => void;
  fetchPlaybook: () => Promise<void>;
  updatePlaybookWithSpot: (ticker: string, newSpot: number) => void;
  setActiveView: (view: ActiveView) => void;
  setGaiaMode: (mode: "classic" | "atlas") => void;
  setToastMessage: (msg: string | null) => void;
  setTicker: (ticker: string) => void;
  setFlowGammaVwapData: (data: FlowGammaVwapData | null) => void;
  fetchFlowGammaVwap: (ticker?: string) => Promise<void>;
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
const initialSimulated = buildSimulatedAnalyticsPayload("SPY");

export const useDashboardStore = create<DashboardState>((set, get) => ({
  activeView: "Heatmap",
  activeTicker: defaultPreset.ticker,
  dataSource: "SIMULATED",
  connectionStatus: "LIVE",
  isStaleSnapshot: false,
  isLoadingChain: false,
  liveTickPrice: null,
  liveTickTimestamp: 0,
  liveTickDirection: "flat",
  liveTickCount: 0,
  toastMessage: null,
  lastUpdated: "19:04 UTC",
  bookTimestamp: null,
  spotPrice: defaultPreset.spotPrice,
  previousClose: defaultPreset.previousClose,
  impliedVolatility: defaultPreset.impliedVolatility,
  strikeStep: defaultPreset.strikeStep,
  extendedQuote: null,
  expectedMoves: initialSimulated.expectedMoves ?? null,
  netMetrics: { ...defaultPreset.netMetrics },
  allExpNetMetrics: { ...defaultPreset.netMetrics },
  gammaLevels: { ...defaultPreset.gammaLevels },
  allExpGammaLevels: { ...defaultPreset.gammaLevels },
  gammaLevelsByFilter: defaultPreset.gammaLevelsByFilter ?? null,
  kingNode: defaultKing,
  allExpKingNode: defaultKing,
  kingByFilter: null,
  chainExpirations: initialSimulated.expirations,
  chainStrikes: initialSimulated.strikes,
  gridFilters: {
    metric: "GEX",
    expiration: "ALL",
  },
  alerts: [],
  intradayData: generateIntradayTrajectory({
    ticker: defaultPreset.ticker,
    spotPrice: defaultPreset.spotPrice,
    previousClose: defaultPreset.previousClose,
    gammaLevels: defaultPreset.gammaLevels,
    strikeStep: defaultPreset.strikeStep,
  }),
  flowGammaVwapData: {
    flowVwap: defaultPreset.spotPrice,
    upper1s: Number((defaultPreset.spotPrice + 1.25).toFixed(2)),
    lower1s: Number((defaultPreset.spotPrice - 1.25).toFixed(2)),
    upper2s: Number((defaultPreset.spotPrice + 2.5).toFixed(2)),
    lower2s: Number((defaultPreset.spotPrice - 2.5).toFixed(2)),
    sigma: 1.25,
  },
  discordConfig: getInitialDiscordConfig(),
  isSetupModalOpen: false,
  gaiaMode: "classic",
  uiMode: "signal",
  toggleUiMode: () =>
    set((state) => ({ uiMode: state.uiMode === "signal" ? "quant" : "signal" })),
  setUiMode: (mode) => set({ uiMode: mode }),
  playbookPayload: null,

  setPlaybookPayload: (payload) => {
    const currentSpot = get().spotPrice;
    const currentTicker = get().activeTicker.toUpperCase();
    const updatePick = (p: PlaybookPick) => {
      const spot =
        p.ticker.toUpperCase() === currentTicker
          ? currentSpot
          : p.currentSpot ?? p.priorClose;
      return {
        ...p,
        currentSpot: spot,
        status: evaluateExecutionStatus(p, spot),
      };
    };
    set({
      playbookPayload: {
        ...payload,
        picks: payload.picks.map(updatePick),
        topCalls: payload.topCalls?.map(updatePick),
        topPuts: payload.topPuts?.map(updatePick),
      },
    });
  },

  updatePlaybookWithSpot: (ticker, newSpot) => {
    set((state) => {
      if (!state.playbookPayload) return {};
      const target = ticker.toUpperCase();
      const updatePick = (p: PlaybookPick) => {
        if (p.ticker.toUpperCase() === target) {
          return {
            ...p,
            currentSpot: newSpot,
            status: evaluateExecutionStatus(p, newSpot),
          };
        }
        return p;
      };
      return {
        playbookPayload: {
          ...state.playbookPayload,
          picks: state.playbookPayload.picks.map(updatePick),
          topCalls: state.playbookPayload.topCalls?.map(updatePick),
          topPuts: state.playbookPayload.topPuts?.map(updatePick),
        },
      };
    });
  },

  fetchPlaybook: async () => {
    try {
      const res = await fetch("/api/scanner/playbook", { cache: "no-store" });
      if (res.ok) {
        const data: PlaybookPayload = await res.json();
        get().setPlaybookPayload(data);
      }
    } catch {
      // fallback handled gracefully
    }
  },

  setActiveView: (view) => {
    if (view === "Atlas") {
      set({ activeView: "Gaia" });
    } else {
      set({ activeView: view });
    }
  },
  setGaiaMode: (mode) => set({ gaiaMode: mode }),
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
      const isStandardFilter =
        state.gridFilters.expiration === "ALL" ||
        state.gridFilters.expiration === "0DTE" ||
        state.gridFilters.expiration === "THIS_WEEK" ||
        state.gridFilters.expiration === "OPEX";
      const safeExpFilter = isStandardFilter
        ? state.gridFilters.expiration
        : "ALL";

      const baseKing = buildKingNodeMetrics(preset, safeExpFilter);
      const filtered = computeFilteredSummaryMetrics({
        expirationFilter: safeExpFilter,
        preset,
        expirations: [],
        strikes: [],
        allExpNetMetrics: preset.netMetrics,
        allExpKingNode: baseKing,
        allExpGammaLevels: preset.gammaLevels,
        gammaLevelsByFilter: preset.gammaLevelsByFilter ?? null,
        spotPrice: preset.spotPrice,
      });

      return {
        activeTicker: preset.ticker,
        isLoadingChain: true,
        spotPrice: preset.spotPrice,
        liveTickPrice: null,
        liveTickTimestamp: 0,
        liveTickDirection: "flat",
        previousClose: preset.previousClose,
        impliedVolatility: preset.impliedVolatility,
        strikeStep: preset.strikeStep,
        extendedQuote: null,
        expectedMoves: null,
        netMetrics: filtered.netMetrics,
        allExpNetMetrics: { ...preset.netMetrics },
        gammaLevels: filtered.gammaLevels,
        allExpGammaLevels: { ...preset.gammaLevels },
        gammaLevelsByFilter: preset.gammaLevelsByFilter ?? null,
        kingNode: filtered.kingNode,
        allExpKingNode: baseKing,
        kingByFilter: null,
        chainExpirations: [],
        chainStrikes: [],
        gridFilters: {
          ...state.gridFilters,
          expiration: safeExpFilter,
        },
        alerts: [],
        intradayData: generateIntradayTrajectory({
          ticker: preset.ticker,
          spotPrice: preset.spotPrice,
          previousClose: preset.previousClose,
          gammaLevels: filtered.gammaLevels,
          strikeStep: preset.strikeStep,
        }),
        flowGammaVwapData: {
          flowVwap: preset.spotPrice,
          upper1s: Number((preset.spotPrice + 1.25).toFixed(2)),
          lower1s: Number((preset.spotPrice - 1.25).toFixed(2)),
          upper2s: Number((preset.spotPrice + 2.5).toFixed(2)),
          lower2s: Number((preset.spotPrice - 2.5).toFixed(2)),
          sigma: 1.25,
        },
      };
    });
    get().fetchFlowGammaVwap(preset.ticker).catch(() => {});
  },

  setLiveTick: (ticker, price, timestamp = Date.now()) =>
    set((state) => {
      if (ticker.toUpperCase() !== state.activeTicker.toUpperCase()) return state;
      if (!Number.isFinite(price) || price <= 0) return state;
      const prev = state.liveTickPrice ?? state.spotPrice;
      const direction: "up" | "down" | "flat" =
        price > prev + 0.001 ? "up" : price < prev - 0.001 ? "down" : state.liveTickDirection;
      return {
        spotPrice: price,
        liveTickPrice: price,
        liveTickTimestamp: timestamp,
        liveTickDirection: direction,
        liveTickCount: state.liveTickCount + 1,
      };
    }),

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

      let nextPlaybook = state.playbookPayload;
      if (nextPlaybook && nextPlaybook.picks.length > 0) {
        const updatePick = (p: PlaybookPick) => {
          if (p.ticker.toUpperCase() === state.activeTicker.toUpperCase()) {
            return {
              ...p,
              currentSpot: roundedSpot,
              status: evaluateExecutionStatus(p, roundedSpot),
            };
          }
          return p;
        };
        nextPlaybook = {
          ...nextPlaybook,
          picks: nextPlaybook.picks.map(updatePick),
          topCalls: nextPlaybook.topCalls?.map(updatePick),
          topPuts: nextPlaybook.topPuts?.map(updatePick),
        };
      }

      return {
        spotPrice: roundedSpot,
        netMetrics: {
          ...state.netMetrics,
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
        playbookPayload: nextPlaybook,
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
        allExpGammaLevels: {
          ...state.allExpGammaLevels,
          ...walls,
        },
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

      if (filters.expiration === undefined && filters.metric === undefined) {
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
        allExpGammaLevels: state.allExpGammaLevels,
        gammaLevelsByFilter: state.gammaLevelsByFilter,
        spotPrice: state.spotPrice,
      });

      return {
        gridFilters: nextFilters,
        netMetrics: filtered.netMetrics,
        kingNode: filtered.kingNode,
        gammaLevels: filtered.gammaLevels,
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
          getTodayEtShort(),
        hasZeroDte: payload.kingNode.hasZeroDte ?? true,
        weeklyKing:
          payload.kingNode.weeklyKing ??
          payload.kingByFilter?.THIS_WEEK?.strike ??
          preset.kingPreset.weeklyKing,
        weeklyDate:
          payload.kingNode.weeklyDate ??
          payload.kingByFilter?.THIS_WEEK?.label?.match(/\(([^)]+)\)/)?.[1] ??
          getFridayEtShort(),
      };

      const filtered = computeFilteredSummaryMetrics({
        expirationFilter: state.gridFilters.expiration,
        preset,
        expirations: payload.expirations,
        strikes: payload.strikes,
        allExpNetMetrics: payload.netMetrics,
        allExpKingNode: baseAllExpKingNode,
        allExpGammaLevels: payload.gammaLevels,
        gammaLevelsByFilter: payload.gammaLevelsByFilter ?? null,
        spotPrice: payload.spotPrice,
      });

      const isInitialChainHydration = state.chainStrikes.length === 0;
      const nextAlerts = [...state.alerts];

      const formattedTime = new Date().toLocaleTimeString("en-US", {
        hour12: true,
        hour: "numeric",
        minute: "2-digit",
      });

      if (!isInitialChainHydration) {
        if (
          filtered.kingNode.allExpKing !== state.allExpKingNode.allExpKing &&
          state.allExpKingNode.allExpKing > 0
        ) {
          nextAlerts.push({
            id: `${payload.ticker}-king-${Date.now() - 1}`,
            timestamp: formattedTime,
            type: "king",
            message: `${payload.ticker} King moved ${state.allExpKingNode.allExpKing.toFixed(0)} → ${filtered.kingNode.allExpKing.toFixed(0)}`,
          });
        }
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
        if (
          (state.spotPrice < state.gammaLevels.zeroGamma &&
            payload.spotPrice >= payload.gammaLevels.zeroGamma) ||
          (state.spotPrice >= state.gammaLevels.zeroGamma &&
            payload.spotPrice < payload.gammaLevels.zeroGamma)
        ) {
          const dir =
            payload.spotPrice >= payload.gammaLevels.zeroGamma
              ? "above"
              : "below";
          nextAlerts.push({
            id: `${payload.ticker}-zg-${Date.now() + 2}`,
            timestamp: formattedTime,
            type: "zero",
            message: `${payload.ticker} crossed ${dir} zero γ ($${payload.gammaLevels.zeroGamma.toFixed(2)}) — spot $${payload.spotPrice.toFixed(2)}`,
          });
        }
      }

      const nextIntraday: IntradayPoint[] =
        payload.intradayData && payload.intradayData.length >= 2
          ? payload.intradayData.map((d) => ({
              time: d.time,
              spot: d.spot,
              callWall: d.callWall ?? (d as any).cw ?? payload.gammaLevels.callWall,
              putWall: d.putWall ?? (d as any).pw ?? payload.gammaLevels.putWall,
              zeroGamma: d.zeroGamma ?? (d as any).zg ?? payload.gammaLevels.zeroGamma,
            }))
          : isInitialChainHydration ||
            Math.abs(payload.spotPrice - state.spotPrice) > payload.strikeStep * 10
            ? generateIntradayTrajectory({
                ticker: payload.ticker,
                spotPrice: payload.spotPrice,
                previousClose: payload.previousClose,
                gammaLevels: payload.gammaLevels,
                strikeStep: payload.strikeStep,
              })
            : [
                ...state.intradayData.slice(-168),
                {
                  time: payload.lastUpdated,
                  spot: payload.spotPrice,
                  callWall: payload.gammaLevels.callWall,
                  putWall: payload.gammaLevels.putWall,
                  zeroGamma: payload.gammaLevels.zeroGamma,
                },
              ];

      let resolvedAlerts: AlertItem[] = nextAlerts.slice(-50);
      if (Array.isArray(payload.alerts) && payload.alerts.length > 0) {
        const mappedServerAlerts: AlertItem[] = payload.alerts.map((a, i) => ({
          id: a.id || `${payload.ticker}-alert-${i}`,
          timestamp: a.timestamp || (a as any).time || formattedTime,
          message: a.message || (a as any).msg || "",
          type: a.type || "zero",
        }));
        const seenMessages = new Set(mappedServerAlerts.map((a) => a.message));
        const clientNew = nextAlerts.filter((a) => !seenMessages.has(a.message));
        resolvedAlerts = [...mappedServerAlerts, ...clientNew].slice(-50);
      }

      let nextPlaybook = state.playbookPayload;
      if (nextPlaybook && nextPlaybook.picks.length > 0) {
        const target = payload.ticker.toUpperCase();
        const updatePick = (p: PlaybookPick) => {
          if (p.ticker.toUpperCase() === target) {
            return {
              ...p,
              currentSpot: payload.spotPrice,
              gexKing: filtered.kingNode.allExpKing,
              status: evaluateExecutionStatus(p, payload.spotPrice),
            };
          }
          return p;
        };
        nextPlaybook = {
          ...nextPlaybook,
          picks: nextPlaybook.picks.map(updatePick),
          topCalls: nextPlaybook.topCalls?.map(updatePick),
          topPuts: nextPlaybook.topPuts?.map(updatePick),
        };
      }

      const resolvedAllExpKingNode: KingNodeMetrics = {
        ...baseAllExpKingNode,
        allExpKing: filtered.kingNode.allExpKing,
        zeroDteKing: filtered.kingNode.zeroDteKing,
        zeroDteDate: filtered.kingNode.zeroDteDate,
        hasZeroDte: filtered.kingNode.hasZeroDte,
        weeklyKing: filtered.kingNode.weeklyKing,
        weeklyDate: filtered.kingNode.weeklyDate,
      };

      return {
        dataSource: payload.dataSource,
        isLoadingChain: false,
        lastUpdated: payload.lastUpdated,
        bookTimestamp: payload.bookTimestamp ?? null,
        spotPrice: payload.spotPrice,
        previousClose: payload.previousClose,
        impliedVolatility: payload.impliedVolatility,
        strikeStep: payload.strikeStep,
        extendedQuote: payload.extendedQuote ?? null,
        expectedMoves: payload.expectedMoves ?? null,
        netMetrics: filtered.netMetrics,
        allExpNetMetrics: payload.netMetrics,
        gammaLevels: filtered.gammaLevels,
        allExpGammaLevels: payload.gammaLevels,
        gammaLevelsByFilter: payload.gammaLevelsByFilter ?? null,
        kingNode: filtered.kingNode,
        allExpKingNode: resolvedAllExpKingNode,
        kingByFilter: payload.kingByFilter,
        chainExpirations: payload.expirations,
        chainStrikes: payload.strikes,
        alerts: resolvedAlerts,
        intradayData: nextIntraday,
        playbookPayload: nextPlaybook,
      };
    });
  },

  setFlowGammaVwapData: (data) => set({ flowGammaVwapData: data }),

  fetchFlowGammaVwap: async (ticker) => {
    const targetTicker = (ticker ?? get().activeTicker).trim().toUpperCase();
    try {
      const res = await fetch(
        `/api/flow-vwap?ticker=${encodeURIComponent(targetTicker)}`,
        { cache: "no-store" }
      );
      if (!res.ok) return;
      const points = await res.json();
      if (Array.isArray(points) && points.length > 0) {
        const latest = points[points.length - 1];
        const sigma =
          latest.sigma ?? Math.max(0.316, latest.upper1Sigma - latest.flowVwap);
        set({
          flowGammaVwapData: {
            flowVwap: Number(latest.flowVwap.toFixed(2)),
            upper1s: Number((latest.upper1s ?? latest.upper1Sigma).toFixed(2)),
            lower1s: Number((latest.lower1s ?? latest.lower1Sigma).toFixed(2)),
            upper2s: Number((latest.upper2s ?? latest.upper2Sigma).toFixed(2)),
            lower2s: Number((latest.lower2s ?? latest.lower2Sigma).toFixed(2)),
            sigma: Number(sigma.toFixed(3)),
          },
        });
      }
    } catch {
      // Non-fatal background fetch
    }
  },

  fetchOptionsChain: async (ticker, force = false, showToastOnError = false) => {
    const targetTicker = (ticker ?? get().activeTicker).trim().toUpperCase();
    // Seamlessly update Flow VWAP during the 5-second polling cycle
    get().fetchFlowGammaVwap(targetTicker).catch(() => {});
    set({ isLoadingChain: true });
    try {
      const res = await fetch(
        `/api/options?ticker=${encodeURIComponent(targetTicker)}${force ? "&force=true" : ""}`,
        { cache: "no-store" }
      );
      if (!res.ok) {
        // If we already have live data for this ticker, retain the last verified valid snapshot!
        const state = get();
        if (state.activeTicker === targetTicker && state.chainStrikes.length > 0 && state.dataSource !== "SIMULATED") {
          set({
            isLoadingChain: false,
            connectionStatus: "SYNCING",
            isStaleSnapshot: true,
            toastMessage: showToastOnError ? `Reconnecting to options feed for ${targetTicker}...` : null,
          });
          return;
        }

        const fallback = buildSimulatedAnalyticsPayload(targetTicker);
        get().hydrateFromMarketData(fallback);
        set({
          isLoadingChain: false,
          connectionStatus: "OFFLINE",
          isStaleSnapshot: false,
          toastMessage: showToastOnError
            ? `Options feed connected (offline model for ${targetTicker})`
            : null,
        });
        return;
      }
      const payload: OptionsAnalyticsPayload = await res.json();
      get().hydrateFromMarketData(payload);

      const status: "LIVE" | "SYNCING" | "RECONNECTING" | "OFFLINE" =
        payload.connectionStatus ?? (payload.isStale ? "SYNCING" : payload.dataSource === "SIMULATED" ? "OFFLINE" : "LIVE");

      set({
        isLoadingChain: false,
        connectionStatus: status,
        isStaleSnapshot: !!payload.isStale,
        toastMessage: null,
      });
    } catch {
      // Network fetch failure: if valid data exists, serve last verified valid snapshot with SYNCING indicator
      const state = get();
      if (state.activeTicker === targetTicker && state.chainStrikes.length > 0 && state.dataSource !== "SIMULATED") {
        set({
          isLoadingChain: false,
          connectionStatus: "SYNCING",
          isStaleSnapshot: true,
          toastMessage: showToastOnError
            ? `Reconnecting to options feed for ${targetTicker}...`
            : null,
        });
      } else {
        const fallback = buildSimulatedAnalyticsPayload(targetTicker);
        get().hydrateFromMarketData(fallback);
        set({
          isLoadingChain: false,
          connectionStatus: "OFFLINE",
          isStaleSnapshot: false,
          toastMessage: showToastOnError
            ? `Operating in offline options simulation for ${targetTicker}`
            : null,
        });
      }
    }
  },
}));
