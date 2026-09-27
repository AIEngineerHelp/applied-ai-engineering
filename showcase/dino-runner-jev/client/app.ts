import {
  Autopilot, DINO_X, Game, STEP, createCourse, safeActions, speedAt, triggerGap,
  type Action, type Course, type Kind, type Obstacle,
} from "../src/game.js";
import { ruleAction } from "../src/players.js";
import { createAudio } from "./audio.js";
import { createScene, type Label } from "./scene.js";
import { createTelemetry, type Decision, type Meta } from "./telemetry.js";

type Player = "human" | "rule" | "jev";
type Mode = "realtime" | "paused";
type State = "ready" | "playing" | "over";

// Endless for humans; AI runs stop here so a forgotten tab cannot keep spending.
const AI_OBSTACLE_LIMIT = 100;
const NAMES: Record<Kind, string> = {
  "small-cactus": "Small cactus",
  "large-cactus": "Tall cactus",
  "cactus-cluster": "Cactus cluster",
  "low-bird": "Low bird",
  "mid-bird": "Head-height bird",
  "high-bird": "High bird",
};

/** A decision plus what the game knew when it asked, to compute the budget. */
interface Row extends Decision {
  obstacle: Obstacle;
  gapAtRequest: number;
  speedAtRequest: number;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>("game");
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const coarsePointer = matchMedia("(pointer: coarse)");
const scene = createScene(canvas, { reducedMotion: () => reducedMotion.matches });
const telemetry = createTelemetry();
const audio = createAudio();

let state: State = "ready";
let player: Player = "jev";
let mode: Mode = "realtime";
let seed = 11;
let game: Game;
let pilot: Autopilot | null;
let peek: Course;
let shown = 0; // obstacles that have entered the simulation's view
let rows = new Map<number, Row>();
let failure = "";
let run = 0;
let abort = new AbortController();
let accumulator = 0;
let previous = { distance: 0, y: 0 };
let last = performance.now();
let overAt = 0;
let lastScore = -1;
let config = { live: false, model: "jev-latest" };

// --- best scores (per player; storage may be unavailable) --------------------
function readBest(p: Player) {
  try {
    return Number(localStorage.getItem(`dino-jev-hi-${p}`)) || 0;
  } catch {
    return 0;
  }
}
function writeBest(p: Player, score: number) {
  try {
    localStorage.setItem(`dino-jev-hi-${p}`, String(score));
  } catch {}
}
const pad = (n: number) => String(Math.min(n, 99999)).padStart(5, "0");

// --- lifecycle -------------------------------------------------------------
function reset() {
  audio.stopMusic();
  abort.abort();
  abort = new AbortController();
  run++;
  game = new Game(seed, { obstacleLimit: player === "human" ? Infinity : AI_OBSTACLE_LIMIT });
  pilot = player === "human" ? null : new Autopilot();
  peek = createCourse(seed);
  shown = 0;
  rows = new Map();
  failure = "";
  accumulator = 0;
  previous = { distance: 0, y: 0 };
  lastScore = -1;
  setState("ready");
  $("over").hidden = true;
  $("best").textContent = pad(readBest(player));
  telemetry.reset();
  updatePrompt();
}

function setState(next: State) {
  state = next;
  document.body.dataset.state = next;
  $("run-state").textContent = { ready: "Ready", playing: "Running", over: "Stopped" }[next];
}

function start() {
  if (player === "jev" && !config.live) return;
  if (state !== "ready") reset();
  setState("playing");
  last = performance.now();
  audio.unlock();
  audio.startMusic();
}

function restart() {
  if (performance.now() - overAt < 350) return; // ignore the key press that crashed
  reset();
  start();
}

function end() {
  setState("over");
  overAt = performance.now();
  abort.abort();
  audio.stopMusic();
  if (game.crashedInto) {
    scene.crashed(game.distance, game.y);
    audio.crash();
  } else if (!failure) audio.milestone();
  const best = readBest(player);
  if (game.score > best) writeBest(player, game.score);
  $("over-title").textContent = failure ? "Run stopped" : game.crashedInto ? "Game over" : "Course complete";
  $("over-score").textContent = pad(game.score);
  $("over-best").textContent = pad(Math.max(best, game.score));
  $("over-cleared").textContent = String(game.cleared);
  $("best").textContent = pad(Math.max(best, game.score));
  $("over-reason").textContent = reason();
  $("over").hidden = false;
  $("announce").textContent = `${$("over-title").textContent}. ${$("over-reason").textContent} Score ${game.score}.`;
  $<HTMLButtonElement>("restart").focus({ preventScroll: true });
}

function reason() {
  if (failure) return failure;
  const o = game.crashedInto;
  const who = player === "jev" ? "Jev" : "The rule bot";
  if (!o) return `${who} cleared all ${game.cleared} obstacles.`;
  const name = NAMES[o.kind].toLowerCase();
  if (player === "human") return `Hit a ${name} after ${game.cleared} obstacles.`;
  const row = rows.get(o.id);
  if (!row?.action) return `Jev had not answered when the dino reached the ${name} (#${row?.index}).`;
  if (!row.safe) return `${who} chose ${row.action} for a ${name} (#${row.index}); that move cannot clear it.`;
  if (row.late)
    return `${who} chose ${row.action} for a ${name} (#${row.index}), but the answer took ${row.roundTripMs} ms against a ${Math.round(row.budgetMs)} ms budget.`;
  return `Hit a ${name}.`;
}

// --- decisions ---------------------------------------------------------------
function budget(row: Row, action: Action) {
  if (action === "run") return null; // running needs no move, so no deadline
  const trigger = triggerGap(action, row.speedAtRequest, row.obstacle);
  return Math.max(0, ((row.gapAtRequest - trigger) / row.speedAtRequest) * 1000);
}

function settle(row: Row, action: Action) {
  row.action = action;
  row.safe = safeActions(row.obstacle.kind, speedAt(row.obstacle.worldX)).includes(action);
  row.budgetMs = budget(row, action);
  pilot.set(row.obstacle.id, action, game.time);
}

function request(obstacle: Obstacle) {
  if (player === "human") return;
  const row: Row = {
    obstacle,
    index: obstacle.id + 1,
    kind: obstacle.kind,
    label: NAMES[obstacle.kind],
    startedAt: performance.now(),
    gapAtRequest: game.gap(obstacle),
    speedAtRequest: game.speed,
  };
  rows.set(obstacle.id, row);
  if (player === "rule") {
    row.roundTripMs = 0;
    settle(row, ruleAction(obstacle.kind));
    return;
  }
  const id = run;
  fetch("/api/decide", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: obstacle.kind }),
    signal: abort.signal,
  })
    .then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      return data;
    })
    .then((data) => {
      if (id !== run) return;
      Object.assign(row, {
        confidence: data.confidence,
        probabilities: data.probabilities,
        apiMs: data.ms,
        model: data.model,
        inputTokens: data.inputTokens,
        outputTokens: data.outputTokens,
        roundTripMs: Math.round(performance.now() - row.startedAt),
      });
      // The decision exists from this game moment on; in real-time mode the
      // obstacle may already be too close to act on it.
      settle(row, data.action);
      audio.pop();
    })
    .catch((error) => {
      if (id !== run || error.name === "AbortError") return;
      // Stop instead of substituting a move: a fallback would hide the failure.
      row.error = error.message;
      failure = `Jev request failed: ${error.message}`;
    });
}

/** Paused mode holds the world while any obstacle in view has no answer yet. */
function waiting() {
  return player === "jev" && mode === "paused" && game.active.some((o) => !pilot.decisions.has(o.id));
}

function labelFor(o: Obstacle): Label | undefined {
  const row = rows.get(o.id);
  if (!row) return undefined;
  if (row.error) return { text: `#${row.index} error`, tone: "unsafe" };
  if (!row.action) return { text: `#${row.index} awaiting Jev · ${Math.round(performance.now() - row.startedAt)} ms`, tone: "pending" };
  if (player === "rule") return { text: `#${row.index} ${row.action}`, tone: "neutral" };
  const text = `#${row.index} ${row.action} · p=${row.confidence.toFixed(2)} · ${row.roundTripMs} ms${row.late ? " · late" : ""}`;
  return { text, tone: !row.safe ? "unsafe" : row.late ? "late" : "safe" };
}

function updatePrompt() {
  const touch = coarsePointer.matches;
  const key = touch ? "Tap" : "Press Space";
  $("prompt-main").textContent =
    player === "jev" && !config.live
      ? "Jev is not configured"
      : player === "human"
        ? `${key} to start`
        : `${key} to run ${player === "jev" ? "Jev" : "the rule bot"}`;
  $("prompt-sub").textContent =
    player === "jev" && !config.live
      ? "Set TYPESAFE_API_KEY and ENABLE_LIVE=true in .env, then restart the server."
      : player === "human"
        ? touch ? "Tap to jump · hold the ground to duck" : "Space / ↑ jump · ↓ duck"
        : player === "jev"
          ? "One Jev Choice call per obstacle. Code handles timing; Jev picks jump, duck, or run."
          : "Instant lookup table. A baseline with zero latency.";
}

// --- main loop -------------------------------------------------------------------
function frame(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  let holding = false;
  if (state === "playing") {
    accumulator += dt;
    while (accumulator >= STEP && !game.over && !failure) {
      if (waiting()) {
        holding = true;
        accumulator = 0;
        break;
      }
      previous = { distance: game.distance, y: game.y };
      pilot?.update(game);
      const grounded = game.onGround;
      for (const event of game.step())
        if (event.type === "visible") {
          shown++;
          request(event.obstacle);
        }
      if (grounded && !game.onGround) {
        scene.jumped();
        audio.jump();
      }
      if (!grounded && game.onGround) {
        scene.landed(game.distance);
        audio.land();
      }
      accumulator -= STEP;
    }
    // Lateness is decided by the autopilot the moment the dino sees the answer.
    for (const row of rows.values()) row.late = pilot?.decisions.get(row.obstacle.id)?.late;
    if (game.over || failure) end();
  }
  document.body.classList.toggle("holding", holding);
  const alpha = state === "playing" && !holding ? accumulator / STEP : 1;
  const distance = previous.distance + (game.distance - previous.distance) * alpha;
  const y = game.onGround ? 0 : previous.y + (game.y - previous.y) * alpha;

  // Upcoming obstacles are drawn from a copy of the course, so wide screens show
  // them before the simulation "sees" them at 600 px (which is when Jev is asked).
  const obstacles = game.active.map((obstacle) => ({ obstacle, label: labelFor(obstacle) }));
  for (let i = shown; i < game.obstacleLimit; i++) {
    const o = peek.get(i);
    if (o.worldX - distance + DINO_X > scene.visibleWorldWidth() + 60) break;
    obstacles.push({ obstacle: o, label: undefined });
  }
  scene.render(
    {
      distance,
      clock: now / 1000,
      dino: { y, ducking: game.ducking, onGround: game.onGround },
      running: state === "playing" && !holding,
      crashed: !!game.crashedInto,
      showHorizon: player !== "human",
      obstacles,
    },
    dt,
  );

  if (game.score !== lastScore) {
    if (state === "playing" && lastScore > 0 && Math.floor(game.score / 100) > Math.floor(lastScore / 100)) audio.milestone();
    lastScore = game.score;
    // The music speeds up with the run: 120 BPM at the start, ~150 at top speed.
    audio.setTempo(120 + ((game.speed - 360) / 420) * 30);
    $("score").textContent = pad(game.score);
    $("speed").textContent = `${Math.round(game.speed)} px/s`;
  }
  const meta: Meta = { player, mode, model: config.model, live: config.live };
  telemetry.update([...rows.values()], meta, now);
  requestAnimationFrame(frame);
}

// --- input -------------------------------------------------------------------
function jump() {
  if (state === "playing" && player === "human") game.jump();
}
function primary() {
  if (state === "ready") {
    start();
    jump();
  } else if (state === "playing") jump();
  else restart();
}

function setSound(on: boolean) {
  audio.setMuted(!on);
  const button = $("sound");
  button.setAttribute("aria-pressed", String(on));
  button.setAttribute("aria-label", on ? "Sound on" : "Sound off");
}
$("sound").addEventListener("click", (event) => {
  audio.unlock();
  setSound(audio.muted);
  (event.currentTarget as HTMLElement).blur(); // keep Space for the game
});
setSound(!audio.muted);

window.addEventListener("keydown", (event) => {
  if (event.target instanceof HTMLInputElement) return;
  if (event.key === "m" || event.key === "M") {
    audio.unlock();
    setSound(audio.muted);
    return;
  }
  if (event.key === " " || event.key === "ArrowUp") {
    event.preventDefault();
    if (!event.repeat || state === "playing") primary();
  } else if (event.key === "Enter") {
    if (event.target instanceof HTMLButtonElement && event.target.id !== "restart") return;
    event.preventDefault();
    if (state !== "playing") primary();
  } else if (event.key === "ArrowDown" && state === "playing") {
    event.preventDefault();
    if (player === "human") game.duck(true);
  }
});
window.addEventListener("keyup", (event) => {
  if (event.key === "ArrowDown" && player === "human") game.duck(false);
});

canvas.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  if (state === "over") return;
  // On touch screens, holding the ground (below the horizon) ducks.
  const top = canvas.getBoundingClientRect().top;
  if (state === "playing" && player === "human" && event.clientY - top > scene.groundY) {
    game.duck(true);
    canvas.setPointerCapture(event.pointerId);
    return;
  }
  primary();
});
const release = () => player === "human" && game.duck(false);
canvas.addEventListener("pointerup", release);
canvas.addEventListener("pointercancel", release);
canvas.addEventListener("contextmenu", (event) => event.preventDefault());

$("restart").addEventListener("click", () => state === "over" && restart());

function choose(group: string, value: string) {
  for (const button of document.querySelectorAll<HTMLButtonElement>(`[data-group="${group}"]`))
    button.setAttribute("aria-checked", String(button.dataset.value === value));
}
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-group]"))
  button.addEventListener("click", () => {
    if (button.dataset.group === "player") player = button.dataset.value as Player;
    else mode = button.dataset.value as Mode;
    choose(button.dataset.group, button.dataset.value);
    document.body.dataset.player = player;
    button.blur(); // keep Space for the game, not for re-clicking the button
    reset();
  });
const seedInput = $<HTMLInputElement>("seed");
seedInput.addEventListener("change", () => {
  seed = Math.min(999999, Math.abs(Math.trunc(Number(seedInput.value))) || 1);
  seedInput.value = String(seed);
  seedInput.blur();
  reset();
});
seedInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === "Escape") seedInput.blur();
});

new ResizeObserver(() => scene.resize()).observe(canvas);
// The chart draws in real pixels, so redraw it when the sidebar changes size.
new ResizeObserver(() => telemetry.reset()).observe($("chart"));

async function loadConfig() {
  try {
    config = await (await fetch("/api/config")).json();
  } catch {
    config = { live: false, model: "jev-latest" };
  }
  $("model").textContent = config.model;
  $("status").dataset.live = String(config.live);
  $("status-text").textContent = config.live ? "Live" : "Offline";
  $("status").title = config.live
    ? "The server has a TypeSafe key and live calls are enabled."
    : "Set TYPESAFE_API_KEY and ENABLE_LIVE=true in .env to enable Jev.";
  // Without live access, open on the rule bot so the page still demonstrates something.
  if (!config.live && player === "jev") {
    player = "rule";
    choose("player", player);
    document.body.dataset.player = player;
    reset();
  }
  updatePrompt();
}

scene.resize();
document.body.dataset.player = player;
choose("player", player);
reset();
loadConfig();
requestAnimationFrame(frame);
