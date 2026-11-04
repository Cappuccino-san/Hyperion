import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

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

const TICK_CACHE = new Map<string, { data: LiveTickResponse; ts: number }>();
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

async function fetchCnbcTick(ticker: string): Promise<LiveTickResponse> {
  const cnbcSym = CNBC_SYMBOL_MAP[ticker] || ticker;
  const url = `https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=${encodeURIComponent(
    cnbcSym
  )}&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json`;

  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
    cache: "no-store",
    signal: AbortSignal.timeout(1100),
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
}

async function fetchRobinhoodTick(ticker: string): Promise<LiveTickResponse> {
  if (["SPX", "NDX", "VIX", "RUT", "DJI"].includes(ticker)) {
    throw new Error("Index not on Robinhood quote endpoint");
  }
  const url = `https://api.robinhood.com/quotes/?symbols=${encodeURIComponent(ticker)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
    cache: "no-store",
    signal: AbortSignal.timeout(1100),
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
}

async function fetchYahooTick(ticker: string): Promise<LiveTickResponse> {
  const yahooSym = YAHOO_SYMBOL_MAP[ticker] || ticker;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    yahooSym
  )}?interval=1m&range=1d`;

  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
    cache: "no-store",
    signal: AbortSignal.timeout(1200),
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
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const ticker = (searchParams.get("ticker") || "SPY").trim().toUpperCase();

  try {
    const clean = ticker.trim().toUpperCase();
    const now = Date.now();
    const cached = TICK_CACHE.get(clean);
    if (cached && now - cached.ts < TICK_CACHE_TTL_MS) {
      return NextResponse.json(cached.data, {
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        },
      });
    }

    const winner = await Promise.any([
      fetchCnbcTick(clean),
      fetchRobinhoodTick(clean),
      fetchYahooTick(clean),
    ]);

    TICK_CACHE.set(clean, { data: winner, ts: now });
    return NextResponse.json(winner, {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      },
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: "Tick fetch failed",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
}
