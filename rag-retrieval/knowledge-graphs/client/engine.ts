// The canvas renderer. Two full-viewport canvases:
//   back  stars (with parallax), graph edges, glowing nodes, labels, hero words
//   front flying labels and flashes, which travel over the page's panels
// The graph lives in world coordinates (data/layout.json, about 960 × 660)
// and is mapped into a "slot": the hero section or the sticky stage panel,
// whichever is on screen. The camera pans and zooms inside the slot.
//
// Scenes don't draw; they describe a Frame (what is lit, hot, drawn, flying)
// and the engine eases the display toward it every animation frame.

import type { Graph } from "../src/graph.ts";

export type Rect = { x: number; y: number; w: number; h: number };
export interface Camera {
  x: number;
  y: number;
  z: number;
}

export interface NodeTarget {
  lit: number; // 0 = ghost point, 1 = fully lit with label
  hot?: number; // on the active traversal
  flare?: number; // momentary extra glow (arrival, fusion)
}
export interface EdgeTarget {
  draw: number; // 0..1 how much of the edge is drawn
  hot?: number;
  pulse?: number; // position of a travelling light, 0..1 from source side of the hop
  reverse?: boolean; // pulse travels target → source
  label?: boolean;
}
export interface FlyLabel {
  text: string;
  type: string;
  x: number; // screen
  y: number;
  alpha: number;
  size: number; // px
  glow: number; // 0..1
}
export interface Flash {
  x: number;
  y: number;
  r: number; // px
  alpha: number;
  type: string;
}
export interface HeroWord {
  text: string;
  type: string | null;
  x: number; // world
  y: number;
  alpha: number;
  glow: number;
  size: number; // world units
}
export interface Frame {
  nodes: Map<string, NodeTarget>;
  edges: Map<string, EdgeTarget>;
  ghost: number; // alpha of unlit nodes
  labels: FlyLabel[]; // front canvas
  flashes: Flash[]; // front canvas
  worldFlashes?: { id: string; r: number; alpha: number }[]; // flashes at a node, in world space
  words?: HeroWord[]; // back canvas, world space
  camera: Camera;
  instantCamera?: boolean;
  clipLabels?: boolean; // keep flying labels inside the graph's slot
}

export const WORLD = { x: 480, y: 330, w: 940, h: 680 };
export const HOME: Camera = { x: WORLD.x, y: WORLD.y, z: 1 };

const TYPE_COLORS: Record<string, { dark: string; light: string }> = {
  Person: { dark: "#ff6b8b", light: "#e11d48" },
  Team: { dark: "#8b93ff", light: "#4f46e5" },
  Service: { dark: "#4cc3ff", light: "#0284c7" },
  Product: { dark: "#3ff0d0", light: "#0d9488" },
  Component: { dark: "#b18cff", light: "#7c3aed" },
  Company: { dark: "#ffc24d", light: "#d97706" },
  Customer: { dark: "#62f08f", light: "#16a34a" },
};

export const typeColor = (type: string, dark: boolean) => (TYPE_COLORS[type] ?? { dark: "#ffffff", light: "#18181b" })[dark ? "dark" : "light"];

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

interface Display {
  lit: number;
  hot: number;
  flare: number;
}
interface EdgeDisplay {
  draw: number;
  hot: number;
}

export class Engine {
  private back: CanvasRenderingContext2D;
  private front: CanvasRenderingContext2D;
  private dpr = 1;
  private W = 0;
  private H = 0;
  private sprites = new Map<string, HTMLCanvasElement>();
  private nodeDisp = new Map<string, Display>();
  private edgeDisp = new Map<string, EdgeDisplay>();
  private stars: { x: number; y: number; d: number; r: number; tw: number }[] = [];
  private pointer = { x: 0, y: 0, sx: 0, sy: 0 };
  private last = performance.now();
  private rectNow: Rect | null = null;

  camera: Camera = { ...HOME };
  userCamera: Camera | null = null; // set while the visitor pans or zooms
  dark = true;
  reduced = false;
  frozen = false; // ?t= screenshots: no drift, no idle pulses
  hover: string | null = null;
  clock = 0;
  private bend = new Map<string, number>();

  constructor(
    backCanvas: HTMLCanvasElement,
    frontCanvas: HTMLCanvasElement,
    private graph: Graph,
    private layout: Record<string, number[]>,
  ) {
    this.back = backCanvas.getContext("2d")!;
    this.front = frontCanvas.getContext("2d")!;
    this.resize();
    addEventListener("resize", () => this.resize());
    addEventListener("pointermove", (e) => {
      this.pointer.x = e.clientX / Math.max(1, this.W) - 0.5;
      this.pointer.y = e.clientY / Math.max(1, this.H) - 0.5;
    });
    // Seeded stars, so frames are repeatable.
    let s = 7;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 240; i++) this.stars.push({ x: rnd(), y: rnd(), d: 0.15 + rnd() * 0.85, r: 0.4 + rnd() * 1.1, tw: rnd() * 6.28 });
    // Two relations between the same pair of nodes bow apart as curves.
    for (const e of graph.edges) {
      const pair = graph.edges.filter((o) => (o.source === e.source && o.target === e.target) || (o.source === e.target && o.target === e.source));
      this.bend.set(e.id, pair.length > 1 ? (pair.indexOf(e) - (pair.length - 1) / 2) * 120 : 0);
    }
  }

  private resize() {
    this.dpr = Math.min(2, devicePixelRatio || 1);
    this.W = innerWidth;
    this.H = innerHeight;
    for (const ctx of [this.back, this.front]) {
      ctx.canvas.width = Math.round(this.W * this.dpr);
      ctx.canvas.height = Math.round(this.H * this.dpr);
      ctx.canvas.style.width = `${this.W}px`;
      ctx.canvas.style.height = `${this.H}px`;
    }
  }

  /** A soft radial glow, pre-rendered once per colour so drawing it is cheap. */
  private sprite(color: string): HTMLCanvasElement {
    let c = this.sprites.get(color);
    if (c) return c;
    c = document.createElement("canvas");
    c.width = c.height = 128;
    const g = c.getContext("2d")!;
    const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, color);
    grad.addColorStop(0.18, `${color}cc`);
    grad.addColorStop(0.45, `${color}33`);
    grad.addColorStop(1, `${color}00`);
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    this.sprites.set(color, c);
    return c;
  }

  // --- coordinates ------------------------------------------------------------

  rect(): Rect {
    return this.rectNow ?? { x: 0, y: 0, w: this.W, h: this.H };
  }
  private baseScale(r: Rect) {
    return Math.min(r.w / WORLD.w, r.h / WORLD.h) * 0.94;
  }
  scale(): number {
    return this.baseScale(this.rect()) * this.camera.z;
  }
  /** World position of a node, with a slow drift. */
  pos(id: string): [number, number] {
    const p = this.layout[this.graph.nodes.get(id)!.name];
    if (this.reduced || this.frozen) return [p[0], p[1]];
    const ph = p[0] * 0.013 + p[1] * 0.021;
    return [p[0] + Math.sin(this.clock * 0.32 + ph) * 7, p[1] + Math.cos(this.clock * 0.27 + ph * 1.3) * 6];
  }
  toScreen(wx: number, wy: number): [number, number] {
    const r = this.rect();
    const s = this.scale();
    return [r.x + r.w / 2 + (wx - this.camera.x) * s, r.y + r.h / 2 + (wy - this.camera.y) * s];
  }
  toWorld(sx: number, sy: number): [number, number] {
    const r = this.rect();
    const s = this.scale();
    return [(sx - r.x - r.w / 2) / s + this.camera.x, (sy - r.y - r.h / 2) / s + this.camera.y];
  }
  nodeScreen(id: string): [number, number] {
    const [x, y] = this.pos(id);
    return this.toScreen(x, y);
  }
  /** The node under a screen point, if any. */
  hit(sx: number, sy: number): string | null {
    let best: string | null = null;
    let bestD = 22;
    for (const id of this.graph.nodes.keys()) {
      if ((this.nodeDisp.get(id)?.lit ?? 0) < 0.5) continue;
      const [x, y] = this.nodeScreen(id);
      const d = Math.hypot(x - sx, y - sy);
      if (d < bestD) {
        bestD = d;
        best = id;
      }
    }
    return best;
  }
  /** Camera that frames a set of world points inside the slot. */
  fit(ids: string[], maxZoom = 1.9): Camera {
    if (!ids.length) return { ...HOME };
    const pts = ids.map((id) => this.layout[this.graph.nodes.get(id)!.name]);
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs) - 130, Math.max(...xs) + 130, Math.min(...ys) - 90, Math.max(...ys) + 110];
    const z = Math.max(0.9, Math.min(maxZoom, Math.min(WORLD.w / (x1 - x0), WORLD.h / (y1 - y0))));
    return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, z };
  }

  // --- the frame ----------------------------------------------------------------

  render(frame: Frame, slot: Rect) {
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    if (!this.reduced && !this.frozen) this.clock += dt;
    const k = this.reduced || this.frozen ? 1 : 1 - Math.exp(-dt * 9);
    const kCam = this.reduced || this.frozen || frame.instantCamera ? 1 : 1 - Math.exp(-dt * 3.2);

    // The slot glides between the hero and the stage as the page scrolls.
    this.rectNow = this.rectNow && !this.reduced ? { x: lerp(this.rectNow.x, slot.x, kCam * 1.6 > 1 ? 1 : kCam * 1.6), y: lerp(this.rectNow.y, slot.y, Math.min(1, kCam * 1.6)), w: lerp(this.rectNow.w, slot.w, Math.min(1, kCam * 1.6)), h: lerp(this.rectNow.h, slot.h, Math.min(1, kCam * 1.6)) } : { ...slot };
    const target = this.userCamera ?? frame.camera;
    this.camera = { x: lerp(this.camera.x, target.x, kCam), y: lerp(this.camera.y, target.y, kCam), z: lerp(this.camera.z, target.z, kCam) };
    this.pointer.sx = lerp(this.pointer.sx, this.pointer.x, k * 0.3);
    this.pointer.sy = lerp(this.pointer.sy, this.pointer.y, k * 0.3);

    for (const id of this.graph.nodes.keys()) {
      const t = frame.nodes.get(id);
      const d = this.nodeDisp.get(id) ?? { lit: 0, hot: 0, flare: 0 };
      d.lit = lerp(d.lit, t?.lit ?? 0, k);
      d.hot = lerp(d.hot, t?.hot ?? 0, k);
      d.flare = lerp(d.flare, t?.flare ?? 0, Math.min(1, k * 1.5));
      this.nodeDisp.set(id, d);
    }
    for (const e of this.graph.edges) {
      const t = frame.edges.get(e.id);
      const d = this.edgeDisp.get(e.id) ?? { draw: 0, hot: 0 };
      // Drawing in follows the scene exactly; fading out is eased.
      d.draw = (t?.draw ?? 0) >= d.draw ? (t?.draw ?? 0) : lerp(d.draw, t?.draw ?? 0, k);
      d.hot = lerp(d.hot, t?.hot ?? 0, k);
      this.edgeDisp.set(e.id, d);
    }

    this.drawBack(frame);
    this.drawFront(frame);
  }

  private drawBack(frame: Frame) {
    const ctx = this.back;
    const { dpr, W, H } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // Stars, in layers that shift with the camera and the pointer.
    const s = this.scale();
    const camDx = (this.camera.x - HOME.x) * s;
    const camDy = (this.camera.y - HOME.y) * s;
    ctx.fillStyle = this.dark ? "#cfd8ff" : "#64748b";
    for (const st of this.stars) {
      const px = (((st.x * W - camDx * st.d * 0.12 - this.pointer.sx * 26 * st.d) % W) + W) % W;
      const py = (((st.y * H - camDy * st.d * 0.12 - this.pointer.sy * 18 * st.d) % H) + H) % H;
      const tw = this.reduced || this.frozen ? 0.7 : 0.55 + 0.45 * Math.sin(this.clock * 1.3 + st.tw);
      ctx.globalAlpha = (this.dark ? 0.55 : 0.22) * st.d * tw;
      ctx.beginPath();
      ctx.arc(px, py, st.r * (this.dark ? 1 : 0.8), 0, 6.283);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    const scale = this.scale();
    const fontPx = Math.max(11, Math.min(15, 14 * scale));

    // Edges.
    for (const e of this.graph.edges) {
      const d = this.edgeDisp.get(e.id)!;
      if (d.draw <= 0.002) continue;
      const pts = this.curve(e.id, e.source, e.target);
      const n = Math.max(1, Math.round(d.draw * (pts.length - 1)));
      const t = frame.edges.get(e.id);
      const focusDim = frame.nodes.size && [...frame.edges.values()].some((x) => (x.hot ?? 0) > 0.5) && d.hot < 0.3 ? 0.35 : 1;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i <= n; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      const base = this.dark ? "rgba(190,205,255," : "rgba(51,65,85,";
      ctx.strokeStyle = `${base}${(0.2 + 0.1 * (this.hover && (e.source === this.hover || e.target === this.hover) ? 3 : 0)) * focusDim})`;
      ctx.lineWidth = 1.2;
      ctx.stroke();
      if (d.hot > 0.02) {
        const hotColor = this.dark ? "94,234,212" : "13,148,136";
        ctx.strokeStyle = `rgba(${hotColor},${0.22 * d.hot})`;
        ctx.lineWidth = 9;
        ctx.stroke();
        ctx.strokeStyle = `rgba(${hotColor},${0.95 * d.hot})`;
        ctx.lineWidth = 2.4;
        ctx.stroke();
      }
      // Arrowhead at the target end, once the edge is drawn.
      if (d.draw > 0.97) {
        const [ax, ay] = pts[pts.length - 1];
        const [bx, by] = pts[pts.length - 3];
        const ang = Math.atan2(ay - by, ax - bx);
        ctx.fillStyle = d.hot > 0.3 ? (this.dark ? "#5eead4" : "#0d9488") : `${base}${0.45 * focusDim})`;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(ax - 8 * Math.cos(ang - 0.42), ay - 8 * Math.sin(ang - 0.42));
        ctx.lineTo(ax - 8 * Math.cos(ang + 0.42), ay - 8 * Math.sin(ang + 0.42));
        ctx.closePath();
        ctx.fill();
      }
      // Idle light, now and then, along drawn edges; travelling pulses on the active path.
      let pulse = t?.pulse;
      if (pulse === undefined && !this.reduced && !this.frozen && d.draw > 0.99) {
        const ph = (this.clock * 0.16 + (e.id.length * 0.137) % 1) % 1;
        if (ph < 0.3) pulse = ph / 0.3;
      }
      if (pulse !== undefined && pulse >= 0 && pulse <= 1) {
        const p = t?.reverse ? 1 - pulse : pulse;
        const [px, py] = pts[Math.round(p * (pts.length - 1))];
        const strong = t?.pulse !== undefined;
        const spr = this.sprite(strong ? (this.dark ? "#a7fff0" : "#0d9488") : this.dark ? "#c7d2fe" : "#64748b");
        const size = strong ? 46 : 18;
        ctx.globalAlpha = strong ? 1 : 0.5 * focusDim;
        ctx.drawImage(spr, px - size / 2, py - size / 2, size, size);
        ctx.globalAlpha = 1;
      }
    }

    // Nodes.
    for (const [id, node] of this.graph.nodes) {
      const d = this.nodeDisp.get(id)!;
      const [x, y] = this.nodeScreen(id);
      const color = typeColor(node.type, this.dark);
      const ghostA = frame.ghost * (1 - d.lit);
      if (ghostA > 0.01) {
        ctx.globalAlpha = ghostA;
        ctx.fillStyle = this.dark ? "#9aa6c8" : "#94a3b8";
        ctx.beginPath();
        ctx.arc(x, y, 2.2, 0, 6.283);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      if (d.lit < 0.01) continue;
      const anyHot = [...frame.nodes.values()].some((n) => (n.hot ?? 0) > 0.5);
      const dim = anyHot && d.hot < 0.3 && this.hover !== id ? 0.38 : 1;
      const glow = (0.75 + d.hot * 0.7 + d.flare * 1.4 + (this.hover === id ? 0.5 : 0)) * d.lit;
      const g = 78 * Math.min(2.4, glow) * Math.max(0.75, Math.min(1.25, scale));
      ctx.globalAlpha = Math.min(1, (this.dark ? 0.85 : 0.45) * dim * Math.min(1, glow));
      ctx.drawImage(this.sprite(color), x - g / 2, y - g / 2, g, g);
      ctx.globalAlpha = d.lit * dim;
      const r = (5.2 + d.hot * 1.8 + d.flare * 2) * Math.max(0.85, Math.min(1.3, scale));
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, 6.283);
      ctx.fill();
      ctx.fillStyle = this.dark ? "#ffffff" : "#ffffff";
      ctx.globalAlpha = d.lit * dim * (0.55 + 0.45 * d.hot);
      ctx.beginPath();
      ctx.arc(x, y, r * 0.45, 0, 6.283);
      ctx.fill();
      // A dashed ring marks an entity merged from several names.
      if (node.aliases.length) {
        ctx.globalAlpha = d.lit * dim * 0.7;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.setLineDash([2.5, 3]);
        ctx.beginPath();
        ctx.arc(x, y, r + 5.5, 0, 6.283);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      // Label.
      const la = Math.max(0, (d.lit - 0.35) / 0.65) * dim;
      if (la > 0.01) {
        ctx.globalAlpha = la;
        ctx.font = `${d.hot > 0.5 || this.hover === id ? 600 : 500} ${fontPx}px Inter, system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.lineJoin = "round";
        ctx.strokeStyle = this.dark ? "rgba(5,7,15,0.85)" : "rgba(250,250,247,0.9)";
        ctx.lineWidth = 4;
        ctx.strokeText(node.name, x, y + r + 8);
        ctx.fillStyle = this.dark ? (d.hot > 0.5 ? "#ffffff" : "#d7def0") : d.hot > 0.5 ? "#0f172a" : "#334155";
        ctx.fillText(node.name, x, y + r + 8);
      }
      ctx.globalAlpha = 1;
    }

    // Edge labels: on the active path, and around the hovered node.
    for (const e of this.graph.edges) {
      const d = this.edgeDisp.get(e.id)!;
      const t = frame.edges.get(e.id);
      const show = (t?.label && d.hot > 0.4) || (this.hover && (e.source === this.hover || e.target === this.hover) && d.draw > 0.9);
      if (!show) continue;
      const [lx, ly] = this.labelPoint(e.id, e.source, e.target);
      ctx.font = `600 ${Math.max(10, fontPx - 3)}px "JetBrains Mono", ui-monospace, monospace`;
      const w = ctx.measureText(e.type).width + 12;
      const h = Math.max(10, fontPx - 3) + 8;
      ctx.globalAlpha = 0.95;
      ctx.fillStyle = this.dark ? "rgba(8,12,24,0.92)" : "rgba(255,255,255,0.95)";
      ctx.strokeStyle = this.dark ? "rgba(94,234,212,0.55)" : "rgba(13,148,136,0.5)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(lx - w / 2, ly - h / 2, w, h, 5);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = this.dark ? "#99f6e4" : "#0f766e";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(e.type, lx, ly + 0.5);
      ctx.globalAlpha = 1;
    }

    // Hero words (world space).
    for (const w of frame.words ?? []) {
      if (w.alpha < 0.01) continue;
      const [sx, sy] = this.toScreen(w.x, w.y);
      const px = Math.max(10, w.size * scale);
      ctx.font = `${w.type ? 500 : 400} ${px}px Inter, system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      if (w.type && w.glow > 0.02) {
        const c = typeColor(w.type, this.dark);
        const g = px * 5 * (0.6 + w.glow);
        ctx.globalAlpha = w.alpha * w.glow * (this.dark ? 0.55 : 0.3);
        ctx.drawImage(this.sprite(c), sx - g / 2, sy - g / 2, g, g);
        ctx.globalAlpha = w.alpha;
        ctx.fillStyle = mix(this.dark ? "#cbd5e1" : "#475569", c, w.glow);
      } else {
        ctx.globalAlpha = w.alpha;
        ctx.fillStyle = this.dark ? "#8b95b3" : "#64748b";
      }
      ctx.fillText(w.text, sx, sy);
    }
    ctx.globalAlpha = 1;

    // Flashes anchored to nodes.
    for (const f of frame.worldFlashes ?? []) this.ring(ctx, ...this.nodeScreen(f.id), f.r, f.alpha, this.graph.nodes.get(f.id)!.type);
  }

  private drawFront(frame: Frame) {
    const ctx = this.front;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.W, this.H);
    ctx.save();
    if (frame.clipLabels) {
      const r = this.rect();
      ctx.beginPath();
      ctx.rect(r.x, r.y, r.w, r.h);
      ctx.clip();
    }
    for (const f of frame.flashes) this.ring(ctx, f.x, f.y, f.r, f.alpha, f.type);
    for (const l of frame.labels) {
      if (l.alpha < 0.01) continue;
      const c = typeColor(l.type, this.dark);
      ctx.font = `600 ${l.size}px Inter, system-ui, sans-serif`;
      const w = ctx.measureText(l.text).width + 16;
      const h = l.size + 10;
      if (l.glow > 0.02) {
        const g = w * 1.6;
        ctx.globalAlpha = l.alpha * l.glow * (this.dark ? 0.5 : 0.25);
        ctx.drawImage(this.sprite(c), l.x - g / 2, l.y - g / 2, g, g);
      }
      ctx.globalAlpha = l.alpha;
      ctx.fillStyle = this.dark ? "rgba(10,14,28,0.88)" : "rgba(255,255,255,0.94)";
      ctx.strokeStyle = c;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.roundRect(l.x - w / 2, l.y - h / 2, w, h, h / 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = this.dark ? "#ffffff" : "#0f172a";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(l.text, l.x, l.y + 0.5);
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  private ring(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, alpha: number, type: string) {
    if (alpha < 0.01) return;
    const c = typeColor(type, this.dark);
    ctx.globalAlpha = alpha * 0.6;
    ctx.drawImage(this.sprite(c), x - r, y - r, r * 2, r * 2);
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = c;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, r * 0.7, 0, 6.283);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  /** Points along an edge, in screen space, trimmed at both nodes. */
  curve(edgeId: string, from: string, to: string, n = 24): [number, number][] {
    const [x1, y1] = this.nodeScreen(from);
    const [x2, y2] = this.nodeScreen(to);
    const len = Math.hypot(x2 - x1, y2 - y1) || 1;
    const [nx, ny] = [-(y2 - y1) / len, (x2 - x1) / len];
    const b = (this.bend.get(edgeId) ?? 0) * this.scale();
    const [cx, cy] = [(x1 + x2) / 2 + nx * b, (y1 + y2) / 2 + ny * b];
    const pts: [number, number][] = [];
    const trim = 12 / Math.max(len, 1);
    for (let i = 0; i <= n; i++) {
      const t = trim + (i / n) * (1 - 2.2 * trim);
      const u = 1 - t;
      pts.push([u * u * x1 + 2 * u * t * cx + t * t * x2, u * u * y1 + 2 * u * t * cy + t * t * y2]);
    }
    return pts;
  }
  /** Where an edge's label sits: the middle of its curve, nudged outward. */
  labelPoint(edgeId: string, from: string, to: string): [number, number] {
    const [x1, y1] = this.nodeScreen(from);
    const [x2, y2] = this.nodeScreen(to);
    const len = Math.hypot(x2 - x1, y2 - y1) || 1;
    const [nx, ny] = [-(y2 - y1) / len, (x2 - x1) / len];
    const bend = this.bend.get(edgeId) ?? 0;
    const off = bend ? (bend * this.scale()) / 2 + Math.sign(bend) * 4 : -12;
    return [(x1 + x2) / 2 + nx * off, (y1 + y2) / 2 + ny * off];
  }
}

function mix(a: string, b: string, t: number) {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return `rgb(${pa.map((v, i) => Math.round(v + (pb[i] - v) * Math.max(0, Math.min(1, t)))).join(",")})`;
}
