import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isValidDiscordWebhookUrl,
  sanitizeDiscordWebhookUrl,
} from "../discordWebhook";

test("isValidDiscordWebhookUrl accepts official Discord webhook URLs", () => {
  const validUrls = [
    "https://discord.com/api/webhooks/123456789012345678/abcDEF_123-xyz",
    "https://discordapp.com/api/webhooks/123456789012345678/token_with-dash",
    "https://ptb.discord.com/api/v10/webhooks/123456789012345678/AbCdEf0123456789_-",
    "https://canary.discord.com/api/webhooks/123456789012345678/token123/",
  ];

  for (const url of validUrls) {
    assert.equal(isValidDiscordWebhookUrl(url), true, `Expected valid: ${url}`);
  }
});

test("isValidDiscordWebhookUrl rejects SSRF hosts, non-HTTPS, ports, credentials, and malformed paths", () => {
  const invalidUrls = [
    "http://discord.com/api/webhooks/123456789012345678/abc123",
    "https://evil.example.com/api/webhooks/123456789012345678/abc123",
    "https://discord.com.evil.com/api/webhooks/123456789012345678/abc123",
    "https://127.0.0.1/api/webhooks/123456789012345678/abc123",
    "https://discord.com:8443/api/webhooks/123456789012345678/abc123",
    "https://user:pass@discord.com/api/webhooks/123456789012345678/abc123",
    "https://discord.com/api/webhooks/not-a-number/abc123",
    "https://discord.com/api/webhooks/123456789012345678/bad.token!",
    "https://discord.com/api/webhooks/123456789012345678/abc123/extra",
    "https://discord.com/api/users/@me",
    "not-a-url",
    "",
  ];

  for (const url of invalidUrls) {
    assert.equal(isValidDiscordWebhookUrl(url), false, `Expected invalid: ${url}`);
  }
});

test("sanitizeDiscordWebhookUrl handles empty, valid, and invalid inputs", () => {
  assert.deepEqual(sanitizeDiscordWebhookUrl(undefined), { url: undefined, invalid: false });
  assert.deepEqual(sanitizeDiscordWebhookUrl(null), { url: undefined, invalid: false });
  assert.deepEqual(sanitizeDiscordWebhookUrl("   "), { url: undefined, invalid: false });
  assert.deepEqual(sanitizeDiscordWebhookUrl(123), { url: undefined, invalid: true });
  assert.deepEqual(
    sanitizeDiscordWebhookUrl("https://evil.com/api/webhooks/123/abc"),
    { url: undefined, invalid: true }
  );
  assert.deepEqual(
    sanitizeDiscordWebhookUrl("  https://discord.com/api/webhooks/123456789012345678/abc_123-XYZ  "),
    {
      url: "https://discord.com/api/webhooks/123456789012345678/abc_123-XYZ",
      invalid: false,
    }
  );
});
