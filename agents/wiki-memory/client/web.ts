// The knowledge web: a canvas renderer for the page graph. Every visual state is a pure function of
// the scene clock, so any frame can be reproduced (the app's ?t= hook freezes the clock for screenshots).
// No libraries: glow comes from cached radial-gradient sprites, which is cheap enough for 60 fps.

import type { Layout } from "../src/layout.ts";
import type { Graph, PageType } from "../src/wiki.ts";

type NodeType = PageType | "missing";

interface WebNode {
  id: string;
  type: NodeType;
  x: number;
  y: number;
  depth: number;
  phase: number;
  /** Scene time at which the node ignites. -Infinity: it was already there. */
  born: number;
  /** Scene time of an "updated" pulse, or NaN. */
  pulse: number;
}

interface WebEdge {
  a: string;
  b: string;
  /** Scene time the edge starts drawing. -Infinity: already drawn. */
  at: number;
}

export interface Doc {
  /** Target node. */
  to: string;
  /** Start position, in canvas CSS pixels. */
  from: { x: number; y: number };
  label: string;
  at: number;
  /** Flight time in ms. */
  dur: number;
  /** Card size multiplier. */
  size?: number;
}

export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export interface Flags {
  nodes: Set<string>;
  pairs: [string, string][];
  at: number;
  /** Scene time the flags resolve (turn calm), or Infinity. */
  resolve: number;
}

const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeBack = (t: number) => {
  const c = 1.7;
  return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
};

/** A small seeded random generator, so the starfield and drift are the same on every load. */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

interface Palette {
  dark: boolean;
  bg: string;
  edge: string;
  label: string;
  labelDim: string;
  newc: string;
  edit: string;
  bad: string;
  good: string;
  accent: string;
  types: Record<NodeType, string>;
}

function readPalette(): Palette {
  const css = getComputedStyle(document.documentElement);
  const v = (n: string) => css.getPropertyValue(n).trim();
  return {
    dark: document.documentElement.dataset.theme !== "light",
    bg: v("--bg"),
    edge: v("--web-edge"),
    label: v("--ink"),
    labelDim: v("--muted"),
    newc: v("--new"),
    edit: v("--edit"),
    bad: v("--bad"),
    good: v("--new"),
    accent: v("--accent"),
    types: {
      overview: v("--n-overview"),
      source: v("--n-source"),
      entity: v("--n-entity"),
      concept: v("--n-concept"),
      missing: v("--bad"),
    },
  };
}

export class Web {
  private ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private nodes = new Map<string, WebNode>();
  private edges: WebEdge[] = [];
  private docs: Doc[] = [];
  private flags: Flags | null = null;
  private scanAt = NaN;
  private stars: { x: number; y: number; z: number; r: number }[] = [];
  private sprites = new Map<string, HTMLCanvasElement>();
  private pal: Palette;
  private camFrom: Camera = { x: 0.5, y: 0.5, zoom: 1 };
  private camTo: Camera = { x: 0.5, y: 0.5, zoom: 1 };
  private camAt = 0;
  private camDur = 1;
  /** Where the graph's centre sits on the canvas, as fractions of width and height. */
  view = { cx: 0.5, cy: 0.5, fill: 0.9 };
  /** Smoothed pointer position, -1..1, for parallax. */
  private pointer = { x: 0, y: 0, tx: 0, ty: 0 };
  highlight = new Set<string>();

  constructor(
    private canvas: HTMLCanvasElement,
    private layout: Layout,
  ) {
    this.ctx = canvas.getContext("2d")!;
    this.pal = readPalette();
    const r = rng(7);
    for (let i = 0; i < 150; i++) this.stars.push({ x: r(), y: r(), z: 0.2 + r() * 0.8, r: 0.4 + r() * 1.1 });
    canvas.addEventListener("pointermove", (e) => {
      const b = canvas.getBoundingClientRect();
      this.pointer.tx = ((e.clientX - b.left) / b.width) * 2 - 1;
      this.pointer.ty = ((e.clientY - b.top) / b.height) * 2 - 1;
    });
    canvas.addEventListener("pointerleave", () => {
      this.pointer.tx = 0;
      this.pointer.ty = 0;
    });
  }

  refreshPalette() {
    this.pal = readPalette();
    this.sprites.clear();
  }

  resize() {
    const b = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = Math.max(1, b.width);
    this.h = Math.max(1, b.height);
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
  }

  /**
   * Shows a graph. Nodes in `created` ignite from `at`, one after another; nodes in `touched` pulse;
   * edges in `newEdges` draw themselves once both ends exist. Everything else is shown at rest.
   */
  setGraph(graph: Graph | null, opts: { created?: Set<string>; touched?: Set<string>; newEdges?: Set<string>; at?: number; stagger?: number; order?: string[] } = {}) {
    const { created = new Set(), touched = new Set(), newEdges = new Set(), at = 0, stagger = 110 } = opts;
    this.nodes.clear();
    this.edges = [];
    this.flags = null;
    this.docs = [];
    this.scanAt = NaN;
    if (!graph) return;
    const order = opts.order ?? graph.nodes.map((n) => n.id);
    const createdOrder = order.filter((id) => created.has(id));
    const touchedOrder = order.filter((id) => touched.has(id));
    for (const n of graph.nodes) {
      const p = this.layout[n.id] ?? { x: 0.5, y: 0.5 };
      const ci = createdOrder.indexOf(n.id);
      const ti = touchedOrder.indexOf(n.id);
      this.nodes.set(n.id, {
        id: n.id,
        type: n.type,
        x: p.x,
        y: p.y,
        depth: 0.75 + hash(n.id) * 0.5,
        phase: hash(`${n.id}#`) * Math.PI * 2,
        born: ci >= 0 ? at + ci * stagger : n.type === "missing" && created.size ? at + createdOrder.length * stagger : -Infinity,
        pulse: ti >= 0 ? at + 80 + ti * 90 : NaN,
      });
    }
    let k = 0;
    for (const e of graph.edges) {
      const key = [e.from, e.to].sort().join("|");
      if (!newEdges.has(key)) {
        this.edges.push({ a: e.from, b: e.to, at: -Infinity });
        continue;
      }
      const ready = Math.max(this.nodes.get(e.from)?.born ?? 0, this.nodes.get(e.to)?.born ?? 0, at);
      this.edges.push({ a: e.from, b: e.to, at: Math.max(ready + 250, at + 250 + k * 60) });
      k++;
    }
  }

  /** Last scene time at which anything in the graph is still animating in. */
  settleTime(): number {
    let t = 0;
    for (const n of this.nodes.values()) if (Number.isFinite(n.born)) t = Math.max(t, n.born + 600);
    for (const e of this.edges) if (Number.isFinite(e.at)) t = Math.max(t, e.at + 700);
    return t;
  }

  setDocs(docs: Doc[]) {
    this.docs = docs;
  }

  setFlags(flags: Flags | null) {
    this.flags = flags;
  }

  scan(at: number) {
    this.scanAt = at;
  }

  /** Moves the camera from `from` to `to`, starting at scene time `at`. */
  moveCamera(to: Camera, at: number, dur: number, from: Camera) {
    this.camFrom = from;
    this.camTo = to;
    this.camAt = at;
    this.camDur = dur;
  }

  /** The camera at scene time t, to start the next move from. */
  cameraNow(t: number): Camera {
    return this.cameraAt(t);
  }

  setCamera(cam: Camera) {
    this.camFrom = cam;
    this.camTo = cam;
    this.camAt = 0;
    this.camDur = 1;
  }

  /** The camera that frames a set of nodes. */
  frame(ids: string[], zoom = 1.25): Camera {
    const pts = ids.map((id) => this.layout[id]).filter(Boolean);
    if (!pts.length) return { x: 0.5, y: 0.5, zoom: 1 };
    const x = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const y = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    // Pull the focus part of the way to the centre so the rest of the web stays in view.
    return { x: 0.5 + (x - 0.5) * 0.4, y: 0.5 + (y - 0.5) * 0.4, zoom };
  }

  private cameraAt(t: number): Camera {
    const k = easeInOut(clamp((t - this.camAt) / this.camDur));
    return {
      x: this.camFrom.x + (this.camTo.x - this.camFrom.x) * k,
      y: this.camFrom.y + (this.camTo.y - this.camFrom.y) * k,
      zoom: this.camFrom.zoom + (this.camTo.zoom - this.camFrom.zoom) * k,
    };
  }

  /** Screen position (CSS px) of a node at scene time t. */
  screenOf(id: string, t: number, wall: number): { x: number; y: number } {
    const n = this.nodes.get(id);
    const p = n ?? { ...(this.layout[id] ?? { x: 0.5, y: 0.5 }), depth: 1, phase: 0 };
    return this.project(p.x, p.y, p.depth, p.phase, this.cameraAt(t), wall);
  }

  private graphSize() {
    const gw = Math.min(this.w * this.view.fill, this.h * this.view.fill * 1.5);
    return { gw, gh: gw / 1.5 };
  }

  private project(x: number, y: number, depth: number, phase: number, cam: Camera, wall: number) {
    const { gw, gh } = this.graphSize();
    const drift = 5;
    const dx = Math.sin(wall * 0.00035 + phase) * drift * depth;
    const dy = Math.cos(wall * 0.0003 + phase * 1.3) * drift * depth;
    const par = 14 * (depth - 1);
    return {
      x: this.w * this.view.cx + (x - cam.x) * gw * cam.zoom + dx + this.pointer.x * par,
      y: this.h * this.view.cy + (y - cam.y) * gh * cam.zoom + dy + this.pointer.y * par,
    };
  }

  private sprite(color: string): HTMLCanvasElement {
    let s = this.sprites.get(color);
    if (s) return s;
    s = document.createElement("canvas");
    s.width = s.height = 128;
    const g = s.getContext("2d")!;
    const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, rgba(color, 1));
    grad.addColorStop(0.18, rgba(color, 0.55));
    grad.addColorStop(0.45, rgba(color, 0.14));
    grad.addColorStop(1, rgba(color, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    this.sprites.set(color, s);
    return s;
  }

  private glow(x: number, y: number, r: number, color: string, alpha: number) {
    if (alpha <= 0.01 || r <= 0) return;
    const c = this.ctx;
    c.globalAlpha = clamp(alpha) * (this.pal.dark ? 1 : 0.55);
    c.drawImage(this.sprite(color), x - r, y - r, r * 2, r * 2);
    c.globalAlpha = 1;
  }

  /** Draws one frame. `t` is scene time, `wall` drives the slow drift; both in ms. */
  render(t: number, wall: number, still = false) {
    const c = this.ctx;
    const P = this.pal;
    if (!still) {
      this.pointer.x += (this.pointer.tx - this.pointer.x) * 0.06;
      this.pointer.y += (this.pointer.ty - this.pointer.y) * 0.06;
    }
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, this.w, this.h);
    const cam = this.cameraAt(t);
    const blend = P.dark ? "lighter" : "source-over";

    // Starfield: two layers of slow parallax.
    c.fillStyle = P.labelDim;
    for (const s of this.stars) {
      const x = ((s.x * this.w + wall * 0.004 * s.z + this.pointer.x * 10 * s.z) % this.w + this.w) % this.w;
      const y = s.y * this.h + this.pointer.y * 8 * s.z;
      c.globalAlpha = (P.dark ? 0.55 : 0.2) * s.z * (0.6 + 0.4 * Math.sin(wall * 0.001 + s.x * 40));
      c.beginPath();
      c.arc(x, y, s.r * s.z, 0, Math.PI * 2);
      c.fill();
    }
    c.globalAlpha = 1;

    const pos = new Map<string, { x: number; y: number }>();
    for (const n of this.nodes.values()) pos.set(n.id, this.project(n.x, n.y, n.depth, n.phase, cam, wall));
    const visible = (n: WebNode) => t >= n.born;
    const flagged = (id: string) => this.flags?.nodes.has(id) ?? false;
    const resolveK = this.flags ? clamp((t - this.flags.resolve) / 900) : 0;
    const flagK = this.flags ? clamp((t - this.flags.at) / 400) * (1 - resolveK) : 0;

    // Edges.
    c.lineCap = "round";
    for (const e of this.edges) {
      const a = pos.get(e.a);
      const b = pos.get(e.b);
      const na = this.nodes.get(e.a);
      const nb = this.nodes.get(e.b);
      if (!a || !b || !na || !nb) continue;
      if (!Number.isFinite(e.at)) {
        if (!visible(na) || !visible(nb)) continue;
        const hot = this.highlight.size === 0 || (this.highlight.has(e.a) && this.highlight.has(e.b));
        c.strokeStyle = P.edge;
        c.globalAlpha = hot ? 0.55 : 0.18;
        c.lineWidth = 1;
        c.beginPath();
        c.moveTo(a.x, a.y);
        c.lineTo(b.x, b.y);
        c.stroke();
        continue;
      }
      const k = clamp((t - e.at) / 650);
      if (k <= 0) continue;
      const kk = easeOut(k);
      const hx = a.x + (b.x - a.x) * kk;
      const hy = a.y + (b.y - a.y) * kk;
      const after = clamp((t - e.at - 650) / 1600);
      // The settled line, then a light trail on top that fades once the link has drawn.
      c.strokeStyle = P.edge;
      c.globalAlpha = 0.55;
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(a.x, a.y);
      c.lineTo(hx, hy);
      c.stroke();
      c.globalCompositeOperation = blend;
      c.strokeStyle = P.accent;
      c.globalAlpha = 0.95 * (1 - after);
      c.lineWidth = 1.8;
      c.beginPath();
      c.moveTo(a.x, a.y);
      c.lineTo(hx, hy);
      c.stroke();
      if (k < 1) this.glow(hx, hy, 22, P.accent, 1);
      c.globalCompositeOperation = "source-over";
      c.globalAlpha = 1;
    }

    // Conflict lines between pages that disagree.
    if (this.flags && flagK > 0) {
      c.save();
      c.globalCompositeOperation = blend;
      c.setLineDash([6, 6]);
      c.lineDashOffset = -wall * 0.03;
      c.strokeStyle = P.bad;
      c.lineWidth = 2;
      for (const [x, y] of this.flags.pairs) {
        const a = pos.get(x);
        const b = pos.get(y);
        if (!a || !b) continue;
        c.globalAlpha = 0.8 * flagK;
        c.beginPath();
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2 - Math.hypot(b.x - a.x, b.y - a.y) * 0.18;
        c.moveTo(a.x, a.y);
        c.quadraticCurveTo(mx, my, b.x, b.y);
        c.stroke();
      }
      c.restore();
    }

    // Lint scan beam.
    if (Number.isFinite(this.scanAt)) {
      const k = (t - this.scanAt) / 1300;
      if (k > 0 && k < 1) {
        const x = this.w * (0.05 + 0.9 * easeInOut(k));
        const g = c.createLinearGradient(x - 90, 0, x + 6, 0);
        g.addColorStop(0, "transparent");
        g.addColorStop(1, P.accent);
        c.globalCompositeOperation = blend;
        c.globalAlpha = 0.22;
        c.fillStyle = g;
        c.fillRect(x - 90, 0, 96, this.h);
        c.globalAlpha = 0.9;
        c.fillRect(x, 0, 1.5, this.h);
        c.globalAlpha = 1;
        c.globalCompositeOperation = "source-over";
      }
    }

    // Nodes.
    const { gw } = this.graphSize();
    const unit = clamp(gw / 900, 0.6, 1.2) * cam.zoom;
    const labelSize = Math.round(clamp(12 * unit, 10, 14));
    c.textAlign = "center";
    c.textBaseline = "top";
    for (const n of this.nodes.values()) {
      const p = pos.get(n.id)!;
      if (!visible(n)) continue;
      const color = P.types[n.type];
      const age = t - n.born;
      const ignite = Number.isFinite(n.born) ? clamp(age / 520) : 1;
      const scale = Number.isFinite(n.born) ? easeBack(ignite) : 1;
      const base = (n.type === "overview" ? 9 : 6.5) * unit;
      const r = Math.max(0, base * scale);
      const dim = this.highlight.size > 0 && !this.highlight.has(n.id) && !flagged(n.id);
      const breathe = 0.85 + 0.15 * Math.sin(wall * 0.0016 + n.phase);
      c.globalCompositeOperation = blend;
      this.glow(p.x, p.y, r * 7, color, (dim ? 0.14 : 0.62) * breathe);
      // Ignition flare.
      if (Number.isFinite(n.born) && age < 1100) {
        const f = age / 1100;
        this.glow(p.x, p.y, r * (4 + 14 * easeOut(f)), P.newc, 0.9 * (1 - f));
        c.strokeStyle = P.newc;
        c.globalAlpha = 0.8 * (1 - f);
        c.lineWidth = 1.5;
        c.beginPath();
        c.arc(p.x, p.y, r + 4 + 34 * easeOut(f), 0, Math.PI * 2);
        c.stroke();
      }
      // Update pulse.
      if (!Number.isNaN(n.pulse) && t >= n.pulse) {
        const f = clamp((t - n.pulse) / 1100);
        c.strokeStyle = P.edit;
        c.globalAlpha = 0.9 * (1 - f);
        c.lineWidth = 1.5;
        c.beginPath();
        c.arc(p.x, p.y, r + 3 + 22 * easeOut(f), 0, Math.PI * 2);
        c.stroke();
        this.glow(p.x, p.y, r * 6, P.edit, 0.55 * (1 - f));
      }
      // Lint flags: a red heartbeat that turns calm when resolved.
      if (flagged(n.id) && this.flags && t >= this.flags.at) {
        const beat = 0.55 + 0.45 * Math.sin((t - this.flags.at) * 0.008);
        this.glow(p.x, p.y, r * 9, P.bad, flagK * beat);
        this.glow(p.x, p.y, r * 7, P.good, resolveK * (1 - clamp((t - this.flags.resolve - 900) / 1500)) * 0.8);
      }
      c.globalCompositeOperation = "source-over";
      c.globalAlpha = dim ? 0.35 : 1;
      if (n.type === "missing") {
        c.setLineDash([3, 3]);
        c.strokeStyle = P.bad;
        c.lineWidth = 1.5;
        c.globalAlpha *= 0.6 + 0.4 * Math.sin(wall * 0.006);
        c.beginPath();
        c.arc(p.x, p.y, r + 1, 0, Math.PI * 2);
        c.stroke();
        c.setLineDash([]);
      } else {
        c.fillStyle = color;
        c.beginPath();
        c.arc(p.x, p.y, r, 0, Math.PI * 2);
        c.fill();
        c.fillStyle = P.dark ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0.9)";
        c.beginPath();
        c.arc(p.x - r * 0.25, p.y - r * 0.25, r * 0.35, 0, Math.PI * 2);
        c.fill();
      }
      // Label.
      const strong = this.highlight.has(n.id) || flagged(n.id) || (Number.isFinite(n.born) && age < 2600) || (!Number.isNaN(n.pulse) && t - n.pulse < 2600);
      c.globalAlpha = (dim ? 0.3 : strong ? 0.95 : 0.62) * clamp(ignite * 1.4);
      c.font = `500 ${labelSize}px Inter, system-ui, sans-serif`;
      c.lineJoin = "round";
      c.lineWidth = 4;
      c.strokeStyle = P.bg;
      c.strokeText(n.id, p.x, p.y + r + 6);
      c.fillStyle = n.type === "missing" ? P.bad : strong ? P.label : P.labelDim;
      c.fillText(n.id, p.x, p.y + r + 6);
      c.globalAlpha = 1;
    }

    // Documents in flight.
    for (const d of this.docs) this.drawDoc(d, t, wall, pos, blend);
  }

  private drawDoc(d: Doc, t: number, wall: number, pos: Map<string, { x: number; y: number }>, blend: GlobalCompositeOperation) {
    const c = this.ctx;
    const P = this.pal;
    const k = (t - d.at) / d.dur;
    if (k < 0 || k > 1.35) return;
    const target = pos.get(d.to) ?? this.screenOf(d.to, t, wall);
    const m = easeInOut(clamp(k));
    const x = d.from.x + (target.x - d.from.x) * m;
    const y = d.from.y + (target.y - d.from.y) * m - Math.sin(m * Math.PI) * 40;
    if (k <= 1) {
      const s = (1 - 0.75 * m * m) * (d.size ?? 1);
      const w = 74 * s;
      const h = 94 * s;
      c.save();
      c.translate(x, y);
      c.rotate((1 - m) * -0.12);
      c.globalCompositeOperation = blend;
      this.glow(0, 0, 90 * s, P.accent, 0.35 + 0.4 * m);
      c.globalCompositeOperation = "source-over";
      c.globalAlpha = 0.96;
      c.fillStyle = P.dark ? "rgba(20,24,38,0.92)" : "rgba(255,255,255,0.96)";
      c.strokeStyle = P.accent;
      c.lineWidth = 1.2;
      roundRect(c, -w / 2, -h / 2, w, h, 6 * s);
      c.fill();
      c.stroke();
      c.fillStyle = P.labelDim;
      for (let i = 0; i < 6; i++) {
        const lw = (i === 0 ? 0.55 : 0.75 - ((i * 37) % 30) / 100) * w;
        c.globalAlpha = i === 0 ? 0.95 : 0.5;
        c.fillStyle = i === 0 ? P.label : P.labelDim;
        c.fillRect(-w / 2 + 9 * s, -h / 2 + (12 + i * 12) * s, lw - 9 * s, (i === 0 ? 4 : 2.5) * s);
      }
      if (s > 0.6) {
        c.globalAlpha = 0.9 * (s - 0.6) / 0.4;
        c.font = `500 ${Math.round(9 * s + 1)}px "JetBrains Mono", monospace`;
        c.fillStyle = P.accent;
        c.textAlign = "center";
        c.fillText(d.label, 0, h / 2 + 6);
      }
      c.restore();
    } else {
      // Dissolve: a burst of sparks at the target.
      const f = (k - 1) / 0.35;
      c.globalCompositeOperation = blend;
      for (let i = 0; i < 14; i++) {
        const a = (i / 14) * Math.PI * 2 + hash(d.to) * 6;
        const dist = 8 + 46 * easeOut(f) * (0.6 + 0.4 * ((i * 7) % 5) / 5);
        this.glow(target.x + Math.cos(a) * dist, target.y + Math.sin(a) * dist, 7, P.accent, 1 - f);
      }
      this.glow(target.x, target.y, 60 * (1 - f) + 10, P.accent, 0.8 * (1 - f));
      c.globalCompositeOperation = "source-over";
    }
    c.globalAlpha = 1;
  }
}

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

/** "#rrggbb" (or "#rgb") to an rgba() string; other formats pass through unchanged. */
function rgba(color: string, alpha: number): string {
  let hex = color.replace("#", "");
  if (!/^[0-9a-f]{3}([0-9a-f]{3})?$/i.test(hex)) return color;
  if (hex.length === 3) hex = hex.split("").map((ch) => ch + ch).join("");
  const n = parseInt(hex, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
