// Build a static, replay-only copy in dist/: the app plus the committed sample
// runs (results/runs). No server and no API key: the page replays saved runs.
import { cpSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunEvent } from "../src/types.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "dist");
mkdirSync(OUT, { recursive: true });
for (const name of readdirSync(OUT)) {
  if (name !== ".vercel") rmSync(join(OUT, name), { recursive: true, force: true });
}
cpSync(join(ROOT, "site"), OUT, { recursive: true });

const SAMPLES = join(ROOT, "results", "runs");
mkdirSync(join(OUT, "runs"), { recursive: true });
const index = readdirSync(SAMPLES)
  .filter((f) => f.endsWith(".json"))
  .map((f) => {
    cpSync(join(SAMPLES, f), join(OUT, "runs", f));
    const run = JSON.parse(readFileSync(join(SAMPLES, f), "utf8")) as { id: string; events: RunEvent[] };
    const head = run.events.find((e) => e.type === "run") as Extract<RunEvent, { type: "run" }>;
    const done = run.events.find((e) => e.type === "done") as Extract<RunEvent, { type: "done" }> | undefined;
    return { id: run.id, query: head.query, at: head.at, sample: true, ms: done?.ms };
  })
  .sort((a, b) => b.at.localeCompare(a.at));
writeFileSync(join(OUT, "runs", "index.json"), JSON.stringify(index));
writeFileSync(join(OUT, "vercel.json"), `${JSON.stringify({ cleanUrls: true }, null, 2)}\n`);
console.log(`Exported to ${OUT} with ${index.length} sample runs`);
