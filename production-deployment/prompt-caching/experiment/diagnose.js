// Follow-up check: does implicit caching hit under other request shapes?
//
//   node experiment/diagnose.js          dry run
//   node experiment/diagnose.js --live   12 paid requests (about $0.08)
//
// The main run saw no implicit cache hits, so this varies one thing at a time:
// streaming vs not, tools and thinking on vs off, a prompt three times larger,
// and the newer Interactions API. Three requests each, 1.5 s apart, each condition
// with its own prefix. Raw output goes to runs/diagnose-<time>.jsonl.

import { readFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { INSTRUCTIONS, HANDBOOK, EXAMPLES, TOOLS, QUESTIONS } from "../src/fixture.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://generativelanguage.googleapis.com/v1beta";
const MODEL = "gemini-3.8-flash";
const live = process.argv.includes("--live");

const envFile = join(ROOT, ".env");
const key =
  process.env.GEMINI_API_KEY ??
  (existsSync(envFile) ? readFileSync(envFile, "utf8").match(/^GEMINI_API_KEY=(.*)$/m)?.[1]?.trim() : undefined);

const tag = `diag-${Date.now()}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const system = (name, big) =>
  `Northwind ${tag}-${name}\n\n${INSTRUCTIONS}\n\n${big ? `${HANDBOOK}\n\n${HANDBOOK}\n\n${HANDBOOK}` : HANDBOOK}\n\n${EXAMPLES}`;

const CONDITIONS = [
  { id: "non-streaming", api: "generateContent", stream: false, tools: true, thinking: true },
  { id: "no-tools-no-thinking", api: "generateContent", stream: false, tools: false, thinking: false },
  { id: "large-prompt", api: "generateContent", stream: true, tools: true, thinking: true, big: true },
  { id: "interactions-api", api: "interactions" },
];

async function generateContent(c, i) {
  const body = {
    systemInstruction: { parts: [{ text: system(c.id, c.big) }] },
    contents: [{ role: "user", parts: [{ text: QUESTIONS[i] }] }],
    generationConfig: { maxOutputTokens: 200, temperature: 0, ...(c.thinking ? { thinkingConfig: { thinkingLevel: "LOW" } } : {}) },
  };
  if (c.tools) body.tools = [{ functionDeclarations: [...TOOLS].sort((a, b) => a.name.localeCompare(b.name)) }];
  const url = `${API}/models/${MODEL}:${c.stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": key }, body: JSON.stringify(body) });
  const text = await res.text();
  let usage = null;
  if (!res.ok) return { status: res.status, error: text.slice(0, 300) };
  if (c.stream) {
    for (const line of text.split("\n")) if (line.startsWith("data:")) usage = JSON.parse(line.slice(5)).usageMetadata ?? usage;
  } else usage = JSON.parse(text).usageMetadata;
  return { status: res.status, promptTokens: usage.promptTokenCount, cachedTokens: usage.cachedContentTokenCount ?? 0 };
}

async function interactions(c, i) {
  const res = await fetch(`${API}/interactions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key, "Api-Revision": "2026-05-20" },
    body: JSON.stringify({
      model: MODEL,
      system_instruction: system(c.id),
      input: QUESTIONS[i],
      store: false,
      generation_config: { thinking_level: "low", max_output_tokens: 200 },
    }),
  });
  const j = await res.json();
  if (!res.ok) return { status: res.status, error: JSON.stringify(j.error ?? j).slice(0, 300) };
  return { status: res.status, promptTokens: j.usage.total_input_tokens, cachedTokens: j.usage.total_cached_tokens ?? 0 };
}

async function main() {
  console.log(`${CONDITIONS.length} conditions × 3 requests to ${MODEL}.`);
  if (!live) return console.log("Dry run: add --live to send them (paid, about $0.08).");
  if (!key) throw new Error("GEMINI_API_KEY is not set.");
  mkdirSync(join(ROOT, "runs"), { recursive: true });
  const out = join(ROOT, "runs", `diagnose-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
  for (const c of CONDITIONS) {
    for (let i = 0; i < 3; i++) {
      const started = performance.now();
      const r = c.api === "interactions" ? await interactions(c, i) : await generateContent(c, i);
      const row = { condition: c.id, i: i + 1, ms: Math.round(performance.now() - started), ...r };
      appendFileSync(out, `${JSON.stringify(row)}\n`);
      console.log(JSON.stringify(row));
      await sleep(1500);
    }
  }
  console.log(`Saved ${out}`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
