// Health check: the app is up and the database answers.
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

export async function GET() {
  const t = Date.now();
  try {
    const d = await db();
    await d.execute(sql`select 1`);
    return Response.json({ ok: true, db: "ok", ms: Date.now() - t }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return Response.json({ ok: false, db: "error", error: (err as Error).message }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
