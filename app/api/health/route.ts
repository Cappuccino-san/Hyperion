import { NextResponse } from "next/server";
import { ensureLiveBotRunning, getLiveBotStatus, isExecutionHalted } from "@/lib/liveBotDaemon";
import { isExecutionLeader } from "@/lib/executionLease";
import { getActiveDurableBackendKind } from "@/lib/persistenceStore";
import { isMarketOpen } from "@/lib/marketDataService";
import { resolveExecutionMode } from "@/lib/brokerExecution";

export const dynamic = "force-dynamic";

export async function GET() {
  ensureLiveBotRunning();
  const mkt = isMarketOpen();
  const persistenceBackend = getActiveDurableBackendKind();
  const ephemeralStorageWarning = persistenceBackend === "local-cache";
  return NextResponse.json({
    ok: true,
    marketStatus: mkt.open ? "OPEN" : "CLOSED",
    executionMode: resolveExecutionMode(),
    executionLocked: isExecutionHalted(),
    persistenceBackend,
    ephemeralStorageWarning,
    leaseLeaderActive: isExecutionLeader(),
    liveBot: getLiveBotStatus(),
    timestamp: new Date().toISOString(),
  });
}
