import { NextRequest, NextResponse } from "next/server";
import { VALID_TICKER_REGEX } from "@/lib/marketCache";
import { fetchLiveTickQuote, type LiveTickResponse } from "@/lib/liveTick";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export type { LiveTickResponse };

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const rawTicker = (searchParams.get("ticker") || "SPY").trim().toUpperCase();
  if (!VALID_TICKER_REGEX.test(rawTicker)) {
    return NextResponse.json({ error: "Invalid ticker symbol" }, { status: 400 });
  }

  try {
    const winner = await fetchLiveTickQuote(rawTicker);
    if (!winner) {
      throw new Error("All upstream live tick sources failed");
    }
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
