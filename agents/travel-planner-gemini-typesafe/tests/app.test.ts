import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunStore, redact } from "../src/run-store.js";
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Place } from "../src/domain.js";
import {
  parseTask,
  catalog,
  searchCatalog,
  offlinePlan,
  evaluatePlan,
} from "../src/domain.js";
import { compare, runTeam, MAX_STEPS, availableAgents, availableTools } from "../src/engine.js";
import { configuration, createProvider } from "../src/providers.js";
import { createApp } from "../src/server.js";
const config = configuration({});
const task = parseTask({});
const evidence = {
  places: searchCatalog(task, "activity", { tags: [], indoorOnly: false }),
  food: searchCatalog(task, "meal", { tags: [], indoorOnly: false }),
};
const plan = () => offlinePlan(task, evidence);

test("task validation rejects invalid constraints and isolates caller data", () => {
  for (const input of [
    { days: 6 },
    { rainDay: 4 },
    { budget: -1 },
    { interests: ["invented"] },
    { closed: ["unknown"] },
    { vegetarian: "yes" },
  ])
    assert.throws(() => parseTask(input));
  const source = { interests: ["art"] };
  const parsed = parseTask(source);
  parsed.interests.push("culture");
  assert.deepEqual(source.interests, ["art"]);
});
test("independent evaluator detects grounding, closures, diet, rain, repetition and budget failures", () => {
  assert.equal(evaluatePlan(plan(), task).passed, true);
  const bad = plan();
  bad.days[0].activities[0] = "invented";
  assert.equal(evaluatePlan(bad, task).checks[0].passed, false);
  assert.equal(evaluatePlan(plan(), task, []).passed, false);
  const closed = plan().days[0].activities[0];
  assert.equal(
    evaluatePlan(plan(), { ...task, closed: [closed] }).checks[1].passed,
    false,
  );
  const meat = plan();
  meat.days[0].meal = "asakusa-grill";
  assert.equal(evaluatePlan(meat, task).checks[2].passed, false);
  const wet = plan();
  wet.days[0].activities[0] = "asakusa-walk";
  assert.equal(
    evaluatePlan(wet, { ...task, rainDay: 1 }).checks[3].passed,
    false,
  );
  const repeated = plan();
  repeated.days[1].activities[0] = repeated.days[0].activities[0];
  assert.equal(evaluatePlan(repeated, task).checks[4].passed, false);
  assert.equal(
    evaluatePlan(plan(), { ...task, budget: 1000 }).checks.at(-1).passed,
    false,
  );
  assert.equal(evaluatePlan({ days: [] }, task).passed, false);
});
test("offline comparisons satisfy changed conditions with equal isolated plans and no API calls", async () => {
  for (const changes of [
    {},
    { rainDay: 2 },
    { closed: ["digital-gallery"] },
    { days: 5, rainDay: 5, budget: 60000 },
  ]) {
    const results = await compare({
      task: { ...task, ...changes },
      demoDelay: 0,
      providerFactory: () => {
        return {
          choose() {
            throw Error("Unexpected API");
          },
          generate() {
            throw Error("Unexpected API");
          },
        };
      },
    });
    assert.ok(
      results.every((r) => r.status === "completed" && r.review.passed),
    );
    assert.deepEqual(results[0].plan, results[1].plan);
    assert.notEqual(results[0].plan, results[1].plan);
    assert.equal(results[0].metrics.modelCalls, 0);
    assert.equal(results[0].metrics.decisionMs, null);
  }
});
test("infeasible budgets cannot be reported as successful", async () => {
  const results = await compare({
    task: { ...task, budget: 1000 },
    demoDelay: 0,
  });
  assert.ok(
    results.every((r) => r.status === "needs_input" && !r.review.passed),
  );
});
test("premature completion is rejected and execution is bounded", async () => {
  const r = await runTeam({
    team: "hybrid",
    task,
    mode: "live",
    config: { ...config, live: true },
    providerFactory: () => ({
      choose: async (_provider, state) => ({
        choice: state.selectedAgent ? "search_places" : "finish",
      }),
      generate: async () => ({ tags: [], indoorOnly: false }),
      search: async (searchTask, kind, args) => ({ places: searchCatalog(searchTask, kind, args), sources: [], queries: [] }),
    }),
  });
  assert.equal(r.status, "error");
  assert.match(r.error, /Agent is not available/);
  assert.equal(r.metrics.steps, 3);
});
test("both live coordinators must research activities and meals before planning", async () => {
  const { demoDecision } = await import("../src/engine.js");
  const selections = { baseline: [], hybrid: [] };
  const results = await compare({
    task,
    mode: "live",
    config: { ...config, live: true },
    providerFactory: ({ onCall }) => ({
      async choose(provider, state, criteria) {
        const isAgent = state.selectedAgent === null;
        const team = provider === "jev" ? "hybrid" : "baseline";
        selections[team].push({
          kind: isAgent ? "agent" : "tool",
          options: Object.keys(criteria),
          hasPlaces: Boolean(state.evidence.places?.length),
          hasFood: Boolean(state.evidence.food?.length),
        });
        onCall({ provider, stage: "coordination", inputTokens: 0, outputTokens: 0, estimatedUsd: null });
        return {
          choice: demoDecision(state, isAgent ? "agent" : "tool", state.selectedAgent),
        };
      },
      async generate(_instructions, state, schema) {
        if (schema.properties.tags) return { tags: [], indoorOnly: false };
        if (schema.properties.days) return offlinePlan(state.task, state.evidence);
        return { satisfied: state.checks.passed, feedback: "Mocked review" };
      },
      async search(searchTask, kind, args) {
        return { places: searchCatalog(searchTask, kind, args), sources: [], queries: [] };
      },
    }),
  });
  for (const result of results) {
    assert.equal(result.status, "completed");
    assert.equal(result.orchestration, "langgraph");
    assert.equal(result.metrics.toolCalls, 4);
    assert.equal(result.trace.filter((e) => e.type === "validation_error").length, 0);
    assert.deepEqual(
      result.trace.filter((e) => e.type === "tool_start").map((e) => e.tool),
      ["search_places", "search_food", "draft_itinerary", "review_itinerary"],
    );
    for (const selection of selections[result.team]) {
      if (!selection.hasPlaces || !selection.hasFood) {
        assert.ok(!selection.options.includes("planner"));
        assert.ok(!selection.options.includes("draft_itinerary"));
      }
    }
  }
  assert.deepEqual(Object.keys(availableAgents({ evidence: {}, plan: null, review: null })), ["researcher"]);
  assert.deepEqual(Object.keys(availableTools({ evidence: {} }, "researcher")), ["search_places", "search_food"]);
  assert.deepEqual(Object.keys(availableTools({ evidence: { places: evidence.places } }, "researcher")), ["search_food"]);
});
test("graph retains a partial itinerary when later coordination fails", async () => {
  const { demoDecision } = await import("../src/engine.js");
  const result = await runTeam({
    team: "hybrid",
    task,
    mode: "live",
    config: { ...config, live: true },
    providerFactory: () => ({
      async choose(_provider, state) {
        if (state.plan && !state.review && state.selectedAgent === null)
          throw new Error("Coordinator unavailable");
        return {
          choice: demoDecision(
            state,
            state.selectedAgent === null ? "agent" : "tool",
            state.selectedAgent,
          ),
        };
      },
      async generate(_instructions, state, schema) {
        if (schema.properties.tags) return { tags: [], indoorOnly: false };
        return offlinePlan(state.task, state.evidence);
      },
      async search(searchTask, kind, args) {
        return { places: searchCatalog(searchTask, kind, args), sources: [], queries: [] };
      },
    }),
  });
  assert.equal(result.status, "error");
  assert.match(result.error, /Coordinator unavailable/);
  assert.equal(result.plan.days.length, task.days);
  assert.equal(result.review, null);
});
test("invalid agent tools and cancellation never produce a successful run", async () => {
  let n = 0;
  const r = await runTeam({
    team: "baseline",
    task,
    mode: "live",
    config: { ...config, live: true },
    providerFactory: () => ({
      choose: async () => ({ choice: n++ ? "draft_itinerary" : "researcher" }),
    }),
  });
  assert.equal(r.status, "error");
  assert.match(r.error, /not available/);
  const controller = new AbortController();
  controller.abort();
  const stopped = await runTeam({
    team: "baseline",
    task,
    signal: controller.signal,
    demoDelay: 0,
  });
  assert.equal(stopped.status, "cancelled");
});
test("provider adapters send structured choices and account for Gemini reasoning tokens", async () => {
  const calls = [],
    requests = [];
  const cfg = configuration({
    GEMINI_API_KEY: "test-google",
    TYPESAFE_API_KEY: "test-jev",
    ENABLE_LIVE: "true",
    GEMINI_INPUT_USD_PER_MILLION: "1",
    GEMINI_OUTPUT_USD_PER_MILLION: "2",
  });
  const p = createProvider({
    config: cfg,
    onCall: (c) => calls.push(c),
    fetchFn: async (url, options) => {
      requests.push({ url, ...options, body: JSON.parse(options.body) });
      return new Response(
        JSON.stringify(
          url.includes("googleapis")
            ? {
                candidates: [
                  { content: { parts: [{ text: '{"choice":"researcher"}' }] } },
                ],
                usageMetadata: {
                  promptTokenCount: 100,
                  candidatesTokenCount: 5,
                  thoughtsTokenCount: 10,
                },
              }
            : {
                answers: {
                  selection: {
                    choice: "researcher",
                    confidence: 0.8,
                    probabilities: { researcher: 0.8, finish: 0.2 },
                  },
                },
                usage: { input_tokens: 20, output_tokens: 1 },
              },
        ),
      );
    },
  });
  const choices = { researcher: "Research", finish: "Finish" };
  assert.equal((await p.choose("gemini", {}, choices)).choice, "researcher");
  assert.equal((await p.choose("jev", {}, choices)).confidence, 0.8);
  assert.deepEqual(
    requests[0].body.generationConfig.responseJsonSchema.properties.choice.enum,
    Object.keys(choices),
  );
  assert.equal(requests[0].headers["x-goog-api-key"], "test-google");
  assert.equal(requests[1].body.questions.selection.type, "choice");
  assert.deepEqual(requests[1].body.questions.selection.criteria, choices);
  assert.deepEqual(calls[0].request,requests[0].body);
  assert.equal(calls[0].response.candidates[0].content.parts[0].text,'{"choice":"researcher"}');
  assert.ok(calls[0].callId);
  assert.ok(!JSON.stringify(calls).includes("test-google"));
  assert.equal(calls[0].outputTokens, 15);
  assert.equal(calls[0].estimatedUsd, 0.00013);
  assert.equal(calls[1].estimatedUsd, null);
});
test("provider failures are explicit, sanitized and never silently replaced with fixture data", async () => {
  const p = createProvider({
    config,
    fetchFn: async () => new Response("SECRET UPSTREAM BODY", { status: 429 }),
  });
  await assert.rejects(
    () => p.choose("jev", {}, { researcher: "Research" }),
    /HTTP 429/,
  );
  const invalid = createProvider({
    config,
    fetchFn: async () =>
      new Response(
        JSON.stringify({
          answers: { selection: { choice: "invented", confidence: 1 } },
        }),
      ),
  });
  await assert.rejects(
    () => invalid.choose("jev", {}, { researcher: "Research" }),
    /invalid selection/,
  );
  const malformed = createProvider({
    config,
    fetchFn: async () =>
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "not json" }] } }],
        }),
      ),
  });
  await assert.rejects(() => malformed.generate("", {}, {}), /malformed/);
});
test("live search uses Gemini grounding, records sources, and never falls back to fixtures", async () => {
  const requests = [];
  const calls = [];
  const provider = createProvider({
    config,
    onCall: (call) => { calls.push(call); },
    fetchFn: async (_url, options) => {
      const body = JSON.parse(String(options.body));
      requests.push(body);
      return Response.json(requests.length === 1
        ? {
            candidates: [{
              content: { parts: [{ text: "Amber Fort in Jaipur is a historic activity." }] },
              groundingMetadata: {
                webSearchQueries: ["Amber Fort Jaipur"],
                groundingChunks: [{ web: { title: "Official tourism", uri: "https://example.org/amber-fort" } }],
              },
            }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10 },
          }
        : {
            candidates: [{ content: { parts: [{ text: JSON.stringify({ places: [{
              name: "Amber Fort", area: "Amer", indoor: false, vegetarian: false,
              price: 500, minutes: 120, tags: ["culture"], sourceIndex: 0,
            }] }) }] } }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10 },
          });
    },
  });
  const found = await provider.search(task, "activity", { tags: [], indoorOnly: false });
  assert.deepEqual(requests[0].tools, [{ google_search: {} }]);
  assert.equal(found.queries[0], "Amber Fort Jaipur");
  assert.equal(found.places[0].source.uri, "https://example.org/amber-fort");
  assert.equal(calls[0].estimatedUsd, null);
  const ungrounded = createProvider({ config, fetchFn: async () => Response.json({
    candidates: [{ content: { parts: [{ text: "An unsourced venue" }] } }],
  }) });
  await assert.rejects(() => ungrounded.search(task, "activity", { tags: [], indoorOnly: false }), /No catalog fallback/);
});
test("live trips accept new destinations and validate against researched evidence", () => {
  const trip = parseTask({ city: "Lisbon", days: 1, people: 2, budget: 4000, closed: ["Old Tower"] }, true);
  const places: Place[] = [
    { id: "a1", name: "Tile Museum", area: "Central", kind: "activity", tags: ["art"], indoor: true, price: 400, minutes: 90 },
    { id: "a2", name: "Riverside Gallery", area: "River", kind: "activity", tags: ["art"], indoor: true, price: 300, minutes: 90 },
    { id: "m1", name: "Garden Cafe", area: "Central", kind: "meal", tags: ["food"], indoor: true, vegetarian: true, price: 500, minutes: 60 },
  ];
  const plan = { title: "One day", summary: "Art walk", days: [{ day: 1, activities: ["a1", "a2"], meal: "m1", note: "Relaxed" }] };
  const report = evaluatePlan(plan, trip, places.map((place) => place.id), places);
  assert.equal(report.passed, true);
  assert.equal(report.total, 2400);
  assert.match(report.scope, /transport.*excluded/);
  assert.throws(() => parseTask({ city: "Lisbon" }), /supported destination/);
});
test("HTTP app streams both results, hides keys and rejects unsafe or unconfigured requests", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "travel-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const app = createApp({
    store: createRunStore(directory),
    config: { ...config, geminiKey: "DO-NOT-EXPOSE" },
    runner: (opts) => compare({ ...opts, demoDelay: 0 }),
  });
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  const info = await (await fetch(base + "/api/config")).text();
  assert.ok(!info.includes("DO-NOT-EXPOSE"));
  const benchmark = await (await fetch(base + "/api/benchmark/routing")).json();
  assert.equal(benchmark.caseCount, 12);
  assert.equal(benchmark.summary.gemini.correct, 36);
  assert.equal(benchmark.summary.jev.correct, 36);
  assert.equal(benchmark.samples, undefined);
  const post = (body, headers = {}) =>
    fetch(base + "/api/compare", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  assert.equal(
    (await post({ task, mode: "demo" }, { Origin: "https://other.example" }))
      .status,
    403,
  );
  assert.equal((await post({ task, mode: "live" })).status, 409);
  assert.equal((await post({ task: { days: 8 }, mode: "demo" })).status, 400);
  assert.equal((await fetch(base + "/.env")).status, 404);
  const response = await post({ task, mode: "demo" });
  assert.equal(response.status, 200);
  const sessionCookie = response.headers.get("set-cookie").split(";", 1)[0];
  const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events.filter((e) => e.type === "result").length, 2);
  assert.equal(events.at(-1).type, "done");
  const history = await (
    await fetch(base + "/api/runs", { headers: { Cookie: sessionCookie } })
  ).json();
  assert.equal(history.length, 1);
  const otherHistory = await (await fetch(base + "/api/runs")).json();
  assert.equal(otherHistory.length, 0);
  assert.equal((await fetch(base + "/api/runs/" + history[0].id)).status, 404);
  const saved = await (
    await fetch(base + "/api/runs/" + history[0].id, {
      headers: { Cookie: sessionCookie },
    })
  ).json();
  assert.equal(saved.status, "completed");
  assert.equal(saved.results.length, 2);
  assert.ok(saved.events.some((e) => e.type === "tool_end"));
});

test("live engine routes only coordination to Jev while both teams use shared worker contracts", async () => {
  const { demoDecision } = await import("../src/engine.js");
  const selected = [];
  const factory = () => ({
    async choose(provider, state, criteria) {
      selected.push(provider);
      return {
        choice: demoDecision(
          state,
          state.selectedAgent === null ? "agent" : "tool",
          state.selectedAgent,
        ),
      };
    },
    async generate(instructions, state, schema) {
      if (schema.properties.tags) return { tags: [], indoorOnly: false };
      if (schema.properties.days)
        return offlinePlan(state.task, state.evidence);
      return {
        satisfied: state.checks.passed,
        feedback: "Mocked specialist review",
      };
    },
    async search(searchTask, kind, args) {
      return { places: searchCatalog(searchTask, kind, args), sources: [], queries: [] };
    },
  });
  const runs = await compare({
    task,
    mode: "live",
    config: { ...config, live: true },
    providerFactory: factory,
  });
  assert.ok(runs.every((r) => r.status === "completed" && r.review.passed));
  assert.equal(selected.filter((p) => p === "gemini").length, 3);
  assert.equal(selected.filter((p) => p === "jev").length, 3);
});

test("each destination uses its own INR catalog, closures and transit costs", async () => {
  const { catalogs } = await import("../src/domain.js");
  for (const [city, data] of Object.entries(catalogs)) {
    assert.equal(data.currency, "INR");
    const closed = data.places.find((p) => p.kind === "activity").id;
    const [run] = await compare({
      task: { city, closed: [closed], rainDay: 2, budget: 30000 },
      demoDelay: 0,
    });
    assert.equal(run.status, "completed", city);
    assert.equal(run.dataset, data.version);
    const ids = new Set(data.places.map((p) => p.id));
    for (const day of run.plan.days) {
      assert.ok(
        [...day.activities, day.meal].every(
          (id) => ids.has(id) && id !== closed,
        ),
      );
    }
    const expected = run.review.days.reduce(
      (sum, day) =>
        sum +
        day.stops.reduce((n, p) => n + p.price * run.task.people, 0) +
        data.transitPerPersonPerDay * run.task.people,
      0,
    );
    assert.equal(run.review.total, expected);
  }
  assert.throws(
    () => parseTask({ city: "Goa", closed: ["asakusa-walk"] }),
    /Unknown closure/,
  );
  assert.throws(() => parseTask({ city: "Unknown" }), /supported destination/);
});

test("run journal survives reopening, retains failures and marks incomplete runs interrupted", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "travel-journal-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = createRunStore(directory),
    r = store.create({ task, mode: "demo" });
  store.append(r.id, { type: "tool_start", input: { city: "Tokyo" } });
  store.append(r.id, { type: "tool_end", ms: 12, error: "tool failed" });
  const reopened = createRunStore(directory, { recover: true }),
    saved = reopened.get(r.id);
  assert.equal(saved.status, "interrupted");
  assert.equal(saved.events.length, 2);
  assert.equal(saved.events[1].ms, 12);
  const finished = reopened.create({ task, mode: "demo" });
  reopened.finish(finished.id, "cancelled");
  assert.equal(createRunStore(directory).get(finished.id).status, "cancelled");
  assert.throws(() => store.get("../../.env"));
  assert.deepEqual(
    redact({ text: "credential: sample-secret" }, ["sample-secret"]),
    { text: "credential: [REDACTED]" },
  );
});

test("tool trace snapshots preserve inputs, complete outputs and durations", async () => {
  const [run] = await compare({ task, mode: "demo", demoDelay: 0 });
  const start = run.trace.find((e) => e.type === "tool_start");
  assert.deepEqual(start.input.evidence, {});
  const search = run.trace.find(
    (e) => e.type === "tool" && e.tool === "search_places",
  );
  assert.ok(search.response[0].name);
  const end = run.trace.find((e) => e.type === "tool_end");
  assert.ok(end.ms >= 0);
  assert.ok(Array.isArray(end.output));
  assert.ok(end.timestamp);
});

test("disconnect cancels the run while preserving its partial journal", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "travel-stop-"));
  const store = createRunStore(directory);
  const app = createApp({
    config,
    store,
    runner: async ({ signal, emit }) => {
      emit({ type: "start", team: "baseline", atMs: 0 });
      await new Promise((resolve) =>
        signal.addEventListener("abort", resolve, { once: true }),
      );
      return [];
    },
  });
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  t.after(async () => {
    await new Promise((resolve) => app.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  const controller = new AbortController();
  const response = await fetch(
    `http://127.0.0.1:${(app.address() as AddressInfo).port}/api/compare`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task, mode: "demo" }),
      signal: controller.signal,
    },
  );
  await response.body.getReader().read();
  controller.abort();
  for (let i = 0; i < 50 && store.list()[0].status === "running"; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  const saved = store.get(store.list()[0].id);
  assert.equal(saved.status, "cancelled");
  assert.equal(saved.events[0].type, "start");
});
