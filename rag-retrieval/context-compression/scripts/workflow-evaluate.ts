import { runExperiment } from "../src/experiments.ts";
import { defaults } from "../src/compress.ts";
import { formatPassages, retrieve, scenarios } from "../src/fixtures.ts";
const rows = [];
for (const scenario of scenarios)
  for (const kind of ["paired", "agent"] as const)
    for (const method of ["relevance", "words"] as const) {
      const question = scenario.questions[0];
      const source = formatPassages(
        scenario.id === "rag"
          ? retrieve(scenario.passages, question.text, 3).map((r) => r.passage)
          : scenario.passages,
      );
      const result = await runExperiment(
        {
          mode: "fixture",
          kind,
          scenarioId: scenario.id,
          source,
          options: { ...defaults, method, query: question.text, focus: question.focus },
          allowPaid: false,
          failOpen: false,
          judge: true,
          maxSteps: 4,
        },
        { enableLocal: false, python: "/disabled" },
        {},
        { random: () => 0 },
      );
      if (result.full.status !== "complete" || result.compressed.status !== "complete")
        throw new Error(`Workflow failed: ${scenario.id}/${kind}/${method}`);
      rows.push({
        scenario: scenario.id,
        kind,
        method,
        fullStatus: result.full.status,
        compressedStatus: result.compressed.status,
        fullSteps: result.full.steps.length,
        compressedSteps: result.compressed.steps.length,
        fullCalls: result.full.calls.length,
        compressedCalls: result.compressed.calls.length,
        judgeStatus: result.judge.status,
        scriptedVerdict: result.judge.verdict,
      });
    }
console.log(
  JSON.stringify(
    {
      disclaimer:
        "Deterministic scripted control-flow fixtures only. No LLM, semantic quality measurement, model loading or paid calls. Timing omitted for reproducibility; judge order fixed for this fixture export only.",
      rows,
    },
    null,
    2,
  ),
);
