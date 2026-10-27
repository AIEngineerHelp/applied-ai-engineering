// "Ask your own question": Gemini writes Cypher, the guard checks it, Neo4j runs
// it read-only with a timeout, and Gemini answers from the query and its rows.
// A Web-standard handler (Request → Response), so the same code runs in the
// local server (scripts/serve.ts) and as a Vercel function (api/ask.ts).
//
// Protections, in the order they apply:
//   - the question's length (8 to 300 characters) and the request body's size;
//   - rate limits per client and per day, counted in a store shared by every
//     server instance (in production, :AskLog nodes in Neo4j itself, written by
//     server code in a separate write transaction, never by model-written Cypher);
//     the client's address is kept only as a salted hash;
//   - the read-only Cypher guard (which also refuses any query that mentions
//     AskLog), a read transaction, a server-side query timeout and a row limit;
//   - an overall deadline, so a slow model call can't hold the function open.

import { createHash } from "node:crypto";
import type { Graph } from "./graph.ts";

export interface QueryRunLike {
  ok: boolean;
  rows: Record<string, unknown>[];
  error: string | null;
  blocked: boolean;
  cypher: string;
  ms: number;
}

/** Shared counts for the rate limits. `take` records the request only if it is allowed. */
export interface AskLimitStore {
  take(ipHash: string, now: number, limits: AskLimits): Promise<string | null>;
}

export interface AskDeps {
  graph: () => Graph;
  configured: () => boolean;
  limits: () => AskLimitStore;
  textToCypher: (q: string, graph: Graph) => Promise<{ cypher: string; explanation: string; run: QueryRunLike }[]>;
  answer: (q: string, context: string) => Promise<string>;
  now?: () => number;
}

const num = (v: string | undefined, fallback: number) => (v !== undefined && v !== "" && !Number.isNaN(Number(v)) && Number(v) >= 0 ? Number(v) : fallback);

export interface AskLimits {
  /** Questions one client (salted IP hash) may ask per hour; 0 turns the limit off. */
  perIpHour: number;
  /** Questions everyone together may ask per day (rolling 24 hours); 0 turns the limit off. */
  perDay: number;
}

export function limitsFromEnv(): AskLimits {
  return { perIpHour: num(process.env.ASK_LIMIT_IP_PER_HOUR, 5), perDay: num(process.env.ASK_LIMIT_PER_DAY, 300) };
}

export const QUESTION = { minChars: 8, maxChars: 300 };
export const deadlineMs = () => num(process.env.ASK_DEADLINE_MS, 25_000);

export const HOUR = 3600_000;
export const DAY = 24 * HOUR;

/** The friendly message for a request over a limit, or null if it may go ahead. */
export function overLimit(counts: { ipHour: number; day: number }, limits: AskLimits): string | null {
  if (limits.perDay > 0 && counts.day >= limits.perDay) return `This demo has answered its ${limits.perDay} questions for today, the limit that keeps its model costs bounded. Please come back tomorrow; the recorded runs above still work.`;
  if (limits.perIpHour > 0 && counts.ipHour >= limits.perIpHour) return `You've asked ${limits.perIpHour} ${limits.perIpHour === 1 ? "question" : "questions"} in the last hour, the limit for now. Please try again in a little while.`;
  return null;
}

/** The client's address from the platform's forwarding headers, as a salted hash. */
export function clientHash(request: Request): string {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip")?.trim() || "unknown";
  return createHash("sha256").update(`${process.env.RATE_LIMIT_SALT ?? "knowledge-graphs"}:${ip}`).digest("hex").slice(0, 32);
}

/** An in-memory store, for tests. Production counts in Neo4j (src/pipeline/ask-log.ts). */
export function memoryLimitStore(): AskLimitStore & { log: { ipHash: string; at: number }[] } {
  const log: { ipHash: string; at: number }[] = [];
  return {
    log,
    async take(ipHash, now, limits) {
      const counts = { ipHour: log.filter((l) => l.ipHash === ipHash && l.at > now - HOUR).length, day: log.filter((l) => l.at > now - DAY).length };
      const msg = overLimit(counts, limits);
      if (!msg) log.push({ ipHash, at: now });
      return msg;
    },
  };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

export const NOT_CONFIGURED =
  "Asking your own question needs a Gemini key and a Neo4j database on the server, and this copy has neither, so it only replays the recorded runs. Run the app locally with Neo4j and a Gemini key to ask your own.";

class Deadline extends Error {}
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<T>((_, reject) => (timer = setTimeout(() => reject(new Deadline()), ms)))]).finally(() => clearTimeout(timer));
}

export async function handleAsk(request: Request, deps: AskDeps): Promise<Response> {
  if (request.method !== "POST") return json(405, { error: "Use POST." });
  if (!deps.configured()) return json(503, { error: NOT_CONFIGURED });
  const body = await request.text().catch(() => "");
  if (body.length > 4096) return json(413, { error: "The request is too large." });
  let question = "";
  try {
    question = String((JSON.parse(body) as { question?: unknown }).question ?? "").trim();
  } catch {
    return json(400, { error: 'Send JSON: {"question": "..."}.' });
  }
  if (question.length < QUESTION.minChars || question.length > QUESTION.maxChars) return json(400, { error: `Ask a question between ${QUESTION.minChars} and ${QUESTION.maxChars} characters long.` });
  try {
    const limited = await deps.limits().take(clientHash(request), (deps.now ?? Date.now)(), limitsFromEnv());
    if (limited) return json(429, { error: limited });
  } catch {
    return json(503, { error: "The question service can't reach its database right now (a free database may be waking up). Please try again in a minute." });
  }
  try {
    return await withDeadline(
      (async () => {
        const attempts = await deps.textToCypher(question, deps.graph());
        const final = attempts[attempts.length - 1].run;
        const rows = final.rows.slice(0, 50);
        const answer = final.ok
          ? await deps.answer(question, `The Cypher query that was run:\n${final.cypher}\n\nIts result rows:\n${JSON.stringify(rows)}`)
          : final.blocked
            ? "The generated query was blocked by the read-only guard, so it never reached the database."
            : "The query failed, so there is no answer.";
        return json(200, { question, attempts: attempts.map((a) => ({ cypher: a.run.cypher, explanation: a.explanation, ok: a.run.ok, blocked: a.run.blocked, error: a.run.error, rows: a.run.rows.slice(0, 50), ms: a.run.ms })), answer });
      })(),
      deadlineMs(),
    );
  } catch (e) {
    if (e instanceof Deadline) return json(504, { error: "That took too long to answer. Please try again, or ask a simpler question." });
    return json(502, { error: `Something went wrong: ${String((e as Error).message ?? e).replace(/AIza[0-9A-Za-z_-]+/g, "[redacted]").slice(0, 200)}` });
  }
}
