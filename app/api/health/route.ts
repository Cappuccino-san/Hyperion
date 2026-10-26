import { NextRequest, NextResponse } from "next/server";
import { globalTelemetry } from "@/lib/telemetry";
import { getMemoryCacheEntries } from "@/lib/marketCache";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const probe = searchParams.get("probe") === "true";

  if (probe) {
    const start = performance.now();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);
      const res = await fetch("https://cdn.cboe.com/api/global/delayed_quotes/options/_SPX.json", {
        method: "HEAD",
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) HyperionHealthProbe/1.0",
        },
        cache: "no-store",
      });
      clearTimeout(timeout);
      const latencyMs = Math.round(performance.now() - start);
      if (res.ok) {
        globalTelemetry.recordSuccess("SPX", latencyMs);
      } else {
        globalTelemetry.recordFailure("SPX", `HTTP ${res.status}`, latencyMs);
      }
    } catch (err: unknown) {
      const latencyMs = Math.round(performance.now() - start);
      const msg = err instanceof Error ? err.message : "Probe timeout";
      globalTelemetry.recordFailure("SPX", msg, latencyMs);
    }
  }

  const entries = getMemoryCacheEntries();
  const metrics = globalTelemetry.getMetrics(entries);

  return NextResponse.json(metrics, {
    status: metrics.status === "OFFLINE" ? 503 : 200,
    headers: {
      "Cache-Control": "no-store, no-cache, must-revalidate",
    },
  });
}
