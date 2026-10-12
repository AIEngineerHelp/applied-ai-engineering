// The harness drawn as one isometric factory. Pure string building: the figure
// is a function of (installed parts, current step), re-drawn on every step.
// Motion (crates, gears, belts, the scan light) lives in engine.ts and is
// drawn into the empty #fx layer on top.
//
// World axes: x runs to the lower right, y to the lower left, z up. One world
// unit is S pixels. Faces: .t top, .l the face toward +y, .r the face toward +x.

import { PARTS, WINDOW, COMPACT_AT, type Block, type BlockKind, type PartId, type Step } from "../src/harness.ts";

export const S = 21;
const C = Math.cos(Math.PI / 6);

export type Pt = [number, number];
export type W = [number, number, number];

// Every projected point widens the bounds, so the view box fits the drawing.
const bounds = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
let tracking = true;
const grow = (x: number, y: number) => {
  if (!tracking) return;
  bounds.x0 = Math.min(bounds.x0, x);
  bounds.y0 = Math.min(bounds.y0, y);
  bounds.x1 = Math.max(bounds.x1, x);
  bounds.y1 = Math.max(bounds.y1, y);
};
const P = (x: number, y: number, z: number): Pt => {
  const p: Pt = [(x - y) * C * S, (x + y) * 0.5 * S - z * S];
  grow(...p);
  return p;
};
/** Projection without touching the bounds, for the animation layer. */
export const project = (w: W): Pt => [(w[0] - w[1]) * C * S, (w[0] + w[1]) * 0.5 * S - w[2] * S];

const f = (n: number) => n.toFixed(1);
const pts = (list: Pt[]) => list.map(([a, b]) => `${f(a)},${f(b)}`).join(" ");
const poly = (list: Pt[], cls: string, extra = "") => `<polygon class="${cls}" points="${pts(list)}"${extra}/>`;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A solid box: top, the +y face and the +x face. `m` picks the material. */
function box(x: number, y: number, z: number, w: number, d: number, h: number, m = "", extra = ""): string {
  const x1 = x + w, y1 = y + d, z1 = z + h;
  return [
    poly([P(x, y1, z), P(x1, y1, z), P(x1, y1, z1), P(x, y1, z1)], `l ${m}`, extra),
    poly([P(x1, y, z), P(x1, y1, z), P(x1, y1, z1), P(x1, y, z1)], `r ${m}`, extra),
    poly([P(x, y, z1), P(x1, y, z1), P(x1, y1, z1), P(x, y1, z1)], `t ${m}`, extra),
  ].join("");
}

/** A vertical cylinder, centre (x, y), from z to z + h. */
function cyl(x: number, y: number, z: number, r: number, h: number, m = ""): string {
  const rx = r * S * Math.SQRT2 * C, ry = r * S * Math.SQRT2 * 0.5;
  const [bx, by] = P(x, y, z), [tx, ty] = P(x, y, z + h);
  P(x - r, y + r, z); P(x + r, y - r, z + h);
  return [
    `<path class="l ${m}" d="M${f(bx - rx)},${f(by)} A${f(rx)},${f(ry)} 0 0 0 ${f(bx + rx)},${f(by)} L${f(tx + rx)},${f(ty)} L${f(tx - rx)},${f(ty)} Z"/>`,
    `<ellipse class="t ${m}" cx="${f(tx)}" cy="${f(ty)}" rx="${f(rx)}" ry="${f(ry)}"/>`,
  ].join("");
}

// Affine matrices that lay flat 2D drawings onto a face.
const FACE = { top: [C, 0.5, -C, 0.5], front: [C, 0.5, 0, 1], side: [C, -0.5, 0, 1] } as const;
const onFace = (plane: keyof typeof FACE, at: W, body: string, cls = "") => {
  const [tx, ty] = P(...at);
  return `<g class="${cls}" transform="matrix(${FACE[plane].join(",")},${f(tx)},${f(ty)})">${body}</g>`;
};

/** Text lying on a face. */
function label(text: string, x: number, y: number, z: number, plane: keyof typeof FACE, size = 7, cls = "lbl"): string {
  return onFace(plane, [x, y, z], `<text class="${cls}" font-size="${size}">${esc(text)}</text>`);
}

/** A line between two world points. */
const line = (a: W, b: W, cls = "edge") => {
  const [x1, y1] = P(...a), [x2, y2] = P(...b);
  return `<line class="${cls}" x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}"/>`;
};

/** A flat gear outline centred on the origin, radius in pixels. */
function gearPath(r: number, teeth: number): string {
  const d: string[] = [];
  const inner = r * 0.82, n = teeth * 4;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const rr = i % 4 < 2 ? r : inner;
    d.push(`${i ? "L" : "M"}${f(Math.cos(a) * rr)},${f(Math.sin(a) * rr)}`);
  }
  return `${d.join("")}Z M${f(r * 0.22)},0 A${f(r * 0.22)},${f(r * 0.22)} 0 1 0 ${f(-r * 0.22)},0 A${f(r * 0.22)},${f(r * 0.22)} 0 1 0 ${f(r * 0.22)},0Z`;
}

/** A gear painted on a face; engine.ts turns the inner group. */
const gear = (plane: keyof typeof FACE, at: W, r: number, teeth: number, dir: number, m = "") =>
  onFace(plane, at, `<g class="gear" data-dir="${dir}" data-r="${r}"><path class="gear-body ${m}" fill-rule="evenodd" d="${gearPath(r, teeth)}"/></g>`);

// ---------- Layout: where things are, shared with the animation ----------

export const TRAY = { x0: 4, len: 20, y: 15.8, d: 1.5, z: 0.25, h: 1.2 };
const SHELF = { x0: 20, x1: 28.6, y0: 1.6, y1: 3.5, scratch: 0.3, persistent: 2.5 };
const SB = { x0: 19, y0: 1, x1: 29.5, y1: 9.6, z1: 6 };

/** Points the crates travel between. */
export const STATION = {
  modelOut: [16.2, 11.7, 0.8] as W,
  modelFront: [12.5, 12.8, 0.8] as W,
  modelTop: [12.5, 9.9, 6.3] as W,
  rack: [3.6, 2.8, 3.2] as W,
  cabinet: [5.2, 9.6, 3.2] as W,
  board: [12.8, 1.8, 3.4] as W,
  sub: [[10.95, 4.25, 2.6], [14.65, 4.25, 2.6]] as W[],
  terminal: [21.8, 7.2, 1.4] as W,
  bench: [25.8, 7.2, 1.3] as W,
  ductTop: [21.2, 9.9, 4.6] as W,
  ductBottom: [21.2, 14.9, 2.0] as W,
  trayEntry: [21.2, 16.55, 1.6] as W,
  press: [7.05, 16.55, 1.6] as W,
  gate: [25.6, 11.7, 0.8] as W,
  branch: [27.9, 11.7, 1.6] as W,
  main: [29.5, 11.7, 1.6] as W,
};

/** Where each block sits in the tray: start x and width, in world units. */
export function slots(blocks: Block[]): Map<string, { x: number; w: number }> {
  const out = new Map<string, { x: number; w: number }>();
  const unit = TRAY.len / WINDOW;
  let x = TRAY.x0;
  for (const b of blocks) {
    const w = Math.max(0.12, b.tokens * unit);
    out.set(b.id, { x, w });
    x += w;
  }
  return out;
}

export const slotPoint = (s: { x: number; w: number }): W => [s.x + s.w / 2, TRAY.y + TRAY.d / 2, TRAY.z + TRAY.h + 0.2];

/** Where the i-th file sits on a shelf. */
export const shelfPoint = (shelf: "scratch" | "persistent", i: number): W => [SHELF.x0 + 2.95 + i * 1.15, SHELF.y0 + 0.95, SHELF[shelf] + 0.9];

/** The scan light: a pane across the tray at world x. */
export function scanPane(x: number): Pt[] {
  return [project([x, TRAY.y - 0.2, TRAY.z]), project([x, TRAY.y + TRAY.d + 0.2, TRAY.z]), project([x, TRAY.y + TRAY.d + 0.2, TRAY.z + 2.2]), project([x, TRAY.y - 0.2, TRAY.z + 2.2])];
}

/** A crate drawn around the origin, for the animation layer. */
export function crate(size: number, m: string, text?: string): string {
  tracking = false;
  const h = size / 2;
  // box() projects relative to the world origin, which projects to (0, 0).
  let svg = box(-h, -h, -h, size, size, size, m);
  tracking = true;
  if (text) {
    const w = text.length * 5.6 + 12;
    const y = -h * S - 22;
    svg += `<g class="crate-label"><rect x="${f(-w / 2)}" y="${f(y)}" width="${f(w)}" height="15" rx="7.5"/><text x="0" y="${f(y + 10.6)}" text-anchor="middle">${esc(text)}</text></g>`;
  }
  return svg;
}

// Where each numbered pin points, in world units.
const PIN: Record<PartId, W> = {
  skills: [3.4, 2.6, 3.6],
  memory: [2.5, 10.4, 4.4],
  summarization: [7.1, 16.4, 4.9],
  offloading: [21.2, 9.4, 5.3],
  repl: [21.6, 6.9, 3.4],
  sandbox: [29.5, 1, 6],
  filesystem: [24.4, 2.4, 5.1],
  code: [26.4, 7.6, 1.5],
  planning: [12.4, 1.2, 4.9],
  subagents: [11, 4.5, 2.6],
  hitl: [27.6, 14.1, 1.9],
};

export const PART_NUMBER: Record<PartId, number> = Object.fromEntries(PARTS.map((p, i) => [p.id, i + 1])) as Record<PartId, number>;

const GROUP_OF = Object.fromEntries(PARTS.map((p) => [p.id, p.group])) as Record<PartId, string>;

export const KIND_CLASS: Record<BlockKind, string> = {
  system: "k-ins", memory: "k-ins", skill: "k-ins", task: "k-ins", plan: "k-ins",
  file: "k-file", output: "k-out", tag: "k-tag", report: "k-rep", edit: "k-edit", summary: "k-sum",
};

export const LEGEND: { cls: string; name: string }[] = [
  { cls: "k-ins", name: "Instructions" },
  { cls: "k-file", name: "Files read" },
  { cls: "k-out", name: "Tool output" },
  { cls: "k-tag", name: "Offloaded: path + head/tail" },
  { cls: "k-rep", name: "Subagent report" },
  { cls: "k-edit", name: "Edits and notes" },
  { cls: "k-sum", name: "Summary" },
];

export interface FigureState {
  on: Set<PartId>;
  step: Step;
  /** When things that arrive this step should appear, in ms from the step start. */
  arrive: Map<string, number>;
  lastCall: string;
  shipped: "branch" | "main" | null;
  /** The model is called at the start of this step. */
  thinking: boolean;
  /** The window no longer fits: the alarm runs. */
  alarm: boolean;
  /** The window before this step, and the blocks the press squeezes out of it. */
  before: Block[];
  leaving: Block[];
}

/** Inline style that hides something until its crate lands. */
const at = (st: FigureState, id: string) => {
  const ms = st.arrive.get(id);
  return ms === undefined ? "" : ` style="--d:${Math.round(ms)}ms"`;
};
const arriving = (st: FigureState, id: string) => (st.arrive.has(id) ? " arrive" : "");

/** Wraps one part so it can be hovered, selected and pulled out. */
function part(id: PartId, st: FigureState, body: string): string {
  const removed = !st.on.has(id);
  const active = st.step.active.includes(id);
  const cls = ["part", removed ? "removed" : "", active ? "active" : ""].join(" ").trim();
  return `<g class="${cls}" data-part="${id}" data-group="${GROUP_OF[id]}">${body}</g>`;
}

export function drawFigure(st: FigureState): string {
  const { step } = st;
  const out: string[] = [];
  Object.assign(bounds, { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });

  // Factory floor, with the one engraved line on its front edge.
  out.push(`<g class="plate">${box(0, 0, -0.6, 30.5, 19.6, 0.6, "plate")}</g>`);
  out.push(label("AGENT = MODEL + HARNESS", 1.2, 19.6, -0.47, "front", 8.5, "lbl lbl-plate"));

  // 1 · Skills: a rack of eight playbook cards. One is pulled when a task matches.
  {
    let g = box(1, 1, 0, 5.4, 3.6, 0.45);
    for (let i = 0; i < 8; i++) {
      const x = 1.35 + i * 0.62;
      const out_ = step.skillOut === i;
      const m = out_ ? "acc" : "card";
      g += `<g class="${out_ ? "lift" : ""}"${out_ ? at(st, "lift") : ""}>${box(x, 1.45, 0.45, 0.11, 2.7, 2.2, m)}${box(x, 1.55 + (i % 3) * 0.75, 2.65, 0.11, 0.6, 0.32, m)}</g>`;
    }
    g += label("SKILLS", 1.4, 4.6, 0.12, "front", 8.1);
    out.push(part("skills", st, g));
  }

  // 9 · Planning: a peg board with one tag per to-do.
  {
    let g = box(9.2, 0.9, 0, 0.35, 0.35, 4.8) + box(16.1, 0.9, 0, 0.35, 0.35, 4.8);
    g += box(9, 1.25, 0.8, 7.7, 0.25, 4.1, "board");
    const todos = step.todos.length ? step.todos : Array.from({ length: 5 }, () => ({ done: false, text: "" }));
    todos.forEach((t, i) => {
      const x = 9.45 + i * 1.5;
      const m = !step.todos.length ? "blank" : t.done ? "done" : "tag";
      const id = `todo:${i}`;
      g += `<g class="${arriving(st, id)}"${at(st, id)}${t.text ? ` data-tip="${esc(`${i + 1}. ${t.text}${t.done ? " — done" : ""}`)}"` : ""}>${box(x, 1.5, 2.4, 1.15, 0.1, 1.55, m)}</g>`;
      g += label(String(i + 1), x + 0.15, 1.6, 3.65, "front", 8.8, "lbl lbl-num");
      if (t.done) {
        const [a, b] = P(x + 0.35, 1.6, 2.95), [c, d] = P(x + 0.55, 1.6, 2.7), [e, h] = P(x + 0.95, 1.6, 3.3);
        const tick = st.arrive.has(`tick:${i}`) ? `tick:${i}` : id;
        g += `<path class="tick${arriving(st, tick)}"${at(st, tick)} d="M${f(a)},${f(b)} L${f(c)},${f(d)} L${f(e)},${f(h)}"/>`;
      }
    });
    g += label("PLAN", 9.4, 1.5, 1.6, "front", 8.8);
    out.push(part("planning", st, g));
  }

  // 10 · Subagents: two small engines, each with its own small window.
  {
    let g = "";
    [9.7, 13.4].forEach((x, i) => {
      const used = step.subagents[i] ?? 0;
      const busy = used > 0;
      g += box(x, 3.2, 0, 2.5, 2.1, 2.3, busy ? "acc-dark" : "dark");
      g += gear("front", [x + 0.75, 5.3, 1.25], 9, 8, i ? -1 : 1, busy ? "gear-hot" : "");
      g += cyl(x + 1.25, 4.25, 2.3, 0.45, 0.35, busy ? "acc-dark" : "dark");
      g += box(x - 0.1, 5.55, 0, 2.7, 0.85, 0.3);
      const len = Math.min(2.5, (used / WINDOW) * 2.5);
      const id = `sub:${i}`;
      if (len > 0) g += `<g class="${arriving(st, id)}"${at(st, id)} data-tip="${esc(`Subagent window: ${Math.round(used / 1000)}k tokens`)}">${box(x, 5.65, 0.3, len, 0.65, 0.35, "k-file")}</g>`;
    });
    out.push(part("subagents", st, g));
  }

  // 6 · Sandbox (floor and back panes), then what lives inside it.
  out.push(
    part(
      "sandbox",
      st,
      box(SB.x0, SB.y0, -0.05, SB.x1 - SB.x0, SB.y1 - SB.y0, 0.3, "slab") +
        poly([P(SB.x0, SB.y0, 0.25), P(SB.x1, SB.y0, 0.25), P(SB.x1, SB.y0, SB.z1), P(SB.x0, SB.y0, SB.z1)], "glass") +
        poly([P(SB.x0, SB.y0, 0.25), P(SB.x0, SB.y1, 0.25), P(SB.x0, SB.y1, SB.z1), P(SB.x0, SB.y0, SB.z1)], "glass"),
    ),
  );

  // 7 · File system: two shelves, persistent above scratch.
  {
    let g = "";
    const { x0, x1, y0, y1 } = SHELF;
    for (const x of [x0, x1 - 0.25]) g += box(x, y0, 0.25, 0.25, 0.25, 4.6);
    const shelf = (z: number) => box(x0, y0, z, x1 - x0, y1 - y0, 0.2, "shelf");
    const files = (list: string[], which: "scratch" | "persistent", m: string) =>
      list
        .map((name, i) => {
          const [cx, cy, cz] = shelfPoint(which, i);
          const id = `file:${name}`;
          return `<g class="${arriving(st, id)}"${at(st, id)} data-tip="${esc(name)}">${box(cx - 0.45, cy - 0.65, cz - 0.7, 0.9, 1.3, 0.75 + (i % 2) * 0.25, m)}</g>`;
        })
        .join("");
    g += shelf(SHELF.scratch) + files(step.scratch, "scratch", "k-out");
    g += shelf(SHELF.persistent) + files(step.persistent, "persistent", "k-edit");
    g += shelf(4.7);
    for (const x of [x0, x1 - 0.25]) g += box(x, y1 - 0.25, 0.25, 0.25, 0.25, 4.6);
    g += label("SCRATCH", x0 + 0.4, y1, 0.36, "front", 7.4);
    g += label("PERSISTENT", x0 + 0.4, y1, 2.56, "front", 7.4);
    out.push(part("filesystem", st, g));
  }

  // 5 · REPL: a terminal that runs the call and prints the result.
  {
    let g = box(20.1, 6.1, 0, 3.2, 2.4, 1.05);
    g += box(20.5, 6.4, 1.05, 2.5, 0.3, 2.1, "dark");
    const call = st.lastCall.length > 26 ? `${st.lastCall.slice(0, 25)}…` : st.lastCall;
    g += poly([P(20.65, 6.71, 1.25), P(22.85, 6.71, 1.25), P(22.85, 6.71, 3.0), P(20.65, 6.71, 3.0)], "screen");
    g += label(`$ ${call}`, 20.75, 6.71, 2.75, "front", 6.2, "lbl lbl-screen");
    g += onFace("front", [20.75, 6.71, 2.3], `<rect class="cursor" width="4" height="6" y="-5"/>`);
    g += label("REPL", 20.3, 8.5, 0.3, "front", 7.4);
    out.push(part("repl", st, g));
  }

  // 8 · Write & run code: a workbench with a script being written on it.
  {
    let g = box(24.4, 6.1, 0, 3.9, 2.4, 1.05);
    const writing = step.active.includes("code");
    g += box(25, 6.5, 1.05, 1.6, 1.5, 0.06, writing ? "acc" : "paper");
    const wd = st.arrive.get("write") ?? 0;
    for (let i = 0; i < 5; i++) g += `<g class="${writing ? "write" : ""}" style="--i:${i};--d:${Math.round(wd)}ms">${line([25.2, 6.75 + i * 0.25, 1.12], [25.2 + 0.6 + (i % 3) * 0.3, 6.75 + i * 0.25, 1.12], "ink")}</g>`;
    g += cyl(27.4, 7.3, 1.05, 0.28, 0.9, "dark");
    g += label("CODE", 24.6, 8.5, 0.3, "front", 7.4);
    out.push(part("code", st, g));
  }

  // 6 · Sandbox front panes and frame, over everything inside it.
  out.push(
    part(
      "sandbox",
      st,
      poly([P(SB.x0, SB.y1, 0.25), P(SB.x1, SB.y1, 0.25), P(SB.x1, SB.y1, SB.z1), P(SB.x0, SB.y1, SB.z1)], "glass glass-front") +
        poly([P(SB.x1, SB.y0, 0.25), P(SB.x1, SB.y1, 0.25), P(SB.x1, SB.y1, SB.z1), P(SB.x1, SB.y0, SB.z1)], "glass glass-front") +
        poly([P(SB.x0, SB.y0, SB.z1), P(SB.x1, SB.y0, SB.z1), P(SB.x1, SB.y1, SB.z1), P(SB.x0, SB.y1, SB.z1)], "glass glass-top") +
        label("SANDBOX", SB.x0 + 0.4, SB.y1, 5.55, "front", 8.1),
    ),
  );

  // 2 · Memory: a filing cabinet whose top drawer opens when notes are read or written.
  {
    const open = step.active.includes("memory");
    let g = box(1, 7.6, 0, 3.4, 4, 4.2);
    g += box(4.4, 7.9, 0.3, 0.15, 3.4, 1.75) + box(4.55, 9.2, 1.0, 0.12, 0.8, 0.18);
    g += `<g class="${open ? "drawer-open" : ""}"${open ? at(st, "drawer") : ""}>${box(4.4, 7.9, 2.25, 0.15, 3.4, 1.75, open ? "acc" : "")}${box(4.55, 9.2, 2.95, 0.12, 0.8, 0.18)}${label("AGENTS.md", 4.56, 11.1, 3.55, "side", 6.8)}</g>`;
    g += label("NOTES", 4.56, 11.1, 1.6, "side", 6.8);
    g += label("MEMORY", 1.2, 11.6, 0.35, "front", 8.1);
    out.push(part("memory", st, g));
  }

  // The model: a sealed engine with gears on its side and a stack on top.
  {
    let g = box(9, 7.4, 0, 7, 5, 5.4, "dark");
    g += cyl(12.5, 9.9, 5.4, 1.3, 0.5, "dark");
    g += cyl(14.6, 8.6, 5.4, 0.35, 0.9, `beacon${st.alarm ? " alarm" : ""}`);
    for (let i = 0; i < 5; i++) g += line([9.6 + i * 0.25, 7.8, 5.4], [9.6 + i * 0.25, 11.9, 5.4], "vent");
    g += gear("side", [16, 11.0, 3.4], 24, 14, 1, "gear-model");
    g += gear("side", [16, 9.05, 4.15], 15, 9, -1.6, "gear-model");
    g += gear("side", [16, 8.75, 2.05], 11, 7, -2.2, "gear-model");
    g += label("MODEL", 9.6, 12.4, 4.4, "front", 14.9, "lbl lbl-model");
    g += label("text in · text out", 9.6, 12.4, 3.5, "front", 8.1, "lbl lbl-model-sub");
    out.push(`<g class="core model${st.thinking ? " thinking" : ""}" data-core="model"${st.thinking ? ` style="--d:${Math.round(st.arrive.get("think") ?? 0)}ms"` : ""}>${g}</g>`);
  }

  // Output belt toward the gate, with moving slats.
  out.push(`<g class="core" data-core="belt">${box(16, 11.1, 0, 10.6, 1.2, 0.45, "belt")}${line([16.1, 11.4, 0.46], [26.5, 11.4, 0.46], "belt-line")}${line([16.1, 12.0, 0.46], [26.5, 12.0, 0.46], "belt-line")}</g>`);

  // 11 · Human in the loop: a gate across the belt, with a person's lever.
  {
    const gate = step.gate;
    let g = box(25.7, 10.5, 0, 0.5, 0.5, 3.2) + box(25.7, 12.4, 0, 0.5, 0.5, 3.2);
    if (gate === "waiting" || gate === "idle") g += box(25.8, 10.6, 1.0, 0.3, 2.3, 0.35, gate === "waiting" ? "acc" : "");
    else g += `<g class="${gate === "approved" ? "gate-open" : ""}"${gate === "approved" ? at(st, "gate") : ""}>${box(25.8, 10.6, 1.0, 0.3, 0.35, 2.4, gate === "approved" ? "acc" : "")}</g>`;
    // The change waits on the belt until a person decides.
    if (gate === "waiting") g += `<g class="${arriving(st, "parked")}"${at(st, "parked")}>${box(24.55, 11.2, 0.45, 1.05, 1.05, 1.05, "k-edit")}</g>`;
    g += box(26.8, 13.4, 0, 1.6, 1.4, 1.5);
    g += cyl(27.6, 14.1, 1.5, 0.42, 0.35, gate === "waiting" ? "acc blink" : "button");
    g += label("APPROVE", 26.9, 14.8, 0.6, "front", 6.2);
    out.push(part("hitl", st, g));
  }

  // Where shipped work lands: two slots, a review branch and main.
  {
    let g = box(27.1, 10.4, 0, 3.1, 2.6, 1.3);
    g += label("BRANCH", 27.25, 13.0, 0.85, "front", 6.2) + label("MAIN", 28.95, 13.0, 0.85, "front", 6.2);
    if (st.shipped) g += `<g class="${arriving(st, "ship")}"${at(st, "ship")}>${box(st.shipped === "branch" ? 27.4 : 29.0, 10.9, 1.3, 1.0, 1.6, 0.25, st.shipped === "main" ? "bad" : "k-edit")}</g>`;
    out.push(`<g class="core" data-core="outbox">${g}</g>`);
  }

  // Feed belt from the tray up to the model.
  out.push(`<g class="core" data-core="feed">${box(11, 12.4, 0, 4, 3.1, 0.3, "belt")}${[11.6, 12.5, 13.4, 14.3].map((x) => line([x, 15.4, 0.31], [x, 12.5, 0.31], "belt-line belt-in")).join("")}</g>`);

  // The return line: tool output travels from the sandbox down to the tray.
  {
    const xa = 20.6, xb = 21.8, ya = 14.7, yb = SB.y1, za = 1.3, zb = 4.0, h = 0.7;
    let g = box(20.6, 12.6, 0, 0.3, 0.3, 2.9) + box(21.5, 12.6, 0, 0.3, 0.3, 2.9);
    g += poly([P(xb, ya, za), P(xb, yb, zb), P(xb, yb, zb + h), P(xb, ya, za + h)], "r");
    g += poly([P(xa, ya, za + h), P(xb, ya, za + h), P(xb, yb, zb + h), P(xa, yb, zb + h)], "t");
    g += line([21.2, ya, za + h + 0.01], [21.2, yb, zb + h + 0.01], "belt-line belt-down");
    g += box(20.2, 14.6, 0.5, 2.0, 0.95, 1.0);
    out.push(`<g class="core" data-core="return">${g}</g>`);
  }

  // 4 · Context offloading: a diverter on the return line that sends big output to a file.
  {
    const flow = step.chute;
    let g = box(20.35, 9.7, 3.6, 1.7, 1.3, 1.25, flow ? "acc" : "");
    g += `<g class="${flow ? "flap" : ""}"${flow ? at(st, "flap") : ""}>${box(20.45, 9.75, 4.85, 1.5, 0.4, 0.12, flow ? "acc-dark" : "dark")}</g>`;
    g += label("DIVERT", 20.5, 11.0, 3.95, "front", 5.5);
    out.push(part("offloading", st, g));
  }

  // The context window: a tray 20 units long, one unit per 10k tokens.
  {
    const { x0, len } = TRAY;
    let g = box(x0, 15.5, 0, len, 2.1, 0.25, "tray");
    g += box(x0, 15.5, 0.25, len, 0.15, 0.75, "tray");
    // Blocks the press squeezes out are drawn where they were, then flattened.
    const was = slots(st.before);
    for (const b of st.leaving) {
      const { x, w } = was.get(b.id)!;
      g += `<g class="blk leave"${at(st, "leave")}>${box(x, TRAY.y, TRAY.z, w - 0.04, TRAY.d, TRAY.h, KIND_CLASS[b.kind])}</g>`;
    }
    const at_ = slots(step.blocks);
    for (const b of step.blocks) {
      const { x, w } = at_.get(b.id)!;
      const over = x + w > x0 + len;
      const m = over ? "bad" : KIND_CLASS[b.kind];
      g += `<g class="blk${arriving(st, b.id)}${over ? " over" : ""}"${at(st, b.id)} data-tip="${esc(`${b.label} · ${b.tokens.toLocaleString("en-US")} tokens`)}">${box(x, TRAY.y, TRAY.z, w - 0.04, TRAY.d, TRAY.h, m)}</g>`;
    }
    g += box(x0, 17.45, 0.25, len, 0.15, 0.35, "tray");
    g += box(x0 + len, 15.5, 0.25, 0.15, 2.1, 0.75, "tray");
    for (let i = 0; i <= 20; i++) g += line([x0 + i, 17.7, 0], [x0 + i, i % 5 === 0 ? 18.05 : 17.9, 0], "tickmark");
    for (const k of [0, 50, 100, 150, 200]) g += label(`${k}k`, x0 + k / 10 - 0.15, 18.45, 0, "top", 7.4, "lbl lbl-scale");
    const cx = x0 + (COMPACT_AT / WINDOW) * len;
    g += line([cx, 15.5, 1.0], [cx, 17.6, 0.6], "threshold");
    g += label("CONTEXT WINDOW · 200K TOKENS", x0 + 0.1, 19.25, 0, "top", 8.1, "lbl lbl-strong");
    out.push(`<g class="core" data-core="window">${g}</g>`);
  }

  // 3 · Summarization: a press over the tray that comes down at the threshold.
  {
    const down = step.pressing;
    let g = box(5.6, 14.9, 0, 0.45, 0.45, 4.4) + box(5.6, 17.85, 0, 0.45, 0.45, 4.4);
    g += box(5.6, 14.9, 4.4, 2.9, 3.4, 0.5, down ? "acc" : "");
    g += `<g class="${down ? "pressing" : ""}"${down ? at(st, "press") : ""}>${cyl(7.05, 16.6, 2.85, 0.35, 1.55, "steel")}${box(5.95, 15.75, 2.6, 2.2, 1.7, 0.3, down ? "acc" : "dark")}</g>`;
    out.push(part("summarization", st, g));
  }

  // The animation layer: crates, the scan light, steam.
  out.push(`<g id="fx" pointer-events="none"></g>`);

  // Numbered pins, on top of everything.
  for (const p of PARTS) {
    const [ax, ay] = P(...PIN[p.id]);
    grow(ax - 9, ay - 40);
    const removed = !st.on.has(p.id);
    const active = step.active.includes(p.id);
    out.push(
      `<g class="pin${removed ? " removed" : ""}${active ? " active" : ""}" data-part="${p.id}" data-group="${p.group}">` +
        `<line x1="${f(ax)}" y1="${f(ay)}" x2="${f(ax)}" y2="${f(ay - 24)}"/><circle cx="${f(ax)}" cy="${f(ay - 31)}" r="7.5"/>` +
        `<text x="${f(ax)}" y="${f(ay - 28.2)}" text-anchor="middle">${PART_NUMBER[p.id]}</text></g>`,
    );
  }

  const pad = 10;
  const vb = [bounds.x0 - pad, bounds.y0 - pad, bounds.x1 - bounds.x0 + pad * 2, bounds.y1 - bounds.y0 + pad * 2];
  return `<svg class="machine" viewBox="${vb.map((v) => v.toFixed(0)).join(" ")}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="An agent harness drawn as a factory: the model in the centre, the context window as a tray in front of it, and eleven numbered parts around it.">${out.join("")}</svg>`;
}
