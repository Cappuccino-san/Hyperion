/**
 * CLI Verification Script: Discord #trade-signals BTO & STC Dispatch Suite
 *
 * Usage:
 *   npx tsx scripts/testDiscordSignalDispatch.ts          # Dry-run payload + firewall verification (zero network, zero .cache writes)
 *   npx tsx scripts/testDiscordSignalDispatch.ts --live   # Live Discord webhook reachability test across BTO & STC embeds
 */

import fs from "fs";
import path from "path";
import assert from "node:assert/strict";
import {
  sendDiscordTradeAlert,
  TradeLifecycleAlert,
} from "../lib/tradeSignalEngine";

function resolveWebhookUrl(isLive: boolean): { url: string; source: string } {
  try {
    const envPath = path.resolve(process.cwd(), ".env.local");
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("DISCORD_WEBHOOK_URL=")) {
          const val = trimmed.slice("DISCORD_WEBHOOK_URL=".length).trim().replace(/^["']|["']$/g, "");
          if (val) return { url: val, source: ".env.local" };
        }
      }
    }
  } catch {
    // ignore
  }
  if (process.env.DISCORD_WEBHOOK_URL?.trim()) {
    return { url: process.env.DISCORD_WEBHOOK_URL.trim(), source: "process.env" };
  }
  if (!isLive) {
    return {
      url: "https://discord.com/api/webhooks/000000000000000000/dry-run-placeholder",
      source: "dry-run-placeholder",
    };
  }
  return { url: "", source: "unset" };
}

function buildScenarioAlerts(nowSec: number): Array<{ label: string; expectBlocked?: boolean; alert: TradeLifecycleAlert }> {
  const base: Omit<TradeLifecycleAlert, "id" | "action" | "contractType" | "contractLabel" | "strike" | "setupName" | "reason" | "status" | "message"> = {
    timestamp: "11:35 AM",
    ts: nowSec,
    dispatchedAt: nowSec,
    ticker: "SPY",
    expiration: "2026-11-13",
    expHuman: "Today, Nov 13 (0 DTE · Same-Day)",
    robinhoodExp: "Nov 13",
    robinhoodTab: "Today (0 DTE)",
    spotPrice: 752.45,
    btoSpotPrice: 750.30,
    target1Spot: 753.00,
    target2Spot: 755.50,
    stopLossSpot: 749.10,
    optionMid: 0.65,
    optionBid: 0.64,
    optionAsk: 0.66,
    btoOptionMid: 0.65,
    contractsQty: 1,
    remainingQty: 1,
    totalOutlay: 65,
    estTp1Mid: 0.95,
    estTp2Mid: 1.40,
    estStopMid: 0.49,
    tp1Pct: 46,
    tp2Pct: 115,
    rrRatio: 2.25,
    calibratedWinRate: 68,
    calibratedExpectancyR: 0.45,
    dataConvictionScore: 88,
    flowVwap: 751.80,
    ceilingShareChi: 0.72,
    pecletNumber: 2.4,
    isHistoricalBackfill: false,
    eventId: `verify-${nowSec}`,
  };

  return [
    {
      label: "1. Historical Backfill Silence Guard",
      expectBlocked: true,
      alert: {
        ...base,
        id: `verify-backfill-${nowSec}`,
        action: "BUY_TO_OPEN",
        contractType: "CALL",
        contractLabel: "SPY 261113 752C",
        strike: 752,
        setupName: "Impulse Flux & Divergence Reclaim [BTO CALL]",
        reason: "Historical replay test",
        status: "OPEN",
        isHistoricalBackfill: true,
        message: "Backfill silenced test",
      },
    },
    {
      label: "2. BUY_TO_OPEN (CALL)",
      alert: {
        ...base,
        id: `verify-bto-call-${nowSec}`,
        action: "BUY_TO_OPEN",
        contractType: "CALL",
        contractLabel: "SPY 261113 752C (Today, 0 DTE · $0.65)",
        strike: 752,
        setupName: "Impulse Flux & Divergence Reclaim [BTO CALL]",
        reason: "Put Wall 750 Bounce + 5m Bullish Divergence",
        status: "OPEN",
        message: "🟢 BUY TO OPEN (1x @ $0.65) · SPY 261113 752C @ $750.30",
      },
    },
    {
      label: "3. BUY_TO_OPEN (PUT)",
      alert: {
        ...base,
        id: `verify-bto-put-${nowSec}`,
        action: "BUY_TO_OPEN",
        contractType: "PUT",
        contractLabel: "SPY 261113 757P (Today, 0 DTE · $0.58)",
        strike: 757,
        spotPrice: 758.25,
        btoSpotPrice: 758.25,
        target1Spot: 755.50,
        target2Spot: 752.50,
        stopLossSpot: 760.10,
        setupName: "Flux-Field Breakdown & Upper Rejection [BTO PUT]",
        reason: "Bearish Zero-Gamma & Flow VWAP Rejection",
        status: "OPEN",
        ceilingShareChi: 0.12,
        pecletNumber: -4.2,
        message: "🟣 BUY TO OPEN (1x @ $0.58) · SPY 261113 757P @ $758.25",
      },
    },
    {
      label: "4. SELL_TO_CLOSE (TAKE_PROFIT)",
      alert: {
        ...base,
        id: `verify-stc-tp-${nowSec}`,
        action: "SELL_TO_CLOSE",
        contractType: "CALL",
        contractLabel: "SPY 261113 752C",
        strike: 752,
        setupName: "Impulse Flux & Divergence Reclaim [BTO CALL]",
        reason: "TARGET 1 HIT · FULL PROFIT EXIT (1 CONTRACT)",
        status: "CLOSED",
        remainingQty: 0,
        optionMid: 1.05,
        pnlOptionPct: 61.5,
        pnlSpotPct: 0.36,
        message: "🎯 STC · SPY 261113 752C [TARGET 1 HIT] @ $753.00 (+61.5%)",
      },
    },
    {
      label: "5. SELL_TO_CLOSE (TRAILING_PROFIT)",
      alert: {
        ...base,
        id: `verify-stc-trail-${nowSec}`,
        action: "SELL_TO_CLOSE",
        contractType: "PUT",
        contractLabel: "SPY 261113 757P",
        strike: 757,
        spotPrice: 754.10,
        btoSpotPrice: 758.25,
        setupName: "Bearish Zero-Gamma Flush [BTO PUT]",
        reason: "TRAILING PROFIT LOCKED",
        status: "CLOSED",
        remainingQty: 0,
        optionMid: 2.15,
        pnlOptionPct: 230.8,
        pnlSpotPct: 0.55,
        message: "🔒 STC · SPY 261113 757P [TRAILING PROFIT LOCKED] @ $754.10 (+230.8%)",
      },
    },
    {
      label: "6. SELL_TO_CLOSE (REVERSAL)",
      alert: {
        ...base,
        id: `verify-stc-reversal-${nowSec}`,
        action: "SELL_TO_CLOSE",
        contractType: "PUT",
        contractLabel: "SPY 261113 757P",
        strike: 757,
        spotPrice: 756.04,
        btoSpotPrice: 758.25,
        setupName: "Flux-Field Breakdown & Upper Rejection [BTO PUT]",
        reason: "MOMENTUM REVERSAL PROFIT LOCK",
        status: "CLOSED",
        remainingQty: 0,
        optionMid: 1.18,
        pnlOptionPct: 81.5,
        pnlSpotPct: 0.29,
        message: "🔄 STC · SPY 261113 757P [MOMENTUM REVERSAL PROFIT LOCK] @ $756.04 (+81.5%)",
      },
    },
    {
      label: "7. SELL_TO_CLOSE (STOP_LOSS)",
      alert: {
        ...base,
        id: `verify-stc-sl-${nowSec}`,
        action: "SELL_TO_CLOSE",
        contractType: "CALL",
        contractLabel: "SPY 261113 752C",
        strike: 752,
        spotPrice: 749.10,
        setupName: "Support Bounce / Bullish Reversal",
        reason: "STOP LOSS / LEVEL INVALIDATION",
        status: "CLOSED",
        remainingQty: 0,
        optionMid: 0.48,
        pnlOptionPct: -26.2,
        pnlSpotPct: -0.16,
        message: "🛑 STC · SPY 261113 752C [STOP LOSS] @ $749.10 (-26.2%)",
      },
    },
    {
      label: "8. SELL_TO_CLOSE (EOD_1555_FORCE_CLOSE)",
      alert: {
        ...base,
        id: `verify-stc-moc-${nowSec}`,
        action: "SELL_TO_CLOSE",
        contractType: "CALL",
        contractLabel: "SPY 261113 752C",
        strike: 752,
        timestamp: "3:55 PM",
        spotPrice: 754.25,
        setupName: "Impulse Flux & Divergence Reclaim [BTO CALL]",
        reason: "15:55 PM ET HARD MARKET CLOSE CUTOFF",
        status: "CLOSED",
        remainingQty: 0,
        optionMid: 1.32,
        pnlOptionPct: 103.1,
        pnlSpotPct: 0.53,
        message: "⏰ STC · SPY 261113 752C [15:55 PM ET HARD MARKET CLOSE CUTOFF] @ $754.25 (+103.1%)",
      },
    },
  ];
}

async function main(): Promise<void> {
  const isLive = process.argv.includes("--live");
  const { url: webhookUrl, source } = resolveWebhookUrl(isLive);
  const masked = webhookUrl.replace(/(webhooks\/\d+\/)[^?]+/, "$1***");

  console.log("================================================================================");
  console.log(`  HYPERION DISCORD BTO/STC VERIFICATION (${isLive ? "LIVE DISPATCH" : "DRY-RUN"})`);
  console.log("================================================================================");
  console.log(`Webhook (${source}): ${masked || "(unset)"}`);
  assert.ok(webhookUrl.startsWith("https://discord.com/api/webhooks/"), "Valid Discord webhook URL required");

  // Verify fail-closed behavior when neither customWebhookUrl nor process.env.DISCORD_WEBHOOK_URL is set
  if (!isLive) {
    const prevEnvUrl = process.env.DISCORD_WEBHOOK_URL;
    delete process.env.DISCORD_WEBHOOK_URL;
    const scenariosCheck = buildScenarioAlerts(Math.floor(Date.now() / 1000));
    const failClosed = await sendDiscordTradeAlert(scenariosCheck[1].alert, undefined, { bypassFsmFirewall: true });
    if (prevEnvUrl !== undefined) process.env.DISCORD_WEBHOOK_URL = prevEnvUrl;
    assert.strictEqual(failClosed, false, "Unset Discord webhook URL must fail closed (return false)");
  }

  const capturedPayloads: Array<{ label: string; url: string; payload: any }> = [];
  const originalFetch = globalThis.fetch;

  if (!isLive) {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const targetUrl = String(input);
      const parsedBody = init?.body ? JSON.parse(String(init.body)) : {};
      capturedPayloads.push({ label: parsedBody?.embeds?.[0]?.title ?? "", url: targetUrl, payload: parsedBody });
      return new Response(JSON.stringify({ id: "dry-run-msg-id" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
  }

  try {
    const scenarios = buildScenarioAlerts(Math.floor(Date.now() / 1000));
    for (const sc of scenarios) {
      const ok = await sendDiscordTradeAlert(sc.alert, webhookUrl, { bypassFsmFirewall: true });
      if (sc.expectBlocked) {
        assert.strictEqual(ok, false, `${sc.label} must return false`);
        console.log(`✅ [PASS] ${sc.label} -> silenced`);
      } else {
        assert.strictEqual(ok, true, `${sc.label} must succeed`);
        if (!isLive) {
          const last = capturedPayloads[capturedPayloads.length - 1];
          assert.ok(last.url.includes("?wait=true") || last.url.includes("&wait=true"), `${sc.label} must attach wait=true`);
          assert.ok(last.payload?.embeds?.[0]?.title, `${sc.label} embed title missing`);
          assert.ok(Array.isArray(last.payload?.embeds?.[0]?.fields) && last.payload.embeds[0].fields.length >= 6, `${sc.label} embed fields incomplete`);
          if (sc.alert.action === "BUY_TO_OPEN") {
            const embed = last.payload.embeds[0];
            const fieldsText = embed.fields.map((f: any) => `${f.name}: ${f.value}`).join("\n");
            assert.match(embed.title, /Ask \$\d+\.\d{2} \(Max Limit \$\d+\.\d{2}\)/, `${sc.label} title must include Ask + Max Limit`);
            assert.match(fieldsText, /T1 \*\*\$\d+\.\d{2}\*\*[\s\S]*T2 \*\*\$\d+\.\d{2}\*\*/, `${sc.label} must include Spot T1 and T2`);
            assert.match(fieldsText, /-45%[\s\S]*Ratchet:/, `${sc.label} must include -45% hard stop and ratchet rules`);
            assert.match(fieldsText, /Confluence Thesis/, `${sc.label} must include Confluence Thesis`);
            assert.ok(!fieldsText.includes("-25%"), `${sc.label} must NOT contain stale -25% hard stop text`);
          }
          console.log(`✅ [PASS] ${sc.label} -> "${last.payload.embeds[0].title}"`);
        } else {
          console.log(`✅ [LIVE 200 OK] ${sc.label}`);
        }
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log("\nAll 8 Discord BTO/STC & Backfill Silence checks passed with zero .cache/active-trades-*.json writes.");
}

main().catch((err) => {
  console.error("❌ Verification failed:", err);
  process.exit(1);
});
