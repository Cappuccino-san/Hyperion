import fs from "fs";
import path from "path";
import type { NormalizedOptionContract } from "@/lib/optionsExposure";
import { DEFAULT_HARD_OPTION_STOP_LOSS_PCT } from "@/lib/bracketOrderEngine";
import {
  etMinutesOfDay,
  getSessionBoundsEt,
  getTodayEt,
  toEpochSec,
} from "@/lib/gaiaSessionGuards";

export type ZeroShadowModeId = "SHADOW_FOLLOW" | "SHADOW_FADE" | "SHADOW_1DTE";
export type ZeroShadowGrade = "OPEN" | "RIGHT" | "WRONG" | "SCRATCH";

export interface ZeroShadowEntry {
  id: string;
  sessionDate: string;
  ticker: string;
  mode: ZeroShadowModeId;
  modeBadge: string;
  direction: "LONG" | "SHORT";
  contractType: "CALL" | "PUT";
  contractSymbol: string;
  contractLabel: string;
  strike: number;
  expiration: string;
  dteDays: number;
  openedTs: number;
  openedTimeEt: string;
  entrySpot: number;
  entryAsk: number;
  currentBid: number;
  peakOptionPnlPct: number;
  closedTs?: number;
  closedTimeEt?: string;
  exitSpot?: number;
  exitBid?: number;
  exitReason?: string;
  pnlOptionPct: number;
  rMultiple: number;
  entryLagMins: number;
  status: ZeroShadowGrade;
}

export interface ZeroShadowModeScore {
  mode: ZeroShadowModeId;
  label: string;
  totalClosed: number;
  rightCount: number;
  wrongCount: number;
  scratchCount: number;
  winRatePct: number;
  avgR: number;
}

export interface ZeroShadowLedgerState {
  version: number;
  updatedAt: string;
  entries: ZeroShadowEntry[];
}

export interface ZeroShadowReadout {
  sessionDate: string;
  ticker: string;
  entriesToday: ZeroShadowEntry[];
  modeScores: ZeroShadowModeScore[];
  overallWinRatePct: number;
  overallRightCount: number;
  overallDecisiveCount: number;
  overallAvgR: number;
}

const SHADOW_LEDGER_VERSION = 1;
const MAX_RETENTION_ENTRIES = 240;

function resolveShadowLedgerPath(): string {
  const dir = process.env.HYPERION_CACHE_DIR
    ? path.resolve(process.env.HYPERION_CACHE_DIR)
    : path.join(process.cwd(), ".cache");
  return path.join(dir, "zero-shadow-ledger.json");
}

function formatEtShort(tsSec: number): string {
  try {
    return new Date(tsSec * 1000).toLocaleTimeString("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "--:--";
  }
}

function computeTradingDteDays(sessionDate: string, expiration: string): number {
  if (!sessionDate || !expiration || expiration <= sessionDate) return 0;
  const [y1, m1, d1] = sessionDate.split("-").map(Number);
  const [y2, m2, d2] = expiration.split("-").map(Number);
  const cur = new Date(Date.UTC(y1, (m1 || 1) - 1, d1 || 1));
  const end = new Date(Date.UTC(y2, (m2 || 1) - 1, d2 || 1));
  let days = 0;
  while (cur < end && days < 30) {
    cur.setUTCDate(cur.getUTCDate() + 1);
    const wd = cur.getUTCDay();
    if (wd !== 0 && wd !== 6) days++;
  }
  return days;
}

export function readZeroShadowLedgerSync(): ZeroShadowLedgerState {
  const filePath = resolveShadowLedgerPath();
  try {
    if (!fs.existsSync(filePath)) {
      return { version: SHADOW_LEDGER_VERSION, updatedAt: new Date(0).toISOString(), entries: [] };
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (!parsed || parsed.version !== SHADOW_LEDGER_VERSION || !Array.isArray(parsed.entries)) {
      return { version: SHADOW_LEDGER_VERSION, updatedAt: new Date(0).toISOString(), entries: [] };
    }
    return parsed as ZeroShadowLedgerState;
  } catch {
    return { version: SHADOW_LEDGER_VERSION, updatedAt: new Date(0).toISOString(), entries: [] };
  }
}

export function writeZeroShadowLedgerSync(state: ZeroShadowLedgerState): void {
  const filePath = resolveShadowLedgerPath();
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const trimmed: ZeroShadowLedgerState = {
      version: SHADOW_LEDGER_VERSION,
      updatedAt: new Date().toISOString(),
      entries: state.entries.slice(-MAX_RETENTION_ENTRIES),
    };
    const tmp = `${filePath}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(trimmed), "utf-8");
    fs.renameSync(tmp, filePath);
  } catch {
    // Non-fatal: shadow grading must never interrupt live execution
  }
}

function selectRealQuoteShadowContract(params: {
  ticker: string;
  sessionDate: string;
  contractType: "CALL" | "PUT";
  spotPrice: number;
  contracts: NormalizedOptionContract[];
  require1Dte: boolean;
}): {
  contract: NormalizedOptionContract;
  dteDays: number;
  ask: number;
  bid: number;
} | null {
  const wantType = params.contractType === "CALL" ? "C" : "P";
  const maxOtmDist = Math.max(4.0, params.spotPrice * 0.008);
  const candidates = params.contracts
    .filter((c) => {
      if (c.optionType !== wantType) return false;
      if (!c.expiration || c.expiration < params.sessionDate) return false;
      if (wantType === "C" && c.strike < params.spotPrice * 0.998) return false;
      if (wantType === "P" && c.strike > params.spotPrice * 1.002) return false;
      const otmDist = Math.abs(c.strike - params.spotPrice);
      if (otmDist > maxOtmDist) return false;
      const ask = Number(c.ask ?? 0);
      const bid = Number(c.bid ?? 0);
      if (!Number.isFinite(ask) || ask < 0.15 || ask > 0.99) return false;
      if (!Number.isFinite(bid) || bid < 0.05 || bid > ask) return false;
      const mid = (ask + bid) / 2;
      if (mid <= 0 || (ask - bid) / mid > 0.28) return false;
      const dte = computeTradingDteDays(params.sessionDate, c.expiration);
      if (params.require1Dte) {
        return dte >= 1 && dte <= 3;
      }
      return dte === 0 || dte === 1;
    })
    .map((c) => {
      const ask = Number((c.ask ?? 0).toFixed(2));
      const bid = Number((c.bid ?? 0).toFixed(2));
      const dteDays = computeTradingDteDays(params.sessionDate, c.expiration);
      const otmDist =
        wantType === "C"
          ? Math.max(0, c.strike - params.spotPrice)
          : Math.max(0, params.spotPrice - c.strike);
      // Prefer near-ATM liquid options with tighter spread and higher |delta|
      const spreadPct = (ask - bid) / Math.max(0.05, (ask + bid) / 2);
      const dteBonus = !params.require1Dte && dteDays === 0 ? 0.25 : 0;
      const score = Math.abs(c.delta || 0.25) * 2.0 - spreadPct * 1.4 - (otmDist / Math.max(1, params.spotPrice)) * 35 + dteBonus;
      return { contract: c, dteDays, ask, bid, score };
    })
    .sort((a, b) => b.score - a.score);

  if (candidates.length === 0) return null;
  const best = candidates[0];
  return {
    contract: best.contract,
    dteDays: best.dteDays,
    ask: best.ask,
    bid: best.bid,
  };
}

function gradeClosedShadowPnl(pnlPct: number): ZeroShadowGrade {
  if (pnlPct >= 5.0) return "RIGHT";
  if (pnlPct <= -5.0) return "WRONG";
  return "SCRATCH";
}

export interface EvaluateZeroShadowTickInput {
  ticker: string;
  sessionDate?: string;
  nowTsSec?: number;
  spotPrice: number;
  openPrice?: number;
  flowVwap?: number;
  sigma?: number;
  compositeScore: number;
  entryLagMins?: number;
  contracts: NormalizedOptionContract[];
}

/**
 * Updates causal paper-only shadow positions (`SHADOW_FOLLOW`, `SHADOW_FADE`, `SHADOW_1DTE`)
 * strictly using real option Ask on entry and real option Bid on exit.
 * 100% isolated from `activePositions`, `closedPositions`, single-slot portfolio lock, and Discord.
 */
export function evaluateZeroShadowTick(input: EvaluateZeroShadowTickInput): ZeroShadowLedgerState {
  const sym = input.ticker.trim().toUpperCase();
  const nowSec = toEpochSec(input.nowTsSec ?? Math.floor(Date.now() / 1000));
  const sessionDate = input.sessionDate || getTodayEt(new Date(nowSec * 1000));
  const etMins = etMinutesOfDay(nowSec);
  const bounds = getSessionBoundsEt(sessionDate);

  const state = readZeroShadowLedgerSync();
  let mutated = false;

  // 1. Mark-to-market & exit open shadow entries for this ticker using REAL BID quotes
  for (const entry of state.entries) {
    if (entry.ticker !== sym || entry.status !== "OPEN") continue;
    const match = input.contracts.find(
      (c) =>
        (entry.contractSymbol && c.symbol === entry.contractSymbol) ||
        (c.expiration === entry.expiration &&
          c.strike === entry.strike &&
          c.optionType === (entry.contractType === "CALL" ? "C" : "P"))
    );

    const liveBid =
      match && typeof match.bid === "number" && Number.isFinite(match.bid) && match.bid > 0
        ? Number(match.bid.toFixed(2))
        : entry.sessionDate < sessionDate || etMins >= bounds.eodFlatMins
          ? entry.currentBid
          : null;

    if (liveBid !== null) {
      entry.currentBid = liveBid;
      const curPct = Number((((liveBid - entry.entryAsk) / entry.entryAsk) * 100).toFixed(1));
      entry.pnlOptionPct = curPct;
      entry.rMultiple = Number((curPct / DEFAULT_HARD_OPTION_STOP_LOSS_PCT).toFixed(2));
      if (curPct > entry.peakOptionPnlPct) {
        entry.peakOptionPnlPct = curPct;
      }
      mutated = true;

      let exitReason: string | null = null;
      if (entry.sessionDate < sessionDate || etMins >= bounds.eodFlatMins) {
        exitReason = "SHADOW MOC FLAT";
      } else if (curPct <= -DEFAULT_HARD_OPTION_STOP_LOSS_PCT) {
        exitReason = "SHADOW HARD STOP (-45%)";
      } else if (curPct >= 55) {
        exitReason = "SHADOW TARGET LOCK (+55%)";
      } else if (entry.peakOptionPnlPct >= 32 && curPct <= 12) {
        exitReason = "SHADOW RATCHET (+32% -> +12%)";
      }

      if (exitReason) {
        entry.closedTs = nowSec;
        entry.closedTimeEt = formatEtShort(nowSec);
        entry.exitSpot = Number(input.spotPrice.toFixed(2));
        entry.exitBid = liveBid;
        entry.exitReason = exitReason;
        entry.status = gradeClosedShadowPnl(curPct);
      }
    }
  }

  // 2. Evaluate causal new shadow entries strictly inside [entryStartMins, entryCutoffMins]
  if (
    etMins >= bounds.entryStartMins &&
    etMins <= bounds.entryCutoffMins &&
    input.spotPrice > 0 &&
    input.contracts.length > 0
  ) {
    const fVwap =
      typeof input.flowVwap === "number" && input.flowVwap > 0 ? input.flowVwap : input.spotPrice;
    const sig =
      typeof input.sigma === "number" && input.sigma > 0
        ? input.sigma
        : Math.max(0.15, input.spotPrice * 0.0018);
    const zScore = (input.spotPrice - fVwap) / sig;
    const barOpen =
      typeof input.openPrice === "number" && input.openPrice > 0 ? input.openPrice : input.spotPrice;

    const followDir: "LONG" | "SHORT" | null =
      input.compositeScore >= 36 && zScore >= 0.25
        ? "LONG"
        : input.compositeScore <= -36 && zScore <= -0.25
          ? "SHORT"
          : null;

    const fadeDir: "LONG" | "SHORT" | null =
      zScore <= -1.2 && input.spotPrice > barOpen
        ? "LONG"
        : zScore >= 1.2 && input.spotPrice < barOpen
          ? "SHORT"
          : null;

    const modeCandidates: Array<{
      mode: ZeroShadowModeId;
      badge: string;
      dir: "LONG" | "SHORT" | null;
      require1Dte: boolean;
    }> = [
      { mode: "SHADOW_FOLLOW", badge: "SHADOW · FOLLOW", dir: followDir, require1Dte: false },
      { mode: "SHADOW_FADE", badge: "SHADOW · FADE", dir: fadeDir, require1Dte: false },
      {
        mode: "SHADOW_1DTE",
        badge: "SHADOW · 1DTE",
        dir: followDir ?? fadeDir,
        require1Dte: true,
      },
    ];

    for (const cand of modeCandidates) {
      if (!cand.dir) continue;
      const existingModeToday = state.entries.filter(
        (e) => e.sessionDate === sessionDate && e.ticker === sym && e.mode === cand.mode
      );
      if (existingModeToday.some((e) => e.status === "OPEN")) continue;
      if (existingModeToday.length >= 2) continue;
      const lastClosed = existingModeToday[existingModeToday.length - 1];
      if (lastClosed?.closedTs && nowSec - lastClosed.closedTs < 1200) continue;

      const cType: "CALL" | "PUT" = cand.dir === "LONG" ? "CALL" : "PUT";
      const picked = selectRealQuoteShadowContract({
        ticker: sym,
        sessionDate,
        contractType: cType,
        spotPrice: input.spotPrice,
        contracts: input.contracts,
        require1Dte: cand.require1Dte,
      });
      if (!picked) continue;

      const initPct = Number((((picked.bid - picked.ask) / picked.ask) * 100).toFixed(1));
      state.entries.push({
        id: `zshadow-${sym}-${cand.mode}-${nowSec}`,
        sessionDate,
        ticker: sym,
        mode: cand.mode,
        modeBadge: cand.badge,
        direction: cand.dir,
        contractType: cType,
        contractSymbol: picked.contract.symbol,
        contractLabel: `${sym} ${picked.contract.strike}${cType === "CALL" ? "C" : "P"} (${picked.dteDays}DTE)`,
        strike: picked.contract.strike,
        expiration: picked.contract.expiration,
        dteDays: picked.dteDays,
        openedTs: nowSec,
        openedTimeEt: formatEtShort(nowSec),
        entrySpot: Number(input.spotPrice.toFixed(2)),
        entryAsk: picked.ask,
        currentBid: picked.bid,
        peakOptionPnlPct: initPct,
        pnlOptionPct: initPct,
        rMultiple: Number((initPct / DEFAULT_HARD_OPTION_STOP_LOSS_PCT).toFixed(2)),
        entryLagMins: Math.max(0, Math.round(input.entryLagMins ?? 0)),
        status: "OPEN",
      });
      mutated = true;
    }
  }

  if (mutated) {
    writeZeroShadowLedgerSync(state);
  }
  return state;
}

export function readZeroShadowSummary(ticker: string, sessionDate?: string): ZeroShadowReadout {
  const sym = (ticker || "SPY").trim().toUpperCase();
  const targetDate = sessionDate || getTodayEt();
  const state = readZeroShadowLedgerSync();
  const tickerEntries = state.entries.filter((e) => e.ticker === sym);
  const entriesToday = tickerEntries.filter((e) => e.sessionDate === targetDate);

  const modes: Array<{ mode: ZeroShadowModeId; label: string }> = [
    { mode: "SHADOW_FOLLOW", label: "FOLLOW" },
    { mode: "SHADOW_FADE", label: "FADE" },
    { mode: "SHADOW_1DTE", label: "1DTE" },
  ];

  const modeScores: ZeroShadowModeScore[] = modes.map(({ mode, label }) => {
    const closed = tickerEntries.filter((e) => e.mode === mode && e.status !== "OPEN");
    const rightCount = closed.filter((e) => e.status === "RIGHT").length;
    const wrongCount = closed.filter((e) => e.status === "WRONG").length;
    const scratchCount = closed.filter((e) => e.status === "SCRATCH").length;
    const decisive = rightCount + wrongCount;
    const winRatePct = decisive > 0 ? Math.round((rightCount / decisive) * 100) : 0;
    const avgR =
      closed.length > 0
        ? Number((closed.reduce((s, e) => s + e.rMultiple, 0) / closed.length).toFixed(2))
        : 0;
    return {
      mode,
      label,
      totalClosed: closed.length,
      rightCount,
      wrongCount,
      scratchCount,
      winRatePct,
      avgR,
    };
  });

  const allClosed = tickerEntries.filter((e) => e.status !== "OPEN");
  const overallRightCount = allClosed.filter((e) => e.status === "RIGHT").length;
  const overallWrongCount = allClosed.filter((e) => e.status === "WRONG").length;
  const overallDecisiveCount = overallRightCount + overallWrongCount;
  const overallWinRatePct =
    overallDecisiveCount > 0 ? Math.round((overallRightCount / overallDecisiveCount) * 100) : 100;
  const overallAvgR =
    allClosed.length > 0
      ? Number((allClosed.reduce((s, e) => s + e.rMultiple, 0) / allClosed.length).toFixed(2))
      : 0;

  return {
    sessionDate: targetDate,
    ticker: sym,
    entriesToday,
    modeScores,
    overallWinRatePct,
    overallRightCount,
    overallDecisiveCount,
    overallAvgR,
  };
}
