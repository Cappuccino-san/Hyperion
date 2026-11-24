import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { readHistoricalSessions, getPersistenceCacheDir } from "@/lib/persistenceStore";
import { computeTradeRealizedPnl } from "@/lib/execution/pnlAccounting";
import { getSessionBoundsEt } from "@/lib/gaiaSessionGuards";
import { optionsMemoryCache } from "@/lib/marketCache";

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
        const pnl = computeTradeRealizedPnl(p);
        const qty = pnl.contractsQty;
        const entryPx = pnl.entryPrice;
        const exitPx = pnl.exitPrice;
        const outlay = pnl.outlay;
        const realizedDollarPnl = pnl.realizedDollarPnl;
        const pnlOptionPct = pnl.pnlOptionPct;
        const rMultiple = pnl.rMultiple;

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

function buildLiveStructuralRecapTickers(dayIso: string, cacheDir: string) {
  const result: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const intradayPath = path.join(cacheDir, `intraday-${dayIso}.json`);

  const countMoves = (vals: number[]): number => {
    let moves = 0;
    let prev: number | null = null;
    for (const v of vals) {
      if (!Number.isFinite(v) || v <= 0) continue;
      if (prev !== null && Math.abs(v - prev) > 0.01) moves++;
      prev = v;
    }
    return moves;
  };

  if (fs.existsSync(intradayPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(intradayPath, "utf-8"));
      const tickersMap = parsed?.tickers ?? {};
      for (const [symRaw, entry] of Object.entries(tickersMap)) {
        const sym = symRaw.toUpperCase();
        const tEntry = entry as {
          rthHistory?: Array<{ ts: number; spot: number; cw?: number; pw?: number; zg?: number; callWall?: number; putWall?: number; zeroGamma?: number; king?: number }>;
          history?: Array<{ ts: number; spot: number; cw?: number; pw?: number; zg?: number; callWall?: number; putWall?: number; zeroGamma?: number; king?: number }>;
        };
        const pts = (tEntry?.rthHistory?.length ? tEntry.rthHistory : tEntry?.history) ?? [];
        if (pts.length === 0) continue;
        seen.add(sym);

        const first = pts[0];
        const last = pts[pts.length - 1];
        const cached = optionsMemoryCache.get(sym)?.payload;
        const cws = pts.map((p) => p.callWall || p.cw || 0).filter((v) => v > 0);
        const pws = pts.map((p) => p.putWall || p.pw || 0).filter((v) => v > 0);
        const zgs = pts.map((p) => p.zeroGamma || p.zg || 0).filter((v) => v > 0);
        const kings = pts.map((p) => p.king || 0).filter((v) => v > 0);

        const closePx = cached?.spotPrice ?? last.spot;
        const prevClose = cached?.previousClose ?? first.spot;
        const nextCw = cached?.gammaLevelsByFilter?.["0DTE"]?.callWall ?? cached?.gammaLevels?.callWall ?? (cws[cws.length - 1] || null);
        const nextPw = cached?.gammaLevelsByFilter?.["0DTE"]?.putWall ?? cached?.gammaLevels?.putWall ?? (pws[pws.length - 1] || null);
        const nextZg = cached?.gammaLevelsByFilter?.["0DTE"]?.zeroGamma ?? cached?.gammaLevels?.zeroGamma ?? (zgs[zgs.length - 1] || null);
        const nextGk = cached?.kingNode?.allExpKing ?? (kings[kings.length - 1] || 0);
        const dailyEm = cached?.expectedMoves?.daily;

        result.push({
          label: sym,
          symbol: sym,
          as_of: dayIso,
          prev_close: prevClose,
          open: first.spot,
          close: closePx,
          session: {
            tracked: true,
            first_ts: first.ts,
            gk: {
              start: kings[0] ?? (nextGk || null),
              end: kings[kings.length - 1] ?? (nextGk || null),
              moves: countMoves(kings),
            },
            cw: {
              open: cws[0] ?? null,
              close: cws[cws.length - 1] ?? null,
              moves: countMoves(cws),
            },
            pw: {
              open: pws[0] ?? null,
              close: pws[pws.length - 1] ?? null,
              moves: countMoves(pws),
            },
            zg: {
              open: zgs[0] ?? null,
              close: zgs[zgs.length - 1] ?? null,
            },
          },
          next: {
            date: dayIso,
            ...(nextGk > 0 ? { gk: [nextGk, cached?.kingNode?.kingValue ?? 0] } : {}),
            cw: nextCw,
            pw: nextPw,
            zg: nextZg,
            ...(dailyEm
              ? {
                  em: {
                    exp: dailyEm.exp,
                    atm: Math.round(closePx),
                    move: dailyEm.em,
                    low: dailyEm.low,
                    high: dailyEm.high,
                  },
                }
              : {}),
          },
        });
      }
    } catch {
      // Non-fatal malformed intraday cache
    }
  }

  // Also include warm core tickers from optionsMemoryCache not yet in intraday history
  for (const sym of ["SPY", "QQQ", "IWM", "SPXW"]) {
    if (seen.has(sym)) continue;
    const cached = optionsMemoryCache.get(sym)?.payload;
    if (!cached || cached.strikes.length === 0) continue;
    const dailyEm = cached.expectedMoves?.daily;
    result.push({
      label: sym,
      symbol: sym,
      as_of: dayIso,
      prev_close: cached.previousClose,
      open: cached.previousClose,
      close: cached.spotPrice,
      session: {
        tracked: true,
        gk: { start: cached.kingNode.allExpKing, end: cached.kingNode.allExpKing, moves: 0 },
        cw: { open: cached.gammaLevels.callWall, close: cached.gammaLevels.callWall, moves: 0 },
        pw: { open: cached.gammaLevels.putWall, close: cached.gammaLevels.putWall, moves: 0 },
        zg: { open: cached.gammaLevels.zeroGamma, close: cached.gammaLevels.zeroGamma },
      },
      next: {
        date: dayIso,
        gk: [cached.kingNode.allExpKing, cached.kingNode.kingValue ?? 0],
        cw: cached.gammaLevelsByFilter?.["0DTE"]?.callWall ?? cached.gammaLevels.callWall,
        pw: cached.gammaLevelsByFilter?.["0DTE"]?.putWall ?? cached.gammaLevels.putWall,
        zg: cached.gammaLevelsByFilter?.["0DTE"]?.zeroGamma ?? cached.gammaLevels.zeroGamma,
        ...(dailyEm
          ? {
              em: {
                exp: dailyEm.exp,
                atm: Math.round(cached.spotPrice),
                move: dailyEm.em,
                low: dailyEm.low,
                high: dailyEm.high,
              },
            }
          : {}),
      },
    });
  }

  return result;
}

function computeNextTradingDayIso(fromIso: string): string {
  const m = fromIso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return fromIso;
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  for (let i = 1; i <= 10; i++) {
    const cand = new Date(dt.getTime() + i * 86_400_000);
    const iso = cand.toISOString().slice(0, 10);
    if (getSessionBoundsEt(iso).isTradingDay) {
      return iso;
    }
  }
  return fromIso;
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const rawDay =
      searchParams.get("day")?.trim() ||
      searchParams.get("date")?.trim() ||
      "";
    const requestedDay = /^\d{4}-\d{2}-\d{2}$/.test(rawDay) ? rawDay : "";

    const portfolio = await buildRollingPortfolioSummary();
    const cacheDir = getPersistenceCacheDir();

    const latestDay =
      requestedDay ||
      portfolio.daysWithTrades[portfolio.daysWithTrades.length - 1] ||
      new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

    // Synthesize live structural recap directly from Hyperion's intraday ledger + closing options book
    const liveTickers = buildLiveStructuralRecapTickers(latestDay, cacheDir);

    // Optional explicit SESSION_RECAP_PATH override (no silent offline terrashade fallback)
    if (liveTickers.length === 0 && process.env.SESSION_RECAP_PATH) {
      const envPath = path.resolve(process.env.SESSION_RECAP_PATH);
      if (fs.existsSync(envPath)) {
        const parsed = JSON.parse(fs.readFileSync(envPath, "utf-8"));
        if (!requestedDay || parsed?.day === requestedDay || parsed?.recap?.day === requestedDay) {
          return NextResponse.json(
            { ...parsed, portfolio },
            { headers: { "Cache-Control": "no-store" } }
          );
        }
      }
    }

    return NextResponse.json(
      {
        days: portfolio.daysWithTrades.length > 0 ? portfolio.daysWithTrades : [latestDay],
        day: latestDay,
        recap: {
          day: latestDay,
          built_at: Math.floor(Date.now() / 1000),
          next_date: computeNextTradingDayIso(latestDay),
          tickers: liveTickers,
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
