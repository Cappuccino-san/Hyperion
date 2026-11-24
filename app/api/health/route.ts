import { NextResponse } from "next/server";
import { ensureLiveBotRunning, getLiveBotStatus, isExecutionHalted } from "@/lib/liveBotDaemon";
import { isExecutionLeader } from "@/lib/executionLease";
import { getActiveDurableBackendKind } from "@/lib/persistenceStore";
import { isMarketOpen } from "@/lib/marketDataService";
import { resolveExecutionMode } from "@/lib/brokerExecution";
import { resolveOptionsQuoteProvider, resolveTradierAccessToken } from "@/lib/optionsExposure";

export const dynamic = "force-dynamic";

export async function GET() {
  ensureLiveBotRunning();
  const mkt = isMarketOpen();
  const persistenceBackend = getActiveDurableBackendKind();
  const ephemeralStorageWarning = persistenceBackend === "local-cache";
  const optionsQuoteProvider = resolveOptionsQuoteProvider();
  return NextResponse.json({
    ok: true,
    marketStatus: mkt.open ? "OPEN" : "CLOSED",
    executionMode: resolveExecutionMode(),
    executionLocked: isExecutionHalted(),
    optionsQuoteProvider,
    tradierConfigured: resolveTradierAccessToken().length > 0,
    persistenceBackend,
    ephemeralStorageWarning,
    leaseLeaderActive: isExecutionLeader(),
    liveBot: getLiveBotStatus(),
    timestamp: new Date().toISOString(),
  });
}
