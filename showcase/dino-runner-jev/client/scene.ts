// Canvas renderer for the game stage, in a 2D cartoon style: flat colours,
// bold ink outlines, and squash-and-stretch. It only draws: every position
// comes from the shared simulation in src/game.ts, so visuals never change
// collisions.
import { DINO_X, VIEW_WIDTH, type Obstacle } from "../src/game.js";

export type Tone = "pending" | "safe" | "unsafe" | "late" | "neutral";
export interface Label {
  text: string;
  tone: Tone;
}
export interface Frame {
  /** Interpolated distance travelled, in world pixels. */
  distance: number;
  /** Seconds since the page loaded; drives ambient animation only. */
  clock: number;
  dino: { y: number; ducking: boolean; onGround: boolean };
  running: boolean;
  crashed: boolean;
  /** Draw the line where the simulation asks the player for a decision. */
  showHorizon: boolean;
  obstacles: { obstacle: Obstacle; label?: Label }[];
}

const INK = "#1f1a2e";
const C = {
  sky: "#8fd6f7",
  skyLow: "#c8eefb",
  sun: "#ffd23f",
  cloud: "#ffffff",
  mesa: "#f09b6d",
  mesaTop: "#f7b58e",
  dune: "#ffc766",
  sand: "#ffe08a",
  sandDark: "#f3c96a",
  pebble: "#dca955",
  dino: "#5cc96c",
  dinoShade: "#46a95a",
  belly: "#eefab8",
  spikes: "#ff9f1c",
  crash: "#ff6b5a",
  cactus: "#4fbf63",
  cactusShade: "#3a9a4f",
  cactusLight: "#9be58f",
  flower: "#ff6fa8",
  bird: "#ff7a59",
  birdWing: "#e85d3f",
  beak: "#ffd23f",
  shadow: "rgba(31, 26, 46, 0.14)",
  tones: {
    pending: ["#dde5ff", "#2f5bea"],
    safe: ["#c8f5d3", "#157a3a"],
    unsafe: ["#ffd3d0", "#c42525"],
    late: ["#ffe8a3", "#8a5a00"],
    neutral: ["#ffffff", INK],
  },
};

function hash(n: number) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

// Far flat-topped buttes and nearer rolling dunes. `factor` is parallax speed
// relative to the ground; heights are world pixels.
function buttes(tile: number, seed: number) {
  const step = 20;
  const count = tile / step;
  const points: number[] = [];
  let k = 0;
  while (points.length < count) {
    const gap = 3 + Math.floor(hash(seed + k++) * 7);
    const top = 3 + Math.floor(hash(seed + k++) * 6);
    const h = 0.55 + hash(seed + k++) * 0.45;
    for (let j = 0; j < gap && points.length < count; j++) points.push(0.1);
    for (let j = 0; j < top && points.length < count; j++) points.push(j === 0 || j === top - 1 ? h * 0.82 : h);
  }
  return { factor: 0.08, tile, height: 96, step, points };
}
function dunes(tile: number, seed: number) {
  const step = 24;
  const count = tile / step;
  const points = Array.from({ length: count }, (_, i) => {
    let v = 0.45;
    [1, 3, 5].forEach((k, w) => (v += [0.28, 0.14, 0.06][w] * Math.sin((2 * Math.PI * k * i) / count + hash(seed + w) * 6.28)));
    return Math.max(0.05, Math.min(1, v));
  });
  return { factor: 0.22, tile, height: 40, step, points };
}
const FAR = buttes(1600, 7);
const NEAR = dunes(1200, 21);

interface Puff {
  x: number; // absolute world x, so dust stays put on the ground
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
}

export function createScene(canvas: HTMLCanvasElement, options: { reducedMotion: () => boolean }) {
  const ctx = canvas.getContext("2d");
  let width = 0;
  let height = 0;
  let scale = 1;
  let groundY = 0;
  let originX = 0;
  let distance = 0;
  const puffs: Puff[] = [];
  const effects = { stretch: 0, squash: 0, shake: 0, impact: 0 };
  let impactY = 20;
  let dustTimer = 0;

  /**
   * Show at least ~640 world px across (the simulation asks for a decision at
   * 600) and keep room above the ground for the jump apex and the high bird.
   */
  function resize() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    scale = Math.min(width / (width < 600 ? 400 : 660), (height * 0.8 * 0.82) / 160);
    groundY = Math.round(Math.min(height * 0.8, height * 0.5 + 70 * scale));
    originX = Math.min(width * 0.03, 40);
  }

  const sx = (screenWorldX: number) => originX + screenWorldX * scale;
  const sy = (up: number) => groundY - up * scale;
  const visibleWorldWidth = () => (width - originX) / scale;
  const reduce = () => options.reducedMotion();

  // --- effects triggered by the game -------------------------------------
  function dust(worldX: number, count: number, spread: number, lift: number, size: number) {
    const n = reduce() ? Math.ceil(count / 3) : count;
    for (let i = 0; i < n; i++)
      puffs.push({
        x: worldX + (Math.random() - 0.5) * 10,
        y: 2,
        vx: (Math.random() - 0.5) * spread,
        vy: lift * (0.4 + Math.random() * 0.8),
        life: 0,
        max: 0.35 + Math.random() * 0.25,
        size: size * (0.7 + Math.random() * 0.6),
      });
  }
  const jumped = () => (effects.stretch = 1);
  function landed(at: number) {
    effects.squash = 1;
    dust(at + DINO_X + 20, 6, 70, 30, 4);
  }
  function crashed(at: number, y = 0) {
    if (!reduce()) effects.shake = 1;
    effects.impact = 1;
    impactY = y + 26;
    dust(at + DINO_X + 40, 8, 110, 50, 4.5);
  }

  // --- cartoon drawing helpers ----------------------------------------------
  /**
   * Fill several overlapping parts with one outer ink outline: stroke every part
   * thick first, then fill every part on top, so inner seams disappear.
   * `k` is how many CSS pixels one local unit is, to keep the ink width constant.
   */
  function inked(fill: string, parts: Array<() => void>, k: number, inkPx = 2.2, ink = INK) {
    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.strokeStyle = ink;
    ctx.lineWidth = (inkPx * 2) / k;
    for (const part of parts) {
      ctx.beginPath();
      part();
      ctx.stroke();
    }
    ctx.fillStyle = fill;
    for (const part of parts) {
      ctx.beginPath();
      part();
      ctx.fill();
    }
    ctx.restore();
  }
  const rr = (x: number, y: number, w: number, h: number, r: number) => () => ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
  const oval = (x: number, y: number, rx: number, ry: number) => () => ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  const poly = (...points: number[]) => () => {
    ctx.moveTo(points[0], points[1]);
    for (let i = 2; i < points.length; i += 2) ctx.lineTo(points[i], points[i + 1]);
    ctx.closePath();
  };
  function fillShape(color: string, shape: () => void) {
    ctx.fillStyle = color;
    ctx.beginPath();
    shape();
    ctx.fill();
  }

  // --- backdrop -----------------------------------------------------------
  function drawSky(clock: number) {
    const sky = ctx.createLinearGradient(0, 0, 0, groundY);
    sky.addColorStop(0, C.sky);
    sky.addColorStop(1, C.skyLow);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, width, groundY);
    // Sun with slowly turning rays.
    const r = Math.max(16, 22 * scale);
    // Upper middle: clear of the HUD (top right) and the request-line label.
    const cx = width * 0.46;
    const cy = Math.max(r * 2.4, groundY * 0.24);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(reduce() ? 0 : clock * 0.25);
    const rays: Array<() => void> = [];
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      rays.push(() => {
        ctx.save();
        ctx.rotate(a);
        ctx.roundRect(r * 1.25, -r * 0.13, r * 0.55, r * 0.26, r * 0.13);
        ctx.restore();
      });
    }
    inked(C.sun, rays, 1, 1.8);
    inked(C.sun, [oval(0, 0, r, r)], 1, 2.2);
    ctx.restore();
    ctx.fillStyle = "rgba(255, 255, 255, 0.55)";
    ctx.beginPath();
    ctx.ellipse(cx - r * 0.35, cy - r * 0.35, r * 0.28, r * 0.18, -0.6, 0, Math.PI * 2);
    ctx.fill();
    // Puffy clouds drifting with a little parallax.
    const tile = 1700;
    const drift = distance * 0.1 + (reduce() ? 0 : clock * 5);
    for (let i = 0; i < 6; i++) {
      let x = (((hash(i + 30) * tile - drift) % tile) + tile) % tile;
      x = originX + (x - 150) * scale;
      if (x > width + 150 * scale) continue;
      const y = groundY * (0.12 + hash(i + 60) * 0.32);
      const s = (0.7 + hash(i + 90) * 0.5) * scale;
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(s, s);
      inked(C.cloud, [rr(-34, -6, 68, 16, 8), oval(-14, -8, 14, 12), oval(6, -13, 17, 15), oval(24, -4, 11, 9)], s, 2);
      ctx.restore();
    }
  }

  function drawLayer(layer: typeof FAR, fill: string, inkAlpha: number, top?: string) {
    const shift = (distance * layer.factor) % layer.tile;
    const first = Math.floor((shift - originX / scale) / layer.step) - 1;
    const last = Math.ceil((shift + visibleWorldWidth()) / layer.step) + 1;
    const path = () => {
      ctx.moveTo(0, groundY + 2);
      for (let i = first; i <= last; i++) {
        const p = layer.points[((i % layer.points.length) + layer.points.length) % layer.points.length];
        ctx.lineTo(sx(i * layer.step - shift), sy(p * layer.height));
      }
      ctx.lineTo(width, groundY + 2);
      ctx.closePath();
    };
    ctx.save();
    ctx.lineJoin = "round";
    ctx.beginPath();
    path();
    ctx.fillStyle = fill;
    ctx.fill();
    if (top) {
      // A lighter cap band on the butte tops reads as sunlight.
      ctx.save();
      ctx.clip();
      ctx.fillStyle = top;
      ctx.fillRect(0, sy(layer.height), width, 6 * scale);
      ctx.restore();
    }
    ctx.strokeStyle = `rgba(31, 26, 46, ${inkAlpha})`;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  function drawGround() {
    ctx.fillStyle = C.sand;
    ctx.fillRect(0, groundY, width, height - groundY);
    ctx.fillStyle = C.sandDark;
    ctx.fillRect(0, groundY + 10 * scale, width, 3 * scale);
    // Pebbles are keyed to world position, so they scroll exactly with obstacles.
    const step = 16;
    const start = Math.floor((distance - DINO_X - originX / scale) / step);
    const end = start + Math.ceil(visibleWorldWidth() / step) + 4;
    const depth = Math.max(8, (height - groundY) / scale - 8);
    for (let i = start; i < end; i++) {
      const h = hash(i);
      if (h > 0.45) continue;
      const x = sx(i * step - distance + DINO_X + hash(i + 3) * step);
      const d = 16 + hash(i + 7) * Math.min(depth - 16, 50);
      const r = (1.2 + hash(i + 5) * 2.2) * scale;
      if (h < 0.08) inked(C.pebble, [oval(x, groundY + d * scale, r * 1.6, r)], 1, 1.4);
      else fillShape(C.pebble, oval(x, groundY + d * scale, r, r * 0.6));
    }
    ctx.fillStyle = INK;
    ctx.fillRect(0, groundY - 1, width, 2.5);
  }

  function drawRequestLine() {
    const x = Math.round(sx(VIEW_WIDTH)) + 0.5;
    if (x > width - 4) return;
    const top = Math.round(sy(122));
    ctx.save();
    ctx.setLineDash([5, 6]);
    ctx.strokeStyle = "rgba(31, 26, 46, 0.45)";
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, groundY);
    ctx.stroke();
    ctx.restore();
    ctx.font = "800 10px ui-rounded, 'SF Pro Rounded', system-ui, sans-serif";
    const text = "DECISION REQUESTED";
    const w = ctx.measureText(text).width + 14;
    const lx = Math.min(x - w / 2, width - w - 6);
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(lx, top - 22, w, 18, 9);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = INK;
    ctx.textBaseline = "middle";
    ctx.fillText(text, lx + 7, top - 13);
  }

  // --- actors -------------------------------------------------------------
  function drawShadow(x: number, widthWorld: number, up: number) {
    const fade = Math.max(0.3, 1 - up / 130);
    fillShape(C.shadow, oval(x, groundY + 2, (widthWorld / 2) * scale * fade, 3 * scale * fade));
  }

  function drawCactus(o: Obstacle) {
    const stems = o.kind === "cactus-cluster" ? [0.8, 1, 0.68] : [1];
    const slot = o.width / stems.length;
    ctx.save();
    ctx.translate(sx(o.worldX - distance + DINO_X), groundY);
    ctx.scale(scale, scale);
    stems.forEach((ratio, i) => {
      const h = o.height * ratio;
      const trunk = Math.max(7, slot * 0.46);
      const x = i * slot + (slot - trunk) / 2;
      const arm = trunk * 0.58;
      inked(C.cactus, [
        rr(x, -h, trunk, h, trunk / 2),
        rr(x - arm * 1.15, -h * 0.56, arm * 1.4, arm, arm / 2),
        rr(x - arm * 1.15, -h * 0.8, arm, h * 0.3, arm / 2),
        rr(x + trunk - arm * 0.25, -h * 0.7, arm * 1.4, arm, arm / 2),
        rr(x + trunk + arm * 0.15, -h * 0.9, arm, h * 0.26, arm / 2),
      ], scale, 2);
      // Cel shading: a darker side and a highlight streak.
      fillShape(C.cactusShade, rr(x + trunk * 0.62, -h + trunk * 0.45, trunk * 0.3, h - trunk * 0.5, trunk * 0.15));
      fillShape(C.cactusLight, rr(x + trunk * 0.2, -h + trunk * 0.5, trunk * 0.16, h * 0.45, trunk * 0.08));
      if (ratio === 1) {
        const fx = x + trunk / 2;
        inked(C.flower, [oval(fx - 2.2, -h - 1, 2.4, 2.4), oval(fx + 2.2, -h - 1, 2.4, 2.4), oval(fx, -h - 3.2, 2.4, 2.4)], scale, 1.4);
        fillShape(C.sun, oval(fx, -h - 1.4, 1.3, 1.3));
      }
    });
    ctx.restore();
  }

  function drawBird(o: Obstacle, clock: number) {
    ctx.save();
    ctx.translate(sx(o.worldX - distance + DINO_X), sy(o.bottom));
    ctx.scale(scale, scale);
    const flap = reduce() ? 0.3 : Math.sin(clock * 11 + o.id);
    const mid = -o.height * 0.5;
    inked(C.birdWing, [poly(14, mid, 6 + flap * 3, mid - 4 - flap * 12, 26, mid - 1)], scale, 2);
    inked(C.bird, [
      oval(20, mid, 13, 5.5),
      oval(32, mid - 2.5, 6, 5),
      poly(9, mid - 1, -1, mid - 4, 1, mid + 3),
      poly(29, mid - 6, 22, mid - 12, 33, mid - 7),
    ], scale, 2);
    inked(C.beak, [poly(36.5, mid - 4.5, 43, mid - 1.5, 36.5, mid + 0.5)], scale, 1.6);
    inked("#ffffff", [oval(33, mid - 3.8, 2.2, 2.2)], scale, 1.2);
    fillShape(INK, oval(33.7, mid - 3.8, 1.1, 1.1));
    ctx.restore();
  }

  function drawDino(frame: Frame) {
    const { y, ducking, onGround } = frame.dino;
    const low = ducking && onGround;
    const w = low ? 52 : 40;
    // Exaggerated squash and stretch: that is what makes it read as cartoon.
    let stretchY = 1 + 0.12 * effects.stretch - 0.16 * effects.squash;
    if (!frame.running && !frame.crashed && !reduce()) stretchY += 0.015 * Math.sin(frame.clock * 3);
    const stretchX = 1 / stretchY;
    const phase = frame.distance / 15;
    const running = frame.running && onGround && !frame.crashed;
    const liftA = running ? Math.max(0, Math.sin(phase)) * 5 : onGround || frame.crashed ? 0 : 5;
    const liftB = running ? Math.max(0, -Math.sin(phase)) * 5 : onGround || frame.crashed ? 0 : 2;
    const bob = running ? Math.abs(Math.sin(phase)) * 1.2 : 0;
    const blink = !frame.running && !frame.crashed && frame.clock % 3.5 < 0.13;
    const body = frame.crashed ? C.crash : C.dino;
    const k = scale;

    drawShadow(sx(DINO_X + w / 2), w * 0.9, y);
    ctx.save();
    ctx.translate(sx(DINO_X + w / 2), sy(y));
    ctx.scale(scale * stretchX, scale * stretchY);
    ctx.translate(-w / 2, -bob);
    const leg = (x: number, lift: number, length: number) => [rr(x, -length, 5.5, length - lift, 2.5), rr(x, -(lift + 3), 8, 3, 1.5)];
    if (!low) {
      inked(C.spikes, [poly(8, -30, 11, -37, 14, -31), poly(13, -32, 16.5, -39, 20, -33), poly(19, -36, 22.5, -44, 26, -38)], k, 1.8);
      inked(C.dinoShade, leg(11, liftB, 13), k);
      inked(body, [
        ...leg(22, liftA, 13),
        () => {
          ctx.moveTo(13, -31);
          ctx.quadraticCurveTo(3, -29, -4, -35);
          ctx.quadraticCurveTo(1, -20, 13, -15);
          ctx.closePath();
        },
        rr(7, -34, 26, 25, 10),
        rr(19, -38, 12, 12, 4),
        rr(20, -46, 21, 16, 7),
        rr(29, -22, 7, 3, 1.5),
      ], k);
      fillShape(C.belly, oval(23, -18, 7, 7));
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.6 / k;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(33, -35.5);
      ctx.quadraticCurveTo(36.5, -34, 39.5, -36);
      ctx.stroke();
      fillShape(INK, oval(38.5, -41.5, 0.7, 0.7));
      eye(31.5, -40, k, frame.crashed, blink);
    } else {
      inked(C.spikes, [poly(10, -19, 13, -24, 16, -19.5), poly(16, -20, 19, -25, 22, -20.5), poly(22, -20.5, 25, -25.5, 28, -21)], k, 1.8);
      inked(C.dinoShade, leg(13, liftB * 0.5, 8), k);
      inked(body, [
        ...leg(26, liftA * 0.5, 8),
        () => {
          ctx.moveTo(8, -18);
          ctx.quadraticCurveTo(-1, -18, -6, -22);
          ctx.quadraticCurveTo(-1, -10, 8, -8);
          ctx.closePath();
        },
        rr(3, -21, 38, 15, 7),
        rr(34, -26, 18, 14, 6),
      ], k);
      fillShape(C.belly, oval(22, -10.5, 10, 3.5));
      eye(44, -21, k, frame.crashed, blink);
    }
    ctx.restore();
  }

  function eye(x: number, y: number, k: number, crashed: boolean, blink: boolean) {
    if (crashed) {
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.8 / k;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(x - 2.2, y - 2.2);
      ctx.lineTo(x + 2.2, y + 2.2);
      ctx.moveTo(x + 2.2, y - 2.2);
      ctx.lineTo(x - 2.2, y + 2.2);
      ctx.stroke();
      return;
    }
    if (blink) {
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.8 / k;
      ctx.beginPath();
      ctx.moveTo(x - 2.6, y);
      ctx.quadraticCurveTo(x, y + 1.6, x + 2.6, y);
      ctx.stroke();
      return;
    }
    inked("#ffffff", [oval(x, y, 3.4, 3.8)], k, 1.4);
    fillShape(INK, oval(x + 1, y + 0.2, 1.7, 2.1));
    fillShape("#ffffff", oval(x + 1.6, y - 0.8, 0.6, 0.6));
  }

  /** A comic "impact star" where the dino hit the obstacle. */
  function drawImpact() {
    if (effects.impact <= 0) return;
    const t = 1 - effects.impact;
    const size = (10 + 10 * Math.min(1, t * 3)) * scale;
    ctx.save();
    ctx.translate(sx(DINO_X + 42), sy(impactY));
    ctx.rotate(t * 0.6);
    ctx.globalAlpha = Math.min(1, effects.impact * 2);
    const points: number[] = [];
    for (let i = 0; i < 16; i++) {
      const r = i % 2 ? size * 0.45 : size;
      const a = (i / 16) * Math.PI * 2;
      points.push(Math.cos(a) * r, Math.sin(a) * r);
    }
    inked(C.sun, [poly(...points)], 1, 2.2);
    ctx.restore();
  }

  const labelBorn = new Map<number, number>();
  function drawLabel(o: Obstacle, label: Label, now: number) {
    if (!labelBorn.has(o.id)) labelBorn.set(o.id, now);
    // Tags appear many times a minute: fade in quickly, no movement.
    ctx.globalAlpha = Math.min(1, (now - labelBorn.get(o.id)) / 120);
    ctx.font = "700 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
    const [bg, fg] = C.tones[label.tone];
    const w = ctx.measureText(label.text).width + 18;
    const h = 22;
    const cx = sx(o.worldX - distance + DINO_X + o.width / 2);
    const top = sy(o.bottom + o.height) - 14;
    const x = Math.max(6, Math.min(width - w - 8, cx - w / 2));
    const y = Math.max(26, top - h);
    // Speech bubble: hard offset shadow, ink border, and a tail to the obstacle.
    const bubble = () => {
      ctx.roundRect(x, y, w, h, 9);
      const tx = Math.max(x + 10, Math.min(x + w - 10, cx));
      ctx.moveTo(tx - 5, y + h - 1);
      ctx.lineTo(tx, y + h + 7);
      ctx.lineTo(tx + 5, y + h - 1);
    };
    ctx.save();
    ctx.translate(2, 2);
    fillShape(INK, bubble);
    ctx.restore();
    inked(bg, [bubble], 1, 1.1);
    ctx.fillStyle = fg;
    ctx.textBaseline = "middle";
    ctx.fillText(label.text, x + 9, y + h / 2 + 0.5);
    ctx.globalAlpha = 1;
  }

  // --- frame ----------------------------------------------------------------
  function update(frame: Frame, dt: number) {
    effects.stretch = Math.max(0, effects.stretch - dt / 0.16);
    effects.squash = Math.max(0, effects.squash - dt / 0.16);
    effects.shake = Math.max(0, effects.shake - dt / 0.3);
    effects.impact = Math.max(0, effects.impact - dt / 0.5);
    if (frame.running && frame.dino.onGround && !frame.crashed && !reduce()) {
      dustTimer -= dt;
      if (dustTimer <= 0) {
        dustTimer = 0.12;
        dust(frame.distance + DINO_X + 6, 1, 20, 12, 2.4);
      }
    }
    for (let i = puffs.length - 1; i >= 0; i--) {
      const p = puffs[i];
      p.life += dt;
      p.x += p.vx * dt;
      p.vy -= 60 * dt;
      p.y = Math.max(0, p.y + p.vy * dt);
      if (p.life >= p.max) puffs.splice(i, 1);
    }
  }

  function render(frame: Frame, dt: number) {
    if (frame.distance < distance) labelBorn.clear(); // distance went back: a new run
    distance = frame.distance;
    update(frame, dt);
    ctx.save();
    if (effects.shake > 0) {
      const amount = 7 * effects.shake * effects.shake;
      ctx.translate((Math.random() - 0.5) * amount, (Math.random() - 0.5) * amount);
    }
    drawSky(frame.clock);
    drawLayer(FAR, C.mesa, 0.35, C.mesaTop);
    drawLayer(NEAR, C.dune, 0.55);
    drawGround();
    if (frame.showHorizon) drawRequestLine();
    for (const { obstacle } of frame.obstacles)
      drawShadow(sx(obstacle.worldX - distance + DINO_X + obstacle.width / 2), obstacle.width, obstacle.bottom);
    for (const { obstacle } of frame.obstacles)
      obstacle.kind.endsWith("bird") ? drawBird(obstacle, frame.clock) : drawCactus(obstacle);
    for (const p of puffs) {
      const t = p.life / p.max;
      ctx.globalAlpha = 1 - t;
      inked("#ffffff", [oval(sx(p.x - distance), sy(p.y + p.size), p.size * scale * (1 - t * 0.4), p.size * scale * (1 - t * 0.4))], 1, 1.3);
    }
    ctx.globalAlpha = 1;
    drawDino(frame);
    drawImpact();
    const now = performance.now();
    for (const { obstacle, label } of frame.obstacles) if (label) drawLabel(obstacle, label, now);
    ctx.restore();
  }

  return { resize, render, visibleWorldWidth, jumped, landed, crashed, get groundY() { return groundY; } };
}
