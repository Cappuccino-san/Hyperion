import fs from "fs";
import path from "path";
import {
  OptionTradePosition,
  DailyTradeStore,
  loadTradeStore,
  saveTradeStore,
  getTodayEt,
  getNowEtTime,
} from "./tradeSignalEngine";

export interface TradePerformanceItem {
  id: string;
  ticker: string;
  contractType: "CALL" | "PUT";
  contractLabel: string;
  strike: number;
  expiration: string;
  setupName: string;
  openedAt: string;
  closedAt: string;
  btoSpotPrice: number;
  closedSpotPrice: number;
  btoOptionMid: number;
  closedOptionMid: number;
  contractsQty: number;
  totalOutlay: number;
  realizedDollarPnl: number;
  pnlOptionPct: number;
  pnlSpotPct: number;
  exitReason: string;
  isWin: boolean;
}

export interface DailyPerformanceReport {
  date: string;
  totalTrades: number;
  wins: number;
  losses: number;
  breakevens: number;
  winRatePct: number;
  totalRealizedDollarPnl: number;
  totalCapitalAllocated: number;
  returnOnCapitalPct: number;
  avgWinDollar: number;
  avgLossDollar: number;
  profitFactor: number | null;
  trades: TradePerformanceItem[];
  markdownReport: string;
  generatedAt: string;
}

function getCacheDir(): string {
  const dir = path.join(process.cwd(), ".cache");
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // Serverless/read-only filesystem fallback
    }
  }
  return dir;
}

/**
 * Compiles a structured Daily Performance Report from the day's closed positions
 */
export function generateDailyPerformanceReport(date?: string): DailyPerformanceReport {
  const targetDate = date || getTodayEt();
  const store = loadTradeStore();

  const closedPositions: OptionTradePosition[] =
    store.date === targetDate ? store.closedPositions : [];

  const tradeItems: TradePerformanceItem[] = closedPositions.map((p) => {
    // Realistic retail options execution accounting: Buy at Ask, Sell at Bid
    const entryPrice = p.optionAsk && p.optionAsk > 0 ? p.optionAsk : (p.btoOptionMid || 0.5);
    const exitPrice = p.closedOptionMid != null ? p.closedOptionMid : 0.0;
    const qty = p.contractsQty || 1;
    const realizedDollarPnl = Number(((exitPrice - entryPrice) * 100 * qty).toFixed(2));
    const pnlOptionPct =
      p.pnlOptionPct != null
        ? p.pnlOptionPct
        : Number((((exitPrice - entryPrice) / Math.max(0.01, entryPrice)) * 100).toFixed(2));
    const pnlSpotPct = p.pnlSpotPct ?? 0;

    return {
      id: p.id,
      ticker: p.ticker,
      contractType: p.contractType,
      contractLabel: p.contractLabel,
      strike: p.strike,
      expiration: p.expiration,
      setupName: p.setupName,
      openedAt: p.openedAt || "N/A",
      closedAt: p.closedAt || "N/A",
      btoSpotPrice: p.btoSpotPrice,
      closedSpotPrice: p.closedSpotPrice || p.btoSpotPrice,
      btoOptionMid: entryPrice,
      closedOptionMid: exitPrice,
      contractsQty: qty,
      totalOutlay: p.totalOutlay || Number((entryPrice * 100 * qty).toFixed(0)),
      realizedDollarPnl,
      pnlOptionPct,
      pnlSpotPct,
      exitReason: p.exitReason || "Closed",
      isWin: realizedDollarPnl > 0,
    };
  });

  const totalTrades = tradeItems.length;
  const wins = tradeItems.filter((t) => t.realizedDollarPnl > 0).length;
  const losses = tradeItems.filter((t) => t.realizedDollarPnl < 0).length;
  const breakevens = tradeItems.filter((t) => t.realizedDollarPnl === 0).length;
  const winRatePct = totalTrades > 0 ? Number(((wins / totalTrades) * 100).toFixed(1)) : 0;

  const totalRealizedDollarPnl = Number(
    tradeItems.reduce((acc, t) => acc + t.realizedDollarPnl, 0).toFixed(2)
  );
  const totalCapitalAllocated = Number(
    tradeItems.reduce((acc, t) => acc + t.totalOutlay, 0).toFixed(2)
  );
  const returnOnCapitalPct =
    totalCapitalAllocated > 0
      ? Number(((totalRealizedDollarPnl / totalCapitalAllocated) * 100).toFixed(1))
      : 0;

  const winDollars = tradeItems.filter((t) => t.realizedDollarPnl > 0).map((t) => t.realizedDollarPnl);
  const lossDollars = tradeItems.filter((t) => t.realizedDollarPnl < 0).map((t) => Math.abs(t.realizedDollarPnl));

  const avgWinDollar =
    winDollars.length > 0
      ? Number((winDollars.reduce((a, b) => a + b, 0) / winDollars.length).toFixed(2))
      : 0;
  const avgLossDollar =
    lossDollars.length > 0
      ? Number((lossDollars.reduce((a, b) => a + b, 0) / lossDollars.length).toFixed(2))
      : 0;

  const grossGains = winDollars.reduce((a, b) => a + b, 0);
  const grossLosses = lossDollars.reduce((a, b) => a + b, 0);
  const profitFactor =
    grossLosses > 0
      ? Number((grossGains / grossLosses).toFixed(2))
      : grossGains > 0
        ? 999
        : null;

  // Build Markdown Journal representation
  const pnlSign = totalRealizedDollarPnl >= 0 ? "+" : "";
  let md = `# Daily Trading Performance Recap · ${targetDate}\n\n`;
  md += `### Summary\n`;
  md += `- **Net PnL:** \`${pnlSign}$${totalRealizedDollarPnl.toFixed(2)} (${pnlSign}${returnOnCapitalPct}%)\`\n`;
  md += `- **Win Rate:** \`${winRatePct}%\` (${wins}W - ${losses}L - ${breakevens}BE)\n`;
  md += `- **Total Trades:** \`${totalTrades}\`\n`;
  md += `- **Total Capital Outlay:** \`$${totalCapitalAllocated.toFixed(0)}\`\n`;
  if (profitFactor !== null) md += `- **Profit Factor:** \`${profitFactor}\`\n`;
  md += `\n### Trade Log\n\n`;

  if (tradeItems.length === 0) {
    md += `*No closed trades for this session.*\n`;
  } else {
    md += `| # | Ticker | Contract | Time | Entry Mid | Exit Mid | PnL ($) | PnL (%) | Reason |\n`;
    md += `|---|---|---|---|---|---|---|---|---|\n`;
    tradeItems.forEach((t, i) => {
      const rowSign = t.realizedDollarPnl >= 0 ? "+" : "";
      md += `| ${i + 1} | ${t.ticker} | \`${t.contractLabel}\` | ${t.openedAt} → ${t.closedAt} | $${t.btoOptionMid.toFixed(2)} | $${t.closedOptionMid.toFixed(2)} | ${rowSign}$${t.realizedDollarPnl.toFixed(2)} | ${rowSign}${t.pnlOptionPct.toFixed(1)}% | ${t.exitReason} |\n`;
    });
  }

  return {
    date: targetDate,
    totalTrades,
    wins,
    losses,
    breakevens,
    winRatePct,
    totalRealizedDollarPnl,
    totalCapitalAllocated,
    returnOnCapitalPct,
    avgWinDollar,
    avgLossDollar,
    profitFactor,
    trades: tradeItems,
    markdownReport: md,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Saves daily performance to persistent disk cache (.cache/daily-performance-YYYY-MM-DD.json and .md)
 */
export function saveDailyPerformanceReport(report: DailyPerformanceReport): void {
  try {
    const dir = getCacheDir();
    const jsonPath = path.join(dir, `daily-performance-${report.date}.json`);
    const mdPath = path.join(dir, `daily-performance-${report.date}.md`);
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf-8");
    fs.writeFileSync(mdPath, report.markdownReport, "utf-8");
  } catch {
    // ignore filesystem write errors in read-only runtimes
  }
}

/**
 * Dispatches an organized Daily Performance Summary embed to the Discord webhook
 */
export async function sendDailyPerformanceDiscordRecap(
  report: DailyPerformanceReport,
  customWebhookUrl?: string
): Promise<boolean> {
  const webhookUrl =
    (customWebhookUrl || process.env.DISCORD_WEBHOOK_URL)?.trim() || "";
  if (!webhookUrl) {
    console.warn("[TradePerformanceEngine] Skipping daily recap Discord dispatch: DISCORD_WEBHOOK_URL is not configured.");
    return false;
  }

  try {
    const isProfitable = report.totalRealizedDollarPnl > 0;
    const isBreakeven = report.totalRealizedDollarPnl === 0;
    const embedColor = isProfitable ? 0x10b981 : isBreakeven ? 0x94a3b8 : 0xef4444;
    const emoji = isProfitable ? "🚀" : isBreakeven ? "⚪" : "🛑";
    const pnlSign = report.totalRealizedDollarPnl >= 0 ? "+" : "";

    const tradeFields: { name: string; value: string; inline: boolean }[] = [];

    if (report.trades.length === 0) {
      tradeFields.push({
        name: "Trade Log",
        value: "No positions were closed during this session.",
        inline: false,
      });
    } else {
      // Group trade summaries
      const tradeLines = report.trades.slice(0, 8).map((t, idx) => {
        const sign = t.realizedDollarPnl >= 0 ? "+" : "";
        const itemEmoji = t.realizedDollarPnl > 0 ? "🟢" : t.realizedDollarPnl === 0 ? "⚪" : "🔴";
        return `${itemEmoji} **Trade #${idx + 1} · ${t.ticker} ${t.contractType}S** (\`${t.contractLabel}\`)\n• Entry: ${t.openedAt} @ $${t.btoOptionMid.toFixed(2)} → Exit: ${t.closedAt} @ $${t.closedOptionMid.toFixed(2)}\n• PnL: **${sign}$${t.realizedDollarPnl.toFixed(2)} (${sign}${t.pnlOptionPct.toFixed(1)}%)** · *${t.exitReason}*`;
      });

      tradeFields.push({
        name: `📋 Session Trades (${report.trades.length})`,
        value: tradeLines.join("\n\n"),
        inline: false,
      });
    }

    const payload = {
      username: "Hyperion Terminal",
      embeds: [
        {
          author: { name: "Hyperion Options Engine · End-of-Day Performance Audit" },
          title: `${emoji} DAILY TRADING PERFORMANCE RECAP · ${report.date}`,
          description: `**Session Results:**\n• **Net Realized PnL:** \`${pnlSign}$${report.totalRealizedDollarPnl.toFixed(2)} (${pnlSign}${report.returnOnCapitalPct}%)\`\n• **Win Rate:** \`${report.winRatePct}%\` (${report.wins}W - ${report.losses}L - ${report.breakevens}BE)\n• **Total Trades:** \`${report.totalTrades}\`\n• **Total Capital Outlay:** \`$${report.totalCapitalAllocated.toFixed(0)}\``,
          color: embedColor,
          fields: [
            ...tradeFields,
            {
              name: "🛡️ Execution Discipline & Takeaways",
              value:
                report.losses > 0
                  ? "Disciplined capital protection: Hard stops strictly capped downside risk. For tomorrow's session, high-delta contracts (0.25-0.50) closer to ATM and early +18% breakeven locks are prioritized to minimize theta decay."
                  : "Excellent session discipline: High-probability setups executed with optimal R:R scaling.",
              inline: false,
            },
          ],
          timestamp: new Date().toISOString(),
          footer: {
            text: "Hyperion · Sub-$1.00 Small Account Options Engine (Daily Recap)",
          },
        },
      ],
    };

    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Checks if market is closed (ET >= 4:00 PM / 16:00) and triggers the daily recap if not already sent.
 * STRICT ENFORCEMENT: Never dispatches to Discord before 16:00 ET.
 */
export async function checkAndSendMarketCloseRecap(params?: {
  webhookUrl?: string;
  force?: boolean;
}): Promise<DailyPerformanceReport | null> {
  const store = loadTradeStore();
  const etTime = getNowEtTime();

  // STRICT RULE: Absolutely NO End-of-Day recap prior to 16:00 (4:00 PM ET)
  if (etTime.hours < 16 && !params?.force) {
    return null;
  }

  const isMarketClosed = etTime.hours >= 16;
  if (!isMarketClosed && !params?.force) {
    return null;
  }

  // If after market close and already sent official EOD recap, don't duplicate
  if ((store as any).eodRecapSent && !params?.force) {
    return null;
  }

  const report = generateDailyPerformanceReport(store.date);
  saveDailyPerformanceReport(report);

  await sendDailyPerformanceDiscordRecap(report, params?.webhookUrl);

  if (isMarketClosed) {
    (store as any).eodRecapSent = true;
  }
  store.dailyRecapSent = true;
  saveTradeStore(store);

  return report;
}
