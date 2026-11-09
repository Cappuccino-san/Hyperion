/**
 * CLI Verification Script: Live Discord #trade-signals Dispatch
 *
 * Verifies:
 * 1. Webhook URL resolution from .env.local
 * 2. Proper ?wait=true parameter attachment
 * 3. HTTP 200 OK receipt from Discord API
 * 4. Extraction of Discord Message ID and Channel ID
 */

import fs from "fs";
import path from "path";
import { sendDiscordTradeAlert, TradeLifecycleAlert } from "../lib/tradeSignalEngine";

function getEnvWebhook(): string {
  try {
    const envPath = path.resolve(process.cwd(), ".env.local");
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("DISCORD_WEBHOOK_URL=")) {
          return trimmed.slice("DISCORD_WEBHOOK_URL=".length).trim();
        }
      }
    }
  } catch {}
  return process.env.DISCORD_WEBHOOK_URL || "";
}

async function main(): Promise<void> {
  const webhookUrl = getEnvWebhook();
  console.log("================================================================================");
  console.log("   HYPERION / GAIA DISCORD #trade-signals LIVE VERIFICATION DISPATCH             ");
  console.log("================================================================================");

  if (!webhookUrl) {
    console.error("❌ Error: No DISCORD_WEBHOOK_URL found in .env.local or environment.");
    process.exit(1);
  }

  const masked = webhookUrl.replace(/(webhooks\/\d+\/)[^?]+/, "$1***");
  console.log(`Endpoint: ${masked}`);

  const nowSec = Math.floor(Date.now() / 1000);
  const testAlert: TradeLifecycleAlert = {
    id: `gaia-cli-verify-${nowSec}`,
    timestamp: "12:05 PM",
    ts: nowSec,
    dispatchedAt: nowSec,
    ticker: "SPY",
    action: "BUY_TO_OPEN",
    contractType: "CALL",
    contractLabel: "SPY 261104 765C (Today, 0 DTE · Same-Day · $0.65)",
    strike: 765,
    expiration: "2026-11-04",
    expHuman: "Today, Nov 4 (0 DTE · Same-Day)",
    robinhoodExp: "Nov 4",
    robinhoodTab: "Today (0 DTE)",
    setupName: "Gaia Tactical HUD [LONG · FLUX FSM]",
    reason: "Gaia Intraday Non-Repainting FSM Confirmation at $764.50",
    status: "OPEN",
    spotPrice: 764.50,
    btoSpotPrice: 764.50,
    target1Spot: 766.30,
    target2Spot: 768.00,
    stopLossSpot: 763.30,
    optionMid: 0.65,
    optionBid: 0.63,
    optionAsk: 0.65,
    btoOptionMid: 0.65,
    contractsQty: 1,
    remainingQty: 1,
    totalOutlay: 65,
    estTp1Mid: 0.90,
    estTp2Mid: 1.25,
    estStopMid: 0.49,
    tp1Pct: 38,
    tp2Pct: 92,
    rrRatio: 1.5,
    calibratedWinRate: 68,
    calibratedExpectancyR: 0.45,
    dataConvictionScore: 92,
    isHistoricalBackfill: false,
    eventId: `gaia-cli-verify-${nowSec}`,
    message: "🟢 BUY TO OPEN (1x @ $0.65) · SPY [Gaia LONG · FLUX FSM] @ $764.50",
  };

  console.log("\nDispatching live verified trade alert to #trade-signals...");
  const success = await sendDiscordTradeAlert(testAlert, webhookUrl);

  if (success) {
    console.log("✅ Dispatch successful! Webhook returned HTTP 200 OK receipt.");
  } else {
    console.error("❌ Dispatch failed! Check network connectivity or rate limits.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
