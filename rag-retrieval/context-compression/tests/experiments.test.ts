import { test } from "node:test";
import assert from "node:assert/strict";
import { blindJudge, parseExperiment, runExperiment, type ExperimentRequest } from "../src/experiments.ts";
import { defaults, compress } from "../src/compress.ts";
import { scenarios, formatPassages } from "../src/fixtures.ts";
import { fixtureGenerator, geminiGenerator, type Generator, type ModelCall, type ModelReply } from "../src/generation.ts";
import { runBackend, type BackendConfig } from "../src/backends.ts";
import { layaEndpoint } from "../src/laya.ts";
const backend: BackendConfig = { enableLocal: false, python: "/must-never-run" };
const configured = { key: "test-only-key", answerModel: "configured-answer", judgeModel: "configured-judge" };
const req = (patch: Partial<ExperimentRequest> = {}): ExperimentRequest => ({ mode: "fixture", kind: "paired", source: formatPassages(scenarios[0].passages), scenarioId: "document",
  options: { ...defaults, query: scenarios[0].questions[0].text }, allowPaid: false, failOpen: false, judge: true, maxSteps: 4, ...patch });
const reply = (value: unknown): ModelReply => ({ value, model: "MOCK-NOT-INFERENCE", durationMs: 0, usage: { inputTokens: null, outputTokens: null, totalTokens: null } });

test("paired workflow launches both identical-settings answer calls before either resolves", async () => {
  const calls: ModelCall[] = []; const releases: (() => void)[] = [];
  const generator: Generator = (call) => {
    calls.push(call);
    if (call.kind === "judge") return Promise.resolve(reply({ verdict: "uncertain", reason: "Mock judge" }));
    return new Promise((resolve) => releases.push(() => resolve(reply({ answer: "Mock answer", citations: [] }))));
  };
  const running = runExperiment(req(), backend, {}, { generate: generator });
  // Let the compression-preparation await complete; no time-based sleeps needed.
  await Promise.resolve(); await Promise.resolve();
  assert.equal(releases.length, 2);
  assert.equal(calls[0].model, calls[1].model); assert.equal(calls[0].system, calls[1].system);
  assert.equal(calls[0].payload.question, calls[1].payload.question);
  assert.notEqual(calls[0].payload.context, calls[1].payload.context);
  releases.forEach((release) => release());
  const result = await running;
  assert.equal(result.full.status, "complete"); assert.equal(result.compressed.status, "complete");
  assert.equal(result.maxGenerationCalls, 3); assert.equal(result.judge.verdict, "uncertain");
});

test("blind judge receives no method/left-right metadata; random order maps back correctly", async () => {
  for (const flip of [0, 1] as const) {
    const generator: Generator = async (call) => {
      assert.deepEqual(Object.keys(call.payload).sort(), ["answers", "question", "source"]);
      assert.equal(call.kind, "judge");
      const answers = call.payload.answers as { A: string; B: string };
      assert.equal(answers.A, flip ? "SHORT ANSWER" : "FULL ANSWER");
      return reply({ verdict: "A_better", reason: "Mock evidence reasoning" });
    };
    const result = await blindJudge("Question", "Source", "FULL ANSWER", "SHORT ANSWER", generator, "judge", flip);
    assert.equal(result.verdict, flip ? "compressed-better" : "full-better");
  }
});

test("one failed answer preserves the other lane and skips judge", async () => {
  let answers = 0; let judges = 0;
  const result = await runExperiment(req(), backend, {}, { generate: async (call) => {
    if (call.kind === "judge") { judges++; throw new Error("Must not judge"); }
    if (++answers === 1) throw new Error("Mock timeout");
    return reply({ answer: "Other answer survives", citations: [] });
  } });
  assert.equal(result.full.status, "failed"); assert.equal(result.compressed.status, "complete");
  assert.equal(result.full.failedCalls, 1); assert.equal(result.judge.status, "skipped"); assert.equal(judges, 0);
});

test("malformed judge output fails explicitly and preserves returned usage record", async () => {
  const result = await blindJudge("q", "s", "a", "b", async () => reply({ verdict: "equivalent", reason: "" }), "judge", 0);
  assert.equal(result.status, "failed"); assert.ok(result.call);
});

test("live configuration, paid-consent and local-model gates precede all generation", async () => {
  let calls = 0; const generate: Generator = async () => { calls++; return reply({}); };
  await assert.rejects(runExperiment(req({ mode: "live" }), backend, configured, { generate }), /consent/);
  await assert.rejects(runExperiment(req({ mode: "live", allowPaid: true }), backend, {}, { generate }), /Configure/);
  await assert.rejects(runExperiment(req({ mode: "live", allowPaid: true, options: { ...defaults, query: "refund", method: "semantic" } }), backend, configured, { generate }), /disabled/);
  await assert.rejects(runExperiment(req({ options: { ...defaults, query: "refund", method: "semantic" } }), backend, {}, { generate }), /never execute/);
  assert.equal(calls, 0);
});

test("scripted paired and complete multi-step workflow remain explicitly NOT LLM results", async () => {
  for (const kind of ["paired", "agent"] as const) {
    const result = await runExperiment(req({ kind }), backend, {});
    assert.match(result.disclaimer, /Scripted/);
    assert.equal(result.full.status, "complete"); assert.equal(result.compressed.status, "complete");
    assert.ok(result.full.calls.every((call) => call.model === "scripted-fixture-NOT-AN-LLM"));
    if (kind === "agent") {
      assert.equal(result.full.steps.length, 2); assert.equal(result.compressed.steps.length, 2);
      assert.ok(result.compressed.steps.every((step) => step.compression));
      assert.equal(result.full.steps[0].raw, result.full.steps[0].seen);
      assert.ok(result.compressed.steps[0].keptTokens < result.compressed.steps[0].originalTokens);
    }
  }
});

test("agent tool focus reaches the compressor and each lane can choose a different next action", async () => {
  const focuses: string[] = [];
  const generate: Generator = async (call) => {
    const history = call.payload.history as { text: string }[];
    if (!history.length) return reply({ action: "read", id: "refunds", focus: "Read the export exception", query: "", answer: "", citations: [] });
    // Uncompressed tool text includes the ordinary policy; fake compressed read does not.
    if (history.length === 1 && history[0].text.includes("Annual subscriptions qualify")) return reply({ action: "read", id: "cancel", focus: "Check cancellation separately", query: "", answer: "", citations: [] });
    return reply({ action: "finish", answer: "Mock grounded answer", citations: ["refunds"] });
  };
  const result = await runExperiment(req({ kind: "agent", judge: false }), backend, {}, { generate, compress: async (source, options) => {
    focuses.push(options.focus!); assert.equal(options.query, req().options.query);
    const output = compress(source, { ...options, remove: 0 }); output.text = "Mock shortened exception only"; return output;
  } });
  assert.equal(result.full.steps.length, 2); assert.equal(result.compressed.steps.length, 1);
  assert.deepEqual(focuses, ["Read the export exception"]);
});

test("step limit stops agents without inventing a final answer or judge equivalence", async () => {
  const result = await runExperiment(req({ kind: "agent", maxSteps: 1 }), backend, {});
  assert.equal(result.full.status, "step-limit"); assert.equal(result.compressed.status, "step-limit");
  assert.equal(result.full.answer, undefined); assert.equal(result.judge.status, "skipped");
  assert.equal(result.full.calls.length, 1);
});

test("unknown tools/source IDs and unread citations cannot trigger arbitrary side effects", async () => {
  for (const value of [{ action: "run_command", command: "evil" }, { action: "read", id: "https://example.com", focus: "look" }, { action: "finish", answer: "Bad citation", citations: ["unread"] }]) {
    const result = await runExperiment(req({ kind: "agent" }), backend, {}, { generate: async () => reply(value) });
    assert.equal(result.full.status, "failed"); assert.equal(result.compressed.status, "failed");
    assert.equal(result.judge.status, "skipped");
  }
});

test("request bounds reject unbounded loops, unknown corpus, oversized source and invalid flags", () => {
  for (const patch of [{ maxSteps: 5 }, { maxSteps: 0 }, { maxSteps: NaN }, { source: "x".repeat(12001) }, { kind: "agent", scenarioId: "missing" }, { judge: "yes" }]) {
    assert.throws(() => parseExperiment({ ...req(), ...patch }));
  }
});

test("Gemini REST integration is MOCKED, same configured controls and missing usage stays unknown", async () => {
  let calls = 0;
  const generator = geminiGenerator(configured, (async (url, init) => {
    calls++; assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/models/configured-answer:generateContent");
    const body = JSON.parse(init!.body as string);
    assert.equal(body.generationConfig.temperature, 0); assert.equal(body.generationConfig.maxOutputTokens, 1024);
    assert.equal(body.generationConfig.responseMimeType, "application/json"); assert.ok(body.generationConfig.responseJsonSchema);
    assert.equal(String(url).includes("test-only-key"), false);
    return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: '{"answer":"Mock","citations":[]}' }] } }] });
  }) as typeof fetch);
  const result = await generator({ kind: "answer", model: "configured-answer", system: "same", payload: { context: "data" }, schema: {} });
  assert.equal(calls, 1); assert.equal(result.usage.totalTokens, null);
});

test("Laya uses one state per unit, validates probabilities, and does not invent source text", async () => {
  const source = "## Evidence\n\nRefunds allowed.\n\nExports excluded.\n\nUnrelated gardening.";
  const config = { ...backend, laya: { enabled: true, baseUrl: "https://laya.example/", key: "test-key" } };
  const result = await runBackend({ source, options: { ...defaults, threshold: 0, query: "refund after export", method: "laya", remove: 30 }, allowPaid: true, failOpen: false }, config, { fetch: (async (url, init) => {
    assert.equal(url, "https://laya.example/v1/systemone/batch");
    const body = JSON.parse(init!.body as string);
    assert.equal(body.states.length, 3); assert.equal(body.questions.relevance.type, "noul");
    assert.ok(body.states[0].passage.includes("## Evidence"));
    return Response.json({ results: [0.8, 0.95, 0.01].map((noul) => ({ answers: { relevance: { noul } }, usage: { truncated: false } })) });
  }) as typeof fetch });
  assert.equal(result.segments.map((s) => s.text).join(""), source);
  assert.ok(result.compressedTokens <= result.budget); assert.match(result.reason, /Public Laya/);
});

test("Laya cannot target a laptop service, and rejects truncated scoring", async () => {
  for (const baseUrl of ["http://localhost:8000/", "https://127.0.0.1/", "https://[::1]/", "https://machine.local/", "https://user:pass@host.example/"]) assert.throws(() => layaEndpoint({ enabled: true, baseUrl }));
  await assert.rejects(runBackend({ source: req().source, options: { ...req().options, method: "laya" }, allowPaid: true, failOpen: false }, { ...backend, laya: { enabled: true, baseUrl: "https://laya.example/" } }, { fetch: (async (_url, init) => {
    const { states } = JSON.parse(init!.body as string);
    return Response.json({ results: states.map(() => ({ answers: { relevance: { noul: 0.8 } }, usage: { truncated: true } })) });
  }) as typeof fetch }), /truncated/);
});

test("reference perplexity adapters use MOCKED local output, report absent offsets, and honor the gate", async () => {
  for (const method of ["llmlingua", "longllmlingua"] as const) {
    const request = { source: req().source, options: { ...req().options, method, queryAware: method === "longllmlingua" }, allowPaid: false, failOpen: false };
    let calls = 0;
    const local = async (payload: object) => { calls++; assert.equal((payload as { method: string }).method, method); return { text: "Mock reference output", model: "MOCK-PHI2-NOT-LOADED" }; };
    await assert.rejects(runBackend(request, backend, { local }), /disabled/); assert.equal(calls, 0);
    const result = await runBackend(request, { ...backend, enableLocal: true }, { local });
    assert.equal(calls, 1); assert.equal(result.alignment, "unavailable"); assert.equal(result.backend?.method, method);
    assert.match(result.reason, /perplexity/);
  }
});
