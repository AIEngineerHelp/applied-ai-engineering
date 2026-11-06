import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";
import {
  compress,
  defaults,
  splitUnits,
  wordUnits,
  jaccard,
  type Options,
} from "../src/compress.ts";
import {
  capabilities,
  parseRequest,
  runBackend,
  type BackendConfig,
  type BackendRequest,
} from "../src/backends.ts";
import { semanticScoring, scoredUnits } from "../src/model-results.ts";
import { createAppServer } from "../src/server.ts";
const source =
  "## Notes\n\nAnnual refunds are available.\n\nNo refunds after export.\n\nGardening is fun.";
const config: BackendConfig = { enableLocal: false, python: "/must-not-execute" };
const request = (method: Options["method"], patch: Partial<Options> = {}): BackendRequest => ({
  source,
  options: { ...defaults, query: "refunds", threshold: 0, method, ...patch },
  allowPaid: false,
  failOpen: false,
});

test("local model gate rejects before invoking any runner, including fail-open", async () => {
  let calls = 0;
  for (const method of ["semantic", "llmlingua2"] as const) {
    await assert.rejects(
      runBackend({ ...request(method), failOpen: true }, config, {
        local: async () => {
          calls++;
          return {};
        },
      }),
      /disabled/,
    );
  }
  assert.equal(calls, 0);
  assert.equal(capabilities(config).localModelsEnabled, false);
});

test("paid and configuration gates reject before fetch, including fail-open", async () => {
  let calls = 0;
  const fetchMock = (async () => {
    calls++;
    return new Response();
  }) as typeof fetch;
  await assert.rejects(runBackend(request("compresr"), config, { fetch: fetchMock }), /API_KEY/);
  await assert.rejects(
    runBackend(
      { ...request("compresr"), failOpen: true },
      { ...config, apiKey: "test-key" },
      { fetch: fetchMock },
    ),
    /consent/,
  );
  assert.equal(calls, 0);
});

test("Compresr adapter maps fixed removal, focus and fine mode without exposing a key", async () => {
  const response = await runBackend(
    { ...request("compresr", { focus: "exceptions", remove: 40 }), allowPaid: true },
    { ...config, apiKey: "test-key" },
    {
      fetch: (async (url, init) => {
        assert.equal(url, "https://api.compresr.ai/api/compress/question-specific/");
        const payload = JSON.parse(init!.body as string);
        assert.equal(payload.target_compression_ratio, 0.4);
        assert.equal(payload.coarse, false);
        assert.equal(payload.disable_placeholders, true);
        assert.match(payload.query, /exceptions/);
        return Response.json({ data: { compressed_context: "No refunds after export." } });
      }) as typeof fetch,
    },
  );
  assert.equal(response.text, "No refunds after export.");
  assert.equal(response.alignment, "unavailable");
  assert.equal(response.spans.length, 0);
  assert.equal(JSON.stringify(response).includes("test-key"), false);
});

test("dynamic API parameters are multipliers and fixed removal is omitted", async () => {
  await runBackend(
    {
      ...request("compresr", {
        dynamic: true,
        minFactor: 2,
        maxFactor: 5,
        granularity: "paragraph",
      }),
      allowPaid: true,
    },
    { ...config, apiKey: "test-key" },
    {
      fetch: (async (_url, init) => {
        const body = JSON.parse(init!.body as string);
        assert.equal(body.dynamic_min_ratio, 2);
        assert.equal(body.dynamic_max_ratio, 5);
        assert.equal(body.target_compression_ratio, undefined);
        assert.equal(body.coarse, true);
        return Response.json({ data: { compressed_context: "Refunds." } });
      }) as typeof fetch,
    },
  );
});

test("runtime failures are explicit or return accurately labeled raw fallback", async () => {
  const unavailable = (async () => new Response("unavailable", { status: 503 })) as typeof fetch;
  const req = { ...request("compresr"), allowPaid: true };
  await assert.rejects(
    runBackend(req, { ...config, apiKey: "test-key" }, { fetch: unavailable }),
    /503/,
  );
  const result = await runBackend(
    { ...req, failOpen: true },
    { ...config, apiKey: "test-key" },
    { fetch: unavailable },
  );
  assert.equal(result.text, source);
  assert.equal(result.removed, 0);
  assert.equal(result.backend?.fallback, true);
  assert.match(result.reason, /failed/);
});

test("small inputs pass through without network or local inference", async () => {
  let calls = 0;
  const result = await runBackend(
    request("semantic", { threshold: 1000 }),
    { ...config, enableLocal: true },
    {
      local: async () => {
        calls++;
        return {};
      },
    },
  );
  assert.equal(calls, 0);
  assert.equal(result.text, source);
});

test("semantic adapter consumes MOCKED scores while preserving original headings and budgets", async () => {
  const result = await runBackend(
    request("semantic", { remove: 30 }),
    { ...config, enableLocal: true },
    {
      local: async (payload) => {
        assert.ok(
          (payload as { units: string[] }).units.every((unit) => unit.includes("## Notes")),
        );
        return { model: "MOCK-bge-NOT-INFERENCE", scores: [0.1, 0.95, 0.05] };
      },
    },
  );
  assert.match(result.text, /No refunds after export/);
  assert.match(result.text, /## Notes/);
  assert.ok(result.compressedTokens <= result.budget);
  assert.equal(result.backend?.model, "MOCK-bge-NOT-INFERENCE");
});

test("token classifier adapter consumes MOCKED word scores, ignores question and keeps exact offsets", async () => {
  const units = wordUnits(source).map((u) => ({
    start: u.start,
    end: u.end,
    score: /refund|export|No/.test(u.text) ? 0.99 : 0.01,
  }));
  const result = await runBackend(
    request("llmlingua2", { queryAware: false }),
    { ...config, enableLocal: true },
    { local: async () => ({ model: "MOCK-llmlingua2-NOT-INFERENCE", units }) },
  );
  assert.ok(result.compressedTokens <= result.budget);
  assert.equal(result.segments.map((s) => s.text).join(""), source);
  assert.match(result.reason, /not the full reference/i);
});

test("malformed model scores cannot fabricate source offsets or evidence", () => {
  assert.throws(() => scoredUnits(source, [{ start: -1, end: 4, score: 0.8 }]), /offsets/);
  assert.throws(() => scoredUnits(source, [{ start: 0, end: 4, score: NaN }]), /offsets/);
  assert.throws(
    () =>
      scoredUnits(source, [
        { start: 1, end: 8, score: 0.5 },
        { start: 2, end: 4, score: 0.9 },
      ]),
    /offsets/,
  );
  assert.throws(
    () => semanticScoring(source, splitUnits(source, "sentence"), [0.9], "mock"),
    /scores/,
  );
  assert.throws(
    () => compress(source, { ...defaults, method: "semantic" }),
    /explicitly requested/,
  );
});

test("request parsing rejects excessive input and unknown methods", () => {
  assert.throws(() => parseRequest({ source: "x".repeat(12001), options: defaults }), /12,000/);
  assert.throws(
    () => parseRequest({ source, options: { ...defaults, method: "unknown" } }),
    /Unknown/,
  );
  assert.throws(
    () => parseRequest({ source, options: { ...defaults, method: "semantic", dynamic: "yes" } }),
    /dynamic/,
  );
});

test("MMR penalizes duplicate sentences under a two-unit budget", () => {
  const text =
    "Refund policy explains annual subscriptions.\n\nRefund policy explains annual subscriptions.\n\nRefund exceptions cover archive exports.";
  const units = splitUnits(text, "paragraph").map((u, i) => ({ ...u, score: [1, 0.99, 0.7][i] }));
  const settings = {
    ...defaults,
    query: "refund",
    threshold: 0,
    remove: 32,
    granularity: "paragraph" as const,
  };
  const relevance = compress(text, settings, {
    units,
    description: "controlled relevance fixture",
  });
  const mmr = compress(
    text,
    { ...settings, method: "mmr", diversity: 0.5 },
    { units, description: "controlled relevance fixture" },
  );
  assert.ok(relevance.selected.includes(1));
  assert.ok(mmr.selected.includes(2));
  assert.ok(!mmr.selected.includes(1));
  assert.equal(jaccard("refund refunds", "refund"), 1);
});

test("word deletion remains source-aligned and inside its strict budget", () => {
  const result = compress("Refunds are not allowed after export. More unrelated prose here.", {
    ...defaults,
    method: "words",
    query: "refund export",
    threshold: 0,
    remove: 60,
  });
  assert.equal(
    result.segments.map((s) => s.text).join(""),
    "Refunds are not allowed after export. More unrelated prose here.",
  );
  assert.ok(result.compressedTokens <= result.budget);
  assert.match(result.reason, /not a learned/);
});

test("HTTP API enforces same-origin JSON and loopback Host before invoking a runner", async () => {
  let calls = 0;
  const server = createAppServer(
    fileURLToPath(new URL("../site/", import.meta.url)),
    config,
    async (req) => {
      calls++;
      return compress(req.source, { ...defaults, remove: 0 });
    },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const denied = await fetch(base + "/api/compress", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://example.com",
        "X-Compression-Lab": "1",
      },
      body: JSON.stringify(request("semantic")),
    });
    assert.equal(denied.status, 403);
    assert.equal(calls, 0);
    const caps = (await (await fetch(base + "/api/capabilities")).json()) as {
      localModelsEnabled: boolean;
    };
    assert.equal(caps.localModelsEnabled, false);
    const result = await fetch(base + "/api/compress", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base, "X-Compression-Lab": "1" },
      body: JSON.stringify(request("semantic")),
    });
    assert.equal(result.status, 200);
    assert.equal(calls, 1);
    const experiment = {
      mode: "fixture",
      kind: "agent",
      source,
      scenarioId: "document",
      options: { ...defaults, query: "refunds" },
      maxSteps: 4,
      judge: true,
    };
    const blockedExperiment = await fetch(base + "/api/experiment", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://example.com",
        "X-Compression-Lab": "1",
      },
      body: JSON.stringify(experiment),
    });
    assert.equal(blockedExperiment.status, 403);
    const workflow = await fetch(base + "/api/experiment", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base, "X-Compression-Lab": "1" },
      body: JSON.stringify(experiment),
    });
    assert.equal(workflow.status, 200);
    const trace = (await workflow.json()) as {
      mode: string;
      full: { status: string; steps: unknown[] };
      compressed: { status: string };
      disclaimer: string;
    };
    assert.equal(trace.mode, "fixture");
    assert.equal(trace.full.status, "complete");
    assert.equal(trace.compressed.status, "complete");
    assert.equal(trace.full.steps.length, 2);
    assert.match(trace.disclaimer, /Scripted/);
    assert.equal(calls, 1); // Scripted workflows never invoke the optional inference runner.
    const rebinding = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        base + "/api/capabilities",
        { headers: { Host: "attacker.example" } },
        (res) => {
          res.resume();
          resolve(res.statusCode!);
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(rebinding, 403);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
