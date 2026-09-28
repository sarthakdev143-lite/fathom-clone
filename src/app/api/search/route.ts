import { NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/config";
import { searchMeetings } from "@/lib/search";
import { RATE_RULES, rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Full-text search across ready meetings. Read-only, no model calls. */
export async function GET(request: Request) {
  if (!isDbConfigured) {
    return NextResponse.json(
      { error: "Storage is not configured. TURSO_DATABASE_URL is not set." },
      { status: 503 },
    );
  }

  const limited = await rateLimit(request, RATE_RULES.search);
  if (limited) return limited;

  const url = new URL(request.url);
  const query = (url.searchParams.get("q") ?? "").trim().slice(0, 200);
  if (!query) {
    return NextResponse.json({ query: "", mode: "fts", results: [] });
  }

  const { mode, results } = await searchMeetings(query);
  return NextResponse.json({ query, mode, results });
}
