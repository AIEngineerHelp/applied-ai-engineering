// The graph as a static SVG diagram: a small ink shape per entity (the shape is
// the type), thin grey edges, and one accent colour for what is new or on the
// active path. Labels are placed once, when the SVG is built (src/diagram.ts).
// Motion is CSS only: elements with --d fade or draw in at that script time on
// the scene clock (clock.ts), so nothing is redrawn per frame.

import { bends, edgeCurve, placeLabels, placeRelation, samples, type Box, type Pt } from "../src/diagram.ts";
import type { Graph } from "../src/graph.ts";
import { LAYOUT_SIZE } from "../src/layout.ts";

export const SHAPES: Record<string, { shape: "circle" | "square" | "diamond" | "triangle" | "hex"; filled: boolean; glyph: string }> = {
  Person: { shape: "circle", filled: true, glyph: "●" },
  Team: { shape: "circle", filled: false, glyph: "○" },
  Customer: { shape: "diamond", filled: true, glyph: "◆" },
  Product: { shape: "square", filled: true, glyph: "■" },
  Service: { shape: "diamond", filled: false, glyph: "◇" },
  Site: { shape: "triangle", filled: false, glyph: "△" },
  Component: { shape: "square", filled: false, glyph: "□" },
  Incident: { shape: "hex", filled: false, glyph: "⬡" },
  Company: { shape: "triangle", filled: true, glyph: "▲" },
};
export const glyph = (type: string) => SHAPES[type]?.glyph ?? "●";

export interface GraphView {
  nodes: Iterable<string>;
  edges: Iterable<string>;
  label: Iterable<string>;
  size: number; // label size, in layout units (the drawing is 1000 wide)
  r: number;
  accent?: Set<string>;
  dim?: boolean; // grey out everything not accented and not on the path
  nodeAt?: Map<string, number>; // script time a node fades in
  edgeAt?: Map<string, number>; // script time an edge draws in
  ringAt?: Map<string, number>; // script time a merge ring appears
  path?: { edge: string; reverse: boolean; at: number | null }[]; // accent hops (null: already drawn)
  relNames?: boolean;
  ghosts?: Iterable<string>;
  crop?: Box; // a viewBox other than the whole drawing
  title: string;
}

const f = (n: number) => Math.round(n * 10) / 10;
const at = (t: number | undefined) => (t === undefined ? "" : ` style="--d:${Math.round(t)}"`);
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function shape(type: string, x: number, y: number, r: number, cls: string, style: string): string {
  const s = SHAPES[type] ?? SHAPES.Person;
  const c = `class="nd ${s.filled ? "nd-fill" : "nd-line"} ${cls}"${style}`;
  if (s.shape === "circle") return `<circle cx="${f(x)}" cy="${f(y)}" r="${f(r)}" ${c}/>`;
  if (s.shape === "square") return `<rect x="${f(x - r * 0.9)}" y="${f(y - r * 0.9)}" width="${f(r * 1.8)}" height="${f(r * 1.8)}" ${c}/>`;
  if (s.shape === "diamond") return `<polygon points="${f(x)},${f(y - r * 1.25)} ${f(x + r * 1.25)},${f(y)} ${f(x)},${f(y + r * 1.25)} ${f(x - r * 1.25)},${f(y)}" ${c}/>`;
  if (s.shape === "hex") {
    const pts = [0, 1, 2, 3, 4, 5].map((k) => `${f(x + r * 1.1 * Math.cos((Math.PI / 3) * k))},${f(y + r * 1.1 * Math.sin((Math.PI / 3) * k))}`).join(" ");
    return `<polygon points="${pts}" ${c}/>`;
  }
  return `<polygon points="${f(x)},${f(y - r * 1.2)} ${f(x + r * 1.15)},${f(y + r * 0.85)} ${f(x - r * 1.15)},${f(y + r * 0.85)}" ${c}/>`;
}

function arrow(end: Pt, from: Pt, size: number, cls: string, style: string): string {
  const ang = Math.atan2(end[1] - from[1], end[0] - from[0]);
  const p = (a: number) => `${f(end[0] - size * Math.cos(ang + a))},${f(end[1] - size * Math.sin(ang + a))}`;
  return `<polygon points="${f(end[0])},${f(end[1])} ${p(0.42)} ${p(-0.42)}" class="${cls}"${style}/>`;
}

export function graphSvg(g: Graph, layout: Record<string, [number, number]>, v: GraphView): string {
  const pos = (id: string): Pt => layout[id] ?? [0, 0];
  const nodeById = new Map(g.nodes.map((n) => [n.id, n]));
  const nodes = [...v.nodes].filter((id) => nodeById.has(id));
  const edgeList = [...v.edges].map((id) => g.edges.find((e) => e.id === id)).filter((e): e is Graph["edges"][number] => !!e);
  const bend = bends(edgeList);
  const accent = v.accent ?? new Set<string>();
  const pathEdges = new Set((v.path ?? []).map((p) => p.edge));
  // Edges within one column would run straight through the nodes between; bow them out to the right.
  const bendOf = (e: Graph["edges"][number]) => {
    const [a, b] = [pos(e.source), pos(e.target)];
    const dy = b[1] - a[1];
    if (Math.abs(b[0] - a[0]) < 20 && Math.abs(dy) > 40) return -Math.sign(dy) * Math.min(110, Math.abs(dy) * 0.32) + (bend.get(e.id) ?? 0);
    return bend.get(e.id) ?? 0;
  };
  const curves = new Map(edgeList.map((e) => [e.id, edgeCurve(pos(e.source), pos(e.target), bendOf(e), v.r + 4)]));
  const parts: string[] = [];

  for (const id of v.ghosts ?? []) {
    const [x, y] = pos(id);
    parts.push(`<circle cx="${x}" cy="${y}" r="${f(v.r * 0.4)}" class="ghost"/>`);
  }
  for (const e of edgeList) {
    const c = curves.get(e.id)!;
    const d = `M${f(c.start[0])} ${f(c.start[1])} Q${f(c.ctrl[0])} ${f(c.ctrl[1])} ${f(c.end[0])} ${f(c.end[1])}`;
    const t = v.edgeAt?.get(e.id);
    const dimmed = v.dim && !pathEdges.has(e.id) ? " dimmed" : "";
    parts.push(`<path d="${d}" pathLength="1" class="ed${t === undefined ? "" : " ed-new"}${dimmed}"${at(t)}><title>${esc(`${nodeById.get(e.source)?.name} ${e.type} ${nodeById.get(e.target)?.name}`)}</title></path>`);
    parts.push(arrow(c.end, c.ctrl, v.r * 1.2, `ah${t === undefined ? "" : " ah-new"}${dimmed}`, at(t === undefined ? undefined : t + 500)));
  }
  for (const hop of v.path ?? []) {
    const c = curves.get(hop.edge);
    if (!c) continue;
    const [a, b] = hop.reverse ? [c.end, c.start] : [c.start, c.end];
    parts.push(`<path d="M${f(a[0])} ${f(a[1])} Q${f(c.ctrl[0])} ${f(c.ctrl[1])} ${f(b[0])} ${f(b[1])}" pathLength="1" class="hop${hop.at === null ? "" : " hop-new"}"${at(hop.at ?? undefined)}/>`);
    parts.push(arrow(c.end, c.ctrl, v.r * 1.4, `ah-hop${hop.at === null ? "" : " ah-new"}`, at(hop.at === null ? undefined : hop.at + 650)));
  }
  for (const id of nodes) {
    const [x, y] = pos(id);
    const n = nodeById.get(id)!;
    const t = v.nodeAt?.get(id);
    const cls = `${accent.has(id) ? "nd-accent" : ""}${v.dim && !accent.has(id) ? " dimmed" : ""}${t === undefined ? "" : " nd-new"}`;
    parts.push(`<g>${shape(n.type, x, y, v.r, cls, at(t))}<title>${esc(`${n.name} (${n.type})${n.aliases.length ? `, also written ${n.aliases.join(", ")}` : ""}`)}</title></g>`);
    const ring = v.ringAt?.get(id);
    if (ring !== undefined) parts.push(`<circle cx="${x}" cy="${y}" r="${f(v.r * 2.2)}" class="ring"${at(ring)}/>`);
  }
  const view = v.crop ?? { x: 0, y: 0, w: LAYOUT_SIZE.w, h: LAYOUT_SIZE.h };
  const placed = placeLabels({
    pos,
    names: new Map(nodes.map((id) => [id, nodeById.get(id)!.name])),
    nodes,
    label: [...v.label].filter((id) => nodes.includes(id)),
    edgePts: edgeList.flatMap((e) => samples(curves.get(e.id)!)),
    size: v.size,
    r: v.r,
    view,
  });
  for (const p of placed) {
    const t = v.nodeAt?.get(p.id);
    const cls = `lbl${accent.has(p.id) ? " lbl-accent" : ""}${v.dim && !accent.has(p.id) ? " dimmed" : ""}${t === undefined ? "" : " nd-new"}`;
    parts.push(`<text x="${f(p.box.x + 2)}" y="${f(p.box.y + v.size * 0.92)}" font-size="${v.size}" class="${cls}"${at(t)}>${esc(nodeById.get(p.id)!.name)}</text>`);
  }
  if (v.relNames) {
    const avoid: Box[] = placed.map((p) => p.box);
    for (const hop of v.path ?? []) {
      const c = curves.get(hop.edge);
      if (!c) continue;
      const type = hop.edge.split("|")[1];
      const size = v.size * 0.78;
      const box = placeRelation(samples(c, 24), type, size, avoid);
      avoid.push(box);
      parts.push(`<g class="rel${hop.at === null ? "" : " nd-new"}"${at(hop.at === null ? undefined : hop.at + 450)}><rect x="${f(box.x)}" y="${f(box.y)}" width="${f(box.w)}" height="${f(box.h)}" rx="2"/><text x="${f(box.x + box.w / 2)}" y="${f(box.y + box.h * 0.72)}" font-size="${f(size)}" text-anchor="middle">${type}</text></g>`);
    }
  }
  return `<svg class="graph" viewBox="${view.x} ${view.y} ${view.w} ${view.h}" role="img" aria-label="${esc(v.title)}">${parts.join("")}</svg>`;
}

/** Splits a long name into two lines at the space nearest its middle. */
function twoLines(name: string): string[] {
  if (name.length <= 14) return [name];
  const spaces = [...name.matchAll(/ /g)].map((m) => m.index!);
  if (!spaces.length) return [name];
  const cut = spaces.reduce((b, i) => (Math.abs(i - name.length / 2) < Math.abs(b - name.length / 2) ? i : b));
  return [name.slice(0, cut), name.slice(cut + 1)];
}

/**
 * The traversal the recorded query made, drawn as three columns: the part, the
 * products it is PART_OF, and the customers that USE them. Built from the
 * recorded rows, so it shows exactly what Neo4j returned. With `at`, the hops
 * draw in at those script times.
 */
export function pathSvg(start: string, rows: { customer: string; product: string }[], at?: { partOf: number; uses: number }): string {
  const draw = (t: number | undefined) => (t === undefined ? `class="hop"` : `class="hop hop-new" pathLength="1" style="--d:${t}"`);
  const fade = (t: number | undefined) => (t === undefined ? "" : ` class="nd-new" style="--d:${t}"`);
  const products = [...new Set(rows.map((r) => r.product))];
  const sorted = [...rows].sort((x, y) => products.indexOf(x.product) - products.indexOf(y.product));
  const fs = 14, rowH = 50, top = 40;
  const W = 400, H = top + sorted.length * rowH;
  const cx = [44, 168, 262];
  const cy = (j: number) => top + j * rowH + rowH / 2 - 6;
  // Each product sits level with the middle of its customers.
  const py = (i: number) => {
    const js = sorted.map((r, j) => (r.product === products[i] ? j : -1)).filter((j) => j >= 0);
    return (cy(js[0]) + cy(js[js.length - 1])) / 2;
  };
  const sy = (py(0) + py(products.length - 1)) / 2;
  const label = (x: number, y: number, name: string, anchor: string) =>
    twoLines(name).map((l, k, all) => `<text x="${x}" y="${y + (k - (all.length - 1) / 2) * fs * 1.15}" font-size="${fs}" class="lbl lbl-accent" text-anchor="${anchor}">${esc(l)}</text>`).join("");
  const parts: string[] = [];
  ["Part", "Product", "Customer"].forEach((h, i) => parts.push(`<text x="${cx[i] + (i === 2 ? -7 : 0)}" y="14" class="col-h" font-size="10.5" text-anchor="${i === 2 ? "start" : "middle"}">${h.toUpperCase()}</text>`));
  products.forEach((_, i) => parts.push(`<path d="M${cx[0] + 7} ${sy} L${cx[1] - 8} ${py(i)}" ${draw(at?.partOf)}/>`));
  sorted.forEach((r, j) => parts.push(`<path d="M${cx[1] + 8} ${py(products.indexOf(r.product))} L${cx[2] - 8} ${cy(j)}" ${draw(at?.uses)}/>`));
  parts.push(`<text x="${(cx[0] + cx[1]) / 2}" y="30" font-size="10" class="rel-t" text-anchor="middle"${fade(at?.partOf)}>PART_OF →</text>`);
  parts.push(`<text x="${(cx[1] + cx[2]) / 2}" y="30" font-size="10" class="rel-t" text-anchor="middle"${fade(at?.uses)}>← USES</text>`);
  parts.push(`<rect x="${cx[0] - 6}" y="${sy - 6}" width="12" height="12" class="nd nd-line nd-accent"/>${label(cx[0], sy - 28, start, "middle")}`);
  products.forEach((p, i) => parts.push(`<g${fade(at && at.partOf + 500)}><rect x="${cx[1] - 6}" y="${py(i) - 6}" width="12" height="12" class="nd nd-fill nd-accent"/>${label(cx[1], py(i) + 24, p, "middle")}</g>`));
  sorted.forEach((r, j) => parts.push(`<g${fade(at && at.uses + 500)}><polygon points="${cx[2]},${cy(j) - 7} ${cx[2] + 7},${cy(j)} ${cx[2]},${cy(j) + 7} ${cx[2] - 7},${cy(j)}" class="nd nd-fill nd-accent"/>${label(cx[2] + 14, cy(j) + 4.5, r.customer, "start")}</g>`));
  return `<svg class="graph path-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="The path Neo4j followed: ${esc(start)}, part of ${esc(products.join(" and "))}, used by ${rows.length} customers">${parts.join("")}</svg>`;
}
