const ALLOWED_DISCORD_WEBHOOK_HOSTS = new Set([
  "discord.com",
  "discordapp.com",
  "ptb.discord.com",
  "canary.discord.com",
]);

const DISCORD_WEBHOOK_PATH_RE = /^\/api\/(?:v\d+\/)?webhooks\/\d+\/[A-Za-z0-9_-]+\/?$/;

export function isValidDiscordWebhookUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:") return false;
    if (parsed.port) return false;
    if (parsed.username || parsed.password) return false;
    if (!ALLOWED_DISCORD_WEBHOOK_HOSTS.has(parsed.hostname.toLowerCase())) return false;
    return DISCORD_WEBHOOK_PATH_RE.test(parsed.pathname);
  } catch {
    return false;
  }
}

export function sanitizeDiscordWebhookUrl(raw: unknown): { url?: string; invalid: boolean } {
  if (raw == null) return { url: undefined, invalid: false };
  if (typeof raw !== "string") return { url: undefined, invalid: true };
  const trimmed = raw.trim();
  if (!trimmed) return { url: undefined, invalid: false };
  if (!isValidDiscordWebhookUrl(trimmed)) return { url: undefined, invalid: true };
  return { url: trimmed, invalid: false };
}
