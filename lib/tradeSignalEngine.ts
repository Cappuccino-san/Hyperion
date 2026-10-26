import fs from "fs";
import path from "path";
import { NormalizedOptionContract } from "@/lib/optionsExposure";
import {
  calculateSmallAccountSize,
  assertSmallAccountInvariant,
} from "@/lib/positionSizer";

export type ContractType = "CALL" | "PUT";
export type PositionStatus = "OPEN" | "PARTIAL_TP1" | "CLOSED";
export type SignalAction = "BUY_TO_OPEN" | "SELL_TO_CLOSE";
export type DivergenceDirection = "BULL" | "BEAR" | "NO";

export const DEFAULT_DISCORD_WEBHOOK_URL =
  "https://discord.com/api/webhooks/1562857850676449411/Qza12VWuPoBlek12-6o7V6fc2EscYDjIQrKw7KJyfB8Y3i9VAMvU7OJH0m7joqUH5arx";

export interface OptionTradePosition {
  id: string;
  ticker: string;
  contractType: ContractType;
  contractLabel: string;
  strike: number;
  expiration: string; // YYYY-MM-DD
  expHuman?: string;
  robinhoodExp?: string;
  robinhoodTab?: string;
  setupName: string;
  status: PositionStatus;
  btoSpotPrice: number;
  btoOptionMid: number;
  optionBid?: number;
  optionAsk?: number;
  contractsQty: 1 | 2;
  remainingQty: 0 | 1 | 2;
  totalOutlay: number; // in dollars, e.g., mid * 100 * contractsQty
  estTp1Mid?: number;
  estTp2Mid?: number;
  estStopMid?: number;
  tp1Pct?: number;
  tp2Pct?: number;
  target1Spot: number;
  target2Spot: number;
  stopLossSpot: number;
  openedAt: string; // ET timestamp, e.g., "10:35 AM"
  openedTs: number; // Unix timestamp in seconds
  closedAt?: string;
  closedTs?: number;
  closedSpotPrice?: number;
  closedOptionMid?: number | null;
  exitReason?: string;
  pnlSpotPct?: number;
  pnlOptionPct?: number;
  rrRatio?: number;
  altContractNote?: string;
}

export interface TradeLifecycleAlert {
  id: string;
  timestamp: string; // ET time string, e.g. "10:35 AM"
  ts: number;
  ticker: string;
  action: SignalAction;
  contractType: ContractType;
  contractLabel: string;
  strike: number;
  expiration: string;
  expHuman?: string;
  robinhoodExp?: string;
  robinhoodTab?: string;
  setupName: string;
  reason: string;
  status: PositionStatus;
  spotPrice: number;
  btoSpotPrice: number;
  target1Spot: number;
  target2Spot: number;
  stopLossSpot: number;
  optionMid: number | null;
  optionBid?: number;
  optionAsk?: number;
  btoOptionMid: number | null;
  contractsQty: 1 | 2;
  remainingQty: 0 | 1 | 2;
  totalOutlay: number;
  estTp1Mid?: number;
  estTp2Mid?: number;
  estStopMid?: number;
  tp1Pct?: number;
  tp2Pct?: number;
  pnlSpotPct?: number;
  pnlOptionPct?: number;
  rrRatio?: number;
  altContractNote?: string;
  message: string;
}

export interface DailyTradeStore {
  date: string; // YYYY-MM-DD (ET)
  activePositions: Record<string, OptionTradePosition>; // ticker -> active position (OPEN or PARTIAL_TP1)
  closedPositions: OptionTradePosition[];
  alerts: TradeLifecycleAlert[];
  prevSpotPrices: Record<string, number>;
  backfilledTickers?: Record<string, boolean>;
  dailyRecapSent?: boolean;
}

export interface SelectedOptionContract {
  symbol: string;
  strike: number;
  expiration: string;
  expHuman: string;
  robinhoodExp: string;
  robinhoodTab: string;
  dte: number;
  contractType: ContractType;
  contractLabel: string;
  optionBid?: number;
  optionAsk?: number;
  optionMid: number;
  delta: number;
  contractsQty: 1 | 2;
  totalOutlay: number;
  estTp1Mid: number;
  estTp2Mid: number;
  estStopMid: number;
  tp1Pct: number;
  tp2Pct: number;
  altContractNote?: string;
}

export interface Candle5m {
  open: number;
  high: number;
  low: number;
  close: number;
  sma34: number;
}

export interface TradeEvaluationParams {
  ticker: string;
  spotPrice: number;
  prevSpotPrice?: number;
  callWall: number;
  putWall: number;
  zeroGamma: number;
  zeroDteCallWall?: number;
  zeroDtePutWall?: number;
  zeroDteZeroGamma?: number;
  dailyExpectedMove?: { low: number; high: number } | null;
  kingNode?: { strike?: number; allExpKing?: number; kingStrength: number; isContested: boolean } | null;
  filteredKing?: number | null;
  bookCenter?: number | null;
  divergence5m?: DivergenceDirection | null;
  divergence30m?: DivergenceDirection | null;
  latest5mCandle?: Candle5m | null;
  contracts?: NormalizedOptionContract[] | null;
  conviction?: number;
  nowEt?: Date;
  webhookUrl?: string;
}

export interface TradeEvaluationResult {
  ticker: string;
  activePosition: OptionTradePosition | null;
  emittedAlerts: TradeLifecycleAlert[];
  allAlerts: TradeLifecycleAlert[];
}

const SUPPORTED_TRADE_TICKERS = new Set(["SPY", "QQQ", "SPXW", "SPX", "IWM"]);

let inMemoryTradeStore: DailyTradeStore | null = null;

function getCacheDir(): string {
  const dir = path.join(process.cwd(), ".cache");
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // Serverless/read-only filesystem fallback
    }
  }
  return dir;
}

export function getTodayEt(): string {
  try {
    return new Date().toLocaleDateString("en-CA", {
      timeZone: "America/New_York",
    });
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

export function formatTimeEt(dateOrTs: Date | number): string {
  const d = typeof dateOrTs === "number" ? new Date(dateOrTs * 1000) : dateOrTs;
  try {
    return d.toLocaleTimeString("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
}

export function getNowEtTime(date?: Date): { hours: number; minutes: number; totalMinutes: number } {
  const d = date ?? new Date();
  try {
    const etString = d.toLocaleString("en-US", { timeZone: "America/New_York" });
    const etDate = new Date(etString);
    const hours = etDate.getHours();
    const minutes = etDate.getMinutes();
    return { hours, minutes, totalMinutes: hours * 60 + minutes };
  } catch {
    const hours = d.getHours();
    const minutes = d.getMinutes();
    return { hours, minutes, totalMinutes: hours * 60 + minutes };
  }
}

export function loadTradeStore(): DailyTradeStore {
  const today = getTodayEt();
  if (inMemoryTradeStore && inMemoryTradeStore.date === today) {
    return inMemoryTradeStore;
  }

  const cacheDir = getCacheDir();

  // Prune older active-trades-*.json files from previous sessions
  try {
    const files = fs.readdirSync(cacheDir);
    for (const f of files) {
      if (f.startsWith("active-trades-") && !f.includes(today)) {
        try {
          fs.unlinkSync(path.join(cacheDir, f));
        } catch {
          // ignore cleanup failures
        }
      }
    }
  } catch {
    // ignore directory read errors
  }

  const filePath = path.join(cacheDir, `active-trades-${today}.json`);

  if (fs.existsSync(filePath)) {
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw) as DailyTradeStore;
      if (parsed && parsed.date === today && parsed.activePositions) {
        inMemoryTradeStore = parsed;
        return inMemoryTradeStore;
      }
    } catch {
      // Failed to parse, initialize new
    }
  }

  inMemoryTradeStore = {
    date: today,
    activePositions: {},
    closedPositions: [],
    alerts: [],
    prevSpotPrices: {},
  };
  return inMemoryTradeStore;
}

export function saveTradeStore(store: DailyTradeStore): void {
  try {
    inMemoryTradeStore = store;
    const cacheDir = getCacheDir();
    const filePath = path.join(cacheDir, `active-trades-${store.date}.json`);
    fs.writeFileSync(filePath, JSON.stringify(store, null, 2), "utf-8");
  } catch {
    // Non-fatal if filesystem write fails (e.g. read-only environment)
  }
}

export function getActivePositions(): Record<string, OptionTradePosition> {
  const store = loadTradeStore();
  return store.activePositions;
}

export function getActivePosition(ticker: string): OptionTradePosition | null {
  const sym = ticker.trim().toUpperCase();
  const normalizedSym = sym === "SPX" ? "SPXW" : sym;
  const store = loadTradeStore();
  return store.activePositions[normalizedSym] ?? store.activePositions[sym] ?? null;
}

export function getClosedPositions(ticker?: string): OptionTradePosition[] {
  const store = loadTradeStore();
  if (!ticker) return store.closedPositions;
  const sym = ticker.trim().toUpperCase();
  const normalizedSym = sym === "SPX" ? "SPXW" : sym;
  return store.closedPositions.filter(
    (p) => p.ticker === sym || p.ticker === normalizedSym
  );
}

export function getDailyTradeAlerts(ticker?: string): TradeLifecycleAlert[] {
  const store = loadTradeStore();
  if (!ticker) return store.alerts;
  const sym = ticker.trim().toUpperCase();
  const normalizedSym = sym === "SPX" ? "SPXW" : sym;
  return store.alerts.filter(
    (a) => a.ticker === sym || a.ticker === normalizedSym
  );
}

export function clearDailyTrades(): void {
  const today = getTodayEt();
  inMemoryTradeStore = {
    date: today,
    activePositions: {},
    closedPositions: [],
    alerts: [],
    prevSpotPrices: {},
    dailyRecapSent: false,
  };
  saveTradeStore(inMemoryTradeStore);
}

/**
 * Contract Mid-Price Helper
 */
function getContractMidPrice(c: NormalizedOptionContract): number {
  if (c.bid && c.ask && c.bid > 0 && c.ask > 0) {
    return Number(((c.bid + c.ask) / 2).toFixed(2));
  }
  if (c.last && c.last > 0) {
    return Number(c.last.toFixed(2));
  }
  return 0;
}

/**
 * Cache for live CBOE delayed options chain (10s TTL) and live underlying spot prices
 */
const cboeChainCache = new Map<string, { ts: number; contracts: NormalizedOptionContract[] }>();
const spotPriceCache = new Map<string, number>();
const CBOE_CACHE_TTL_MS = 10_000;

export function getCachedSpotPrice(ticker: string): number | null {
  const sym = ticker.trim().toUpperCase();
  const cboeSymbol = sym === "SPX" || sym === "SPXW" ? "_SPX" : sym;
  return spotPriceCache.get(cboeSymbol) ?? spotPriceCache.get(sym) ?? null;
}

export async function fetchLiveCboeOptions(ticker: string): Promise<NormalizedOptionContract[]> {
  const sym = ticker.trim().toUpperCase();
  // SPX and SPXW index options trade under the CBOE ticker `_SPX`
  const cboeSymbol = sym === "SPX" || sym === "SPXW" ? "_SPX" : sym;

  const cached = cboeChainCache.get(cboeSymbol);
  if (cached && Date.now() - cached.ts < CBOE_CACHE_TTL_MS) {
    return cached.contracts;
  }

  try {
    const res = await fetch(`https://cdn.cboe.com/api/global/delayed_quotes/options/${cboeSymbol}.json`, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) HyperionTerminal/1.0",
      },
      cache: "no-store",
    });

    if (!res.ok) return cached?.contracts ?? [];
    const json = await res.json();
    const data = json?.data;
    if (!data) return cached?.contracts ?? [];

    const spot = Number(data.current_price ?? data.close ?? 0);

    // Fetch live real-time spot price from Yahoo Finance to synchronize 15-minute CBOE delay
    const yahooSym = sym === "SPX" || sym === "SPXW" ? "^GSPC" : sym === "NDX" ? "^NDX" : sym;
    let realTimeSpot = spot;
    try {
      const yRes = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
          yahooSym
        )}?interval=1m&range=1d&includePrePost=false`,
        {
          headers: { "User-Agent": "Mozilla/5.0" },
          cache: "no-store",
        }
      );
      if (yRes.ok) {
        const yJson = await yRes.json();
        const closes: (number | null)[] = yJson?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [];
        for (let i = closes.length - 1; i >= 0; i--) {
          if (typeof closes[i] === "number" && closes[i]! > 0) {
            realTimeSpot = Number(closes[i]!.toFixed(2));
            break;
          }
        }
      }
    } catch {
      // Non-fatal fallback to CBOE spot
    }

    const effectiveSpot = realTimeSpot > 0 ? realTimeSpot : spot;
    if (effectiveSpot > 0) {
      spotPriceCache.set(cboeSymbol, effectiveSpot);
      if (cboeSymbol === "_SPX") {
        spotPriceCache.set("SPX", effectiveSpot);
        spotPriceCache.set("SPXW", effectiveSpot);
      }
    }

    // Difference between real-time market spot and 15-minute delayed CBOE spot
    const deltaSpot = realTimeSpot > 0 && spot > 0 ? realTimeSpot - spot : 0;

    const rawOptions = data.options;
    if (!Array.isArray(rawOptions)) return cached?.contracts ?? [];

    const contracts: NormalizedOptionContract[] = [];
    for (const raw of rawOptions) {
      const occ = String(raw.option ?? "");
      const match = occ.match(/^([A-Z0-9_]+?)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
      if (!match) continue;

      const [, root, yy, mm, dd, typeChar, strikeRaw] = match;
      const expiration = `20${yy}-${mm}-${dd}`;
      const strike = parseInt(strikeRaw, 10) / 1000;
      if (!Number.isFinite(strike) || strike <= 0) continue;

      const openInterest = Number(raw.open_interest ?? 0);
      const volume = Number(raw.volume ?? 0);
      let bid = Number(raw.bid ?? 0);
      let ask = Number(raw.ask ?? 0);
      let last = Number(raw.last_trade_price ?? 0);

      // Filter out totally dead contracts with zero quote & zero interest
      if (bid <= 0 && ask <= 0 && last <= 0 && openInterest <= 0 && volume <= 0) continue;

      const delta = Number(raw.delta ?? 0);

      // Real-time Greek synchronization: adjust delayed CBOE option pricing to current live spot
      if (Math.abs(deltaSpot) > 0.05 && Math.abs(delta) > 0.02) {
        const isCall = typeChar === "C";
        const sign = isCall ? 1 : -1;
        const priceAdj = deltaSpot * delta * sign;
        if (bid > 0) bid = Number(Math.max(0.01, bid + priceAdj).toFixed(2));
        if (ask > 0) ask = Number(Math.max(0.02, ask + priceAdj).toFixed(2));
        if (last > 0) last = Number(Math.max(0.01, last + priceAdj).toFixed(2));
      }

      contracts.push({
        symbol: occ,
        expiration,
        optionType: typeChar as "C" | "P",
        strike,
        openInterest,
        volume,
        iv: Number(raw.iv ?? 0),
        delta,
        gamma: Number(raw.gamma ?? 0),
        vega: Number(raw.vega ?? 0),
        percentChange: Number(raw.percent_change ?? 0),
        bid,
        ask,
        last,
      });
    }

    if (contracts.length > 0) {
      cboeChainCache.set(cboeSymbol, { ts: Date.now(), contracts });
    }
    return contracts;
  } catch {
    return cached?.contracts ?? [];
  }
}

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
    const dte = Math.max(0, diffDays);

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

    // Matches Robinhood's exact dropdown label, e.g. "October 22 (0d)", "October 23 (1d)", "October 26 (4d)"
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
 * Finds the next trading weekday (Monday - Friday), skipping weekends
 */
export function getNextTradingDay(baseDate: Date): Date {
  const d = new Date(baseDate);
  d.setDate(d.getDate() + 1);
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() + 1);
  }
  return d;
}

/**
 * Strict Sub-$1.00 Contract Selector & 1–2 Contract Position Sizer
 * - Fetches or uses real live CBOE option chains (never manufactures fake weekend dates or fake prices)
 * - Price Cap: strictly $0.15 <= mid <= $1.00 (sweet spot: $0.35 - $0.85)
 * - Expiration Priority: After 11:30 AM ET, prioritizes 1-3 DTE to protect small accounts from 0DTE theta crush
 * - SPXW routing: suggests equivalent liquid SPY contract matching underlying SPX move
 * - Position Sizing: Calculated strictly off Live ASK.
 *   - ask <= $0.50 -> 2 contracts (total outlay <= $100)
 *   - ask > $0.50 ($0.51 - $0.99) -> 1 contract (total outlay <= $100)
 *   - Never manufactures fake quotes; returns null if no qualifying contract found
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
}): Promise<SelectedOptionContract | null> {
  const {
    ticker,
    contractType,
    spotPrice,
    target1Spot,
    target2Spot,
    stopLossSpot,
    conviction = 70,
    nowEt,
    zeroDteCallWall,
    zeroDtePutWall,
  } = params;

  let contracts = params.contracts;
  const sym = ticker.trim().toUpperCase();
  const isSpxw = sym === "SPXW" || sym === "SPX";
  const todayEt = getTodayEt();
  const etTime = getNowEtTime(nowEt);
  const typeLetter = contractType === "CALL" ? "C" : "P";
  const isCall = contractType === "CALL";

  let altContractNote: string | undefined = undefined;

  let effectiveSym = sym;
  let effectiveSpot = spotPrice;
  let effectiveTarget1 = target1Spot;
  let effectiveTarget2 = target2Spot;

  if (isSpxw) {
    effectiveSym = "SPY";
    effectiveSpot = Number((spotPrice / 10).toFixed(2));
    effectiveTarget1 = Number((target1Spot / 10).toFixed(2));
    effectiveTarget2 = Number((target2Spot / 10).toFixed(2));
    altContractNote = `SPXW Index > $1.00/contract · Using SPY Equivalent for Sub-$1.00 Small Account`;
  }

  // 1. If live contracts are missing or empty, fetch real CBOE chain directly
  if (!contracts || contracts.length === 0) {
    contracts = await fetchLiveCboeOptions(effectiveSym);
  }

  // 2. Filter from real CBOE chain
  if (contracts && contracts.length > 0) {
    interface Candidate {
      contract: NormalizedOptionContract;
      mid: number;
      bid: number;
      ask: number;
      dte: number;
      expHuman: string;
      robinhoodExp: string;
      robinhoodTab: string;
      absDelta: number;
      score: number;
    }

    const stage1Candidates: Candidate[] = []; // Preferred DTEs
    const stage2Candidates: Candidate[] = []; // Alternate DTEs

    const isAfternoon = etTime.hours > 11 || (etTime.hours === 11 && etTime.minutes >= 30);

    for (const c of contracts) {
      if (c.optionType !== typeLetter) continue;
      const mid = getContractMidPrice(c);

      const askPrice = c.ask && c.ask > 0 ? c.ask : mid;
      // Strict Sub-$1.00 Ask Cap: retail buys at ASK ($0.15 <= ask <= $0.99)
      if (askPrice < 0.15 || askPrice > 0.99) continue;

      // Reject low-delta lotto contracts (< 0.18 delta) to avoid rapid theta drag
      const absDelta = Math.abs(c.delta || 0.30);
      if (absDelta < 0.18) continue;

      // Reject wide-spread contracts (> 24% spread) to avoid immediate execution penalty
      if (c.bid && c.ask && c.ask > c.bid) {
        const spreadPct = (c.ask - c.bid) / c.ask;
        if (spreadPct > 0.24) continue;
      }

      // Strike direction filter: OTM / near ATM in direction of move
      if (isCall && c.strike < effectiveSpot * 0.998) continue;
      if (!isCall && c.strike > effectiveSpot * 1.002) continue;

      // Anti-King-Trap Guardrail: Never select deep OTM lottery strikes (> 1.15% OTM and > $2 past Target 2)
      // Prevents buying e.g. $755 Puts when SPY is at $767 (-1.56% away) just because All-Exp King is $755
      if (!isCall && c.strike < effectiveSpot * 0.9885 && c.strike < effectiveTarget2 - 2) continue;
      if (isCall && c.strike > effectiveSpot * 1.0115 && c.strike > effectiveTarget2 + 2) continue;

      const { expHuman, robinhoodExp, robinhoodTab, dte } = formatExpirationHuman(c.expiration, todayEt);

      // Sweet spot distance ($0.35 - $0.85 preferred)
      let priceScore = 0;
      if (mid >= 0.35 && mid <= 0.85) {
        priceScore += 50;
      } else {
        priceScore += 25;
      }

      // Proximity to target1
      const distToTarget = Math.abs(c.strike - effectiveTarget1);
      const targetScore = Math.max(0, 40 - distToTarget * 4);

      // Delta score (0.18 - 0.45 ideal for sub-$1.00 OTMs)
      const deltaScore = absDelta >= 0.18 && absDelta <= 0.45 ? 30 : 10;

      // Liquidity score
      const liqScore = Math.min(25, ((c.openInterest || 0) + (c.volume || 0)) / 100);

      // 0DTE Wall Affinity Score:
      // In small account trading, strike selection for BTO Puts (rejection setups) must be closely
      // related to the 0DTE walls (i.e. Put Wall target and the 0DTE wall corridor).
      let wallAffinityScore = 0;
      const targetWall = isCall
        ? (zeroDteCallWall && isSpxw ? zeroDteCallWall / 10 : zeroDteCallWall) || effectiveTarget2
        : (zeroDtePutWall && isSpxw ? zeroDtePutWall / 10 : zeroDtePutWall) || effectiveTarget2;

      if (targetWall && targetWall > 0) {
        const distToWall = Math.abs(c.strike - targetWall);
        if (distToWall <= 2) {
          wallAffinityScore += 50; // Directly at or adjacent to 0DTE Wall
        } else if (distToWall <= 4) {
          wallAffinityScore += 30; // Very close to 0DTE Wall
        } else if (distToWall <= 8) {
          wallAffinityScore += 10;
        }

        // Heavy penalty for strikes far past the 0DTE destination wall
        // e.g. buying deep OTM puts > $4 below the 0DTE Put Wall that suffer theta burn
        if (!isCall && c.strike < targetWall - 4) {
          wallAffinityScore -= 35;
        } else if (isCall && c.strike > targetWall + 4) {
          wallAffinityScore -= 35;
        }
      }

      const totalScore = priceScore + targetScore + deltaScore + liqScore + wallAffinityScore;

      const candidateObj: Candidate = {
        contract: c,
        mid,
        bid: c.bid ?? mid,
        ask: c.ask ?? mid,
        dte,
        expHuman,
        robinhoodExp,
        robinhoodTab,
        absDelta,
        score: totalScore,
      };

      if (isAfternoon) {
        // After 11:30 AM: 1-3 DTE is primary (avoids 0DTE theta crush), 0DTE secondary
        if (dte >= 1 && dte <= 3) {
          stage1Candidates.push(candidateObj);
        } else {
          stage2Candidates.push(candidateObj);
        }
      } else {
        // Morning: 0-2 DTE are primary
        if (dte <= 2) {
          stage1Candidates.push(candidateObj);
        } else {
          stage2Candidates.push(candidateObj);
        }
      }
    }

    // Pick top scored candidate from preferred stage, falling back to secondary
    stage1Candidates.sort((a, b) => b.score - a.score);
    stage2Candidates.sort((a, b) => b.score - a.score);

    const chosen = stage1Candidates[0] ?? stage2Candidates[0];

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

      // Institutional Small-Account Sizing Engine (Strict Capital Outlay Invariant <= $100.00)
      const entryAsk = ask > 0 ? ask : mid;
      const sizing = calculateSmallAccountSize(entryAsk);
      if (!sizing.allowed) {
        // Automatically rejects contracts costing > $100
        return null;
      }

      const contractsQty: 1 | 2 = sizing.contractsQty;
      const totalOutlay = sizing.totalOutlay;

      // Invariant check
      const invariantCheck = assertSmallAccountInvariant(totalOutlay, contractsQty);
      if (!invariantCheck.valid) {
        return null;
      }

      // Option target & stop estimates based on realistic fill
      const dSpot1 = Math.abs(effectiveTarget1 - effectiveSpot);
      const dSpot2 = Math.abs(effectiveTarget2 - effectiveSpot);

      const estTp1Mid = Number((entryAsk + delta * dSpot1).toFixed(2));
      const tp1Pct = Number((((estTp1Mid - entryAsk) / entryAsk) * 100).toFixed(0));

      const estTp2Mid = Number((entryAsk + delta * dSpot2).toFixed(2));
      const tp2Pct = Number((((estTp2Mid - entryAsk) / entryAsk) * 100).toFixed(0));

      // Capped at -25% max hard stop loss from entry ask
      const estStopMid = Number(Math.max(0.05, entryAsk * 0.75).toFixed(2));

      const expClean = c.expiration.replace(/-/g, "").slice(2);
      const strikeLabel = Number.isInteger(c.strike) ? c.strike.toString() : c.strike.toFixed(1);
      const displaySym = c.strike > 1000 ? "SPXW" : effectiveSym;
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
      };
    }
  }

  // If no qualifying liquid contract under $1.00 exists, return null (never manufacture fake quotes)
  return null;
}

/**
 * Backward-compatible alias
 */
export const selectOptimalContract = selectSmallAccountContract;

/**
 * Cache for live 5m candles and divergence
 */
interface CandleCacheEntry {
  ts: number;
  candle: Candle5m;
  divergence5m: DivergenceDirection;
  divergence30m: DivergenceDirection;
}
const candleCache = new Map<string, CandleCacheEntry>();

export async function fetchLive5mCandleAndDivergence(
  ticker: string
): Promise<{ candle: Candle5m | null; divergence5m: DivergenceDirection; divergence30m: DivergenceDirection }> {
  const sym = ticker.trim().toUpperCase();
  const cached = candleCache.get(sym);
  if (cached && Date.now() - cached.ts < 20_000) {
    return {
      candle: cached.candle,
      divergence5m: cached.divergence5m,
      divergence30m: cached.divergence30m,
    };
  }

  let candle: Candle5m | null = null;
  let divergence5m: DivergenceDirection = "NO";
  let divergence30m: DivergenceDirection = "NO";

  // 1. Fetch 5m candles from Yahoo Finance
  const yahooSym = sym === "SPX" || sym === "SPXW" ? "^GSPC" : sym === "NDX" || sym === "NDXP" ? "^NDX" : sym;
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}?interval=5m&range=2d&includePrePost=false`,
      {
        headers: {
          Accept: "application/json",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) HyperionTerminal/1.0",
        },
        cache: "no-store",
      }
    );
    if (res.ok) {
      const json = await res.json();
      const quote = json?.chart?.result?.[0]?.indicators?.quote?.[0];
      if (quote) {
        const opens: (number | null)[] = quote.open ?? [];
        const highs: (number | null)[] = quote.high ?? [];
        const lows: (number | null)[] = quote.low ?? [];
        const closes: (number | null)[] = quote.close ?? [];

        const validBars: { open: number; high: number; low: number; close: number }[] = [];
        for (let i = 0; i < closes.length; i++) {
          const c = closes[i];
          const o = opens[i];
          const h = highs[i];
          const l = lows[i];
          if (
            typeof c === "number" &&
            typeof o === "number" &&
            typeof h === "number" &&
            typeof l === "number" &&
            c > 0
          ) {
            validBars.push({ open: o, high: h, low: l, close: c });
          }
        }

        if (validBars.length >= 2) {
          const latest = validBars[validBars.length - 1];
          // Calculate SMA 34 across valid 5m closes
          const startIdx = Math.max(0, validBars.length - 34);
          let sum = 0;
          let count = 0;
          for (let k = startIdx; k < validBars.length; k++) {
            sum += validBars[k].close;
            count++;
          }
          const sma34 = Number((sum / Math.max(1, count)).toFixed(2));
          candle = {
            open: Number(latest.open.toFixed(2)),
            high: Number(latest.high.toFixed(2)),
            low: Number(latest.low.toFixed(2)),
            close: Number(latest.close.toFixed(2)),
            sma34,
          };
        }
      }
    }
  } catch {
    // Non-fatal
  }

  // 2. Fetch divergence from TerraShade API
  try {
    const divSym = sym === "SPX" ? "SPXW" : sym;
    const divRes = await fetch(`https://terrashade.onrender.com/api/divergence?symbol=${encodeURIComponent(divSym)}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (divRes.ok) {
      const divData = await divRes.json();
      const row5m = divData?.rows?.find((r: any) => r.tf === "5" || r.name === "5m");
      const row30m = divData?.rows?.find((r: any) => r.tf === "30" || r.name === "30m");
      if (row5m) {
        if (row5m.state === "BULL" || row5m.signal?.type === "bull") divergence5m = "BULL";
        else if (row5m.state === "BEAR" || row5m.signal?.type === "bear") divergence5m = "BEAR";
      }
      if (row30m) {
        if (row30m.state === "BULL" || row30m.signal?.type === "bull") divergence30m = "BULL";
        else if (row30m.state === "BEAR" || row30m.signal?.type === "bear") divergence30m = "BEAR";
      }
    }
  } catch {
    // Non-fatal
  }

  if (candle) {
    candleCache.set(sym, {
      ts: Date.now(),
      candle,
      divergence5m,
      divergence30m,
    });
  }

  return { candle, divergence5m, divergence30m };
}

/**
 * Sends a Trade Lifecycle Alert directly to Discord using the Sub-$1.00 Small Account embed format
 */
export async function sendDiscordTradeAlert(
  alert: TradeLifecycleAlert,
  customWebhookUrl?: string
): Promise<boolean> {
  const webhookUrl =
    (customWebhookUrl || process.env.DISCORD_WEBHOOK_URL)?.trim() ||
    DEFAULT_DISCORD_WEBHOOK_URL;

  try {
    const isBto = alert.action === "BUY_TO_OPEN";
    const isCalls = alert.contractType === "CALL";

    let embedColor: number;
    let title: string;
    let description: string;
    let fields: { name: string; value: string; inline: boolean }[] = [];

    if (isBto) {
      // BTO Embed: Emerald Green (0x10b981) for CALLS, Electric Violet (0x8b5cf6) for PUTS
      embedColor = isCalls ? 0x10b981 : 0x8b5cf6;
      const emoji = isCalls ? "🟢" : "🟣";
      const mid = alert.btoOptionMid || 0.55;
      const bid = alert.optionBid ?? (mid > 0.05 ? mid - 0.01 : mid);
      const ask = alert.optionAsk ?? mid + 0.01;
      const qty = alert.contractsQty || 1;
      const totalOutlay = alert.totalOutlay || mid * 100 * qty;
      const expTabStr = alert.robinhoodTab || alert.robinhoodExp || alert.expHuman || alert.expiration;

      title = `${emoji} BUY TO OPEN · ${alert.ticker} ${alert.contractType}S (${qty}x @ $${mid.toFixed(2)})`;
      description = `**Setup:** ${alert.setupName}\n${
        alert.altContractNote ? `⚠️ *${alert.altContractNote}*\n` : ""
      }**Contract:** \`${alert.contractLabel}\``;

      const rrStr = alert.rrRatio
        ? alert.rrRatio.toFixed(2)
        : (
            Math.abs(alert.target1Spot - alert.btoSpotPrice) /
            Math.max(0.01, Math.abs(alert.btoSpotPrice - alert.stopLossSpot))
          ).toFixed(2);

      const tp1Est = alert.estTp1Mid
        ? `TP1 ~$${alert.estTp1Mid.toFixed(2)} (+${alert.tp1Pct || 40}%)`
        : `TP1 (Trim 50%)`;
      const tp2Est = alert.estTp2Mid
        ? `TP2 ~$${alert.estTp2Mid.toFixed(2)} (+${alert.tp2Pct || 110}%)`
        : `TP2 (Full Exit)`;
      const stopEst = alert.estStopMid
        ? `$${alert.estStopMid.toFixed(2)} (-25% max or Spot $${alert.stopLossSpot.toFixed(2)})`
        : `$${alert.stopLossSpot.toFixed(2)}`;

      fields = [
        {
          name: "🎟️ Contract & Robinhood Tab",
          value: `**${alert.ticker} $${alert.strike} ${alert.contractType}**\n📅 Exp: **${alert.expHuman || alert.expiration}**\n👉 **Robinhood Tab:** \`${expTabStr}\``,
          inline: true,
        },
        {
          name: "💵 Live Market Quote",
          value: `Bid: **$${bid.toFixed(2)}** | Ask: **$${ask.toFixed(2)}**\nMid: **$${mid.toFixed(2)}** ($${(mid * 100).toFixed(0)}/contract)`,
          inline: true,
        },
        {
          name: "📦 Small Acct Size",
          value: `**${qty} Contract${qty > 1 ? "s" : ""}** ($${totalOutlay.toFixed(0)} Total Outlay)`,
          inline: true,
        },
        {
          name: "🎯 Underlying Entry",
          value: `$${alert.btoSpotPrice.toFixed(2)}`,
          inline: true,
        },
        {
          name: "⚖️ Estimated R:R",
          value: `**${rrStr}:1**`,
          inline: true,
        },
        {
          name: "🛑 Underlying Stop",
          value: `$${alert.stopLossSpot.toFixed(2)}`,
          inline: true,
        },
        {
          name: "💰 Option TP1 / TP2 Est.",
          value: `${tp1Est} | ${tp2Est}`,
          inline: false,
        },
        {
          name: "🛑 Option Hard Stop",
          value: `${stopEst}`,
          inline: true,
        },
        {
          name: "⏰ Opened At",
          value: `${alert.timestamp} ET`,
          inline: true,
        },
      ];
    } else {
      // STC Embed: Color coded by exit reason
      const reasonUpper = alert.reason.toUpperCase();
      let emoji = "🔴";
      const isTrim = reasonUpper.includes("1 OF 2") || alert.status === "PARTIAL_TP1";

      if (isTrim) {
        embedColor = 0xf59e0b; // Amber / Gold
        emoji = alert.contractsQty === 2 ? "💰" : "🛡️";
        title =
          alert.contractsQty === 2
            ? `💰 SELL TO CLOSE 1 OF 2 CONTRACTS · ${alert.ticker} ${alert.contractType}S`
            : `🛡️ RAISE STOP TO PROFIT / SCALP · ${alert.ticker} ${alert.contractType}S`;
      } else if (reasonUpper.includes("TARGET 2") || reasonUpper.includes("FULL")) {
        embedColor = 0x10b981; // Emerald Green
        emoji = "🎯";
        title = `🎯 SELL TO CLOSE FINAL 1 CONTRACT (FULL TARGET) · ${alert.ticker} ${alert.contractType}S`;
      } else if (reasonUpper.includes("REVERSAL")) {
        embedColor = 0x3b82f6; // Royal Blue
        emoji = "🔄";
        title = `🔄 SELL TO CLOSE (REVERSAL PROTECT) · ${alert.ticker} ${alert.contractType}S`;
      } else if (reasonUpper.includes("BREAKEVEN")) {
        embedColor = 0x94a3b8; // Slate Gray
        emoji = "⚪";
        title = `⚪ SELL TO CLOSE (BREAKEVEN STOP) · ${alert.ticker} ${alert.contractType}S`;
      } else if (reasonUpper.includes("3:50") || reasonUpper.includes("EOD")) {
        embedColor = 0xf97316; // Orange
        emoji = "⏰";
        title = `⏰ SELL TO CLOSE (3:50 PM ET EOD EXIT) · ${alert.ticker} ${alert.contractType}S`;
      } else if (reasonUpper.includes("HARD STOP") || reasonUpper.includes("-25%")) {
        embedColor = 0xef4444; // Crimson Red
        emoji = "🛑";
        title = `🛑 SELL TO CLOSE (OPTION HARD STOP HIT) · ${alert.ticker} ${alert.contractType}S`;
      } else {
        embedColor = 0xef4444; // Crimson Red (Stop Loss / Invalidation)
        emoji = "🛑";
        title = `🛑 SELL TO CLOSE (STOP LOSS) · ${alert.ticker} ${alert.contractType}S`;
      }

      description = `**Contract:** \`${alert.contractLabel}\` · **Setup:** ${alert.setupName}\n**Exit Action:** ${alert.reason}`;

      const spotMovePct =
        alert.pnlSpotPct != null
          ? alert.pnlSpotPct
          : alert.contractType === "CALL"
            ? ((alert.spotPrice - alert.btoSpotPrice) / alert.btoSpotPrice) * 100
            : ((alert.btoSpotPrice - alert.spotPrice) / alert.btoSpotPrice) * 100;

      const spotMoveStr = `${spotMovePct >= 0 ? "+" : ""}${spotMovePct.toFixed(2)}%`;

      let optionPnlStr = "N/A";
      if (alert.btoOptionMid != null && alert.optionMid != null) {
        const optPct =
          alert.pnlOptionPct != null
            ? alert.pnlOptionPct
            : ((alert.optionMid - alert.btoOptionMid) / alert.btoOptionMid) * 100;
        optionPnlStr = `$${alert.btoOptionMid.toFixed(2)} → $${alert.optionMid.toFixed(2)} (${
          optPct >= 0 ? "+" : ""
        }${optPct.toFixed(1)}%)`;
      }

      let positionActionStr: string;
      if (alert.contractsQty === 2 && alert.remainingQty === 1) {
        positionActionStr = "💰 Sold 1 of 2 Contracts · 1 Runner Active with BE Stop";
      } else if (alert.contractsQty === 1 && alert.status === "PARTIAL_TP1") {
        positionActionStr = "🛡️ Stop Raised to Profit (+25% Min Locked) · 1 Runner Active";
      } else {
        positionActionStr = `100% Position Closed (${alert.contractsQty} Contract${
          alert.contractsQty > 1 ? "s" : ""
        })`;
      }

      fields = [
        { name: "🎯 Underlying Exit", value: `$${alert.spotPrice.toFixed(2)}`, inline: true },
        { name: "🏁 Entry Spot", value: `$${alert.btoSpotPrice.toFixed(2)}`, inline: true },
        { name: "📈 Spot Move", value: spotMoveStr, inline: true },
        { name: "💵 Option Premium", value: optionPnlStr, inline: true },
        {
          name: "📦 Position Action",
          value: positionActionStr,
          inline: true,
        },
        { name: "⏰ Timestamp", value: `${alert.timestamp} ET`, inline: true },
      ];
    }

    const payload = {
      username: "Hyperion Terminal",
      embeds: [
        {
          author: { name: "Hyperion Sub-$1.00 Options Engine (1-2 Contracts Max)" },
          title,
          description,
          color: embedColor,
          fields,
          timestamp: new Date().toISOString(),
          footer: {
            text: isBto
              ? "Hyperion · Sub-$1.00 Small Account Options Engine (1-2 Contracts Max)"
              : "Hyperion · STC Small Account Options Engine",
          },
        },
      ],
    };

    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Reconstructs today's RTH 5-minute session BTO/STC signals if the server started mid-session
 * or after the morning opening drive, ensuring traders never miss morning setups or their exits.
 */
async function backfillIntradaySessionSignals(
  normalizedTicker: string,
  params: TradeEvaluationParams,
  store: DailyTradeStore,
  currentSpot: number
): Promise<void> {
  const yahooSym =
    normalizedTicker === "SPX" || normalizedTicker === "SPXW"
      ? "^GSPC"
      : normalizedTicker === "NDX" || normalizedTicker === "NDXP"
        ? "^NDX"
        : normalizedTicker;

  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
        yahooSym
      )}?interval=5m&range=2d&includePrePost=false`,
      {
        headers: {
          Accept: "application/json",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) HyperionTerminal/1.0",
        },
        cache: "no-store",
      }
    );
    if (!res.ok) return;
    const json = await res.json();
    const result = json?.chart?.result?.[0];
    const timestamps: number[] = result?.timestamp ?? [];
    const quote = result?.indicators?.quote?.[0];
    if (!quote || timestamps.length < 5) return;

    const opens: (number | null)[] = quote.open ?? [];
    const highs: (number | null)[] = quote.high ?? [];
    const lows: (number | null)[] = quote.low ?? [];
    const closes: (number | null)[] = quote.close ?? [];

    interface HistBar {
      ts: number;
      dateEt: string;
      totalMinutes: number;
      open: number;
      high: number;
      low: number;
      close: number;
      sma34: number;
    }

    const allValid: HistBar[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const o = opens[i];
      const h = highs[i];
      const l = lows[i];
      const c = closes[i];
      const ts = timestamps[i];
      if (
        typeof o !== "number" ||
        typeof h !== "number" ||
        typeof l !== "number" ||
        typeof c !== "number" ||
        c <= 0
      ) {
        continue;
      }
      const d = new Date(ts * 1000);
      const dateEt = d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
      const etTime = getNowEtTime(d);
      allValid.push({
        ts,
        dateEt,
        totalMinutes: etTime.totalMinutes,
        open: Number(o.toFixed(2)),
        high: Number(h.toFixed(2)),
        low: Number(l.toFixed(2)),
        close: Number(c.toFixed(2)),
        sma34: Number(c.toFixed(2)),
      });
    }

    for (let i = 0; i < allValid.length; i++) {
      const startIdx = Math.max(0, i - 33);
      let sum = 0;
      let count = 0;
      for (let k = startIdx; k <= i; k++) {
        sum += allValid[k].close;
        count++;
      }
      allValid[i].sma34 = Number((sum / Math.max(1, count)).toFixed(2));
    }

    // Filter to latest trading session RTH bars (9:30 AM to 3:55 PM ET)
    const latestSessionDate = allValid[allValid.length - 1]?.dateEt;
    if (!latestSessionDate) return;

    const sessionBars = allValid.filter(
      (b) => b.dateEt === latestSessionDate && b.totalMinutes >= 570 && b.totalMinutes <= 955
    );
    if (sessionBars.length < 3) return;

    // Determine morning opening support and session high resistance
    const openingSlice = sessionBars.slice(0, Math.min(6, sessionBars.length));
    const openingLow = Math.min(...openingSlice.map((b) => b.low));
    const sessionHigh = Math.max(...sessionBars.map((b) => b.high));

    const effectiveDailyLow =
      params.dailyExpectedMove?.low &&
      Math.abs(openingLow - params.dailyExpectedMove.low) / openingLow <= 0.008
        ? Math.max(openingLow, params.dailyExpectedMove.low)
        : openingLow;
    const effectiveDailyHigh = Math.max(
      sessionHigh,
      params.filteredKing ?? 0,
      params.dailyExpectedMove?.high ?? 0,
      Number((openingLow * 1.0065).toFixed(2))
    );

    const baseContracts = params.contracts ?? [];
    const isSpxw = normalizedTicker === "SPXW" || normalizedTicker === "SPX";

    // Replay bar-by-bar chronologically through today's RTH session (starting at 9:45 AM after 15m Opening Range)
    const replayStartIdx = Math.min(3, sessionBars.length - 1);
    const replayEndIdx = sessionBars.length;
    for (let idx = replayStartIdx; idx < replayEndIdx; idx++) {
      const bar = sessionBars[idx];
      const prevBar = sessionBars[idx - 1];
      const barDate = new Date(bar.ts * 1000);

      const openPos = store.activePositions[normalizedTicker];
      // Use intrabar high/low when an active position is open to capture real limit TP fills
      let evalSpot = bar.close;
      if (openPos) {
        if (openPos.contractType === "CALL" && bar.high >= openPos.target1Spot) {
          evalSpot = bar.high >= openPos.target2Spot ? bar.high : Math.max(bar.close, openPos.target1Spot);
        } else if (openPos.contractType === "PUT" && bar.low <= openPos.target1Spot) {
          evalSpot = bar.low <= openPos.target2Spot ? bar.low : Math.min(bar.close, openPos.target1Spot);
        }
      }

      const refSpotForChain = isSpxw ? evalSpot / 10 : evalSpot;
      const curSpotForChain = isSpxw ? currentSpot / 10 : currentSpot;
      const dSpot = refSpotForChain - curSpotForChain;

      // Synchronize option chain prices to the historical 5m bar's spot & time-of-day
      const barContracts: NormalizedOptionContract[] = baseContracts.map((c) => {
        const isCallOpt = c.optionType === "C";
        const distOtm = isCallOpt
          ? c.strike - refSpotForChain
          : refSpotForChain - c.strike;
        const estDelta = Number(
          Math.max(0.20, Math.min(0.45, 0.42 * Math.exp(-0.18 * Math.max(0, distOtm)))).toFixed(2)
        );
        const sign = isCallOpt ? 1 : -1;

        let bid = c.bid ?? 0;
        let ask = c.ask ?? 0;
        let last = c.last ?? 0;

        if (openPos && c.strike === openPos.strike && c.expiration === openPos.expiration && isCallOpt === (openPos.contractType === "CALL")) {
          // Track active position option value directly from entry fill + delta move
          const entryRef = openPos.btoSpotPrice;
          const moveFromEntry = (refSpotForChain - entryRef) * sign;
          const baseEntryAsk = openPos.optionAsk || openPos.btoOptionMid || 0.45;
          const curEstMid = Math.max(0.05, Number((baseEntryAsk + moveFromEntry * 0.22).toFixed(2)));
          bid = Math.max(0.04, Number((curEstMid - 0.01).toFixed(2)));
          ask = Number((curEstMid + 0.01).toFixed(2));
          last = curEstMid;
        } else {
          // Reconstruct realistic sub-$1.00 option quote at bar timestamp
          const rawMid = getContractMidPrice(c);
          const shiftedMid = rawMid > 0 ? rawMid + dSpot * estDelta * sign : 0;
          if (shiftedMid >= 0.20 && shiftedMid <= 0.95) {
            bid = Number(Math.max(0.18, shiftedMid - 0.02).toFixed(2));
            ask = Number(Math.min(0.98, shiftedMid + 0.02).toFixed(2));
            last = Number(shiftedMid.toFixed(2));
          } else if (distOtm >= -0.5 && distOtm <= 4.5) {
            // If current EOD chain has decayed, restore intraday time value for near-OTM strikes
            const modelMid = Number(Math.max(0.26, Math.min(0.78, 0.72 * Math.exp(-0.22 * Math.max(0, distOtm)))).toFixed(2));
            bid = Number((modelMid - 0.02).toFixed(2));
            ask = Number((modelMid + 0.02).toFixed(2));
            last = modelMid;
          }
        }

        return {
          ...c,
          delta: isCallOpt ? estDelta : -estDelta,
          bid,
          ask,
          last,
        };
      });

      await evaluateTradeSignals({
        ...params,
        ticker: normalizedTicker,
        spotPrice: evalSpot,
        prevSpotPrice: prevBar.close,
        divergence5m: undefined,
        divergence30m: undefined,
        dailyExpectedMove: {
          low: effectiveDailyLow,
          high: effectiveDailyHigh,
        },
        latest5mCandle: {
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          sma34: bar.sma34,
        },
        contracts: barContracts,
        nowEt: barDate,
      });
    }
  } catch {
    // Non-fatal if Yahoo 5m history fetch fails
  }
}

/**
 * Main Evaluation Engine: Evaluates stateful BTO and STC lifecycle rules on every poll.
 * - Tracks at most 1 active position per ticker (SPY, QQQ, SPXW, IWM).
 * - Exclusively emits BTO for Sub-$1.00 Calls/Puts and STC for active position exits.
 * - Enforces 1-2 contract sizing and smart scaling.
 */
export async function evaluateTradeSignals(
  params: TradeEvaluationParams
): Promise<TradeEvaluationResult> {
  const sym = params.ticker.trim().toUpperCase();
  const normalizedTicker = sym === "SPX" ? "SPXW" : sym;

  if (!SUPPORTED_TRADE_TICKERS.has(normalizedTicker) && !SUPPORTED_TRADE_TICKERS.has(sym)) {
    return {
      ticker: sym,
      activePosition: null,
      emittedAlerts: [],
      allAlerts: [],
    };
  }

  const store = loadTradeStore();
  let spotPrice = Number(params.spotPrice.toFixed(2));
  if (spotPrice <= 0) {
    const cached = getCachedSpotPrice(normalizedTicker);
    if (cached && cached > 0) spotPrice = Number(cached.toFixed(2));
    else if (store.prevSpotPrices[normalizedTicker] && store.prevSpotPrices[normalizedTicker] > 0) {
      spotPrice = store.prevSpotPrices[normalizedTicker];
    }
  }
  const prevSpotPrice = params.prevSpotPrice ?? store.prevSpotPrices[normalizedTicker] ?? spotPrice;
  store.prevSpotPrices[normalizedTicker] = spotPrice;

  // Retrieve 5m candle and divergence if not passed in
  let latest5mCandle = params.latest5mCandle ?? null;
  let divergence5m = params.divergence5m ?? null;
  let divergence30m = params.divergence30m ?? null;

  if (!params.nowEt && (!latest5mCandle || !divergence5m || !divergence30m)) {
    const fetched = await fetchLive5mCandleAndDivergence(normalizedTicker);
    if (!latest5mCandle) latest5mCandle = fetched.candle;
    if (!divergence5m || divergence5m === "NO") divergence5m = fetched.divergence5m;
    if (!divergence30m || divergence30m === "NO") divergence30m = fetched.divergence30m;
  }

  // Ensure real-time live CBOE option contracts are available
  if (!params.contracts || params.contracts.length === 0) {
    params.contracts = await fetchLiveCboeOptions(normalizedTicker);
  }

  // Reconstruct today's intraday RTH session BTO/STC signals from 5m bars if server started mid-session
  const hasTickerHistoryToday =
    store.alerts.some((a) => a.ticker === normalizedTicker) ||
    store.closedPositions.some((p) => p.ticker === normalizedTicker) ||
    Boolean(store.activePositions[normalizedTicker]);

  if (!params.nowEt && !hasTickerHistoryToday && !store.backfilledTickers?.[normalizedTicker]) {
    store.backfilledTickers = { ...(store.backfilledTickers || {}), [normalizedTicker]: true };
    await backfillIntradaySessionSignals(normalizedTicker, params, store, spotPrice);
  }

  const now = params.nowEt ?? new Date();
  const nowTs = Math.floor(now.getTime() / 1000);
  const timeStr = formatTimeEt(now);
  const etTime = getNowEtTime(now);

  let activePos: OptionTradePosition | null = store.activePositions[normalizedTicker] ?? null;

  // Hard Market Close Boundary: Equity/ETF options halt trading at 4:00 PM ET sharp.
  // Absolutely zero new evaluations, orders, or after-hours prices allowed after 16:00 ET.
  if (etTime.hours >= 16 && !activePos) {
    return {
      ticker: normalizedTicker,
      activePosition: null,
      emittedAlerts: [],
      allAlerts: store.alerts,
    };
  }

  // Hard Market-On-Close Cutoff at 15:55 ET (protect against Robinhood 3:55 PM forced liquidation)
  const isEodCutoff = (etTime.hours === 15 && etTime.minutes >= 55) || etTime.hours >= 16;

  const emittedAlerts: TradeLifecycleAlert[] = [];
  const hadActivePositionAtStart = Boolean(activePos);

  // --------------------------------------------------------------------------
  // STEP A: EVALUATE STC EXIT RULES (When a position is OPEN or PARTIAL_TP1)
  // --------------------------------------------------------------------------
  if (activePos && (activePos.status === "OPEN" || activePos.status === "PARTIAL_TP1")) {
    const isCall = activePos.contractType === "CALL";

    // Estimate current live option bid/mid from live chain
    let currentOptionMid: number = activePos.btoOptionMid;
    let liveBid: number | undefined = activePos.optionBid;
    let liveAsk: number | undefined = activePos.optionAsk;

    if (params.contracts && params.contracts.length > 0) {
      const match = params.contracts.find(
        (c) =>
          c.strike === activePos?.strike &&
          c.optionType === (isCall ? "C" : "P") &&
          c.expiration === activePos?.expiration
      );
      if (match) {
        const liveMid = getContractMidPrice(match);
        if (liveMid > 0) currentOptionMid = liveMid;
        if (match.bid && match.bid > 0) liveBid = match.bid;
        if (match.ask && match.ask > 0) liveAsk = match.ask;
      }
    }

    const spotMovePct = isCall
      ? ((spotPrice - activePos.btoSpotPrice) / activePos.btoSpotPrice) * 100
      : ((activePos.btoSpotPrice - spotPrice) / activePos.btoSpotPrice) * 100;

    // Realistic execution: exits execute at live BID, not mid
    const exitFillPrice = liveBid && liveBid > 0 ? liveBid : currentOptionMid;
    const entryFillPrice = activePos.optionAsk || activePos.btoOptionMid;
    const pnlOptionPct = Number(
      (((exitFillPrice - entryFillPrice) / Math.max(0.01, entryFillPrice)) * 100).toFixed(2)
    );

    // Helper to close position
    const closePosition = (reason: string, statusText: string) => {
      activePos!.status = "CLOSED";
      activePos!.remainingQty = 0;
      activePos!.closedAt = timeStr;
      activePos!.closedTs = nowTs;
      activePos!.closedSpotPrice = spotPrice;
      activePos!.closedOptionMid = exitFillPrice;
      activePos!.exitReason = reason;
      activePos!.pnlSpotPct = Number(spotMovePct.toFixed(2));
      activePos!.pnlOptionPct = pnlOptionPct;

      const optPnlStr = ` (${pnlOptionPct >= 0 ? "+" : ""}${pnlOptionPct}%)`;
      const msg = `🔴 STC · ${activePos!.contractLabel} [${reason}] @ $${spotPrice.toFixed(
        2
      )} · Spot ${spotMovePct >= 0 ? "+" : ""}${spotMovePct.toFixed(2)}%${optPnlStr}`;

      const alert: TradeLifecycleAlert = {
        id: `${activePos!.id}-stc-${nowTs}`,
        timestamp: timeStr,
        ts: nowTs,
        ticker: normalizedTicker,
        action: "SELL_TO_CLOSE",
        contractType: activePos!.contractType,
        contractLabel: activePos!.contractLabel,
        strike: activePos!.strike,
        expiration: activePos!.expiration,
        expHuman: activePos!.expHuman,
        robinhoodExp: activePos!.robinhoodExp,
        setupName: activePos!.setupName,
        reason,
        status: "CLOSED",
        spotPrice,
        btoSpotPrice: activePos!.btoSpotPrice,
        target1Spot: activePos!.target1Spot,
        target2Spot: activePos!.target2Spot,
        stopLossSpot: activePos!.stopLossSpot,
        optionMid: exitFillPrice,
        optionBid: liveBid,
        optionAsk: liveAsk,
        btoOptionMid: activePos!.btoOptionMid,
        contractsQty: activePos!.contractsQty,
        remainingQty: 0,
        totalOutlay: activePos!.totalOutlay,
        estTp1Mid: activePos!.estTp1Mid,
        estTp2Mid: activePos!.estTp2Mid,
        estStopMid: activePos!.estStopMid,
        tp1Pct: activePos!.tp1Pct,
        tp2Pct: activePos!.tp2Pct,
        pnlSpotPct: Number(spotMovePct.toFixed(2)),
        pnlOptionPct,
        rrRatio: activePos!.rrRatio,
        altContractNote: activePos!.altContractNote,
        message: msg,
      };

      emittedAlerts.push(alert);
      store.alerts.push(alert);
      store.closedPositions.unshift(activePos!);
      delete store.activePositions[normalizedTicker];
      activePos = null;
    };

    // Auto-Trailing Breakeven Protection: Only lock spot stop at Breakeven once spot has covered >= 75% of the distance to TP1
    const distToTp1 = Math.abs(activePos.target1Spot - activePos.btoSpotPrice);
    const currentProgressToTp1 = isCall
      ? spotPrice - activePos.btoSpotPrice
      : activePos.btoSpotPrice - spotPrice;
    if (
      activePos.status === "OPEN" &&
      pnlOptionPct >= 26 &&
      distToTp1 > 0 &&
      currentProgressToTp1 >= distToTp1 * 0.75
    ) {
      if (
        (isCall && activePos.stopLossSpot < activePos.btoSpotPrice) ||
        (!isCall && activePos.stopLossSpot > activePos.btoSpotPrice)
      ) {
        activePos.stopLossSpot = activePos.btoSpotPrice;
      }
    }

    // 1. STC (15:55 PM ET HARD CUTOFF / EOD THETA EXIT)
    if (isEodCutoff) {
      closePosition("15:55 PM ET HARD MARKET CLOSE CUTOFF", "MOC Close");
    }
    // 2. STC: 10:45 AM MORNING CHOP TIME STOP (Protect profits before midday theta crush)
    else if (
      activePos.status === "OPEN" &&
      (activePos.openedAt.includes("9:") || activePos.openedAt.includes("10:0") || activePos.openedAt.includes("10:1")) &&
      ((etTime.hours === 10 && etTime.minutes >= 45) || etTime.hours === 11) &&
      pnlOptionPct < 25 &&
      ((isCall && latest5mCandle && latest5mCandle.close < latest5mCandle.sma34) ||
        (!isCall && latest5mCandle && latest5mCandle.close > latest5mCandle.sma34))
    ) {
      closePosition("10:45 AM MOMENTUM CUTOFF (PROTECT PROFITS / AVOID MIDDAY CHOP)", "Chop Time Stop");
    }
    // 3. STC (TARGET 2 HIT · FULL PROFIT EXIT)
    else if (
      (isCall && spotPrice >= activePos.target2Spot) ||
      (!isCall && spotPrice <= activePos.target2Spot) ||
      pnlOptionPct >= (activePos.tp2Pct || 50)
    ) {
      const exitTitle =
        activePos.contractsQty === 2 && activePos.remainingQty === 1
          ? "TARGET 2 HIT · SELL FINAL 1 CONTRACT (FULL PROFIT)"
          : "TARGET 2 HIT · FULL PROFIT EXIT";
      closePosition(exitTitle, "Target 2 Full Profit");
    }
    // 4. STC (TARGET 1 HIT · SMART SCALING)
    else if (
      activePos.status === "OPEN" &&
      ((isCall && spotPrice >= activePos.target1Spot) ||
        (!isCall && spotPrice <= activePos.target1Spot) ||
        pnlOptionPct >= (activePos.tp1Pct || 25))
    ) {
      if (activePos.contractsQty === 2) {
        // When 2 contracts: Trim 1 of 2 contracts and move stop on runner to breakeven
        activePos.status = "PARTIAL_TP1";
        activePos.remainingQty = 1;
        activePos.stopLossSpot = activePos.btoSpotPrice;
        const msgStr = `💰 SELL TO CLOSE 1 OF 2 CONTRACTS · ${activePos.contractLabel} @ $${exitFillPrice.toFixed(
          2
        )} (+${pnlOptionPct}%) · 1 Runner Remaining with BE Stop ($${activePos.btoSpotPrice.toFixed(2)})`;

        const alert: TradeLifecycleAlert = {
          id: `${activePos.id}-tp1-${nowTs}`,
          timestamp: timeStr,
          ts: nowTs,
          ticker: normalizedTicker,
          action: "SELL_TO_CLOSE",
          contractType: activePos.contractType,
          contractLabel: activePos.contractLabel,
          strike: activePos.strike,
          expiration: activePos.expiration,
          expHuman: activePos.expHuman,
          robinhoodExp: activePos.robinhoodExp,
          setupName: activePos.setupName,
          reason: "TARGET 1 HIT · SELL 1 OF 2 CONTRACTS (LOCK PROFIT)",
          status: "PARTIAL_TP1",
          spotPrice,
          btoSpotPrice: activePos.btoSpotPrice,
          target1Spot: activePos.target1Spot,
          target2Spot: activePos.target2Spot,
          stopLossSpot: activePos.stopLossSpot,
          optionMid: exitFillPrice,
          optionBid: liveBid,
          optionAsk: liveAsk,
          btoOptionMid: activePos.btoOptionMid,
          contractsQty: activePos.contractsQty,
          remainingQty: 1,
          totalOutlay: activePos.totalOutlay,
          estTp1Mid: activePos.estTp1Mid,
          estTp2Mid: activePos.estTp2Mid,
          estStopMid: activePos.estStopMid,
          tp1Pct: activePos.tp1Pct,
          tp2Pct: activePos.tp2Pct,
          pnlSpotPct: Number(spotMovePct.toFixed(2)),
          pnlOptionPct,
          rrRatio: activePos.rrRatio,
          altContractNote: activePos.altContractNote,
          message: msgStr,
        };

        emittedAlerts.push(alert);
        store.alerts.push(alert);
      } else {
        // When 1 contract: In disciplined small-account trading, 1 contract takes 100% profit at Target 1!
        closePosition("TARGET 1 HIT · FULL PROFIT EXIT (1 CONTRACT)", "Target 1 Hit");
      }
    }
    // 5. STC (STOP LOSS / LEVEL INVALIDATION / OPTION HARD STOP HIT)
    else if (
      (isCall && spotPrice <= activePos.stopLossSpot) ||
      (!isCall && spotPrice >= activePos.stopLossSpot) ||
      (activePos.status === "OPEN" && activePos.estStopMid != null && currentOptionMid <= activePos.estStopMid && pnlOptionPct <= -20) ||
      (pnlOptionPct <= -25)
    ) {
      const isBreakeven =
        activePos.status === "PARTIAL_TP1" ||
        Math.abs(activePos.stopLossSpot - activePos.btoSpotPrice) < 0.02;
      const isOptionHardStop = !isBreakeven && pnlOptionPct <= -22;
      const reason = isBreakeven
        ? "BREAKEVEN STOP HIT"
        : isOptionHardStop
          ? "OPTION HARD STOP HIT (-25% MAX LOSS)"
          : "STOP LOSS / LEVEL INVALIDATION";
      closePosition(
        reason,
        isBreakeven ? "Breakeven Stop" : isOptionHardStop ? "Option Hard Stop" : "Stop Loss"
      );
    }
  }

  // --------------------------------------------------------------------------
  // STEP B: EVALUATE BTO ENTRY RULES (Only when NO active position exists)
  // --------------------------------------------------------------------------
  const positionTickerForCheck = normalizedTicker === "SPXW" || normalizedTicker === "SPX" ? "SPY" : normalizedTicker;
  const lastClosedForTicker = store.closedPositions.find((p) => p.ticker === positionTickerForCheck);
  const isInCooldown = Boolean(
    lastClosedForTicker?.closedTs &&
      nowTs - lastClosedForTicker.closedTs >= 0 &&
      nowTs - lastClosedForTicker.closedTs < 25 * 60
  );

  if (!activePos && !hadActivePositionAtStart && !isEodCutoff && !isInCooldown) {
    const {
      callWall,
      putWall,
      zeroGamma,
      dailyExpectedMove,
      kingNode,
      filteredKing,
      bookCenter,
      conviction = 70,
    } = params;

    let candidateBto: {
      contractType: ContractType;
      setupName: string;
      stopLossSpot: number;
      target1Spot: number;
      target2Spot: number;
    } | null = null;

    // Invariant: Tactical intraday trading operates on 0DTE/Next-Exp walls.
    // Outlier all-expiration LEAPS walls (e.g. $800 on SPY $764, > 2.5% away) are sanitized
    // to the tactical 0DTE wall or near-spot structural levels so triggers fire on actionable intraday tests.
    const baseTacticalCw =
      params.zeroDteCallWall && params.zeroDteCallWall > 0
        ? params.zeroDteCallWall
        : callWall > 0 && Math.abs(callWall - spotPrice) / spotPrice <= 0.025
          ? callWall
          : dailyExpectedMove?.high && dailyExpectedMove.high > spotPrice
            ? dailyExpectedMove.high
            : Number((spotPrice * 1.008).toFixed(2));
    const tacticalCw =
      filteredKing &&
      filteredKing > baseTacticalCw &&
      (filteredKing - spotPrice) / spotPrice <= 0.015
        ? filteredKing
        : baseTacticalCw;

    const rawTacticalPw =
      params.zeroDtePutWall && params.zeroDtePutWall > 0
        ? params.zeroDtePutWall
        : putWall > 0 && Math.abs(spotPrice - putWall) / spotPrice <= 0.025
          ? putWall
          : dailyExpectedMove?.low && dailyExpectedMove.low < spotPrice
            ? dailyExpectedMove.low
            : Number((spotPrice * 0.992).toFixed(2));

    // Anti-Distant-King Put Trap Sanitizer:
    // If rawTacticalPw is a distant multi-day Put Wall / All-Exp King (> 0.95% below spot, e.g. $755 when SPY is $766),
    // anchor intraday tactical support to dailyExpectedMove.low or -0.65% so we never chase deep OTM puts!
    const tacticalPw =
      rawTacticalPw > 0 && (spotPrice - rawTacticalPw) / spotPrice > 0.0095
        ? dailyExpectedMove?.low &&
          dailyExpectedMove.low < spotPrice &&
          (spotPrice - dailyExpectedMove.low) / spotPrice <= 0.01
          ? Math.round(dailyExpectedMove.low)
          : Number((spotPrice * 0.9935).toFixed(2))
        : rawTacticalPw;

    // --- SETUP 1: BTO CALLS — Support Bounce / Bullish Reversal ---
    const putBounceRef =
      dailyExpectedMove?.low &&
      dailyExpectedMove.low > 0 &&
      dailyExpectedMove.low > tacticalPw &&
      Math.abs(spotPrice - dailyExpectedMove.low) / spotPrice <= 0.015
        ? Math.round(dailyExpectedMove.low)
        : tacticalPw > 0
          ? tacticalPw
          : Number((spotPrice * 0.992).toFixed(2));

    const isTestingPutBounce =
      putBounceRef > 0 &&
      spotPrice >= putBounceRef * 0.998 &&
      spotPrice <= putBounceRef * 1.0025 &&
      (!latest5mCandle || latest5mCandle.low <= putBounceRef * 1.0012);

    const isBullConfirmation =
      divergence5m === "BULL" ||
      divergence30m === "BULL" ||
      Boolean(
        latest5mCandle &&
          latest5mCandle.close > latest5mCandle.open &&
          (latest5mCandle.close >= latest5mCandle.sma34 ||
            latest5mCandle.close >= putBounceRef * 1.0008)
      );

    if (isTestingPutBounce && isBullConfirmation) {
      const target2 =
        filteredKing && filteredKing > spotPrice + 1.5 && (filteredKing - spotPrice) / spotPrice <= 0.015
          ? filteredKing
          : tacticalCw > spotPrice + 1.5
            ? tacticalCw
            : dailyExpectedMove?.high && dailyExpectedMove.high > spotPrice
              ? Math.round(dailyExpectedMove.high)
              : Number((spotPrice * 1.008).toFixed(2));

      // Stop loss sits strictly below the support wall (never above putBounceRef)
      const structuralFloor = Math.min(putBounceRef, latest5mCandle?.low ?? putBounceRef);
      const rawStop = Number((structuralFloor - spotPrice * 0.0006).toFixed(2));
      const maxAllowedRisk = Math.max(0.5, (target2 - spotPrice) * 0.39);
      const stopLoss = Number(Math.min(putBounceRef - 0.15, Math.max(rawStop, spotPrice - maxAllowedRisk)).toFixed(2));
      const risk = Math.max(0.25, spotPrice - stopLoss);
      const totalReward2 = Math.max(1.5, target2 - spotPrice);

      const minTarget1 = spotPrice + risk * 1.44;
      const candidates = [zeroGamma, bookCenter, filteredKing].filter(
        (v): v is number => typeof v === "number" && v >= minTarget1 && v < target2
      );
      const target1 =
        candidates.length > 0
          ? Math.min(...candidates)
          : Number(Math.min(target2 - 0.15, Math.max(minTarget1, spotPrice + totalReward2 * 0.56)).toFixed(2));

      if (target1 > spotPrice && target2 >= target1 && (target1 - spotPrice) / risk >= 1.4) {
        candidateBto = {
          contractType: "CALL",
          setupName: "Support Bounce / Bullish Reversal",
          stopLossSpot: stopLoss,
          target1Spot: Number(target1.toFixed(2)),
          target2Spot: Number(target2.toFixed(2)),
        };
      }
    }

    // --- SETUP 2: BTO PUTS — Resistance Rejection / Bearish Reversal ---
    if (!candidateBto) {
      const baseCallRejectRef =
        dailyExpectedMove?.high &&
        dailyExpectedMove.high > 0 &&
        dailyExpectedMove.high < tacticalCw &&
        Math.abs(dailyExpectedMove.high - spotPrice) / spotPrice <= 0.015
          ? Math.round(dailyExpectedMove.high)
          : tacticalCw > 0
            ? tacticalCw
            : Number((spotPrice * 1.008).toFixed(2));
      // If Tactical 0DTE/1DTE King sits above baseCallRejectRef within the upper range (e.g. $767 King vs $766 EM),
      // anchor resistance rejection to the Tactical King so we never short midday chop below the upper magnet!
      const callRejectRef =
        filteredKing &&
        filteredKing >= baseCallRejectRef &&
        (filteredKing - spotPrice) / spotPrice <= 0.012
          ? filteredKing
          : baseCallRejectRef;

      const isTestingCallReject =
        callRejectRef > 0 &&
        spotPrice <= callRejectRef * 1.002 &&
        spotPrice >= callRejectRef * 0.9987 &&
        (!latest5mCandle || latest5mCandle.high >= callRejectRef * 0.9992);

      // Anti-Pinning Trap Guardrail:
      // If the Tactical 0DTE/Next-Exp King sits at callRejectRef (e.g. $767 King with 49.8% gamma share)
      // and price is holding ABOVE the 5m SMA34, price is in a Bullish Pinning Regime —
      // NEVER short HOD into an active upward King pin unless 5m candle closes strictly below SMA34!
      const isTacticalKingPinningOverhead =
        Boolean(filteredKing && Math.abs(filteredKing - callRejectRef) / spotPrice <= 0.003);

      const isConfirmedBelowSmaWhenPinned =
        !isTacticalKingPinningOverhead ||
        !latest5mCandle ||
        latest5mCandle.close <= latest5mCandle.sma34;

      const isBearConfirmation =
        isConfirmedBelowSmaWhenPinned &&
        (divergence5m === "BEAR" ||
          divergence30m === "BEAR" ||
          Boolean(
            latest5mCandle &&
              latest5mCandle.close < latest5mCandle.open &&
              latest5mCandle.close <= latest5mCandle.sma34
          ));

      if (isTestingCallReject && isBearConfirmation) {
        const target2 =
          tacticalPw < spotPrice && tacticalPw > 0
            ? (dailyExpectedMove?.low && dailyExpectedMove.low > tacticalPw && dailyExpectedMove.low < spotPrice
                ? Math.round(dailyExpectedMove.low)
                : tacticalPw)
            : dailyExpectedMove?.low && dailyExpectedMove.low < spotPrice
              ? Math.round(dailyExpectedMove.low)
              : Number((spotPrice * 0.993).toFixed(2));

        // Stop loss must sit strictly above the resistance wall & rejection candle high (never below callRejectRef)
        const structuralCeiling = Math.max(callRejectRef, latest5mCandle?.high ?? callRejectRef);
        const stopLoss = Number((structuralCeiling * 1.0012).toFixed(2));
        const risk = Math.max(0.25, stopLoss - spotPrice);
        const totalReward2 = Math.max(1.5, spotPrice - target2);

        const maxTarget1 = spotPrice - risk * 1.45;
        // Invariant: Targets for a PUT must strictly be LOWER than spot/entry (v <= maxTarget1) and ABOVE target2 (v > target2)
        const candidates = [zeroGamma, bookCenter, filteredKing, latest5mCandle?.sma34].filter(
          (v): v is number => typeof v === "number" && v <= maxTarget1 && v > target2
        );
        const target1 =
          candidates.length > 0
            ? Math.max(...candidates)
            : Number(Math.max(target2 + 0.15, Math.min(maxTarget1, spotPrice - totalReward2 * 0.55)).toFixed(2));

        if (target1 < spotPrice && target2 <= target1 && (spotPrice - target1) / risk >= 1.4) {
          candidateBto = {
            contractType: "PUT",
            setupName: "Resistance Rejection / Bearish Reversal",
            stopLossSpot: stopLoss,
            target1Spot: Number(target1.toFixed(2)),
            target2Spot: Number(target2.toFixed(2)),
          };
        }
      }
    }

    // --- SETUP 3: BTO CALLS or PUTS — Zero-Gamma Volatility Breakout ---
    if (!candidateBto && zeroGamma > 0) {
      // Bullish Zero-Gamma Breakout (Crosses Above zeroGamma)
      if (
        prevSpotPrice <= zeroGamma &&
        spotPrice > zeroGamma &&
        latest5mCandle &&
        latest5mCandle.close > latest5mCandle.sma34 &&
        callWall > spotPrice &&
        (callWall - spotPrice) / spotPrice >= 0.0025
      ) {
        const stopLoss = Number((zeroGamma * (1 - 0.0012)).toFixed(2));
        const target1 =
          filteredKing && filteredKing > spotPrice
            ? filteredKing
            : dailyExpectedMove?.high && dailyExpectedMove.high > spotPrice
              ? Number((spotPrice + 0.5 * (dailyExpectedMove.high - spotPrice)).toFixed(2))
              : Number((spotPrice + 0.5 * (callWall - spotPrice)).toFixed(2));

        candidateBto = {
          contractType: "CALL",
          setupName: "Zero-Gamma Bullish Volatility Breakout",
          stopLossSpot: stopLoss,
          target1Spot: Number(target1.toFixed(2)),
          target2Spot: callWall,
        };
      }
      // Bearish Zero-Gamma Flush (Crosses Below zeroGamma)
      else if (
        prevSpotPrice >= zeroGamma &&
        spotPrice < zeroGamma &&
        latest5mCandle &&
        latest5mCandle.close < latest5mCandle.sma34 &&
        tacticalPw < spotPrice &&
        tacticalPw > 0 &&
        (spotPrice - tacticalPw) / spotPrice >= 0.0025
      ) {
        const stopLoss = Number((zeroGamma * (1 + 0.0012)).toFixed(2));
        const target1 =
          filteredKing && filteredKing < spotPrice && filteredKing > tacticalPw
            ? filteredKing
            : dailyExpectedMove?.low && dailyExpectedMove.low < spotPrice
              ? Number((spotPrice - 0.5 * (spotPrice - dailyExpectedMove.low)).toFixed(2))
              : Number((spotPrice - 0.5 * (spotPrice - tacticalPw)).toFixed(2));

        candidateBto = {
          contractType: "PUT",
          setupName: "Zero-Gamma Bearish Flush Breakout",
          stopLossSpot: stopLoss,
          target1Spot: Number(target1.toFixed(2)),
          target2Spot: tacticalPw,
        };
      }
    }

    // --- SETUP 4: BTO CALLS or PUTS — Tactical 0DTE/1DTE or Uncontested King Magnet Pull ---
    // Prioritize the Tactical (0DTE / Next-Exp) King (e.g. $767 with 49.8% concentration) over a weak,
    // dispersed All-Exp King (e.g. $755 with 8.5% concentration > 1.5x Daily EM away).
    const tacticalKingStrike =
      filteredKing && filteredKing > 0
        ? filteredKing
        : (kingNode as any)?.zeroDteKing && (kingNode as any).zeroDteKing > 0
          ? (kingNode as any).zeroDteKing
          : 0;
    const allExpKingStrike = kingNode?.strike ?? kingNode?.allExpKing ?? 0;
    const activeKingMagnet =
      tacticalKingStrike > 0 &&
      Math.abs(tacticalKingStrike - spotPrice) / spotPrice >= 0.0022 &&
      Math.abs(tacticalKingStrike - spotPrice) / spotPrice <= 0.012
        ? tacticalKingStrike
        : allExpKingStrike;

    if (!candidateBto && activeKingMagnet > 0) {
      const isTacticalMagnet = activeKingMagnet === tacticalKingStrike;
      const kingStrength = kingNode?.kingStrength ?? 55;
      const isContested = Boolean(kingNode?.isContested);
      const distPct = Math.abs(activeKingMagnet - spotPrice) / spotPrice;

      // Tactical 0DTE/1DTE King Magnet triggers on 5m SMA34 trend confirmation even if multi-week All-Exp is contested
      const qualifiesMagnet =
        distPct >= 0.0022 &&
        distPct <= 0.011 &&
        (isTacticalMagnet || (kingStrength >= 60 && !isContested));

      if (qualifiesMagnet) {
        // Bullish King Magnet: activeKingMagnet > spotPrice (e.g. SPY $763.60 -> Tactical King $767)
        if (
          activeKingMagnet > spotPrice &&
          latest5mCandle &&
          latest5mCandle.close > latest5mCandle.sma34 &&
          latest5mCandle.close > latest5mCandle.open
        ) {
          const stopBase = Math.min(latest5mCandle.sma34, latest5mCandle.low);
          const stopLoss = Number((stopBase * (1 - 0.001)).toFixed(2));
          const target1 = Number(((spotPrice + activeKingMagnet) / 2).toFixed(2));
          candidateBto = {
            contractType: "CALL",
            setupName: isTacticalMagnet
              ? `Tactical King Magnet Pull ($${activeKingMagnet})`
              : "Uncontested King Magnet Pull",
            stopLossSpot: stopLoss,
            target1Spot: target1,
            target2Spot: activeKingMagnet,
          };
        }
        // Bearish King Magnet: activeKingMagnet < spotPrice
        // Anti-Trap Guardrail: Only allow Bearish King Magnet if activeKingMagnet is within 0.85% of spot
        // AND Tactical King is NOT sitting at/above spot!
        else if (
          activeKingMagnet < spotPrice &&
          distPct <= 0.0085 &&
          (!tacticalKingStrike || tacticalKingStrike < spotPrice) &&
          latest5mCandle &&
          latest5mCandle.close < latest5mCandle.sma34 &&
          latest5mCandle.close < latest5mCandle.open
        ) {
          const stopBase = Math.max(latest5mCandle.sma34, latest5mCandle.high);
          const stopLoss = Number((stopBase * (1 + 0.001)).toFixed(2));
          const target1 = Number(((spotPrice + activeKingMagnet) / 2).toFixed(2));
          candidateBto = {
            contractType: "PUT",
            setupName: isTacticalMagnet
              ? `Tactical King Magnet Pull ($${activeKingMagnet})`
              : "Uncontested King Magnet Pull",
            stopLossSpot: stopLoss,
            target1Spot: target1,
            target2Spot: activeKingMagnet,
          };
        }
      }
    }

    // --- GATE: Minimum R:R Ratio Check >= 1.4 ---
    if (candidateBto) {
      const risk = Math.abs(spotPrice - candidateBto.stopLossSpot);
      const reward1 = Math.abs(candidateBto.target1Spot - spotPrice);
      const rrRatio = risk > 0 ? Number((reward1 / risk).toFixed(2)) : 0;

      if (rrRatio >= 1.4) {
        // Select optimal Sub-$1.00 contract with position sizing
        const optimalContract = await selectSmallAccountContract({
          ticker: normalizedTicker,
          contractType: candidateBto.contractType,
          spotPrice,
          target1Spot: candidateBto.target1Spot,
          target2Spot: candidateBto.target2Spot,
          stopLossSpot: candidateBto.stopLossSpot,
          contracts: params.contracts,
          conviction,
          nowEt: now,
          zeroDteCallWall: params.zeroDteCallWall || tacticalCw,
          zeroDtePutWall: params.zeroDtePutWall || tacticalPw,
        });

        if (!optimalContract) {
          // No qualifying liquid contract under $1.00 found
          return {
            ticker: normalizedTicker,
            activePosition: null,
            emittedAlerts,
            allAlerts: store.alerts,
          };
        }

        const isSpxw = normalizedTicker === "SPXW" || normalizedTicker === "SPX";
        const positionTicker = isSpxw ? "SPY" : normalizedTicker;
        const positionSpot = isSpxw ? Number((spotPrice / 10).toFixed(2)) : spotPrice;
        const positionTarget1 = isSpxw ? Number((candidateBto.target1Spot / 10).toFixed(2)) : candidateBto.target1Spot;
        const positionTarget2 = isSpxw ? Number((candidateBto.target2Spot / 10).toFixed(2)) : candidateBto.target2Spot;
        const positionStopLoss = isSpxw ? Number((candidateBto.stopLossSpot / 10).toFixed(2)) : candidateBto.stopLossSpot;

        const positionId = `${positionTicker}-${candidateBto.contractType}-${nowTs}`;
        const newPosition: OptionTradePosition = {
          id: positionId,
          ticker: positionTicker,
          contractType: candidateBto.contractType,
          contractLabel: optimalContract.contractLabel,
          strike: optimalContract.strike,
          expiration: optimalContract.expiration,
          expHuman: optimalContract.expHuman,
          robinhoodExp: optimalContract.robinhoodExp,
          robinhoodTab: optimalContract.robinhoodTab,
          setupName: candidateBto.setupName,
          status: "OPEN",
          btoSpotPrice: positionSpot,
          btoOptionMid: optimalContract.optionMid,
          optionBid: optimalContract.optionBid,
          optionAsk: optimalContract.optionAsk,
          contractsQty: optimalContract.contractsQty,
          remainingQty: optimalContract.contractsQty,
          totalOutlay: optimalContract.totalOutlay,
          estTp1Mid: optimalContract.estTp1Mid,
          estTp2Mid: optimalContract.estTp2Mid,
          estStopMid: optimalContract.estStopMid,
          tp1Pct: optimalContract.tp1Pct,
          tp2Pct: optimalContract.tp2Pct,
          target1Spot: positionTarget1,
          target2Spot: positionTarget2,
          stopLossSpot: positionStopLoss,
          openedAt: timeStr,
          openedTs: nowTs,
          rrRatio,
          altContractNote: optimalContract.altContractNote,
        };

        const emoji = candidateBto.contractType === "CALL" ? "🟢" : "🟣";
        const msg = `${emoji} BUY TO OPEN (${optimalContract.contractsQty}x @ $${optimalContract.optionMid.toFixed(
          2
        )}) · ${optimalContract.contractLabel} @ $${spotPrice.toFixed(2)} [${
          candidateBto.setupName
        }] · SL: $${candidateBto.stopLossSpot.toFixed(2)}, TP1: $${candidateBto.target1Spot.toFixed(
          2
        )}, TP2: $${candidateBto.target2Spot.toFixed(2)} (R:R ${rrRatio}:1 · $${optimalContract.totalOutlay} Outlay)`;

        const alert: TradeLifecycleAlert = {
          id: `${positionId}-bto`,
          timestamp: timeStr,
          ts: nowTs,
          ticker: normalizedTicker,
          action: "BUY_TO_OPEN",
          contractType: candidateBto.contractType,
          contractLabel: optimalContract.contractLabel,
          strike: optimalContract.strike,
          expiration: optimalContract.expiration,
          expHuman: optimalContract.expHuman,
          robinhoodExp: optimalContract.robinhoodExp,
          robinhoodTab: optimalContract.robinhoodTab,
          setupName: candidateBto.setupName,
          reason: candidateBto.setupName,
          status: "OPEN",
          spotPrice,
          btoSpotPrice: spotPrice,
          target1Spot: candidateBto.target1Spot,
          target2Spot: candidateBto.target2Spot,
          stopLossSpot: candidateBto.stopLossSpot,
          optionMid: optimalContract.optionMid,
          optionBid: optimalContract.optionBid,
          optionAsk: optimalContract.optionAsk,
          btoOptionMid: optimalContract.optionMid,
          contractsQty: optimalContract.contractsQty,
          remainingQty: optimalContract.contractsQty,
          totalOutlay: optimalContract.totalOutlay,
          estTp1Mid: optimalContract.estTp1Mid,
          estTp2Mid: optimalContract.estTp2Mid,
          estStopMid: optimalContract.estStopMid,
          tp1Pct: optimalContract.tp1Pct,
          tp2Pct: optimalContract.tp2Pct,
          rrRatio,
          altContractNote: optimalContract.altContractNote,
          message: msg,
        };

        store.activePositions[normalizedTicker] = newPosition;
        store.alerts.push(alert);
        emittedAlerts.push(alert);
        activePos = newPosition;
      }
    }
  }

  // Save updated store to persistent cache
  saveTradeStore(store);

  // If Discord webhook is provided or configured, dispatch alerts asynchronously
  if (emittedAlerts.length > 0) {
    for (const alert of emittedAlerts) {
      sendDiscordTradeAlert(alert, params.webhookUrl).catch(() => {});
    }
  }

  return {
    ticker: normalizedTicker,
    activePosition: activePos,
    emittedAlerts,
    allAlerts: store.alerts.slice(-50),
  };
}

/**
 * Evaluates all currently active positions across all tickers (SPY, QQQ, SPXW, IWM)
 * against live CBOE data. Ensures that positions on tickers not currently selected
 * in the active dashboard UI are continuously guarded and exited on Target, Stop Loss,
 * or Option Hard Stop.
 */
export async function evaluateAllActivePositions(params?: {
  webhookUrl?: string;
}): Promise<TradeLifecycleAlert[]> {
  const store = loadTradeStore();
  const activeKeys = Object.keys(store.activePositions);
  if (activeKeys.length === 0) return [];

  const allEmitted: TradeLifecycleAlert[] = [];

  for (const ticker of activeKeys) {
    const pos = store.activePositions[ticker];
    if (!pos || (pos.status !== "OPEN" && pos.status !== "PARTIAL_TP1")) continue;

    try {
      // 1. Fetch live CBOE options chain for this ticker
      const contracts = await fetchLiveCboeOptions(ticker);

      // 2. Determine spot price
      let spot = getCachedSpotPrice(ticker);
      if (!spot || spot <= 0) {
        if (ticker === "SPX" || ticker === "SPXW") {
          spot = getCachedSpotPrice("_SPX") || pos.btoSpotPrice;
        } else {
          spot = pos.btoSpotPrice;
        }
      }

      // 3. Evaluate exit rules
      const res = await evaluateTradeSignals({
        ticker,
        spotPrice: spot,
        callWall: 0,
        putWall: 0,
        zeroGamma: 0,
        contracts,
        webhookUrl: params?.webhookUrl,
      });

      if (res.emittedAlerts.length > 0) {
        allEmitted.push(...res.emittedAlerts);
      }
    } catch (err) {
      console.error(`[TradeSignalEngine] Failed to evaluate active position for ${ticker}:`, err);
    }
  }

  // Check if after-market-close daily performance recap should be dispatched
  try {
    const { checkAndSendMarketCloseRecap } = await import("./tradePerformanceEngine");
    await checkAndSendMarketCloseRecap({ webhookUrl: params?.webhookUrl });
  } catch {
    // Non-fatal
  }

  return allEmitted;
}

export * from "./tradePerformanceEngine";
