// Send each prompt layout to Gemini and record what the cache did.
//
//   node experiment/run.js                 dry run: prints the plan, no API calls
//   node experiment/run.js --live          paid run against the Gemini API
//   node experiment/run.js --live --only stable,timestamp-top
//
// Requests run one at a time, with a pause between them, so implicit caching has
// the best chance to work. Raw results go to runs/<run id>.jsonl (Git-ignored);
// `npm run analyze` turns them into the committed results/.

import { mkdirSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";

import { LAYOUTS, EXPLICIT, ALL_IDS } from "./layouts.js";
import { estimateTokens } from "../src/tokens.js";
import { getModel } from "../src/providers.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://generativelanguage.googleapis.com/v1beta";

function loadEnv() {
  const file = join(ROOT, ".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

function int(name, fallback, low, high) {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, low), high) : fallback;
}

loadEnv();
const args = process.argv.slice(2);
const live = args.includes("--live");
const onlyArg = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
const only = onlyArg ? onlyArg.split(",") : ALL_IDS;
const unknown = only.filter((id) => !ALL_IDS.includes(id));
if (unknown.length) {
  console.error(`Unknown layout: ${unknown.join(", ")}. Choose from ${ALL_IDS.join(", ")}.`);
  process.exit(1);
}

const settings = {
  model: process.env.GEMINI_MODEL || "gemini-3.8-flash",
  requests: int("REQUESTS_PER_LAYOUT", 12, 2, 12),
  pauseMs: int("PAUSE_MS", 1500, 0, 60000),
  maxOutputTokens: int("MAX_OUTPUT_TOKENS", 300, 16, 4096),
  timeoutMs: int("REQUEST_TIMEOUT_MS", 60000, 5000, 300000),
  retries: int("MAX_RETRIES", 2, 0, 5),
};

const runId = `r${new Date().toISOString().slice(0, 10).replaceAll("-", "")}${randomBytes(2).toString("hex")}`;
const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function generationConfig() {
  return {
    maxOutputTokens: settings.maxOutputTokens,
    temperature: 0,
    // Keep thinking short so time to first token mostly reflects reading the prompt.
    // (gemini-3.8-flash rejects MINIMAL.)
    thinkingConfig: { thinkingLevel: "LOW" },
  };
}

function body(req) {
  const b = { contents: [{ role: "user", parts: [{ text: req.user }] }], generationConfig: generationConfig() };
  if (req.system) b.systemInstruction = { parts: [{ text: req.system }] };
  if (req.tools) b.tools = [{ functionDeclarations: req.tools }];
  if (req.cachedContent) b.cachedContent = req.cachedContent;
  return b;
}

async function fetchWithRetry(url, init) {
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      if ((res.status === 429 || res.status >= 500) && attempt < settings.retries) {
        await sleep(2000 * 2 ** attempt);
        continue;
      }
      return res;
    } catch (error) {
      if (attempt >= settings.retries) throw error;
      await sleep(2000 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }
}

const headers = () => ({ "content-type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY });

// Stream the response to measure time to first token, and read usage from the last chunk.
async function generate(payload) {
  const started = performance.now();
  const res = await fetchWithRetry(`${API}/models/${settings.model}:streamGenerateContent?alt=sse`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  let firstTokenMs = null;
  let usage = {};
  let text = "";
  const calls = [];
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const data = JSON.parse(line.slice(5));
      for (const part of data.candidates?.[0]?.content?.parts ?? []) {
        if (firstTokenMs === null && (part.text || part.functionCall)) firstTokenMs = performance.now() - started;
        if (part.text && !part.thought) text += part.text;
        if (part.functionCall) calls.push(part.functionCall.name);
      }
      if (data.usageMetadata) usage = data.usageMetadata;
    }
  }
  return { firstTokenMs, totalMs: performance.now() - started, usage, text, calls };
}

async function createCache(req) {
  const res = await fetchWithRetry(`${API}/cachedContents`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      model: `models/${settings.model}`,
      displayName: `prompt-caching-${runId}`,
      systemInstruction: { parts: [{ text: req.system }] },
      tools: [{ functionDeclarations: req.tools }],
      ttl: "600s",
    }),
  });
  if (!res.ok) throw new Error(`Creating the cache failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

async function deleteCache(name) {
  const res = await fetchWithRetry(`${API}/${name}`, { method: "DELETE", headers: headers() });
  return res.ok;
}

const hash = (s) => createHash("sha256").update(s).digest("hex").slice(0, 12);

// Where the rendered request first differs from the previous request in the same layout.
function firstDifference(a, b) {
  if (!a) return null;
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

function plan() {
  const ctx = { runId: "plan", layout: "", now };
  const rows = [...LAYOUTS, EXPLICIT]
    .filter((l) => only.includes(l.id))
    .map((l) => {
      const c = { ...ctx, layout: l.id };
      const req = l.id === "explicit" ? { ...l.cache(c), ...l.build(c, 0) } : l.build(c, 0);
      const tokens = estimateTokens(JSON.stringify(body(req)));
      return { layout: l.id, requests: settings.requests, tokens };
    });
  const model = getModel(settings.model);
  const inputTokens = rows.reduce((s, r) => s + r.tokens * r.requests, 0);
  const worst = (inputTokens * model.input + rows.reduce((s, r) => s + r.requests, 0) * settings.maxOutputTokens * 3.75) / 1e6;
  return { rows, inputTokens, worst };
}

async function main() {
  const p = plan();
  console.log(`Model ${settings.model}, ${settings.requests} requests per layout, ${settings.pauseMs} ms apart.`);
  console.table(p.rows);
  console.log(`About ${p.inputTokens.toLocaleString()} input tokens. Worst case (no cache hits) about $${p.worst.toFixed(2)}.`);
  if (!live) {
    console.log("Dry run: no requests sent. Add --live to call the Gemini API (paid).");
    return;
  }
  if (!process.env.GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY is not set. Copy .env.example to .env and add a key.");
    process.exit(1);
  }

  mkdirSync(join(ROOT, "runs"), { recursive: true });
  const out = join(ROOT, "runs", `${runId}.jsonl`);
  const write = (row) => appendFileSync(out, `${JSON.stringify(row)}\n`);
  write({ type: "run", runId, startedAt: now(), settings, layouts: only });
  console.log(`Run ${runId} → ${out}`);

  for (const layout of [...LAYOUTS, EXPLICIT].filter((l) => only.includes(l.id))) {
    const ctx = { runId, layout: layout.id, now };
    let cache = null;
    let previous = null;
    if (layout.id === "explicit") {
      const started = performance.now();
      cache = await createCache(layout.cache(ctx));
      write({
        type: "cache",
        layout: layout.id,
        name: cache.name,
        createMs: Math.round(performance.now() - started),
        usage: cache.usageMetadata ?? null,
        createdAt: now(),
      });
      console.log(`  created ${cache.name} (${cache.usageMetadata?.totalTokenCount ?? "?"} tokens)`);
    }
    try {
      for (let i = 0; i < settings.requests; i++) {
        const req = cache ? { ...layout.build(ctx, i), cachedContent: cache.name } : layout.build(ctx, i);
        const payload = body(req);
        // The rendered prefix: everything except the question, in the order sent.
        const prefix = JSON.stringify({ tools: payload.tools, system: payload.systemInstruction }) + payload.contents[0].parts[0].text;
        const diffAt = firstDifference(previous, prefix);
        previous = prefix;
        try {
          const r = await generate(payload);
          const u = r.usage;
          write({
            type: "request",
            layout: layout.id,
            i,
            at: now(),
            question: layout.build(ctx, i).user,
            prefixHash: hash(JSON.stringify(payload.systemInstruction ?? "") + JSON.stringify(payload.tools ?? "")),
            firstDiffChars: diffAt,
            promptTokens: u.promptTokenCount ?? null,
            cachedTokens: u.cachedContentTokenCount ?? 0,
            outputTokens: u.candidatesTokenCount ?? 0,
            thoughtTokens: u.thoughtsTokenCount ?? 0,
            firstTokenMs: r.firstTokenMs === null ? null : Math.round(r.firstTokenMs),
            totalMs: Math.round(r.totalMs),
            answer: r.text.slice(0, 2000),
            toolCalls: r.calls,
          });
          console.log(
            `  ${layout.id.padEnd(17)} #${String(i + 1).padStart(2)}  prompt ${u.promptTokenCount}  cached ${u.cachedContentTokenCount ?? 0}  first token ${Math.round(r.firstTokenMs ?? 0)} ms`,
          );
        } catch (error) {
          write({ type: "error", layout: layout.id, i, at: now(), error: String(error.message ?? error) });
          console.error(`  ${layout.id} #${i + 1} failed: ${error.message}`);
        }
        await sleep(settings.pauseMs);
      }
    } finally {
      if (cache) {
        const deleted = await deleteCache(cache.name);
        write({ type: "cache-deleted", layout: layout.id, name: cache.name, deleted, at: now() });
      }
    }
  }
  write({ type: "done", at: now() });
  console.log(`Done. Run \`npm run analyze -- ${runId}\` to export results.`);
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
