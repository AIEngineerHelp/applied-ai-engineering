// Game simulation shared by the browser, tests, and benchmark. It has no rendering
// and no clock of its own: every call to step() advances exactly one fixed tick,
// so the same seed always produces the same course and the same physics.
// Units are pixels and seconds; heights are measured up from the ground.

export const STEP = 1 / 60;
export const VIEW_WIDTH = 600;
export const DINO_X = 40;
export const DINO = { width: 40, height: 44, duckWidth: 52, duckHeight: 26 };
export const JUMP_VELOCITY = 700;
export const GRAVITY = 2400;
// Humans can duck mid-air to drop faster, as in the Chrome game.
export const FAST_FALL = 3;
export const START_SPEED = 360;
export const MAX_SPEED = 780;
// Speed grows with distance travelled, so the course layout never depends on timing.
export const ACCELERATION = 0.012;
export const FIRST_OBSTACLE = 900;
// Spacing between obstacles, in seconds of running at the current speed. The
// minimum leaves room to land from one jump before the next one is due.
export const MIN_GAP_SECONDS = 0.8;
export const MAX_GAP_SECONDS = 1.6;
// Ducking starts this long before the obstacle arrives.
export const DUCK_LEAD_SECONDS = 0.1;

// The high bird's top sits above the jump apex (JUMP_VELOCITY² / 2·GRAVITY ≈
// 102 px), so jumping into it always collides; safeActions() checks this.
export const OBSTACLES = {
  "small-cactus": { width: 18, height: 38, bottom: 0 },
  "large-cactus": { width: 26, height: 50, bottom: 0 },
  "cactus-cluster": { width: 64, height: 42, bottom: 0 },
  "low-bird": { width: 42, height: 26, bottom: 6 },
  "mid-bird": { width: 42, height: 26, bottom: 32 },
  "high-bird": { width: 42, height: 26, bottom: 78 },
} as const;
export type Kind = keyof typeof OBSTACLES;
export const KINDS = Object.keys(OBSTACLES) as Kind[];
export type Action = "jump" | "duck" | "run";
export const ACTIONS: Action[] = ["jump", "duck", "run"];

// Birds appear only after the first few cacti, like the original game.
const WEIGHTS: [Kind, number][] = [
  ["small-cactus", 0.3],
  ["large-cactus", 0.2],
  ["cactus-cluster", 0.15],
  ["low-bird", 0.12],
  ["mid-bird", 0.12],
  ["high-bird", 0.11],
];
const FIRST_BIRD = 3;

export interface Obstacle {
  id: number;
  kind: Kind;
  worldX: number;
  width: number;
  height: number;
  bottom: number;
}

export type GameEvent =
  | { type: "visible"; obstacle: Obstacle }
  | { type: "cleared"; obstacle: Obstacle }
  | { type: "crash"; obstacle: Obstacle };

/** Small seeded PRNG (mulberry32); Math.random cannot be replayed. */
export function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function speedAt(distance: number) {
  return Math.min(MAX_SPEED, START_SPEED + ACCELERATION * distance);
}

export function createCourse(seed: number) {
  const next = random(seed);
  const obstacles: Obstacle[] = [];
  function pick(index: number): Kind {
    const pool = index < FIRST_BIRD ? WEIGHTS.slice(0, 3) : WEIGHTS;
    let r = next() * pool.reduce((sum, [, weight]) => sum + weight, 0);
    for (const [kind, weight] of pool) if ((r -= weight) < 0) return kind;
    return pool.at(-1)[0];
  }
  return {
    seed,
    get(index: number): Obstacle {
      while (obstacles.length <= index) {
        const previous = obstacles.at(-1);
        const gapSeconds =
          MIN_GAP_SECONDS + next() * (MAX_GAP_SECONDS - MIN_GAP_SECONDS);
        const worldX = previous
          ? previous.worldX + previous.width + speedAt(previous.worldX) * gapSeconds
          : FIRST_OBSTACLE;
        const kind = pick(obstacles.length);
        obstacles.push({
          id: obstacles.length,
          kind,
          worldX: Math.round(worldX),
          ...OBSTACLES[kind],
        });
      }
      return obstacles[index];
    },
  };
}
export type Course = Pick<ReturnType<typeof createCourse>, "get">;

export class Game {
  time = 0;
  distance: number;
  speed: number;
  y = 0;
  vy = 0;
  ducking = false;
  cleared = 0;
  crashedInto: Obstacle | null = null;
  /** Obstacles on screen that the dino has not yet passed, nearest first. */
  active: Obstacle[] = [];
  readonly obstacleLimit: number;
  private course: Course;
  private nextIndex = 0;

  constructor(
    readonly seed: number,
    {
      obstacleLimit = Infinity,
      course = createCourse(seed),
      startDistance = 0,
    }: { obstacleLimit?: number; course?: Course; startDistance?: number } = {},
  ) {
    this.obstacleLimit = obstacleLimit;
    this.course = course;
    this.distance = startDistance;
    this.speed = speedAt(startDistance);
  }

  get over() {
    return !!this.crashedInto || this.cleared >= this.obstacleLimit;
  }
  get onGround() {
    return this.y === 0 && this.vy === 0;
  }
  get score() {
    return Math.floor(this.distance / 10);
  }
  screenX(obstacle: Obstacle) {
    return obstacle.worldX - this.distance + DINO_X;
  }
  /** Space between the standing dino's nose and the obstacle's leading edge. */
  gap(obstacle: Obstacle) {
    return this.screenX(obstacle) - (DINO_X + DINO.width);
  }
  box() {
    const low = this.ducking && this.onGround;
    return {
      x: DINO_X,
      y: this.y,
      width: low ? DINO.duckWidth : DINO.width,
      height: low ? DINO.duckHeight : DINO.height,
    };
  }
  jump() {
    if (!this.onGround || this.over) return false;
    this.ducking = false;
    this.vy = JUMP_VELOCITY;
    return true;
  }
  duck(on: boolean) {
    this.ducking = on;
  }

  step(): GameEvent[] {
    if (this.over) return [];
    const events: GameEvent[] = [];
    this.speed = speedAt(this.distance);
    this.distance += this.speed * STEP;
    this.time += STEP;
    if (!this.onGround) {
      // Exact update for constant gravity, so jumps match the timing formula.
      const gravity = GRAVITY * (this.ducking ? FAST_FALL : 1);
      this.y += this.vy * STEP - (gravity * STEP * STEP) / 2;
      this.vy -= gravity * STEP;
      if (this.y <= 0) this.y = this.vy = 0;
    }
    const dino = this.box();
    for (const obstacle of this.active) {
      const x = this.screenX(obstacle);
      if (
        dino.x < x + obstacle.width &&
        dino.x + dino.width > x &&
        dino.y < obstacle.bottom + obstacle.height &&
        dino.y + dino.height > obstacle.bottom
      ) {
        this.crashedInto = obstacle;
        events.push({ type: "crash", obstacle });
        return events;
      }
    }
    while (this.active.length && this.screenX(this.active[0]) + this.active[0].width < DINO_X) {
      const obstacle = this.active.shift();
      this.cleared++;
      events.push({ type: "cleared", obstacle });
    }
    while (this.nextIndex < this.obstacleLimit) {
      const obstacle = this.course.get(this.nextIndex);
      if (this.screenX(obstacle) > VIEW_WIDTH) break;
      this.active.push(obstacle);
      this.nextIndex++;
      events.push({ type: "visible", obstacle });
    }
    return events;
  }
}

/** How far ahead (in gap pixels) the autopilot must start the move. */
export function triggerGap(action: Action, speed: number, obstacle: Obstacle) {
  // Centre the jump's apex (at JUMP_VELOCITY / GRAVITY seconds) on the moment
  // the dino and the obstacle overlap most.
  if (action === "jump")
    return (speed * JUMP_VELOCITY) / GRAVITY - (DINO.width + obstacle.width) / 2;
  if (action === "duck") return speed * DUCK_LEAD_SECONDS;
  return -Infinity;
}

export interface Decision {
  action: Action;
  /** Game time at which the decision is available to the dino. */
  readyAt: number;
  /** Set when the dino first sees the decision: was it too late to act on time? */
  late?: boolean;
}

/**
 * Code decides *when*: it executes each chosen action at the right moment for
 * the current speed. The player (rule bot or Jev) only decides *what*.
 */
export class Autopilot {
  decisions = new Map<number, Decision>();
  private jumped = new Set<number>();

  set(id: number, action: Action, readyAt: number) {
    this.decisions.set(id, { action, readyAt });
  }

  update(game: Game) {
    const target = game.active[0];
    let duck = false;
    const decision = target && this.decisions.get(target.id);
    if (decision && game.time >= decision.readyAt) {
      const gap = game.gap(target);
      const trigger = triggerGap(decision.action, game.speed, target);
      decision.late ??= gap < trigger;
      if (
        decision.action === "jump" &&
        gap <= trigger &&
        !this.jumped.has(target.id) &&
        game.jump()
      )
        this.jumped.add(target.id);
      duck = decision.action === "duck" && gap <= trigger;
    }
    game.duck(duck);
  }
}

// A generous cap so a buggy player cannot loop forever in headless runs.
const MAX_STEPS = 60 * 60 * 30;

/**
 * Plays a course headlessly. `decide` returns the action for each obstacle when
 * it comes into view, plus how many milliseconds the answer takes to arrive in
 * game time: 0 models paused mode, a measured latency models real-time mode.
 */
export function simulate({
  seed,
  obstacleLimit,
  decide,
  course,
  startDistance,
}: {
  seed: number;
  obstacleLimit: number;
  decide: (obstacle: Obstacle) => { action: Action; delayMs: number } | null;
  course?: Course;
  startDistance?: number;
}) {
  const game = new Game(seed, { obstacleLimit, course, startDistance });
  const pilot = new Autopilot();
  for (let i = 0; i < MAX_STEPS && !game.over; i++) {
    pilot.update(game);
    for (const event of game.step())
      if (event.type === "visible") {
        const decision = decide(event.obstacle);
        if (decision)
          pilot.set(event.obstacle.id, decision.action, game.time + decision.delayMs / 1000);
      }
  }
  // An answer still in flight when the dino hits the obstacle was also late.
  const pending = game.crashedInto && pilot.decisions.get(game.crashedInto.id);
  if (pending) pending.late ??= true;
  return {
    cleared: game.cleared,
    crashedInto: game.crashedInto,
    score: game.score,
    decisions: pilot.decisions,
  };
}

const safeCache = new Map<string, Action[]>();
/**
 * The actions that get the autopilot past one obstacle at the given speed,
 * found by simulating each action rather than by hand-written labels.
 */
export function safeActions(kind: Kind, speed: number): Action[] {
  const key = `${kind}:${Math.round(speed)}`;
  if (!safeCache.has(key)) {
    const startDistance = (Math.max(START_SPEED, Math.min(MAX_SPEED, speed)) - START_SPEED) / ACCELERATION;
    const obstacle = { id: 0, kind, worldX: Math.round(startDistance) + VIEW_WIDTH + 40, ...OBSTACLES[kind] };
    safeCache.set(
      key,
      ACTIONS.filter(
        (action) =>
          simulate({
            seed: 0,
            obstacleLimit: 1,
            course: { get: () => obstacle },
            startDistance,
            decide: () => ({ action, delayMs: 0 }),
          }).cleared === 1,
      ),
    );
  }
  return safeCache.get(key);
}
