// The page graph as an SVG: one circle per page, one line per linked pair. Positions come from the
// precomputed layout so a node never moves while the wiki grows.

import type { Layout } from "../src/layout.ts";
import type { Graph } from "../src/wiki.ts";
import { esc } from "./render.ts";

export interface GraphMarks {
  created?: Set<string>;
  touched?: Set<string>;
  flagged?: Set<string>;
  /** Edges new in this view, as "a|b" with the slugs sorted. */
  newEdges?: Set<string>;
  /** When set, everything not in this set is dimmed. */
  focus?: Set<string>;
}

const W = 520;
const H = 360;

export const edgeKey = (a: string, b: string) => [a, b].sort().join("|");

export function graphSvg(graph: Graph, layout: Layout, marks: GraphMarks = {}): string {
  const at = (id: string) => {
    const p = layout[id] ?? { x: 0.5, y: 0.5 };
    return { x: p.x * W, y: p.y * H };
  };
  const edges = graph.edges
    .map((e) => {
      const a = at(e.from);
      const b = at(e.to);
      const key = edgeKey(e.from, e.to);
      const dim = marks.focus && !(marks.focus.has(e.from) && marks.focus.has(e.to));
      return `<line class="g-edge" x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" data-new="${marks.newEdges?.has(key) ?? false}" data-dim="${dim ?? false}"/>`;
    })
    .join("");
  const nodes = graph.nodes
    .map((n) => {
      const p = at(n.id);
      const r = n.type === "overview" ? 8.5 : 6;
      const state = marks.flagged?.has(n.id)
        ? "flagged"
        : marks.created?.has(n.id)
          ? "created"
          : marks.touched?.has(n.id)
            ? "touched"
            : "idle";
      const dim = marks.focus ? !marks.focus.has(n.id) : false;
      // Labels sit below the node, or above it near the bottom edge.
      const below = p.y < H - 30;
      const ly = below ? p.y + r + 13 : p.y - r - 6;
      const anchor = p.x < 60 ? "start" : p.x > W - 60 ? "end" : "middle";
      const lx = anchor === "start" ? p.x - r : anchor === "end" ? p.x + r : p.x;
      return `<g class="g-node" data-type="${n.type}" data-state="${state}" data-dim="${dim}"><title>${esc(n.id)}${n.type === "missing" ? " (no page yet)" : ""}</title><circle class="ring" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r + 4}"/><circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r}"/><text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="${anchor}">${esc(n.id)}</text></g>`;
    })
    .join("");
  return `<svg viewBox="0 0 ${W} ${H}" class="block h-auto w-full" role="img" aria-label="Link graph of the wiki pages">${edges}${nodes}</svg>`;
}

export const LEGEND = `
  <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted">
    <span class="inline-flex items-center gap-1.5"><span class="legend-dot" style="background:var(--n-overview)"></span>overview</span>
    <span class="inline-flex items-center gap-1.5"><span class="legend-dot" style="background:var(--n-source)"></span>source</span>
    <span class="inline-flex items-center gap-1.5"><span class="legend-dot" style="background:var(--n-entity)"></span>entity</span>
    <span class="inline-flex items-center gap-1.5"><span class="legend-dot" style="background:var(--n-concept)"></span>concept</span>
    <span class="inline-flex items-center gap-1.5"><span class="legend-dot border border-dashed" style="border-color:var(--del)"></span>linked, no page</span>
  </div>`;
