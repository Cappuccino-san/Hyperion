import { NextResponse } from "next/server";
import { ensureLiveBotRunning, getLiveBotStatus } from "@/lib/liveBotDaemon";
import { isMarketOpen } from "@/lib/marketDataService";

export const dynamic = "force-dynamic";

export async function GET() {
  ensureLiveBotRunning();
  const mkt = isMarketOpen();
  return NextResponse.json({
    ok: true,
    marketStatus: mkt.open ? "OPEN" : "CLOSED",
    liveBot: getLiveBotStatus(),
    timestamp: new Date().toISOString(),
  });
}
