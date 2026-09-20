import { createHash } from "node:crypto";
import { catalogFor, evaluatePlan, offlinePlan, parseTask } from "./domain.js";
import { runTeam } from "./engine.js";
import { configuration } from "./providers.js";

export const AGENT_CASES = [
  { id: "standard", expectedOutcome: "completed", task: { city: "Tokyo", days: 2, people: 2, budget: 24000, vegetarian: true, interests: ["culture", "art"] } },
  { id: "rain-day", expectedOutcome: "completed", task: { city: "Tokyo", days: 2, people: 2, budget: 24000, vegetarian: true, interests: ["culture", "art"], rainDay: 1 } },
  { id: "closed-venue", expectedOutcome: "completed", task: { city: "Tokyo", days: 2, people: 2, budget: 24000, vegetarian: true, interests: ["culture", "art"], closed: ["asakusa-walk"] } },
  { id: "rain-and-closure", expectedOutcome: "completed", task: { city: "Tokyo", days: 2, people: 2, budget: 24000, vegetarian: true, interests: ["culture", "art"], rainDay: 1, closed: ["craft-gallery"] } },
  { id: "infeasible-budget", expectedOutcome: "needs_input", task: { city: "Tokyo", days: 2, people: 2, budget: 1000, vegetarian: true, interests: ["culture", "art"] } },
] as const;

export function frozenCase(testCase: any) {
  const task = parseTask(testCase.task);
  const catalog = catalogFor(task.city);
  const evidence = {
    places: catalog.places.filter((p) => p.kind === "activity" && !task.closed.includes(p.id)),
    food: catalog.places.filter((p) => p.kind === "meal" && !task.closed.includes(p.id) && (!task.vegetarian || p.vegetarian)),
  };
  const minimumCost = (
    evidence.places.map((p) => p.price).sort((a, b) => a - b).slice(0, task.days * 2).reduce((a, b) => a + b, 0) +
    Math.min(...evidence.food.map((p) => p.price)) * task.days
  ) * task.people;
  if (testCase.expectedOutcome === "needs_input") {
    if (minimumCost <= task.budget) throw new Error(`Infeasibility is not proven: ${testCase.id}`);
  } else {
    const feasibility = evaluatePlan(offlinePlan(task, evidence), task, undefined, [...evidence.places, ...evidence.food]);
    if (!feasibility.passed) throw new Error(`Infeasible benchmark case: ${testCase.id}`);
  }
  return { task, evidence, catalogVersion: catalog.version };
}

export function agentDatasetHash(cases: readonly any[] = AGENT_CASES) {
  return createHash("sha256").update(JSON.stringify(cases.map((c) => ({ id: c.id, ...frozenCase(c) })))).digest("hex");
}

export function summarizeAgentRuns(runs: any[]) {
  return Object.fromEntries(["baseline", "hybrid"].map((team) => {
    const rows = runs.filter((r) => r.team === team);
    const sorted = rows.map((r) => r.wallMs).sort((a, b) => a - b);
    const median = sorted.length ? (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2 : null;
    return [team, { runs: rows.length, correctOutcomes: rows.filter((r) => r.meetsExpectation).length,
      completed: rows.filter((r) => r.completed).length,
      independentlyValid: rows.filter((r) => r.validationPassed).length,
      medianWallMs: median,
      modelCalls: rows.reduce((n, r) => n + r.modelCalls, 0),
      coordinationCalls: rows.reduce((n, r) => n + r.coordinationCalls, 0),
      workerCalls: rows.reduce((n, r) => n + r.workerCalls, 0),
      totalDecisionMs: rows.reduce((n, r) => n + r.decisionMs, 0),
    }];
  }));
}

export async function runAgentBenchmark({ cases = AGENT_CASES, repetitions = 2,
  config = configuration(), onProgress = () => {}, run = runTeam,
}: { cases?: readonly any[]; repetitions?: number; config?: ReturnType<typeof configuration>;
  onProgress?: (sample: any) => void; run?: typeof runTeam } = {}) {
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 3)
    throw new Error("Repetitions must be an integer from 1 to 3.");
  const runs: any[] = [];
  for (let repeat = 0; repeat < repetitions; repeat++) {
    for (let index = 0; index < cases.length; index++) {
      const testCase = cases[index];
      const { task, evidence, catalogVersion } = frozenCase(testCase);
      const order = (repeat + index) % 2 ? ["hybrid", "baseline"] : ["baseline", "hybrid"];
      for (const team of order) {
        const result = await run({ team, task: structuredClone(task), mode: "live", config,
          frozenEvidence: structuredClone(evidence), signal: AbortSignal.timeout(180000) });
        const check = result.plan
          ? evaluatePlan(result.plan, task, [...evidence.places, ...evidence.food].map((p) => p.id), [...evidence.places, ...evidence.food])
          : null;
        const calls = result.calls.map((c) => ({ provider: c.provider, stage: c.stage, model: c.model,
          ms: c.ms, inputTokens: c.inputTokens, outputTokens: c.outputTokens, estimatedUsd: c.estimatedUsd, error: c.error }));
        const actions = result.trace.flatMap((event): any[] => {
          if (event.type === "decision") return [{ step: event.step, kind: event.kind,
            agent: event.agent ?? null, choice: event.choice, source: event.source ?? "model" }];
          if (event.type === "tool_end") return [{ step: event.step, kind: "tool_result",
            agent: event.agent, tool: event.tool, ms: event.ms, error: event.error ?? null }];
          return [];
        });
        const meetsExpectation = testCase.expectedOutcome === "needs_input"
          ? result.status === "needs_input" && !check?.passed
          : result.status === "completed" && !!check?.passed;
        const sample = { caseId: testCase.id, catalogVersion, expectedOutcome: testCase.expectedOutcome,
          meetsExpectation, repetition: repeat + 1, team,
          status: result.status, completed: result.status === "completed", validationPassed: check?.passed ?? false,
          validationIssues: check?.issues ?? ["No itinerary produced."], estimatedTripInr: check?.total ?? null,
          plan: result.plan, review: result.review ? { passed: result.review.passed, specialist: result.review.specialist } : null,
          steps: result.metrics.steps, modelCalls: result.metrics.modelCalls,
          coordinationCalls: calls.filter((c) => c.stage === "coordination").length,
          workerCalls: calls.filter((c) => c.stage !== "coordination").length,
          wallMs: result.metrics.wallMs, decisionMs: result.metrics.decisionMs,
          calls, actions, error: result.error };
        runs.push(sample);
        onProgress(sample);
      }
    }
  }
  return { schemaVersion: 1, createdAt: new Date().toISOString(),
    datasetHash: agentDatasetHash(cases), repetitions,
    cases: cases.map((c) => ({ id: c.id, expectedOutcome: c.expectedOutcome,
      task: frozenCase(c).task, catalogVersion: frozenCase(c).catalogVersion })),
    configuration: { geminiModel: config.geminiModel, jevModel: config.jevModel },
    runs, summary: summarizeAgentRuns(runs) };
}
