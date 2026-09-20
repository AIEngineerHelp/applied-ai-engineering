import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BENCHMARK_CASES, CHALLENGE_CASES, datasetHash, inputFor, runBenchmark } from "../src/benchmark.js";
import { configuration } from "../src/providers.js";

const args = process.argv.slice(2);
const live = args.includes("--live");
const challenge = args.includes("--challenge");
const cases = challenge ? CHALLENGE_CASES : BENCHMARK_CASES;
const repetitionsAt = args.indexOf("--repetitions");
const repetitions = repetitionsAt < 0 ? 3 : Number(args[repetitionsAt + 1]);
if (args.some((arg, index) => !["--live", "--challenge", "--repetitions"].includes(arg) && index !== repetitionsAt + 1))
  throw new Error("Usage: npm run benchmark -- [--challenge] [--live] [--repetitions 1..5]");
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 5)
  throw new Error("Repetitions must be an integer from 1 to 5.");
const config = configuration();
for (const testCase of cases) inputFor(testCase);
const plannedCalls = cases.length * repetitions * 2;
if (!live) {
  console.log(JSON.stringify({ mode: "dry-run", suite: challenge ? "challenge" : "published",
    cases: cases.length, repetitions, plannedCalls, datasetHash: datasetHash(cases),
    note: "No provider calls were made. Pass --live to run the paid coordinator benchmark." }, null, 2));
} else {
  if (!config.live) throw new Error("Configure both API keys and ENABLE_LIVE=true before a paid benchmark.");
  console.error(`Running ${plannedCalls} sequential coordinator calls across ${cases.length} frozen cases.`);
  const result = await runBenchmark({ cases, repetitions, config,
    onProgress: (sample) => console.error(`${sample.repetition}/${repetitions} ${sample.caseId} ${sample.provider}: ${sample.error ?? sample.choice} (${sample.ms} ms)`),
  });
  const outputDir = join(process.cwd(), ".runs", "benchmarks");
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const output = join(outputDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${result.datasetHash.slice(0, 8)}.json`);
  writeFileSync(output, JSON.stringify(result, null, 2), { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({ file: output, summary: result.summary, datasetHash: result.datasetHash }, null, 2));
}
