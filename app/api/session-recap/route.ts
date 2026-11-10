import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const possiblePaths = [
      path.resolve(process.cwd(), "scratch/terrashade/api_recap.json"),
      path.resolve(process.cwd(), ".cache/terrashade/api_recap.json"),
      ...(process.env.SESSION_RECAP_PATH ? [path.resolve(process.env.SESSION_RECAP_PATH)] : []),
    ];

    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, "utf-8");
        return new NextResponse(raw, {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, s-maxage=60, stale-while-revalidate=120",
          },
        });
      }
    }

    // Fallback minimal structure if file is unreachable
    return NextResponse.json({
      days: ["2026-10-16"],
      day: "2026-10-16",
      recap: {
        day: "2026-10-16",
        built_at: 1792274473,
        next_date: "2026-10-19",
        tickers: [],
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Recap error" },
      { status: 500 }
    );
  }
}
