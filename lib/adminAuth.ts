import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";

/**
 * Shared fail-closed admin request authorization guard.
 *
 * - When `HYPERION_ADMIN_TOKEN` is configured, requires a matching token in
 *   `x-hyperion-admin-token` or `Authorization: Bearer <token>` using
 *   constant-time `crypto.timingSafeEqual`.
 * - When `HYPERION_ADMIN_TOKEN` is unset:
 *   - In production (`NODE_ENV === "production"`), fails closed with HTTP 403
 *     (never trusting spoofable `Host` or `X-Forwarded-For` headers).
 *   - In non-production environments, allows local developer ergonomics.
 */
export function authorizeAdminRequest(req: NextRequest): NextResponse | null {
  const configuredToken = process.env.HYPERION_ADMIN_TOKEN?.trim();
  if (configuredToken) {
    const headerToken = req.headers.get("x-hyperion-admin-token")?.trim();
    const authHeader = req.headers.get("authorization")?.trim() ?? "";
    const bearerToken = authHeader.toLowerCase().startsWith("bearer ")
      ? authHeader.slice(7).trim()
      : "";
    const provided = headerToken || bearerToken;
    if (!provided) {
      return NextResponse.json({ error: "Unauthorized admin request" }, { status: 401 });
    }
    const providedBuf = Buffer.from(provided, "utf-8");
    const expectedBuf = Buffer.from(configuredToken, "utf-8");
    if (
      providedBuf.length !== expectedBuf.length ||
      !crypto.timingSafeEqual(providedBuf, expectedBuf)
    ) {
      return NextResponse.json({ error: "Unauthorized admin request" }, { status: 401 });
    }
    return null;
  }

  if (process.env.NODE_ENV === "production") {
    return NextResponse.json(
      { error: "HYPERION_ADMIN_TOKEN is required for admin actions in production." },
      { status: 403 }
    );
  }

  return null;
}
