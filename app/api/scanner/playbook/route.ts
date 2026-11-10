import { NextResponse } from "next/server";
import {
  generateDailyPlaybook,
  LiveTickerTelemetry,
  PLAYBOOK_TICKER_UNIVERSE,
} from "@/lib/playbookEngine";
import { optionsMemoryCache } from "@/lib/marketCache";
import { fetchLiveCboeOptions } from "@/lib/tradeSignalEngine";
import { computeOptionsAnalytics } from "@/lib/optionsExposure";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const telemetryOverrides: Record<string, Partial<LiveTickerTelemetry>> = {};

    // 1. Dynamically pre-hydrate live spot prices for all universe tickers in a single sub-second batch
    try {
      const symbolsParam = PLAYBOOK_TICKER_UNIVERSE.join(",");
      const rhRes = await fetch(
        `https://api.robinhood.com/quotes/?symbols=${symbolsParam}`,
        {
          headers: {
            Accept: "application/json",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) HyperionTerminal/1.0",
          },
          cache: "no-store",
        }
      );
      if (rhRes.ok) {
        const rhData = await rhRes.json();
        for (const item of rhData?.results || []) {
          const s = String(item?.symbol || "").toUpperCase();
          const p = Number(item?.last_trade_price ?? item?.bid_price ?? 0);
          const prev = Number(item?.previous_close ?? 0);
          if (s && p > 0) {
            telemetryOverrides[s] = {
              spotPrice: Number(p.toFixed(2)),
              previousClose: prev > 0 ? Number(prev.toFixed(2)) : undefined,
            };
          }
        }
      }
    } catch {
      // Non-fatal quote pre-fetch error
    }

    // 2. Dynamically compute live GEX/VEX/King metrics from CBOE chains on-demand
    await Promise.all(
      PLAYBOOK_TICKER_UNIVERSE.map(async (ticker) => {
        const sUpper = ticker.toUpperCase();
        let payload = optionsMemoryCache.get(sUpper)?.payload;

        // If not cached, dynamically ingest live CBOE chain for today's session:
        if (!payload || payload.strikes.length === 0) {
          try {
            const contracts = await fetchLiveCboeOptions(sUpper);
            const liveSpot = telemetryOverrides[sUpper]?.spotPrice;
            const prevClose = telemetryOverrides[sUpper]?.previousClose ?? liveSpot;
            if (contracts.length > 0 && liveSpot && liveSpot > 0) {
              payload = computeOptionsAnalytics({
                ticker: sUpper,
                dataSource: "CBOE_MARKET_DATA",
                spotPrice: liveSpot,
                previousClose: prevClose ?? liveSpot,
                contracts,
              });
              optionsMemoryCache.set(sUpper, { timestamp: Date.now(), payload });
            }
          } catch {
            // Non-fatal on-demand chain fetch
          }
        }

        if (payload && payload.strikes.length > 0) {
          // Find true VEX King across all active expirations dynamically
          let vexKing = payload.kingNode.zeroDteKing ?? payload.kingNode.allExpKing;
          let maxVexAbs = -1;
          for (const row of payload.strikes) {
            let sumVex = 0;
            for (const col of payload.expirations) {
              sumVex += row.vex[col.id] ?? 0;
            }
            if (Math.abs(sumVex) > maxVexAbs) {
              maxVexAbs = Math.abs(sumVex);
              vexKing = row.strike;
            }
          }

          telemetryOverrides[sUpper] = {
            ...(telemetryOverrides[sUpper] || {}),
            spotPrice: payload.spotPrice,
            previousClose: payload.previousClose,
            expectedMoveDaily: payload.expectedMoves?.daily?.em,
            netGex: payload.netMetrics.netGex,
            netVex: payload.netMetrics.netVex,
            gexKing: payload.kingNode.allExpKing,
            vexKing,
            kingStrength: payload.kingNode.kingStrength,
            strikeStep: payload.strikeStep,
          };
        }
      })
    );

    const playbook = generateDailyPlaybook(undefined, telemetryOverrides);

    return NextResponse.json(playbook, {
      headers: {
        "Cache-Control": "no-store, max-age=0",
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to generate dynamic 0DTE playbook" },
      { status: 500 }
    );
  }
}
