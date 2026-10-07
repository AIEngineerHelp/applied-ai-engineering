import { test } from "node:test";
import assert from "node:assert/strict";

import { detect } from "../src/detectors.js";
import { analyze, optimize, matchKey } from "../src/analyzer.js";
import { estimateCost } from "../src/cost.js";
import { getModel, MODELS } from "../src/providers.js";
import { PRESETS } from "../src/presets.js";
import { HANDBOOK, INSTRUCTIONS } from "../src/fixture.js";

const rules = (text) => detect(text).filter((m) => m.scope !== "static").map((m) => m.rule);

test("detects values that change per request", () => {
  assert.deepEqual(rules("Current time: 2026-10-07T14:32:09Z"), ["timestamp"]);
  assert.deepEqual(rules("request_id: 9f3c2a71-5b4e-4d0a-9c1e-7a2b8d6f0e13"), ["identifier"]);
  assert.deepEqual(rules("trace id = abc123def456"), ["identifier"]);
  assert.deepEqual(rules("Turn 4 of 20"), ["counter"]);
  assert.deepEqual(rules("Tokens remaining: 18,240"), ["counter"]);
  assert.deepEqual(rules("Generated at 1791386529"), ["timestamp"]);
  assert.deepEqual(rules("The time now is 14:32:09"), ["timestamp"]);
});

test("detects per-user details", () => {
  assert.deepEqual(rules("Contact: alex.rivera@example.com"), ["personal"]);
  assert.deepEqual(rules("You are helping Alex Rivera."), ["personal"]);
  assert.deepEqual(rules("customer_id: C-1042"), ["personal"]);
  assert.deepEqual(rules("session_id: s-88412"), ["sessionId"]);
});

test("today's date changes daily, a fixed date doesn't", () => {
  assert.deepEqual(rules("Today is 7 October 2026."), ["date"]);
  assert.deepEqual(rules("Current date: 2026-10-07"), ["date"]);
  assert.deepEqual(rules("This policy is effective from 2024-01-01."), []);
  assert.deepEqual(rules("Orders placed before 12:00 Mountain Time ship today."), []);
});

test("classifies template variables by name", () => {
  const [date] = detect("Date: {{current_date}}");
  assert.equal(date.scope, "request");
  const [user] = detect("Hello {user_name}");
  assert.equal(user.scope, "user");
  const [other] = detect("Brand voice: ${brand}");
  assert.equal(other.unknown, true);
  // JSON objects aren't templates.
  assert.deepEqual(detect('{"name": "lookup_order"}'), []);
});

test("the handbook and instructions contain nothing volatile", () => {
  assert.deepEqual(rules(INSTRUCTIONS), []);
  assert.deepEqual(rules(HANDBOOK), []);
});

test("a timestamp at the top ends the shared prefix where it appears", () => {
  const blocks = [
    { id: "system", kind: "system", text: `Current time: 2026-10-07T14:32:09Z\n\n${HANDBOOK}` },
    { id: "user", kind: "user", text: "Hello" },
  ];
  const a = analyze(blocks, { minTokens: 1024 });
  assert.ok(a.sharedPrefixTokens < 10, `shared prefix ${a.sharedPrefixTokens}`);
  assert.equal(a.findings[0].rule, "timestamp");
  assert.equal(a.findings[0].severity, "high");
});

test("the same timestamp at the end costs nothing", () => {
  const blocks = [
    { id: "system", kind: "system", text: HANDBOOK },
    { id: "user", kind: "user", text: "Current time: 2026-10-07T14:32:09Z\nHello" },
  ];
  const a = analyze(blocks, { minTokens: 1024 });
  assert.equal(a.sharedPrefixTokens, a.blocks[0].tokens);
  assert.equal(a.findings.length, 0);
  assert.equal(a.score, 100);
});

test("per-user details keep a session prefix but end the shared one", () => {
  const blocks = [
    { id: "system", kind: "system", text: `You are helping Alex Rivera.\n${HANDBOOK}` },
    { id: "user", kind: "user", text: "Hello" },
  ];
  const a = analyze(blocks);
  assert.ok(a.sharedPrefixTokens < 10);
  assert.equal(a.sessionPrefixTokens, a.blocks[0].tokens);
  assert.ok(a.score < 60);
});

test("a per-request block before a stable one is reported", () => {
  const preset = PRESETS.find((p) => p.id === "question-first");
  const a = analyze(preset.blocks);
  assert.equal(a.findings[0].rule, "order");
  assert.equal(a.findings[0].severity, "high");
});

test("dismissing a finding removes it and extends the prefix", () => {
  const blocks = [
    { id: "system", kind: "system", text: `Release: 2026-10-07T00:00:00Z\n${HANDBOOK}` },
    { id: "user", kind: "user", text: "Hi" },
  ];
  const before = analyze(blocks);
  const [match] = detect(blocks[0].text);
  const after = analyze(blocks, { dismissed: [matchKey("system", match)] });
  assert.ok(before.findings.some((f) => f.rule === "timestamp"));
  assert.ok(!after.findings.some((f) => f.rule === "timestamp"));
  assert.ok(after.sharedPrefixTokens > before.sharedPrefixTokens);
});

test("tools: unsorted names are noted, changing tools are high severity", () => {
  const tools = JSON.stringify([{ name: "b" }, { name: "a" }]);
  const a = analyze([{ id: "tools", kind: "tools", text: tools, change: "session" }, { id: "u", kind: "user", text: "x" }]);
  assert.ok(a.findings.some((f) => f.rule === "tools-order" && f.severity === "info"));
  assert.ok(a.findings.some((f) => f.rule === "tools-dynamic" && f.severity === "high"));
});

test("a prefix below the model's minimum is reported and not priced as cached", () => {
  const blocks = [
    { id: "system", kind: "system", text: "Be brief." },
    { id: "user", kind: "user", text: "Hi" },
  ];
  const a = analyze(blocks, { minTokens: 1024 });
  assert.ok(a.findings.some((f) => f.rule === "below-minimum"));
  const cost = estimateCost(a, getModel("claude-haiku-4-5"));
  assert.equal(cost.withCache, cost.noCache);
});

test("optimize fixes every mistake preset except changing tools", () => {
  for (const preset of PRESETS) {
    const { blocks, changes } = optimize(preset.blocks);
    const a = analyze(blocks, { minTokens: 4096 });
    const left = a.findings.filter((f) => f.severity === "high").map((f) => f.rule);
    if (preset.id === "dynamic-tools") assert.deepEqual(left, ["tools-dynamic"]);
    else assert.deepEqual(left, [], `${preset.id}: ${left}`);
    if (preset.id === "optimized") assert.equal(changes.length, 0);
    // Tools always stay first.
    if (blocks.some((b) => b.kind === "tools")) assert.equal(blocks[0].kind, "tools");
    // The user's message stays last.
    assert.equal(blocks.at(-1).kind === "user" || blocks.at(-1).change === "request", true);
  }
});

test("optimize keeps every line of text", () => {
  const preset = PRESETS.find((p) => p.id === "agent-state");
  const { blocks } = optimize(preset.blocks);
  const words = (bs) => bs.flatMap((b) => b.text.split(/\s+/)).filter(Boolean).sort();
  assert.deepEqual(words(blocks), words(preset.blocks));
});

test("cost: a warm shared prefix is written once and read 999 times", () => {
  const model = { input: 1, read: 0.1, write: 1.25, minTokens: 1000, ttlMinutes: 5 };
  const analysis = { totalTokens: 11000, sharedPrefixTokens: 10000, sessionPrefixTokens: 10000 };
  const c = estimateCost(analysis, model, { requestsPerHour: 600 });
  assert.equal(c.tokens.sharedWrite, 10000);
  assert.equal(c.tokens.sharedRead, 10000 * 999);
  // 10k written at 1.25, 9.99M read at 0.1, 1M full price: (12500 + 999000 + 1000000) / 1e6
  assert.ok(Math.abs(c.withCache - 2.0115) < 1e-9);
  assert.ok(Math.abs(c.noCache - 11) < 1e-9);
});

test("cost: traffic slower than the cache lifetime never hits", () => {
  const model = { input: 1, read: 0.1, write: 1.25, minTokens: 1000, ttlMinutes: 5 };
  const analysis = { totalTokens: 11000, sharedPrefixTokens: 10000, sessionPrefixTokens: 10000 };
  const c = estimateCost(analysis, model, { requestsPerHour: 6 });
  assert.equal(c.warm, false);
  assert.equal(c.tokens.sharedRead, 0);
  assert.ok(c.withCache > c.noCache, "write premium makes it more expensive");
});

test("every model has a full price table", () => {
  for (const m of MODELS) {
    for (const key of ["input", "read", "write", "minTokens", "ttlMinutes"]) assert.equal(typeof m[key], "number", `${m.id}.${key}`);
    assert.ok(m.read < m.input && m.write >= m.input, m.id);
  }
});
