import { NextRequest, NextResponse } from "next/server";

interface DiscordAlertRequestBody {
  webhookUrl?: string;
  ticker?: string;
  spotPrice?: number;
  eventType?: string; // 'call' | 'put' | 'zero' | 'king' | 'test'
  message?: string;
  callWall?: number;
  putWall?: number;
  zeroGamma?: number;
  allExpKing?: number;
}

export async function POST(req: NextRequest) {
  try {
    const body: DiscordAlertRequestBody = await req.json();
    const webhookUrl =
      (body.webhookUrl && body.webhookUrl.trim().length > 0
        ? body.webhookUrl.trim()
        : process.env.DISCORD_WEBHOOK_URL)?.trim();

    if (!webhookUrl) {
      return NextResponse.json(
        { error: "No Discord Webhook URL configured or provided." },
        { status: 400 }
      );
    }

    const ticker = body.ticker || "SPY";
    const spot = body.spotPrice ?? 0;
    const eventType = body.eventType || "alert";
    const message = body.message || `${ticker} gamma alert`;
    const callWall = body.callWall ?? 0;
    const putWall = body.putWall ?? 0;
    const zeroGamma = body.zeroGamma ?? 0;
    const allExpKing = body.allExpKing ?? 0;

    // Discord Embed Colors (decimal integers)
    // 0x11cdef (Cyan = 1166831) for Call
    // 0xf5365c (Pink/Red = 16069980) for Put
    // 0xfbbf24 (Amber/Yellow = 16498468) for Zero Gamma / King
    // 0x5e72e4 (Indigo = 6189796) for General / Test
    let embedColor = 6189796;
    if (eventType === "call") embedColor = 1166831;
    else if (eventType === "put") embedColor = 16069980;
    else if (eventType === "zero" || eventType === "king") embedColor = 16498468;

    const payload = {
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
              value: eventType.toUpperCase(),
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
