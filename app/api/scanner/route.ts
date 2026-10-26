import { NextResponse } from "next/server";
import { optionsMemoryCache } from "@/lib/marketCache";

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

function overlayLiveKingMetrics(rows: RawScannerRow[]): RawScannerRow[] {
  const updated = rows.map((row) => {
    const cached = optionsMemoryCache.get(row.t.toUpperCase())?.payload;
    if (!cached || cached.strikes.length === 0) {
      return row;
    }

    const px = Number(cached.spotPrice.toFixed(2));
    const king = cached.kingNode.allExpKing;
    const pts = Number((king - px).toFixed(2));
    const pct = px > 0 ? Number(((pts / px) * 100).toFixed(2)) : row.pct;
    const dailyEm =
      cached.expectedMoves?.daily?.em && cached.expectedMoves.daily.em > 0
        ? cached.expectedMoves.daily.em
        : Math.max(0.5, px * cached.impliedVolatility * Math.sqrt(1 / 252));
    const xem = Number((Math.abs(pts) / Math.max(0.01, dailyEm)).toFixed(2));
    const neg = cached.netMetrics.netGex < 0;
    const str = cached.kingNode.kingStrength;
    const share =
      cached.kingNode.totalBoardGamma > 0
        ? Number(
            (
              (cached.kingNode.kingValue / cached.kingNode.totalBoardGamma) *
              100
            ).toFixed(1)
          )
        : row.share;
    const contested = cached.kingNode.isContested;
    const moved = row.moved || king !== row.king;

    // Recompute conviction score dynamically based on live King strength & proximity to EM
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
      ...row,
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
      book: cached.bookTimestamp ?? row.book,
      contested,
      moved,
    };
  });

  return updated.sort((a, b) => b.score - a.score);
}

export async function GET() {
  const todayEt = new Date().toLocaleDateString("en-CA", {
    timeZone: "America/New_York",
  });
  const nowIso = new Date().toISOString();

  const scannerPayload = {
    scans: [
      {
        slot: "09:35",
        day: todayEt,
        at: nowIso,
        secs: 3381.5,
        credits: 0,
        rows: overlayLiveKingMetrics([
          { t: "AAPL", px: 346.23, king: 350.0, pts: 3.77, pct: 1.09, xem: 0.81, neg: false, str: 64, share: 24.4, base: 68, score: 50, rr: 0.2039, book: "Oct 16, 4:14 PM ET", contested: false, moved: true },
          { t: "MU", px: 879.99, king: 850.0, pts: -29.99, pct: -3.41, xem: 1.28, neg: true, str: 15, share: 5.8, base: 53, score: 43, rr: 0.998, book: "Oct 16, 4:00 PM ET", contested: true, moved: true },
          { t: "META", px: 720.1, king: 750.0, pts: 29.9, pct: 4.15, xem: 2.99, neg: false, str: 57, share: 18.9, base: 46, score: 41, rr: 1.4876, book: "Oct 16, 4:00 PM ET", contested: false, moved: true },
          { t: "IWM", px: 272.02, king: 270.0, pts: -2.02, pct: -0.74, xem: 1.06, neg: true, str: 28, share: 13.4, base: 60, score: 40, rr: 0.0204, book: "Oct 16, 4:00 PM ET", contested: false, moved: true },
          { t: "SPY", px: 763.66, king: 760.0, pts: -3.66, pct: -0.48, xem: 1.03, neg: true, str: 14, share: 6.3, base: 53, score: 39, rr: 0.4925, book: "Oct 16, 4:00 PM ET", contested: false, moved: true },
          { t: "SPXW", px: 7690.9, king: 7650.0, pts: -40.9, pct: -0.53, xem: 1.16, neg: true, str: 13, share: 5.9, base: 52, score: 38, rr: 0.6484, book: "Oct 16, 4:00 PM ET", contested: false, moved: true },
          { t: "QQQ", px: 712.78, king: 700.0, pts: -12.78, pct: -1.79, xem: 2.25, neg: true, str: 16, share: 7.9, base: 48, score: 32, rr: 0.3514, book: "Oct 16, 4:00 PM ET", contested: false, moved: true },
          { t: "MSFT", px: 529.05, king: 575.0, pts: 45.95, pct: 8.69, xem: 7.16, neg: false, str: 62, share: 17.5, base: 29, score: 29, rr: 5.1728, book: "Oct 16, 4:00 PM ET", contested: false, moved: true },
          { t: "GME", px: 26.91, king: 30.0, pts: 3.09, pct: 11.48, xem: 3.77, neg: false, str: 74, share: 24.1, base: 39, score: 20, rr: 0.0989, book: "Oct 16, 3:59 PM ET", contested: false, moved: true },
          { t: "AMZN", px: 248.85, king: 260.0, pts: 11.15, pct: 4.48, xem: 3.78, neg: false, str: 38, share: 14.6, base: 22, score: 20, rr: 1.8254, book: "Oct 16, 3:59 PM ET", contested: false, moved: true },
          { t: "ARM", px: 228.61, king: 250.0, pts: 21.39, pct: 9.36, xem: 2.87, neg: true, str: 21, share: 8.2, base: 37, score: 19, rr: 0.1614, book: "Oct 16, 4:00 PM ET", contested: true, moved: true },
          { t: "SMCI", px: 31.63, king: 40.0, pts: 8.37, pct: 26.46, xem: 3.43, neg: true, str: 27, share: 9.1, base: 28, score: 14, rr: 0.5873, book: "Oct 16, 4:00 PM ET", contested: false, moved: true },
          { t: "MSTR", px: 136.83, king: 135.0, pts: -1.83, pct: -1.34, xem: 0.2, neg: true, str: 26, share: 8.6, base: 25, score: 13, rr: 0.8281, book: "Oct 16, 4:14 PM ET", contested: false, moved: true },
          { t: "NVDA", px: 215.08, king: 230.0, pts: 14.92, pct: 6.94, xem: 3.89, neg: false, str: 25, share: 8.1, base: 14, score: 13, rr: 1.907, book: "Oct 16, 4:08 PM ET", contested: true, moved: true },
          { t: "SPX", px: 7661.6, king: 7650.0, pts: -11.6, pct: -0.15, xem: 0.23, neg: true, str: 29, share: 7.2, base: 30, score: 13, rr: 0.3021, book: "Oct 16, 4:00 PM ET", contested: false, moved: true },
          { t: "GOOGL", px: 340.59, king: 380.0, pts: 39.41, pct: 11.57, xem: 7.83, neg: false, str: 18, share: 7.8, base: 8, score: 5, rr: 1.6834, book: "Oct 16, 4:07 PM ET", contested: true, moved: true },
          { t: "SOFI", px: 14.54, king: 20.0, pts: 5.46, pct: 37.55, xem: 8.27, neg: false, str: 29, share: 13.1, base: 14, score: 3, rr: 0.8519, book: "Oct 16, 3:59 PM ET", contested: true, moved: true },
          { t: "IBIT", px: 46.15, king: 50.0, pts: 3.85, pct: 8.34, xem: 4.23, neg: true, str: 40, share: 11.7, base: 22, score: 3, rr: 0.0762, book: "Oct 16, 4:13 PM ET", contested: false, moved: true },
          { t: "GLD", px: 383.62, king: 450.0, pts: 66.38, pct: 17.3, xem: 18.75, neg: false, str: 38, share: 8.1, base: 18, score: 2, rr: 0.3812, book: "Oct 16, 4:00 PM ET", contested: false, moved: true },
          { t: "DIA", px: 518.11, king: 510.0, pts: -8.11, pct: -1.57, xem: 3.26, neg: false, str: 15, share: 5.8, base: 21, score: 2, rr: 0.0582, book: "Oct 16, 4:00 PM ET", contested: false, moved: true },
          { t: "NDX", px: 29161.17, king: 29200.0, pts: 38.83, pct: 0.13, xem: 0.12, neg: true, str: 25, share: 8.6, base: 16, score: 0, rr: 0.2409, book: "Oct 16, 4:00 PM ET", contested: false, moved: true },
          { t: "NDXP", px: 29161.17, king: 29200.0, pts: 38.83, pct: 0.13, xem: 0.12, neg: true, str: 25, share: 8.6, base: 16, score: 0, rr: 0.2409, book: "Oct 16, 4:00 PM ET", contested: false, moved: true },
          { t: "AMD", px: 529.07, king: 620.0, pts: 90.93, pct: 17.19, xem: 6.16, neg: true, str: 18, share: 4.4, base: 10, score: 0, rr: 0.2285, book: "Oct 16, 3:59 PM ET", contested: false, moved: true },
          { t: "TSLA", px: 354.72, king: 400.0, pts: 45.28, pct: 12.76, xem: 6.01, neg: false, str: 39, share: 8.4, base: 18, score: 0, rr: 0.1333, book: "Oct 16, 4:14 PM ET", contested: false, moved: true },
        ]),
      },
      {
        slot: "15:50",
        day: todayEt,
        at: nowIso,
        secs: 858.2,
        credits: 0,
        rows: overlayLiveKingMetrics([
          { t: "BAC", px: 51.34, king: 50.0, pts: -1.34, pct: -2.61, xem: 2.35, neg: true, str: 68, share: 27.3, base: 75, score: 69, rr: 1.4167, book: "Oct 16, 4:00 PM ET", contested: false },
          { t: "XLE", px: 68.24, king: 70.0, pts: 1.76, pct: 2.58, xem: 2.15, neg: false, str: 63, share: 21.0, base: 65, score: 65, rr: 2.3784, book: "Oct 16, 4:00 PM ET", contested: false, moved: true },
          { t: "TSM", px: 413.4, king: 400.0, pts: -13.4, pct: -3.24, xem: 1.87, neg: true, str: 38, share: 12.6, base: 66, score: 52, rr: 0.5625, book: "Oct 16, 4:05 PM ET", contested: false },
          { t: "WMT", px: 118.74, king: 120.0, pts: 1.26, pct: 1.06, xem: 1.02, neg: false, str: 64, share: 33.6, base: 68, score: 51, rr: 0.3369, book: "Oct 16, 4:08 PM ET", contested: false },
          { t: "IWM", px: 270.74, king: 270.0, pts: -0.74, pct: -0.27, xem: 0.39, neg: true, str: 56, share: 15.7, base: 63, score: 49, rr: 0.5873, book: "Oct 16, 4:00 PM ET", contested: false },
          { t: "ORCL", px: 128.23, king: 120.0, pts: -8.23, pct: -6.42, xem: 1.26, neg: true, str: 34, share: 11.1, base: 64, score: 47, rr: 0.2744, book: "Oct 16, 3:59 PM ET", contested: false, moved: true },
          { t: "SPY", px: 763.09, king: 760.0, pts: -3.09, pct: -0.4, xem: 0.87, neg: true, str: 22, share: 5.9, base: 57, score: 44, rr: 0.5707, book: "Oct 16, 4:00 PM ET", contested: false },
          { t: "QQQ", px: 710.82, king: 700.0, pts: -10.82, pct: -1.52, xem: 1.9, neg: true, str: 25, share: 8.2, base: 59, score: 43, rr: 0.3761, book: "Oct 16, 4:00 PM ET", contested: false },
          { t: "MU", px: 885.35, king: 850.0, pts: -35.35, pct: -3.99, xem: 1.51, neg: true, str: 17, share: 5.9, base: 54, score: 38, rr: 0.3652, book: "Oct 16, 4:00 PM ET", contested: true },
          { t: "SPCX", px: 143.78, king: 135.0, pts: -8.78, pct: -6.11, xem: 2.65, neg: true, str: 40, share: 16.9, base: 52, score: 38, rr: 0.6393, book: "Oct 16, 4:00 PM ET", contested: true },
          { t: "LLY", px: 1257.03, king: 1300.0, pts: 42.97, pct: 3.42, xem: 1.11, neg: false, str: 37, share: 8.5, base: 56, score: 38, rr: 0.1744, book: "Oct 16, 4:00 PM ET", contested: false, moved: true },
          { t: "COIN", px: 173.16, king: 200.0, pts: 26.84, pct: 15.5, xem: 2.47, neg: false, str: 24, share: 7.6, base: 41, score: 27, rr: 0.5823, book: "Oct 16, 3:59 PM ET", contested: false, moved: true },
          { t: "PLTR", px: 186.03, king: 210.0, pts: 23.97, pct: 12.89, xem: 2.74, neg: false, str: 19, share: 9.0, base: 33, score: 26, rr: 1.2665, book: "Oct 16, 4:00 PM ET", contested: true, moved: true },
          { t: "RBLX", px: 49.55, king: 35.0, pts: -14.55, pct: -29.36, xem: 5.03, neg: false, str: 51, share: 13.0, base: 24, score: 24, rr: 3.2373, book: "Oct 16, 4:00 PM ET", contested: false, moved: true },
          { t: "BABA", px: 109.11, king: 120.0, pts: 10.89, pct: 9.98, xem: 2.95, neg: false, str: 15, share: 7.0, base: 27, score: 21, rr: 1.4331, book: "Oct 16, 4:00 PM ET", contested: true, moved: true },
          { t: "SPX", px: 7661.6, king: 7650.0, pts: -11.6, pct: -0.15, xem: 0.23, neg: true, str: 29, share: 7.2, base: 30, score: 13, rr: 0.3021, book: "Oct 16, 4:00 PM ET", contested: false, moved: true },
          { t: "GME", px: 26.97, king: 30.0, pts: 3.03, pct: 11.23, xem: 3.7, neg: false, str: 57, share: 20.8, base: 32, score: 12, rr: 0.0309, book: "Oct 16, 3:59 PM ET", contested: false },
          { t: "MARA", px: 7.5, king: 5.0, pts: -2.5, pct: -33.33, xem: 6.76, neg: true, str: 33, share: 12.7, base: 18, score: 8, rr: 1.0, book: "Oct 16, 4:00 PM ET", contested: false, moved: true },
          { t: "BA", px: 190.28, king: 200.0, pts: 9.72, pct: 5.11, xem: 3.98, neg: false, str: 24, share: 11.9, base: 12, score: 6, rr: 1.3789, book: "Oct 16, 3:59 PM ET", contested: true, moved: true },
          { t: "GLD", px: 382.32, king: 450.0, pts: 67.68, pct: 17.7, xem: 19.12, neg: false, str: 29, share: 7.0, base: 14, score: 6, rr: 1.1552, book: "Oct 16, 4:00 PM ET", contested: false },
          { t: "AVGO", px: 329.26, king: 300.0, pts: -29.26, pct: -8.89, xem: 4.87, neg: true, str: 18, share: 9.1, base: 10, score: 6, rr: 1.6132, book: "Oct 16, 3:59 PM ET", contested: true, moved: true },
          { t: "SPXW", px: 7655.38, king: 7650.0, pts: -5.38, pct: -0.07, xem: 0.15, neg: true, str: 26, share: 5.7, base: 20, score: 4, rr: 0.368, book: "Oct 16, 4:00 PM ET", contested: false },
          { t: "SOFI", px: 14.54, king: 20.0, pts: 5.46, pct: 37.55, xem: 8.27, neg: false, str: 29, share: 13.1, base: 14, score: 3, rr: 0.8519, book: "Oct 16, 3:59 PM ET", contested: true, moved: true },
          { t: "DIA", px: 518.52, king: 510.0, pts: -8.52, pct: -1.64, xem: 3.42, neg: false, str: 16, share: 5.8, base: 19, score: 3, rr: 0.3514, book: "Oct 16, 4:00 PM ET", contested: false },
          { t: "HOOD", px: 98.87, king: 120.0, pts: 21.13, pct: 21.37, xem: 3.75, neg: false, str: 28, share: 9.4, base: 18, score: 1, rr: 0.292, book: "Oct 16, 4:00 PM ET", contested: false, moved: true },
          { t: "NDX", px: 29161.17, king: 29200.0, pts: 38.83, pct: 0.13, xem: 0.12, neg: true, str: 25, share: 8.6, base: 16, score: 0, rr: 0.2409, book: "Oct 16, 4:00 PM ET", contested: false, moved: true },
          { t: "NDXP", px: 29161.17, king: 29200.0, pts: 38.83, pct: 0.13, xem: 0.12, neg: true, str: 25, share: 8.6, base: 16, score: 0, rr: 0.2409, book: "Oct 16, 4:00 PM ET", contested: false, moved: true },
          { t: "TLT", px: 80.05, king: 90.0, pts: 9.95, pct: 12.43, xem: 19.9, neg: false, str: 30, share: 9.9, base: 14, score: 0, rr: 0.3115, book: "Oct 16, 4:00 PM ET", contested: false, moved: true },
          { t: "RIVN", px: 12.42, king: 20.0, pts: 7.58, pct: 61.03, xem: 12.23, neg: false, str: 24, share: 10.9, base: 11, score: 0, rr: 0.1905, book: "Oct 16, 4:00 PM ET", contested: true, moved: true },
          { t: "AMD", px: 529.07, king: 620.0, pts: 90.93, pct: 17.19, xem: 6.16, neg: true, str: 18, share: 4.4, base: 10, score: 0, rr: 0.2285, book: "Oct 16, 3:59 PM ET", contested: false, moved: true },
          { t: "TSLA", px: 354.72, king: 400.0, pts: 45.28, pct: 12.76, xem: 6.01, neg: false, str: 39, share: 8.4, base: 18, score: 0, rr: 0.1333, book: "Oct 16, 4:14 PM ET", contested: false, moved: true },
        ]),
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
