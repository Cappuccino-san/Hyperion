import fs from "fs";
import path from "path";
import type { OptionTradePosition } from "./execution/types";
import { loadTradeStore, saveTradeStore } from "./execution/ledgerCommit";
import { getTodayEt, getSessionBoundsEt } from "./gaiaSessionGuards";
import { getNowEtTime } from "./execution/optionPricing";
import { computeTradeRealizedPnl } from "./execution/pnlAccounting";
import { getPersistenceCacheDir } from "./persistenceStore";
import { isValidDiscordWebhookUrl } from "./discordWebhook";

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
  exitQuoteSource?: string;
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
  return getPersistenceCacheDir();
}

function firstPositiveNum(...vals: unknown[]): number | undefined {
  for (const v of vals) {
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  }
  return undefined;
}

function firstFiniteNum(...vals: unknown[]): number | undefined {
  for (const v of vals) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}

/**
 * Compiles a structured Daily Performance Report from the day's closed positions
 */
export function generateDailyPerformanceReport(date?: string): DailyPerformanceReport {
  const targetDate = date || getTodayEt();
  let store = loadTradeStore(targetDate);
  if (store.date !== targetDate) {
    try {
      const dayPath = path.join(getCacheDir(), `active-trades-${targetDate}.json`);
      if (fs.existsSync(dayPath)) {
        const parsed = JSON.parse(fs.readFileSync(dayPath, "utf-8"));
        if (parsed && parsed.date === targetDate) {
          store = parsed;
        }
      }
    } catch {
      // Non-fatal fallback
    }
  }

  const closedPositions: OptionTradePosition[] =
    store.date === targetDate && Array.isArray(store.closedPositions) ? store.closedPositions : [];

  const tradeItems: TradePerformanceItem[] = closedPositions.map((p) => {
    const pnl = computeTradeRealizedPnl(p);
    const entryPrice = pnl.entryPrice;
    const exitPrice = pnl.exitPrice;
    const qty = pnl.contractsQty;
    const totalOutlay = pnl.outlay;
    const realizedDollarPnl = pnl.realizedDollarPnl;
    const pnlOptionPct = pnl.pnlOptionPct;
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
      btoOptionMid: Number(entryPrice.toFixed(2)),
      closedOptionMid: Number(exitPrice.toFixed(2)),
      contractsQty: qty,
      totalOutlay,
      realizedDollarPnl,
      pnlOptionPct,
      pnlSpotPct,
      exitReason: p.exitReason || "Closed",
      exitQuoteSource: p.exitQuoteSource,
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
    md += `| # | Ticker | Contract | Time | Entry Ask | Exit Bid | PnL ($) | PnL (%) | Reason |\n`;
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
  const dir = getCacheDir();
  const jsonPath = path.join(dir, `daily-performance-${report.date}.json`);
  const mdPath = path.join(dir, `daily-performance-${report.date}.md`);
  const suffix = `.tmp.${process.pid}.${Date.now()}`;
  const jsonTmp = `${jsonPath}${suffix}`;
  const mdTmp = `${mdPath}${suffix}`;
  try {
    fs.writeFileSync(jsonTmp, JSON.stringify(report, null, 2), "utf-8");
    fs.renameSync(jsonTmp, jsonPath);
    fs.writeFileSync(mdTmp, report.markdownReport, "utf-8");
    fs.renameSync(mdTmp, mdPath);
  } catch {
    // ignore filesystem write errors in read-only runtimes
  } finally {
    try {
      if (fs.existsSync(jsonTmp)) fs.unlinkSync(jsonTmp);
    } catch {}
    try {
      if (fs.existsSync(mdTmp)) fs.unlinkSync(mdTmp);
    } catch {}
  }
}

/**
 * Dispatches an organized Daily Performance Summary embed to the Discord webhook
 */
export async function sendDailyPerformanceDiscordRecap(
  report: DailyPerformanceReport,
  customWebhookUrl?: string,
  options?: { signal?: AbortSignal; isHistoricalBackfill?: boolean }
): Promise<boolean> {
  if (options?.isHistoricalBackfill) {
    return false;
  }
  const webhookUrl =
    (customWebhookUrl || process.env.DISCORD_WEBHOOK_URL)?.trim() || "";
  if (!webhookUrl) {
    console.warn("[TradePerformanceEngine] Skipping daily recap Discord dispatch: DISCORD_WEBHOOK_URL is not configured.");
    return false;
  }
  if (!isValidDiscordWebhookUrl(webhookUrl)) {
    console.warn("[TradePerformanceEngine] Rejecting invalid Discord webhook URL.");
    return false;
  }
  if (options?.signal?.aborted) {
    return false;
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options?.signal?.addEventListener("abort", onAbort, { once: true });
  const timeoutId = setTimeout(() => controller.abort(), 8_000);

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
        return `${itemEmoji} **Trade #${idx + 1} · ${t.ticker} ${t.contractType}S** (\`${t.contractLabel}\`)\n• Entry: ${t.openedAt} @ Ask $${t.btoOptionMid.toFixed(2)} → Exit: ${t.closedAt} @ Bid $${t.closedOptionMid.toFixed(2)}\n• PnL: **${sign}$${t.realizedDollarPnl.toFixed(2)} (${sign}${t.pnlOptionPct.toFixed(1)}%)** · *${t.exitReason}*`;
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
      signal: controller.signal,
    });

    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutId);
    options?.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Checks if market is closed (ET >= 4:00 PM / 16:00) and triggers the daily recap if not already sent.
 * STRICT ENFORCEMENT: Never dispatches to Discord before 16:00 ET.
 */
export async function checkAndSendMarketCloseRecap(
  params?: {
    webhookUrl?: string;
    force?: boolean;
    date?: string;
    signal?: AbortSignal;
    isHistoricalBackfill?: boolean;
  },
  options?: {
    signal?: AbortSignal;
    isHistoricalBackfill?: boolean;
    date?: string;
  }
): Promise<DailyPerformanceReport | null> {
  const signal = params?.signal ?? options?.signal;
  if (signal?.aborted) {
    return null;
  }
  const targetDate = params?.date ?? options?.date;
  const todayEt = getTodayEt();
  const isHistoricalBackfill =
    params?.isHistoricalBackfill ??
    options?.isHistoricalBackfill ??
    Boolean(targetDate && targetDate !== todayEt);

  const store = loadTradeStore(targetDate);
  const etTime = getNowEtTime();
  const bounds = getSessionBoundsEt(targetDate || store.date || todayEt);

  // STRICT RULE: Absolutely NO End-of-Day recap prior to official RTH close (16:00 ET / 13:00 ET early close)
  const isMarketClosed = etTime.totalMinutes >= bounds.rthCloseMins;
  if (!isMarketClosed && !params?.force) {
    return null;
  }

  // If after market close and already sent official EOD recap, don't duplicate
  if ((store as any).eodRecapSent && !params?.force) {
    return null;
  }

  const report = generateDailyPerformanceReport(targetDate || store.date);
  saveDailyPerformanceReport(report);

  if (!isHistoricalBackfill) {
    await sendDailyPerformanceDiscordRecap(report, params?.webhookUrl, {
      signal,
      isHistoricalBackfill,
    });
  }

  // Reload latest trade store post-await before persisting flags so concurrent updates aren't clobbered
  if (store.date === todayEt) {
    const latestStore = loadTradeStore();
    if (isMarketClosed) {
      (latestStore as any).eodRecapSent = true;
    }
    latestStore.dailyRecapSent = true;
    saveTradeStore(latestStore);
  }

  // Trigger 16:05 ET Post-Market Attribution only when real intraday bars exist (never poison with bars: [])
  const isPostAttributionCutoff = etTime.hours > 16 || (etTime.hours === 16 && etTime.minutes >= 5);
  if (isPostAttributionCutoff && !isHistoricalBackfill) {
    try {
      const sessionTargetDate = targetDate || store.date;
      const { getMergedIntradayHistory } = await import("./intradayHistory");
      const ticks = getMergedIntradayHistory("SPY", sessionTargetDate);
      if (ticks.length >= 6) {
        const bucketMap = new Map<number, typeof ticks>();
        for (const tick of ticks) {
          const bucket = Math.floor(tick.ts / 300) * 300;
          if (!bucketMap.has(bucket)) bucketMap.set(bucket, []);
          bucketMap.get(bucket)!.push(tick);
        }
        const bars = Array.from(bucketMap.entries())
          .sort((a, b) => a[0] - b[0])
          .map(([bucketTs, group]) => ({
            ts: bucketTs,
            open: group[0].spot,
            high: Math.max(...group.map((g) => g.spot)),
            low: Math.min(...group.map((g) => g.spot)),
            close: group[group.length - 1].spot,
          }));
        if (bars.length >= 6) {
          const { computeBarFlowGammaVwapSeries } = await import("./flowGammaVwap");
          const { runPostMarketAttribution } = await import("./agenticSupervisor");
          const flowSeries = computeBarFlowGammaVwapSeries(
            bars.map((b) => ({
              timestamp: b.ts,
              open: b.open,
              high: b.high,
              low: b.low,
              close: b.close,
            }))
          );
          const lastTick = ticks[ticks.length - 1];
          await runPostMarketAttribution({
            sessionDate: sessionTargetDate,
            ticker: "SPY",
            bars,
            flowSeries,
            callWall: lastTick?.callWall || lastTick?.cw,
            putWall: lastTick?.putWall || lastTick?.pw,
            zeroGamma: lastTick?.zeroGamma || lastTick?.zg,
            zeroDteKing: lastTick?.king,
            executedTrades: store.closedPositions,
          });
        }
      }
    } catch {
      // Non-fatal post-market attribution
    }
  }

  return report;
}
