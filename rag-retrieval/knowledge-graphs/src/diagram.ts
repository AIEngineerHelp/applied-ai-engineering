// Geometry for drawing the graph as a diagram: edge curves, and where each label
// goes. Computed once per drawing, never per animation frame, so labels cannot
// jump while a scene plays. Pure (no DOM), so tests can check that labels
// don't overlap each other or the nodes.

export type Pt = [number, number];
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Approximate text width for Inter, in units of the font size; close enough to place labels, and the same in Node and the browser. */
export function textWidth(text: string, size: number): number {
  let w = 0;
  for (const ch of text) {
    if (" .,:;'!|il1-".includes(ch)) w += 0.3;
    else if ("ftjrI()".includes(ch)) w += 0.38;
    else if ("mwMW".includes(ch)) w += 0.86;
    else if (/[A-Z0-9]/.test(ch)) w += 0.66;
    else w += 0.56;
  }
  return w * size;
}

/** Curvature per edge: two relations between the same pair bow apart; others are straight. */
export function bends(edges: { id: string; source: string; target: string }[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of edges) {
    const pair = edges.filter((o) => (o.source === e.source && o.target === e.target) || (o.source === e.target && o.target === e.source));
    const sign = e.source < e.target ? 1 : -1;
    out.set(e.id, pair.length > 1 ? (pair.indexOf(e) - (pair.length - 1) / 2) * 60 * sign : 0);
  }
  return out;
}

/** A quadratic edge from a to b, trimmed `trim` units at each end. */
export function edgeCurve(a: Pt, b: Pt, bend: number, trim = 11): { start: Pt; ctrl: Pt; end: Pt } {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const [nx, ny] = [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
  const ctrl: Pt = [(a[0] + b[0]) / 2 + nx * bend, (a[1] + b[1]) / 2 + ny * bend];
  const at = (t: number): Pt => {
    const u = 1 - t;
    return [u * u * a[0] + 2 * u * t * ctrl[0] + t * t * b[0], u * u * a[1] + 2 * u * t * ctrl[1] + t * t * b[1]];
  };
  const t0 = Math.min(0.45, trim / len);
  const t1 = Math.max(0.55, 1 - (trim + 3) / len);
  // The control point of the trimmed sub-curve (de Casteljau on [t0, t1]).
  const p = at(t0);
  const d: Pt = [2 * (1 - t0) * (ctrl[0] - a[0]) + 2 * t0 * (b[0] - ctrl[0]), 2 * (1 - t0) * (ctrl[1] - a[1]) + 2 * t0 * (b[1] - ctrl[1])];
  const s = (t1 - t0) / 2;
  return { start: p, ctrl: [p[0] + d[0] * s, p[1] + d[1] * s], end: at(t1) };
}

export function samples(c: { start: Pt; ctrl: Pt; end: Pt }, n = 40): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push([u * u * c.start[0] + 2 * u * t * c.ctrl[0] + t * t * c.end[0], u * u * c.start[1] + 2 * u * t * c.ctrl[1] + t * t * c.end[1]]);
  }
  return out;
}

/** Label positions around a node: below, above, right, left, then the four diagonals. */
export function labelBox(side: number, x: number, y: number, w: number, h: number, gap: number): Box {
  switch (side) {
    case 0: return { x: x - w / 2, y: y + gap, w, h };
    case 1: return { x: x - w / 2, y: y - gap - h, w, h };
    case 2: return { x: x + gap + 2, y: y - h / 2, w, h };
    case 3: return { x: x - gap - 2 - w, y: y - h / 2, w, h };
    case 4: return { x: x + gap - 4, y: y + gap - 4, w, h };
    case 5: return { x: x - gap + 4 - w, y: y + gap - 4, w, h };
    case 6: return { x: x + gap - 4, y: y - gap - h + 4, w, h };
    default: return { x: x - gap + 4 - w, y: y - gap - h + 4, w, h };
  }
}

/**
 * Place a label for each node in `label`, at the side that crosses the fewest
 * edges and overlaps no other label or node and stays inside `view`. Greedy, in
 * the given order, so the result is deterministic.
 */
export function placeLabels(o: {
  pos: (id: string) => Pt;
  names: Map<string, string>;
  nodes: string[];
  label: string[];
  edgePts: Pt[];
  size: number;
  r: number;
  view: Box;
}): { id: string; box: Box }[] {
  const nodeBoxes = o.nodes.map((id) => {
    const [x, y] = o.pos(id);
    return { x: x - o.r - 3, y: y - o.r - 3, w: 2 * o.r + 6, h: 2 * o.r + 6 };
  });
  const placed: { id: string; box: Box }[] = [];
  for (const id of o.label) {
    const [x, y] = o.pos(id);
    const w = textWidth(o.names.get(id)!, o.size) + 4;
    const h = o.size * 1.2;
    let best = 0;
    let bestScore = Infinity;
    for (let side = 0; side < 8; side++) {
      const b = labelBox(side, x, y, w, h, o.r + 5);
      const crossings = o.edgePts.filter(([px, py]) => px > b.x && px < b.x + b.w && py > b.y && py < b.y + b.h).length;
      const hits = placed.filter((p) => overlaps(b, p.box)).length * 200 + nodeBoxes.filter((n) => overlaps(b, n)).length * 60;
      const out = b.x < o.view.x || b.x + b.w > o.view.x + o.view.w || b.y < o.view.y || b.y + b.h > o.view.y + o.view.h ? 1 : 0;
      const score = Math.min(crossings, 40) * 3 + hits + out * 1000 + side * 0.5;
      if (score < bestScore) {
        bestScore = score;
        best = side;
      }
    }
    // Every spot overprints another label or leaves the drawing: leave this name to the tooltip.
    if (bestScore >= 200) continue;
    placed.push({ id, box: labelBox(best, x, y, w, h, o.r + 5) });
  }
  return placed;
}

/** A spot for a relation name along an edge, clear of node labels and of earlier relation names. */
export function placeRelation(pts: Pt[], text: string, size: number, avoid: Box[]): Box {
  const w = text.length * 0.62 * size + 10; // monospaced: about 0.6 em per character
  const h = size * 1.3;
  for (const f of [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74]) {
    const i = Math.round(f * (pts.length - 1));
    const [px, py] = pts[i];
    const [qx, qy] = pts[Math.min(pts.length - 1, i + 1)];
    const len = Math.hypot(qx - px, qy - py) || 1;
    const [nx, ny] = [-(qy - py) / len, (qx - px) / len];
    for (const off of [0, h * 0.9, -h * 0.9]) {
      const b = { x: px + nx * off - w / 2, y: py + ny * off - h / 2, w, h };
      if (!avoid.some((a) => overlaps(b, a))) return b;
    }
  }
  const [px, py] = pts[Math.round(pts.length / 2)];
  return { x: px - w / 2, y: py - h / 2, w, h };
}
