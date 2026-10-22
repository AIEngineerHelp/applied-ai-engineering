// A small map of the wiki's links, drawn in thin lines. It is secondary to the pages: it only shows
// which pages exist and how they connect. New links draw themselves; nothing glows or pulses.
// Delays are CSS custom properties (--d, in ms), so ?t= can freeze any frame.

import type { Layout } from "../src/layout.ts";
import type { Graph } from "../src/wiki.ts";
import { esc } from "./render.ts";

export interface MapOptions {
  width: number;
  height: number;
  created?: Set<string>;
  touched?: Set<string>;
  /** Nodes that fade in without being styled as created (the opening figure). */
  appear?: Set<string>;
  /** Label every node, not only the ones this scene is about. */
  labelAll?: boolean;
  newEdges?: Set<string>;
  flagged?: Set<string>;
  pairs?: [string, string][];
  /** When new nodes start to appear, and when new links start to draw (ms). */
  nodeAt?: number;
  edgeAt?: number;
  /** When lint marks appear (ms). */
  flagAt?: number;
  /** Total time for each sequence; items are spread across it. */
  span?: number;
  fontSize?: number;
}

export const edgeKey = (a: string, b: string) => [a, b].sort().join("|");

export function mapSvg(graph: Graph, layout: Layout, o: MapOptions): string {
  const { width: W, height: H, created = new Set(), touched = new Set(), appear = new Set(), labelAll = false, newEdges = new Set(), flagged = new Set(), pairs = [], nodeAt = 0, edgeAt = 0, flagAt = 0, span = 900, fontSize = 10 } = o;
  const pad = { x: W * 0.02, y: H * 0.02 };
  const at = (id: string) => {
    const p = layout[id] ?? { x: 0.5, y: 0.5 };
    return { x: pad.x + p.x * (W - 2 * pad.x), y: pad.y + p.y * (H - 2 * pad.y) };
  };
  const createdList = graph.nodes.filter((n) => created.has(n.id) || appear.has(n.id)).map((n) => n.id);
  const nodeStep = createdList.length > 1 ? Math.min(90, span / createdList.length) : 0;
  const newList = graph.edges.filter((e) => newEdges.has(edgeKey(e.from, e.to)));
  const edgeStep = newList.length > 1 ? Math.min(70, (span - 400) / newList.length) : 0;

  const edges = graph.edges
    .map((e) => {
      const a = at(e.from);
      const b = at(e.to);
      const k = newList.indexOf(e);
      const attrs = k >= 0 ? `class="me me-new" pathLength="1" style="--d:${Math.round(edgeAt + k * edgeStep)}"` : `class="me"`;
      return `<line ${attrs} x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}"/>`;
    })
    .join("");

  const conflicts = pairs
    .map(([x, y]) => {
      const a = at(x);
      const b = at(y);
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2 - Math.hypot(b.x - a.x, b.y - a.y) * 0.2;
      return `<path class="mc seq" style="--d:${flagAt}" d="M${a.x.toFixed(1)},${a.y.toFixed(1)} Q${mx.toFixed(1)},${my.toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}"/>`;
    })
    .join("");

  // Labels: place the most relevant first and drop any that would overlap one already placed.
  const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
  const rank = (id: string) => (created.has(id) ? 0 : flagged.has(id) ? 1 : touched.has(id) ? 2 : 3);
  const labelOk = new Set<string>();
  for (const n of [...graph.nodes].sort((a, b) => rank(a.id) - rank(b.id))) {
    const wanted = labelAll || created.has(n.id) || touched.has(n.id) || flagged.has(n.id) || n.type === "missing";
    if (!wanted) continue;
    const p = at(n.id);
    const w = n.id.length * fontSize * 0.56;
    const below = p.y < H - fontSize * 2.2;
    const y0 = below ? p.y + 5 : p.y - 5 - fontSize;
    const x0 = p.x < W * 0.12 ? p.x - 3 : p.x > W * 0.88 ? p.x - w + 3 : p.x - w / 2;
    const box = { x0, x1: x0 + w, y0, y1: y0 + fontSize + 2 };
    if (!labelAll && placed.some((b) => b.x0 < box.x1 && box.x0 < b.x1 && b.y0 < box.y1 && box.y0 < b.y1)) continue;
    placed.push(box);
    labelOk.add(n.id);
  }

  const nodes = graph.nodes
    .map((n) => {
      const p = at(n.id);
      const r = n.type === "overview" ? 4 : 3;
      const k = createdList.indexOf(n.id);
      const cls = [
        "mn",
        `mn-${n.type}`,
        created.has(n.id) ? "mn-created" : "",
        touched.has(n.id) ? "mn-touched" : "",
        flagged.has(n.id) ? "mn-flagged" : "",
      ]
        .filter(Boolean)
        .join(" ");
      const anim = k >= 0 ? ` seq" style="--d:${Math.round(nodeAt + k * nodeStep)}` : "";
      const below = p.y < H - fontSize * 2.2;
      const ly = below ? p.y + r + fontSize + 2 : p.y - r - 5;
      const anchor = p.x < W * 0.12 ? "start" : p.x > W * 0.88 ? "end" : "middle";
      const lx = anchor === "start" ? p.x - r : anchor === "end" ? p.x + r : p.x;
      const ring = flagged.has(n.id) ? `<circle class="mf seq" style="--d:${flagAt}" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r + 4}"/>` : "";
      const label = labelOk.has(n.id) ? `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="${anchor}" font-size="${fontSize}">${esc(n.id)}</text>` : "";
      return `<g class="${cls}${anim}"><title>${esc(n.id)}</title>${ring}<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r}"/>${label}</g>`;
    })
    .join("");

  return `<svg class="map" viewBox="0 0 ${W} ${H}" role="img" aria-label="Map of the wiki's pages and their links">${edges}${conflicts}${nodes}</svg>`;
}
