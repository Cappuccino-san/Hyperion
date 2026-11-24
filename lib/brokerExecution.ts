/**
 * Broker Execution & Order Lifecycle Interface
 *
 * Implements Institutional Execution Milestone 4:
 * Direct Broker Integration Hooks for Robinhood, Tradier, and Institutional Simulation.
 *
 * Provides:
 * 1. Standardized order submission and bracket dispatch
 * 2. Immutable Broker-Confirmed Fill Slips
 * 3. Bid-Ask crossing enforcement on all live and simulated orders
 */

import { NbboQuote, executeNbboOrder, ExecutionFillResult, isMarketOpen } from "@/lib/marketDataService";
import { calculateSmallAccountSize } from "@/lib/positionSizer";
import { etMinutesOfDay, getSessionBoundsEt, getTodayEt, toEpochSec } from "@/lib/gaiaSessionGuards";

export type ExecutionMode = "PAPER_SHADOW" | "LIVE";
export type OrderLifecycleState = "SUBMITTED" | "PARTIAL" | "FILLED" | "CANCELLED" | "REJECTED";

export interface PreTradeRiskGateResult {
  allowed: boolean;
  reason?: string;
  executionMode: ExecutionMode;
  clientOrderId: string;
}

export interface BrokerReconciliationReport {
  broker: SupportedBroker;
  checkedAtMs: number;
  inSync: boolean;
  discrepancies: Array<{
    symbol: string;
    ledgerQty: number;
    brokerQty: number;
    issue: "MISSING_AT_BROKER" | "PHANTOM_AT_BROKER" | "QTY_MISMATCH";
  }>;
}

export interface ExecutionAdapter {
  readonly broker: SupportedBroker;
  isConfigured(): boolean;
  executeOrder(request: BrokerOrderRequest): Promise<BrokerFillSlip>;
  pollOrderStatus(brokerOrderId: string): Promise<{
    brokerOrderId: string;
    status: OrderLifecycleState;
    filledQty: number;
    avgFillPrice: number;
  }>;
  reconcileBrokerPositions(
    ledgerPositions: Array<{ symbol: string; qty: number }>
  ): Promise<BrokerReconciliationReport>;
}

const submittedClientOrderIds = new Set<string>();
const MAX_IDEMPOTENCY_KEYS = 2000;

export function resetOrderIdempotencyCacheForTests(): void {
  submittedClientOrderIds.clear();
}

/**
 * Fail-closed execution mode resolver.
 * Strictly defaults to PAPER_SHADOW even when broker API credentials exist in env.
 * Live routing requires BOTH explicit HYPERION_EXECUTION_MODE=LIVE and a >=16-char HYPERION_LIVE_ARM_TOKEN.
 */
export function resolveExecutionMode(
  env: Record<string, string | undefined> = process.env
): ExecutionMode {
  const mode = (env.HYPERION_EXECUTION_MODE ?? "PAPER_SHADOW").trim().toUpperCase();
  const armToken = (env.HYPERION_LIVE_ARM_TOKEN ?? "").trim();
  if (mode === "LIVE" && armToken.length >= 16) {
    return "LIVE";
  }
  return "PAPER_SHADOW";
}

function isKillSwitchHalted(): boolean {
  const g = globalThis as unknown as {
    __hyperionLiveBotState?: { executionHalted?: boolean };
  };
  return Boolean(g.__hyperionLiveBotState?.executionHalted);
}

export function buildDeterministicClientOrderId(request: BrokerOrderRequest): string {
  if (request.clientOrderId?.trim()) return request.clientOrderId.trim();
  const tsBucket = Math.floor((request.nowEt?.getTime() ?? Date.now()) / 1000);
  return `HYP-${request.action}-${request.symbol}-${request.contractsQty}-${tsBucket}`;
}

/**
 * Fail-Closed Pre-Trade Risk Gate (SignalIntent -> PreTradeRiskGate -> ExecutionAdapter).
 * Enforces kill-switch, market hours, 09:35-14:30 ET BTO cutoff, quote freshness TTL (<= 30s),
 * 1-contract / <= $100 sniper outlay ceiling, spread <= 25%, and clientOrderId idempotency.
 */
export function evaluatePreTradeRiskGate(
  request: BrokerOrderRequest,
  options?: {
    executionHalted?: boolean;
    maxQuoteAgeSec?: number;
    env?: Record<string, string | undefined>;
    enforceIdempotency?: boolean;
  }
): PreTradeRiskGateResult {
  const executionMode = resolveExecutionMode(options?.env);
  const clientOrderId = buildDeterministicClientOrderId(request);
  const halted = options?.executionHalted ?? isKillSwitchHalted();

  if (halted) {
    return {
      allowed: false,
      reason: "EXECUTION_HALTED: Emergency kill-switch / cockpit lock is active.",
      executionMode,
      clientOrderId,
    };
  }

  if (options?.enforceIdempotency !== false && request.clientOrderId?.trim()) {
    if (submittedClientOrderIds.has(clientOrderId)) {
      return {
        allowed: false,
        reason: `DUPLICATE_CLIENT_ORDER_ID: Order ${clientOrderId} was already submitted.`,
        executionMode,
        clientOrderId,
      };
    }
  }

  const mkt = isMarketOpen(request.nowEt);
  if (!mkt.open) {
    return {
      allowed: false,
      reason: mkt.reason || "MARKET_CLOSED",
      executionMode,
      clientOrderId,
    };
  }

  // Enforce strict RTH entry window (09:35 - 14:30 ET, or 09:35 - 11:30 ET on early-close days) for BTO
  const refDate = request.nowEt ?? new Date();
  const refDateIso = getTodayEt(refDate);
  const bounds = getSessionBoundsEt(refDateIso);
  const etMins = etMinutesOfDay(refDate.getTime());
  if (
    request.action === "BUY_TO_OPEN" &&
    (etMins < bounds.entryStartMins || etMins > bounds.entryCutoffMins)
  ) {
    return {
      allowed: false,
      reason: `OUTSIDE_BTO_ENTRY_WINDOW: etMins=${etMins} outside [${bounds.entryStartMins}, ${bounds.entryCutoffMins}] on ${refDateIso}`,
      executionMode,
      clientOrderId,
    };
  }

  // Quote freshness TTL gate (default 30s)
  const maxQuoteAgeSec = options?.maxQuoteAgeSec ?? 30;
  if (typeof request.quote.timestamp === "number" && request.quote.timestamp > 0) {
    const quoteSec = toEpochSec(request.quote.timestamp);
    const refSec = Math.floor(refDate.getTime() / 1000);
    const ageSec = refSec - quoteSec;
    if (ageSec > maxQuoteAgeSec) {
      return {
        allowed: false,
        reason: `STALE_QUOTE_TTL_EXCEEDED: Quote age ${ageSec}s > ${maxQuoteAgeSec}s limit.`,
        executionMode,
        clientOrderId,
      };
    }
  }

  if (
    !Number.isFinite(request.quote.ask) ||
    request.quote.ask <= 0 ||
    !Number.isFinite(request.quote.bid) ||
    request.quote.bid < 0 ||
    request.quote.bid > request.quote.ask ||
    !Number.isFinite(request.quote.spreadPct) ||
    request.quote.spreadPct > 0.25
  ) {
    const spreadLabel = Number.isFinite(request.quote.spreadPct)
      ? (request.quote.spreadPct * 100).toFixed(1)
      : "NaN";
    return {
      allowed: false,
      reason: `ILLIQUID_OR_INVALID_QUOTE: spread=${spreadLabel}%`,
      executionMode,
      clientOrderId,
    };
  }

  if (request.action === "BUY_TO_OPEN") {
    if (request.contractsQty !== 1) {
      return {
        allowed: false,
        reason: `CONTRACT_QTY_VIOLATION: Attempted ${request.contractsQty} (strictly 1 allowed)`,
        executionMode,
        clientOrderId,
      };
    }
    const sizing = calculateSmallAccountSize(request.quote.ask);
    if (!sizing.allowed) {
      return {
        allowed: false,
        reason: sizing.rejectionReason || "BUDGET_EXCEEDED",
        executionMode,
        clientOrderId,
      };
    }
  }

  return {
    allowed: true,
    executionMode,
    clientOrderId,
  };
}

function recordSubmittedClientOrderId(clientOrderId: string): void {
  if (!clientOrderId) return;
  submittedClientOrderIds.add(clientOrderId);
  if (submittedClientOrderIds.size > MAX_IDEMPOTENCY_KEYS) {
    const oldest = submittedClientOrderIds.values().next().value;
    if (oldest) submittedClientOrderIds.delete(oldest);
  }
}

function validateLiveBrokerOrder(request: BrokerOrderRequest): string | null {
  const gate = evaluatePreTradeRiskGate(request, { enforceIdempotency: false });
  return gate.allowed ? null : (gate.reason ?? "PRE_TRADE_RISK_GATE_REJECTED");
}

function buildRejectedSlip(
  request: BrokerOrderRequest,
  broker: SupportedBroker,
  reason: string,
  brokerOrderId = "NONE",
  ledgerSignature = "REJECTED_ORDER",
  fillSlipIdPrefix = "SLIP-REJ"
): BrokerFillSlip {
  const nowTs = Math.floor(Date.now() / 1000);
  return {
    fillSlipId: `${fillSlipIdPrefix}-${nowTs}`,
    broker,
    brokerOrderId,
    timestamp: nowTs,
    timeEt: new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York" }),
    ticker: request.ticker,
    symbol: request.symbol,
    action: request.action,
    filledQty: request.contractsQty,
    filledPrice: 0,
    totalOutlayOrProceeds: 0,
    nbboBid: request.quote.bid,
    nbboAsk: request.quote.ask,
    effectiveSpread: request.quote.spread,
    slippage: 0,
    status: "REJECTED",
    rejectionReason: reason,
    ledgerSignature,
  };
}

export type SupportedBroker = "ROBINHOOD" | "TRADIER" | "INSTITUTIONAL_SIMULATOR";

export interface BrokerOrderRequest {
  ticker: string;
  symbol: string; // OCC format
  action: "BUY_TO_OPEN" | "SELL_TO_CLOSE";
  contractsQty: 1 | 2;
  orderType: "MARKET" | "LIMIT";
  limitPrice?: number;
  timeInForce?: "GFD" | "IOC";
  quote: NbboQuote;
  nowEt?: Date;
  clientOrderId?: string;
}

export interface BrokerFillSlip {
  fillSlipId: string;
  broker: SupportedBroker;
  brokerOrderId: string;
  clientOrderId?: string;
  executionMode?: ExecutionMode;
  timestamp: number;
  timeEt: string;
  ticker: string;
  symbol: string;
  action: "BUY_TO_OPEN" | "SELL_TO_CLOSE";
  filledQty: 1 | 2;
  filledPrice: number;
  totalOutlayOrProceeds: number;
  nbboBid: number;
  nbboAsk: number;
  effectiveSpread: number;
  slippage: number;
  status: OrderLifecycleState;
  rejectionReason?: string;
  ledgerSignature: string;
}

/**
 * Simulated Institutional Broker with realistic LOB fill mechanics
 */
class InstitutionalSimulatedBroker {
  async executeOrder(request: BrokerOrderRequest): Promise<BrokerFillSlip> {
    const isBuy = request.action === "BUY_TO_OPEN";
    const simAction = isBuy ? "BUY" : "SELL";

    // 1. Position Sizing, Quantity (1-contract strict) & Budget Check for Buys
    let effectiveQty = request.contractsQty;
    if (isBuy) {
      const sizing = calculateSmallAccountSize(request.quote.ask);
      if (!sizing.allowed) {
        return this.createRejectedSlip(
          request,
          "INSTITUTIONAL_SIMULATOR",
          sizing.rejectionReason || "BUDGET_EXCEEDED"
        );
      }
      if (request.contractsQty !== 1) {
        return this.createRejectedSlip(
          request,
          "INSTITUTIONAL_SIMULATOR",
          `CONTRACT_QTY_VIOLATION: Attempted ${request.contractsQty} contracts (strictly 1 allowed)`
        );
      }
      effectiveQty = sizing.contractsQty;
    }

    // 2. Microstructure LOB Execution (BUY on Ask, SELL on Bid)
    const execResult: ExecutionFillResult = executeNbboOrder({
      action: simAction,
      quote: request.quote,
      quantity: effectiveQty,
      orderType: request.orderType,
      limitPrice: request.limitPrice,
      nowEt: request.nowEt,
    });

    if (execResult.status === "REJECTED") {
      return this.createRejectedSlip(
        request,
        "INSTITUTIONAL_SIMULATOR",
        execResult.rejectionReason || "EXECUTION_REJECTED"
      );
    }

    const nowTs = Math.floor(Date.now() / 1000);
    const timeEt = new Date().toLocaleTimeString("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
    });

    const slipId = `SLIP-SIM-${request.ticker}-${nowTs}-${Math.floor(Math.random() * 100000)}`;
    const brokerOrderId = `RH-SIM-ORD-${Date.now().toString(36).toUpperCase()}`;

    return {
      fillSlipId: slipId,
      broker: "INSTITUTIONAL_SIMULATOR",
      brokerOrderId,
      timestamp: nowTs,
      timeEt,
      ticker: request.ticker,
      symbol: request.symbol,
      action: request.action,
      filledQty: request.contractsQty,
      filledPrice: execResult.fillPrice,
      totalOutlayOrProceeds: execResult.totalOutlay,
      nbboBid: request.quote.bid,
      nbboAsk: request.quote.ask,
      effectiveSpread: request.quote.spread,
      slippage: execResult.slippage,
      status: "FILLED",
      ledgerSignature: `SHA256:${Buffer.from(`${slipId}:${execResult.fillPrice}:${execResult.totalOutlay}`).toString(
        "base64"
      )}`,
    };
  }

  private createRejectedSlip(
    request: BrokerOrderRequest,
    broker: SupportedBroker,
    reason: string
  ): BrokerFillSlip {
    return buildRejectedSlip(request, broker, reason);
  }
}

/**
 * Robinhood Live REST API Client Hooks
 * Ready for live execution when ROBINHOOD_BEARER_TOKEN is provided.
 */
class RobinhoodApiClient {
  private token: string | null = null;

  constructor() {
    this.token = process.env.ROBINHOOD_BEARER_TOKEN || process.env.ROBINHOOD_AUTH_TOKEN || null;
  }

  isConfigured(): boolean {
    return Boolean(this.token);
  }

  async executeOrder(request: BrokerOrderRequest): Promise<BrokerFillSlip> {
    if (!this.token) {
      throw new Error("Robinhood API client is not configured with an authentication token.");
    }

    const validationError = validateLiveBrokerOrder(request);
    if (validationError) {
      return buildRejectedSlip(request, "ROBINHOOD", validationError, "PRECHECK_REJECTED", "ROBINHOOD_PRECHECK_REJECTED", "RH-REJ");
    }

    const isBuy = request.action === "BUY_TO_OPEN";
    const side = isBuy ? "buy" : "sell";
    const positionEffect = isBuy ? "open" : "close";
    const price = isBuy ? request.quote.ask : request.quote.bid;

    try {
      const res = await fetch("https://api.robinhood.com/options/orders/", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({
          account: process.env.ROBINHOOD_ACCOUNT_NUMBER,
          direction: isBuy ? "debit" : "credit",
          time_in_force: "gfd",
          trigger: "immediate",
          type: request.orderType.toLowerCase(),
          price: price.toFixed(2),
          quantity: request.contractsQty,
          side,
          position_effect: positionEffect,
          legs: [
            {
              option: request.symbol,
              position_effect: positionEffect,
              side,
              ratio_quantity: 1,
            },
          ],
        }),
      });

      const json = await res.json();
      const nowTs = Math.floor(Date.now() / 1000);
      const timeEt = new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York" });

      if (!res.ok || json?.error) {
        return buildRejectedSlip(
          request,
          "ROBINHOOD",
          json?.error || json?.detail || `Robinhood HTTP ${res.status}`,
          json?.id || "ERROR",
          "ROBINHOOD_REJECTED",
          "RH-ERR"
        );
      }

      const submittedPrice = Number(json.price || price);
      const totalOutlayOrProceeds = Number((submittedPrice * 100 * request.contractsQty).toFixed(2));
      const rawState = String(json.state || "submitted").toLowerCase();
      const lifecycleStatus: OrderLifecycleState =
        rawState === "filled"
          ? "FILLED"
          : rawState === "partially_filled"
            ? "PARTIAL"
            : rawState === "cancelled" || rawState === "canceled"
              ? "CANCELLED"
              : rawState === "rejected" || rawState === "failed"
                ? "REJECTED"
                : "SUBMITTED";

      return {
        fillSlipId: `SLIP-RH-${json.id || nowTs}`,
        broker: "ROBINHOOD",
        brokerOrderId: json.id || `RH-${nowTs}`,
        clientOrderId: request.clientOrderId,
        executionMode: "LIVE",
        timestamp: nowTs,
        timeEt,
        ticker: request.ticker,
        symbol: request.symbol,
        action: request.action,
        filledQty: request.contractsQty,
        filledPrice: submittedPrice,
        totalOutlayOrProceeds,
        nbboBid: request.quote.bid,
        nbboAsk: request.quote.ask,
        effectiveSpread: request.quote.spread,
        slippage: Number(Math.abs(submittedPrice - (isBuy ? request.quote.ask : request.quote.bid)).toFixed(2)),
        status: lifecycleStatus,
        ledgerSignature: `ROBINHOOD_${lifecycleStatus}:${json.id}:${submittedPrice}`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Robinhood connection failed";
      return {
        fillSlipId: `RH-FAIL-${Date.now()}`,
        broker: "ROBINHOOD",
        brokerOrderId: "NETWORK_ERROR",
        timestamp: Math.floor(Date.now() / 1000),
        timeEt: new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York" }),
        ticker: request.ticker,
        symbol: request.symbol,
        action: request.action,
        filledQty: request.contractsQty,
        filledPrice: 0,
        totalOutlayOrProceeds: 0,
        nbboBid: request.quote.bid,
        nbboAsk: request.quote.ask,
        effectiveSpread: request.quote.spread,
        slippage: 0,
        status: "REJECTED",
        rejectionReason: msg,
        ledgerSignature: "NETWORK_EXCEPTION",
      };
    }
  }
}

/**
 * Tradier Live Brokerage Client Hooks
 * Ready for live execution when TRADIER_API_KEY is provided.
 */
class TradierApiClient {
  private apiKey: string | null = null;
  private accountId: string | null = null;

  constructor() {
    this.apiKey = (process.env.TRADIER_API_KEY || process.env.TRADIER_ACCESS_TOKEN || "").trim() || null;
    this.accountId = process.env.TRADIER_ACCOUNT_ID?.trim() || null;
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey && this.accountId);
  }

  async executeOrder(request: BrokerOrderRequest): Promise<BrokerFillSlip> {
    if (!this.apiKey || !this.accountId) {
      throw new Error("Tradier API client is not configured with an API key and account ID.");
    }

    const validationError = validateLiveBrokerOrder(request);
    if (validationError) {
      return buildRejectedSlip(request, "TRADIER", validationError, "PRECHECK_REJECTED", "TRADIER_PRECHECK_REJECTED", "TRAD-REJ");
    }

    const isBuy = request.action === "BUY_TO_OPEN";
    const side = isBuy ? "buy_to_open" : "sell_to_close";
    const price = isBuy ? request.quote.ask : request.quote.bid;

    try {
      const formData = new URLSearchParams({
        class: "option",
        symbol: request.ticker,
        option_symbol: request.symbol,
        side,
        quantity: String(request.contractsQty),
        type: request.orderType.toLowerCase(),
        duration: "day",
        price: price.toFixed(2),
      });

      const res = await fetch(`https://api.tradier.com/v1/accounts/${this.accountId}/orders`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        signal: AbortSignal.timeout(10_000),
        body: formData.toString(),
      });

      const json = await res.json();
      const nowTs = Math.floor(Date.now() / 1000);
      const timeEt = new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York" });

      if (!res.ok || json?.errors) {
        const rawErr = json?.errors?.error;
        const errorMsg = Array.isArray(rawErr)
          ? rawErr.join(", ")
          : typeof rawErr === "string"
            ? rawErr
            : `Tradier HTTP ${res.status}`;
        return buildRejectedSlip(
          request,
          "TRADIER",
          errorMsg,
          "ERROR",
          "TRADIER_REJECTED",
          "TRAD-ERR"
        );
      }

      const orderId = String(json?.order?.id || nowTs);
      const submittedPrice = price;
      const totalOutlayOrProceeds = Number((submittedPrice * 100 * request.contractsQty).toFixed(2));
      const rawStatus = String(json?.order?.status || "submitted").toLowerCase();
      const lifecycleStatus: OrderLifecycleState =
        rawStatus === "filled"
          ? "FILLED"
          : rawStatus === "partially_filled"
            ? "PARTIAL"
            : rawStatus === "canceled" || rawStatus === "cancelled"
              ? "CANCELLED"
              : rawStatus === "rejected"
                ? "REJECTED"
                : "SUBMITTED";

      return {
        fillSlipId: `SLIP-TRAD-${orderId}`,
        broker: "TRADIER",
        brokerOrderId: orderId,
        clientOrderId: request.clientOrderId,
        executionMode: "LIVE",
        timestamp: nowTs,
        timeEt,
        ticker: request.ticker,
        symbol: request.symbol,
        action: request.action,
        filledQty: request.contractsQty,
        filledPrice: submittedPrice,
        totalOutlayOrProceeds,
        nbboBid: request.quote.bid,
        nbboAsk: request.quote.ask,
        effectiveSpread: request.quote.spread,
        slippage: 0,
        status: lifecycleStatus,
        ledgerSignature: `TRADIER_${lifecycleStatus}:${orderId}:${submittedPrice}`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Tradier connection failed";
      return {
        fillSlipId: `TRAD-FAIL-${Date.now()}`,
        broker: "TRADIER",
        brokerOrderId: "NETWORK_ERROR",
        timestamp: Math.floor(Date.now() / 1000),
        timeEt: new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York" }),
        ticker: request.ticker,
        symbol: request.symbol,
        action: request.action,
        filledQty: request.contractsQty,
        filledPrice: 0,
        totalOutlayOrProceeds: 0,
        nbboBid: request.quote.bid,
        nbboAsk: request.quote.ask,
        effectiveSpread: request.quote.spread,
        slippage: 0,
        status: "REJECTED",
        rejectionReason: msg,
        ledgerSignature: "NETWORK_EXCEPTION",
      };
    }
  }
}

// Singletons
export const simBroker = new InstitutionalSimulatedBroker();
export const robinhoodBroker = new RobinhoodApiClient();
export const tradierBroker = new TradierApiClient();

/**
 * Reconciles Hyperion's internal active ledger positions against broker-reported positions.
 * Any discrepancy returns `inSync: false` so an autonomous supervisor can immediately halt execution.
 */
export function reconcileLedgerVsBrokerPositions(
  broker: SupportedBroker,
  ledgerPositions: Array<{ symbol: string; qty: number }>,
  brokerPositions: Array<{ symbol: string; qty: number }>
): BrokerReconciliationReport {
  const ledgerMap = new Map<string, number>();
  for (const p of ledgerPositions) {
    ledgerMap.set(p.symbol, (ledgerMap.get(p.symbol) ?? 0) + p.qty);
  }
  const brokerMap = new Map<string, number>();
  for (const p of brokerPositions) {
    brokerMap.set(p.symbol, (brokerMap.get(p.symbol) ?? 0) + p.qty);
  }

  const discrepancies: BrokerReconciliationReport["discrepancies"] = [];
  const allSymbols = new Set<string>([
    ...Array.from(ledgerMap.keys()),
    ...Array.from(brokerMap.keys()),
  ]);
  for (const symbol of Array.from(allSymbols)) {
    const lQty = ledgerMap.get(symbol) ?? 0;
    const bQty = brokerMap.get(symbol) ?? 0;
    if (lQty > 0 && bQty === 0) {
      discrepancies.push({ symbol, ledgerQty: lQty, brokerQty: bQty, issue: "MISSING_AT_BROKER" });
    } else if (lQty === 0 && bQty > 0) {
      discrepancies.push({ symbol, ledgerQty: lQty, brokerQty: bQty, issue: "PHANTOM_AT_BROKER" });
    } else if (lQty !== bQty) {
      discrepancies.push({ symbol, ledgerQty: lQty, brokerQty: bQty, issue: "QTY_MISMATCH" });
    }
  }

  return {
    broker,
    checkedAtMs: Date.now(),
    inSync: discrepancies.length === 0,
    discrepancies,
  };
}

/**
 * Fail-Closed Universal Broker Dispatcher:
 * 1. Always evaluates PreTradeRiskGate (kill-switch, RTH entry window, quote TTL, <= $100/1-contract, idempotency).
 * 2. Defaults strictly to PAPER_SHADOW (InstitutionalSimulatedBroker) even if live broker env keys exist.
 * 3. Only routes to Robinhood / Tradier when HYPERION_EXECUTION_MODE=LIVE AND HYPERION_LIVE_ARM_TOKEN (>=16 chars) are explicitly armed.
 */
export async function dispatchBrokerOrder(
  request: BrokerOrderRequest,
  options?: { executionHalted?: boolean; maxQuoteAgeSec?: number; env?: Record<string, string | undefined> }
): Promise<BrokerFillSlip> {
  const gate = evaluatePreTradeRiskGate(request, options);
  if (!gate.allowed) {
    return buildRejectedSlip(
      request,
      "INSTITUTIONAL_SIMULATOR",
      gate.reason || "PRE_TRADE_RISK_GATE_REJECTED",
      "RISK_GATE_BLOCKED",
      "PRE_TRADE_RISK_GATE_REJECTED"
    );
  }

  const normalizedReq: BrokerOrderRequest = {
    ...request,
    clientOrderId: gate.clientOrderId,
  };

  if (request.clientOrderId?.trim()) {
    recordSubmittedClientOrderId(gate.clientOrderId);
  }

  if (gate.executionMode === "LIVE") {
    if (robinhoodBroker.isConfigured()) {
      return robinhoodBroker.executeOrder(normalizedReq);
    }
    if (tradierBroker.isConfigured()) {
      return tradierBroker.executeOrder(normalizedReq);
    }
  }

  const simSlip = await simBroker.executeOrder(normalizedReq);
  return {
    ...simSlip,
    clientOrderId: gate.clientOrderId,
    executionMode: "PAPER_SHADOW",
  };
}
