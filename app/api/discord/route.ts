import { NextRequest, NextResponse } from "next/server";
import { isValidDiscordWebhookUrl } from "@/lib/discordWebhook";

interface CachedEvent {
  timestamp: number;
}
const dispatchedAlertsCache = new Map<string, CachedEvent>();

interface DiscordAlertRequestBody {
  webhookUrl?: string;
  dryRun?: boolean;
  action?: "BUY_TO_OPEN" | "SELL_TO_CLOSE";
  eventType?: string; // 'bto' | 'stc' | 'buy_to_open' | 'sell_to_close' | 'call' | 'put' | 'zero' | 'king' | 'test'
  isHistoricalBackfill?: boolean;
  eventId?: string;

  // Sub-$1.00 Small Account BTO / STC Fields
  ticker?: string;
  contractType?: "CALL" | "PUT";
  contractLabel?: string;
  strike?: number;
  expiration?: string;
  expHuman?: string;
  robinhoodExp?: string;
  robinhoodTab?: string;
  optionBid?: number;
  optionAsk?: number;
  setupName?: string;
  reason?: string;
  status?: "OPEN" | "PARTIAL_TP1" | "CLOSED";
  spotPrice?: number;
  btoSpotPrice?: number;
  target1Spot?: number;
  target2Spot?: number;
  stopLossSpot?: number;
  optionMid?: number | null;
  btoOptionMid?: number | null;
  contractsQty?: 1 | 2;
  remainingQty?: 0 | 1 | 2;
  totalOutlay?: number;
  estTp1Mid?: number;
  estTp2Mid?: number;
  estStopMid?: number;
  tp1Pct?: number;
  tp2Pct?: number;
  pnlSpotPct?: number;
  pnlOptionPct?: number;
  rrRatio?: number;
  altContractNote?: string;
  openedAt?: string;
  timestamp?: string;

  // Legacy Structure Fields
  message?: string;
  callWall?: number;
  putWall?: number;
  zeroGamma?: number;
  allExpKing?: number;
}

export async function POST(req: NextRequest) {
  try {
    const body: DiscordAlertRequestBody = await req.json();

    // 1. Strict Backfill Firewall: NEVER dispatch historical replay/backfill signals to Discord
    if (body.isHistoricalBackfill) {
      return NextResponse.json({
        ignored: true,
        reason: "Historical backfill signals are strictly silenced from live Discord dispatch.",
      });
    }

    // 2. Webhook Idempotency & Deduplication Guard (stamped only after HTTP 2xx)
    if (body.eventId) {
      const nowMs = Date.now();
      const existing = dispatchedAlertsCache.get(body.eventId);
      if (existing && nowMs - existing.timestamp < 3600_000) {
        return NextResponse.json({
          ignored: true,
          reason: "Duplicate eventId already dispatched.",
        });
      }
    }
    const webhookUrl =
      (body.webhookUrl && body.webhookUrl.trim().length > 0
        ? body.webhookUrl.trim()
        : process.env.DISCORD_WEBHOOK_URL?.trim()) || "";

    if (!body.dryRun && !webhookUrl) {
      return NextResponse.json(
        { error: "No Discord Webhook URL configured (DISCORD_WEBHOOK_URL unset)." },
        { status: 400 }
      );
    }

    if (webhookUrl && !isValidDiscordWebhookUrl(webhookUrl)) {
      return NextResponse.json(
        { error: "Invalid Discord Webhook URL; official HTTPS discord.com webhook required." },
        { status: 400 }
      );
    }

    const ticker = (body.ticker || "SPY").trim().toUpperCase();
    const spot = body.spotPrice ?? 0;
    const eventType = (body.eventType || "").toLowerCase();
    const action = body.action || (eventType === "bto" || eventType === "buy_to_open"
      ? "BUY_TO_OPEN"
      : eventType === "stc" || eventType === "sell_to_close"
        ? "SELL_TO_CLOSE"
        : undefined);

    if ((action === "BUY_TO_OPEN" || action === "SELL_TO_CLOSE") && (!Number.isFinite(spot) || spot <= 0)) {
      return NextResponse.json(
        { error: "Invalid trade alert payload: positive spotPrice is required." },
        { status: 400 }
      );
    }

    let payload: any;

    if (action === "BUY_TO_OPEN") {
      // ----------------------------------------------------------------------
      // 1. BUY TO OPEN (BTO) Execution Embed (Sub-$1.00 Small Account)
      // ----------------------------------------------------------------------
      const contractType = body.contractType || "CALL";
      const isCalls = contractType === "CALL";
      const contractLabel = body.contractLabel || `${ticker} ${contractType}`;
      const setupName = body.setupName || "System Setup";
      const btoSpot = body.btoSpotPrice ?? spot;
      const t1 = body.target1Spot ?? spot;
      const t2 = body.target2Spot ?? t1;
      const sl = body.stopLossSpot ?? spot;
      const openedAt = body.openedAt || body.timestamp || "Now";

      const mid = body.btoOptionMid ?? 0.55;
      const qty = body.contractsQty ?? 1;
      const totalRisk = body.totalOutlay ?? Number((mid * 100 * qty).toFixed(0));

      // Color: Emerald Green (0x10b981) for CALLS, Electric Violet (0x8b5cf6) for PUTS
      const embedColor = isCalls ? 0x10b981 : 0x8b5cf6;
      const emoji = isCalls ? "🟢" : "🟣";

      const rrVal =
        body.rrRatio ??
        (Math.abs(t1 - btoSpot) / Math.max(0.01, Math.abs(btoSpot - sl)));

      const bid = body.optionBid ?? (mid > 0.05 ? mid - 0.01 : mid);
      const ask = body.optionAsk ?? mid;
      const maxChaseLimit = Math.min(
        0.99,
        Number((ask + Math.max(0.03, ask * 0.05)).toFixed(2))
      );
      const hardStop45 = Number(Math.max(0.01, ask * 0.55).toFixed(2));
      const estTp1 = body.estTp1Mid
        ? `T1 **$${t1.toFixed(2)}** (~$${body.estTp1Mid.toFixed(2)} / +${body.tp1Pct ?? 45}%)`
        : `T1 **$${t1.toFixed(2)}**`;

      const estTp2 = body.estTp2Mid
        ? `T2 **$${t2.toFixed(2)}** (~$${body.estTp2Mid.toFixed(2)} / +${body.tp2Pct ?? 100}%)`
        : `T2 **$${t2.toFixed(2)}**`;

      const estStop = `Hard Stop **$${hardStop45.toFixed(2)} (-45%)** or Spot **$${sl.toFixed(2)}** · Ratchet: +30%→BE, +60%→+25%, +100%→Trail`;
      const expTabStr = body.robinhoodTab || body.robinhoodExp || body.expHuman || body.expiration;
      const optSuffix = isCalls ? "C" : "P";

      payload = {
        username: "Hyperion Terminal",
        embeds: [
          {
            author: {
              name: "Hyperion Sub-$1.00 Options Engine (1 Contract Max)",
            },
            title: `${emoji} BTO ${qty}x ${ticker} ${body.strike ?? ""}${optSuffix} @ Ask $${ask.toFixed(2)} (Max Limit $${maxChaseLimit.toFixed(2)})`,
            description: `**Setup:** ${setupName}\n${
              body.altContractNote ? `⚠️ *${body.altContractNote}*\n` : ""
            }**Contract:** \`${contractLabel}\``,
            color: embedColor,
            fields: [
              {
                name: "🎟️ Contract & Robinhood Tab",
                value: `**${ticker} $${body.strike ?? ""} ${contractType}**\n📅 Exp: **${body.expHuman || body.expiration || "Today"}**\n👉 **Robinhood Tab:** \`${expTabStr}\``,
                inline: true,
              },
              {
                name: "💵 Live Market Quote",
                value: `Bid: **$${bid.toFixed(2)}** | Ask: **$${ask.toFixed(2)}**\nMid: **$${mid.toFixed(2)}** ($${(mid * 100).toFixed(0)}/contract)`,
                inline: true,
              },
              {
                name: "📦 Small Acct Size",
                value: `**${qty} Contract${qty > 1 ? "s" : ""}** ($${totalRisk} Total Outlay)`,
                inline: true,
              },
              {
                name: "🎯 Underlying Entry",
                value: `$${btoSpot.toFixed(2)}`,
                inline: true,
              },
              {
                name: "⚖️ Estimated R:R",
                value: `**${rrVal.toFixed(2)}:1**`,
                inline: true,
              },
              {
                name: "🛑 Underlying Stop",
                value: `$${sl.toFixed(2)}`,
                inline: true,
              },
              {
                name: "💰 Option TP1 / TP2 Est.",
                value: `${estTp1} | ${estTp2}`,
                inline: false,
              },
              {
                name: "🛑 Option Hard Stop",
                value: estStop,
                inline: true,
              },
              {
                name: "⏰ Opened At",
                value: `${openedAt} ET`,
                inline: true,
              },
            ],
            timestamp: new Date().toISOString(),
            footer: {
              text: "Hyperion · Sub-$1.00 Small Account Options Engine (1 Contract Max)",
            },
          },
        ],
      };
    } else if (action === "SELL_TO_CLOSE") {
      // ----------------------------------------------------------------------
      // 2. SELL TO CLOSE (STC) Execution Embed (Canonical Taxonomy & Correct Math)
      // ----------------------------------------------------------------------
      const contractType = body.contractType || "CALL";
      const isCalls = contractType === "CALL";
      const contractLabel = body.contractLabel || `${ticker} ${contractType}`;
      const setupName = body.setupName || "Open Position";
      const reason = body.reason || "Exit Triggered";
      const reasonUpper = reason.toUpperCase();
      const btoSpot = body.btoSpotPrice ?? spot;
      const contractsQty = body.contractsQty ?? 1;

      let pnlOptionPct = body.pnlOptionPct ?? 0;
      if (body.btoOptionMid != null && body.optionMid != null) {
        if (body.pnlOptionPct == null) {
          pnlOptionPct = Number(
            (((body.optionMid - body.btoOptionMid) / Math.max(0.01, body.btoOptionMid)) * 100).toFixed(1)
          );
        }
      }
      const isWin = pnlOptionPct >= 0;

      let embedColor = isWin ? 0x10b981 : 0xef4444; // Green for win, Red for loss
      let resultWord = isWin ? "CLOSED IN PROFIT" : "CLOSED AT LOSS";
      let resultEmoji = isWin ? "💰" : "🛑";

      if (reasonUpper.includes("TARGET 2") || reasonUpper.includes("FULL")) {
        resultWord = "TAKE PROFIT HIT";
        resultEmoji = "💰";
        embedColor = 0x10b981;
      } else if (reasonUpper.includes("TARGET 1") || reasonUpper.includes("TP1") || reasonUpper.includes("TAKE PROFIT")) {
        resultWord = "TAKE PROFIT HIT";
        resultEmoji = "💰";
        embedColor = 0x10b981;
      } else if (
        reasonUpper.includes("REVERSAL") ||
        reasonUpper.includes("FLIP") ||
        reasonUpper.includes("DIVERGENCE") ||
        reasonUpper.includes("SCRATCH")
      ) {
        resultWord = isWin ? "REVERSAL PROFIT LOCK" : "REGIME PROTECT EXIT";
        resultEmoji = isWin ? "🔒" : "🔄";
        embedColor = isWin ? 0x10b981 : 0x3b82f6;
      } else if (reasonUpper.includes("TRAIL") || reasonUpper.includes("PROFIT LOCK") || reasonUpper.includes("RATCHET") || reasonUpper.includes("LOCK PROFIT")) {
        resultWord = "TRAILING PROFIT LOCKED";
        resultEmoji = "💰";
        embedColor = 0x10b981;
      } else if (
        reasonUpper.includes("15:55") ||
        reasonUpper.includes("3:55") ||
        reasonUpper.includes("3:50") ||
        reasonUpper.includes("EOD") ||
        reasonUpper.includes("CUTOFF") ||
        reasonUpper.includes("MARKET CLOSE")
      ) {
        resultWord = isWin ? "3:55 PM EOD PROFIT EXIT" : "3:55 PM EOD CUTOFF";
        resultEmoji = isWin ? "💰" : "⏰";
        embedColor = isWin ? 0x10b981 : 0xf59e0b;
      } else if (reasonUpper.includes("BREAKEVEN")) {
        resultWord = "BREAKEVEN STOP";
        resultEmoji = "⚪";
        embedColor = 0x94a3b8;
      } else {
        resultWord = isWin ? "TRAILING STOP EXIT" : "STOP LOSS HIT";
        resultEmoji = isWin ? "💰" : "🛑";
        embedColor = isWin ? 0x10b981 : 0xef4444;
      }

      const title = `${resultEmoji} SELL TO CLOSE (${resultWord}) - ${ticker} ${contractType}S`;

      // Directional Underlying Math
      const rawSpotDiff = spot - btoSpot;
      const spotMovePct = ((spot - btoSpot) / Math.max(0.01, btoSpot)) * 100;
      const directionalPts = isCalls ? rawSpotDiff : -rawSpotDiff;
      const directionalLabel =
        directionalPts >= 0
          ? `+${directionalPts.toFixed(2)} pts favorable to ${contractType}`
          : `${directionalPts.toFixed(2)} pts adverse to ${contractType}`;
      const spotMoveStr = `${spotMovePct >= 0 ? "+" : ""}${spotMovePct.toFixed(2)}% (${rawSpotDiff >= 0 ? "+" : ""}${rawSpotDiff.toFixed(2)} pts | ${directionalLabel})`;

      let optionPnlStr = "N/A";
      if (body.btoOptionMid != null && body.optionMid != null) {
        optionPnlStr = `$${body.btoOptionMid.toFixed(2)} → $${body.optionMid.toFixed(2)} (${
          pnlOptionPct >= 0 ? "+" : ""
        }${pnlOptionPct.toFixed(1)}%)`;
      }

      const positionActionStr = `100% Position Closed (${contractsQty} Contract)`;
      const execTime = body.timestamp || body.openedAt || "Now";

      payload = {
        username: "Hyperion Terminal",
        embeds: [
          {
            author: {
              name: "Hyperion 1-Contract Sniper Execution Engine",
            },
            title,
            description: `**Contract:** \`${contractLabel}\` · **Setup:** ${setupName}\n**Exit Action:** ${reason}`,
            color: embedColor,
            fields: [
              {
                name: "🎯 Underlying Exit",
                value: `$${spot.toFixed(2)}`,
                inline: true,
              },
              {
                name: "🏁 Entry Spot",
                value: `$${btoSpot.toFixed(2)}`,
                inline: true,
              },
              {
                name: "📉 Spot Move",
                value: spotMoveStr,
                inline: false,
              },
              {
                name: "💵 Option Premium",
                value: optionPnlStr,
                inline: true,
              },
              {
                name: "📦 Position Action",
                value: positionActionStr,
                inline: true,
              },
              {
                name: "⏰ Execution Time",
                value: `${execTime} ET`,
                inline: true,
              },
            ],
            timestamp: new Date().toISOString(),
            footer: {
              text: `Hyperion · 1-Contract Sniper Engine · Exec ${execTime} ET`,
            },
          },
        ],
      };
    } else {
      // ----------------------------------------------------------------------
      // 3. Legacy Gamma / Structure Alert Embed (Silenced in favor of Trade Signals)
      // ----------------------------------------------------------------------
      if (eventType !== "test") {
        return NextResponse.json({
          ignored: true,
          message:
            "Legacy structure alerts silenced. Discord webhook exclusively delivers BUY TO OPEN and SELL TO CLOSE trade signals.",
        });
      }

      const message = body.message || `${ticker} gamma alert`;
      const callWall = body.callWall ?? 0;
      const putWall = body.putWall ?? 0;
      const zeroGamma = body.zeroGamma ?? 0;
      const allExpKing = body.allExpKing ?? 0;

      const embedColor = 6189796; // Indigo for Test Verification

      payload = {
        username: "Hyperion Terminal",
        embeds: [
          {
            author: {
              name: "Hyperion Terminal",
            },
            title: `⚡ ${ticker} Structure Alert`,
            description: `**${message}**`,
            color: embedColor,
            fields: [
              {
                name: "Spot Price",
                value: `$${spot.toFixed(2)}`,
                inline: true,
              },
              {
                name: "Call Wall",
                value: `$${callWall.toFixed(0)}`,
                inline: true,
              },
              {
                name: "Put Wall",
                value: `$${putWall.toFixed(0)}`,
                inline: true,
              },
              {
                name: "Zero γ Flip",
                value: `$${zeroGamma.toFixed(2)}`,
                inline: true,
              },
              {
                name: "All-Exp King",
                value: `$${allExpKing.toFixed(0)}`,
                inline: true,
              },
              {
                name: "Event Type",
                value: (eventType || "ALERT").toUpperCase(),
                inline: true,
              },
            ],
            timestamp: new Date().toISOString(),
            footer: {
              text: "Hyperion · Real-Time Gamma & King Node Alerts",
            },
          },
        ],
      };
    }

    if (body.dryRun) {
      return NextResponse.json({
        success: true,
        dryRun: true,
        validated: true,
        action: action || eventType || "TEST",
        timestamp: new Date().toISOString(),
      });
    }

    // Post to Discord with HTTP 429 Retry-After backoff (max 2 retries)
    let discordRes: Response | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      discordRes = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(8_000),
      });
      if (discordRes.status !== 429 || attempt === 2) {
        break;
      }
      const headerRetry = Number(discordRes.headers.get("retry-after") ?? 0);
      let bodyRetryMs = 0;
      try {
        const rateJson = await discordRes.json();
        if (typeof rateJson?.retry_after === "number" && Number.isFinite(rateJson.retry_after)) {
          bodyRetryMs = rateJson.retry_after > 50 ? rateJson.retry_after : rateJson.retry_after * 1000;
        }
      } catch {
        // Fallback to exponential backoff
      }
      const waitMs = Math.min(
        4000,
        Math.max(300, bodyRetryMs || (headerRetry > 0 ? headerRetry * 1000 : 500 * Math.pow(2, attempt)))
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    if (!discordRes || !discordRes.ok) {
      const errText = discordRes ? await discordRes.text() : "No response";
      return NextResponse.json(
        { error: `Discord Webhook error: ${errText || discordRes?.statusText || "HTTP error"}` },
        { status: discordRes?.status ?? 502 }
      );
    }

    if (body.eventId) {
      dispatchedAlertsCache.set(body.eventId, { timestamp: Date.now() });
      if (dispatchedAlertsCache.size > 2000) {
        const oldestKey = dispatchedAlertsCache.keys().next().value;
        if (oldestKey) dispatchedAlertsCache.delete(oldestKey);
      }
    }

    return NextResponse.json({ success: true, timestamp: new Date().toISOString() });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Internal server error: ${errorMsg}` },
      { status: 500 }
    );
  }
}
