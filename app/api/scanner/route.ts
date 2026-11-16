import { NextResponse } from "next/server";
import { optionsMemoryCache } from "@/lib/marketCache";
import { getTickerPreset } from "@/lib/tickerPresets";
import { getTodayEt } from "@/lib/gaiaSessionGuards";

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
}

const SCANNER_UNIVERSE_1 = [
  "AAPL", "MU", "META", "IWM", "SPY", "SPXW", "QQQ", "MSFT", "GME", "AMZN",
  "ARM", "SMCI", "MSTR", "NVDA", "SPX", "GOOGL", "SOFI", "IBIT", "GLD", "DIA",
  "NDX", "AMD", "TSLA"
];

const SCANNER_UNIVERSE_2 = [
  "BAC", "XLE", "TSM", "WMT", "IWM", "ORCL", "SPY", "QQQ", "MU", "LLY",
  "COIN", "PLTR", "RBLX", "BABA", "SPX", "GME", "MARA", "BA", "GLD", "AVGO",
  "SPXW", "SOFI", "DIA", "HOOD", "NDX", "TLT", "RIVN", "AMD", "TSLA"
];

function buildLiveScannerRows(
  symbols: string[],
  liveQuotes: Record<string, number>
): RawScannerRow[] {
  const nowEt = new Date().toLocaleTimeString("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
  });

  return symbols.map((sym) => {
    const s = sym.toUpperCase();
    const cached = optionsMemoryCache.get(s)?.payload;
    const preset = getTickerPreset(s, liveQuotes[s]);
    const px = cached?.spotPrice ?? liveQuotes[s] ?? preset.spotPrice;
    const king = cached?.kingNode?.allExpKing ?? preset.kingPreset.allExpKing;
    const pts = Number((king - px).toFixed(2));
    const pct = px > 0 ? Number(((pts / px) * 100).toFixed(2)) : 0;
    const dailyEm = cached?.expectedMoves?.daily?.em ?? (px * (preset.impliedVolatility || 0.25) * Math.sqrt(1 / 252));
    const xem = Number((Math.abs(pts) / Math.max(0.01, dailyEm)).toFixed(2));
    const neg = (cached?.netMetrics?.netGex ?? preset.netMetrics.netGex) < 0;
    const str = cached?.kingNode?.kingStrength ?? 60;
    const totalGamma = cached?.kingNode?.totalBoardGamma ?? preset.kingPreset.totalBoardGamma ?? 500;
    const kingVal = cached?.kingNode?.kingValue ?? preset.kingPreset.kingValue ?? 100;
    const share = totalGamma > 0 ? Number(((kingVal / totalGamma) * 100).toFixed(1)) : 15.0;
    const contested = cached?.kingNode?.isContested ?? false;

    const emAlignmentScore = Math.max(0, 35 - Math.abs(xem - 1.15) * 12);
    const base = Math.round(Math.min(99, str * 0.65 + emAlignmentScore));
    const score = Math.round(
      Math.max(
        0,
        Math.min(
          99,
          base * (contested ? 0.82 : 1.0) - (xem > 4 ? (xem - 4) * 5 : 0)
        )
      )
    );

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
      book: cached?.bookTimestamp ?? `${nowEt} ET`,
      contested,
      moved: false,
    };
  }).sort((a, b) => b.score - a.score);
}

export async function GET() {
  const todayEt = getTodayEt();
  const nowIso = new Date().toISOString();

  // Pre-fetch live quotes for all scanner symbols dynamically in a single sub-second batch
  const liveQuotes: Record<string, number> = {};
  try {
    const allUniqueSymbols = Array.from(new Set([...SCANNER_UNIVERSE_1, ...SCANNER_UNIVERSE_2])).join(",");
    const res = await fetch(`https://api.robinhood.com/quotes/?symbols=${allUniqueSymbols}`, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) HyperionTerminal/1.0",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(3000),
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

  const scannerPayload = {
    scans: [
      {
        slot: "09:35",
        day: todayEt,
        at: nowIso,
        secs: 3381.5,
        credits: 0,
        rows: buildLiveScannerRows(SCANNER_UNIVERSE_1, liveQuotes),
      },
      {
        slot: "15:50",
        day: todayEt,
        at: nowIso,
        secs: 858.2,
        credits: 0,
        rows: buildLiveScannerRows(SCANNER_UNIVERSE_2, liveQuotes),
      },
    ],
    running: null,
    slots: ["09:35", "15:50"],
  };

  return NextResponse.json(scannerPayload, {
    headers: {
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
