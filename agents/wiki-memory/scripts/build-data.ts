// Regenerates results/run.json (used by the app) and results/wiki/ (the final wiki as files).
// Deterministic and offline: no model calls.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildRun, finalWikiFiles, ROOT } from "../src/build.ts";

const run = buildRun();
const out = join(ROOT, "results");
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "run.json"), `${JSON.stringify(run, null, 1)}\n`);

const wikiDir = join(out, "wiki");
rmSync(wikiDir, { recursive: true, force: true });
for (const f of finalWikiFiles(run)) {
  mkdirSync(dirname(join(wikiDir, f.path)), { recursive: true });
  writeFileSync(join(wikiDir, f.path), f.text);
}

const last = run.steps[run.steps.length - 1];
console.log(`${run.steps.length} steps, ${last.pages.length} pages, ${run.chunkCount} raw chunks`);
console.log(`Lint before fixes: ${run.lintBefore.findings.length} findings; after: ${run.lintAfter.findings.length}`);
console.log(`Wrote ${join(out, "run.json")} and ${wikiDir}/`);
