import type { NormalizedOptionContract } from "@/lib/optionsExposure";
import type { MarketRegimeId } from "@/lib/persistenceStore";
import { getSessionBoundsEt, getTodayEt } from "@/lib/gaiaSessionGuards";
import {
  selectOptimalSmallAccountContract,
  type ContractCandidateInput,
} from "@/lib/alphaScorer";
import { DEFAULT_HARD_OPTION_STOP_LOSS_PCT } from "@/lib/bracketOrderEngine";
import { MAX_OPTION_DELTA, resolveMinOptionDelta } from "@/lib/positionSizer";
import type { ContractType, SelectedOptionContract } from "@/lib/execution/types";
import {
  computeRemainingYearsToExpiration,
  fetchLiveCboeOptions,
  formatEtIsoDate,
  getContractMidPrice,
  getNowEtTime,
  reanchorDelayedContractsToSpot,
  repriceOptionBS,
  solveImpliedVol,
} from "@/lib/execution/optionPricing";

/**
 * Formats an ISO expiration date (YYYY-MM-DD) into clear human strings and Robinhood tab names
 */
export function formatExpirationHuman(
  expIso: string,
  todayIso: string
): { expHuman: string; robinhoodExp: string; robinhoodTab: string; dte: number } {
  try {
    const [ey, em, ed] = expIso.split("-").map(Number);
    const [ty, tm, td] = todayIso.split("-").map(Number);
    const expDate = new Date(Date.UTC(ey, em - 1, ed, 16, 0, 0));
    const todayDate = new Date(Date.UTC(ty, tm - 1, td, 16, 0, 0));
    const diffDays = Math.round(
      (expDate.getTime() - todayDate.getTime()) / (1000 * 60 * 60 * 24)
    );
    const dte = diffDays;

    const fullMonths = [
      "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December",
    ];
    const monthNames = [
      "Jan", "Feb", "Mar", "Apr", "May", "Jun",
      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const expDayName = dayNames[expDate.getUTCDay()];
    const expMonth = monthNames[em - 1];
    const fullMonth = fullMonths[em - 1];

    const robinhoodTab = `${fullMonth} ${ed} (${dte}d)`;
    const robinhoodExp = `${expMonth} ${ed}, ${ey}`;

    let expHuman: string;
    if (dte === 0) {
      expHuman = `Today, ${expMonth} ${ed} (0 DTE · Same-Day)`;
    } else if (dte === 1) {
      expHuman = `Tomorrow, ${expDayName} ${expMonth} ${ed} (1 DTE)`;
    } else {
      expHuman = `${expDayName}, ${expMonth} ${ed} (${dte} DTE)`;
    }

    return { expHuman, robinhoodExp, robinhoodTab, dte };
  } catch {
    return { expHuman: expIso, robinhoodExp: expIso, robinhoodTab: expIso, dte: 1 };
  }
}

/**
 * Strict Sub-$1.00 Contract Selector & 1-Contract Position Sizer
 * - Fetches or uses real live/re-anchored option chains (never manufactures fake dates/prices)
 * - Price Cap: strictly $0.15 <= ask <= $0.99 (1 contract max, <= $100 outlay)
 * - Delta & Payoff Routing: conditions |delta| floor on microstructural regime / |Pe|
 *   and ranks candidates by Second-Order Taylor NetEV(K,T) with 0.22 spread-to-edge veto
 * - SPXW routing: maps to liquid SPY contract matching underlying SPX move
 */
export async function selectSmallAccountContract(params: {
  ticker: string;
  contractType: ContractType;
  spotPrice: number;
  target1Spot: number;
  target2Spot: number;
  stopLossSpot: number;
  contracts?: NormalizedOptionContract[] | null;
  conviction?: number;
  nowEt?: Date;
  zeroDteCallWall?: number;
  zeroDtePutWall?: number;
  preferredDte?: "0DTE" | "1-2DTE" | "NONE";
  regime?: MarketRegimeId;
  absImpulsePeclet?: number;
  remainingExpectedMove?: number;
  dataSource?: string;
  referenceSpotPrice?: number;
  contractsAlreadyAnchored?: boolean;
  signal?: AbortSignal;
}): Promise<SelectedOptionContract | null> {
  const {
    ticker,
    contractType,
    spotPrice,
    target1Spot,
    target2Spot,
    stopLossSpot,
    nowEt,
    zeroDteCallWall,
    zeroDtePutWall,
    preferredDte,
    regime,
    absImpulsePeclet,
    remainingExpectedMove,
    dataSource,
    referenceSpotPrice,
    contractsAlreadyAnchored,
    signal,
  } = params;

  if (signal?.aborted) return null;
  let contracts = params.contracts;
  const sym = ticker.trim().toUpperCase();
  const isSpxw = sym === "SPXW" || sym === "SPX";
  const todayEt = nowEt ? formatEtIsoDate(nowEt) : getTodayEt();
  const etTime = getNowEtTime(nowEt);
  const sessionBounds = getSessionBoundsEt(todayEt);
  const typeLetter = contractType === "CALL" ? "C" : "P";
  const isCall = contractType === "CALL";

  let altContractNote: string | undefined = undefined;

  let effectiveSym = sym;
  let effectiveSpot = spotPrice;
  let effectiveTarget1 = target1Spot;
  let effectiveTarget2 = target2Spot;
  let effectiveStopLoss = stopLossSpot;

  if (isSpxw) {
    effectiveSym = "SPY";
    effectiveSpot = Number((spotPrice / 10).toFixed(2));
    effectiveTarget1 = Number((target1Spot / 10).toFixed(2));
    effectiveTarget2 = Number((target2Spot / 10).toFixed(2));
    effectiveStopLoss = Number((stopLossSpot / 10).toFixed(2));
    altContractNote = `SPXW Index > $1.00/contract · Using SPY Equivalent for Sub-$1.00 Small Account`;
  }

  const hasSpxScaleChain =
    isSpxw &&
    Array.isArray(contracts) &&
    contracts.length > 0 &&
    contracts.some((c) => c.strike > effectiveSpot * 3);
  if (!contracts || contracts.length === 0 || hasSpxScaleChain) {
    contracts = await fetchLiveCboeOptions(effectiveSym, signal);
    if (signal?.aborted) return null;
  } else if (
    dataSource !== "TRADIER_LIVE" &&
    dataSource !== "tradier" &&
    dataSource !== "BACKFILL" &&
    !contractsAlreadyAnchored &&
    typeof referenceSpotPrice === "number" &&
    referenceSpotPrice > 0
  ) {
    const normalizedRefSpot = isSpxw && referenceSpotPrice > effectiveSpot * 3
      ? Number((referenceSpotPrice / 10).toFixed(2))
      : referenceSpotPrice;
    if (Math.abs(normalizedRefSpot - effectiveSpot) > 0.01) {
      contracts = reanchorDelayedContractsToSpot({
        contracts,
        referenceSpot: normalizedRefSpot,
        liveSpot: effectiveSpot,
        nowMs: (nowEt ?? new Date()).getTime(),
      });
    }
  }

  if (contracts && contracts.length > 0) {
    const validCandidates: ContractCandidateInput[] = [];
    const isAfternoon = etTime.hours > 11 || (etTime.hours === 11 && etTime.minutes >= 30);
    const hasFutureExpirations = contracts.some(
      (item) => typeof item.expiration === "string" && /^\d{4}-\d{2}-\d{2}$/.test(item.expiration) && item.expiration > todayEt
    );

    const minOptionDelta = resolveMinOptionDelta({
      regime,
      absImpulsePeclet,
      etMins: etTime.totalMinutes,
    });

    for (const c of contracts) {
      if (c.optionType !== typeLetter) continue;
      if (typeof c.expiration !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(c.expiration)) continue;
      const mid = getContractMidPrice(c);

      const rawBid = typeof c.bid === "number" && Number.isFinite(c.bid) ? c.bid : undefined;
      const rawAsk = typeof c.ask === "number" && Number.isFinite(c.ask) ? c.ask : undefined;
      const askPrice = rawAsk !== undefined ? rawAsk : mid;
      if (askPrice < 0.15 || askPrice > 0.99) continue;

      const absDelta = typeof c.delta === "number" && Number.isFinite(c.delta) ? Math.abs(c.delta) : 0;
      if (absDelta < minOptionDelta || absDelta > MAX_OPTION_DELTA) continue;

      const effectiveBid = rawBid ?? (askPrice > 0 ? 0 : -1);
      if (effectiveBid < 0 || askPrice <= 0 || effectiveBid > askPrice) continue;
      const spreadPct = (askPrice - effectiveBid) / askPrice;
      if (spreadPct > 0.24) continue;

      if (isCall && c.strike < effectiveSpot * 0.998) continue;
      if (!isCall && c.strike > effectiveSpot * 1.002) continue;

      const maxOtmDistance = Math.min(3.50, effectiveSpot * 0.0045);
      if (Math.abs(c.strike - effectiveSpot) > maxOtmDistance) continue;

      const { expHuman, robinhoodExp, robinhoodTab, dte } = formatExpirationHuman(c.expiration, todayEt);
      const minAskFloor = dte === 0 ? 0.45 : 0.15;
      if (askPrice < minAskFloor) {
        continue;
      }
      if (
        !Number.isFinite(dte) ||
        dte < 0 ||
        c.expiration < todayEt ||
        ((Boolean(nowEt) || hasFutureExpirations) && etTime.totalMinutes >= sessionBounds.rthCloseMins && dte <= 0)
      ) {
        continue;
      }

      const normZeroDteCw = typeof zeroDteCallWall === "number" && zeroDteCallWall > 0
        ? (isSpxw ? zeroDteCallWall / 10 : zeroDteCallWall) : 0;
      const normZeroDtePw = typeof zeroDtePutWall === "number" && zeroDtePutWall > 0
        ? (isSpxw ? zeroDtePutWall / 10 : zeroDtePutWall) : 0;
      const overheadCeiling = normZeroDteCw > effectiveSpot ? normZeroDteCw : 0;
      if (contractType === "CALL" && overheadCeiling > 0 && c.strike > overheadCeiling) {
        continue;
      }
      const floorSupport = normZeroDtePw > 0 && normZeroDtePw < effectiveSpot ? normZeroDtePw : 0;
      const putFloorBuffer = Math.max(0.5, effectiveSpot * 0.0027);
      if (contractType === "PUT" && floorSupport > 0 && c.strike < floorSupport - putFloorBuffer) {
        continue;
      }

      validCandidates.push({
        contract: c,
        mid,
        bid: effectiveBid,
        ask: askPrice,
        dte,
        expHuman,
        robinhoodExp,
        robinhoodTab,
        absDelta,
        theta: typeof c.theta === "number" ? c.theta : undefined,
      });
    }

    const selection = selectOptimalSmallAccountContract({
      candidates: validCandidates,
      spotPrice: effectiveSpot,
      target1Spot: effectiveTarget1,
      target2Spot: effectiveTarget2,
      isCall,
      isSpxw,
      zeroDteCallWall,
      zeroDtePutWall,
      isAfternoon,
      preferredDte,
      regime,
      absImpulsePeclet,
      remainingExpectedMove:
        typeof remainingExpectedMove === "number" && remainingExpectedMove > 0
          ? (isSpxw ? remainingExpectedMove / 10 : remainingExpectedMove)
          : undefined,
      etMins: etTime.totalMinutes,
      nowMs: (nowEt ?? new Date()).getTime(),
    });
    const chosen = selection?.chosen;

    if (chosen) {
      const c = chosen.contract;
      const mid = chosen.mid;
      const bid = chosen.bid;
      const ask = chosen.ask;
      const dte = chosen.dte;
      const delta = chosen.absDelta || 0.30;
      const expHuman = chosen.expHuman;
      const robinhoodExp = chosen.robinhoodExp;
      const robinhoodTab = chosen.robinhoodTab;

      const entryAsk = ask > 0 ? ask : mid;
      if (entryAsk > 1.00 || entryAsk < 0.15) {
        return null;
      }

      const contractsQty: 1 = 1;
      const singleContractCents = Math.round(entryAsk * 10000);
      if (singleContractCents > 10000) {
        return null;
      }
      const totalOutlay = singleContractCents / 100;

      const tYears = computeRemainingYearsToExpiration((nowEt ?? new Date()).getTime(), Math.max(0, dte));
      const rawChainIv =
        typeof c.iv === "number" && Number.isFinite(c.iv) && c.iv > 0
          ? c.iv > 4
            ? c.iv / 100
            : c.iv
          : 0;
      const hasLiveChainIv = rawChainIv >= 0.04 && rawChainIv <= 2.50;
      const impliedAskIv = solveImpliedVol(entryAsk, effectiveSpot, c.strike, tYears, isCall);
      const solvedIv = hasLiveChainIv ? Number(rawChainIv.toFixed(4)) : impliedAskIv;
      const bsEntryCheck = hasLiveChainIv
        ? repriceOptionBS(effectiveSpot, c.strike, tYears, solvedIv, isCall)
        : entryAsk;
      const repriceIv =
        hasLiveChainIv && Math.abs(bsEntryCheck - entryAsk) > entryAsk * 0.25 ? impliedAskIv : solvedIv;

      const bsTp1Mid = repriceOptionBS(effectiveTarget1, c.strike, tYears * 0.96, repriceIv, isCall);
      const bsTp2Mid = repriceOptionBS(effectiveTarget2, c.strike, tYears * 0.92, repriceIv, isCall);
      const bsStopMid = repriceOptionBS(effectiveStopLoss, c.strike, tYears * 0.96, repriceIv, isCall);

      const estTp1Mid = Number(Math.max(entryAsk + 0.05, bsTp1Mid).toFixed(2));
      const estTp2Mid = Number(Math.max(estTp1Mid + 0.05, bsTp2Mid).toFixed(2));
      const hardStopMult = 1 - DEFAULT_HARD_OPTION_STOP_LOSS_PCT / 100;
      const estStopMid = Number(Math.max(entryAsk * hardStopMult, Math.min(entryAsk - 0.01, bsStopMid)).toFixed(2));

      const tp1Pct = Number((((estTp1Mid - entryAsk) / entryAsk) * 100).toFixed(0));
      const tp2Pct = Number((((estTp2Mid - entryAsk) / entryAsk) * 100).toFixed(0));

      const expClean = c.expiration.replace(/-/g, "").slice(2);
      const strikeLabel = Number.isInteger(c.strike) ? c.strike.toString() : c.strike.toFixed(1);
      const displaySym = isSpxw && c.strike > 1000 ? "SPXW" : effectiveSym;
      const contractLabel = `${displaySym} ${expClean} ${strikeLabel}${typeLetter} (${expHuman} · $${entryAsk.toFixed(2)})`;

      return {
        symbol: c.symbol || `${effectiveSym}${expClean}${typeLetter}${strikeLabel}`,
        strike: c.strike,
        expiration: c.expiration,
        expHuman,
        robinhoodExp,
        robinhoodTab,
        dte,
        contractType,
        contractLabel,
        optionBid: bid,
        optionAsk: ask,
        optionMid: mid,
        delta,
        contractsQty,
        totalOutlay,
        estTp1Mid,
        estTp2Mid,
        estStopMid,
        tp1Pct,
        tp2Pct,
        altContractNote,
        entryIv: solvedIv,
        entryTYears: tYears,
      };
    }
  }

  return null;
}

export const selectOptimalContract = selectSmallAccountContract;
