import test from "node:test";
import assert from "node:assert/strict";
import {
  Autopilot, Game, KINDS, MAX_SPEED, MIN_GAP_SECONDS, START_SPEED, VIEW_WIDTH,
  createCourse, random, safeActions, simulate, speedAt, triggerGap,
} from "../src/game.js";
import { CRITERIA, obstacleState, ruleAction } from "../src/players.js";

const rule = (o) => ({ action: ruleAction(o.kind), delayMs: 0 });

test("random numbers and courses are reproducible from the seed", () => {
  const a = random(42), b = random(42);
  for (let i = 0; i < 5; i++) assert.equal(a(), b());
  const first = createCourse(7), second = createCourse(7);
  for (let i = 0; i < 50; i++) assert.deepEqual(first.get(i), second.get(i));
  assert.notDeepEqual(createCourse(8).get(5), first.get(5));
});

test("courses space obstacles far enough apart and delay birds", () => {
  const course = createCourse(3);
  for (let i = 0; i < 3; i++) assert.ok(course.get(i).kind.endsWith("cactus") || course.get(i).kind === "cactus-cluster");
  for (let i = 1; i < 200; i++) {
    const previous = course.get(i - 1), current = course.get(i);
    const gap = current.worldX - previous.worldX - previous.width;
    assert.ok(gap >= speedAt(previous.worldX) * MIN_GAP_SECONDS - 1, `gap before obstacle ${i}`);
  }
  assert.ok(Array.from({ length: 200 }, (_, i) => course.get(i).kind).some((k) => k.endsWith("bird")));
});

test("speed rises with distance and is capped", () => {
  assert.equal(speedAt(0), START_SPEED);
  assert.ok(speedAt(10000) > START_SPEED);
  assert.equal(speedAt(1e9), MAX_SPEED);
});

test("a jump rises to about 102 px and lands back on the ground", () => {
  const game = new Game(1);
  assert.ok(game.jump());
  assert.equal(game.jump(), false, "no double jump");
  let apex = 0;
  for (let i = 0; i < 60 && (i === 0 || !game.onGround); i++) {
    game.step();
    apex = Math.max(apex, game.y);
  }
  assert.ok(apex > 100 && apex < 103, `apex ${apex}`);
  assert.ok(game.onGround);
});

test("ducking lowers the dino only on the ground", () => {
  const game = new Game(1);
  game.duck(true);
  assert.equal(game.box().height, 26);
  game.duck(false);
  assert.equal(game.box().height, 44);
});

test("running with no moves crashes into the first cactus", () => {
  const result = simulate({ seed: 11, obstacleLimit: 5, decide: () => null });
  assert.equal(result.cleared, 0);
  assert.equal(result.crashedInto.id, 0);
});

test("safe moves come from simulation and match the obstacle descriptions", () => {
  const expected = {
    "small-cactus": ["jump"],
    "large-cactus": ["jump"],
    "cactus-cluster": ["jump"],
    "low-bird": ["jump"],
    "mid-bird": ["jump", "duck"],
    "high-bird": ["duck", "run"],
  };
  for (const speed of [START_SPEED, 520, 650, MAX_SPEED])
    for (const kind of KINDS) assert.deepEqual(safeActions(kind, speed), expected[kind], `${kind} at ${speed}`);
});

test("the rule bot always picks a safe move and clears long courses", () => {
  for (const kind of KINDS) assert.ok(safeActions(kind, START_SPEED).includes(ruleAction(kind)));
  for (const seed of [1, 2, 11, 23, 37, 41, 59, 1000]) {
    const result = simulate({ seed, obstacleLimit: 80, decide: rule });
    assert.equal(result.cleared, 80, `seed ${seed}`);
    assert.equal([...result.decisions.values()].filter((d) => d.late).length, 0);
  }
});

test("a wrong move crashes into that obstacle", () => {
  const result = simulate({
    seed: 11,
    obstacleLimit: 10,
    decide: (o) => ({ action: o.id === 4 ? "run" : ruleAction(o.kind), delayMs: 0 }),
  });
  assert.equal(result.crashedInto?.id, 4);
});

test("slow answers are marked late and can crash in real time", () => {
  const fast = simulate({ seed: 11, obstacleLimit: 60, decide: (o) => ({ ...rule(o), delayMs: 200 }) });
  assert.equal(fast.cleared, 60);
  const slow = simulate({ seed: 11, obstacleLimit: 60, decide: (o) => ({ ...rule(o), delayMs: 1100 }) });
  assert.ok(slow.cleared < 60);
  assert.ok([...slow.decisions.values()].some((d) => d.late));
});

test("the autopilot jumps at the trigger point, not before", () => {
  const game = new Game(11, { obstacleLimit: 1 });
  const pilot = new Autopilot();
  let obstacle;
  while (!obstacle) obstacle = game.step().find((e) => e.type === "visible")?.obstacle;
  pilot.set(obstacle.id, "jump", game.time);
  while (game.onGround) {
    const gap = game.gap(obstacle);
    pilot.update(game);
    if (!game.onGround) assert.ok(gap <= triggerGap("jump", game.speed, obstacle));
    else assert.ok(gap > triggerGap("jump", game.speed, obstacle));
    game.step();
  }
  assert.ok(game.screenX(obstacle) < VIEW_WIDTH);
});

test("model state is words only, and every move has a description", () => {
  for (const kind of KINDS) {
    const text = JSON.stringify(obstacleState(kind));
    assert.doesNotMatch(text, /\d/, `${kind} state contains a number`);
  }
  assert.deepEqual(Object.keys(CRITERIA).sort(), ["duck", "jump", "run"]);
});
