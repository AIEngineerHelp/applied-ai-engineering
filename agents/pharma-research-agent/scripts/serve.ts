// Local server: the UI, live research runs streamed over server-sent events,
// and saved runs for replay. Binds to 127.0.0.1 by default. A live run spends
// the GEMINI_API_KEY in .env; nothing runs live without one.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { extname, join, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createGemini } from "../src/gemini.ts";
import { createToolsets } from "../src/sources/index.ts";
import { runResearch, newRunId } from "../src/run.ts";
import type { RunEvent } from "../src/types.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = join(ROOT, "site");
const RUNS = join(ROOT, "runs");
const SAMPLES = join(ROOT, "results", "runs");
const PORT = Number(process.env.PORT) || 4325;
const HOST = process.env.HOST || "127.0.0.1";
const MAX_QUERY = 400;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

interface Live {
  events: RunEvent[];
  listeners: Set<ServerResponse>;
  done: boolean;
}
const live = new Map<string, Live>();
let running = 0;

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }).end(JSON.stringify(body));
};

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) throw new Error("Request too large");
  }
  return raw ? JSON.parse(raw) : {};
}

/** Saved runs: this machine's runs/, then the committed samples. */
function savedRuns() {
  const list: { id: string; query: string; at: string; sample: boolean; ms?: number }[] = [];
  for (const [dir, sample] of [[RUNS, false], [SAMPLES, true]] as const) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
      try {
        const run = JSON.parse(readFileSync(join(dir, f), "utf8")) as { id: string; events: RunEvent[] };
        const head = run.events.find((e) => e.type === "run") as Extract<RunEvent, { type: "run" }> | undefined;
        const done = run.events.find((e) => e.type === "done") as Extract<RunEvent, { type: "done" }> | undefined;
        if (head) list.push({ id: run.id, query: head.query, at: head.at, sample, ms: done?.ms });
      } catch {
        // Skip unreadable files.
      }
    }
  }
  // A run saved locally and also committed as a sample is listed once, as the sample.
  const byId = new Map<string, (typeof list)[number]>();
  for (const r of list) if (!byId.has(r.id) || r.sample) byId.set(r.id, r);
  return [...byId.values()].sort((a, b) => b.at.localeCompare(a.at));
}

function findRun(id: string): string | null {
  if (!/^[\w-]+$/.test(id)) return null;
  for (const dir of [RUNS, SAMPLES]) {
    const p = join(dir, `${id}.json`);
    if (existsSync(p)) return p;
  }
  return null;
}

function startRun(query: string): string {
  const id = newRunId();
  const entry: Live = { events: [], listeners: new Set(), done: false };
  live.set(id, entry);
  running += 1;
  const llm = createGemini();
  void runResearch(query, {
    llm,
    toolsets: createToolsets({ llm }),
    emit: (e) => {
      entry.events.push(e);
      for (const res of entry.listeners) res.write(`data: ${JSON.stringify(e)}\n\n`);
    },
  }, id)
    .then((result) => {
      mkdirSync(RUNS, { recursive: true });
      writeFileSync(join(RUNS, `${id}.json`), JSON.stringify({ id, events: result.events }));
    })
    .finally(() => {
      running -= 1;
      entry.done = true;
      for (const res of entry.listeners) res.end();
      setTimeout(() => live.delete(id), 10 * 60_000);
    });
  return id;
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const path = decodeURIComponent(url.pathname);
  try {
    if (path === "/api/config") {
      return json(res, 200, { live: !!process.env.GEMINI_API_KEY, model: process.env.GEMINI_MODEL || "gemini-3.8-flash", running });
    }
    if (path === "/api/runs" && req.method === "GET") return json(res, 200, savedRuns());
    if (path === "/api/runs" && req.method === "POST") {
      if (!process.env.GEMINI_API_KEY) return json(res, 400, { error: "No GEMINI_API_KEY in .env, so live runs are off. Replay a saved run instead." });
      if (running >= 1) return json(res, 429, { error: "A run is already in progress. Wait for it to finish." });
      const body = await readBody(req);
      const query = String(body.query ?? "").trim();
      if (query.length < 10 || query.length > MAX_QUERY) return json(res, 400, { error: `Ask a question between 10 and ${MAX_QUERY} characters.` });
      return json(res, 200, { id: startRun(query) });
    }
    const ev = path.match(/^\/api\/runs\/([\w-]+)\/events$/);
    if (ev) {
      const entry = live.get(ev[1]);
      if (!entry) return json(res, 404, { error: "No live run with that id" });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      for (const e of entry.events) res.write(`data: ${JSON.stringify(e)}\n\n`);
      if (entry.done) return res.end();
      entry.listeners.add(res);
      req.on("close", () => entry.listeners.delete(res));
      return;
    }
    const one = path.match(/^\/api\/runs\/([\w-]+)$/);
    if (one) {
      const file = findRun(one[1]);
      if (!file) return json(res, 404, { error: "No saved run with that id" });
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      return res.end(readFileSync(file));
    }

    // Static files from site/.
    const rel = normalize(path.slice(1)).replace(/^(\.\.[/\\])+/, "");
    let file = join(SITE, rel || "index.html");
    if (!file.startsWith(SITE)) return json(res, 404, { error: "Not found" });
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file)) return json(res, 404, { error: "Not found" });
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(readFileSync(file));
  } catch (err) {
    json(res, 500, { error: (err as Error).message });
  }
}).listen(PORT, HOST, () => console.log(`Pharma research agent: http://${HOST}:${PORT}${process.env.GEMINI_API_KEY ? "" : "  (no GEMINI_API_KEY: replay only)"}`));
