import {
  buildDiscordWebhookDispatchUrl,
  isValidDiscordWebhookUrl,
} from "@/lib/discordWebhook";
import {
  etMinutesOfDay,
  getSessionBoundsEt,
  getTodayEt,
  type SessionBoundsEt,
} from "@/lib/gaiaSessionGuards";
import {
  DailyTradeStore,
  GaiaSpySignalSyncInput,
  SyncGaiaTickerParams,
  SyncGaiaTickerResult,
  TradeLifecycleAlert,
  isSupportedTradeTicker,
} from "@/lib/execution/types";
import {
  loadTradeStore,
  saveTradeStore,
} from "@/lib/execution/ledgerCommit";

export const DISCORD_ALLOWED_TICKERS = ["SPY", "QQQ"] as const;

export function isDiscordTickerAllowed(rawTicker?: string): boolean {
  const cleaned = (rawTicker || "").trim().toUpperCase().replace(/^\$/, "");
  return cleaned === "SPY" || cleaned === "QQQ";
}

export function isAlertDispatchEligible(
  alert: TradeLifecycleAlert,
  realNowTs: number,
  sessionBounds: SessionBoundsEt
): boolean {
  if (alert.isHistoricalBackfill) return false;
  if (!isDiscordTickerAllowed(alert.ticker)) return false;

  const etMins = etMinutesOfDay(realNowTs);
  if (alert.action === "BUY_TO_OPEN") {
    const isFresh = Math.abs(realNowTs - alert.ts) <= 180;
    const isRth = etMins >= sessionBounds.rthOpenMins && etMins < sessionBounds.rthCloseMins;
    return isRth && isFresh;
  }

  // SELL_TO_CLOSE: allow live retries inside RTH and during post-close MOC grace (+20m) on same session date
  const alertDate = new Date(alert.ts * 1000).toLocaleDateString("en-CA", {
    timeZone: "America/New_York",
  });
  const nowDate = new Date(realNowTs * 1000).toLocaleDateString("en-CA", {
    timeZone: "America/New_York",
  });
  if (alertDate !== nowDate) return false;
  return etMins >= sessionBounds.rthOpenMins && etMins <= sessionBounds.rthCloseMins + 20;
}

/**
 * Sweeps the persisted ledger for any eligible unsent alerts (e.g. STC/MOC retries after transient failure)
 * and persists `dispatchedAlertIds` atomically once Discord confirms HTTP 200.
 */
export async function flushPendingDiscordAlerts(options?: {
  webhookUrl?: string;
  ticker?: string;
  signal?: AbortSignal;
  nowDate?: Date;
}): Promise<number> {
  if (options?.signal?.aborted) return 0;

  const nowDate = options?.nowDate ?? new Date();
  const realNowTs = Math.floor(nowDate.getTime() / 1000);
  const sessionDate = getTodayEt(nowDate);
  const sessionBounds = getSessionBoundsEt(sessionDate);
  const sym = options?.ticker?.trim().toUpperCase().replace(/^\$/, "");
  const normalizedSym = sym === "SPX" ? "SPXW" : sym;
  const altKey = normalizedSym === "SPXW" ? "SPY" : normalizedSym;

  const store = loadTradeStore();
  const pending = store.alerts.filter((a) => {
    if (normalizedSym && a.ticker !== normalizedSym && a.ticker !== altKey && a.ticker !== sym) {
      return false;
    }
    if (store.dispatchedAlertIds?.[a.id]) return false;
    return isAlertDispatchEligible(a, realNowTs, sessionBounds);
  });

  if (pending.length === 0) return 0;

  const sentIds: string[] = [];
  for (const alert of pending) {
    if (options?.signal?.aborted) break;
    const ok = await sendDiscordTradeAlert(
      { ...alert, isHistoricalBackfill: false },
      options?.webhookUrl,
      { signal: options?.signal }
    ).catch(() => false);
    if (ok) {
      sentIds.push(alert.id);
    }
  }

  if (sentIds.length > 0) {
    const afterStore = loadTradeStore();
    afterStore.dispatchedAlertIds = afterStore.dispatchedAlertIds || {};
    for (const id of sentIds) {
      afterStore.dispatchedAlertIds[id] = true;
    }
    saveTradeStore(afterStore);
  }

  return sentIds.length;
}

/**
 * Sends a Trade Lifecycle Alert directly to Discord using the Sub-$1.00 Small Account embed format
 */
export async function sendDiscordTradeAlert(
  alert: TradeLifecycleAlert,
  customWebhookUrl?: string,
  options?: { bypassFsmFirewall?: boolean; signal?: AbortSignal }
): Promise<boolean> {
  if (options?.signal?.aborted) {
    return false;
  }
  if (alert.isHistoricalBackfill) {
    return false;
  }
  if (!isDiscordTickerAllowed(alert.ticker)) {
    return false;
  }

  const isBtoAlert = alert.action === "BUY_TO_OPEN";
  const isGaiaHudSetup = Boolean(alert.setupName?.includes("Gaia Tactical HUD"));
  if (!options?.bypassFsmFirewall && isBtoAlert && isGaiaHudSetup) {
    const store = loadTradeStore();
    const tickerFsm =
      store.gaiaStateByTicker?.[alert.ticker] ??
      (alert.ticker === "SPY"
        ? {
            activeFsmState: store.activeFsmState,
            macroRegime: store.macroRegime,
            chiPct: store.chiPct,
          }
        : undefined);
    if (tickerFsm) {
      const fsmState = tickerFsm.activeFsmState;
      const macro = tickerFsm.macroRegime;
      const chiPct = tickerFsm.chiPct ?? 50;

      if (alert.contractType === "PUT") {
        if (fsmState === "LONG" || fsmState === "STAND_ASIDE" || macro === "CALL" || chiPct >= 50) {
          console.warn(
            `[DiscordTradeAlert FIREWALL REJECT] Blocked illegal ${alert.ticker} PUT alert (${alert.action} · ${alert.id}) while FSM is ${fsmState} / Macro ${macro} (χ=${chiPct}%).`
          );
          return false;
        }
      }
      if (alert.contractType === "CALL") {
        if (fsmState === "SHORT" || fsmState === "STAND_ASIDE" || macro === "PUT" || chiPct < 50) {
          console.warn(
            `[DiscordTradeAlert FIREWALL REJECT] Blocked illegal ${alert.ticker} CALL alert (${alert.action} · ${alert.id}) while FSM is ${fsmState} / Macro ${macro} (χ=${chiPct}%).`
          );
          return false;
        }
      }
    }
  }

  const webhookUrl = (customWebhookUrl || process.env.DISCORD_WEBHOOK_URL)?.trim() || "";
  if (!webhookUrl) {
    console.warn("[DiscordTradeAlert] Skipping dispatch: DISCORD_WEBHOOK_URL is not configured.");
    return false;
  }
  if (!isValidDiscordWebhookUrl(webhookUrl)) {
    console.warn("[DiscordTradeAlert] Rejecting invalid Discord webhook URL.");
    return false;
  }

  try {
    const isBto = alert.action === "BUY_TO_OPEN";
    const isCalls = alert.contractType === "CALL";

    let embedColor: number;
    let title: string;
    let description: string;
    let fields: { name: string; value: string; inline: boolean }[] = [];

    if (isBto) {
      embedColor = isCalls ? 0x10b981 : 0x8b5cf6;
      const emoji = isCalls ? "🟢" : "🟣";
      const mid = alert.btoOptionMid || 0.55;
      const bid = alert.optionBid ?? (mid > 0.05 ? mid - 0.01 : mid);
      const ask = alert.optionAsk ?? mid;
      const maxChaseLimit = Math.min(
        0.99,
        Number((ask + Math.max(0.03, ask * 0.05)).toFixed(2))
      );
      const qty = alert.contractsQty || 1;
      const totalOutlay = alert.totalOutlay || Math.round(ask * 100 * qty);
      const expTabStr = alert.robinhoodTab || alert.robinhoodExp || alert.expHuman || alert.expiration;
      const optSuffix = alert.contractType === "CALL" ? "C" : "P";

      title = `${emoji} BTO ${qty}x ${alert.ticker} ${alert.strike}${optSuffix} @ Ask $${ask.toFixed(2)} (Max Limit $${maxChaseLimit.toFixed(2)})`;
      description = `**Setup:** ${alert.setupName}\n${
        alert.altContractNote ? `⚠️ *${alert.altContractNote}*\n` : ""
      }**Contract:** \`${alert.contractLabel}\``;

      const rrStr = alert.rrRatio
        ? alert.rrRatio.toFixed(2)
        : (
            Math.abs(alert.target1Spot - alert.btoSpotPrice) /
            Math.max(0.01, Math.abs(alert.btoSpotPrice - alert.stopLossSpot))
          ).toFixed(2);

      const tp1Est = alert.estTp1Mid
        ? `T1 **$${alert.target1Spot.toFixed(2)}** (~$${alert.estTp1Mid.toFixed(2)} / +${alert.tp1Pct ?? 45}%)`
        : `T1 **$${alert.target1Spot.toFixed(2)}**`;
      const tp2Est = alert.estTp2Mid
        ? `T2 **$${alert.target2Spot.toFixed(2)}** (~$${alert.estTp2Mid.toFixed(2)} / +${alert.tp2Pct ?? 100}%)`
        : `T2 **$${alert.target2Spot.toFixed(2)}**`;
      const hardStop45 = Number(Math.max(0.01, ask * 0.55).toFixed(2));
      const stopEst = `Hard Stop **$${hardStop45.toFixed(2)} (-45%)** or Spot **$${alert.stopLossSpot.toFixed(2)}**\nRatchet: **+30%→BE** · **+60%→+25%** · **+100%→Trail** · **Flux-Flip ≥+50%**`;

      const wallRoomPts =
        alert.contractType === "CALL" && typeof alert.callWall === "number" && alert.callWall > alert.btoSpotPrice
          ? `CW $${alert.callWall.toFixed(0)} (+$${(alert.callWall - alert.btoSpotPrice).toFixed(2)})`
          : alert.contractType === "PUT" && typeof alert.putWall === "number" && alert.putWall > 0 && alert.putWall < alert.btoSpotPrice
            ? `PW $${alert.putWall.toFixed(0)} (-$${(alert.btoSpotPrice - alert.putWall).toFixed(2)})`
            : `T1 Room $${Math.abs(alert.target1Spot - alert.btoSpotPrice).toFixed(2)} (${rrStr}:1)`;
      const regimeTag = alert.entryRegime || (alert.ceilingShareChi !== undefined && alert.ceilingShareChi >= 0.5 ? "BULL_FLUX" : "BEAR_FLUX");
      const mtfDivTag = `5m:${alert.divergence5m ?? "NO"} / 30m:${alert.divergence30m ?? "NO"}`;
      const fluxPart =
        typeof alert.flowVwap === "number" && typeof alert.ceilingShareChi === "number"
          ? `FVWAP $${alert.flowVwap.toFixed(2)} | χ=${(alert.ceilingShareChi * 100).toFixed(0)}% | Pe=${(alert.pecletNumber ?? 0) >= 0 ? "+" : ""}${(alert.pecletNumber ?? 0).toFixed(2)}`
          : `Spot $${alert.btoSpotPrice.toFixed(2)} | R:R ${rrStr}:1`;
      const confluenceThesis = `**${regimeTag}** · ${wallRoomPts} · MTF Div **${mtfDivTag}**\n${fluxPart}`;

      fields = [
        {
          name: "🎟️ Contract & Robinhood Tab",
          value: `**${alert.ticker} $${alert.strike} ${alert.contractType}**\n📅 Exp: **${alert.expHuman || alert.expiration}**\n👉 **Tab:** \`${expTabStr}\``,
          inline: true,
        },
        {
          name: "💵 Executable Quote & Cap",
          value: `Bid: **$${bid.toFixed(2)}** | Ask: **$${ask.toFixed(2)}**\nMax Chase: **$${maxChaseLimit.toFixed(2)}** · Outlay **$${totalOutlay.toFixed(0)}** (${qty}x)`,
          inline: true,
        },
        {
          name: "🎯 Spot Entry & Invalidation",
          value: `Entry: **$${alert.btoSpotPrice.toFixed(2)}**\nSL: **$${alert.stopLossSpot.toFixed(2)}** · R:R **${rrStr}:1**`,
          inline: true,
        },
        {
          name: "🚀 Spot & Option Targets (T1 / T2)",
          value: `${tp1Est}\n${tp2Est}`,
          inline: false,
        },
        {
          name: "🛡️ Risk Gate (-45% Stop & Profit Ratchet)",
          value: stopEst,
          inline: false,
        },
        {
          name: "🧭 Confluence Thesis",
          value: confluenceThesis,
          inline: false,
        },
        ...(typeof alert.calibratedWinRate === "number"
          ? [
              {
                name: "📊 Empirical Bayes Edge",
                value: `Win: **${alert.calibratedWinRate.toFixed(1)}%** | E[R]: **${(alert.calibratedExpectancyR ?? 0) >= 0 ? "+" : ""}${(alert.calibratedExpectancyR ?? 0).toFixed(2)}R** | Score: **${alert.dataConvictionScore ?? 50}/100**`,
                inline: true,
              },
            ]
          : []),
        {
          name: "⏰ Opened At",
          value: `${alert.timestamp} ET`,
          inline: true,
        },
      ];
    } else {
      const reasonUpper = alert.reason.toUpperCase();
      const pnlPct = alert.pnlOptionPct ?? 0;
      const isProfitable = pnlPct > 0;
      const isBreakeven = Math.abs(pnlPct) <= 2;
      const isTrim = reasonUpper.includes("1 OF 2") || alert.status === "PARTIAL_TP1";

      let badge = "SELL TO CLOSE";
      let emoji = "🎯";

      if (isTrim) {
        embedColor = 0xf59e0b;
        emoji = alert.contractsQty === 2 ? "💰" : "🛡️";
        badge = alert.contractsQty === 2 ? "SELL 1 OF 2 CONTRACTS (LOCK PROFIT)" : "RAISE STOP TO PROFIT";
        title = `${emoji} ${badge} · ${alert.ticker} ${alert.contractType}S`;
      } else if (reasonUpper.includes("REGIME") || reasonUpper.includes("FLIP") || reasonUpper.includes("REVERSAL")) {
        if (pnlPct >= 10) {
          embedColor = 0x10b981;
          emoji = "🔒";
          badge = "REVERSAL PROFIT LOCK";
        } else if (isProfitable || isBreakeven) {
          embedColor = 0x94a3b8;
          emoji = "🔄";
          badge = "MOMENTUM DIVERGENCE SCRATCH";
        } else {
          embedColor = 0x3b82f6;
          emoji = "🔄";
          badge = "REGIME FLIP / REVERSAL EXIT";
        }
        title = `🔄 ${badge} · ${alert.ticker} ${alert.contractType}S`;
      } else if (reasonUpper.includes("TRAILING") || reasonUpper.includes("PROTECT")) {
        embedColor = 0x10b981;
        emoji = "🔒";
        badge = "TRAILING PROFIT LOCKED";
        title = `🔒 ${badge} · ${alert.ticker} ${alert.contractType}S`;
      } else if (reasonUpper.includes("TARGET 2")) {
        embedColor = 0x10b981;
        emoji = "🎯";
        badge = "TARGET 2 FULL PROFIT HIT";
        title = `🎯 ${badge} · ${alert.ticker} ${alert.contractType}S`;
      } else if (reasonUpper.includes("TARGET 1")) {
        embedColor = 0x10b981;
        emoji = "🎯";
        badge = alert.contractsQty === 1 ? "TARGET 1 FULL PROFIT HIT" : "TARGET 1 PROFIT SECURED";
        title = `🎯 ${badge} · ${alert.ticker} ${alert.contractType}S`;
      } else if (
        reasonUpper.includes("15:55") ||
        reasonUpper.includes("3:55") ||
        reasonUpper.includes("12:55") ||
        reasonUpper.includes("CLOSE") ||
        reasonUpper.includes("EOD") ||
        reasonUpper.includes("MOC")
      ) {
        embedColor = isProfitable ? 0x10b981 : 0xf59e0b;
        emoji = "⏰";
        badge = isProfitable ? "EOD MARKET CLOSE CUTOFF (WIN)" : "EOD MARKET CLOSE CUTOFF";
        title = `⏰ ${badge} · ${alert.ticker} ${alert.contractType}S`;
      } else if (isBreakeven || reasonUpper.includes("BREAKEVEN")) {
        embedColor = 0x94a3b8;
        emoji = "⚪";
        badge = "BREAKEVEN STOP";
        title = `⚪ ${badge} · ${alert.ticker} ${alert.contractType}S`;
      } else if (reasonUpper.includes("STOP LOSS") || reasonUpper.includes("INVALIDATION")) {
        embedColor = 0xef4444;
        emoji = "🛑";
        badge = "STOP LOSS HIT";
        title = `🛑 ${badge} · ${alert.ticker} ${alert.contractType}S`;
      } else if (pnlPct >= 50) {
        embedColor = 0x10b981;
        emoji = "🎯";
        badge = "TARGET 2 FULL PROFIT HIT";
        title = `🎯 ${badge} · ${alert.ticker} ${alert.contractType}S`;
      } else if (pnlPct >= 25) {
        embedColor = 0x10b981;
        emoji = "🎯";
        badge = alert.contractsQty === 1 ? "TARGET 1 FULL PROFIT HIT" : "TARGET 1 PROFIT SECURED";
        title = `🎯 ${badge} · ${alert.ticker} ${alert.contractType}S`;
      } else if (isProfitable) {
        embedColor = 0x10b981;
        emoji = "🎯";
        badge = "PROFIT LOCKED";
        title = `🎯 ${badge} · ${alert.ticker} ${alert.contractType}S`;
      } else {
        embedColor = 0xef4444;
        emoji = "🛑";
        badge = "STOP LOSS HIT";
        title = `🛑 ${badge} · ${alert.ticker} ${alert.contractType}S`;
      }

      description = `**Contract:** \`${alert.contractLabel}\` · **Setup:** ${alert.setupName}\n**Exit Action:** ${alert.reason}`;

      const rawSpotDiff = alert.spotPrice - alert.btoSpotPrice;
      const spotChangePct = alert.btoSpotPrice > 0 ? (rawSpotDiff / alert.btoSpotPrice) * 100 : 0;
      const directionalFavor = isCalls ? rawSpotDiff : -rawSpotDiff;
      const directionalFavorPct = isCalls ? spotChangePct : -spotChangePct;

      const spotMoveStr = `${rawSpotDiff >= 0 ? "+" : ""}$${rawSpotDiff.toFixed(2)} (${
        spotChangePct >= 0 ? "+" : ""
      }${spotChangePct.toFixed(2)}%) · ${directionalFavor >= 0 ? "+" : ""}$${directionalFavor.toFixed(
        2
      )} (${directionalFavorPct >= 0 ? "+" : ""}${directionalFavorPct.toFixed(1)}% to ${alert.contractType})`;

      let optionPnlStr = "N/A";
      if (alert.btoOptionMid != null && alert.optionMid != null) {
        const optPct =
          alert.pnlOptionPct != null
            ? alert.pnlOptionPct
            : ((alert.optionMid - alert.btoOptionMid) / alert.btoOptionMid) * 100;
        optionPnlStr = `$${alert.btoOptionMid.toFixed(2)} → $${alert.optionMid.toFixed(2)} (${
          optPct >= 0 ? "+" : ""
        }${optPct.toFixed(1)}%)`;
      }

      let positionActionStr: string;
      if (alert.contractsQty === 2 && alert.remainingQty === 1) {
        positionActionStr = "💰 Sold 1 of 2 Contracts · 1 Runner Active with BE Stop";
      } else if (alert.contractsQty === 1 && alert.status === "PARTIAL_TP1") {
        positionActionStr = "🛡️ Stop Raised to Profit (+25% Min Locked) · 1 Runner Active";
      } else {
        positionActionStr = `100% Position Closed (${alert.contractsQty} Contract${
          alert.contractsQty > 1 ? "s" : ""
        })`;
      }

      fields = [
        { name: "🎯 Underlying Exit", value: `$${alert.spotPrice.toFixed(2)}`, inline: true },
        { name: "🏁 Entry Spot", value: `$${alert.btoSpotPrice.toFixed(2)}`, inline: true },
        { name: "📈 Spot Move", value: spotMoveStr, inline: true },
        { name: "💵 Option Premium", value: optionPnlStr, inline: true },
        {
          name: "📦 Position Action",
          value: positionActionStr,
          inline: true,
        },
        { name: "⏰ Timestamp", value: `${alert.timestamp} ET`, inline: true },
      ];
    }

    const payload = {
      username: "Hyperion Terminal",
      embeds: [
        {
          author: { name: "Hyperion Sub-$1.00 Options Engine (1 Contract Max)" },
          title,
          description,
          color: embedColor,
          fields,
          timestamp: new Date().toISOString(),
          footer: {
            text: isBto
              ? "Hyperion · Sub-$1.00 Small Account Options Engine (1 Contract Max)"
              : "Hyperion · STC Small Account Options Engine",
          },
        },
      ],
    };

    const targetUrl = buildDiscordWebhookDispatchUrl(webhookUrl, { wait: true });

    let lastStatus = 0;

    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await fetch(targetUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: options?.signal,
      });

      lastStatus = res.status;

      if (res.status === 429) {
        if (options?.signal?.aborted) return false;
        const rateData = await res.json().catch(() => null);
        const retryAfterSec = typeof rateData?.retry_after === "number" ? rateData.retry_after : 1.5;
        const sleepMs = Math.min(Math.round(retryAfterSec * 1000) + 100, 5000);
        console.warn(`[DiscordTradeAlert] HTTP 429 rate limit encountered. Backing off for ${sleepMs}ms (attempt ${attempt}/3)...`);
        await new Promise<void>((resolve) => {
          if (options?.signal?.aborted) {
            resolve();
            return;
          }
          let timer: ReturnType<typeof setTimeout> | null = null;
          const onAbort = () => {
            if (timer) clearTimeout(timer);
            resolve();
          };
          timer = setTimeout(() => {
            options?.signal?.removeEventListener("abort", onAbort);
            resolve();
          }, sleepMs);
          options?.signal?.addEventListener("abort", onAbort, { once: true });
        });
        if (options?.signal?.aborted) return false;
        continue;
      }

      if (!res.ok) {
        const lastErrorText = await res.text().catch(() => res.statusText);
        console.error(`[DiscordTradeAlert] HTTP ${res.status} error dispatching to Discord: ${lastErrorText}`);
        return false;
      }

      const bodyData = await res.json().catch(() => null);
      const discordMsgId = bodyData?.id || "";
      console.log(`[DiscordTradeAlert] Successfully dispatched ${alert.action} [${alert.ticker} ${alert.contractType}]. HTTP ${res.status} OK · Message ID: ${discordMsgId}`);
      return true;
    }

    console.error(`[DiscordTradeAlert] Failed to dispatch alert after 3 attempts. Last HTTP status: ${lastStatus}`);
    return false;
  } catch (err) {
    console.error("[DiscordTradeAlert] Network or unexpected exception dispatching Discord webhook:", err);
    return false;
  }
}

export function getCanonicalGaiaSlot(sig: GaiaSpySignalSyncInput): string {
  const lbl = (sig.label || "").toUpperCase();
  const isShort = sig.type === "SHORT" || lbl.includes("SHORT");
  const baseSlot = isShort
    ? lbl.includes("OPEN") || sig.id === "sig-open" || sig.id.startsWith("sig-open")
      ? "SHORT_OPEN"
      : lbl.includes("PEAK") || sig.id === "sig-peak" || sig.id.startsWith("sig-peak")
        ? "SHORT_PEAK"
        : lbl.includes("BREAK") || sig.id.includes("break")
          ? "SHORT_BREAK"
          : `${sig.type}_${sig.time || sig.timeLabel || "SIG"}`
    : lbl.includes("OPEN") || sig.id === "sig-open" || sig.id.startsWith("sig-open")
      ? "LONG_OPEN"
      : lbl.includes("RECLAIM") || sig.id.includes("reclaim")
        ? "LONG_RECLAIM"
        : `${sig.type}_${sig.time || sig.timeLabel || "SIG"}`;

  const idxMatch = sig.id ? sig.id.match(/-(\d+)$/) : null;
  return idxMatch ? `${baseSlot}_${idxMatch[1]}` : baseSlot;
}

/**
 * Single-Writer Telemetry Sync (P0-D1):
 * `liveBotDaemon` -> `evaluateTradeSignals` is the sole authoritative writer for
 * `activePositions`, `closedPositions`, `alerts`, and Discord BTO/STC webhooks.
 * This endpoint updates per-ticker Gaia HUD regime metadata (`gaiaStateByTicker`) only
 * and NEVER opens, closes, or dispatches trades.
 */
export async function syncGaiaTickerSignalsToDiscord(
  params: SyncGaiaTickerParams
): Promise<SyncGaiaTickerResult> {
  if (params.signal?.aborted) {
    return { dispatchedCount: 0, keys: [] };
  }
  const sym = (params.ticker || "").trim().toUpperCase().replace(/^\$/, "");
  const normalizedTicker = sym === "SPX" ? "SPXW" : sym;
  if (!isSupportedTradeTicker(normalizedTicker)) {
    return { dispatchedCount: 0, keys: [] };
  }
  const positionTicker = normalizedTicker === "SPXW" ? "SPY" : normalizedTicker;
  const resolvedDate = params.sessionDate || getTodayEt();
  if (params.isHistoricalBackfill || resolvedDate !== getTodayEt()) {
    return { dispatchedCount: 0, keys: [] };
  }

  const store: DailyTradeStore = loadTradeStore();
  store.gaiaStateByTicker = store.gaiaStateByTicker || {};
  const prevTickerState = store.gaiaStateByTicker[positionTicker] || {};
  const updatedTickerState = {
    activeFsmState:
      params.activeFsmState ??
      prevTickerState.activeFsmState ??
      (positionTicker === "SPY" ? store.activeFsmState : undefined),
    macroRegime:
      params.macroRegime ??
      prevTickerState.macroRegime ??
      (positionTicker === "SPY" ? store.macroRegime : undefined),
    chiPct:
      typeof params.chiPct === "number"
        ? params.chiPct
        : prevTickerState.chiPct ?? (positionTicker === "SPY" ? store.chiPct : undefined),
    zeroGamma:
      typeof params.zeroGamma === "number" && params.zeroGamma > 0
        ? params.zeroGamma
        : prevTickerState.zeroGamma ?? (positionTicker === "SPY" ? store.zeroGamma : undefined),
  };

  let changed =
    prevTickerState.activeFsmState !== updatedTickerState.activeFsmState ||
    prevTickerState.macroRegime !== updatedTickerState.macroRegime ||
    prevTickerState.chiPct !== updatedTickerState.chiPct ||
    prevTickerState.zeroGamma !== updatedTickerState.zeroGamma;
  store.gaiaStateByTicker[positionTicker] = updatedTickerState;

  if (positionTicker === "SPY") {
    if (params.activeFsmState && store.activeFsmState !== params.activeFsmState) {
      store.activeFsmState = params.activeFsmState;
      changed = true;
    }
    if (params.macroRegime && store.macroRegime !== params.macroRegime) {
      store.macroRegime = params.macroRegime;
      changed = true;
    }
    if (typeof params.chiPct === "number" && store.chiPct !== params.chiPct) {
      store.chiPct = params.chiPct;
      changed = true;
    }
    if (typeof params.zeroGamma === "number" && params.zeroGamma > 0 && store.zeroGamma !== params.zeroGamma) {
      store.zeroGamma = params.zeroGamma;
      changed = true;
    }
  }

  if (changed) {
    saveTradeStore(store);
  }

  return { dispatchedCount: 0, keys: [] };
}
