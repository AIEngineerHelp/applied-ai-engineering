// "Ask your own question": Gemini writes Cypher, the guard checks it, Neo4j runs
// it read-only with a timeout, and Gemini answers from the rows. A Web-standard
// handler (Request → Response), so the same code runs in the local server and,
// later, as a Vercel function (api/ask.ts). It is not deployed.
//
// Protections: question length limits, a per-IP rate limit (the address is
// stored only as a salted hash), the read-only Cypher guard, a read transaction,
// a server-side query timeout, and a row limit. The rate limit here is kept in
// memory, so it is per server instance; a deployment with several instances
// needs a shared store (the pharma research agent in this repository counts in
// Postgres for that reason).

import { createHash } from "node:crypto";
import type { Graph } from "./graph.ts";

export interface AskDeps {
  graph: () => Graph;
  configured: () => boolean;
  textToCypher: (q: string, graph: Graph) => Promise<{ cypher: string; explanation: string; run: { ok: boolean; rows: Record<string, unknown>[]; error: string | null; blocked: boolean; cypher: string; ms: number } }[]>;
  answer: (q: string, context: string) => Promise<string>;
  now?: () => number;
}

export const LIMITS = {
  minChars: 8,
  maxChars: 300,
  perHour: () => Number(process.env.ASK_RATE_LIMIT_PER_HOUR) || 20,
};

const hits = new Map<string, number[]>();

export function clientKey(request: Request): string {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip")?.trim() || "local";
  return createHash("sha256").update(`${process.env.RATE_LIMIT_SALT ?? "knowledge-graphs"}:${ip}`).digest("hex").slice(0, 32);
}

/** Sliding one-hour window per client. Returns null if allowed, or a message. */
export function rateLimit(key: string, now: number, perHour = LIMITS.perHour()): string | null {
  const recent = (hits.get(key) ?? []).filter((t) => now - t < 3600_000);
  if (recent.length >= perHour) {
    hits.set(key, recent);
    return `You've asked ${perHour} questions in the last hour, the limit for now. Please try again later.`;
  }
  recent.push(now);
  hits.set(key, recent);
  return null;
}
export const resetRateLimits = () => hits.clear();

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

export async function handleAsk(request: Request, deps: AskDeps): Promise<Response> {
  if (request.method !== "POST") return json(405, { error: "Use POST." });
  if (!deps.configured()) return json(503, { error: "Asking your own question needs a Gemini key and a running Neo4j. It works when you run the app locally; the published site only replays recorded answers." });
  let question = "";
  try {
    question = String(((await request.json()) as { question?: unknown }).question ?? "").trim();
  } catch {
    return json(400, { error: "Send JSON: {\"question\": \"...\"}." });
  }
  if (question.length < LIMITS.minChars || question.length > LIMITS.maxChars) return json(400, { error: `Ask a question between ${LIMITS.minChars} and ${LIMITS.maxChars} characters long.` });
  const limited = rateLimit(clientKey(request), (deps.now ?? Date.now)());
  if (limited) return json(429, { error: limited });
  try {
    const attempts = await deps.textToCypher(question, deps.graph());
    const final = attempts[attempts.length - 1].run;
    const rows = final.rows.slice(0, 50);
    const answer = final.ok
      ? await deps.answer(question, `The Cypher query that was run:\n${final.cypher}\n\nIts result rows:\n${JSON.stringify(rows)}`)
      : final.blocked
        ? "The generated query was blocked by the read-only guard, so it never reached the database."
        : "The query failed, so there is no answer.";
    return json(200, { question, attempts: attempts.map((a) => ({ cypher: a.run.cypher, explanation: a.explanation, ok: a.run.ok, blocked: a.run.blocked, error: a.run.error, rows: a.run.rows.slice(0, 50), ms: a.run.ms })), answer });
  } catch (e) {
    return json(502, { error: `Something went wrong: ${String((e as Error).message ?? e).replace(/AIza[0-9A-Za-z_-]+/g, "[redacted]").slice(0, 200)}` });
  }
}
