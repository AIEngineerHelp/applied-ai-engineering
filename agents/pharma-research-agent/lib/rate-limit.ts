// Rate limits for starting research, checked before a run is created. A public
// demo with no sign-in has two identities to limit: the browser's workspace
// cookie and the client's IP address (clearing cookies resets the first, not the
// second). The address is stored only as a salted hash. Counts come from the
// reports table itself, so limits hold across server instances.

import { createHash } from "node:crypto";
import { and, count, eq, gte, inArray } from "drizzle-orm";
import { db, schema } from "./db";

const { reports } = schema;

const num = (v: string | undefined, fallback: number) => (v && !Number.isNaN(Number(v)) && Number(v) >= 0 ? Number(v) : fallback);

export function rateLimitsFromEnv() {
  return {
    /** Research runs one browser may start per hour (0 turns the limit off). */
    perWorkspaceHour: num(process.env.RATE_LIMIT_WORKSPACE_PER_HOUR, 10),
    /** Research runs one IP address may start per hour (0 turns the limit off). */
    perClientHour: num(process.env.RATE_LIMIT_IP_PER_HOUR, 20),
    /** Runs one browser may have going at once. */
    concurrent: num(process.env.RATE_LIMIT_CONCURRENT, 2),
  };
}

/** The client's IP address from the platform's forwarding headers, as a salted hash. */
export function clientHash(request: Request): string | undefined {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip")?.trim();
  if (!ip) return undefined;
  return createHash("sha256").update(`${process.env.RATE_LIMIT_SALT ?? "pharma-research-agent"}:${ip}`).digest("hex").slice(0, 32);
}

/** Why a new run may not start now, or null if it may. */
export async function rateLimited(workspaceId: string, client: string | undefined, limits = rateLimitsFromEnv()): Promise<string | null> {
  const d = await db();
  const hourAgo = new Date(Date.now() - 3600_000);
  if (limits.concurrent > 0) {
    const [r] = await d.select({ n: count() }).from(reports).where(and(eq(reports.workspaceId, workspaceId), inArray(reports.status, ["queued", "running"])));
    if (r.n >= limits.concurrent) return `You have ${r.n} research runs in progress. Wait for one to finish before starting another.`;
  }
  if (limits.perWorkspaceHour > 0) {
    const [r] = await d.select({ n: count() }).from(reports).where(and(eq(reports.workspaceId, workspaceId), gte(reports.createdAt, hourAgo)));
    if (r.n >= limits.perWorkspaceHour) return `You've started ${limits.perWorkspaceHour} research runs in the last hour, the limit for now. Please try again later.`;
  }
  if (client && limits.perClientHour > 0) {
    const [r] = await d.select({ n: count() }).from(reports).where(and(eq(reports.clientHash, client), gte(reports.createdAt, hourAgo)));
    if (r.n >= limits.perClientHour) return "Too many research runs have been started from your network in the last hour. Please try again later.";
  }
  return null;
}
