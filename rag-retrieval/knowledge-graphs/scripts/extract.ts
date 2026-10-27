// Re-run entity and relation extraction on the sample documents with Gemini.
//
//   npm run extract              dry run: shows the prompt and the calls it would make
//   npm run extract -- --live    paid: one Gemini call per document, results in runs/
//
// Live results are validated against the schema and written to the
// Git-ignored runs/extractions/. They never overwrite the committed fixtures
// in data/extractions/, which the app and the tests use; compare them by hand
// and copy one over if you want the app to show it.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DOCUMENTS } from "../src/data.ts";
import { docText } from "../src/retrieve.ts";
import { ENTITY_TYPES, EXTRACTION_JSON_SCHEMA, RELATION_TYPES, validateExtraction, type Extraction } from "../src/schema.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
try {
  process.loadEnvFile(join(ROOT, ".env"));
} catch {
  // No .env: use the environment as it is.
}

const live = process.argv.includes("--live");
const model = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const key = process.env.GEMINI_API_KEY;
const API = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

const SYSTEM = [
  "You extract a knowledge graph from a company document.",
  `Entity types: ${ENTITY_TYPES.join(", ")}. Customer is an external organization that uses a product; Company is a supplier.`,
  "Relation types (source type -> target type):",
  ...Object.entries(RELATION_TYPES).map(([t, r]) => `- ${t}: ${r.from.join("|")} -> ${r.to.join("|")}`),
  "Rules: write each entity name exactly as it appears in the text. Only use the listed types.",
  "Only extract relations the text states; copy the exact words that state each one into evidence.",
  "Do not invent entities, and do not merge different names for the same thing: that is done later.",
].join("\n");

// Gemini's schema subset needs explicit object properties, so free-form
// properties travel as key/value pairs and are converted back afterwards.
const kv = { type: "array", items: { type: "object", properties: { key: { type: "string" }, value: { type: "string" } }, required: ["key", "value"] } };
const schema = structuredClone(EXTRACTION_JSON_SCHEMA) as unknown as {
  properties: { entities: { items: { properties: Record<string, unknown> } }; relations: { items: { properties: Record<string, unknown> } } };
};
schema.properties.entities.items.properties.properties = kv;
schema.properties.relations.items.properties.properties = kv;

type Raw = { entities: { name: string; type: string; properties?: { key: string; value: string }[] }[]; relations: { source: string; type: string; target: string; evidence: string; properties?: { key: string; value: string }[] }[] };
const props = (p?: { key: string; value: string }[]) => (p?.length ? Object.fromEntries(p.map((x) => [x.key, x.value])) : undefined);

async function call(text: string): Promise<Raw> {
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: "user", parts: [{ text }] }],
    generationConfig: { temperature: 0, responseMimeType: "application/json", responseJsonSchema: schema },
  };
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(API, { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": key! }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
    } catch (error) {
      if (attempt >= 2) throw new Error(`Request failed: ${(error as Error).message}`);
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
      continue;
    }
    if (RETRYABLE.has(res.status) && attempt < 2) {
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}. Check the API key, model name (${model}) and quota.`);
    const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[] };
    const out = (data.candidates?.[0]?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? "").join("");
    return JSON.parse(out) as Raw;
  }
}

console.log(`Model: ${model}. Documents: ${DOCUMENTS.length}. Calls: ${DOCUMENTS.length} (one per document).`);
if (!live) {
  console.log("\nDry run. No API calls were made. System prompt:\n");
  console.log(SYSTEM);
  console.log("\nRun with --live (and GEMINI_API_KEY set) to make the paid calls. Results go to runs/extractions/.");
  process.exit(0);
}
if (!key) {
  console.error("Set GEMINI_API_KEY in .env (see .env.example) for a live run.");
  process.exit(1);
}

const outDir = join(ROOT, "runs", "extractions");
mkdirSync(outDir, { recursive: true });
for (const doc of DOCUMENTS) {
  const text = docText(doc);
  const raw = await call(`# ${doc.title}\n\n${text}`);
  const x: Extraction = {
    document: doc.id,
    source: "gemini",
    model,
    entities: raw.entities.map((e) => ({ name: e.name, type: e.type as Extraction["entities"][number]["type"], properties: props(e.properties) })),
    relations: raw.relations.map((r) => ({ source: r.source, type: r.type as Extraction["relations"][number]["type"], target: r.target, evidence: r.evidence, properties: props(r.properties) })),
  };
  const problems = validateExtraction(x, text);
  writeFileSync(join(outDir, `${doc.id}.json`), `${JSON.stringify(x, null, 2)}\n`);
  console.log(`${doc.id}: ${x.entities.length} entities, ${x.relations.length} relations${problems.length ? `, ${problems.length} problems:\n  ${problems.join("\n  ")}` : ""}`);
}
