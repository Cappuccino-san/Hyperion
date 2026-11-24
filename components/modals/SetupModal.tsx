"use client";

import React, { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Bell, Check, Loader2, Send, Settings, ShieldCheck, X } from "lucide-react";
import { useDashboardStore } from "@/store/useDashboardStore";

interface SetupModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SetupModal({ open, onOpenChange }: SetupModalProps) {
  const discordConfig = useDashboardStore((state) => state.discordConfig);
  const updateDiscordConfig = useDashboardStore(
    (state) => state.updateDiscordConfig
  );
  const adminToken = useDashboardStore((state) => state.adminToken);
  const setAdminToken = useDashboardStore((state) => state.setAdminToken);
  const activeTicker = useDashboardStore((state) => state.activeTicker);
  const spotPrice = useDashboardStore((state) => state.spotPrice);
  const gammaLevels = useDashboardStore((state) => state.gammaLevels);
  const kingNode = useDashboardStore((state) => state.kingNode);

  const [url, setUrl] = useState(discordConfig.webhookUrl || "");
  const [enabled, setEnabled] = useState(discordConfig.enabled ?? false);
  const [tokenInput, setTokenInput] = useState(adminToken || "");

  const [testState, setTestState] = useState<"idle" | "sending" | "success" | "error">(
    "idle"
  );
  const [testMessage, setTestMessage] = useState<string | null>(null);

  // Sync state whenever modal opens or store updates
  useEffect(() => {
    if (open) {
      setUrl(discordConfig.webhookUrl || "");
      setEnabled(discordConfig.enabled ?? false);
      setTokenInput(adminToken || "");
      setTestState("idle");
      setTestMessage(null);
    }
  }, [open, discordConfig, adminToken]);

  const handleSave = () => {
    setAdminToken(tokenInput);
    updateDiscordConfig({
      webhookUrl: url.trim(),
      enabled,
    });
    onOpenChange(false);
  };

  const handleSendTest = async () => {
    const targetUrl = url.trim();
    const activeToken = tokenInput.trim() || adminToken.trim();

    setTestState("sending");
    setTestMessage(null);

    try {
      const res = await fetch("/api/discord", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(activeToken ? { "x-hyperion-admin-token": activeToken } : {}),
        },
        body: JSON.stringify({
          ...(targetUrl ? { webhookUrl: targetUrl } : {}),
          ticker: activeTicker,
          spotPrice,
          eventType: "test",
          message: `${activeTicker} Test Alert: Hyperion Alerts Discord integration verified successfully.`,
          callWall: gammaLevels.callWall,
          putWall: gammaLevels.putWall,
          zeroGamma: gammaLevels.zeroGamma,
          allExpKing: kingNode.allExpKing,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setTestState("error");
        setTestMessage(data.error || "Failed to deliver webhook.");
      } else {
        setTestState("success");
        setTestMessage("✓ Sent to Hyperion Alerts on Discord!");
      }
    } catch (err: unknown) {
      setTestState("error");
      setTestMessage(
        err instanceof Error ? err.message : "Network error testing webhook."
      );
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm transition-opacity animate-in fade-in duration-200" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[95vw] max-w-xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto argon-scrollbar rounded-2xl bg-[#111422] border border-[#5e72e4]/50 p-6 text-slate-200 shadow-[0_0_40px_rgba(0,0,0,0.85)] focus:outline-none">
          {/* Modal Header */}
          <div className="flex items-start justify-between gap-4 border-b border-white/10 pb-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#1c223a] border border-[#5e72e4]/50 text-[#5e72e4]">
                <Settings className="h-5 w-5 text-indigo-400" />
              </div>
              <div>
                <Dialog.Title className="text-lg font-extrabold text-white tracking-tight">
                  Hyperion Alerts · Discord Webhook Setup
                </Dialog.Title>
                <Dialog.Description className="text-xs font-mono text-slate-400">
                  Deliver real-time BTO &amp; STC options trade signals (09:35–15:55 ET) straight to your Discord channel
                </Dialog.Description>
              </div>
            </div>

            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="Close Setup Modal"
                className="rounded-lg bg-[#0b0d17] border border-white/15 p-1.5 text-slate-400 hover:text-white hover:border-white/30 transition-colors cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </Dialog.Close>
          </div>

          {/* Form Content */}
          <div className="mt-5 space-y-5 text-xs">
            {/* Webhook Input */}
            <div className="space-y-1.5">
              <label
                htmlFor="discord-webhook-url"
                className="block font-mono font-bold uppercase tracking-wider text-slate-300"
              >
                Hyperion Alerts Webhook URL
              </label>
              <input
                id="discord-webhook-url"
                type="password"
                autoComplete="off"
                placeholder="Leave blank to use server DISCORD_WEBHOOK_URL (recommended)"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                className="w-full rounded-xl bg-[#0b0d17] border border-white/15 px-3.5 py-2.5 font-mono text-xs text-white placeholder-slate-600 focus:outline-none focus:border-[#5e72e4] focus:ring-1 focus:ring-[#5e72e4] transition-all"
              />
              <p className="text-[11px] font-mono text-slate-400">
                Recommended: set <code className="text-slate-300">DISCORD_WEBHOOK_URL</code> in server <code className="text-slate-300">.env.local</code>. Any URL entered here stays in memory only (never saved to localStorage) and is disabled in production.
              </p>
            </div>

            {/* Operator Admin Token Input (sessionStorage / React memory only — never localStorage) */}
            <div className="space-y-1.5">
              <label
                htmlFor="hyperion-admin-token"
                className="block font-mono font-bold uppercase tracking-wider text-slate-300"
              >
                Operator Admin Token (Session Memory Only)
              </label>
              <input
                id="hyperion-admin-token"
                type="password"
                autoComplete="off"
                placeholder="HYPERION_ADMIN_TOKEN for Emergency Lock & Paper Flatten"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                className="w-full rounded-xl bg-[#0b0d17] border border-white/15 px-3.5 py-2.5 font-mono text-xs text-white placeholder-slate-600 focus:outline-none focus:border-[#5e72e4] focus:ring-1 focus:ring-[#5e72e4] transition-all"
              />
              <p className="text-[11px] font-mono text-slate-400">
                Held strictly in <code className="text-slate-300">sessionStorage</code> / React memory for the current tab (<strong className="text-slate-300">never</strong> persisted to <code className="text-slate-300">localStorage</code>). Execution stays strictly <code className="text-emerald-300">PAPER_SHADOW</code>.
              </p>
            </div>

            {/* Alert Event Subscriptions */}
            <div className="rounded-xl bg-[#0b0d17] border border-white/10 p-4 space-y-3">
              <div className="flex items-center justify-between pb-2 border-b border-white/10">
                <span className="font-mono font-bold text-white uppercase tracking-wider">
                  Alert Subscriptions
                </span>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={(e) => setEnabled(e.target.checked)}
                    className="h-3.5 w-3.5 rounded border-white/20 bg-[#111422] text-[#5e72e4] focus:ring-0"
                  />
                  <span className="font-mono text-slate-300 font-semibold">
                    {enabled ? "Enabled" : "Paused"}
                  </span>
                </label>
              </div>

              <div className="space-y-2.5 pt-1">
                <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 px-3 py-2">
                  <div className="font-mono font-bold text-emerald-300">
                    🟢 BUY TO OPEN (CALL &amp; PUT) · 09:35–14:30 ET
                  </div>
                  <div className="text-[11px] font-mono text-slate-400">
                    Live RTH small-account sniper entries (1 contract, Flux-Field + Wall confluence). Historical backfills are silenced.
                  </div>
                </div>

                <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2">
                  <div className="font-mono font-bold text-amber-300">
                    🎯 SELL TO CLOSE (TP / Trail / Reversal / SL / 15:55 MOC)
                  </div>
                  <div className="text-[11px] font-mono text-slate-400">
                    Real-time profit locks, trailing ratchets, stop losses, and mandatory 15:55 ET Market-On-Close exits.
                  </div>
                </div>

                <div className="text-[10.5px] font-mono text-slate-500 pt-0.5">
                  Legacy structural wall / Zero-γ / King alerts are silenced in Discord so #trade-signals stays 100% actionable.
                </div>
              </div>
            </div>

            {/* Test Status feedback */}
            {testMessage && (
              <div
                className={`rounded-xl px-3.5 py-2 font-mono text-xs flex items-center gap-2 ${
                  testState === "success"
                    ? "bg-emerald-500/15 border border-emerald-400/40 text-emerald-300"
                    : "bg-rose-500/15 border border-rose-400/40 text-rose-300"
                }`}
              >
                {testState === "success" ? (
                  <Check className="h-4 w-4 shrink-0 text-emerald-400" />
                ) : (
                  <Bell className="h-4 w-4 shrink-0 text-rose-400" />
                )}
                <span>{testMessage}</span>
              </div>
            )}

            {/* Actions */}
            <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
              <button
                type="button"
                onClick={handleSendTest}
                disabled={testState === "sending"}
                className="inline-flex items-center gap-1.5 rounded-xl bg-[#1c223a] border border-[#5e72e4]/50 px-4 py-2 font-mono font-bold text-slate-200 hover:text-white hover:border-[#5e72e4] transition-all disabled:opacity-40 disabled:pointer-events-none cursor-pointer"
              >
                {testState === "sending" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-indigo-400" />
                ) : (
                  <Send className="h-3.5 w-3.5 text-indigo-400" />
                )}
                <span>Send Test Alert</span>
              </button>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => onOpenChange(false)}
                  className="rounded-xl px-4 py-2 font-mono text-slate-400 hover:text-white transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSave}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-[#5e72e4] hover:bg-[#485ec7] text-white font-mono font-extrabold px-5 py-2 transition-all shadow-[0_0_15px_rgba(94,114,228,0.4)] cursor-pointer"
                >
                  <ShieldCheck className="h-4 w-4" />
                  <span>Save</span>
                </button>
              </div>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
