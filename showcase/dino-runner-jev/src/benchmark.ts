import { createHash } from "node:crypto";
import {
  ACCELERATION, DINO, DUCK_LEAD_SECONDS, GRAVITY, JUMP_VELOCITY, MAX_SPEED, OBSTACLES,
  START_SPEED, STEP, createCourse, safeActions, simulate, speedAt,
  type Action, type Kind,
} from "./game.js";
import { CRITERIA, INSTRUCTION, ruleAction } from "./players.js";
import type { DecideFn } from "./jev.js";

// Fixed courses. Changing any seed, count, constant, or prompt changes the hash.
export const SEEDS = [11, 23, 37, 41, 59];
export const OBSTACLES_PER_SEED = 30;

export function dataset() {
  return SEEDS.map((seed) => {
    const course = createCourse(seed);
    return {
      seed,
      obstacles: Array.from({ length: OBSTACLES_PER_SEED }, (_, i) => {
        const { id, kind, worldX } = course.get(i);
        const speed = Math.round(speedAt(worldX));
        return { id, kind, worldX, speed, safe: safeActions(kind, speed) };
      }),
    };
  });
}

export function datasetHash(data = dataset()) {
  const physics = { STEP, START_SPEED, MAX_SPEED, ACCELERATION, JUMP_VELOCITY, GRAVITY, DUCK_LEAD_SECONDS, DINO, OBSTACLES };
  return createHash("sha256")
    .update(JSON.stringify({ version: 1, physics, prompt: { INSTRUCTION, CRITERIA }, data }))
    .digest("hex");
}

export function plan(repetitions = 1) {
  const data = dataset();
  const kinds: Record<string, number> = {};
  for (const course of data) for (const o of course.obstacles) kinds[o.kind] = (kinds[o.kind] ?? 0) + 1;
  return {
    datasetHash: datasetHash(data),
    seeds: SEEDS,
    obstaclesPerSeed: OBSTACLES_PER_SEED,
    repetitions,
    plannedCalls: SEEDS.length * OBSTACLES_PER_SEED * repetitions,
    kinds,
  };
}

export interface Sample {
  seed: number;
  repetition: number;
  obstacleId: number;
  kind: Kind;
  speed: number;
  safe: Action[];
  choice: Action | null;
  correct: boolean;
  confidence: number | null;
  ms: number | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedUsd: number | null;
  error: string | null;
}

/** Asks Jev about every obstacle, one call at a time, in course order. */
export async function collect({
  decide,
  repetitions = 1,
  onSample = (_sample: Sample) => {},
}: {
  decide: DecideFn;
  repetitions?: number;
  onSample?: (sample: Sample) => void;
}) {
  const samples: Sample[] = [];
  for (let repetition = 1; repetition <= repetitions; repetition++)
    for (const course of dataset())
      for (const o of course.obstacles) {
        const base = { seed: course.seed, repetition, obstacleId: o.id, kind: o.kind, speed: o.speed, safe: o.safe };
        let sample: Sample;
        try {
          const d = await decide(o.kind);
          sample = {
            ...base, choice: d.action, correct: o.safe.includes(d.action), confidence: d.confidence,
            ms: d.ms, model: d.model, inputTokens: d.inputTokens, outputTokens: d.outputTokens,
            estimatedUsd: d.estimatedUsd, error: null,
          };
        } catch (error) {
          sample = {
            ...base, choice: null, correct: false, confidence: null, ms: null, model: null,
            inputTokens: null, outputTokens: null, estimatedUsd: null, error: error.message,
          };
        }
        samples.push(sample);
        onSample(sample);
      }
  return samples;
}

const percentile = (values: number[], p: number) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};

/**
 * Replays each seed with the collected answers. Paused: answers arrive
 * instantly. Real-time replay: each answer arrives after its measured latency
 * in game time, which is what would happen if the game kept running.
 */
export function play(samples: Sample[]) {
  const games = [];
  const runs = new Map<string, Sample[]>();
  for (const s of samples) {
    const key = `${s.repetition}:${s.seed}`;
    runs.set(key, [...(runs.get(key) ?? []), s]);
  }
  for (const [key, runSamples] of runs) {
    const [repetition, seed] = key.split(":").map(Number);
    const byId = new Map(runSamples.map((s) => [s.obstacleId, s]));
    const outcome = (realTime: boolean) => {
      const result = simulate({
        seed,
        obstacleLimit: OBSTACLES_PER_SEED,
        decide: (o) => {
          const s = byId.get(o.id);
          return s?.choice ? { action: s.choice, delayMs: realTime ? s.ms : 0 } : null;
        },
      });
      return {
        cleared: result.cleared,
        crashedAt: result.crashedInto?.id ?? null,
        late: [...result.decisions.values()].filter((d) => d.late).length,
      };
    };
    games.push({ repetition, seed, paused: outcome(false), realTime: outcome(true) });
  }
  return games;
}

export function summarize(samples: Sample[]) {
  const answered = samples.filter((s) => !s.error);
  const latencies = answered.map((s) => s.ms);
  const choices: Record<string, Record<string, number>> = {};
  for (const s of samples) {
    const choice = s.choice ?? "error";
    choices[s.kind] ??= {};
    choices[s.kind][choice] = (choices[s.kind][choice] ?? 0) + 1;
  }
  const games = play(samples);
  const rule = SEEDS.map((seed) =>
    simulate({ seed, obstacleLimit: OBSTACLES_PER_SEED, decide: (o) => ({ action: ruleAction(o.kind), delayMs: 0 }) }).cleared,
  );
  const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
  const costs = answered.map((s) => s.estimatedUsd);
  return {
    decisions: samples.length,
    correct: samples.filter((s) => s.correct).length,
    errors: samples.length - answered.length,
    medianMs: percentile(latencies, 50),
    p90Ms: percentile(latencies, 90),
    maxMs: latencies.length ? Math.max(...latencies) : null,
    choices,
    models: [...new Set(answered.map((s) => s.model))],
    inputTokens: sum(answered.map((s) => s.inputTokens ?? 0)),
    outputTokens: sum(answered.map((s) => s.outputTokens ?? 0)),
    estimatedUsd: costs.length && costs.every((c) => c !== null) ? sum(costs) : null,
    obstaclesPerGame: OBSTACLES_PER_SEED,
    games,
    pausedCleared: sum(games.map((g) => g.paused.cleared)),
    realTimeCleared: sum(games.map((g) => g.realTime.cleared)),
    realTimeLate: sum(games.map((g) => g.realTime.late)),
    possibleCleared: games.length * OBSTACLES_PER_SEED,
    ruleBotCleared: sum(rule),
    ruleBotPossible: SEEDS.length * OBSTACLES_PER_SEED,
  };
}
