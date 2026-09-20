import test from "node:test";
import assert from "node:assert/strict";
import { BENCHMARK_CASES, CHALLENGE_CASES, datasetHash, inputFor, runBenchmark, summarize } from "../src/benchmark.js";
import { AGENT_CASES, frozenCase } from "../src/agent-benchmark.js";
import { offlinePlan } from "../src/domain.js";
import { availableAgents, runTeam } from "../src/engine.js";
import { configuration } from "../src/providers.js";

test("every gold action is a real nontrivial choice in the current agent", () => {
  assert.equal(new Set(BENCHMARK_CASES.map((item) => item.id)).size, BENCHMARK_CASES.length);
  for (const item of BENCHMARK_CASES) {
    const input = inputFor(item);
    assert.ok(Object.keys(input.criteria).length > 1, item.id);
    assert.ok(Object.hasOwn(input.criteria, item.expected), item.id);
  }
  assert.match(datasetHash(), /^[a-f0-9]{64}$/);
});

test("challenge cases keep defensible actions legal and the published dataset unchanged", async () => {
  assert.equal(datasetHash(), "574475eb1981d973ef852091657bb8f5e6c16375aafa3e131781783fb11fbd40");
  for (const item of CHALLENGE_CASES) {
    const input = inputFor(item);
    assert.ok(Object.keys(input.criteria).length > 1, item.id);
  }
  const either = CHALLENGE_CASES.find((item) => item.id === "search-one-of-two-gaps");
  const result = await runBenchmark({ cases: [either], repetitions: 1,
    providerFactory: () => ({ choose: async (provider) => ({ choice: provider === "jev" ? "search_food" : "search_places" }) }),
  });
  assert.ok(result.samples.every((sample) => sample.correct));
  assert.equal(result.samples.find((sample) => sample.provider === "jev").preferred, false);
});

test("both providers see identical frozen inputs, with alternating order and preserved failures", async () => {
  const seen: any[] = [];
  const cases = BENCHMARK_CASES.slice(0, 2);
  const result = await runBenchmark({ cases, repetitions: 2,
    providerFactory: ({ onCall }: any) => ({ choose: async (provider, state, criteria) => {
      seen.push({ provider, state: structuredClone(state), criteria: structuredClone(criteria) });
      onCall({ provider, stage: "coordination", model: provider + "-test", ms: 10,
        inputTokens: 10, outputTokens: 2, estimatedUsd: null, error: null });
      if (provider === "jev" && seen.length === 2) throw new Error("quota exceeded");
      return { choice: cases[seen.length < 5 ? 0 : 1].expected };
    } }),
  });
  assert.equal(result.samples.length, 8);
  assert.deepEqual(seen.map((item) => item.provider), ["gemini", "jev", "jev", "gemini", "jev", "gemini", "gemini", "jev"]);
  for (let i = 0; i < seen.length; i += 2) {
    assert.deepEqual(seen[i].state, seen[i + 1].state);
    assert.deepEqual(seen[i].criteria, seen[i + 1].criteria);
  }
  assert.equal(result.samples[1].error, "quota exceeded");
  assert.equal(result.samples[1].correct, false);
  assert.equal(result.summary.jev.errors, 1);
  assert.equal(result.summary.jev.estimatedUsd, null);
});

test("summary counts failures in the denominator and never invents cost", () => {
  const base = { caseId: "one", group: "agent", repetition: 1, expected: "planner", calls: [] };
  const summary = summarize([
    { ...base, provider: "gemini", choice: "planner", correct: true, error: null, ms: 100 },
    { ...base, provider: "gemini", choice: null, correct: false, error: "timeout", ms: 45000 },
    { ...base, provider: "jev", choice: "researcher", correct: false, error: null, ms: 50 },
  ]);
  assert.equal(summary.gemini.accuracy, 0.5);
  assert.equal(summary.gemini.errors, 1);
  assert.equal(summary.gemini.medianMs, 100);
  assert.equal(summary.jev.accuracy, 0);
  assert.equal(summary.jev.estimatedUsd, null);
});

test("frozen-evidence live agent run uses the same catalog without search API calls", async () => {
  const { task, evidence } = frozenCase(AGENT_CASES[1]);
  let searchCalls = 0;
  const result = await runTeam({ team: "hybrid", task, mode: "live",
    frozenEvidence: evidence, config: { ...configuration({}), live: true },
    providerFactory: () => ({
      search() { searchCalls++; throw new Error("Search must not run"); },
      choose: async (_provider, state, criteria) => {
        const options = Object.keys(criteria);
        const selected = state.selectedAgent;
        return { choice: selected === "researcher"
          ? options.includes("search_places") && !state.evidence.places?.length ? "search_places" : "search_food"
          : options.includes("planner") && !state.plan ? "planner" : "reviewer" };
      },
      generate: async (_instruction, state, schema) => {
        if (schema.properties.tags) return { tags: [], indoorOnly: false };
        if (schema.properties.days) return offlinePlan(task, state.evidence);
        return { satisfied: true, feedback: "Fixture checks passed." };
      },
    }),
  });
  assert.equal(searchCalls, 0);
  assert.equal(result.dataset, "frozen-synthetic-evidence");
  assert.equal(result.status, "completed");
  assert.equal(result.review.passed, true);
});

test("agent benchmark includes feasible tasks and a proven impossible budget", () => {
  for (const item of AGENT_CASES) {
    const { task, evidence } = frozenCase(item);
    assert.ok(evidence.places.length >= task.days * 2);
    assert.ok(evidence.food.length > 0);
    if (item.expectedOutcome === "needs_input") {
      const cheapestActivities = evidence.places.map((p) => p.price).sort((a, b) => a - b).slice(0, task.days * 2);
      const lowerBound = (cheapestActivities.reduce((a, b) => a + b, 0) + Math.min(...evidence.food.map((p) => p.price)) * task.days) * task.people;
      assert.ok(lowerBound > task.budget);
    }
  }
});

test("budget stop rule leaves feasible evidence available for replanning", () => {
  const history = [
    { agent: "reviewer", tool: "review_itinerary", outcome: "budget_failed" },
    { agent: "planner", tool: "revise_itinerary", outcome: "unchanged" },
  ];
  const feasible = frozenCase(AGENT_CASES[0]);
  const impossible = frozenCase(AGENT_CASES.find((item) => item.id === "infeasible-budget"));
  const asState = ({ task, evidence }) => ({ task, evidence, plan: offlinePlan(task, evidence), review: null, history, lastError: null });
  assert.ok(Object.hasOwn(availableAgents(asState(feasible)), "planner"));
  assert.deepEqual(Object.keys(availableAgents(asState(impossible))), ["clarify"]);
});

test("budget failure followed by unchanged research asks for clarification before step limit", async () => {
  const { task, evidence } = frozenCase(AGENT_CASES.find((item) => item.id === "infeasible-budget"));
  const result = await runTeam({ team: "hybrid", task, mode: "live",
    frozenEvidence: evidence, config: { ...configuration({}), live: true },
    providerFactory: () => ({
      search() { throw new Error("Frozen evidence should bypass search"); },
      choose: async (_provider, state, criteria) => {
        if (state.selectedAgent === "researcher")
          return { choice: Object.hasOwn(criteria, "search_places") && !state.evidence.places?.length ? "search_places"
            : Object.hasOwn(criteria, "search_food") && !state.evidence.food?.length ? "search_food" : "search_places" };
        return { choice: !state.plan ? "planner" : !state.review ? "reviewer" : "researcher" };
      },
      generate: async (_instruction, state, schema) => {
        if (schema.properties.tags) return { tags: [], indoorOnly: false };
        if (schema.properties.days) return offlinePlan(task, state.evidence);
        return { satisfied: false, feedback: "Budget cannot fit." };
      },
    }),
  });
  assert.equal(result.status, "needs_input");
  assert.ok(result.metrics.steps < 12);
  assert.notEqual(result.review?.passed, true);
  assert.ok(result.trace.some((event) => event.type === "decision" && event.choice === "clarify"));
});
