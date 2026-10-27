// The canvas renderer, drawn like a technical diagram: small ink shapes for
// entities (the shape is the type), thin grey edges, labels with a paper
// knock-out so they stay readable, and one accent colour for the active path.
//
// Two full-viewport canvases:
//   back   the graph (clipped to the area no overlay covers) and hero words
//   front  labels that travel from the document into the graph
// The graph lives in world coordinates (data/layout.json, about 960 × 660)
// and is fitted into a rectangle the page supplies: the hero, or the part of
// the stage that the controls, caption and verdict leave clear.
//
// Scenes don't draw; they describe a Frame, and the engine eases toward it.

import type { Graph } from "../src/graph.ts";

export type Rect = { x: number; y: number; w: number; h: number };
export interface Camera {
  x: number;
  y: number;
  z: number;
}
export interface NodeTarget {
  lit: number; // 0 = faint point, 1 = drawn with its label
  hot?: number; // on the active traversal
}
export interface EdgeTarget {
  draw: number; // 0..1 how much of the edge is drawn
  path?: number; // 0..1 how much of the accent path line is drawn over it
  reverse?: boolean; // the path runs target → source
  label?: boolean;
}
export interface FlyLabel {
  text: string;
  type: string;
  x: number; // screen
  y: number;
  alpha: number;
}
export interface HeroWord {
  text: string;
  type: string | null;
  x: number; // world
  y: number;
  alpha: number;
  ink: number; // 0 = grey word, 1 = ink entity
}
export interface Frame {
  nodes: Map<string, NodeTarget>;
  edges: Map<string, EdgeTarget>;
  ghost: number; // opacity of not-yet-extracted entities
  labels: FlyLabel[];
  words?: HeroWord[];
  camera: Camera;
  clipLabels?: boolean;
}

export interface Palette {
  paper: string;
  ink: string;
  grey: string;
  faint: string;
  rule: string;
  accent: string;
}

export const WORLD = { x: 480, y: 330, w: 940, h: 690 };
export const HOME: Camera = { x: WORLD.x, y: WORLD.y, z: 1 };

/** Each entity type is a shape, filled or outlined. */
export const SHAPES: Record<string, { shape: "circle" | "square" | "diamond" | "triangle"; filled: boolean; glyph: string }> = {
  Person: { shape: "circle", filled: true, glyph: "●" },
  Team: { shape: "circle", filled: false, glyph: "○" },
  Service: { shape: "diamond", filled: false, glyph: "◇" },
  Product: { shape: "square", filled: true, glyph: "■" },
  Component: { shape: "square", filled: false, glyph: "□" },
  Company: { shape: "triangle", filled: true, glyph: "▲" },
  Customer: { shape: "diamond", filled: true, glyph: "◆" },
};

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
type Box = { x: number; y: number; w: number; h: number };
const hits = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Label positions around a node: below, above, right, left, then the four diagonals. */
const SIDES = 8;
function labelBox(side: number, x: number, y: number, w: number, h: number, gap: number): Box {
  switch (side) {
    case 0: return { x: x - w / 2, y: y + gap - 1, w, h };
    case 1: return { x: x - w / 2, y: y - gap - h + 1, w, h };
    case 2: return { x: x + gap + 2, y: y - h / 2, w, h };
    case 3: return { x: x - gap - 2 - w, y: y - h / 2, w, h };
    case 4: return { x: x + gap - 3, y: y + gap - 4, w, h };
    case 5: return { x: x - gap + 3 - w, y: y + gap - 4, w, h };
    case 6: return { x: x + gap - 3, y: y - gap - h + 4, w, h };
    default: return { x: x - gap + 3 - w, y: y - gap - h + 4, w, h };
  }
}

/** A point at fraction f along a polyline, pushed `off` units along its normal. */
function along(pts: [number, number][], f: number, off: number): [number, number] {
  const i = Math.min(pts.length - 2, Math.round(f * (pts.length - 1)));
  const [px, py] = pts[i];
  const [qx, qy] = pts[i + 1];
  const len = Math.hypot(qx - px, qy - py) || 1;
  return [px - ((qy - py) / len) * off, py + ((qx - px) / len) * off];
}

export class Engine {
  private back: CanvasRenderingContext2D;
  private front: CanvasRenderingContext2D;
  private dpr = 1;
  private W = 0;
  private H = 0;
  private nodeDisp = new Map<string, { lit: number; hot: number }>();
  private edgeDisp = new Map<string, { draw: number; path: number }>();
  private last = performance.now();
  private rectNow: Rect | null = null;
  private bend = new Map<string, number>();

  camera: Camera = { ...HOME };
  userCamera: Camera | null = null;
  reduced = false;
  frozen = false;
  hover: string | null = null;
  /** Debug: label side per node in the last frame (?trace=1 records it). */
  lastSides = new Map<string, number>();
  // Label placement is computed once for the whole graph (in world space,
  // against every edge) and kept, so labels never jump while a scene plays.
  private labelSide = new Map<string, number>();
  private edgeSpot = new Map<string, { f: number; off: number }>();
  private labelsReady = false;
  private focus = 0; // eased 0..1: how strongly everything off the active path is dimmed
  palette: Palette = { paper: "#faf9f7", ink: "#1b1b19", grey: "#6f6e69", faint: "#a9a7a0", rule: "#e3e1db", accent: "#2f4f7f" };

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
    // Two relations between the same pair of nodes bow apart as curves.
    for (const e of graph.edges) {
      const pair = graph.edges.filter((o) => (o.source === e.source && o.target === e.target) || (o.source === e.target && o.target === e.source));
      const sign = e.source < e.target ? 1 : -1;
      this.bend.set(e.id, pair.length > 1 ? (pair.indexOf(e) - (pair.length - 1) / 2) * 90 * sign : 0);
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

  // --- coordinates --------------------------------------------------------------

  rect(): Rect {
    return this.rectNow ?? { x: 0, y: 0, w: this.W, h: this.H };
  }
  scale(): number {
    const r = this.rect();
    return Math.min(r.w / WORLD.w, r.h / WORLD.h) * 0.96 * this.camera.z;
  }
  pos(id: string): [number, number] {
    const p = this.layout[this.graph.nodes.get(id)!.name];
    return [p[0], p[1]];
  }
  toScreen(wx: number, wy: number): [number, number] {
    const r = this.rect();
    const s = this.scale();
    return [r.x + r.w / 2 + (wx - this.camera.x) * s, r.y + r.h / 2 + (wy - this.camera.y) * s];
  }
  nodeScreen(id: string): [number, number] {
    return this.toScreen(...this.pos(id));
  }
  hit(sx: number, sy: number): string | null {
    let best: string | null = null;
    let bestD = 18;
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
  /** Camera that frames a set of nodes, never zoomed in so far that labels crowd the edges. */
  fit(ids: string[], maxZoom = 1.6): Camera {
    if (!ids.length) return { ...HOME };
    const pts = ids.map((id) => this.layout[this.graph.nodes.get(id)!.name]);
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs) - 140, Math.max(...xs) + 140, Math.min(...ys) - 80, Math.max(...ys) + 110];
    const z = Math.max(1, Math.min(maxZoom, Math.min(WORLD.w / (x1 - x0), WORLD.h / (y1 - y0))));
    return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, z };
  }

  // --- the frame ------------------------------------------------------------------

  render(frame: Frame, area: Rect) {
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    const still = this.reduced || this.frozen;
    const k = still ? 1 : 1 - Math.exp(-dt * 8);
    const kCam = still ? 1 : 1 - Math.exp(-dt * 3);

    // The graph's area glides to a new size (when the verdict lands): eased, and
    // never more than a few pixels per frame, so it never jumps.
    const glide = (a: number, b: number) => {
      const d = (b - a) * kCam;
      const max = 7 * (dt / (1 / 60));
      return a + Math.max(-max, Math.min(max, d));
    };
    this.rectNow = this.rectNow && !still ? { x: glide(this.rectNow.x, area.x), y: glide(this.rectNow.y, area.y), w: glide(this.rectNow.w, area.w), h: glide(this.rectNow.h, area.h) } : { ...area };
    const target = this.userCamera ?? frame.camera;
    this.camera = { x: lerp(this.camera.x, target.x, kCam), y: lerp(this.camera.y, target.y, kCam), z: lerp(this.camera.z, target.z, kCam) };

    for (const id of this.graph.nodes.keys()) {
      const t = frame.nodes.get(id);
      const d = this.nodeDisp.get(id) ?? { lit: 0, hot: 0 };
      d.lit = lerp(d.lit, t?.lit ?? 0, k);
      d.hot = lerp(d.hot, t?.hot ?? 0, k);
      this.nodeDisp.set(id, d);
    }
    for (const e of this.graph.edges) {
      const t = frame.edges.get(e.id);
      const d = this.edgeDisp.get(e.id) ?? { draw: 0, path: 0 };
      // Lines draw in exactly with the scene; they fade out gently.
      d.draw = (t?.draw ?? 0) >= d.draw ? (t?.draw ?? 0) : lerp(d.draw, t?.draw ?? 0, k);
      d.path = (t?.path ?? 0) >= d.path ? (t?.path ?? 0) : lerp(d.path, t?.path ?? 0, k);
      this.edgeDisp.set(e.id, d);
    }
    const wantFocus = [...frame.edges.values()].some((x) => (x.path ?? 0) > 0) || [...frame.nodes.values()].some((n) => (n.hot ?? 0) > 0.5);
    this.focus = lerp(this.focus, wantFocus ? 1 : 0, still ? 1 : 1 - Math.exp(-dt * 6));
    if (!this.labelsReady) this.layoutLabels();
    this.drawBack(frame);
    this.drawFront(frame);
  }

  /** Recompute label placement, e.g. once web fonts have loaded and text widths changed. */
  invalidateLabels() {
    this.labelsReady = false;
  }

  /**
   * Choose, once, where every node label and every relation name goes. Uses
   * the full graph in world coordinates (every edge, every node), so the
   * choice does not depend on what is drawn or lit at a given moment.
   */
  private layoutLabels() {
    const ctx = this.back;
    const fontPx = 12.5;
    const nodeR = 4.6;
    const gap = nodeR + 6;
    const edgePts: [number, number][] = [];
    for (const e of this.graph.edges) edgePts.push(...this.curveWorld(e.id, e.source, e.target, 48));
    const nodeBoxes: Box[] = [...this.graph.nodes.keys()].map((id) => {
      const [x, y] = this.pos(id);
      return { x: x - nodeR - 5, y: y - nodeR - 5, w: 2 * nodeR + 10, h: 2 * nodeR + 10 };
    });
    const labelBoxes: Box[] = [];
    ctx.font = `450 ${fontPx}px Inter, system-ui, sans-serif`;
    for (const [id, node] of this.graph.nodes) {
      const [x, y] = this.pos(id);
      const w = ctx.measureText(node.name).width + 4;
      const h = fontPx + 3;
      let best = 0;
      let bestScore = Infinity;
      for (let side = 0; side < SIDES; side++) {
        const b = labelBox(side, x, y, w, h, gap);
        const inside = edgePts.filter(([px, py]) => px > b.x - 1 && px < b.x + b.w + 1 && py > b.y - 1 && py < b.y + b.h + 1).length;
        const overlap = labelBoxes.filter((o) => hits(b, o)).length + nodeBoxes.filter((o) => hits(b, o)).length;
        const outside = b.x < 0 || b.x + b.w > 960 || b.y < -10 || b.y + b.h > 680 ? 1 : 0;
        const score = inside * 3 + overlap * 20 + outside * 60 + side * 0.6;
        if (score < bestScore) {
          bestScore = score;
          best = side;
        }
      }
      this.labelSide.set(id, best);
      labelBoxes.push(labelBox(best, x, y, w, h, gap));
    }
    // Relation names: the first spot along each edge that touches no node, no label and no earlier relation name.
    const placed: Box[] = [];
    ctx.font = `500 10.5px "JetBrains Mono", ui-monospace, monospace`;
    for (const e of this.graph.edges) {
      const pts = this.curveWorld(e.id, e.source, e.target, 24);
      const w = ctx.measureText(e.type).width + 8;
      const h = 15;
      let spot = { f: 0.5, off: 0 };
      outer: for (const f of [0.5, 0.4, 0.6, 0.32, 0.68, 0.25, 0.75, 0.18, 0.82]) {
        for (const off of [0, 12, -12]) {
          const [cx, cy] = along(pts, f, off);
          const b = { x: cx - w / 2 - 4, y: cy - h / 2 - 3, w: w + 8, h: h + 6 };
          if ([...labelBoxes, ...nodeBoxes, ...placed].some((o) => hits(b, o))) continue;
          spot = { f, off };
          placed.push(b);
          break outer;
        }
      }
      this.edgeSpot.set(e.id, spot);
    }
    this.labelsReady = true;
  }

  private shape(ctx: CanvasRenderingContext2D, type: string, x: number, y: number, r: number, color: string, paper: string) {
    const s = SHAPES[type] ?? SHAPES.Person;
    ctx.beginPath();
    if (s.shape === "circle") ctx.arc(x, y, r, 0, 6.283);
    if (s.shape === "square") ctx.rect(x - r * 0.88, y - r * 0.88, r * 1.76, r * 1.76);
    if (s.shape === "diamond") {
      ctx.moveTo(x, y - r * 1.2);
      ctx.lineTo(x + r * 1.2, y);
      ctx.lineTo(x, y + r * 1.2);
      ctx.lineTo(x - r * 1.2, y);
      ctx.closePath();
    }
    if (s.shape === "triangle") {
      ctx.moveTo(x, y - r * 1.15);
      ctx.lineTo(x + r * 1.1, y + r * 0.8);
      ctx.lineTo(x - r * 1.1, y + r * 0.8);
      ctx.closePath();
    }
    ctx.fillStyle = s.filled ? color : paper;
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    ctx.stroke();
  }

  private drawBack(frame: Frame) {
    const ctx = this.back;
    const P = this.palette;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.W, this.H);
    const r = this.rect();
    // Nothing is drawn outside the clear area, so no overlay ever covers the graph.
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x - 4, r.y - 4, r.w + 8, r.h + 8);
    ctx.clip();

    const scale = this.scale();
    const fontPx = Math.max(11, Math.min(13, 12.5 * scale));
    const nodeR = Math.max(3.4, Math.min(5.2, 4.6 * scale));
    const focus = this.focus;

    // Edges: thin grey lines with small arrowheads; the path drawn over them in the accent.
    for (const e of this.graph.edges) {
      const d = this.edgeDisp.get(e.id)!;
      if (d.draw <= 0.002) continue;
      const pts = this.curve(e.id, e.source, e.target, 36);
      const touchesHover = this.hover && (e.source === this.hover || e.target === this.hover);
      ctx.globalAlpha = 1 - 0.55 * focus * (1 - Math.min(1, d.path * 20));
      this.polyline(ctx, pts, 0, d.draw, touchesHover ? P.grey : P.faint, 1);
      if (d.draw > 0.98) this.arrow(ctx, pts, touchesHover ? P.grey : P.faint);
      ctx.globalAlpha = 1;
      if (d.path > 0.001) {
        const t = frame.edges.get(e.id);
        if (t?.reverse) this.polyline(ctx, pts, 1 - d.path, 1, P.accent, 2);
        else this.polyline(ctx, pts, 0, d.path, P.accent, 2);
        if (d.path > 0.98) this.arrow(ctx, pts, P.accent);
      }
    }

    // Nodes, then their labels, at the side chosen once by layoutLabels().
    const toLabel: { id: string; x: number; y: number; alpha: number; hot: boolean }[] = [];
    for (const [id, node] of this.graph.nodes) {
      const d = this.nodeDisp.get(id)!;
      const [x, y] = this.nodeScreen(id);
      if (frame.ghost > 0 && d.lit < 0.99) {
        ctx.globalAlpha = frame.ghost * (1 - d.lit) * 0.5;
        ctx.fillStyle = P.faint;
        ctx.beginPath();
        ctx.arc(x, y, 1.6, 0, 6.283);
        ctx.fill();
      }
      if (d.lit < 0.01) continue;
      const dim = 1 - 0.6 * focus * (1 - Math.min(1, d.hot / 0.5)) * (this.hover === id ? 0 : 1);
      ctx.globalAlpha = d.lit * dim;
      const color = d.hot > 0.5 ? P.accent : P.ink;
      this.shape(ctx, node.type, x, y, nodeR + (d.hot > 0.5 ? 0.6 : 0), color, P.paper);
      // A second hairline ring marks an entity merged from several names.
      if (node.aliases.length) {
        ctx.strokeStyle = d.hot > 0.5 ? P.accent : P.faint;
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.arc(x, y, nodeR + 4.5, 0, 6.283);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      const la = Math.max(0, (d.lit - 0.4) / 0.6) * dim;
      if (la > 0.01) toLabel.push({ id, x, y, alpha: la, hot: d.hot > 0.5 });
    }
    ctx.font = `450 ${fontPx}px Inter, system-ui, sans-serif`;
    for (const l of toLabel) {
      const name = this.graph.nodes.get(l.id)!.name;
      // Width at the regular weight, so a label keeps its place when it turns bold.
      ctx.font = `450 ${fontPx}px Inter, system-ui, sans-serif`;
      const w = ctx.measureText(name).width + 4;
      const side = this.labelSide.get(l.id) ?? 0;
      const box = labelBox(side, l.x, l.y, w, fontPx + 3, nodeR + 6);
      this.lastSides.set(l.id, side);
      ctx.font = `${l.hot || this.hover === l.id ? 600 : 450} ${fontPx}px Inter, system-ui, sans-serif`;
      ctx.globalAlpha = l.alpha;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.lineJoin = "round";
      ctx.strokeStyle = P.paper;
      ctx.lineWidth = 4;
      ctx.strokeText(name, box.x + 2, box.y + 1);
      ctx.fillStyle = l.hot ? P.accent : P.ink;
      ctx.fillText(name, box.x + 2, box.y + 1);
      ctx.globalAlpha = 1;
    }

    // Relation names on the active path and around the hovered node, at their fixed spots.
    const relPx = Math.max(10, fontPx - 2);
    ctx.font = `500 ${relPx}px "JetBrains Mono", ui-monospace, monospace`;
    for (const e of this.graph.edges) {
      const d = this.edgeDisp.get(e.id)!;
      const t = frame.edges.get(e.id);
      const show = (t?.label && d.path > 0.6) || (this.hover && (e.source === this.hover || e.target === this.hover) && d.draw > 0.9);
      if (!show) continue;
      const spotDef = this.edgeSpot.get(e.id) ?? { f: 0.5, off: 0 };
      const [cx, cy] = along(this.curve(e.id, e.source, e.target, 24), spotDef.f, spotDef.off);
      const w = ctx.measureText(e.type).width + 8;
      const h = relPx + 5;
      ctx.fillStyle = P.paper;
      ctx.fillRect(cx - w / 2, cy - h / 2, w, h);
      ctx.fillStyle = t?.label ? P.accent : P.grey;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(e.type, cx, cy + 0.5);
    }

    // Hero words.
    for (const w of frame.words ?? []) {
      if (w.alpha < 0.01) continue;
      const [sx, sy] = this.toScreen(w.x, w.y);
      ctx.globalAlpha = w.alpha;
      ctx.font = `${w.type && w.ink > 0.5 ? 500 : 400} ${Math.max(11, 13 * scale)}px Inter, system-ui, sans-serif`;
      ctx.fillStyle = w.type && w.ink > 0.5 ? P.ink : P.faint;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(w.text, sx, sy);
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  private drawFront(frame: Frame) {
    const ctx = this.front;
    const P = this.palette;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.W, this.H);
    ctx.save();
    if (frame.clipLabels) {
      const r = this.rect();
      ctx.beginPath();
      ctx.rect(r.x, r.y, r.w, r.h);
      ctx.clip();
    }
    ctx.font = "500 12px Inter, system-ui, sans-serif";
    for (const l of frame.labels) {
      if (l.alpha < 0.01) continue;
      const w = ctx.measureText(l.text).width + 26;
      const h = 22;
      ctx.globalAlpha = l.alpha;
      ctx.fillStyle = P.paper;
      ctx.strokeStyle = P.ink;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(l.x - w / 2, l.y - h / 2, w, h, 3);
      ctx.fill();
      ctx.stroke();
      this.shape(ctx, l.type, l.x - w / 2 + 10, l.y, 3, P.ink, P.paper);
      ctx.fillStyle = P.ink;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(l.text, l.x - w / 2 + 18, l.y + 0.5);
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  private polyline(ctx: CanvasRenderingContext2D, pts: [number, number][], from: number, to: number, color: string, width: number) {
    const n = pts.length - 1;
    const a = from * n;
    const b = to * n;
    if (b - a <= 0) return;
    const at = (f: number): [number, number] => {
      const i = Math.min(n - 1, Math.floor(f));
      const u = f - i;
      return [lerp(pts[i][0], pts[i + 1][0], u), lerp(pts[i][1], pts[i + 1][1], u)];
    };
    ctx.beginPath();
    ctx.moveTo(...at(a));
    for (let i = Math.ceil(a); i < b; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.lineTo(...at(b));
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = "round";
    ctx.stroke();
  }

  private arrow(ctx: CanvasRenderingContext2D, pts: [number, number][], color: string) {
    const [ax, ay] = pts[pts.length - 1];
    const [bx, by] = pts[pts.length - 3];
    const ang = Math.atan2(ay - by, ax - bx);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(ax - 6 * Math.cos(ang - 0.45), ay - 6 * Math.sin(ang - 0.45));
    ctx.lineTo(ax - 6 * Math.cos(ang + 0.45), ay - 6 * Math.sin(ang + 0.45));
    ctx.closePath();
    ctx.fill();
  }

  /** Points along an edge in world space (no trimming), for label layout. */
  private curveWorld(edgeId: string, from: string, to: string, n: number): [number, number][] {
    const [x1, y1] = this.pos(from);
    const [x2, y2] = this.pos(to);
    const len = Math.hypot(x2 - x1, y2 - y1) || 1;
    const [nx, ny] = [-(y2 - y1) / len, (x2 - x1) / len];
    const b = this.bend.get(edgeId) ?? 0;
    const [cx, cy] = [(x1 + x2) / 2 + nx * b, (y1 + y2) / 2 + ny * b];
    const pts: [number, number][] = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const u = 1 - t;
      pts.push([u * u * x1 + 2 * u * t * cx + t * t * x2, u * u * y1 + 2 * u * t * cy + t * t * y2]);
    }
    return pts;
  }

  /** Points along an edge in screen space, trimmed at both nodes. */
  curve(edgeId: string, from: string, to: string, n = 24): [number, number][] {
    const [x1, y1] = this.nodeScreen(from);
    const [x2, y2] = this.nodeScreen(to);
    const len = Math.hypot(x2 - x1, y2 - y1) || 1;
    const [nx, ny] = [-(y2 - y1) / len, (x2 - x1) / len];
    const b = (this.bend.get(edgeId) ?? 0) * this.scale();
    const [cx, cy] = [(x1 + x2) / 2 + nx * b, (y1 + y2) / 2 + ny * b];
    const pts: [number, number][] = [];
    const t0 = 10 / len;
    const t1 = 1 - 12 / len;
    for (let i = 0; i <= n; i++) {
      const t = t0 + (i / n) * (t1 - t0);
      const u = 1 - t;
      pts.push([u * u * x1 + 2 * u * t * cx + t * t * x2, u * u * y1 + 2 * u * t * cy + t * t * y2]);
    }
    return pts;
  }
}
