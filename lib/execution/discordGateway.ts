import { computeAdaptiveQuantMetrics } from "@/lib/gaiaSignalFsm";
import { isValidDiscordWebhookUrl } from "@/lib/discordWebhook";
import {
  capExitTsToEodFlat,
  etMinutesOfDay,
  getSessionBoundsEt,
  getTodayEt,
  type SessionBoundsEt,
} from "@/lib/gaiaSessionGuards";
import { DEFAULT_HARD_OPTION_STOP_LOSS_PCT } from "@/lib/bracketOrderEngine";
import {
  ContractType,
  DailyTradeStore,
  GaiaSpySignalSyncInput,
  OptionTradePosition,
  SyncGaiaTickerParams,
  SyncGaiaTickerResult,
  TradeLifecycleAlert,
  isSupportedTradeTicker,
} from "@/lib/execution/types";
import {
  clampOptionPriceToGreekEnvelope,
  formatTimeEt,
  getNowEtTime,
} from "@/lib/execution/optionPricing";
import { selectSmallAccountContract } from "@/lib/execution/contractRouter";
import {
  getGaiaDiscordDedupState,
  loadTradeStore,
  saveTradeStore,
} from "@/lib/execution/ledgerCommit";

export function isAlertDispatchEligible(
  alert: TradeLifecycleAlert,
  realNowTs: number,
  sessionBounds: SessionBoundsEt
): boolean {
  if (alert.isHistoricalBackfill) return false;

  const etMins = etMinutesOfDay(realNowTs);
  if (alert.action === "BUY_TO_OPEN") {
    const isFresh = Math.abs(realNowTs - alert.ts) <= 180;
    const isRth = etMins >= sessionBounds.rthOpenMins && etMins < sessionBounds.rthCloseMins;
    return isFresh && isRth;
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

    const targetUrl = webhookUrl.includes("?")
      ? `${webhookUrl}&wait=true`
      : `${webhookUrl}?wait=true`;

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

function getCanonicalGaiaSlot(sig: GaiaSpySignalSyncInput): string {
  const lbl = (sig.label || "").toUpperCase();
  const baseSlot =
    lbl.includes("OPEN") || sig.id === "sig-open" || sig.id.startsWith("sig-open")
      ? "LONG_OPEN"
      : lbl.includes("PEAK") || sig.id === "sig-peak" || sig.id.startsWith("sig-peak")
      ? "SHORT_PEAK"
      : lbl.includes("BREAK") || sig.id.includes("break")
      ? "SHORT_BREAK"
      : lbl.includes("RECLAIM") || sig.id.includes("reclaim")
      ? "LONG_RECLAIM"
      : `${sig.type}_${sig.time || sig.timeLabel || "SIG"}`;

  const idxMatch = sig.id ? sig.id.match(/-(\d+)$/) : null;
  return idxMatch ? `${baseSlot}_${idxMatch[1]}` : baseSlot;
}

export async function syncGaiaTickerSignalsToDiscord(params: SyncGaiaTickerParams): Promise<SyncGaiaTickerResult> {
  const sym = (params.ticker || "").trim().toUpperCase().replace(/^\$/, "");
  const normalizedTicker = sym === "SPX" ? "SPXW" : sym;
  if (!isSupportedTradeTicker(normalizedTicker)) {
    return { dispatchedCount: 0, keys: [] };
  }
  const isSpxwSync = normalizedTicker === "SPXW";
  const positionTicker = isSpxwSync ? "SPY" : normalizedTicker;
  const tickerSlug = positionTicker.toLowerCase().replace(/[^a-z0-9]/g, "") || "ticker";
  const resolvedDate = params.sessionDate || getTodayEt();
  const sessionBounds = getSessionBoundsEt(resolvedDate);

  let store = loadTradeStore();
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

  const applyGaiaStateToStore = (targetStore: DailyTradeStore): boolean => {
    targetStore.gaiaStateByTicker = targetStore.gaiaStateByTicker || {};
    const existing = targetStore.gaiaStateByTicker[positionTicker] || {};
    let changed =
      existing.activeFsmState !== updatedTickerState.activeFsmState ||
      existing.macroRegime !== updatedTickerState.macroRegime ||
      existing.chiPct !== updatedTickerState.chiPct ||
      existing.zeroGamma !== updatedTickerState.zeroGamma;
    targetStore.gaiaStateByTicker[positionTicker] = updatedTickerState;
    if (positionTicker === "SPY") {
      if (params.activeFsmState && targetStore.activeFsmState !== params.activeFsmState) {
        targetStore.activeFsmState = params.activeFsmState;
        changed = true;
      }
      if (params.macroRegime && targetStore.macroRegime !== params.macroRegime) {
        targetStore.macroRegime = params.macroRegime;
        changed = true;
      }
      if (typeof params.chiPct === "number" && targetStore.chiPct !== params.chiPct) {
        targetStore.chiPct = params.chiPct;
        changed = true;
      }
      if (typeof params.zeroGamma === "number" && params.zeroGamma > 0 && targetStore.zeroGamma !== params.zeroGamma) {
        targetStore.zeroGamma = params.zeroGamma;
        changed = true;
      }
    }
    return changed;
  };
  const gaiaStateChanged = applyGaiaStateToStore(store);

  const tickerPos = store.activePositions[positionTicker];
  const isTickerStructural = Boolean(tickerPos && !tickerPos.setupName.includes("Gaia Tactical HUD"));
  const guardNowDate = new Date();
  const guardRawNowTs = Math.floor(guardNowDate.getTime() / 1000);
  const guardNowEt = getNowEtTime(guardNowDate);
  const isGuardMocCutoff = !params.isHistoricalBackfill && guardNowEt.totalMinutes >= sessionBounds.eodFlatMins;
  const guardHeldSec = tickerPos ? guardRawNowTs - (tickerPos.openedTs || guardRawNowTs) : 0;
  const rawParamsSpot = Number(params.spotPrice);
  const guardCloseSpot =
    rawParamsSpot > 0
      ? (isSpxwSync ? Number((rawParamsSpot / 10).toFixed(2)) : Number(rawParamsSpot.toFixed(2)))
      : (tickerPos?.btoSpotPrice ?? 0);
  const guardAdverseMove = tickerPos
    ? (tickerPos.contractType === "CALL" ? tickerPos.btoSpotPrice - guardCloseSpot : guardCloseSpot - tickerPos.btoSpotPrice)
    : 0;
  const guardMinInvalidation = computeAdaptiveQuantMetrics(
    guardCloseSpot,
    tickerPos?.atr5m ?? guardCloseSpot * 0.0018
  ).minReversalInvalidation;

  let guardExitReason: string | null = null;
  if (tickerPos && !isTickerStructural) {
    const isGuardCall = tickerPos.contractType === "CALL";
    const isGuardWinning = isGuardCall
      ? guardCloseSpot > tickerPos.btoSpotPrice
      : guardCloseSpot < tickerPos.btoSpotPrice;
    if (isGuardMocCutoff) {
      guardExitReason = sessionBounds.isEarlyClose
        ? "12:55 PM ET HARD EARLY-CLOSE MARKET CUTOFF"
        : "15:55 PM ET HARD MARKET CLOSE CUTOFF";
    } else if (
      params.activeFsmState === "STAND_ASIDE" &&
      guardHeldSec >= 600 &&
      (guardAdverseMove >= guardMinInvalidation || isGuardWinning)
    ) {
      guardExitReason = "Gaia FSM Neutralization to STAND_ASIDE";
    } else if (
      guardHeldSec >= 600 &&
      guardAdverseMove >= guardMinInvalidation &&
      !isGuardCall &&
      (params.activeFsmState === "LONG" || (updatedTickerState.macroRegime === "CALL" && (updatedTickerState.chiPct ?? 50) > 52))
    ) {
      guardExitReason = "Macro Rotation to Bull Regime";
    } else if (
      guardHeldSec >= 600 &&
      guardAdverseMove >= guardMinInvalidation &&
      isGuardCall &&
      (params.activeFsmState === "SHORT" || (updatedTickerState.macroRegime === "PUT" && (updatedTickerState.chiPct ?? 50) < 48))
    ) {
      guardExitReason = "Macro Rotation to Bear Regime";
    }
  }

  let guardSaved = false;
  if (guardExitReason && tickerPos) {
    console.warn(`[GaiaSync] Closed ${positionTicker} ${tickerPos.contractType} position: ${guardExitReason}`);
    const isGuardCall = tickerPos.contractType === "CALL";
    const entryOptPrice = tickerPos.btoOptionMid || tickerPos.optionAsk || 0.50;
    const dirMove = isGuardCall ? guardCloseSpot - tickerPos.btoSpotPrice : tickerPos.btoSpotPrice - guardCloseSpot;
    const spotMovePct = Number(((dirMove / Math.max(0.01, tickerPos.btoSpotPrice)) * 100).toFixed(2));
    const rawEstOpt = Math.max(0.05, Number((entryOptPrice + dirMove * 0.45).toFixed(2)));
    const closedOptMid = clampOptionPriceToGreekEnvelope(
      tickerPos.btoSpotPrice,
      guardCloseSpot,
      entryOptPrice,
      rawEstOpt,
      isGuardCall,
      Math.max(1, guardHeldSec / 60)
    );
    const pnlOptionPct = Number((((closedOptMid - entryOptPrice) / Math.max(0.01, entryOptPrice)) * 100).toFixed(2));

    const needsGuardCap =
      isGuardMocCutoff ||
      guardNowEt.totalMinutes >= sessionBounds.rthCloseMins ||
      guardNowEt.totalMinutes < sessionBounds.rthOpenMins;
    const guardNowTs = needsGuardCap ? capExitTsToEodFlat(guardRawNowTs, resolvedDate).ts : guardRawNowTs;
    const guardTimeStr = formatTimeEt(guardNowTs);
    const isGuardLiveRth =
      guardNowEt.totalMinutes >= sessionBounds.rthOpenMins &&
      guardNowEt.totalMinutes < sessionBounds.rthCloseMins;
    const isGuardHistorical =
      Boolean(params.isHistoricalBackfill || tickerPos.originBackfill) || !isGuardLiveRth;
    const guardExitAlertId = `${tickerPos.id}-guard-stc`;

    tickerPos.status = "CLOSED";
    tickerPos.remainingQty = 0;
    tickerPos.closedTs = guardNowTs;
    tickerPos.closedAt = guardTimeStr;
    tickerPos.closedSpotPrice = guardCloseSpot;
    tickerPos.closedOptionMid = closedOptMid;
    tickerPos.pnlSpotPct = spotMovePct;
    tickerPos.pnlOptionPct = pnlOptionPct;
    tickerPos.exitReason = guardExitReason;

    const guardExitAlert: TradeLifecycleAlert = {
      id: guardExitAlertId,
      timestamp: guardTimeStr,
      ts: guardNowTs,
      ticker: positionTicker,
      action: "SELL_TO_CLOSE",
      contractType: tickerPos.contractType,
      contractLabel: tickerPos.contractLabel,
      strike: tickerPos.strike,
      expiration: tickerPos.expiration,
      expHuman: tickerPos.expHuman,
      robinhoodExp: tickerPos.robinhoodExp,
      setupName: tickerPos.setupName,
      reason: guardExitReason,
      status: "CLOSED",
      spotPrice: guardCloseSpot,
      btoSpotPrice: tickerPos.btoSpotPrice,
      target1Spot: tickerPos.target1Spot,
      target2Spot: tickerPos.target2Spot,
      stopLossSpot: tickerPos.stopLossSpot,
      optionMid: closedOptMid,
      optionBid: closedOptMid,
      optionAsk: closedOptMid,
      btoOptionMid: entryOptPrice,
      contractsQty: tickerPos.contractsQty,
      remainingQty: 0,
      totalOutlay: tickerPos.totalOutlay,
      pnlSpotPct: spotMovePct,
      pnlOptionPct,
      isHistoricalBackfill: isGuardHistorical,
      eventId: guardExitAlertId,
      message: `🔴 STC · ${tickerPos.contractLabel} [${guardExitReason}] @ $${guardCloseSpot.toFixed(2)} · Spot ${spotMovePct >= 0 ? "+" : ""}${spotMovePct}% (${pnlOptionPct >= 0 ? "+" : ""}${pnlOptionPct}%)`,
    };

    store.closedPositions.push(tickerPos);
    delete store.activePositions[positionTicker];
    store.alerts.push(guardExitAlert);
    saveTradeStore(store);
    guardSaved = true;

    if (!isGuardHistorical && !params.signal?.aborted) {
      const sent = await sendDiscordTradeAlert(guardExitAlert, params.webhookUrl, { signal: params.signal }).catch(
        (err) => {
          console.error("[GaiaSync] Failed to dispatch Consistency Guard STC alert to Discord:", err);
          return false;
        }
      );
      if (sent) {
        const afterGuardSend = loadTradeStore();
        afterGuardSend.dispatchedAlertIds = afterGuardSend.dispatchedAlertIds || {};
        afterGuardSend.dispatchedAlertIds[guardExitAlertId] = true;
        saveTradeStore(afterGuardSend);
        store = afterGuardSend;
      }
    }
  }

  const rawSignals = Array.isArray(params.signals) ? params.signals : [];
  if (rawSignals.length === 0 || params.activeFsmState === "STAND_ASIDE") {
    if (gaiaStateChanged && !guardSaved) {
      saveTradeStore(store);
    }
    return { dispatchedCount: 0, keys: [] };
  }
  if (gaiaStateChanged && !guardSaved) {
    saveTradeStore(store);
  }

  const dispatchedSet = getGaiaDiscordDedupState().syncDate(resolvedDate);
  const sorted = [...rawSignals].sort((a, b) => (a.index ?? a.idx ?? 0) - (b.index ?? b.idx ?? 0));
  const newlyDispatched: string[] = [];

  for (let i = 0; i < sorted.length; i++) {
    if (params.signal?.aborted) break;
    store = loadTradeStore();
    const sig = sorted[i];
    const nextSig = sorted[i + 1];
    const slot = getCanonicalGaiaSlot(sig);
    const rawSigTs = sig.timestamp || sig.barTimestamp;
    const nowTs = Math.floor(Date.now() / 1000);
    const eventTs =
      typeof rawSigTs === "number" && rawSigTs > 0
        ? rawSigTs > 1e11
          ? Math.floor(rawSigTs / 1000)
          : rawSigTs
        : nowTs;
    const isCall = sig.type === "LONG";
    const direction: ContractType = isCall ? "CALL" : "PUT";

    const tickerFsmState = updatedTickerState.activeFsmState;
    const tickerChiPct = updatedTickerState.chiPct;
    const effectiveMacro =
      updatedTickerState.macroRegime ||
      (tickerChiPct !== undefined ? (tickerChiPct > 50 ? "CALL" : "PUT") : undefined);
    if (
      direction === "PUT" &&
      (tickerFsmState === "LONG" || (effectiveMacro === "CALL" && (tickerChiPct ?? 50) > 52))
    ) {
      console.warn(`[GaiaSync FIREWALL] Blocked ${positionTicker} PUT signal at $${sig.price} while regime is ${effectiveMacro} / FSM ${tickerFsmState} (χ=${tickerChiPct}%).`);
      continue;
    }
    const zgRef =
      typeof params.zeroGamma === "number" && params.zeroGamma > 0
        ? params.zeroGamma
        : typeof updatedTickerState.zeroGamma === "number" && updatedTickerState.zeroGamma > 0
          ? updatedTickerState.zeroGamma
          : undefined;
    const isBelowZeroGamma = typeof zgRef === "number" && zgRef > 0 && sig.price < zgRef;
    const isChiBearish = (tickerChiPct ?? 50) < 50;

    const sigDate = new Date(eventTs * 1000);
    const sigEt = getNowEtTime(sigDate);
    const inferredIntervalSec =
      typeof sig.barSpanSeconds === "number" && sig.barSpanSeconds > 0
        ? sig.barSpanSeconds
        : 300;
    const eventCloseTs = sig.barCloseTimestamp || (eventTs + inferredIntervalSec);
    const eventCloseEtMins = etMinutesOfDay(eventCloseTs);
    if (
      sigEt.totalMinutes < sessionBounds.entryStartMins ||
      sigEt.totalMinutes > sessionBounds.entryCutoffMins ||
      eventCloseEtMins > sessionBounds.entryCutoffMins
    ) {
      console.warn(
        `[GaiaSync FIREWALL] Blocked signal outside entry window (${sigEt.hours}:${String(sigEt.minutes).padStart(2, "0")}, closeEtMins=${eventCloseEtMins} > ${sessionBounds.entryCutoffMins}).`
      );
      continue;
    }
    const storedSpotNorm = store.prevSpotPrices[normalizedTicker];
    const storedSpotPos = store.prevSpotPrices[positionTicker];
    const scaledStoredPos =
      typeof storedSpotPos === "number" && storedSpotPos > 0
        ? (isSpxwSync ? storedSpotPos * 10 : storedSpotPos)
        : undefined;
    const liveSpotRef =
      Number(params.spotPrice) > 0
        ? Number(params.spotPrice)
        : (storedSpotNorm ?? scaledStoredPos);
    if (typeof liveSpotRef === "number" && liveSpotRef > 0) {
      const basisDiffPct = Math.abs(sig.price - liveSpotRef) / liveSpotRef;
      if (basisDiffPct > 0.0075) {
        console.warn(`[GaiaSync FIREWALL] Blocked unphysical ${positionTicker} signal price ${sig.price} vs live spot ${liveSpotRef}`);
        continue;
      }
    }
    const isOpeningRangeSig = sigEt.totalMinutes < 585;
    const priorCloseRef =
      typeof storedSpotNorm === "number" && storedSpotNorm > 0
        ? storedSpotNorm
        : typeof scaledStoredPos === "number" && scaledStoredPos > 0
          ? scaledStoredPos
          : Number(params.spotPrice) > 0
            ? Number(params.spotPrice)
            : undefined;
    const isOpeningNegativeGamma =
      isOpeningRangeSig &&
      (isBelowZeroGamma ||
        (typeof priorCloseRef === "number" && sig.price < priorCloseRef) ||
        isChiBearish);

    const isImpulseCallReclaim =
      !isOpeningRangeSig &&
      ((params.impulseChi ?? 0) >= 0.60 ||
        Boolean(sig.label?.includes("Impulse") || sig.tag?.includes("IMPULSE")));
    const isHardBearishFlux = (tickerChiPct ?? 50) < 45 || effectiveMacro === "PUT" || tickerFsmState === "SHORT";
    if (
      direction === "CALL" &&
      !isImpulseCallReclaim &&
      (isHardBearishFlux || isBelowZeroGamma || isOpeningNegativeGamma)
    ) {
      console.warn(
        `[GaiaSync FIREWALL] Blocked Counter-Trend ${positionTicker} CALL signal at $${sig.price} (below ZG: ${isBelowZeroGamma}, χ: ${tickerChiPct}%, FSM: ${tickerFsmState}, Macro: ${effectiveMacro}, OpeningRange: ${isOpeningRangeSig}, PriorClose: ${priorCloseRef}).`
      );
      continue;
    }

    const idempotencyKey = `${positionTicker}_${eventTs}_${direction}`;
    const entryKey = `${resolvedDate}:${positionTicker}:ENTRY:${slot}:${idempotencyKey}`;

    if (!dispatchedSet.has(entryKey) && !store.dispatchedAlertIds?.[idempotencyKey]) {
      const sameTickerClosed = (store.closedPositions ?? []).filter(
        (p) => p.ticker === positionTicker || p.ticker === normalizedTicker
      );
      const closedCount = sameTickerClosed.length;
      const prevClosed = sameTickerClosed.reduce<OptionTradePosition | undefined>(
        (latest, cur) => (!latest || (cur.closedTs ?? 0) >= (latest.closedTs ?? 0) ? cur : latest),
        undefined
      );
      const prevCooldownMet =
        closedCount === 1 &&
        typeof prevClosed?.closedTs === "number" &&
        eventTs - prevClosed.closedTs >= 1800;
      const canPhase2OppositeReclaim =
        closedCount === 1 &&
        prevCooldownMet &&
        sigEt.totalMinutes >= 630 &&
        sigEt.totalMinutes <= sessionBounds.entryCutoffMins &&
        prevClosed?.contractType !== direction;
      if (closedCount >= 2 || (closedCount >= 1 && !canPhase2OppositeReclaim)) {
        console.warn(`[GaiaSync FIREWALL] Blocked ${positionTicker} trade dispatch: Day is LOCKED_FOR_DAY (${closedCount} closed trades on ${positionTicker}).`);
        continue;
      }
      const activePos = store.activePositions[positionTicker];
      if (activePos && activePos.status === "OPEN") {
        console.warn(`[GaiaSync FIREWALL] Blocked trade dispatch: ${positionTicker} already has an ACTIVE position (${activePos.contractLabel}).`);
        continue;
      }
      if (Object.keys(store.activePositions || {}).length >= 1) {
        console.warn("[GaiaSync FIREWALL] Blocked trade dispatch: Another ticker position is already ACTIVE.");
        continue;
      }

      const posSigPrice = isSpxwSync ? Number((sig.price / 10).toFixed(2)) : Number(sig.price.toFixed(2));
      const syncStopDist = Math.max(0.05, Number((posSigPrice * 0.0016).toFixed(2)));
      const syncTp1Dist = Math.ceil((syncStopDist * 1.5 - 1e-9) * 100) / 100;
      const syncTp2Dist = Math.max(syncTp1Dist + 0.05, Number((posSigPrice * 0.0047).toFixed(2)));
      const target1Spot = isCall
        ? Number((posSigPrice + syncTp1Dist).toFixed(2))
        : Number((posSigPrice - syncTp1Dist).toFixed(2));
      const target2Spot = isCall
        ? Number((posSigPrice + syncTp2Dist).toFixed(2))
        : Number((posSigPrice - syncTp2Dist).toFixed(2));
      const stopLossSpot = isCall
        ? Number((posSigPrice - syncStopDist).toFixed(2))
        : Number((posSigPrice + syncStopDist).toFixed(2));

      const contractSpot = isSpxwSync ? Number((posSigPrice * 10).toFixed(2)) : posSigPrice;
      const contractT1 = isSpxwSync ? Number((target1Spot * 10).toFixed(2)) : target1Spot;
      const contractT2 = isSpxwSync ? Number((target2Spot * 10).toFixed(2)) : target2Spot;
      const contractSl = isSpxwSync ? Number((stopLossSpot * 10).toFixed(2)) : stopLossSpot;
      const optimal = await selectSmallAccountContract({
        ticker: normalizedTicker,
        contractType: direction,
        spotPrice: contractSpot,
        target1Spot: contractT1,
        target2Spot: contractT2,
        stopLossSpot: contractSl,
        conviction: 92,
        nowEt: sigDate,
        contractsAlreadyAnchored: true,
        signal: params.signal,
      }).catch(() => null);

      if (params.signal?.aborted) break;
      if (!optimal) {
        console.warn(`[GaiaSync FIREWALL] No qualifying live contract under $1.00 for ${normalizedTicker} ${direction} @ $${posSigPrice.toFixed(2)} — skipping synthetic fallback.`);
        continue;
      }

      const strike = optimal.strike;
      const expDate = optimal.expiration;
      const contractLabel = optimal.contractLabel;
      const entryAsk = optimal.optionAsk || optimal.optionMid;
      const contractsQty: 1 = 1;
      const singleContractCents = Math.round(entryAsk * 10000);
      if (singleContractCents > 10000) {
        console.warn(`[GaiaSync FIREWALL] Blocked ${positionTicker} outlay $${(singleContractCents / 100).toFixed(2)} (> $100 cap).`);
        continue;
      }
      const totalOutlay = singleContractCents / 100;
      const estTp1 = optimal.estTp1Mid;
      const estTp2 = optimal.estTp2Mid;
      const maxStopLossFloor = Number((entryAsk * (1 - DEFAULT_HARD_OPTION_STOP_LOSS_PCT / 100)).toFixed(2));
      const estStop = Math.max(maxStopLossFloor, optimal.estStopMid);
      const tp1Pct = Math.round(((estTp1 - entryAsk) / Math.max(0.01, entryAsk)) * 100);
      const tp2Pct = Math.round(((estTp2 - entryAsk) / Math.max(0.01, entryAsk)) * 100);
      const alertTimeStr = sig.time || sig.timeLabel || formatTimeEt(sigDate);

      const isStale = nowTs - eventCloseTs > Math.round(inferredIntervalSec * 1.5);
      const isRthWindow =
        sigEt.totalMinutes >= sessionBounds.rthOpenMins &&
        sigEt.totalMinutes < sessionBounds.rthCloseMins;
      const isHistoricalBackfill = isStale || !isRthWindow || Boolean(params.isHistoricalBackfill);
      const alertId = `gaia-${tickerSlug}-${entryKey.toLowerCase().replace(/[^a-z0-9]/g, "-")}`;

      const btoAlert: TradeLifecycleAlert = {
        id: alertId,
        timestamp: alertTimeStr,
        ts: eventTs,
        dispatchedAt: nowTs,
        ticker: positionTicker,
        action: "BUY_TO_OPEN",
        contractType: direction,
        contractLabel,
        strike,
        expiration: expDate,
        expHuman: optimal.expHuman,
        robinhoodExp: optimal.robinhoodExp,
        robinhoodTab: optimal.robinhoodTab,
        setupName: `Gaia Tactical HUD [${sig.label || sig.type}]`,
        reason: `Gaia Intraday ${sig.label || sig.type} signal at $${posSigPrice.toFixed(2)}`,
        status: "OPEN",
        spotPrice: posSigPrice,
        btoSpotPrice: posSigPrice,
        target1Spot,
        target2Spot,
        stopLossSpot,
        optionMid: entryAsk,
        optionBid: optimal.optionBid,
        optionAsk: entryAsk,
        btoOptionMid: entryAsk,
        contractsQty,
        remainingQty: contractsQty,
        totalOutlay,
        estTp1Mid: estTp1,
        estTp2Mid: estTp2,
        estStopMid: estStop,
        tp1Pct,
        tp2Pct,
        rrRatio: 1.5,
        altContractNote: optimal.altContractNote,
        isHistoricalBackfill,
        eventId: alertId,
        message: `${isCall ? "🟢" : "🟣"} BUY TO OPEN (${contractsQty}x @ $${entryAsk.toFixed(2)}) · ${positionTicker} [Gaia ${sig.label || sig.type}] @ $${posSigPrice.toFixed(2)} · SL: $${stopLossSpot}, TP1: $${target1Spot}, TP2: $${target2Spot}`,
      };

      const newPos: OptionTradePosition = {
        id: alertId,
        ticker: positionTicker,
        contractType: direction,
        contractLabel,
        strike,
        expiration: expDate,
        expHuman: optimal.expHuman,
        robinhoodExp: optimal.robinhoodExp,
        robinhoodTab: optimal.robinhoodTab,
        setupName: btoAlert.setupName,
        status: "OPEN",
        btoSpotPrice: posSigPrice,
        btoOptionMid: entryAsk,
        optionBid: optimal.optionBid,
        optionAsk: entryAsk,
        contractsQty,
        remainingQty: contractsQty,
        totalOutlay,
        estTp1Mid: estTp1,
        estTp2Mid: estTp2,
        estStopMid: estStop,
        tp1Pct,
        tp2Pct,
        target1Spot,
        target2Spot,
        stopLossSpot,
        openedAt: alertTimeStr,
        openedTs: eventTs,
        rrRatio: 1.5,
        initialRisk: Number(Math.max(0.05, Math.abs(posSigPrice - stopLossSpot)).toFixed(2)),
        atr5m: Number((posSigPrice * 0.0018).toFixed(4)),
        altContractNote: optimal.altContractNote,
        originBackfill: isHistoricalBackfill,
      };

      if (params.signal?.aborted) break;
      const latestStoreBeforeCommit = loadTradeStore();
      if (Object.keys(latestStoreBeforeCommit.activePositions || {}).length > 0) {
        console.warn(`[GaiaSync FIREWALL] Aborted ${positionTicker} commit: global slot became occupied during option lookup.`);
        continue;
      }
      applyGaiaStateToStore(latestStoreBeforeCommit);
      latestStoreBeforeCommit.activePositions[positionTicker] = newPos;
      latestStoreBeforeCommit.alerts.push(btoAlert);
      latestStoreBeforeCommit.dispatchedAlertIds = latestStoreBeforeCommit.dispatchedAlertIds || {};
      if (isHistoricalBackfill) {
        dispatchedSet.add(entryKey);
        newlyDispatched.push(entryKey);
        latestStoreBeforeCommit.dispatchedAlertIds[btoAlert.id] = true;
        latestStoreBeforeCommit.dispatchedAlertIds[idempotencyKey] = true;
        saveTradeStore(latestStoreBeforeCommit);
        store = latestStoreBeforeCommit;
      } else {
        saveTradeStore(latestStoreBeforeCommit);
        store = latestStoreBeforeCommit;
        const sent = await sendDiscordTradeAlert(btoAlert, params.webhookUrl, { signal: params.signal }).catch((err) => {
          console.error("[GaiaSync] Failed to dispatch BTO alert to Discord:", err);
          return false;
        });
        if (sent) {
          dispatchedSet.add(entryKey);
          newlyDispatched.push(entryKey);
          const afterSendStore = loadTradeStore();
          afterSendStore.dispatchedAlertIds = afterSendStore.dispatchedAlertIds || {};
          afterSendStore.dispatchedAlertIds[btoAlert.id] = true;
          afterSendStore.dispatchedAlertIds[idempotencyKey] = true;
          saveTradeStore(afterSendStore);
          store = afterSendStore;
        }
      }
    }

    if (nextSig && nextSig.type !== sig.type) {
      if (params.signal?.aborted) break;
      const latestExitStore = loadTradeStore();
      const openPos = latestExitStore.activePositions[positionTicker];
      if (!openPos || openPos.contractType !== direction) {
        continue;
      }
      const nextSigRawTs = nextSig.timestamp || nextSig.barTimestamp || Math.floor(Date.now() / 1000);
      const rawNextSigEpochSec = nextSigRawTs > 1e11 ? Math.floor(nextSigRawTs / 1000) : nextSigRawTs;
      const nextSigEtRaw = getNowEtTime(new Date(rawNextSigEpochSec * 1000));
      const nextSigNeedsCap =
        nextSigEtRaw.totalMinutes >= sessionBounds.eodFlatMins ||
        nextSigEtRaw.totalMinutes >= sessionBounds.rthCloseMins ||
        nextSigEtRaw.totalMinutes < sessionBounds.rthOpenMins;
      const nextSigEpochSec = nextSigNeedsCap
        ? capExitTsToEodFlat(rawNextSigEpochSec, resolvedDate).ts
        : rawNextSigEpochSec;
      const nextPosPrice = isSpxwSync ? Number((nextSig.price / 10).toFixed(2)) : Number(nextSig.price.toFixed(2));
      const heldSeconds = nextSigEpochSec - (openPos.openedTs || nextSigEpochSec);
      const adverseSpot = isCall ? openPos.btoSpotPrice - nextPosPrice : nextPosPrice - openPos.btoSpotPrice;
      const estOptMovePct = (((isCall ? nextPosPrice - openPos.btoSpotPrice : openPos.btoSpotPrice - nextPosPrice) * 0.45) / Math.max(0.01, openPos.btoOptionMid || 0.5)) * 100;
      const minSyncRev = computeAdaptiveQuantMetrics(
        nextPosPrice,
        openPos.atr5m ?? nextPosPrice * 0.0018
      ).minReversalInvalidation;
      if (heldSeconds < 600 || (adverseSpot < minSyncRev && estOptMovePct < 10)) {
        continue;
      }

      const exitKey = `${resolvedDate}:${positionTicker}:EXIT:${slot}`;
      const dedupExitAlertId = `gaia-${tickerSlug}-${exitKey.toLowerCase().replace(/[^a-z0-9]/g, "-")}`;
      if (!dispatchedSet.has(exitKey) && !latestExitStore.dispatchedAlertIds?.[dedupExitAlertId]) {
        const entrySpot = openPos.btoSpotPrice;
        const entryOptMid = openPos.btoOptionMid || openPos.optionAsk || 0.50;
        const underlyingMove = isCall ? nextPosPrice - entrySpot : entrySpot - nextPosPrice;
        const spotMovePct = Number(((underlyingMove / Math.max(0.01, entrySpot)) * 100).toFixed(2));
        const rawEstExit = Math.max(0.05, Number((entryOptMid + underlyingMove * 0.45).toFixed(2)));
        const estExitPrice = clampOptionPriceToGreekEnvelope(
          entrySpot,
          nextPosPrice,
          entryOptMid,
          rawEstExit,
          isCall,
          Math.max(1, heldSeconds / 60)
        );
        const pnlOptionPct = Number((((estExitPrice - entryOptMid) / Math.max(0.01, entryOptMid)) * 100).toFixed(1));
        const exitAlertId = dedupExitAlertId;
        const nextSigDate = new Date(nextSigEpochSec * 1000);
        const exitTimeStr = nextSigNeedsCap
          ? formatTimeEt(nextSigEpochSec)
          : nextSig.time || nextSig.timeLabel || formatTimeEt(nextSigDate);
        const nextSigEt = getNowEtTime(nextSigDate);
        const isExitRthWindow =
          nextSigEt.totalMinutes >= sessionBounds.rthOpenMins &&
          nextSigEt.totalMinutes < sessionBounds.rthCloseMins;
        const isExitStale = Math.floor(Date.now() / 1000) - nextSigEpochSec > 450;
        const isExitHistorical =
          isExitStale ||
          !isExitRthWindow ||
          Boolean(params.isHistoricalBackfill || openPos.originBackfill);

        const exitAlert: TradeLifecycleAlert = {
          id: exitAlertId,
          timestamp: exitTimeStr,
          ts: nextSigEpochSec,
          ticker: positionTicker,
          action: "SELL_TO_CLOSE",
          contractType: direction,
          contractLabel: openPos.contractLabel,
          strike: openPos.strike,
          expiration: openPos.expiration,
          setupName: openPos.setupName,
          reason: `Gaia closed on reversal transition to ${nextSig.label || nextSig.type}`,
          status: "CLOSED",
          spotPrice: nextPosPrice,
          btoSpotPrice: entrySpot,
          target1Spot: openPos.target1Spot,
          target2Spot: openPos.target2Spot,
          stopLossSpot: openPos.stopLossSpot,
          optionMid: estExitPrice,
          optionBid: estExitPrice,
          optionAsk: estExitPrice,
          btoOptionMid: entryOptMid,
          contractsQty: openPos.contractsQty,
          remainingQty: 0,
          totalOutlay: openPos.totalOutlay,
          pnlSpotPct: spotMovePct,
          pnlOptionPct,
          isHistoricalBackfill: isExitHistorical,
          eventId: exitAlertId,
          message: `🔴 SELL TO CLOSE · ${openPos.contractLabel} [Gaia ${sig.label || sig.type}] @ $${nextPosPrice.toFixed(2)} · Spot ${spotMovePct >= 0 ? "+" : ""}${spotMovePct}% (${pnlOptionPct >= 0 ? "+" : ""}${pnlOptionPct}%)`,
        };

        openPos.status = "CLOSED";
        openPos.remainingQty = 0;
        openPos.closedAt = exitTimeStr;
        openPos.closedTs = nextSigEpochSec;
        openPos.closedSpotPrice = nextPosPrice;
        openPos.closedOptionMid = estExitPrice;
        openPos.pnlOptionPct = pnlOptionPct;
        openPos.pnlSpotPct = spotMovePct;
        openPos.exitReason = exitAlert.reason;
        latestExitStore.closedPositions.push(openPos);
        delete latestExitStore.activePositions[positionTicker];

        latestExitStore.alerts.push(exitAlert);
        latestExitStore.dispatchedAlertIds = latestExitStore.dispatchedAlertIds || {};
        if (isExitHistorical) {
          dispatchedSet.add(exitKey);
          newlyDispatched.push(exitKey);
          latestExitStore.dispatchedAlertIds[exitAlert.id] = true;
          saveTradeStore(latestExitStore);
          store = latestExitStore;
        } else {
          saveTradeStore(latestExitStore);
          store = latestExitStore;
          const sent = await sendDiscordTradeAlert(exitAlert, params.webhookUrl, { signal: params.signal }).catch((err) => {
            console.error("[GaiaSync] Failed to dispatch STC alert to Discord:", err);
            return false;
          });
          if (sent) {
            dispatchedSet.add(exitKey);
            newlyDispatched.push(exitKey);
            const afterExitSend = loadTradeStore();
            afterExitSend.dispatchedAlertIds = afterExitSend.dispatchedAlertIds || {};
            afterExitSend.dispatchedAlertIds[exitAlert.id] = true;
            saveTradeStore(afterExitSend);
            store = afterExitSend;
          }
        }
      }
    }
  }

  return { dispatchedCount: newlyDispatched.length, keys: newlyDispatched };
}
