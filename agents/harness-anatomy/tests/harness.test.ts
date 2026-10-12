import { test } from "node:test";
import assert from "node:assert/strict";

import { ALL_PARTS, COMPACT_AT, PARTS, WINDOW, effective, run, type PartId, type Problem } from "../src/harness.ts";

const without = (...ids: PartId[]) => ALL_PARTS.filter((p) => !ids.includes(p));

test("the full harness finishes the task with no problems, inside the window", () => {
  const r = run(ALL_PARTS);
  assert.equal(r.finished, true);
  assert.deepEqual(r.problems, []);
  assert.ok(r.peak < COMPACT_AT, "the press never needs to move");
  const last = r.steps.at(-1)!;
  assert.ok(last.todos.length === 5 && last.todos.every((t) => t.done), "every to-do is ticked");
  assert.equal(last.gate, "approved");
});

test("every step's window is the sum of its blocks, and billing adds the window at each model call", () => {
  // Without subagents, every billed token is the main window at a main call.
  for (const installed of [without("subagents"), without("subagents", "offloading"), without("subagents", "offloading", "summarization"), []]) {
    const r = run(installed);
    let billed = 0;
    let calls = 0;
    for (const s of r.steps) {
      assert.equal(s.used, s.blocks.reduce((n, b) => n + b.tokens, 0));
      if (s.calls > calls) {
        billed += s.used;
        calls = s.calls;
      }
      assert.equal(s.billed, billed);
    }
    assert.equal(r.billed, billed);
    assert.equal(r.calls, calls);
    assert.equal(r.peak, Math.max(...r.steps.map((s) => s.used)));
  }
});

test("a subagent's own calls are billed once, on top of the main window", () => {
  const r = run(ALL_PARTS);
  const main = r.steps.reduce((acc, s, i) => {
    const prevCalls = i ? r.steps[i - 1].calls : 0;
    return s.calls > prevCalls ? acc + s.used : acc;
  }, 0);
  // Two explorer calls: its brief alone, then its brief plus the 110k of files.
  assert.equal(r.billed - main, 3_000 + 3_000 + 110_000);
});

test("removing each part causes the failure the page describes", () => {
  const expected: Partial<Record<PartId, Problem[]>> = {
    memory: ["rework", "forgets"],
    repl: ["unverified"],
    sandbox: ["host"],
    planning: ["stopped-early"],
    hitl: ["unreviewed"],
  };
  for (const [id, problems] of Object.entries(expected)) {
    assert.deepEqual(run(without(id as PartId)).problems.sort(), [...problems].sort(), id);
  }
});

test("parts that keep text out of the window save tokens when removed one at a time", () => {
  const full = run(ALL_PARTS);
  for (const id of ["skills", "offloading", "subagents", "filesystem"] as PartId[]) {
    const r = run(without(id));
    assert.ok(r.peak > full.peak && r.billed > full.billed, `${id} should raise the window and the bill`);
  }
  // Subagents are the single biggest saving in this run.
  const billed = (id: PartId) => run(without(id)).billed;
  for (const p of ALL_PARTS) if (p !== "subagents") assert.ok(billed("subagents") >= billed(p), p);
});

test("summarization only matters when the window fills, and then it saves the run", () => {
  assert.deepEqual(run(without("summarization")).problems, []);
  const pressed = run(without("subagents", "offloading"));
  assert.equal(pressed.finished, true);
  assert.ok(pressed.steps.some((s) => s.pressing), "the press comes down");
  assert.ok(pressed.steps.every((s, i) => i === 0 || s.used <= WINDOW));

  const overflow = run(without("subagents", "offloading", "summarization"));
  assert.equal(overflow.finished, false);
  assert.ok(overflow.problems.includes("overflow"));
  assert.ok(overflow.steps.at(-1)!.used > WINDOW);
});

test("a part stops working when a part it needs is removed", () => {
  const on = effective(without("filesystem"));
  for (const id of ["memory", "offloading", "code"] as PartId[]) assert.equal(on.has(id), false, id);
  assert.equal(effective(without("repl")).has("code"), false);
  // Every dependency names a real part.
  for (const p of PARTS) for (const n of p.needs) assert.ok(ALL_PARTS.includes(n));
});

test("the run is deterministic", () => {
  assert.deepEqual(run(without("memory", "hitl")), run(without("memory", "hitl")));
});
