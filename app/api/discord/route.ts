import { NextRequest, NextResponse } from "next/server";

const DEFAULT_DISCORD_WEBHOOK_URL =
  "https://discord.com/api/webhooks/1562857850676449411/Qza12VWuPoBlek12-6o7V6fc2EscYDjIQrKw7KJyfB8Y3i9VAMvU7OJH0m7joqUH5arx";

interface CachedEvent {
  timestamp: number;
}
const dispatchedAlertsCache = new Map<string, CachedEvent>();

export interface DiscordAlertRequestBody {
  webhookUrl?: string;
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

    // 2. Webhook Idempotency & Deduplication Guard
    if (body.eventId) {
      const nowMs = Date.now();
      const existing = dispatchedAlertsCache.get(body.eventId);
      if (existing && nowMs - existing.timestamp < 3600_000) {
        return NextResponse.json({
          ignored: true,
          reason: "Duplicate eventId already dispatched.",
        });
      }
      dispatchedAlertsCache.set(body.eventId, { timestamp: nowMs });
      if (dispatchedAlertsCache.size > 2000) {
        const oldestKey = dispatchedAlertsCache.keys().next().value;
        if (oldestKey) dispatchedAlertsCache.delete(oldestKey);
      }
    }
    const webhookUrl =
      (body.webhookUrl && body.webhookUrl.trim().length > 0
        ? body.webhookUrl.trim()
        : process.env.DISCORD_WEBHOOK_URL)?.trim() || DEFAULT_DISCORD_WEBHOOK_URL;

    if (!webhookUrl) {
      return NextResponse.json(
        { error: "No Discord Webhook URL configured or provided." },
        { status: 400 }
      );
    }

    const ticker = body.ticker || "SPY";
    const spot = body.spotPrice ?? 0;
    const eventType = (body.eventType || "").toLowerCase();
    const action = body.action || (eventType === "bto" || eventType === "buy_to_open"
      ? "BUY_TO_OPEN"
      : eventType === "stc" || eventType === "sell_to_close"
        ? "SELL_TO_CLOSE"
        : undefined);

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
      const t2 = body.target2Spot ?? spot;
      const sl = body.stopLossSpot ?? spot;
      const openedAt = body.openedAt || body.timestamp || "Now";

      const mid = body.btoOptionMid ?? 0.55;
      const qty = body.contractsQty ?? (mid <= 0.5 ? 2 : 1);
      const totalRisk = body.totalOutlay ?? Number((mid * 100 * qty).toFixed(0));

      // Color: Emerald Green (0x10b981) for CALLS, Electric Violet (0x8b5cf6) for PUTS
      const embedColor = isCalls ? 0x10b981 : 0x8b5cf6;
      const emoji = isCalls ? "🟢" : "🟣";

      const rrVal =
        body.rrRatio ??
        (Math.abs(t1 - btoSpot) / Math.max(0.01, Math.abs(btoSpot - sl)));

      const estTp1 = body.estTp1Mid
        ? `TP1 ~$${body.estTp1Mid.toFixed(2)} (+${body.tp1Pct ?? 45}%)`
        : `TP1 ~$${(mid * 1.5).toFixed(2)} (+50%)`;

      const estTp2 = body.estTp2Mid
        ? `TP2 ~$${body.estTp2Mid.toFixed(2)} (+${body.tp2Pct ?? 110}%)`
        : `TP2 ~$${(mid * 2.2).toFixed(2)} (+120%)`;

      const estStop = body.estStopMid
        ? `$${body.estStopMid.toFixed(2)} (-25% max or Spot $${sl.toFixed(2)})`
        : `$${(mid * 0.75).toFixed(2)} (-25% max or Spot $${sl.toFixed(2)})`;

      const bid = body.optionBid ?? (mid > 0.05 ? mid - 0.01 : mid);
      const ask = body.optionAsk ?? mid + 0.01;
      const expTabStr = body.robinhoodTab || body.robinhoodExp || body.expHuman || body.expiration;

      payload = {
        username: "Hyperion Terminal",
        embeds: [
          {
            author: {
              name: "Hyperion Sub-$1.00 Options Engine (1-2 Contracts Max)",
            },
            title: `${emoji} BUY TO OPEN · ${ticker} ${contractType}S (${qty}x @ $${mid.toFixed(2)})`,
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
              text: "Hyperion · Sub-$1.00 Small Account Options Engine (1-2 Contracts Max)",
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
      let exitBadge = "🏁 POSITION CLOSED";
      let resultWord = isWin ? "CLOSED IN PROFIT" : "CLOSED AT LOSS";
      let resultEmoji = isWin ? "💰" : "🛑";

      if (reasonUpper.includes("TARGET 2") || reasonUpper.includes("FULL")) {
        exitBadge = "🎯 TARGET 2 SMASHED";
        resultWord = "TAKE PROFIT HIT";
        resultEmoji = "💰";
        embedColor = 0x10b981;
      } else if (reasonUpper.includes("TARGET 1") || reasonUpper.includes("TP1") || reasonUpper.includes("TAKE PROFIT")) {
        exitBadge = "🎯 TARGET 1 HIT";
        resultWord = "TAKE PROFIT HIT";
        resultEmoji = "💰";
        embedColor = 0x10b981;
      } else if (reasonUpper.includes("TRAIL") || reasonUpper.includes("PROFIT LOCK") || reasonUpper.includes("RATCHET") || reasonUpper.includes("LOCK PROFIT")) {
        exitBadge = "🛡️ TRAILING PROFIT LOCKED";
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
        exitBadge = "⏰ 3:55 PM EOD MARKET CLOSE CUTOFF";
        resultWord = isWin ? "3:55 PM EOD PROFIT EXIT" : "3:55 PM EOD CUTOFF";
        resultEmoji = isWin ? "💰" : "⏰";
        embedColor = isWin ? 0x10b981 : 0xf59e0b;
      } else if (reasonUpper.includes("REVERSAL") || reasonUpper.includes("FLIP")) {
        exitBadge = "🔄 REGIME FLIP EXIT";
        resultWord = isWin ? "REGIME PROFIT EXIT" : "REGIME PROTECT EXIT";
        resultEmoji = isWin ? "💰" : "🔄";
        embedColor = isWin ? 0x10b981 : 0x3b82f6;
      } else if (reasonUpper.includes("BREAKEVEN")) {
        exitBadge = "⚪ BREAKEVEN STOP";
        resultWord = "BREAKEVEN STOP";
        resultEmoji = "⚪";
        embedColor = 0x94a3b8;
      } else {
        exitBadge = "🛑 STOP LOSS HIT";
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

    const discordRes = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!discordRes.ok) {
      const errText = await discordRes.text();
      return NextResponse.json(
        { error: `Discord Webhook error: ${errText || discordRes.statusText}` },
        { status: discordRes.status }
      );
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
