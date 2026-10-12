// The harness drawn as one isometric machine. Pure string building: the figure
// is a function of (installed parts, current step), re-drawn on every change.
//
// World axes: x runs to the lower right, y to the lower left, z up. One world
// unit is S pixels. Faces: .t top, .l the face toward +y, .r the face toward +x.

import { GROUPS, PARTS, WINDOW, COMPACT_AT, type Block, type BlockKind, type PartId, type Step } from "../src/harness.ts";

const S = 21;
const C = Math.cos(Math.PI / 6);

type Pt = [number, number];
// Every projected point widens the bounds, so the view box fits the drawing.
const bounds = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
const grow = (x: number, y: number) => {
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
const pts = (list: Pt[]) => list.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join(" ");
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
  return [
    `<path class="l ${m}" d="M${bx - rx},${by} A${rx},${ry} 0 0 0 ${bx + rx},${by} L${tx + rx},${ty} L${tx - rx},${ty} Z"/>`,
    `<ellipse class="t ${m}" cx="${tx}" cy="${ty}" rx="${rx}" ry="${ry}"/>`,
  ].join("");
}

/** Text lying on a face. `plane` is the face it is painted on. */
function label(text: string, x: number, y: number, z: number, plane: "top" | "front" | "side", size = 7, cls = "lbl"): string {
  const [tx, ty] = P(x, y, z);
  const m = plane === "top" ? [C, 0.5, -C, 0.5] : plane === "front" ? [C, 0.5, 0, 1] : [C, -0.5, 0, 1];
  return `<text class="${cls}" font-size="${size}" transform="matrix(${m.join(",")},${tx.toFixed(1)},${ty.toFixed(1)})">${esc(text)}</text>`;
}

/** A line between two world points. */
const line = (a: [number, number, number], b: [number, number, number], cls = "edge") => {
  const [x1, y1] = P(...a), [x2, y2] = P(...b);
  return `<line class="${cls}" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;
};

// Where each numbered pin points, in world units.
const PIN: Record<PartId, [number, number, number]> = {
  skills: [3.4, 2.6, 3.6],
  memory: [2.5, 10.4, 4.4],
  summarization: [7.1, 16.4, 4.9],
  offloading: [21.2, 12.3, 3.4],
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

const KIND_CLASS: Record<BlockKind, string> = {
  system: "k-ins", memory: "k-ins", skill: "k-ins", task: "k-ins", plan: "k-ins",
  file: "k-file", output: "k-out", tag: "k-tag", report: "k-rep", edit: "k-edit", summary: "k-sum",
};

export const LEGEND: { cls: string; name: string }[] = [
  { cls: "k-ins", name: "Instructions" },
  { cls: "k-file", name: "Files read" },
  { cls: "k-out", name: "Tool output" },
  { cls: "k-tag", name: "Offloaded (path + head/tail)" },
  { cls: "k-rep", name: "Subagent report" },
  { cls: "k-edit", name: "Edits and notes" },
  { cls: "k-sum", name: "Summary" },
];

export interface FigureState {
  on: Set<PartId>;
  step: Step;
  /** Blocks that were not in the previous step, so they can animate in. */
  fresh: Set<string>;
  /** The step's index; the last call to show on the terminal. */
  lastCall: string;
  /** True after the final step, to show where the change landed. */
  shipped: "branch" | "main" | null;
}

/** Wraps one part so it can be hovered, selected and pulled out. */
function part(id: PartId, st: FigureState, body: string): string {
  const removed = !st.on.has(id);
  const active = st.step.active.includes(id);
  const cls = ["part", removed ? "removed" : "", active ? "active" : ""].join(" ").trim();
  return `<g class="${cls}" data-part="${id}" data-group="${GROUP_OF[id]}" tabindex="-1">${body}</g>`;
}

export function drawFigure(st: FigureState): string {
  const { step } = st;
  const out: string[] = [];
  Object.assign(bounds, { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });

  // Base plate, with the machine's one engraved line on its front edge.
  out.push(`<g class="plate">${box(0, 0, -0.6, 30.5, 19.6, 0.6, "plate")}</g>`);
  out.push(label("AGENT = MODEL + HARNESS", 1.2, 19.6, -0.47, "front", 8.5, "lbl lbl-plate"));

  // 1 · Skills: a rack of eight playbook cards. One is pulled when a task matches.
  {
    let g = box(1, 1, 0, 5.4, 3.6, 0.45);
    for (let i = 0; i < 8; i++) {
      const x = 1.35 + i * 0.62;
      const up = step.skillOut === i ? 1.9 : 0;
      const m = step.skillOut === i ? "acc" : "card";
      g += box(x, 1.45, 0.45 + up, 0.11, 2.7, 2.2, m);
      g += box(x, 1.55 + (i % 3) * 0.75, 2.65 + up, 0.11, 0.6, 0.32, m);
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
      g += box(x, 1.5, 2.4, 1.15, 0.1, 1.55, m, t.text ? ` data-tip="${esc(`${i + 1}. ${t.text}${t.done ? " — done" : ""}`)}"` : "");
      g += label(String(i + 1), x + 0.15, 1.6, 3.65, "front", 8.8, "lbl lbl-num");
      if (t.done) {
        const [a, b] = P(x + 0.35, 1.6, 2.95), [c, d] = P(x + 0.55, 1.6, 2.7), [e, f] = P(x + 0.95, 1.6, 3.3);
        g += `<path class="tick" d="M${a},${b} L${c},${d} L${e},${f}"/>`;
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
      g += cyl(x + 1.25, 4.25, 2.3, 0.45, 0.35, busy ? "acc-dark" : "dark");
      g += box(x - 0.1, 5.55, 0, 2.7, 0.85, 0.3);
      const len = Math.min(2.5, (used / WINDOW) * 2.5);
      if (len > 0) g += box(x, 5.65, 0.3, len, 0.65, 0.35, "k-file", ` data-tip="${esc(`Subagent window: ${Math.round(used / 1000)}k tokens`)}"`);
    });
    out.push(part("subagents", st, g));
  }

  // 6 · Sandbox (back panes), then what lives inside it.
  const sb = { x0: 19, y0: 1, x1: 29.5, y1: 9.6, z0: 0, z1: 6 };
  {
    const g =
      box(sb.x0, sb.y0, -0.05, sb.x1 - sb.x0, sb.y1 - sb.y0, 0.3, "slab") +
      poly([P(sb.x0, sb.y0, 0.25), P(sb.x1, sb.y0, 0.25), P(sb.x1, sb.y0, sb.z1), P(sb.x0, sb.y0, sb.z1)], "glass") +
      poly([P(sb.x0, sb.y0, 0.25), P(sb.x0, sb.y1, 0.25), P(sb.x0, sb.y1, sb.z1), P(sb.x0, sb.y0, sb.z1)], "glass");
    out.push(part("sandbox", st, g));
  }

  // 7 · File system: two shelves, persistent above scratch.
  {
    let g = "";
    const x0 = 20, x1 = 28.6, y0 = 1.6, y1 = 3.5;
    for (const x of [x0, x1 - 0.25]) g += box(x, y0, 0.25, 0.25, 0.25, 4.6) ;
    const shelf = (z: number) => box(x0, y0, z, x1 - x0, y1 - y0, 0.2, "shelf");
    const files = (list: string[], z: number, m: string) =>
      list
        .map((f, i) => box(x0 + 2.5 + i * 1.15, y0 + 0.3, z + 0.2, 0.9, 1.3, 0.75 + (i % 2) * 0.25, m, ` data-tip="${esc(f)}"`))
        .join("");
    g += shelf(0.3) + files(step.scratch, 0.3, "k-out");
    g += shelf(2.5) + files(step.persistent, 2.5, "k-edit");
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
    g += label(`$ ${call || "_"}`, 20.75, 6.71, 2.75, "front", 6.2, "lbl lbl-screen");
    g += label(step.active.includes("repl") ? "exit 0" : "", 20.75, 6.71, 2.35, "front", 6.2, "lbl lbl-screen");
    g += label("REPL", 20.3, 8.5, 0.3, "front", 7.4);
    out.push(part("repl", st, g));
  }

  // 8 · Write & run code: a workbench with a script on it.
  {
    let g = box(24.4, 6.1, 0, 3.9, 2.4, 1.05);
    const writing = step.active.includes("code");
    g += box(25, 6.5, 1.05, 1.6, 1.5, 0.06, writing ? "acc" : "paper");
    for (let i = 0; i < 5; i++) g += line([25.2, 6.75 + i * 0.25, 1.12], [25.2 + 0.6 + (i % 3) * 0.3, 6.75 + i * 0.25, 1.12], "ink");
    g += cyl(27.4, 7.3, 1.05, 0.28, 0.9, "dark");
    g += label("CODE", 24.6, 8.5, 0.3, "front", 7.4);
    out.push(part("code", st, g));
  }

  // 6 · Sandbox front panes and frame, over everything inside it.
  {
    const g =
      poly([P(sb.x0, sb.y1, 0.25), P(sb.x1, sb.y1, 0.25), P(sb.x1, sb.y1, sb.z1), P(sb.x0, sb.y1, sb.z1)], "glass glass-front") +
      poly([P(sb.x1, sb.y0, 0.25), P(sb.x1, sb.y1, 0.25), P(sb.x1, sb.y1, sb.z1), P(sb.x1, sb.y0, sb.z1)], "glass glass-front") +
      poly([P(sb.x0, sb.y0, sb.z1), P(sb.x1, sb.y0, sb.z1), P(sb.x1, sb.y1, sb.z1), P(sb.x0, sb.y1, sb.z1)], "glass glass-top") +
      label("SANDBOX", sb.x0 + 0.4, sb.y1, 5.55, "front", 8.1);
    out.push(part("sandbox", st, g));
  }

  // 2 · Memory: a filing cabinet whose top drawer opens when notes are read or written.
  {
    const open = step.active.includes("memory") ? 0.9 : 0;
    let g = box(1, 7.6, 0, 3.4, 4, 4.2);
    g += box(4.4, 7.9, 0.3, 0.15, 3.4, 1.75);
    g += box(4.4 + open, 7.9, 2.25, 0.15, 3.4, 1.75, open ? "acc" : "");
    if (open) g += box(4.4, 7.9, 3.85, open, 3.4, 0.08, "acc");
    g += box(4.55, 9.2, 1.0, 0.12, 0.8, 0.18) + box(4.55 + open, 9.2, 2.95, 0.12, 0.8, 0.18);
    g += label("AGENTS.md", 4.56 + open, 11.1, 3.55, "side", 6.8);
    g += label("NOTES", 4.56, 11.1, 1.6, "side", 6.8);
    g += label("MEMORY", 1.2, 11.6, 0.35, "front", 8.1);
    out.push(part("memory", st, g));
  }

  // The model: a sealed engine. Text in from the tray, text out to the belt.
  out.push(`<g class="core" data-core="model">${box(9, 7.4, 0, 7, 5, 5.4, "dark")}${cyl(12.5, 9.9, 5.4, 1.3, 0.5, "dark")}${[0, 1, 2, 3, 4]
    .map((i) => line([9.6 + i * 0.25, 7.8, 5.4], [9.6 + i * 0.25, 11.9, 5.4], "vent"))
    .join("")}${label("MODEL", 9.6, 12.4, 4.4, "front", 14.9, "lbl lbl-model")}${label("text in · text out", 9.6, 12.4, 3.5, "front", 8.1, "lbl lbl-model-sub")}</g>`);

  // Output belt toward the gate.
  out.push(`<g class="core">${box(16, 11.1, 0, 10.6, 1.2, 0.45, "belt")}${[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => line([16.6 + i, 11.1, 0.45], [16.6 + i, 12.3, 0.45], "edge")).join("")}</g>`);

  // 11 · Human in the loop: a gate across the belt, with a person's lever.
  {
    const gate = step.gate;
    let g = box(25.7, 10.5, 0, 0.5, 0.5, 3.2) + box(25.7, 12.4, 0, 0.5, 0.5, 3.2);
    if (gate === "waiting") g += box(25.8, 10.6, 1.0, 0.3, 2.3, 0.35, "acc");
    else if (gate === "idle") g += box(25.8, 10.6, 1.0, 0.3, 2.3, 0.35);
    else g += box(25.8, 10.6, 1.0, 0.3, 0.35, 2.4, gate === "approved" ? "acc" : "");
    g += box(26.8, 13.4, 0, 1.6, 1.4, 1.5);
    g += cyl(27.6, 14.1, 1.5, 0.42, 0.35, gate === "waiting" ? "acc" : "button");
    g += label("APPROVE", 26.9, 14.8, 0.6, "front", 6.2);
    out.push(part("hitl", st, g));
  }

  // Where shipped work lands: two slots, main and a review branch.
  {
    let g = box(27.1, 10.4, 0, 3.1, 2.6, 1.3);
    g += label("BRANCH", 27.25, 13.0, 0.85, "front", 6.2) + label("MAIN", 28.95, 13.0, 0.85, "front", 6.2);
    if (st.shipped) g += box(st.shipped === "branch" ? 27.4 : 29.0, 10.9, 1.3, 1.0, 1.6, 0.25, st.shipped === "main" ? "bad" : "k-edit");
    out.push(`<g class="core">${g}</g>`);
  }

  // Feed ramp from the tray to the model.
  out.push(`<g class="core">${box(11, 12.4, 0, 4, 3.1, 0.3, "belt")}${[0, 1, 2, 3, 4].map((i) => line([11, 12.9 + i * 0.55, 0.3], [15, 12.9 + i * 0.55, 0.3], "edge")).join("")}</g>`);

  // 4 · Context offloading: a hopper behind the tray and a duct into the sandbox.
  {
    const flow = step.chute ? "acc" : "";
    const xa = 20.5, xb = 21.9, ya = 14.7, yb = sb.y1, za = 1.3, zb = 4.0, h = 0.7;
    let g = box(20.6, 12.6, 0, 0.3, 0.3, 2.9) + box(21.5, 12.6, 0, 0.3, 0.3, 2.9);
    g += poly([P(xb, ya, za), P(xb, yb, zb), P(xb, yb, zb + h), P(xb, ya, za + h)], `r ${flow}`);
    g += poly([P(xa, ya, za + h), P(xb, ya, za + h), P(xb, yb, zb + h), P(xa, yb, zb + h)], `t ${flow}`);
    g += box(20.2, 14.6, 0.5, 2.0, 0.95, 1.0, flow);
    out.push(part("offloading", st, g));
  }

  // The context window: a tray 20 units long, one unit per 10k tokens.
  {
    const x0 = 4, len = 20, unit = len / WINDOW;
    let g = box(x0, 15.5, 0, len, 2.1, 0.25, "tray");
    g += box(x0, 15.5, 0.25, len, 0.15, 0.75, "tray");
    let x = x0;
    for (const b of step.blocks) {
      const w = Math.max(0.12, b.tokens * unit);
      const over = x + w > x0 + len;
      const m = over ? "bad" : KIND_CLASS[b.kind];
      const fresh = st.fresh.has(b.id) ? " fresh" : "";
      g += `<g class="blk${fresh}" data-tip="${esc(`${b.label} · ${b.tokens.toLocaleString("en-US")} tokens`)}">${box(x, 15.8, 0.25, w - 0.04, 1.5, 1.2, m)}</g>`;
      x += w;
    }
    g += box(x0, 17.45, 0.25, len, 0.15, 0.35, "tray");
    g += box(x0 + len, 15.5, 0.25, 0.15, 2.1, 0.75, "tray");
    for (let i = 0; i <= 20; i++) {
      const tall = i % 5 === 0;
      g += line([x0 + i, 17.7, 0], [x0 + i, tall ? 18.05 : 17.9, 0], "tickmark");
    }
    for (const k of [0, 50, 100, 150, 200]) g += label(`${k}k`, x0 + k / 10 - 0.15, 18.45, 0, "top", 7.4, "lbl lbl-scale");
    const cx = x0 + COMPACT_AT * unit;
    g += line([cx, 15.5, 1.0], [cx, 17.6, 0.6], "threshold");
    g += label("CONTEXT WINDOW · 200K TOKENS", x0 + 0.1, 19.25, 0, "top", 8.1, "lbl lbl-strong");
    out.push(`<g class="core" data-core="window">${g}</g>`);
  }

  // 3 · Summarization: a press over the tray that comes down at the threshold.
  {
    const down = step.pressing;
    const zp = down ? 1.15 : 2.6;
    let g = box(5.6, 14.9, 0, 0.45, 0.45, 4.4) + box(5.6, 17.85, 0, 0.45, 0.45, 4.4);
    g += box(5.6, 14.9, 4.4, 2.9, 3.4, 0.5, down ? "acc" : "");
    g += cyl(7.05, 16.6, zp + 0.25, 0.35, 4.4 - zp - 0.25, "steel");
    g += box(5.95, 15.75, zp, 2.2, 1.7, 0.3, down ? "acc" : "dark");
    out.push(part("summarization", st, g));
  }

  // Numbered pins, on top of everything.
  for (const p of PARTS) {
    const [ax, ay] = P(...PIN[p.id]);
    const n = PART_NUMBER[p.id];
    grow(ax - 9, ay - 40);
    const removed = !st.on.has(p.id);
    const active = step.active.includes(p.id);
    out.push(
      `<g class="pin${removed ? " removed" : ""}${active ? " active" : ""}" data-part="${p.id}" data-group="${p.group}">` +
        `<line x1="${ax}" y1="${ay}" x2="${ax}" y2="${ay - 24}"/><circle cx="${ax}" cy="${ay - 31}" r="7.5"/>` +
        `<text x="${ax}" y="${ay - 28.2}" text-anchor="middle">${n}</text></g>`,
    );
  }

  // Fit the view box to the drawing.
  const pad = 10;
  const vb = [bounds.x0 - pad, bounds.y0 - pad, bounds.x1 - bounds.x0 + pad * 2, bounds.y1 - bounds.y0 + pad * 2];
  return `<svg class="machine" viewBox="${vb.map((v) => v.toFixed(0)).join(" ")}" role="img" aria-label="An agent harness drawn as a machine: the model in the centre, the context window as a tray in front of it, and eleven numbered parts around it.">${out.join("")}</svg>`;
}

export const GROUP_NAMES = Object.fromEntries(GROUPS.map((g) => [g.id, g.name]));
