/**
 * On-Chart Trade Execution Markers & PnL Badges Renderer
 *
 * Plots live and closed quantitative engine trades (`BTO` and `STC`) directly onto
 * the candlestick canvas (`GaiaView.tsx`).
 *
 * Layers Rendered:
 * 1. Trade Trajectory Line:
 *    - Dotted connector line (`[4, 4]`) from Entry `(entryX, priceToY(btoSpotPrice))`
 *      to Exit `(exitX, priceToY(closedSpotPrice))` (or live bar if still `OPEN`).
 * 2. BTO Entry Markers (The Sniper Shot):
 *    - SHORT / PUT: Downward-pointing Crimson Red (`#ef4444`) triangle directly above
 *      the entry candle's high wick, with a crisp `BTO PUT` pill label.
 *    - LONG / CALL: Upward-pointing Emerald Green (`#10b981`) triangle directly below
 *      the entry candle's low wick, with a crisp `BTO CALL` pill label.
 * 3. STC Exit Markers & PnL Badges (The Cover / Take Profit):
 *    - Corresponding exit triangle on the closing candle.
 *    - Glowing PnL Badge pill right next to the `STC` marker:
 *      - Profitable (`pnlOptionPct >= 0`): `rgba(16, 185, 129, 0.2)` fill, `#10b981` border/text
 *      - Loss (`pnlOptionPct < 0`): `rgba(239, 68, 68, 0.2)` fill, `#ef4444` border/text
 */

export interface ChartCandleLike {
  timestamp?: number;
  timeLabel?: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface ServerTradesState {
  activePositions?: Record<string, any>;
  closedPositions?: any[];
  alerts?: any[];
  loaded?: boolean;
}

export interface NormalizedChartTrade {
  id: string;
  ticker: string;
  contractType: "CALL" | "PUT";
  status: "OPEN" | "CLOSED";
  setupName: string;
  btoSpotPrice: number;
  openedAt?: string;
  openedTs?: number;
  closedSpotPrice?: number;
  closedAt?: string;
  closedTs?: number;
  pnlOptionPct?: number;
  exitReason?: string;
}

export interface DrawTradeExecutionMarkersOptions {
  ctx: CanvasRenderingContext2D;
  ticker: string;
  candles: ChartCandleLike[];
  safeActiveIdx: number;
  barToX: (barIdx: number) => number;
  priceToY: (price: number) => number;
  serverTrades?: ServerTradesState | null;
  fsmSignals?: any[];
  precomputedTrades?: NormalizedChartTrade[];
  padLeft?: number;
  plotRightX?: number;
  padTop?: number;
  plotBottomY?: number;
}

/**
 * Parses a time label like "9:35 AM", "09:35 AM", "10:55 AM", or "14:15" into
 * minutes since midnight ET (e.g. 9*60 + 35 = 575).
 */
export function parseTimeLabelToMinutes(label?: string): number | null {
  if (!label || typeof label !== "string") return null;
  const trimmed = label.trim();
  const match = trimmed.match(/(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*(AM|PM)?/i);
  if (!match) return null;
  let hours = parseInt(match[1], 10);
  const mins = match[2] ? parseInt(match[2], 10) : 0;
  if (Number.isNaN(hours) || Number.isNaN(mins)) return null;
  const meridiem = (match[3] || "").toUpperCase();
  if (meridiem === "PM" && hours < 12) hours += 12;
  if (meridiem === "AM" && hours === 12) hours = 0;
  if (hours < 0 || hours >= 24 || mins < 0 || mins >= 60) return null;
  return hours * 60 + mins;
}

/**
 * Matches a trade event timestamp (`tsSeconds` and/or `timeLabel`) to the best
 * candle index in `candles`.
 */
export function matchTradeToCandleIndex(
  candles: ChartCandleLike[],
  tsSeconds?: number,
  timeLabel?: string
): number {
  // Verify ts matches explicit ET timeLabel so chart markers never drift from [ CALL LOG ]
  // Canonical 5m floor bucket alignment so 9:49 AM snaps to the 9:45 AM 5m candle across both canvases
  if (!candles || candles.length === 0) return -1;

  // Estimate bar interval in seconds by sampling candle intervals (default 300s = 5m)
  let barStepSec = 300;
  if (candles.length >= 2) {
    const intervals: number[] = [];
    const limit = Math.min(candles.length - 1, 10);
    for (let k = 0; k < limit; k++) {
      const rawDt0 = candles[k].timestamp || 0;
      const rawDt1 = candles[k + 1].timestamp || 0;
      const dt0 = rawDt0 > 1e11 ? Math.floor(rawDt0 / 1000) : rawDt0;
      const dt1 = rawDt1 > 1e11 ? Math.floor(rawDt1 / 1000) : rawDt1;
      const step = Math.abs(dt1 - dt0);
      if (step >= 60 && step <= 3600) {
        intervals.push(step);
      }
    }
    if (intervals.length > 0) {
      intervals.sort((a, b) => a - b);
      barStepSec = intervals[Math.floor(intervals.length / 2)];
    }
  }

  // 1. Primary Match: Unix Timestamp (seconds)
  if (typeof tsSeconds === "number" && Number.isFinite(tsSeconds) && tsSeconds > 0) {
    // Normalize if milliseconds were accidentally passed
    const normTs = tsSeconds > 1e11 ? Math.floor(tsSeconds / 1000) : tsSeconds;
    const bucketTs = Math.floor(normTs / barStepSec) * barStepSec;

    let bestIdx = -1;
    let bestDiff = Infinity;

    for (let i = 0; i < candles.length; i++) {
      const cTs = candles[i].timestamp;
      if (typeof cTs === "number" && cTs > 0) {
        const normCandleTs = cTs > 1e11 ? Math.floor(cTs / 1000) : cTs;
        const candleBucketTs = Math.floor(normCandleTs / barStepSec) * barStepSec;
        // Canonical 5m floor-bucket match so 9:49 AM snaps to the 9:45 AM 5m candle
        if (candleBucketTs === bucketTs || (normTs >= normCandleTs && normTs < normCandleTs + barStepSec)) {
          return i;
        }
        const diff = Math.abs(candleBucketTs - bucketTs);
        if (diff < bestDiff) {
          bestDiff = diff;
          bestIdx = i;
        }
      }
    }

    if (bestIdx !== -1 && bestDiff <= Math.round(barStepSec * 0.5)) {
      return bestIdx;
    }
    // Never fall through to time-of-day label fallback across different trading sessions/days
    if (bestIdx !== -1 && bestDiff > 4 * 3600) {
      return -1;
    }
  }

  // 2. Fallback Match: Time Label (e.g. "9:35 AM")
  const targetMins = parseTimeLabelToMinutes(timeLabel);
  if (targetMins !== null) {
    const barStepMins = Math.max(1, Math.round(barStepSec / 60));
    let bestIdx = -1;
    let bestDiff = Infinity;

    for (let i = 0; i < candles.length; i++) {
      const cMins = parseTimeLabelToMinutes(candles[i].timeLabel);
      if (cMins !== null) {
        if (targetMins >= cMins && targetMins < cMins + barStepMins) {
          return i;
        }
        const diff = Math.abs(cMins - targetMins);
        if (diff < bestDiff) {
          bestDiff = diff;
          bestIdx = i;
        }
      }
    }

    if (bestIdx !== -1 && bestDiff <= Math.max(barStepMins * 2, 10)) {
      return bestIdx;
    }
  }

  return -1;
}

/**
 * Helper to resolve whether a trade/position is Short / Put across multiple schemas
 */
function isShortOrPut(pos: any): boolean {
  if (!pos) return false;
  const ct = String(pos.contractType || "").toUpperCase();
  const dir = String(pos.direction || pos.type || "").toUpperCase();
  const act = String(pos.action || "").toUpperCase();
  return ct === "PUT" || dir === "SHORT" || act.includes("PUT") || act === "SELL_TO_OPEN";
}

/**
 * Extracts normalized trades for `ticker` from `serverTrades` (`activePositions`, `closedPositions`, `alerts`).
 */
export function extractNormalizedTradesForTicker(
  ticker: string,
  serverTrades?: ServerTradesState | null,
  fsmSignals?: any[]
): NormalizedChartTrade[] {
  if (!serverTrades && (!fsmSignals || fsmSignals.length === 0)) return [];
  const sym = ticker.toUpperCase();
  const byId = new Map<string, NormalizedChartTrade>();

  // 1. Closed Positions
  if (serverTrades && Array.isArray(serverTrades.closedPositions)) {
    for (const pos of serverTrades.closedPositions) {
      if (!pos || String(pos.ticker || "").toUpperCase() !== sym) continue;
      const id = String(pos.id || `${sym}-${pos.contractType}-${pos.openedTs || pos.openedAt}`);
      byId.set(id, {
        id,
        ticker: sym,
        contractType: isShortOrPut(pos) ? "PUT" : "CALL",
        status: "CLOSED",
        setupName: String(pos.setupName || ""),
        btoSpotPrice: Number(pos.btoSpotPrice || pos.spotPrice || 0),
        openedAt: pos.openedAt,
        openedTs: typeof pos.openedTs === "number" ? pos.openedTs : undefined,
        closedSpotPrice:
          typeof pos.closedSpotPrice === "number" ? pos.closedSpotPrice : undefined,
        closedAt: pos.closedAt,
        closedTs: typeof pos.closedTs === "number" ? pos.closedTs : undefined,
        pnlOptionPct:
          typeof pos.pnlOptionPct === "number" ? pos.pnlOptionPct : undefined,
        exitReason: pos.exitReason,
      });
    }
  }

  // 2. Active Positions
  if (serverTrades?.activePositions && typeof serverTrades.activePositions === "object") {
    for (const pos of Object.values(serverTrades.activePositions)) {
      if (!pos || String(pos.ticker || "").toUpperCase() !== sym) continue;
      const id = String(pos.id || `${sym}-${pos.contractType}-${pos.openedTs || pos.openedAt}`);
      if (byId.has(id)) continue;
      byId.set(id, {
        id,
        ticker: sym,
        contractType: isShortOrPut(pos) ? "PUT" : "CALL",
        status: "OPEN",
        setupName: String(pos.setupName || ""),
        btoSpotPrice: Number(pos.btoSpotPrice || pos.spotPrice || 0),
        openedAt: pos.openedAt,
        openedTs: typeof pos.openedTs === "number" ? pos.openedTs : undefined,
        pnlOptionPct:
          typeof pos.pnlOptionPct === "number" ? pos.pnlOptionPct : undefined,
      });
    }
  }

  // 3. Fallback: Reconstruct from `alerts` if `activePositions` / `closedPositions` were empty
  if (byId.size === 0 && serverTrades && Array.isArray(serverTrades.alerts)) {
    const btoAlerts = serverTrades.alerts.filter(
      (a) =>
        a &&
        String(a.ticker || "").toUpperCase() === sym &&
        !String(a.id || "").startsWith("radar-") &&
        a.setupName !== "Intraday Radar Briefing" &&
        a.action === "BUY_TO_OPEN"
    );
    const stcAlerts = serverTrades.alerts.filter(
      (a) =>
        a &&
        String(a.ticker || "").toUpperCase() === sym &&
        !String(a.id || "").startsWith("radar-") &&
        a.action === "SELL_TO_CLOSE"
    );

    const usedStcIds = new Set<string>();
    for (const bto of btoAlerts) {
      const baseId = String(bto.id || "").replace(/-bto$/, "");
      const gaiaEntryMatch = baseId.match(/^(gaia-.+?)-entry-(\d+)/);
      const gaiaPrefix = baseId.includes("-entry-") ? baseId.split("-entry-")[0] : "";
      const matchingStc = stcAlerts.find((stc) => {
        const stcId = String(stc.id || "");
        if (stcId && usedStcIds.has(stcId)) return false;
        if (gaiaEntryMatch) {
          return (
            stcId.startsWith(`${gaiaEntryMatch[1]}-exit-${gaiaEntryMatch[2]}`) ||
            stcId.startsWith(`${gaiaEntryMatch[1]}-exit-`)
          );
        }
        if (gaiaPrefix) {
          return stcId.startsWith(`${gaiaPrefix}-exit-`);
        }
        return baseId ? stcId.startsWith(baseId) : stc.contractType === bto.contractType;
      });
      if (matchingStc?.id) {
        usedStcIds.add(String(matchingStc.id));
      }
      const id = baseId || `${sym}-${bto.contractType}-${bto.ts || bto.timestamp}`;
      byId.set(id, {
        id,
        ticker: sym,
        contractType: isShortOrPut(bto) ? "PUT" : "CALL",
        status: matchingStc ? "CLOSED" : "OPEN",
        setupName: String(bto.setupName || bto.reason || ""),
        btoSpotPrice: Number(bto.btoSpotPrice || bto.spotPrice || 0),
        openedAt: bto.timestamp,
        openedTs: typeof bto.ts === "number" ? bto.ts : undefined,
        closedSpotPrice: matchingStc
          ? Number(matchingStc.spotPrice || matchingStc.closedSpotPrice || 0)
          : undefined,
        closedAt: matchingStc?.timestamp,
        closedTs: typeof matchingStc?.ts === "number" ? matchingStc.ts : undefined,
        pnlOptionPct:
          typeof matchingStc?.pnlOptionPct === "number"
            ? matchingStc.pnlOptionPct
            : undefined,
        exitReason: matchingStc?.reason,
      });
    }
  }

  // 4. Fallback: Synthesize NormalizedChartTrade items from FSM signals only while server trades have not yet loaded
  if (byId.size === 0 && !serverTrades?.loaded && Array.isArray(fsmSignals) && fsmSignals.length > 0) {
    fsmSignals.forEach((sig: any, idx: number) => {
      if (!sig) return;
      if (sig.ticker && String(sig.ticker).toUpperCase() !== sym) return;
      const isPut = isShortOrPut(sig);
      const contractType: "CALL" | "PUT" = isPut ? "PUT" : "CALL";
      const btoSpot = Number(sig.price || sig.btoSpotPrice || 0);
      if (btoSpot <= 0) return;

      const rawClosedSpot = Number(sig.exitPrice ?? sig.closedSpotPrice ?? 0);
      const hasClosedSpot = Number.isFinite(rawClosedSpot) && rawClosedSpot > 0;
      const rawOpenTs = Number(sig.timestamp ?? sig.openedTs ?? 0);
      const openedTs =
        Number.isFinite(rawOpenTs) && rawOpenTs > 0
          ? rawOpenTs < 1e11
            ? rawOpenTs * 1000
            : rawOpenTs
          : undefined;
      const openedAt = sig.time || sig.openedAt || undefined;
      const rawCloseTs = Number(sig.exitTimestamp ?? sig.closedTs ?? 0);
      const closedTs =
        Number.isFinite(rawCloseTs) && rawCloseTs > 0
          ? rawCloseTs < 1e11
            ? rawCloseTs * 1000
            : rawCloseTs
          : undefined;
      const closedAt = sig.exitTime || sig.closedAt || undefined;

      const isClosed = Boolean(
        sig.isClosed ||
          sig.status === "CLOSED" ||
          (hasClosedSpot && (closedTs !== undefined || Boolean(closedAt)))
      );

      let pnlOptionPct: number | undefined = Number.isFinite(Number(sig.pnlOptionPct))
        ? Number(sig.pnlOptionPct)
        : undefined;

      if (pnlOptionPct === undefined && isClosed && hasClosedSpot && btoSpot > 0) {
        const directionalPct = isPut
          ? ((btoSpot - rawClosedSpot) / btoSpot) * 100
          : ((rawClosedSpot - btoSpot) / btoSpot) * 100;
        pnlOptionPct = Number((directionalPct * 25).toFixed(1));
      }

      const id = String(sig.id || `${sym}-fsm-${openedTs || openedAt}-${contractType}-${idx}`);
      byId.set(id, {
        id,
        ticker: sym,
        contractType,
        status: isClosed ? "CLOSED" : "OPEN",
        setupName: String(sig.label || sig.setupName || (isPut ? "PUT SETUP" : "CALL SETUP")),
        btoSpotPrice: btoSpot,
        openedAt,
        openedTs,
        closedSpotPrice: isClosed && hasClosedSpot ? rawClosedSpot : undefined,
        closedAt: isClosed ? closedAt : undefined,
        closedTs: isClosed ? closedTs : undefined,
        pnlOptionPct,
        exitReason: sig.reason || sig.exitReason || undefined,
      });
    });
  }

  return Array.from(byId.values());
}

/** Clamps an execution spot price inside the matched candle's [low, high] range. */
export function clampSpotToCandle(spot: number, candle: ChartCandleLike): number {
  const lo = Math.min(candle.low, candle.high);
  const hi = Math.max(candle.low, candle.high);
  if (!Number.isFinite(spot) || spot <= 0) return candle.close;
  if (hi <= 0) return spot;
  return Math.max(lo, Math.min(hi, spot));
}

/**
 * Anchors the STC PnL badge Y-coordinate directly to `priceToY(closedSpotPrice)`
 * (clamped to the exit candle's `[low, high]` and chart plot bounds).
 */
export function computeStcBadgeY(params: {
  closedSpotPrice: number;
  exitCandle: ChartCandleLike;
  priceToY: (price: number) => number;
  badgeH?: number;
  padTop?: number;
  plotBottomY?: number;
}): { exitSpot: number; exitSpotY: number; badgeY: number } {
  const {
    closedSpotPrice,
    exitCandle,
    priceToY,
    badgeH = 18,
    padTop = 18,
    plotBottomY = 9999,
  } = params;
  const exitSpot = clampSpotToCandle(closedSpotPrice, exitCandle);
  const exitSpotY = Math.max(padTop + 4, Math.min(plotBottomY - 4, priceToY(exitSpot)));
  const badgeY = Math.max(padTop + 2, Math.min(plotBottomY - badgeH - 2, exitSpotY - badgeH / 2));
  return { exitSpot, exitSpotY, badgeY };
}

const extractCacheByCtx = new WeakMap<
  CanvasRenderingContext2D,
  {
    ticker: string;
    serverTrades: ServerTradesState | null | undefined;
    fsmSignals: any[] | undefined;
    result: NormalizedChartTrade[];
  }
>();

/**
 * Draws the On-Chart Trade Execution Markers (`BTO` triangles + labels, `STC` cover markers,
 * glowing PnL pill badges, and dotted trajectory connectors) onto a 2D canvas context.
 */
export function drawTradeExecutionMarkers(
  options: DrawTradeExecutionMarkersOptions
): void {
  const {
    ctx,
    ticker,
    candles,
    safeActiveIdx,
    barToX,
    priceToY,
    serverTrades,
    fsmSignals,
    precomputedTrades,
    padLeft = 24,
    plotRightX = 9999,
    padTop = 18,
    plotBottomY = 9999,
  } = options;

  if (!candles || candles.length === 0 || safeActiveIdx < 0) return;
  let trades: NormalizedChartTrade[];
  const cached = extractCacheByCtx.get(ctx);
  if (precomputedTrades) {
    trades = precomputedTrades;
  } else if (
    cached &&
    cached.ticker === ticker &&
    cached.serverTrades === serverTrades &&
    cached.fsmSignals === fsmSignals
  ) {
    trades = cached.result;
  } else {
    trades = extractNormalizedTradesForTicker(ticker, serverTrades, fsmSignals);
    extractCacheByCtx.set(ctx, { ticker, serverTrades, fsmSignals, result: trades });
  }
  if (trades.length === 0) return;

  // Track occupied BTO/STC pill rectangles across trades so multi-leg labels never collide
  const occupiedPillRects: Array<{ x: number; y: number; w: number; h: number }> = [];
  const placeCanvasPillY = (
    x: number,
    rawY: number,
    w: number,
    h: number,
    preferUp: boolean
  ): number => {
    const minY = padTop + 2;
    const maxY = plotBottomY - h - 2;
    const collides = (cy: number) =>
      occupiedPillRects.some(
        (r) => x < r.x + r.w + 3 && x + w + 3 > r.x && cy < r.y + r.h + 2 && cy + h + 2 > r.y
      );
    const clamped = Math.max(minY, Math.min(maxY, rawY));
    if (!collides(clamped)) {
      occupiedPillRects.push({ x, y: clamped, w, h });
      return clamped;
    }
    const step = h + 4;
    for (let k = 1; k <= 6; k++) {
      const first = Math.max(minY, Math.min(maxY, clamped + (preferUp ? -k : k) * step));
      if (!collides(first)) {
        occupiedPillRects.push({ x, y: first, w, h });
        return first;
      }
      const second = Math.max(minY, Math.min(maxY, clamped + (preferUp ? k : -k) * step));
      if (!collides(second)) {
        occupiedPillRects.push({ x, y: second, w, h });
        return second;
      }
    }
    occupiedPillRects.push({ x, y: clamped, w, h });
    return clamped;
  };

  for (const trade of trades) {
    const entryIdx = matchTradeToCandleIndex(
      candles,
      trade.openedTs,
      trade.openedAt
    );
    if (entryIdx < 0 || entryIdx > safeActiveIdx) continue;

    const exitIdxRaw =
      trade.status === "CLOSED"
        ? matchTradeToCandleIndex(candles, trade.closedTs, trade.closedAt)
        : -1;
    const isClosedAndVisible =
      trade.status === "CLOSED" && exitIdxRaw >= 0 && exitIdxRaw <= safeActiveIdx;

    const entryCandle = candles[entryIdx];
    const entryX = barToX(entryIdx);
    const entrySpot = clampSpotToCandle(trade.btoSpotPrice, entryCandle);
    const entrySpotY = Math.max(padTop + 4, Math.min(plotBottomY - 4, priceToY(entrySpot)));

    const isPut = trade.contractType === "PUT";
    const btoColor = isPut ? "#ef4444" : "#10b981";
    const btoLabel = isPut ? "BTO PUT" : "BTO CALL";

    // =========================================================================
    // 1. Trade Trajectory Line (Entry -> Exit or Entry -> Current Bar if OPEN)
    // =========================================================================
    if (isClosedAndVisible) {
      const exitCandle = candles[exitIdxRaw];
      const exitX = barToX(exitIdxRaw);
      const exitSpot = clampSpotToCandle(trade.closedSpotPrice ?? exitCandle.close, exitCandle);
      const exitSpotY = Math.max(padTop + 4, Math.min(plotBottomY - 4, priceToY(exitSpot)));
      const isProfit = (trade.pnlOptionPct ?? 0) >= 0;

      ctx.save();
      ctx.strokeStyle = isProfit ? "rgba(16, 185, 129, 0.78)" : "rgba(239, 68, 68, 0.78)";
      ctx.lineWidth = 1.75;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(entryX, entrySpotY);
      ctx.lineTo(exitX, exitSpotY);
      ctx.stroke();
      ctx.setLineDash([]);

      // Anchor dots at exact BTO and STC spot execution prices
      ctx.fillStyle = btoColor;
      ctx.beginPath();
      ctx.arc(entryX, entrySpotY, 2.8, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = isProfit ? "#10b981" : "#ef4444";
      ctx.beginPath();
      ctx.arc(exitX, exitSpotY, 2.8, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    } else if (safeActiveIdx > entryIdx) {
      // Active trade still OPEN (or replay is between entry and exit): dotted line to active bar
      const curCandle = candles[safeActiveIdx];
      const curX = barToX(safeActiveIdx);
      const curY = priceToY(curCandle.close);

      // Trajectory color strictly tracks live PnL polarity (Green = in-the-money / profit, Red = adverse move)
      const dir = isPut ? -1 : 1;
      const currentUnderlyingDelta = (curCandle.close - entrySpot) * dir;
      const isCurProfit = currentUnderlyingDelta >= 0;

      ctx.save();
      ctx.strokeStyle = isCurProfit
        ? "rgba(16, 185, 129, 0.65)"
        : "rgba(239, 68, 68, 0.65)";
      ctx.lineWidth = 1.4;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(entryX, entrySpotY);
      ctx.lineTo(curX, curY);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    // =========================================================================
    // 2. BTO Entry Marker (The Sniper Shot)
    // =========================================================================
    ctx.save();
    const yHigh = priceToY(entryCandle.high);
    const yLow = priceToY(entryCandle.low);
    const triHalfW = 6.5;
    const triH = 9.5;

    ctx.fillStyle = btoColor;
    ctx.shadowColor = isPut
      ? "rgba(239, 68, 68, 0.85)"
      : "rgba(16, 185, 129, 0.85)";
    ctx.shadowBlur = 10;

    if (isPut) {
      // Downward-pointing Crimson Red (#ef4444) triangle directly ABOVE entry candle's high wick
      const tipY = Math.max(padTop + 18, yHigh - 5);
      const baseY = tipY - triH;
      ctx.beginPath();
      ctx.moveTo(entryX, tipY);
      ctx.lineTo(entryX - triHalfW, baseY);
      ctx.lineTo(entryX + triHalfW, baseY);
      ctx.closePath();
      ctx.fill();

      ctx.shadowBlur = 0;
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1;
      ctx.stroke();

      // Tiny crisp label `BTO PUT` above the triangle
      ctx.font = "bold 9.5px ui-monospace, SFMono-Regular, Menlo, monospace";
      const textW = ctx.measureText(btoLabel).width;
      const pillW = textW + 10;
      const pillH = 15;
      const pillX = Math.max(
        padLeft + 2,
        Math.min(plotRightX - pillW - 2, entryX - pillW / 2)
      );
      const pillY = placeCanvasPillY(pillX, baseY - pillH - 3, pillW, pillH, true);

      ctx.fillStyle = "rgba(15, 23, 42, 0.92)";
      ctx.strokeStyle = "#ef4444";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.roundRect(pillX, pillY, pillW, pillH, 4);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = "#fca5a5";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(btoLabel, pillX + pillW / 2, pillY + pillH / 2 + 0.5);
    } else {
      // Upward-pointing Emerald Green (#10b981) triangle directly BELOW entry candle's low wick
      const tipY = Math.min(plotBottomY - 18, yLow + 5);
      const baseY = tipY + triH;
      ctx.beginPath();
      ctx.moveTo(entryX, tipY);
      ctx.lineTo(entryX - triHalfW, baseY);
      ctx.lineTo(entryX + triHalfW, baseY);
      ctx.closePath();
      ctx.fill();

      ctx.shadowBlur = 0;
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1;
      ctx.stroke();

      // Tiny crisp label `BTO CALL` below the triangle
      ctx.font = "bold 9.5px ui-monospace, SFMono-Regular, Menlo, monospace";
      const textW = ctx.measureText(btoLabel).width;
      const pillW = textW + 10;
      const pillH = 15;
      const pillX = Math.max(
        padLeft + 2,
        Math.min(plotRightX - pillW - 2, entryX - pillW / 2)
      );
      const pillY = placeCanvasPillY(pillX, baseY + 3, pillW, pillH, false);

      ctx.fillStyle = "rgba(15, 23, 42, 0.92)";
      ctx.strokeStyle = "#10b981";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.roundRect(pillX, pillY, pillW, pillH, 4);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = "#6ee7b7";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(btoLabel, pillX + pillW / 2, pillY + pillH / 2 + 0.5);
    }
    ctx.restore();

    // =========================================================================
    // 3. STC Exit Marker & PnL Badge (The Cover / Take Profit)
    // =========================================================================
    if (isClosedAndVisible) {
      const exitCandle = candles[exitIdxRaw];
      const exitX = barToX(exitIdxRaw);
      const exitYHigh = priceToY(exitCandle.high);
      const exitYLow = priceToY(exitCandle.low);

      const pnlPct = trade.pnlOptionPct ?? 0;
      const isProfit = pnlPct >= 0;
      const stcColor = isProfit ? "#10b981" : "#ef4444";
      const stcFillBg = isProfit
        ? "rgba(16, 185, 129, 0.22)"
        : "rgba(239, 68, 68, 0.22)";
      const pnlFormatted = `${pnlPct >= 0 ? "+" : ""}${Math.round(pnlPct)}%`;
      const badgeText = `STC ${pnlFormatted}`;

      ctx.save();
      ctx.fillStyle = stcColor;
      ctx.shadowColor = isProfit ? "rgba(16, 185, 129, 0.9)" : "rgba(239, 68, 68, 0.9)";
      ctx.shadowBlur = 10;

      // For covering a Put (Short), draw an upward triangle below the closing candle's low wick.
      // For closing a Call (Long), draw a downward triangle above the closing candle's high wick.
      if (isPut) {
        // Guarantee collision-free rendering: If candle reaches the bottom of the chart, place STC marker above high wick
        const hasClearanceBelow = exitYLow + 5 + triH + 4 <= plotBottomY;
        const tipY = hasClearanceBelow
          ? exitYLow + 5
          : Math.max(padTop + 20, exitYHigh - 5);
        const baseY = hasClearanceBelow ? tipY + triH : tipY - triH;

        ctx.beginPath();
        ctx.moveTo(exitX, tipY);
        ctx.lineTo(exitX - triHalfW, baseY);
        ctx.lineTo(exitX + triHalfW, baseY);
        ctx.closePath();
        ctx.fill();

        ctx.shadowBlur = 0;
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1;
        ctx.stroke();
      } else {
        const tipY = Math.max(padTop + 20, exitYHigh - 5);
        const baseY = tipY - triH;
        ctx.beginPath();
        ctx.moveTo(exitX, tipY);
        ctx.lineTo(exitX - triHalfW, baseY);
        ctx.lineTo(exitX + triHalfW, baseY);
        ctx.closePath();
        ctx.fill();

        ctx.shadowBlur = 0;
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // Anchor STC PnL badge Y-coordinate directly to priceToY(closedSpotPrice) clamped to exit bar [low, high]
      ctx.font = "bold 10px ui-monospace, SFMono-Regular, Menlo, monospace";
      const textW = ctx.measureText(badgeText).width;
      const badgeW = Math.max(82, Math.ceil(textW + 16));
      const badgeH = 18;
      const { badgeY } = computeStcBadgeY({
        closedSpotPrice: trade.closedSpotPrice ?? exitCandle.close,
        exitCandle,
        priceToY,
        badgeH,
        padTop,
        plotBottomY,
      });

      let bx = exitX + triHalfW + 5;
      if (bx + badgeW > plotRightX - 4) {
        bx = Math.max(
          padLeft + 2,
          Math.min(plotRightX - badgeW - 2, exitX - badgeW - triHalfW - 5)
        );
      }
      const by = placeCanvasPillY(bx, badgeY, badgeW, badgeH, !isPut);

      // Dark backing for readability over candles/ribbons, then glowing pill fill
      ctx.fillStyle = "rgba(9, 13, 22, 0.88)";
      ctx.beginPath();
      ctx.roundRect(bx, by, badgeW, badgeH, 5);
      ctx.fill();

      ctx.fillStyle = stcFillBg;
      ctx.strokeStyle = stcColor;
      ctx.lineWidth = 1.4;
      ctx.shadowColor = isProfit ? "rgba(16, 185, 129, 0.55)" : "rgba(239, 68, 68, 0.55)";
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.roundRect(bx, by, badgeW, badgeH, 5);
      ctx.fill();
      ctx.stroke();

      ctx.shadowBlur = 0;
      ctx.fillStyle = stcColor;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(badgeText, bx + badgeW / 2, by + badgeH / 2 + 0.5);
      ctx.restore();
    }
  }
}
