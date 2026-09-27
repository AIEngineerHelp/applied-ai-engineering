import test from "node:test";
import assert from "node:assert/strict";
import { OBSTACLES_PER_SEED, SEEDS, collect, dataset, datasetHash, plan, summarize } from "../src/benchmark.js";
import { ruleAction } from "../src/players.js";

test("the dataset is fixed and its hash is stable", () => {
  assert.equal(datasetHash(), datasetHash(dataset()));
  const details = plan(2);
  assert.equal(details.plannedCalls, SEEDS.length * OBSTACLES_PER_SEED * 2);
  assert.equal(Object.values(details.kinds).reduce((a, b) => a + b, 0), SEEDS.length * OBSTACLES_PER_SEED);
  for (const course of dataset()) for (const o of course.obstacles) assert.ok(o.safe.length >= 1);
});

const fake = (choose, ms = 100) => async (kind) => ({
  action: choose(kind), confidence: 0.9, probabilities: null, ms, model: "jev-test",
  inputTokens: 150, outputTokens: 0, estimatedUsd: null,
});

test("a perfect player scores full marks in paused and fast real-time play", async () => {
  const samples = await collect({ decide: fake(ruleAction) });
  const summary = summarize(samples);
  assert.equal(summary.decisions, SEEDS.length * OBSTACLES_PER_SEED);
  assert.equal(summary.correct, summary.decisions);
  assert.equal(summary.pausedCleared, summary.possibleCleared);
  assert.equal(summary.realTimeCleared, summary.possibleCleared);
  assert.equal(summary.ruleBotCleared, summary.ruleBotPossible);
  assert.equal(summary.medianMs, 100);
  assert.equal(summary.estimatedUsd, null);
  assert.deepEqual(summary.models, ["jev-test"]);
});

test("slow answers lose real-time games but not paused ones", async () => {
  const summary = summarize(await collect({ decide: fake(ruleAction, 1500) }));
  assert.equal(summary.pausedCleared, summary.possibleCleared);
  assert.ok(summary.realTimeCleared < summary.possibleCleared);
  assert.ok(summary.realTimeLate > 0);
});

test("errors and wrong moves are counted, not skipped", async () => {
  let n = 0;
  const samples = await collect({
    decide: async (kind) => {
      if (++n === 3) throw new Error("Jev request timed out.");
      return fake(() => (kind === "high-bird" ? "jump" : ruleAction(kind)))(kind);
    },
  });
  const summary = summarize(samples);
  assert.equal(summary.errors, 1);
  assert.equal(summary.decisions, SEEDS.length * OBSTACLES_PER_SEED);
  assert.ok(summary.correct < summary.decisions - 1);
  assert.equal(summary.choices["high-bird"].jump > 0, true);
  const first = summary.games.find((g) => g.seed === SEEDS[0]);
  assert.equal(first.paused.crashedAt, 2, "the obstacle without an answer ends the game");
});
