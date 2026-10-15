// Records real responses from the three public APIs into agent/offline/fixtures/, so
// tests and the offline dry run work without a network. Free APIs; no key.
//   npx tsx scripts/record-fixtures.ts (makes network calls)
import { writeFileSync } from "node:fs";
import { fdaToolset } from "../agent/tools/fda.ts";
import { pubmedToolset } from "../agent/tools/pubmed.ts";
import { trialsToolset } from "../agent/tools/trials.ts";

const calls = [
  ["pubmed", pubmedToolset(), "search_pubmed", { query: "(semaglutide OR GLP-1 receptor agonist) AND pancreatitis AND (meta-analysis[pt] OR randomized controlled trial[pt])", max: 5 }],
  ["trials", trialsToolset(), "search_trials", { intervention: "semaglutide", condition: "heart failure", max: 6 }],
  ["fda", fdaToolset(), "get_drug_label", { generic_name: "semaglutide" }],
] as const;

const out: Record<string, unknown> = { recorded: new Date().toISOString().slice(0, 10) };
for (const [kind, ts, name, args] of calls) {
  out[kind] = { name, args, output: await ts.call(name, args as Record<string, unknown>) };
  console.log(kind, (out[kind] as { output: { sources: unknown[] } }).output.sources.length, "sources");
}
writeFileSync(new URL("../agent/offline/fixtures/sources.json", import.meta.url), JSON.stringify(out, null, 1));
