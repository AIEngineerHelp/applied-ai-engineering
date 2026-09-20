import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { availableAgents, availableTools, MAX_STEPS } from "./engine.js";
import { catalogFor, offlinePlan, parseTask } from "./domain.js";
import { createProvider, configuration } from "./providers.js";

// These labels are hand-authored examples of the desired routing policy. They
// are not inferred from a model answer or from the routing implementation.
const task = parseTask({ city: "Tokyo", days: 2, budget: 24000 });
const places = catalogFor("Tokyo").places.filter((p) => p.kind === "activity");
const food = catalogFor("Tokyo").places.filter((p) => p.kind === "meal");
const plan = offlinePlan(task, { places, food });
const state = (changes: Record<string, any> = {}) => ({
  task, evidence: { places, food }, plan: null, review: null,
  history: [], lastError: null, ...changes,
});
const failed = (issue: string) => ({ passed: false, issues: [issue], specialist: { satisfied: false } });

export const BENCHMARK_CASES = [
  { id: "draft-after-research", group: "agent", expected: "planner", reason: "Both evidence sets are ready; no draft exists.", state: state() },
  { id: "draft-after-search-retry", group: "agent", expected: "planner", reason: "The missing meal search succeeded; drafting is now possible.", state: state({ history: [{ agent: "researcher", tool: "search_food", outcome: "6 meals found" }] }) },
  { id: "review-first-draft", group: "agent", expected: "reviewer", reason: "A draft exists and has not been checked.", state: state({ plan }) },
  { id: "review-revised-draft", group: "agent", expected: "reviewer", reason: "The revision has not been reviewed yet.", state: state({ plan, history: [{ agent: "planner", tool: "revise_itinerary", outcome: "Revised draft" }] }) },
  { id: "replace-insufficient-activities", group: "agent", expected: "researcher", reason: "One researched activity cannot supply four distinct activity slots.", state: state({ evidence: { places: places.slice(0, 1), food }, plan, review: failed("Only one researched activity is available for four distinct activity slots.") }) },
  { id: "replace-unsuitable-meals", group: "agent", expected: "researcher", reason: "The sole researched meal is unsuitable for a vegetarian request.", state: state({ evidence: { places, food: [{ ...food[0], vegetarian: false }] }, plan, review: failed("The only researched meal is not vegetarian.") }) },
  { id: "revise-closed-stop", group: "agent", expected: "planner", reason: "Other researched activities are available; revise the closed stop out of the draft.", state: state({ task: { ...task, closed: [plan.days[0].activities[0]] }, plan, review: failed("A planned activity is closed; unused researched alternatives exist.") }) },
  { id: "revise-rain-day", group: "agent", expected: "planner", reason: "Indoor researched alternatives exist for the rainy day.", state: state({ task: { ...task, rainDay: 1 }, plan, review: failed("Day 1 includes an outdoor activity in rain; unused indoor alternatives exist.") }) },
  { id: "search-more-activities", group: "tool", agent: "researcher", expected: "search_places", reason: "The failed review needs more distinct activities, while meal evidence is sufficient.", state: state({ evidence: { places: places.slice(0, 1), food }, plan, review: failed("Only one researched activity is available for four distinct activity slots.") }) },
  { id: "search-indoor-activities", group: "tool", agent: "researcher", expected: "search_places", reason: "No indoor activity is present for the rainy day.", state: state({ task: { ...task, rainDay: 1 }, evidence: { places: places.filter((p) => !p.indoor), food }, plan, review: failed("No researched indoor activity is available for rainy day 1.") }) },
  { id: "search-vegetarian-meals", group: "tool", agent: "researcher", expected: "search_food", reason: "The only researched meal conflicts with the vegetarian requirement.", state: state({ evidence: { places, food: [{ ...food[0], vegetarian: false }] }, plan, review: failed("The only researched meal is not vegetarian.") }) },
  { id: "search-replacement-meal", group: "tool", agent: "researcher", expected: "search_food", reason: "The sole researched meal is closed; activity evidence is sufficient.", state: state({ task: { ...task, closed: [food[0].id] }, evidence: { places, food: food.slice(0, 1) }, plan, review: failed("The only researched meal is closed.") }) },
] as const;

// A separate, as-yet-unmeasured challenge set. Keep it separate from the
// published 12-case result so its dataset hash and claims remain unchanged.
export const CHALLENGE_CASES = [
  { id: "repair-meal-with-alternative", group: "agent", expected: "planner", reason: "A vegetarian replacement is already researched; revise rather than search again.",
    state: state({ plan: { ...plan, days: [{ ...plan.days[0], meal: "asakusa-grill" }, ...plan.days.slice(1)] }, review: failed("The first meal is not vegetarian; a suitable alternative is present.") }) },
  { id: "research-when-all-known-places-closed", group: "agent", expected: "researcher", reason: "Current activity evidence cannot fill the plan because every known activity is excluded.",
    state: state({ task: { ...task, closed: places.map((p) => p.id) }, plan, review: failed("No available researched activities remain.") }) },
  { id: "revise-expensive-draft-with-cheap-evidence", group: "agent", expected: "planner", reason: "The researched catalog includes enough lower-cost options; revise the expensive draft before searching.",
    state: state({ task: { ...task, budget: 6000 }, plan: { ...plan, days: plan.days.map((day, index) => ({ ...day, activities: index ? ["digital-gallery", "print-studio"] : ["tea-room", "city-museum"], meal: "shibuya-tofu" })) }, review: failed("This draft exceeds budget, but researched low-cost alternatives exist.") }) },
  { id: "research-after-first-budget-failure", group: "agent", expected: "researcher", reason: "The current evidence is too expensive; one failed draft is not proof that cheaper web options do not exist.",
    state: state({ task: { ...task, budget: 1000 }, plan, review: failed("Current plan exceeds budget."), history: [{ agent: "reviewer", tool: "review_itinerary", outcome: "budget_failed" }] }) },
  { id: "ask-about-conflicting-requirements", group: "agent", expected: "clarify", reason: "The review found mutually exclusive user constraints that cannot be repaired by choosing another known venue.",
    state: state({ task: { ...task, notes: "I need both an entirely outdoor day and an entirely indoor day on the same rainy day. Ask me which matters more." }, plan, review: failed("Traveler must choose which mutually exclusive requirement to prioritize.") }) },
  { id: "search-one-of-two-gaps", group: "tool", agent: "researcher", expected: "search_places", acceptable: ["search_places", "search_food"], reason: "Both activity and meal evidence are missing. Either first search is valid; this case must not force an arbitrary order.",
    state: state({ evidence: {}, plan: null, review: null }) },
  { id: "repair-vegetarian-evidence", group: "tool", agent: "researcher", expected: "search_food", reason: "Activities are sufficient, but the only meal conflicts with the dietary requirement.",
    state: state({ evidence: { places, food: [{ ...food[0], vegetarian: false }] }, plan, review: failed("The only meal is not vegetarian.") }) },
] as const;

export function inputFor(testCase: any) {
  const criteria = testCase.group === "agent"
    ? availableAgents(testCase.state)
    : availableTools(testCase.state, testCase.agent);
  if (Object.keys(criteria).length < 2 ||
    !(testCase.acceptable ?? [testCase.expected]).every((choice) => Object.hasOwn(criteria, choice)) ||
    !Object.hasOwn(criteria, testCase.expected))
    throw new Error(`Invalid benchmark case: ${testCase.id}`);
  return {
    state: structuredClone({ ...testCase.state, remainingSteps: MAX_STEPS - 3, selectedAgent: testCase.agent ?? null }),
    criteria: structuredClone(criteria),
  };
}

export function datasetHash(cases: readonly any[] = BENCHMARK_CASES) {
  return createHash("sha256").update(JSON.stringify(cases.map((c) => ({ id: c.id, expected: c.expected,
    ...(c.acceptable ? { acceptable: c.acceptable } : {}), reason: c.reason, ...inputFor(c) })))).digest("hex");
}

export function summarize(samples: any[]) {
  const median = (values: number[]) => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };
  return Object.fromEntries(["gemini", "jev"].map((provider) => {
    const rows = samples.filter((s) => s.provider === provider);
    const successful = rows.filter((s) => !s.error);
    const calls = rows.flatMap((s) => s.calls);
    const versions = [...new Set(calls.map((c) => c.model))];
    const estimatedCosts = calls.map((c) => c.estimatedUsd);
    return [provider, {
      total: rows.length, correct: rows.filter((s) => s.correct).length,
      accuracy: rows.length ? rows.filter((s) => s.correct).length / rows.length : null,
      errors: rows.filter((s) => s.error).length,
      medianMs: median(successful.map((s) => s.ms)),
      p90Ms: successful.length ? [...successful.map((s) => s.ms)].sort((a, b) => a - b)[Math.ceil(successful.length * 0.9) - 1] : null,
      inputTokens: calls.reduce((sum, c) => sum + (c.inputTokens ?? 0), 0),
      outputTokens: calls.reduce((sum, c) => sum + (c.outputTokens ?? 0), 0),
      estimatedUsd: estimatedCosts.length && estimatedCosts.every((v) => typeof v === "number") ? estimatedCosts.reduce((a, b) => a + b, 0) : null,
      modelVersions: versions,
    }];
  }));
}

export async function runBenchmark({
  cases = BENCHMARK_CASES, repetitions = 3, config = configuration(),
  providerFactory = createProvider, onProgress = () => {},
}: {
  cases?: readonly any[]; repetitions?: number; config?: ReturnType<typeof configuration>;
  providerFactory?: (options: { config: ReturnType<typeof configuration>; onCall: (call: any) => void }) => { choose: (provider: string, state: any, criteria: any) => Promise<{ choice: string }> };
  onProgress?: (sample: any) => void;
} = {}) {
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 5)
    throw new Error("Repetitions must be an integer from 1 to 5.");
  const samples: any[] = [];
  for (let repeat = 0; repeat < repetitions; repeat++) {
    for (let index = 0; index < cases.length; index++) {
      const testCase = cases[index];
      const input = inputFor(testCase);
      const order = (index + repeat) % 2 ? ["jev", "gemini"] : ["gemini", "jev"];
      for (const providerName of order) {
        const calls: any[] = [];
        const provider = providerFactory({ config, onCall: (call) => {
          // Persist usage and timing, never the raw model request/response.
          const { provider, stage, model, ms, inputTokens, outputTokens, estimatedUsd, error } = call;
          calls.push({ provider, stage, model, ms, inputTokens, outputTokens, estimatedUsd, error });
        } });
        const start = performance.now();
        let choice: string | null = null, error: string | null = null;
        try {
          choice = (await provider.choose(providerName, structuredClone(input.state), structuredClone(input.criteria))).choice;
          if (!Object.hasOwn(input.criteria, choice)) throw new Error("Provider chose an illegal action.");
        } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
        const accepted = testCase.acceptable ?? [testCase.expected];
        const sample = { caseId: testCase.id, group: testCase.group, repetition: repeat + 1,
          provider: providerName, expected: testCase.expected, acceptable: accepted, choice,
          preferred: choice === testCase.expected && !error,
          correct: accepted.includes(choice) && !error,
          ms: Math.round(performance.now() - start), error, calls };
        samples.push(sample);
        onProgress(sample);
      }
    }
  }
  return { schemaVersion: 1, createdAt: new Date().toISOString(), datasetHash: datasetHash(cases),
    repetitions, cases: cases.map(({ id, group, agent, expected, acceptable, reason }) => ({ id, group, agent, expected, acceptable: acceptable ?? [expected], reason })),
    configuration: { geminiModel: config.geminiModel, jevModel: config.jevModel, instruction: "See CHOICE_INSTRUCTION in src/providers.ts" },
    samples, summary: summarize(samples) };
}
