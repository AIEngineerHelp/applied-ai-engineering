import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_CASES, agentDatasetHash, frozenCase, runAgentBenchmark } from "../src/agent-benchmark.js";
import { configuration } from "../src/providers.js";

const args = process.argv.slice(2);
const live = args.includes("--live");
const repetitionsAt = args.indexOf("--repetitions");
const repetitions = repetitionsAt < 0 ? 2 : Number(args[repetitionsAt + 1]);
if (args.some((arg, index) => !["--live", "--repetitions"].includes(arg) && index !== repetitionsAt + 1))
  throw new Error("Usage: npm run benchmark:agent -- [--live] [--repetitions 1..3]");
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 3)
  throw new Error("Repetitions must be an integer from 1 to 3.");
for (const testCase of AGENT_CASES) frozenCase(testCase);
const plannedRuns = AGENT_CASES.length * repetitions * 2;
if (!live) {
  console.log(JSON.stringify({ mode: "dry-run", cases: AGENT_CASES.length, repetitions,
    plannedRuns, datasetHash: agentDatasetHash(),
    note: "No provider calls were made. Pass --live to run the paid frozen-evidence agent benchmark." }, null, 2));
} else {
  const config = configuration();
  if (!config.live) throw new Error("Configure both API keys and ENABLE_LIVE=true before a paid benchmark.");
  console.error(`Running ${plannedRuns} sequential agent runs against identical synthetic evidence.`);
  const result = await runAgentBenchmark({ repetitions, config,
    onProgress: (sample) => console.error(`${sample.repetition}/${repetitions} ${sample.caseId} ${sample.team}: ${sample.status}, expected=${sample.meetsExpectation}, ${sample.wallMs} ms`),
  });
  const outputDir = join(process.cwd(), ".runs", "benchmarks");
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const output = join(outputDir, `agent-${new Date().toISOString().replace(/[:.]/g, "-")}-${result.datasetHash.slice(0, 8)}.json`);
  writeFileSync(output, JSON.stringify(result, null, 2), { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({ file: output, summary: result.summary, datasetHash: result.datasetHash }, null, 2));
}
