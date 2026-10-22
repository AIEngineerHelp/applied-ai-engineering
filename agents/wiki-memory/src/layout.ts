// A small deterministic force layout for the page graph, computed once over the final graph so that
// nodes keep their place while the wiki grows. Same input, same positions: no randomness.

import type { Graph } from "./wiki.ts";

export type Layout = Record<string, { x: number; y: number }>;

export function forceLayout(graph: Graph, { iterations = 600, gravity = 0.15, spread = 1.5, minGap = 0.19 } = {}): Layout {
  const ids = graph.nodes.map((n) => n.id);
  const count = ids.length;
  const pos = ids.map((_, i) => {
    const angle = (2 * Math.PI * i) / count;
    return { x: Math.cos(angle), y: Math.sin(angle) };
  });
  const index = new Map(ids.map((id, i) => [id, i]));
  const edges = graph.edges.map((e) => [index.get(e.from)!, index.get(e.to)!] as const);
  const k = spread * Math.sqrt(4 / count);
  let temperature = 0.1;

  for (let step = 0; step < iterations; step++) {
    const force = pos.map(() => ({ x: 0, y: 0 }));
    for (let i = 0; i < count; i++) {
      for (let j = i + 1; j < count; j++) {
        const dx = pos[i].x - pos[j].x;
        const dy = pos[i].y - pos[j].y;
        const d2 = Math.max(dx * dx + dy * dy, 1e-4);
        const f = (k * k) / d2;
        force[i].x += dx * f;
        force[i].y += dy * f;
        force[j].x -= dx * f;
        force[j].y -= dy * f;
      }
    }
    for (const [a, b] of edges) {
      const dx = pos[a].x - pos[b].x;
      const dy = pos[a].y - pos[b].y;
      const d = Math.max(Math.hypot(dx, dy), 1e-3);
      const f = d / k;
      force[a].x -= dx * f;
      force[a].y -= dy * f;
      force[b].x += dx * f;
      force[b].y += dy * f;
    }
    for (let i = 0; i < count; i++) {
      // Gentle pull to the centre keeps loosely linked nodes on screen.
      force[i].x -= pos[i].x * gravity;
      force[i].y -= pos[i].y * gravity;
      const len = Math.max(Math.hypot(force[i].x, force[i].y), 1e-9);
      const move = Math.min(len, temperature);
      pos[i].x += (force[i].x / len) * move;
      pos[i].y += (force[i].y / len) * move;
    }
    temperature = Math.max(0.002, temperature * 0.992);
  }

  // Fit into the drawing area: x in [0.08, 0.92], y in [0.1, 0.9].
  const xs = pos.map((p) => p.x);
  const ys = pos.map((p) => p.y);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const fit = pos.map((p) => ({
    x: 0.08 + (0.84 * (p.x - minX)) / Math.max(maxX - minX, 1e-9),
    y: 0.1 + (0.8 * (p.y - minY)) / Math.max(maxY - minY, 1e-9),
  }));

  // Push apart any two nodes closer than minGap (measured on the 3:2 drawing), so labels stay readable.
  const ASPECT = 1.5;
  for (let pass = 0; pass < 200; pass++) {
    let moved = false;
    for (let i = 0; i < count; i++) {
      for (let j = i + 1; j < count; j++) {
        const dx = (fit[i].x - fit[j].x) * ASPECT;
        const dy = fit[i].y - fit[j].y;
        const d = Math.hypot(dx, dy);
        if (d >= minGap) continue;
        moved = true;
        const push = (minGap - d) / 2 + 1e-4;
        const ux = d > 1e-9 ? dx / d : 1;
        const uy = d > 1e-9 ? dy / d : 0;
        fit[i].x += (ux * push) / ASPECT;
        fit[i].y += uy * push;
        fit[j].x -= (ux * push) / ASPECT;
        fit[j].y -= uy * push;
      }
    }
    for (const p of fit) {
      p.x = Math.min(0.92, Math.max(0.08, p.x));
      p.y = Math.min(0.9, Math.max(0.1, p.y));
    }
    if (!moved) break;
  }

  const layout: Layout = {};
  ids.forEach((id, i) => {
    layout[id] = { x: round(fit[i].x), y: round(fit[i].y) };
  });
  return layout;
}

const round = (n: number) => Math.round(n * 1000) / 1000;
