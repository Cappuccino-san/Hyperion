import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const SUPPORTED_SYMBOLS = new Set(["SPY", "QQQ", "SPXW", "SPX", "IWM"]);

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const rawSymbol = searchParams.get("symbol") || searchParams.get("ticker") || "SPY";
  const symbol = rawSymbol.trim().toUpperCase();

  if (!SUPPORTED_SYMBOLS.has(symbol)) {
    return NextResponse.json(
      { error: "Divergence only available for core index tickers (SPY, QQQ, SPXW, IWM)" },
      { status: 404 }
    );
  }

  // Map SPX to SPXW if needed
  const querySym = symbol === "SPX" ? "SPXW" : symbol;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);

    const res = await fetch(`https://terrashade.onrender.com/api/divergence?symbol=${encodeURIComponent(querySym)}`, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (compatible; HyperionAnalytics/1.0)",
      },
      cache: "no-store",
    });

    clearTimeout(timeout);

    if (res.ok) {
      const data = await res.json();
      return NextResponse.json(data);
    }
  } catch (err) {
    // Fallback: If external API call times out or fails, return empty schema
  }

  return NextResponse.json({
    symbol,
    rows: [
      { tf: "5", name: "5m", state: "NO", signal: null, signals: [], bars: 0, building: false, intraday: true },
      { tf: "30", name: "30m", state: "NO", signal: null, signals: [], bars: 0, building: false, intraday: true },
      { tf: "120", name: "2h", state: "NO", signal: null, signals: [], bars: 0, building: false, intraday: true },
      { tf: "D", name: "Daily", state: "NO", signal: null, signals: [], bars: 0, building: false, intraday: false },
      { tf: "W", name: "Weekly", state: "NO", signal: null, signals: [], bars: 0, building: false, intraday: false },
    ],
    levels: { King: 0, "Call wall": 0, "Put wall": 0 },
    pivot: 3,
    recent: 30,
    built_at: Math.floor(Date.now() / 1000),
  });
}
