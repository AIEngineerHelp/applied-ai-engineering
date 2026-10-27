// Step 1: extract entities and relations from each document with Gemini,
// against the schema, as structured output. Each relation must carry the exact
// quote that states it. Code then validates every relation against the schema
// and checks the quote is verbatim in the document; rejects are kept, with why.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Doc } from "../corpus.ts";
import { ROOT } from "../load-corpus.ts";
import { extractionJsonSchema, schemaText, validateExtraction, type RawExtraction, type Reject, type Triple } from "../schema.ts";
import { generateJson, MODEL, type CallUsage } from "./gemini.ts";

export const EXTRACT_SYSTEM = `You build a knowledge graph from short company documents of Corvane Instruments, a maker of water and flow sensors.

${schemaText()}

Rules:
1. List every entity the document names that fits one of the entity types, with its name exactly as written in the text. Do not invent names, and do not merge different spellings yourself.
2. List every relation the document states between two of those entities, using only the relation types and directions above.
3. For each relation, copy into "quote" the shortest exact span of the document that states it, character for character. Do not paraphrase or join sentences.
4. Add a property only when the text states it: "since"/"until"/"date" as YYYY-MM-DD, "units" as a number, "role" as sole, main or second source.
5. Do not add facts that are only implied, and do not extract opinions, plans or recommendations as relations.`;

export interface DocExtraction {
  doc: string;
  entities: { name: string; type: string }[];
  triples: Triple[];
  rejects: Reject[];
  usage: CallUsage;
}

export interface ExtractionRun {
  run: number;
  runId: string;
  model: string;
  at: string;
  docs: DocExtraction[];
}

export async function extractRun(docs: Doc[], run: number, runId: string, concurrency = 5): Promise<ExtractionRun> {
  const rawDir = join(ROOT, "runs", runId, "extract");
  mkdirSync(rawDir, { recursive: true });
  const out: DocExtraction[] = new Array(docs.length);
  let next = 0;
  async function worker() {
    while (next < docs.length) {
      const i = next++;
      const d = docs[i];
      const input = `Document: ${d.title}\nKind: ${d.kind}\nDate: ${d.date}\n\n${d.text}`;
      const { data, raw, usage } = await generateJson<RawExtraction>({ step: `extract-run-${run}`, label: d.id, system: EXTRACT_SYSTEM, input, schema: extractionJsonSchema() });
      writeFileSync(join(rawDir, `${d.id}.json`), `${JSON.stringify({ doc: d.id, model: usage.model, input, raw, usage }, null, 2)}\n`);
      const v = validateExtraction(data, d.text);
      out[i] = { doc: d.id, ...v, usage };
      console.log(`  run ${run} ${d.id}: ${v.entities.length} entities, ${v.triples.length} relations, ${v.rejects.length} rejected, $${usage.cost.toFixed(4)}`);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { run, runId, model: MODEL(), at: new Date().toISOString(), docs: out };
}
