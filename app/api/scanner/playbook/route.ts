import { NextResponse } from "next/server";
import {
  generateDailyPlaybook,
  LiveTickerTelemetry,
} from "@/lib/playbookEngine";
import { optionsMemoryCache } from "@/lib/marketCache";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const telemetryOverrides: Record<string, Partial<LiveTickerTelemetry>> = {};

    optionsMemoryCache.forEach((entry, sym) => {
      const payload = entry.payload;
      if (!payload || payload.strikes.length === 0) return;

      // Find true VEX King across all expirations
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

      telemetryOverrides[sym.toUpperCase()] = {
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
    });

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
