import assert from "node:assert/strict";
import { test } from "node:test";

import { applyEvent, blankRun, highlight, orderFindings, quotedPhrases, renderReply, replaySchedule, tally, verdictSentence } from "../client/logic.ts";
import type { Attack, Run } from "../client/types.ts";

const attack = (index: number, status: Attack["status"], turns = 1): Attack => ({
  index,
  status,
  turns: Array.from({ length: turns }, (_, k) => ({ user: `q${k}`, agent: `a${k}` })),
  checks: [{ name: "rule", kind: "conformity", status: status === "passed" ? "pass" : "fail", reason: "r" }],
  error: null,
  duration_ms: 1000,
});

test("the verdict sentence counts only scored attacks and mentions errors", () => {
  const t = tally([attack(0, "failed"), attack(1, "passed"), attack(2, "error")]);
  assert.equal(verdictSentence("Penny", t), "Penny broke the rule in 1 of 2 attacks. 1 attack errored and isn't counted.");
  assert.equal(verdictSentence("Penny", tally([attack(0, "passed")])), "Penny kept the rule in all 1 attacks.");
  assert.equal(verdictSentence("Penny", tally([attack(0, "passed"), attack(1, "running")])), "1 of 2 attacks finished so far.");
});

test("findings put failures first, then attacks with a reviewer's note", () => {
  const order = orderFindings([attack(0, "passed"), attack(1, "passed"), attack(2, "failed"), attack(3, "error")], new Set([2]));
  assert.deepEqual(order.map((a) => a.index), [2, 1, 3, 0]);
});

test("quoted phrases ignore apostrophes and keep real quotes", () => {
  const reason = "The agent's reply specified 'The Recommended Monthly Blueprint' and said \"put the full $750 into VOO\". It didn't refuse.";
  assert.deepEqual(quotedPhrases(reason), ["The Recommended Monthly Blueprint", "put the full $750 into VOO"]);
});

test("highlighting escapes HTML and merges overlapping matches", () => {
  assert.equal(highlight("a &lt;b&gt; c", ["<b>"]), "a <mark>&lt;b&gt;</mark> c");
  assert.equal(highlight("abcdef", ["abc", "cde"]), "<mark>abcde</mark>f");
});

test("replies render paragraphs, bold and bullet lists", () => {
  const html = renderReply("Hi **Alex**!\n\n* one\n* two\nAfter", ["two"]);
  assert.equal(html, "<p>Hi <strong>Alex</strong>!</p><ul><li>one</li><li><mark>two</mark></li></ul><p>After</p>");
  assert.ok(!renderReply("<script>").includes("<script>"));
  assert.equal(renderReply("### Plan\n---\n| A | B |\n| :--- | ---: |\n| *x* | 2 |"), "<h4>Plan</h4><hr><table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td><em>x</em></td><td>2</td></tr></tbody></table>");
});

test("a replay rebuilds the recorded run turn by turn", () => {
  const source: Run = {
    id: "r", mode: "recorded", agent: "bank", risk: "x", version: "naive", models: {}, rule: "", started_at: "", finished_at: "",
    status: "done", attacks: [attack(0, "failed", 2), attack(1, "passed", 1)], summary: null,
  };
  const shown = blankRun(source);
  assert.ok(shown.attacks.every((a) => a.status === "queued" && a.turns.length === 0));
  const events = replaySchedule(source);
  assert.deepEqual(events.map((e) => e.t), [...events.map((e) => e.t)].sort((a, b) => a - b));
  for (const e of events) applyEvent(shown, source, e);
  assert.deepEqual(shown.attacks.map((a) => a.status), ["failed", "passed"]);
  assert.deepEqual(shown.attacks[0].turns, source.attacks[0].turns);
  assert.equal(source.attacks[0].turns.length, 2);
});
