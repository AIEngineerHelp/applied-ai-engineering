// The graph drawing: a hand-placed SVG layout (data/layout.json) with
// suppliers → components → products → customers left to right, and people
// and teams underneath. Positions are presentation only; which nodes and
// edges exist comes from the computed graph.

import type { Edge, Graph } from "../src/graph.ts";
import { RELATION_TYPES } from "../src/schema.ts";

const NS = "http://www.w3.org/2000/svg";
const R = 12;

const el = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, parent?: Element) => {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  parent?.appendChild(node);
  return node;
};

export interface ViewState {
  visibleNodes: Set<string>;
  visibleEdges: Set<string>;
  current: Set<string>; // nodes mentioned in the selected document
  hotNodes: Set<string>;
  hotEdges: Set<string>;
  focus: boolean; // dim everything that is not hot
}

export class GraphView {
  private nodeEls = new Map<string, SVGGElement>();
  private edgeEls = new Map<string, { line: SVGPathElement; label: SVGTextElement }>();
  private shown = new Set<string>();

  constructor(
    private svg: SVGSVGElement,
    private graph: Graph,
    private layout: Record<string, number[]>,
    private onNode: (id: string | null) => void,
  ) {
    this.draw();
  }

  private pos(id: string): [number, number] {
    const p = this.layout[this.graph.nodes.get(id)!.name];
    return [p[0], p[1]];
  }

  private draw() {
    const defs = el("defs", {}, this.svg);
    for (const [id, cls] of [["arr", "fill-[var(--edge)]"], ["arr-hot", "fill-[var(--edge-hot)]"]]) {
      const m = el("marker", { id, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" }, defs);
      el("path", { d: "M0 1 L10 5 L0 9 z", class: cls }, m);
    }
    const edges = el("g", {}, this.svg);
    const labels = el("g", {}, this.svg);
    const nodes = el("g", {}, this.svg);

    for (const e of this.graph.edges) {
      const [x1, y1] = this.pos(e.source);
      const [x2, y2] = this.pos(e.target);
      const len = Math.hypot(x2 - x1, y2 - y1);
      const [ux, uy] = [(x2 - x1) / len, (y2 - y1) / len];
      // Two relations between the same pair (SUPPLIES and DELAYED) bow apart
      // as curves so both stay visible; a single relation is a straight line.
      const pair = this.graph.edges.filter((o) => (o.source === e.source && o.target === e.target) || (o.source === e.target && o.target === e.source));
      const bend = pair.length > 1 ? (pair.indexOf(e) - (pair.length - 1) / 2) * 44 : 0;
      const [px, py] = [-uy, ux]; // unit normal
      const [cx, cy] = [(x1 + x2) / 2 + px * bend, (y1 + y2) / 2 + py * bend];
      const dir = (fx: number, fy: number, tx: number, ty: number) => {
        const d = Math.hypot(tx - fx, ty - fy);
        return [(tx - fx) / d, (ty - fy) / d];
      };
      const [sx, sy] = bend ? dir(x1, y1, cx, cy) : [ux, uy];
      const [ex, ey] = bend ? dir(cx, cy, x2, y2) : [ux, uy];
      const a = [x1 + sx * (R + 3), y1 + sy * (R + 3)];
      const b = [x2 - ex * (R + 5), y2 - ey * (R + 5)];
      const d = bend ? `M${a[0]} ${a[1]} Q${cx} ${cy} ${b[0]} ${b[1]}` : `M${a[0]} ${a[1]} L${b[0]} ${b[1]}`;
      const line = el("path", { d, class: "g-edge", "marker-end": "url(#arr)" }, edges);
      line.style.setProperty("--len", String(Math.ceil(len * (bend ? 1.15 : 1))));
      // Label at the curve's midpoint (halfway between the chord midpoint and the control point).
      const label = el("text", { x: (x1 + x2) / 2 + (px * bend) / 2, y: (y1 + y2) / 2 + (py * bend) / 2 - 5, "text-anchor": "middle", class: "g-elabel" }, labels);
      label.textContent = e.type;
      this.edgeEls.set(e.id, { line, label });
    }

    for (const n of this.graph.nodes.values()) {
      const [x, y] = this.pos(n.id);
      const g = el("g", { transform: `translate(${x} ${y})`, class: "g-node", "data-type": n.type, tabindex: 0, role: "button", "aria-label": `${n.name}, ${n.type}` }, nodes);
      const inner = el("g", {}, g);
      el("circle", { r: R + 9, class: "halo" }, inner);
      if (n.aliases.length) el("circle", { r: R + 4.5, class: "ring" }, inner);
      el("circle", { r: R, class: "dot" }, inner);
      const t = el("text", { y: R + 21, "text-anchor": "middle" }, inner);
      t.textContent = n.name;
      g.addEventListener("pointerenter", () => this.onNode(n.id));
      g.addEventListener("pointerleave", () => this.onNode(null));
      g.addEventListener("focus", () => this.onNode(n.id));
      g.addEventListener("blur", () => this.onNode(null));
      g.addEventListener("click", () => this.onNode(n.id));
      this.nodeEls.set(n.id, g as SVGGElement);
    }
  }

  update(s: ViewState) {
    for (const [id, g] of this.nodeEls) {
      const visible = s.visibleNodes.has(id);
      g.style.display = visible ? "" : "none";
      if (visible && !this.shown.has(id)) {
        const inner = g.firstElementChild as SVGGElement;
        inner.classList.remove("g-enter");
        void inner.getBoundingClientRect();
        inner.classList.add("g-enter");
        inner.style.transformBox = "fill-box";
        inner.style.transformOrigin = "center";
      }
      g.classList.toggle("cur", s.current.has(id) && !s.focus);
      g.classList.toggle("hot", s.hotNodes.has(id));
      g.classList.toggle("dim", s.focus && !s.hotNodes.has(id));
    }
    for (const [id, { line, label }] of this.edgeEls) {
      const visible = s.visibleEdges.has(id);
      line.style.display = visible ? "" : "none";
      if (visible && !this.shown.has(id)) {
        line.classList.remove("g-draw");
        void line.getBoundingClientRect();
        line.classList.add("g-draw");
      }
      const hot = s.hotEdges.has(id);
      line.classList.toggle("hot", hot);
      line.setAttribute("marker-end", hot ? "url(#arr-hot)" : "url(#arr)");
      line.classList.toggle("dim", s.focus && !hot);
      label.classList.toggle("on", visible && hot);
    }
    this.shown = new Set([...s.visibleNodes, ...s.visibleEdges]);
  }
}

export const relationText = (g: Graph, e: Edge) =>
  `${g.nodes.get(e.source)!.name} ${RELATION_TYPES[e.type].reads} ${g.nodes.get(e.target)!.name}`;
