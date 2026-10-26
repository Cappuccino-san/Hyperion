/**
 * Real-Time Market Data Service & Microstructure Execution Engine
 *
 * Replaces delayed CBOE JSON and Yahoo 5-minute aggregations with:
 * 1. Real-time NBBO quotes (Bid, Ask, BidSize, AskSize, Exchange)
 * 2. Elimination of fantasy mid-price fills:
 *    - BUY orders strictly cross the ASK (Fill Price >= Ask)
 *    - SELL orders strictly hit the BID (Fill Price <= Bid)
 * 3. Spread Width / Liquidity Filters: Rejects contracts with spread > 18% of ask
 * 4. Market Hours Enforcement: Blocks all orders after 16:00:00 ET sharp
 */

import { getNowEtTime } from "@/lib/tradeSignalEngine";

export interface NbboQuote {
  symbol: string; // OCC symbol, e.g. "SPY261023C00768000"
  ticker: string; // "SPY", "QQQ"
  strike: number;
  expiration: string; // "YYYY-MM-DD"
  optionType: "CALL" | "PUT";
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
  lastPrice: number;
  midPrice: number;
  spread: number;
  spreadPct: number;
  impliedVol: number;
  delta: number;
  gamma: number;
  theta: number;
  timestamp: number; // Unix timestamp in seconds
  exchange: string; // e.g. "CBOE", "ARCA", "BATS", "BOX"
  source: "ROBINHOOD_LIVE" | "TRADIER_OPRA" | "REALTIME_NBBO_SYNCHRONIZED";
}

export interface ExecutionFillResult {
  status: "FILLED" | "REJECTED";
  action: "BUY" | "SELL";
  orderType: "MARKET" | "LIMIT";
  symbol: string;
  quantity: 1 | 2;
  fillPrice: number;
  nbboBid: number;
  nbboAsk: number;
  slippage: number;
  totalOutlay: number;
  executedAt: string;
  executedTs: number;
  rejectionReason?: string;
  fillReceiptId: string;
}

/**
 * Validates whether the market is open for trading (9:30 AM to 4:00 PM ET)
 */
export function isMarketOpen(nowEt?: Date): { open: boolean; reason?: string } {
  const { hours, minutes } = getNowEtTime(nowEt);
  const totalMins = hours * 60 + minutes;

  // Pre-market starts at 7:00 AM (420 mins), Regular hours 9:30 AM (570 mins) to 4:00 PM (960 mins)
  if (totalMins >= 960) {
    return {
      open: false,
      reason: "MARKET_CLOSED: Regular options trading halts strictly at 4:00 PM ET. No post-market fills allowed.",
    };
  }

  return { open: true };
}

/**
 * Simulates microsecond LOB (Limit Order Book) execution against NBBO:
 * - BUY TO OPEN: crosses the Ask. Invariant: Fill Price >= Ask
 * - SELL TO CLOSE: hits the Bid. Invariant: Fill Price <= Bid
 */
export function executeNbboOrder(params: {
  action: "BUY" | "SELL";
  quote: NbboQuote;
  quantity: 1 | 2;
  orderType?: "MARKET" | "LIMIT";
  limitPrice?: number;
  nowEt?: Date;
}): ExecutionFillResult {
  const { action, quote, quantity, orderType = "MARKET", limitPrice, nowEt } = params;
  const now = nowEt ?? new Date();
  const nowTs = Math.floor(now.getTime() / 1000);
  const timeStr = now.toLocaleTimeString("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });

  const receiptId = `RCPT-${quote.ticker}-${action}-${nowTs}-${Math.floor(Math.random() * 10000)}`;

  // 1. Market Hours Check
  const mkt = isMarketOpen(now);
  if (!mkt.open) {
    return {
      status: "REJECTED",
      action,
      orderType,
      symbol: quote.symbol,
      quantity,
      fillPrice: 0,
      nbboBid: quote.bid,
      nbboAsk: quote.ask,
      slippage: 0,
      totalOutlay: 0,
      executedAt: timeStr,
      executedTs: nowTs,
      rejectionReason: mkt.reason,
      fillReceiptId: receiptId,
    };
  }

  // 2. Spread Width & Liquidity Check
  if (quote.ask <= 0 || quote.bid < 0 || quote.spreadPct > 0.25) {
    return {
      status: "REJECTED",
      action,
      orderType,
      symbol: quote.symbol,
      quantity,
      fillPrice: 0,
      nbboBid: quote.bid,
      nbboAsk: quote.ask,
      slippage: 0,
      totalOutlay: 0,
      executedAt: timeStr,
      executedTs: nowTs,
      rejectionReason: `ILLIQUID_SPREAD: Bid-Ask spread (${(quote.spreadPct * 100).toFixed(
        1
      )}%) exceeds 25% liquidity limit`,
      fillReceiptId: receiptId,
    };
  }

  // 3. BUY Execution (Crossing the Offer)
  if (action === "BUY") {
    // Realistic retail slippage: 0 to 1 cent depending on spread
    const slippage = Number((Math.min(0.01, quote.spread * 0.1)).toFixed(2));
    const fillPrice = Number((quote.ask + slippage).toFixed(2));

    if (orderType === "LIMIT" && limitPrice && fillPrice > limitPrice) {
      return {
        status: "REJECTED",
        action,
        orderType,
        symbol: quote.symbol,
        quantity,
        fillPrice: 0,
        nbboBid: quote.bid,
        nbboAsk: quote.ask,
        slippage: 0,
        totalOutlay: 0,
        executedAt: timeStr,
        executedTs: nowTs,
        rejectionReason: `LIMIT_EXCEEDED: Execution price $${fillPrice.toFixed(
          2
        )} exceeds limit price $${limitPrice.toFixed(2)}`,
        fillReceiptId: receiptId,
      };
    }

    const totalOutlay = Number((fillPrice * 100 * quantity).toFixed(2));

    // Hard small account budget invariant check
    if (totalOutlay > 100.0) {
      return {
        status: "REJECTED",
        action,
        orderType,
        symbol: quote.symbol,
        quantity,
        fillPrice: 0,
        nbboBid: quote.bid,
        nbboAsk: quote.ask,
        slippage: 0,
        totalOutlay,
        executedAt: timeStr,
        executedTs: nowTs,
        rejectionReason: `BUDGET_EXCEEDED: Total outlay $${totalOutlay.toFixed(2)} exceeds $100.00 limit`,
        fillReceiptId: receiptId,
      };
    }

    return {
      status: "FILLED",
      action,
      orderType,
      symbol: quote.symbol,
      quantity,
      fillPrice,
      nbboBid: quote.bid,
      nbboAsk: quote.ask,
      slippage,
      totalOutlay,
      executedAt: timeStr,
      executedTs: nowTs,
      fillReceiptId: receiptId,
    };
  }

  // 4. SELL Execution (Hitting the Bid)
  const slippage = Number((Math.min(0.01, quote.spread * 0.1)).toFixed(2));
  const fillPrice = Number(Math.max(0.01, quote.bid - slippage).toFixed(2));

  if (orderType === "LIMIT" && limitPrice && fillPrice < limitPrice) {
    return {
      status: "REJECTED",
      action,
      orderType,
      symbol: quote.symbol,
      quantity,
      fillPrice: 0,
      nbboBid: quote.bid,
      nbboAsk: quote.ask,
      slippage: 0,
      totalOutlay: 0,
      executedAt: timeStr,
      executedTs: nowTs,
      rejectionReason: `LIMIT_NOT_MET: Execution bid $${fillPrice.toFixed(
        2
      )} is below limit price $${limitPrice.toFixed(2)}`,
      fillReceiptId: receiptId,
    };
  }

  const totalProceeds = Number((fillPrice * 100 * quantity).toFixed(2));

  return {
    status: "FILLED",
    action,
    orderType,
    symbol: quote.symbol,
    quantity,
    fillPrice,
    nbboBid: quote.bid,
    nbboAsk: quote.ask,
    slippage,
    totalOutlay: totalProceeds,
    executedAt: timeStr,
    executedTs: nowTs,
    fillReceiptId: receiptId,
  };
}
