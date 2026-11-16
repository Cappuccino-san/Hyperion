import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { readHistoricalSessions, getPersistenceCacheDir } from "@/lib/persistenceStore";

export const dynamic = "force-dynamic";

export interface PortfolioTradeRow {
  id: string;
  date: string;
  ticker: string;
  contractType: "CALL" | "PUT";
  contractLabel: string;
  setupName: string;
  openedAt: string;
  closedAt: string;
  openedTs: number;
  closedTs: number;
  entryOptionPrice: number;
  exitOptionPrice: number;
  contractsQty: number;
  outlay: number;
  realizedDollarPnl: number;
  pnlOptionPct: number;
  rMultiple: number;
  exitReason: string;
}

export interface PortfolioDailyRow {
  date: string;
  trades: number;
  wins: number;
  losses: number;
  netDollarPnl: number;
  equityAfter: number;
}

export interface PortfolioRecapSummary {
  windowDays: number;
  daysWithTrades: string[];
  totalTrades: number;
  wins: number;
  losses: number;
  breakevens: number;
  winRatePct: number;
  cumulativeDollarPnl: number;
  totalCapitalOutlay: number;
  profitFactor: number | null;
  maxDrawdown: number;
  expectancyR: number;
  rDistribution: Array<{ label: string; count: number }>;
  equityCurve: Array<{
    index: number;
    date: string;
    ticker: string;
    contractLabel: string;
    tradePnl: number;
    equity: number;
    rMultiple: number;
  }>;
  dailyBreakdown: PortfolioDailyRow[];
  trades: PortfolioTradeRow[];
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

async function buildRollingPortfolioSummary(): Promise<PortfolioRecapSummary> {
  const sessions = await readHistoricalSessions(7);
  const trades: PortfolioTradeRow[] = [];
  const dailyBreakdown: PortfolioDailyRow[] = [];

  let runningEquity = 0;
  for (const parsed of sessions) {
    const fileDate = parsed.date;
    try {
      const closed = Array.isArray(parsed?.closedPositions) ? parsed.closedPositions : [];
      let dayWins = 0;
      let dayLosses = 0;
      let dayPnl = 0;

      for (const p of closed) {
        const raw = p as unknown as Record<string, unknown>;
        const qty = Number(p.contractsQty) || 1;
        const entryPx =
          firstPositiveNum(
            raw.btoOptionAsk,
            p.optionAsk,
            raw.btoPrice,
            p.btoOptionMid,
            raw.btoMid
          ) ?? 0.5;
        const exitPx =
          firstFiniteNum(raw.closedOptionBid, raw.stcPrice, p.closedOptionMid) ?? 0;
        const outlay =
          entryPx > 0
            ? Number((entryPx * 100 * qty).toFixed(2))
            : Number(p.totalOutlay ?? 0);
        const realizedDollarPnl = Number(
          (
            firstFiniteNum(raw.realizedPnlDollars, raw.pnlDollars) ??
            (exitPx - entryPx) * 100 * qty
          ).toFixed(2)
        );
        const pnlOptionPct = Number(
          (
            firstFiniteNum(p.pnlOptionPct, raw.realizedPnlPct) ??
            (entryPx > 0 ? ((exitPx - entryPx) / entryPx) * 100 : 0)
          ).toFixed(1)
        );
        const riskDollars = Math.max(10, outlay * 0.25);
        const rMultiple = Number(
          (firstFiniteNum(raw.realizedR) ?? realizedDollarPnl / riskDollars).toFixed(2)
        );

        if (realizedDollarPnl > 0) dayWins++;
        else if (realizedDollarPnl < 0) dayLosses++;
        dayPnl += realizedDollarPnl;

        trades.push({
          id: String(p.id || `${fileDate}-${p.ticker || "SPY"}-${trades.length}`),
          date: fileDate,
          ticker: String(p.ticker || "SPY").toUpperCase(),
          contractType: p.contractType === "PUT" ? "PUT" : "CALL",
          contractLabel: String(p.contractLabel || raw.optionSymbol || ""),
          setupName: String(p.setupName || ""),
          openedAt: String(p.openedAt || "—"),
          closedAt: String(p.closedAt || "—"),
          openedTs: Number(p.openedTs || 0),
          closedTs: Number(p.closedTs || 0),
          entryOptionPrice: Number(entryPx.toFixed(2)),
          exitOptionPrice: Number(exitPx.toFixed(2)),
          contractsQty: qty,
          outlay: Math.round(outlay),
          realizedDollarPnl,
          pnlOptionPct,
          rMultiple,
          exitReason: String(p.exitReason || "Closed"),
        });
      }

      runningEquity = Number((runningEquity + dayPnl).toFixed(2));
      dailyBreakdown.push({
        date: fileDate,
        trades: closed.length,
        wins: dayWins,
        losses: dayLosses,
        netDollarPnl: Number(dayPnl.toFixed(2)),
        equityAfter: runningEquity,
      });
    } catch {
      // Skip malformed session records so healthy sessions remain visible
    }
  }

  trades.sort((a, b) => (a.closedTs || a.openedTs) - (b.closedTs || b.openedTs));

  let cumulativePnl = 0;
  let peakEquity = 0;
  let maxDrawdown = 0;
  let grossGains = 0;
  let grossLosses = 0;
  let wins = 0;
  let losses = 0;
  let breakevens = 0;

  const equityCurve = trades.map((t, idx) => {
    cumulativePnl = Number((cumulativePnl + t.realizedDollarPnl).toFixed(2));
    if (cumulativePnl > peakEquity) peakEquity = cumulativePnl;
    maxDrawdown = Math.max(maxDrawdown, Number((peakEquity - cumulativePnl).toFixed(2)));
    if (t.realizedDollarPnl > 0) {
      wins++;
      grossGains += t.realizedDollarPnl;
    } else if (t.realizedDollarPnl < 0) {
      losses++;
      grossLosses += Math.abs(t.realizedDollarPnl);
    } else {
      breakevens++;
    }
    return {
      index: idx + 1,
      date: t.date,
      ticker: t.ticker,
      contractLabel: t.contractLabel,
      tradePnl: t.realizedDollarPnl,
      equity: cumulativePnl,
      rMultiple: t.rMultiple,
    };
  });

  const rDistribution = [
    { label: "<= -1.0R", count: trades.filter((t) => t.rMultiple <= -1.0).length },
    { label: "-1.0R..0R", count: trades.filter((t) => t.rMultiple > -1.0 && t.rMultiple < 0).length },
    { label: "0R..+1.0R", count: trades.filter((t) => t.rMultiple >= 0 && t.rMultiple < 1.0).length },
    { label: "+1.0R..+2.0R", count: trades.filter((t) => t.rMultiple >= 1.0 && t.rMultiple < 2.0).length },
    { label: ">= +2.0R", count: trades.filter((t) => t.rMultiple >= 2.0).length },
  ];

  const totalTrades = trades.length;
  const winRatePct = totalTrades > 0 ? Number(((wins / totalTrades) * 100).toFixed(1)) : 0;
  const profitFactor =
    grossLosses > 0
      ? Number((grossGains / grossLosses).toFixed(2))
      : grossGains > 0
        ? 999
        : null;
  const expectancyR =
    totalTrades > 0
      ? Number((trades.reduce((s, t) => s + t.rMultiple, 0) / totalTrades).toFixed(2))
      : 0;

  return {
    windowDays: 7,
    daysWithTrades: dailyBreakdown.map((d) => d.date),
    totalTrades,
    wins,
    losses,
    breakevens,
    winRatePct,
    cumulativeDollarPnl: cumulativePnl,
    totalCapitalOutlay: trades.reduce((s, t) => s + t.outlay, 0),
    profitFactor,
    maxDrawdown,
    expectancyR,
    rDistribution,
    equityCurve,
    dailyBreakdown,
    trades: [...trades].reverse(),
  };
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const rawDay = searchParams.get("day")?.trim() || "";
    const requestedDay = /^\d{4}-\d{2}-\d{2}$/.test(rawDay) ? rawDay : "";

    const portfolio = await buildRollingPortfolioSummary();
    const cacheDir = getPersistenceCacheDir();
    const possiblePaths = [
      ...(requestedDay
        ? [
            path.resolve(process.cwd(), `scratch/terrashade/api_recap_${requestedDay}.json`),
            path.join(cacheDir, `terrashade/api_recap_${requestedDay}.json`),
          ]
        : []),
      path.resolve(process.cwd(), "scratch/terrashade/api_recap.json"),
      path.join(cacheDir, "terrashade/api_recap.json"),
      ...(process.env.SESSION_RECAP_PATH ? [path.resolve(process.env.SESSION_RECAP_PATH)] : []),
    ];

    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        const parsed = JSON.parse(fs.readFileSync(p, "utf-8"));
        if (!requestedDay || parsed?.day === requestedDay || parsed?.recap?.day === requestedDay) {
          return NextResponse.json(
            { ...parsed, portfolio },
            { headers: { "Cache-Control": "no-store" } }
          );
        }
      }
    }

    const latestDay =
      requestedDay ||
      portfolio.daysWithTrades[portfolio.daysWithTrades.length - 1] ||
      new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

    return NextResponse.json(
      {
        days: portfolio.daysWithTrades.length > 0 ? portfolio.daysWithTrades : [latestDay],
        day: latestDay,
        recap: {
          day: latestDay,
          built_at: Math.floor(Date.now() / 1000),
          next_date: latestDay,
          tickers: [],
        },
        portfolio,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Recap error" },
      { status: 500 }
    );
  }
}
