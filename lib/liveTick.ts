import { BoundedMap } from "@/lib/marketCache";

export interface LiveTickResponse {
  ticker: string;
  spot: number;
  prevClose: number;
  change: number;
  changePct: number;
  dayHigh: number;
  dayLow: number;
  volume: number;
  timestamp: number;
  source: "cnbc" | "robinhood" | "yahoo";
  isLive: true;
}

const TICK_CACHE = new BoundedMap<string, { data: LiveTickResponse; ts: number }>(128);
const TICK_CACHE_TTL_MS = 400; // 400ms micro-coalescing

const YAHOO_SYMBOL_MAP: Record<string, string> = {
  SPX: "^GSPC",
  NDX: "^NDX",
  VIX: "^VIX",
  RUT: "^RUT",
  DJI: "^DJI",
};

const CNBC_SYMBOL_MAP: Record<string, string> = {
  SPX: ".SPX",
  NDX: ".NDX",
  VIX: ".VIX",
  RUT: ".RUT",
  DJI: ".DJI",
};

function linkSignal(external?: AbortSignal, timeoutMs = 1100): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Tick timeout")), timeoutMs);
  const onAbort = () => controller.abort(external?.reason);
  if (external) {
    if (external.aborted) {
      clearTimeout(timer);
      controller.abort(external.reason);
    } else {
      external.addEventListener("abort", onAbort, { once: true });
    }
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      external?.removeEventListener("abort", onAbort);
    },
  };
}

export async function fetchCnbcTick(ticker: string, signal?: AbortSignal): Promise<LiveTickResponse> {
  const cnbcSym = CNBC_SYMBOL_MAP[ticker] || ticker;
  const url = `https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=${encodeURIComponent(
    cnbcSym
  )}&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json`;

  const linked = linkSignal(signal, 1100);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      cache: "no-store",
      signal: linked.signal,
    });
    if (!res.ok) throw new Error(`CNBC HTTP ${res.status}`);
    const json = await res.json();
    const q = json?.FormattedQuoteResult?.FormattedQuote?.[0];
    if (!q) throw new Error("Empty CNBC quote");

    const parseNum = (v: unknown): number => {
      if (typeof v === "number") return v;
      if (typeof v === "string") return parseFloat(v.replace(/,/g, ""));
      return NaN;
    };

    const spot = parseNum(q.last);
    if (!Number.isFinite(spot) || spot <= 0) throw new Error("Invalid CNBC spot");

    const prevClose = parseNum(q.previous_day_closing) || spot;
    const dayHigh = parseNum(q.high) || spot;
    const dayLow = parseNum(q.low) || spot;
    const volume = parseNum(q.volume) || 0;
    const change = spot - prevClose;
    const changePct = prevClose > 0 ? (change / prevClose) * 100 : 0;

    return {
      ticker,
      spot: Number(spot.toFixed(2)),
      prevClose: Number(prevClose.toFixed(2)),
      change: Number(change.toFixed(2)),
      changePct: Number(changePct.toFixed(2)),
      dayHigh: Number(dayHigh.toFixed(2)),
      dayLow: Number(dayLow.toFixed(2)),
      volume,
      timestamp: Date.now(),
      source: "cnbc",
      isLive: true,
    };
  } finally {
    linked.cleanup();
  }
}

export async function fetchRobinhoodTick(ticker: string, signal?: AbortSignal): Promise<LiveTickResponse> {
  if (["SPX", "NDX", "VIX", "RUT", "DJI"].includes(ticker)) {
    throw new Error("Index not on Robinhood quote endpoint");
  }
  const url = `https://api.robinhood.com/quotes/?symbols=${encodeURIComponent(ticker)}`;
  const linked = linkSignal(signal, 1100);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      cache: "no-store",
      signal: linked.signal,
    });
    if (!res.ok) throw new Error(`RH HTTP ${res.status}`);
    const json = await res.json();
    const q = json?.results?.[0];
    if (!q) throw new Error("Empty RH quote");

    const regPrice = parseFloat(q.last_trade_price);
    const extPrice = parseFloat(q.last_extended_hours_trade_price);
    const bid = parseFloat(q.bid_price);
    const ask = parseFloat(q.ask_price);
    const mid =
      Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0
        ? (bid + ask) / 2
        : NaN;

    let spot = Number.isFinite(regPrice) && regPrice > 0 ? regPrice : extPrice;
    if (Number.isFinite(mid) && Math.abs(mid - spot) / spot < 0.002) {
      spot = mid;
    }
    if (!Number.isFinite(spot) || spot <= 0) throw new Error("Invalid RH spot");

    const prevClose = parseFloat(q.previous_close) || spot;
    const change = spot - prevClose;
    const changePct = prevClose > 0 ? (change / prevClose) * 100 : 0;

    return {
      ticker,
      spot: Number(spot.toFixed(2)),
      prevClose: Number(prevClose.toFixed(2)),
      change: Number(change.toFixed(2)),
      changePct: Number(changePct.toFixed(2)),
      dayHigh: Number(spot.toFixed(2)),
      dayLow: Number(spot.toFixed(2)),
      volume: 0,
      timestamp: Date.now(),
      source: "robinhood",
      isLive: true,
    };
  } finally {
    linked.cleanup();
  }
}

export async function fetchYahooTick(ticker: string, signal?: AbortSignal): Promise<LiveTickResponse> {
  const yahooSym = YAHOO_SYMBOL_MAP[ticker] || ticker;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    yahooSym
  )}?interval=1m&range=1d`;

  const linked = linkSignal(signal, 1200);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      cache: "no-store",
      signal: linked.signal,
    });
    if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
    const json = await res.json();
    const result = json?.chart?.result?.[0];
    const meta = result?.meta;
    if (!meta) throw new Error("No Yahoo meta");

    const quote = result?.indicators?.quote?.[0];
    const closes: number[] = (quote?.close ?? []).filter(
      (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)
    );
    const lastClose = closes.length > 0 ? closes[closes.length - 1] : NaN;

    const spot =
      Number.isFinite(meta.regularMarketPrice) && meta.regularMarketPrice > 0
        ? meta.regularMarketPrice
        : lastClose;

    if (!Number.isFinite(spot) || spot <= 0) throw new Error("Invalid Yahoo spot");

    const prevClose = meta.chartPreviousClose || meta.previousClose || spot;
    const dayHigh = meta.regularMarketDayHigh || spot;
    const dayLow = meta.regularMarketDayLow || spot;
    const volume = meta.regularMarketVolume || 0;
    const change = spot - prevClose;
    const changePct = prevClose > 0 ? (change / prevClose) * 100 : 0;

    return {
      ticker,
      spot: Number(spot.toFixed(2)),
      prevClose: Number(prevClose.toFixed(2)),
      change: Number(change.toFixed(2)),
      changePct: Number(changePct.toFixed(2)),
      dayHigh: Number(dayHigh.toFixed(2)),
      dayLow: Number(dayLow.toFixed(2)),
      volume,
      timestamp: Date.now(),
      source: "yahoo",
      isLive: true,
    };
  } finally {
    linked.cleanup();
  }
}

/**
 * Fetches sub-second live underlying spot from the /api/tick multi-source race
 * (CNBC, Robinhood, Yahoo) with 400ms coalescing cache.
 */
export async function fetchLiveTickQuote(
  rawTicker: string,
  signal?: AbortSignal
): Promise<LiveTickResponse | null> {
  const clean = rawTicker.trim().toUpperCase();
  if (!clean || signal?.aborted) return null;

  const now = Date.now();
  const cached = TICK_CACHE.get(clean);
  if (cached && now - cached.ts < TICK_CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const winner = await Promise.any([
      fetchCnbcTick(clean, signal),
      fetchRobinhoodTick(clean, signal),
      fetchYahooTick(clean, signal),
    ]);
    TICK_CACHE.set(clean, { data: winner, ts: Date.now() });
    return winner;
  } catch {
    return null;
  }
}
