// Usage: npm run benchmark                      (no API calls; validates the dataset)
//        npm run benchmark -- --live [--repetitions 1-3]   (paid Jev calls)
import { mkdirSync, writeFileSync } from "node:fs";
import { collect, plan, summarize } from "../src/benchmark.js";
import { configuration, createJevPlayer } from "../src/jev.js";

const args = process.argv.slice(2);
const live = args.includes("--live");
const index = args.indexOf("--repetitions");
const repetitions = index === -1 ? 1 : Number(args[index + 1]);
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 3) {
  console.error("--repetitions must be an integer from 1 to 3.");
  process.exit(1);
}
const details = plan(repetitions);
if (!live) {
  console.log(JSON.stringify({ mode: "dry-run", ...details }, null, 2));
  console.log(`\nNo API calls made. Add --live to make ${details.plannedCalls} sequential Jev calls.`);
  process.exit(0);
}
const config = configuration();
if (!config.live) {
  console.error("Live calls are disabled. Set TYPESAFE_API_KEY and ENABLE_LIVE=true in .env.");
  process.exit(1);
}
const createdAt = new Date().toISOString();
let done = 0;
const samples = await collect({
  decide: createJevPlayer({ config }),
  repetitions,
  onSample: (s) => {
    done++;
    if (s.error || done % 25 === 0) console.error(`${done}/${details.plannedCalls}${s.error ? ` error: ${s.error}` : ""}`);
  },
});
const summary = summarize(samples);
const result = { createdAt, requestedModel: config.model, timeoutMs: config.timeoutMs, ...details, summary, samples };
mkdirSync(".runs/benchmarks", { recursive: true, mode: 0o700 });
const file = `.runs/benchmarks/${createdAt.replace(/[:.]/g, "-")}.json`;
writeFileSync(file, JSON.stringify(result, null, 2), { mode: 0o600 });
const { games, choices, ...headline } = summary;
console.log(JSON.stringify({ ...headline, choices }, null, 2));
console.log(`\nSaved ${file}`);
