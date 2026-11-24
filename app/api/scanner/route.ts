import { NextResponse } from "next/server";
import { optionsMemoryCache, setBoundedMapEntry } from "@/lib/marketCache";
import { getTickerPreset } from "@/lib/tickerPresets";
import { getTodayEt } from "@/lib/gaiaSessionGuards";
import {
  computeOptionsAnalytics,
  globalContractsCache,
} from "@/lib/optionsExposure";
import {
  fetchLiveCboeOptions,
  getCachedSpotPrice,
  resolveContractsFromRawCacheEntry,
} from "@/lib/tradeSignalEngine";
import { fetchLiveTickQuote } from "@/lib/liveTick";

export const dynamic = "force-dynamic";

interface RawScannerRow {
  t: string;
  px: number;
  king: number;
  pts: number;
  pct: number;
  xem: number;
  neg: boolean;
  str: number;
  share: number;
  base: number;
  score: number;
  rr: number;
  book: string;
  contested: boolean;
  moved?: boolean;
  dataStatus: "LIVE" | "SYNCING";
  isLive: boolean;
}

const CORE_INDEX_TICKERS = ["SPY", "QQQ", "IWM", "SPXW"] as const;

const SCANNER_UNIVERSE = [
  "SPY", "QQQ", "IWM", "SPXW", "SPX", "NDX", "DIA",
  "NVDA", "AAPL", "MSFT", "META", "AMZN", "GOOGL", "TSLA", "AMD", "AVGO",
  "MU", "ARM", "SMCI", "MSTR", "PLTR", "COIN", "HOOD", "ORCL", "TSM",
  "LLY", "WMT", "BAC", "XLE", "GLD", "TLT", "IBIT", "SOFI", "GME", "BA", "BABA", "RBLX", "MARA", "RIVN",
];

const globalForScannerWarm = globalThis as unknown as {
  __hyperionScannerWarmInFlight?: Set<string>;
  __hyperionScannerLastWarmAt?: Map<string, number>;
};

const WARM_TTL_MS = 120_000;

async function warmSingleTickerCache(
  symbol: string,
  liveQuotes: Record<string, number>
): Promise<void> {
  const sym = symbol.toUpperCase();
  const existing = optionsMemoryCache.get(sym);
  if (existing && Date.now() - existing.timestamp < WARM_TTL_MS && existing.payload.strikes.length > 0) {
    return;
  }

  const inFlight =
    globalForScannerWarm.__hyperionScannerWarmInFlight ??
    (globalForScannerWarm.__hyperionScannerWarmInFlight = new Set<string>());
  if (inFlight.has(sym)) return;
  inFlight.add(sym);

  try {
    const mapped = sym === "SPXW" ? "SPX" : sym === "NDXP" ? "NDX" : sym;
    const [contracts, tick] = await Promise.all([
      fetchLiveCboeOptions(sym, AbortSignal.timeout(5500)),
      liveQuotes[sym]
        ? Promise.resolve(null)
        : fetchLiveTickQuote(mapped).catch(() => null),
    ]);
    if (!contracts || contracts.length === 0) return;

    const cboeRefSpot = getCachedSpotPrice(sym) ?? 0;
    const liveSpot =
      (tick && tick.spot > 0 ? tick.spot : 0) ||
      liveQuotes[sym] ||
      cboeRefSpot ||
      0;
    if (liveSpot <= 0) return;

    const prevClose =
      (tick && tick.prevClose > 0 ? tick.prevClose : 0) || liveSpot;
    const rawEntry = globalContractsCache.get(sym);
    const anchored = rawEntry
      ? resolveContractsFromRawCacheEntry(
          rawEntry,
          liveSpot,
          Date.now(),
          getTickerPreset(sym, liveSpot).impliedVolatility || 0.22
        )
      : contracts;

    const payload = computeOptionsAnalytics({
      ticker: sym,
      dataSource: "CBOE_MARKET_DATA",
      spotPrice: liveSpot,
      previousClose: prevClose,
      contracts: anchored,
    });
    optionsMemoryCache.set(sym, { timestamp: Date.now(), payload });
    const lastWarm =
      globalForScannerWarm.__hyperionScannerLastWarmAt ??
      (globalForScannerWarm.__hyperionScannerLastWarmAt = new Map<string, number>());
    lastWarm.set(sym, Date.now());
  } catch {
    // Non-fatal background warm failure
  } finally {
    inFlight.delete(sym);
  }
}

function triggerBackgroundWarmup(
  symbols: string[],
  liveQuotes: Record<string, number>
): void {
  const cold = symbols.filter((s) => {
    const entry = optionsMemoryCache.get(s.toUpperCase());
    return !entry || Date.now() - entry.timestamp >= WARM_TTL_MS || entry.payload.strikes.length === 0;
  });
  if (cold.length === 0) return;

  const CONCURRENCY = 3;
  let cursor = 0;
  const worker = async () => {
    while (cursor < cold.length) {
      const next = cold[cursor++];
      await warmSingleTickerCache(next, liveQuotes);
    }
  };
  for (let i = 0; i < Math.min(CONCURRENCY, cold.length); i++) {
    void worker();
  }
}

function buildLiveScannerRows(
  symbols: string[],
  liveQuotes: Record<string, number>
): RawScannerRow[] {
  const nowEt = new Date().toLocaleTimeString("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
  });

  return symbols
    .map((sym) => {
      const s = sym.toUpperCase();
      const cachedEntry = optionsMemoryCache.get(s);
      const cached =
        cachedEntry && cachedEntry.payload.strikes.length > 0
          ? cachedEntry.payload
          : undefined;
      const isLive = Boolean(cached);
      const preset = getTickerPreset(s, liveQuotes[s]);
      const px = cached?.spotPrice ?? liveQuotes[s] ?? preset.spotPrice;
      const king = cached?.kingNode?.allExpKing ?? preset.kingPreset.allExpKing;
      const pts = Number((king - px).toFixed(2));
      const pct = px > 0 ? Number(((pts / px) * 100).toFixed(2)) : 0;
      const dailyEm =
        cached?.expectedMoves?.daily?.em ??
        px * (preset.impliedVolatility || 0.25) * Math.sqrt(1 / 252);
      const xem = Number((Math.abs(pts) / Math.max(0.01, dailyEm)).toFixed(2));
      const neg = (cached?.netMetrics?.netGex ?? preset.netMetrics.netGex) < 0;
      const str = cached?.kingNode?.kingStrength ?? 0;
      const totalGamma = cached?.kingNode?.totalBoardGamma ?? 0;
      const kingVal = cached?.kingNode?.kingValue ?? 0;
      const share =
        isLive && totalGamma > 0
          ? Number(((kingVal / totalGamma) * 100).toFixed(1))
          : 0;
      const contested = cached?.kingNode?.isContested ?? false;

      const emAlignmentScore = Math.max(0, 35 - Math.abs(xem - 1.15) * 12);
      const base = isLive
        ? Math.round(Math.min(99, str * 0.65 + emAlignmentScore))
        : 0;
      const score = isLive
        ? Math.round(
            Math.max(
              0,
              Math.min(
                99,
                base * (contested ? 0.82 : 1.0) - (xem > 4 ? (xem - 4) * 5 : 0)
              )
            )
          )
        : 0;

      return {
        t: s,
        px,
        king,
        pts,
        pct,
        xem,
        neg,
        str,
        share,
        base,
        score,
        rr: Number((Math.abs(pts) / Math.max(1, dailyEm)).toFixed(4)),
        book: isLive ? (cached?.bookTimestamp ?? `${nowEt} ET`) : "SYNCING",
        contested,
        moved: false,
        dataStatus: (isLive ? "LIVE" : "SYNCING") as "LIVE" | "SYNCING",
        isLive,
      };
    })
    .sort((a, b) => {
      if (a.isLive !== b.isLive) return a.isLive ? -1 : 1;
      return b.score - a.score;
    });
}

export async function GET() {
  const startMs = Date.now();
  const todayEt = getTodayEt();
  const nowIso = new Date().toISOString();

  // 1. Pre-fetch live spot quotes for equities in a single fast batch
  const liveQuotes: Record<string, number> = {};
  try {
    const equitySymbols = SCANNER_UNIVERSE.filter(
      (s) => !["SPX", "SPXW", "NDX"].includes(s)
    ).join(",");
    const res = await fetch(`https://api.robinhood.com/quotes/?symbols=${equitySymbols}`, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) HyperionTerminal/1.0",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(2500),
    });
    if (res.ok) {
      const json = await res.json();
      for (const item of json?.results || []) {
        const s = String(item?.symbol || "").toUpperCase();
        const p = Number(item?.last_trade_price ?? item?.bid_price ?? 0);
        if (s && p > 0) liveQuotes[s] = Number(p.toFixed(2));
      }
    }
  } catch {
    // Non-fatal
  }

  // 2. Synchronously warm ONLY cold core index tickers (SPY, QQQ, IWM, SPXW) so request stays fast
  const coldCore = CORE_INDEX_TICKERS.filter((sym) => {
    const entry = optionsMemoryCache.get(sym);
    return !entry || Date.now() - entry.timestamp >= WARM_TTL_MS || entry.payload.strikes.length === 0;
  });
  if (coldCore.length > 0) {
    await Promise.allSettled(
      coldCore.map((sym) => warmSingleTickerCache(sym, liveQuotes))
    );
  }

  // 3. Non-blocking background warm-up for remaining cold tickers (unwarmed rows explicitly report SYNCING)
  const nonCoreUniverse = SCANNER_UNIVERSE.filter(
    (s) => !(CORE_INDEX_TICKERS as readonly string[]).includes(s)
  );
  triggerBackgroundWarmup(nonCoreUniverse, liveQuotes);

  const rows = buildLiveScannerRows(SCANNER_UNIVERSE, liveQuotes);
  const elapsedSecs = Number(((Date.now() - startMs) / 1000).toFixed(2));
  const syncingCount = rows.filter((r) => r.dataStatus === "SYNCING").length;

  const scannerPayload = {
    scans: [
      {
        slot: "LIVE",
        day: todayEt,
        at: nowIso,
        secs: elapsedSecs,
        credits: 0,
        liveCount: rows.length - syncingCount,
        syncingCount,
        rows,
      },
    ],
    running: syncingCount > 0 ? `Syncing ${syncingCount} chains in background` : null,
    slots: ["LIVE"],
  };

  return NextResponse.json(scannerPayload, {
    headers: {
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
