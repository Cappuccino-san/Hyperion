/**
 * Hyperion Headless Live Route & API Smoke Verifier
 *
 * Verifies all 5 App Router pages and 5 JSON API endpoints return HTTP 200
 * with live, non-mock payloads.
 *
 * Usage:
 *   npm run test:routes
 *   HYPERION_BASE_URL=http://localhost:3000 npx tsx scripts/verifyLiveRoutes.ts
 */

interface RouteCheckResult {
  route: string;
  kind: "PAGE" | "API";
  status: number;
  latencyMs: number;
  passed: boolean;
  detail: string;
}

const BASE_URL = (
  process.env.HYPERION_BASE_URL ||
  process.argv[2] ||
  "http://localhost:3000"
).replace(/\/+$/, "");

const REQUEST_TIMEOUT_MS = 15_000;

async function checkPageRoute(route: string): Promise<RouteCheckResult> {
  const start = Date.now();
  try {
    const res = await fetch(`${BASE_URL}${route}`, {
      headers: { Accept: "text/html" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
    });
    const latencyMs = Date.now() - start;
    const html = await res.text();
    const contentType = res.headers.get("content-type") || "";

    const hasNextError =
      html.includes("__next_error__") ||
      html.includes("Application error: a client-side exception") ||
      html.includes("NEXT_NOT_FOUND");
    const isHtml = contentType.includes("text/html") && html.includes("<html");

    const passed = res.status === 200 && isHtml && !hasNextError;
    const detail = passed
      ? `HTML OK (${(html.length / 1024).toFixed(1)} KB)`
      : `status=${res.status}, isHtml=${isHtml}, hasNextError=${hasNextError}`;

    return { route, kind: "PAGE", status: res.status, latencyMs, passed, detail };
  } catch (err) {
    return {
      route,
      kind: "PAGE",
      status: 0,
      latencyMs: Date.now() - start,
      passed: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function checkApiRoute(
  route: string,
  validate: (data: any) => { ok: boolean; detail: string }
): Promise<RouteCheckResult> {
  const start = Date.now();
  try {
    const res = await fetch(`${BASE_URL}${route}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
    });
    const latencyMs = Date.now() - start;
    const text = await res.text();

    let data: any = null;
    try {
      data = JSON.parse(text);
    } catch {
      return {
        route,
        kind: "API",
        status: res.status,
        latencyMs,
        passed: false,
        detail: `Invalid JSON response (${text.slice(0, 120)})`,
      };
    }

    if (res.status !== 200) {
      return {
        route,
        kind: "API",
        status: res.status,
        latencyMs,
        passed: false,
        detail: `HTTP ${res.status}: ${data?.error || text.slice(0, 140)}`,
      };
    }

    const check = validate(data);
    return {
      route,
      kind: "API",
      status: res.status,
      latencyMs,
      passed: check.ok,
      detail: check.detail,
    };
  } catch (err) {
    return {
      route,
      kind: "API",
      status: 0,
      latencyMs: Date.now() - start,
      passed: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main() {
  console.log(`[ROUTE-SMOKE] Target: ${BASE_URL}`);

  const pageRoutes = ["/", "/quad", "/gaia", "/scanner", "/recap"];
  const pageChecks = pageRoutes.map((route) => checkPageRoute(route));

  const apiChecks = [
    checkApiRoute("/api/health", (data) => {
      const ok =
        data?.ok === true &&
        (data?.marketStatus === "OPEN" || data?.marketStatus === "CLOSED") &&
        typeof data?.liveBot === "object" &&
        typeof data?.timestamp === "string";
      return {
        ok,
        detail: ok
          ? `ok=true marketStatus=${data.marketStatus} bot=${data.liveBot?.lastStatus ?? "n/a"}`
          : `Unexpected /api/health shape`,
      };
    }),
    checkApiRoute("/api/gaia?ticker=SPY", (data) => {
      const validSource =
        data?.dataSource === "TRADIER_LIVE" || data?.dataSource === "CBOE_MARKET_DATA";
      const hasCandles = Array.isArray(data?.candles) && data.candles.length > 0;
      const hasBuckets = Array.isArray(data?.optionBuckets) && data.optionBuckets.length > 0;
      const validSpot = typeof data?.spotPrice === "number" && data.spotPrice > 0;
      const validSigma = typeof data?.sigma1Move === "number" && data.sigma1Move > 0;
      const ok =
        data?.ticker === "SPY" &&
        validSource &&
        hasCandles &&
        hasBuckets &&
        validSpot &&
        validSigma;
      return {
        ok,
        detail: ok
          ? `source=${data.dataSource} spot=$${data.spotPrice} candles=${data.candles.length} buckets=${data.optionBuckets.length}`
          : `Non-live or incomplete /api/gaia payload (source=${data?.dataSource}, spot=${data?.spotPrice})`,
      };
    }),
    checkApiRoute("/api/options?ticker=SPY", (data) => {
      const hasStrikes = Array.isArray(data?.strikes) && data.strikes.length > 0;
      const hasLevels =
        typeof data?.gammaLevels === "object" &&
        data.gammaLevels !== null &&
        typeof data.gammaLevels.zeroGamma === "number";
      const validSpot = typeof data?.spotPrice === "number" && data.spotPrice > 0;
      const notMock = data?.isLiveOnly !== true && !data?.error;
      const ok = data?.ticker === "SPY" && validSpot && hasStrikes && hasLevels && notMock;
      return {
        ok,
        detail: ok
          ? `status=${data.connectionStatus ?? "LIVE"} spot=$${data.spotPrice} strikes=${data.strikes.length} zeroG=${data.gammaLevels.zeroGamma}`
          : `Invalid/fallback /api/options payload`,
      };
    }),
    checkApiRoute("/api/signals", (data) => {
      const ok =
        typeof data?.activePositions === "object" &&
        data.activePositions !== null &&
        Array.isArray(data?.closedPositions) &&
        Array.isArray(data?.alerts) &&
        typeof data?.timestamp === "string";
      return {
        ok,
        detail: ok
          ? `active=${Object.keys(data.activePositions).length} closed=${data.closedPositions.length} alerts=${data.alerts.length}`
          : `Unexpected /api/signals shape`,
      };
    }),
    checkApiRoute("/api/session-recap", (data) => {
      const isStaticStub =
        data?.day === "2026-10-16" &&
        Array.isArray(data?.recap?.tickers) &&
        data.recap.tickers.length === 0 &&
        !data?.portfolio;
      const p = data?.portfolio;
      const hasValidPortfolio =
        typeof p === "object" &&
        p !== null &&
        typeof p.totalTrades === "number" &&
        Number.isFinite(p.cumulativeDollarPnl) &&
        Array.isArray(p.equityCurve);
      const ok = !isStaticStub && hasValidPortfolio && Array.isArray(data?.days);
      return {
        ok,
        detail: isStaticStub
          ? `Static "2026-10-16" fallback detected (expected live aggregated recap)`
          : ok
            ? `days=${data.days.length} trades=${p.totalTrades} pnl=$${p.cumulativeDollarPnl}`
            : `Unexpected /api/session-recap shape`,
      };
    }),
  ];

  const results = await Promise.all([...pageChecks, ...apiChecks]);
  let failed = 0;

  for (const r of results) {
    const tag = r.passed ? "PASS" : "FAIL";
    if (!r.passed) failed++;
    console.log(
      `[${tag}] ${r.kind.padEnd(4)} ${r.route.padEnd(24)} HTTP ${String(r.status).padEnd(3)} ${String(r.latencyMs).padStart(5)}ms | ${r.detail}`
    );
  }

  console.log(
    `[ROUTE-SMOKE] Result: ${results.length - failed} / ${results.length} passed, ${failed} failed.`
  );
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[ROUTE-SMOKE] Fatal error:", err);
  process.exit(1);
});
