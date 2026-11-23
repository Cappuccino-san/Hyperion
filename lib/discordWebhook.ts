const ALLOWED_DISCORD_WEBHOOK_HOSTS = new Set([
  "discord.com",
  "discordapp.com",
  "ptb.discord.com",
  "canary.discord.com",
]);

const DISCORD_WEBHOOK_PATH_RE = /^\/api\/(?:v\d+\/)?webhooks\/\d+\/[A-Za-z0-9_-]+\/?$/;

function hasAllowedDiscordSearchParams(params: URLSearchParams): boolean {
  let valid = true;
  params.forEach((value, key) => {
    if (!valid) return;
    if (key === "wait") {
      if (value !== "true" && value !== "false") valid = false;
      return;
    }
    if (key === "thread_id") {
      if (!/^\d+$/.test(value)) valid = false;
      return;
    }
    valid = false;
  });
  return valid;
}

export function isValidDiscordWebhookUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:") return false;
    if (parsed.port) return false;
    if (parsed.username || parsed.password) return false;
    if (parsed.hash) return false;
    if (!ALLOWED_DISCORD_WEBHOOK_HOSTS.has(parsed.hostname.toLowerCase())) return false;
    if (!DISCORD_WEBHOOK_PATH_RE.test(parsed.pathname)) return false;
    return hasAllowedDiscordSearchParams(parsed.searchParams);
  } catch {
    return false;
  }
}

export function buildDiscordWebhookDispatchUrl(
  raw: string,
  options?: { wait?: boolean }
): string {
  const parsed = new URL(raw);
  parsed.hash = "";
  const threadId = parsed.searchParams.get("thread_id");
  parsed.search = "";
  if (threadId && /^\d+$/.test(threadId)) {
    parsed.searchParams.set("thread_id", threadId);
  }
  if (options?.wait) {
    parsed.searchParams.set("wait", "true");
  }
  return parsed.toString();
}

export function sanitizeDiscordWebhookUrl(raw: unknown): { url?: string; invalid: boolean } {
  if (raw == null) return { url: undefined, invalid: false };
  if (typeof raw !== "string") return { url: undefined, invalid: true };
  const trimmed = raw.trim();
  if (!trimmed) return { url: undefined, invalid: false };
  if (!isValidDiscordWebhookUrl(trimmed)) return { url: undefined, invalid: true };
  return { url: trimmed, invalid: false };
}
