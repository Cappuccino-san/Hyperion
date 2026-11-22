import { create } from "zustand";
import {
  type ComputedStrikeRow,
  type DataSourceType,
  type ExpectedMovesPayload,
  type ExpirationColumnSpec,
  type ExtendedQuoteInfo,
  type OptionsAnalyticsPayload,
} from "@/lib/optionsExposure";
import type { PlaybookPayload, PlaybookPick } from "@/lib/types/playbook";
import type { SessionPlaybookPolicy } from "@/lib/persistenceStore";
import { evaluateExecutionStatus } from "@/lib/playbookEngine";

export type ActiveView =
  | "Heatmap"
  | "Quad"
  | "Gaia"
  | "Scanner"
  | "Recap";
export * from "@/lib/tickerPresets";
import {
  type NetMetrics,
  type GammaLevels,
  type KingNodeMetrics,
  type TickerPreset,
  calculateKingStrength,
  getTodayEtShort,
  getFridayEtShort,
  buildKingNodeMetrics,
  getStaticTickerPreset,
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

    const spot = params.spotPrice && params.spotPrice > 0 ? params.spotPrice : preset.spotPrice;

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
      let maxCall = 0;
      let pw = spot;
      let maxPut = 0;

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
      netDex: Number(((allExpNetMetrics.netDex ?? 0) * scaleFactor).toFixed(1)),
      netCharm: Number(((allExpNetMetrics.netCharm ?? 0) * scaleFactor).toFixed(1)),
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
}

export const DEFAULT_DISCORD_WEBHOOK_URL = "";

export const DEFAULT_DISCORD_CONFIG: DiscordConfig = {
  webhookUrl: DEFAULT_DISCORD_WEBHOOK_URL,
  enabled: false,
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
      const savedUrl = typeof parsed.webhookUrl === "string" ? parsed.webhookUrl.trim() : "";
      return {
        webhookUrl: savedUrl || DEFAULT_DISCORD_WEBHOOK_URL,
        enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : Boolean(savedUrl),
      };
    }
  } catch {}
  return DEFAULT_DISCORD_CONFIG;
}

let optionsAbortCtrl: AbortController | null = null;
let optionsReqSeq = 0;
let flowVwapAbortCtrl: AbortController | null = null;
let flowVwapReqSeq = 0;
let serverTradesAbortCtrl: AbortController | null = null;
let serverTradesReqSeq = 0;
let localAlertSeq = 0;

export interface DashboardState {
  activeView: ActiveView;
  activeTicker: string;
  loadedTicker: string;
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
  uiMode: "signal" | "quant";
  toggleUiMode: () => void;
  setUiMode: (mode: "signal" | "quant") => void;
  connectionStatus: "LIVE" | "SYNCING" | "RECONNECTING" | "OFFLINE";
  isStaleSnapshot: boolean;
  cboeSpotLagDollars: number | null;
  optionsCacheAgeSec: number | null;
  executionArmState: "PAPER" | "LOCKED";
  audioAlertsMuted: boolean;
  setExecutionArmState: (mode: "PAPER" | "LOCKED") => void;
  toggleExecutionLock: (flattenPaper?: boolean) => Promise<void>;
  setAudioAlertsMuted: (muted: boolean) => void;
  liveTickPrice: number | null;
  liveTickTimestamp: number;
  liveTickDirection: "up" | "down" | "flat";
  liveTickCount: number;
  liveTickMarketOpen: boolean | null;
  setLiveTick: (ticker: string, price: number, timestamp?: number, marketOpen?: boolean) => void;
  serverActivePositions: Record<string, any>;
  serverClosedTrades: any[];
  serverTradeAlerts: any[];
  serverTradesLoaded: boolean;
  supervisorPolicy: SessionPlaybookPolicy | null;
  setServerTrades: (payload: {
    activePositions?: Record<string, any>;
    closedPositions?: any[];
    alerts?: any[];
    supervisorPolicy?: SessionPlaybookPolicy | null;
    loaded?: boolean;
  }) => void;
  fetchServerTrades: (ticker?: string, sessionDate?: string) => Promise<void>;
  playbookPayload: PlaybookPayload | null;
  setPlaybookPayload: (payload: PlaybookPayload) => void;
  fetchPlaybook: () => Promise<void>;
  updatePlaybookWithSpot: (ticker: string, newSpot: number) => void;
  setActiveView: (view: ActiveView) => void;
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
  hydrateDiscordConfig: () => void;
  updateDiscordConfig: (cfg: Partial<DiscordConfig>) => void;
  hydrateFromMarketData: (payload: OptionsAnalyticsPayload) => void;
  fetchOptionsChain: (
    ticker?: string,
    force?: boolean,
    showToastOnSimulated?: boolean
  ) => Promise<void>;
}

const EMPTY_NET_METRICS: NetMetrics = {
  netGex: 0,
  netVex: 0,
  netDex: 0,
  netCharm: 0,
};

const EMPTY_GAMMA_LEVELS: GammaLevels = {
  putWall: 0,
  callWall: 0,
  zeroGamma: 0,
  hasZeroGammaFlip: false,
};

const EMPTY_KING_NODE: KingNodeMetrics = {
  allExpKing: 0,
  filteredKing: 0,
  filteredLabel: "Syncing...",
  zeroDteKing: 0,
  zeroDteDate: "",
  hasZeroDte: false,
  weeklyKing: 0,
  weeklyDate: "",
  kingValue: 0,
  secondLargestStrike: 0,
  secondLargestValue: 0,
  totalBoardGamma: 0,
  kingStrength: 0,
  isContested: false,
};

export const useDashboardStore = create<DashboardState>((set, get) => ({
  activeView: "Heatmap",
  activeTicker: "SPY",
  loadedTicker: "SPY",
  dataSource: "CBOE_MARKET_DATA",
  connectionStatus: "SYNCING",
  isStaleSnapshot: false,
  cboeSpotLagDollars: null,
  optionsCacheAgeSec: null,
  executionArmState: "PAPER",
  audioAlertsMuted: false,
  isLoadingChain: true,
  liveTickPrice: null,
  liveTickTimestamp: 0,
  liveTickDirection: "flat",
  liveTickCount: 0,
  liveTickMarketOpen: null,
  toastMessage: null,
  lastUpdated: "--:-- ET",
  bookTimestamp: null,
  spotPrice: 0,
  previousClose: 0,
  impliedVolatility: 0,
  strikeStep: 1,
  extendedQuote: null,
  expectedMoves: null,
  netMetrics: { ...EMPTY_NET_METRICS },
  allExpNetMetrics: { ...EMPTY_NET_METRICS },
  gammaLevels: { ...EMPTY_GAMMA_LEVELS },
  allExpGammaLevels: { ...EMPTY_GAMMA_LEVELS },
  gammaLevelsByFilter: null,
  kingNode: { ...EMPTY_KING_NODE },
  allExpKingNode: { ...EMPTY_KING_NODE },
  kingByFilter: null,
  chainExpirations: [],
  chainStrikes: [],
  gridFilters: {
    metric: "GEX",
    expiration: "ALL",
  },
  alerts: [],
  intradayData: [],
  flowGammaVwapData: null,
  discordConfig: DEFAULT_DISCORD_CONFIG,
  isSetupModalOpen: false,
  uiMode: "signal",
  toggleUiMode: () =>
    set((state) => ({ uiMode: state.uiMode === "signal" ? "quant" : "signal" })),
  setUiMode: (mode) => set({ uiMode: mode }),
  serverActivePositions: {},
  serverClosedTrades: [],
  serverTradeAlerts: [],
  serverTradesLoaded: false,
  supervisorPolicy: null,
  setServerTrades: (payload) =>
    set((state) => ({
      serverActivePositions: payload.activePositions ?? {},
      serverClosedTrades: payload.closedPositions ?? [],
      serverTradeAlerts: payload.alerts ?? [],
      serverTradesLoaded: payload.loaded ?? true,
      supervisorPolicy:
        payload.supervisorPolicy !== undefined
          ? payload.supervisorPolicy
          : state.supervisorPolicy,
    })),
  fetchServerTrades: async (ticker, sessionDate) => {
    const targetTicker = (ticker || get().activeTicker || "SPY").toUpperCase();
    serverTradesAbortCtrl?.abort();
    const ctrl = new AbortController();
    serverTradesAbortCtrl = ctrl;
    const reqId = ++serverTradesReqSeq;
    const dateParam =
      sessionDate && /^\d{4}-\d{2}-\d{2}$/.test(sessionDate)
        ? `&date=${encodeURIComponent(sessionDate)}`
        : "";
    try {
      const res = await fetch(
        `/api/signals?ticker=${encodeURIComponent(targetTicker)}${dateParam}`,
        { cache: "no-store", keepalive: true, signal: ctrl.signal }
      );
      if (
        ctrl.signal.aborted ||
        reqId !== serverTradesReqSeq ||
        get().activeTicker.toUpperCase() !== targetTicker
      ) {
        return;
      }
      if (res.ok) {
        const data = await res.json();
        if (
          ctrl.signal.aborted ||
          reqId !== serverTradesReqSeq ||
          get().activeTicker.toUpperCase() !== targetTicker
        ) {
          return;
        }
        set({
          serverActivePositions: data?.activePositions ?? {},
          serverClosedTrades: data?.closedPositions ?? [],
          serverTradeAlerts: data?.alerts ?? [],
          serverTradesLoaded: true,
          supervisorPolicy: data?.supervisorPolicy ?? null,
          ...(typeof data?.executionLocked === "boolean"
            ? { executionArmState: data.executionLocked ? "LOCKED" : "PAPER" }
            : {}),
        });
      }
    } catch {
      // silent fallback
    }
  },
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

  setActiveView: (view) => set({ activeView: view }),
  setSetupModalOpen: (open) => set({ isSetupModalOpen: open }),
  hydrateDiscordConfig: () => {
    let muted = false;
    if (typeof window !== "undefined") {
      try {
        muted = localStorage.getItem("hyperion_audio_muted") === "true";
      } catch {}
    }
    set({ discordConfig: getInitialDiscordConfig(), audioAlertsMuted: muted });
  },
  setExecutionArmState: (mode) => set({ executionArmState: mode }),
  setAudioAlertsMuted: (muted) => {
    if (typeof window !== "undefined") {
      try {
        localStorage.setItem("hyperion_audio_muted", muted ? "true" : "false");
      } catch {}
    }
    set({ audioAlertsMuted: muted });
  },
  toggleExecutionLock: async (flattenPaper = false) => {
    const current = get().executionArmState;
    const locking = flattenPaper ? true : current !== "LOCKED";
    const action = flattenPaper
      ? "FLATTEN_PAPER_POSITIONS"
      : locking
        ? "EMERGENCY_LOCK"
        : "UNLOCK_EXECUTION";
    try {
      const res = await fetch("/api/signals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (res.ok) {
        const data = await res.json();
        const isLocked = Boolean(data?.executionLocked);
        const flattened = Array.isArray(data?.flattenedTickers) ? data.flattenedTickers : [];
        set({
          executionArmState: isLocked ? "LOCKED" : "PAPER",
          toastMessage: flattenPaper
            ? flattened.length > 0
              ? `LOCKED · Paper positions flattened: ${flattened.join(", ")}`
              : "LOCKED · No open paper positions to flatten"
            : isLocked
              ? "EXECUTION LOCKED · Stand-Aside safety engaged (Paper/Shadow)"
              : "PAPER / SHADOW MODE resumed",
        });
        void get().fetchServerTrades(get().activeTicker);
      }
    } catch {
      set({ toastMessage: "Failed to toggle execution lock" });
    }
  },
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
    const preset = getStaticTickerPreset(rawTicker);
    if (preset.ticker === get().activeTicker) {
      return;
    }
    optionsAbortCtrl?.abort();
    flowVwapAbortCtrl?.abort();
    serverTradesAbortCtrl?.abort();
    set((state) => {
      const isStandardFilter =
        state.gridFilters.expiration === "ALL" ||
        state.gridFilters.expiration === "0DTE" ||
        state.gridFilters.expiration === "THIS_WEEK" ||
        state.gridFilters.expiration === "OPEX";
      const safeExpFilter = isStandardFilter
        ? state.gridFilters.expiration
        : "ALL";

      return {
        activeTicker: preset.ticker,
        loadedTicker: preset.ticker,
        isLoadingChain: true,
        connectionStatus: "SYNCING",
        isStaleSnapshot: false,
        lastUpdated: "--:-- ET",
        bookTimestamp: null,
        spotPrice: 0,
        liveTickPrice: null,
        liveTickTimestamp: 0,
        liveTickDirection: "flat",
        previousClose: 0,
        impliedVolatility: 0,
        strikeStep: preset.strikeStep,
        extendedQuote: null,
        expectedMoves: null,
        netMetrics: { ...EMPTY_NET_METRICS },
        allExpNetMetrics: { ...EMPTY_NET_METRICS },
        gammaLevels: { ...EMPTY_GAMMA_LEVELS },
        allExpGammaLevels: { ...EMPTY_GAMMA_LEVELS },
        gammaLevelsByFilter: null,
        kingNode: { ...EMPTY_KING_NODE },
        allExpKingNode: { ...EMPTY_KING_NODE },
        kingByFilter: null,
        chainExpirations: [],
        chainStrikes: [],
        gridFilters: {
          ...state.gridFilters,
          expiration: safeExpFilter,
        },
        alerts: [],
        serverActivePositions: {},
        serverClosedTrades: [],
        serverTradeAlerts: [],
        serverTradesLoaded: false,
        supervisorPolicy: null,
        intradayData: [],
        flowGammaVwapData: null,
      };
    });
  },

  setLiveTick: (ticker, price, timestamp = Date.now(), marketOpen) =>
    set((state) => {
      if (ticker.toUpperCase() !== state.activeTicker.toUpperCase()) return state;
      if (!Number.isFinite(price) || price <= 0) return state;
      const nextMktOpen = typeof marketOpen === "boolean" ? marketOpen : state.liveTickMarketOpen;
      if (
        state.liveTickPrice !== null &&
        Math.abs(price - state.liveTickPrice) < 1e-6 &&
        state.liveTickMarketOpen === nextMktOpen
      ) {
        return { liveTickTimestamp: timestamp };
      }
      const prev = state.liveTickPrice ?? state.spotPrice;
      const direction: "up" | "down" | "flat" =
        price > prev + 0.001 ? "up" : price < prev - 0.001 ? "down" : state.liveTickDirection;
      return {
        spotPrice: price,
        liveTickPrice: price,
        liveTickTimestamp: timestamp,
        liveTickDirection: direction,
        liveTickCount: state.liveTickCount + 1,
        liveTickMarketOpen: nextMktOpen,
      };
    }),

  updateSpot: (newSpot) => {
    if (!Number.isFinite(newSpot) || newSpot <= 0) return;
    const roundedSpot = Number(newSpot.toFixed(2));

    set((state) => {
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
          id: `alert-${Date.now()}-${++localAlertSeq}`,
          timestamp: nowLabel,
          message,
          type,
        },
      ],
    }));
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

      if (state.chainStrikes.length === 0) {
        return { gridFilters: nextFilters };
      }

      const preset = getStaticTickerPreset(state.activeTicker);
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
      if (payload.ticker.toUpperCase() !== state.activeTicker.toUpperCase()) {
        return state;
      }

      const preset = getStaticTickerPreset(payload.ticker);
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
        hasZeroDte:
          payload.kingNode.hasZeroDte ??
          payload.expirations.some((c) => c.tag === "0DTE"),
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

      const fmtStrike = (s: number) =>
        s % 1 !== 0 ? Number(s.toFixed(2)).toString() : s.toFixed(0);

      if (!isInitialChainHydration) {
        if (
          filtered.kingNode.allExpKing !== state.allExpKingNode.allExpKing &&
          state.allExpKingNode.allExpKing > 0 &&
          filtered.kingNode.allExpKing > 0
        ) {
          nextAlerts.push({
            id: `${payload.ticker}-king-${Date.now() - 1}`,
            timestamp: formattedTime,
            type: "king",
            message: `${payload.ticker} King moved ${fmtStrike(state.allExpKingNode.allExpKing)} → ${fmtStrike(filtered.kingNode.allExpKing)}`,
          });
        }
        if (
          filtered.gammaLevels.callWall !== state.gammaLevels.callWall &&
          state.gammaLevels.callWall > 0 &&
          filtered.gammaLevels.callWall > 0
        ) {
          nextAlerts.push({
            id: `${payload.ticker}-cwall-${Date.now()}`,
            timestamp: formattedTime,
            type: "call",
            message: `${payload.ticker} Call wall moved ${fmtStrike(state.gammaLevels.callWall)} → ${fmtStrike(filtered.gammaLevels.callWall)}`,
          });
        }
        if (
          filtered.gammaLevels.putWall !== state.gammaLevels.putWall &&
          state.gammaLevels.putWall > 0 &&
          filtered.gammaLevels.putWall > 0
        ) {
          nextAlerts.push({
            id: `${payload.ticker}-pwall-${Date.now() + 1}`,
            timestamp: formattedTime,
            type: "put",
            message: `${payload.ticker} Put wall moved ${fmtStrike(state.gammaLevels.putWall)} → ${fmtStrike(filtered.gammaLevels.putWall)}`,
          });
        }
        if (
          state.spotPrice > 0 &&
          state.gammaLevels.zeroGamma > 0 &&
          filtered.gammaLevels.zeroGamma > 0 &&
          ((state.spotPrice < state.gammaLevels.zeroGamma &&
            payload.spotPrice >= filtered.gammaLevels.zeroGamma) ||
            (state.spotPrice >= state.gammaLevels.zeroGamma &&
              payload.spotPrice < filtered.gammaLevels.zeroGamma))
        ) {
          const dir =
            payload.spotPrice >= filtered.gammaLevels.zeroGamma
              ? "above"
              : "below";
          nextAlerts.push({
            id: `${payload.ticker}-zg-${Date.now() + 2}`,
            timestamp: formattedTime,
            type: "zero",
            message: `${payload.ticker} crossed ${dir} zero γ ($${filtered.gammaLevels.zeroGamma.toFixed(2)}) — spot $${payload.spotPrice.toFixed(2)}`,
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
            ? [
                {
                  time: payload.lastUpdated,
                  spot: payload.spotPrice,
                  callWall: payload.gammaLevels.callWall,
                  putWall: payload.gammaLevels.putWall,
                  zeroGamma: payload.gammaLevels.zeroGamma,
                },
              ]
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

      const hasFreshTick =
        state.liveTickPrice !== null &&
        state.liveTickPrice > 0 &&
        Date.now() - state.liveTickTimestamp < 3000 &&
        state.loadedTicker.toUpperCase() === payload.ticker.toUpperCase();

      return {
        dataSource: payload.dataSource,
        isLoadingChain: false,
        lastUpdated: payload.lastUpdated,
        bookTimestamp: payload.bookTimestamp ?? null,
        cboeSpotLagDollars:
          typeof payload.spotLagDollars === "number" ? payload.spotLagDollars : null,
        optionsCacheAgeSec:
          typeof payload.cacheAgeSec === "number" ? payload.cacheAgeSec : 0,
        spotPrice: hasFreshTick ? state.liveTickPrice! : payload.spotPrice,
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
    flowVwapAbortCtrl?.abort();
    const ctrl = new AbortController();
    flowVwapAbortCtrl = ctrl;
    const reqId = ++flowVwapReqSeq;
    try {
      const res = await fetch(
        `/api/flow-vwap?ticker=${encodeURIComponent(targetTicker)}`,
        { cache: "no-store", signal: ctrl.signal }
      );
      if (
        !res.ok ||
        ctrl.signal.aborted ||
        reqId !== flowVwapReqSeq ||
        get().activeTicker.toUpperCase() !== targetTicker
      ) {
        return;
      }
      const points = await res.json();
      if (
        ctrl.signal.aborted ||
        reqId !== flowVwapReqSeq ||
        get().activeTicker.toUpperCase() !== targetTicker
      ) {
        return;
      }
      if (Array.isArray(points) && points.length > 0) {
        const latest = points[points.length - 1];
        const flowVwap = Number(latest?.flowVwap);
        const u1 = Number(latest?.upper1s ?? latest?.upper1Sigma);
        const l1 = Number(latest?.lower1s ?? latest?.lower1Sigma);
        const u2 = Number(latest?.upper2s ?? latest?.upper2Sigma);
        const l2 = Number(latest?.lower2s ?? latest?.lower2Sigma);
        const rawSigma = Number(latest?.sigma ?? u1 - flowVwap);
        if (Number.isFinite(flowVwap) && Number.isFinite(rawSigma)) {
          const safeSigma = Math.max(0, rawSigma);
          set({
            flowGammaVwapData: {
              flowVwap: Number(flowVwap.toFixed(2)),
              upper1s: Number(
                (Number.isFinite(u1) ? u1 : flowVwap + safeSigma).toFixed(2)
              ),
              lower1s: Number(
                (Number.isFinite(l1) ? l1 : flowVwap - safeSigma).toFixed(2)
              ),
              upper2s: Number(
                (Number.isFinite(u2) ? u2 : flowVwap + 2 * safeSigma).toFixed(2)
              ),
              lower2s: Number(
                (Number.isFinite(l2) ? l2 : flowVwap - 2 * safeSigma).toFixed(2)
              ),
              sigma: Number(safeSigma.toFixed(3)),
            },
          });
        }
      }
    } catch {
      // Non-fatal background fetch
    }
  },

  fetchOptionsChain: async (ticker, force = false, showToastOnError = false) => {
    const targetTicker = (ticker ?? get().activeTicker).trim().toUpperCase();
    if (targetTicker !== get().activeTicker.toUpperCase()) return;
    optionsAbortCtrl?.abort();
    const ctrl = new AbortController();
    optionsAbortCtrl = ctrl;
    const reqId = ++optionsReqSeq;

    // Seamlessly update Flow VWAP during the 5-second polling cycle
    get().fetchFlowGammaVwap(targetTicker).catch(() => {});
    // Only flip blocking loading state on cold/empty chain or manual refresh (prevents 5s LIVE->CONNECTING flicker)
    if (force || get().chainStrikes.length === 0 || get().loadedTicker.toUpperCase() !== targetTicker) {
      set({ isLoadingChain: true });
    }
    try {
      const res = await fetch(
        `/api/options?ticker=${encodeURIComponent(targetTicker)}${force ? "&force=true" : ""}`,
        { cache: "no-store", signal: ctrl.signal }
      );
      if (
        ctrl.signal.aborted ||
        reqId !== optionsReqSeq ||
        get().activeTicker.toUpperCase() !== targetTicker
      ) {
        return;
      }
      if (!res.ok) {
        // If we already have live data for this ticker, retain the last verified valid snapshot!
        const state = get();
        if (state.activeTicker === targetTicker && state.chainStrikes.length > 0) {
          set({
            isLoadingChain: false,
            connectionStatus: "SYNCING",
            isStaleSnapshot: true,
            toastMessage: showToastOnError ? `Reconnecting to options feed for ${targetTicker}...` : null,
          });
          return;
        }

        // Live-only guarantee: never fall back to simulated mock data
        set({
          isLoadingChain: false,
          connectionStatus: "SYNCING",
          isStaleSnapshot: false,
          toastMessage: showToastOnError
            ? `Syncing live market data for ${targetTicker}...`
            : null,
        });
        return;
      }
      const payload: OptionsAnalyticsPayload = await res.json();
      if (
        ctrl.signal.aborted ||
        reqId !== optionsReqSeq ||
        get().activeTicker.toUpperCase() !== targetTicker
      ) {
        return;
      }
      get().hydrateFromMarketData(payload);

      const status: "LIVE" | "SYNCING" | "RECONNECTING" =
        payload.connectionStatus === "SYNCING" || payload.isStale ? "SYNCING" : "LIVE";

      set({
        isLoadingChain: false,
        connectionStatus: status,
        isStaleSnapshot: !!payload.isStale,
        toastMessage: null,
      });
    } catch {
      if (
        ctrl.signal.aborted ||
        reqId !== optionsReqSeq ||
        get().activeTicker.toUpperCase() !== targetTicker
      ) {
        return;
      }
      // Network fetch failure: if valid data exists, serve last verified valid snapshot with SYNCING indicator
      const state = get();
      if (state.activeTicker === targetTicker && state.chainStrikes.length > 0) {
        set({
          isLoadingChain: false,
          connectionStatus: "SYNCING",
          isStaleSnapshot: true,
          toastMessage: showToastOnError
            ? `Reconnecting to options feed for ${targetTicker}...`
            : null,
        });
      } else {
        set({
          isLoadingChain: false,
          connectionStatus: "SYNCING",
          isStaleSnapshot: false,
          toastMessage: showToastOnError
            ? `Syncing live market data for ${targetTicker}...`
            : null,
        });
      }
    }
  },
}));
