// The factory's motion. `plan()` turns one step of the run into crate trips
// between stations; `Engine` plays them with requestAnimationFrame, and keeps
// the belts, gears, scan light and steam moving.

import { WINDOW, type Block, type PartId, type Step } from "../src/harness.ts";
import { KIND_CLASS, STATION, crate, project, scanPane, shelfPoint, slotPoint, slots, TRAY, type W } from "./figure.ts";

/** One leg of a trip: straight along a belt, or lifted in an arc. */
interface Leg {
  to: W;
  arc?: number;
}

export interface Trip {
  from: W;
  legs: Leg[];
  /** ms from the step start. */
  start: number;
  dur: number;
  size: number;
  cls: string;
}

export interface Plan {
  trips: Trip[];
  /** When each arriving thing should appear, ms from the step start. */
  arrive: Map<string, number>;
  /** The model call at the start of the step, ms; 0 when there is none. */
  think: number;
  /** How far along the tray the scan light runs, world x. */
  scanTo: number;
  /** When the choreography is over. */
  end: number;
}

const THINK = 800;
const add = (a: W, b: W): W => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

/** The trips for one step, given the step before it. */
export function plan(prev: Step | undefined, step: Step, on: Set<PartId>, shipped: "branch" | "main" | null): Plan {
  const trips: Trip[] = [];
  const arrive = new Map<string, number>();
  const isCall = !!prev && step.calls > prev.calls;
  const think = isCall ? THINK : 0;
  const prevBlocks = prev?.blocks ?? [];
  const scanTo = TRAY.x0 + Math.min(TRAY.len + 0.6, (prevBlocks.reduce((n, b) => n + b.tokens, 0) / WINDOW) * TRAY.len);
  let t = isCall ? THINK : 150;

  const trip = (from: W, legs: Leg[], dur: number, size: number, cls: string, start = t) => {
    trips.push({ from, legs, start, dur, size, cls });
    return start + dur;
  };

  const seen = new Set(prevBlocks.map((b) => b.id));
  const fresh = step.blocks.filter((b) => !seen.has(b.id));
  const place = slots(step.blocks);
  const slot = (b: Block) => slotPoint(place.get(b.id)!);
  const toTray = (b: Block): Leg[] => [{ to: STATION.ductBottom }, { to: STATION.trayEntry }, { to: slot(b) }];
  const big = (b: Block) => Math.min(1.5, 0.45 + Math.sqrt(b.tokens / 1000) * 0.18);

  // A command goes out to the terminal first when the step runs something.
  const runs = step.active.includes("repl") && !!step.call;
  if (runs) t = trip(STATION.modelOut, [{ to: STATION.terminal, arc: 3 }], 650, 0.45, "acc");

  // Code: the script is written on the bench and filed on the scratch shelf.
  if (step.active.includes("code")) {
    trip(STATION.terminal, [{ to: STATION.bench, arc: 1.5 }], 450, 0.4, "acc", t - 200);
  }

  // Subagent: a brief goes out, files stream into its own window.
  const subStart = (prev?.subagents[0] ?? 0) === 0 && step.subagents[0] > 0;
  if (subStart) {
    let end = trip(STATION.modelTop, [{ to: STATION.sub[0], arc: 2.5 }], 650, 0.45, "acc");
    for (let i = 0; i < 6; i++) end = Math.max(end, trip(add(STATION.terminal, [0, 0, 1]), [{ to: STATION.sub[0], arc: 3.5 + i * 0.2 }], 700, 0.55, "k-file", t + 650 + i * 160));
    arrive.set("sub:0", end);
  }

  // Each new block in the window arrives from where it came from.
  let i = 0;
  for (const b of fresh) {
    const s = t + i * 140;
    i++;
    let end = s;
    switch (b.kind) {
      case "system":
      case "task":
        end = trip(add(slot(b), [0, 0, 5]), [{ to: slot(b) }], 600, 0.7, KIND_CLASS[b.kind], s);
        break;
      case "memory":
        end = trip(STATION.cabinet, [{ to: slot(b), arc: 3 }], 800, 0.7, "k-ins", s);
        break;
      case "skill":
        end = trip(on.has("skills") ? STATION.rack : add(slot(b), [0, 0, 5]), [{ to: slot(b), arc: on.has("skills") ? 3.5 : 0 }], 850, on.has("skills") ? 0.55 : 1.4, "k-ins", s);
        break;
      case "plan":
        trip(STATION.modelTop, [{ to: STATION.board, arc: 2 }], 600, 0.45, "acc", s);
        end = trip(STATION.board, [{ to: slot(b), arc: 4 }], 900, 0.5, "k-ins", s + 600);
        for (let k = 0; k < 5; k++) arrive.set(`todo:${k}`, s + 600 + k * 70);
        break;
      case "report":
        end = trip(STATION.sub[0], [{ to: slot(b), arc: 3.5 }], 900, 0.6, "k-rep", s);
        break;
      case "file":
        end = trip(STATION.terminal, [{ to: STATION.ductTop, arc: 2 }, ...toTray(b)], 1300, big(b), "k-file", s);
        break;
      case "output":
        end = trip(STATION.terminal, [{ to: STATION.ductTop, arc: 2 }, ...toTray(b)], 1200, big(b), "k-out", s);
        break;
      case "tag": {
        // The diverter sends the full output to a file and lets only the tag through.
        const log = step.scratch.at(-1)!;
        const atDiv = trip(STATION.terminal, [{ to: STATION.ductTop, arc: 2 }], 500, 1.2, "k-out", s);
        const filed = trip(STATION.ductTop, [{ to: shelfPoint("scratch", step.scratch.length - 1), arc: 2.5 }], 700, 1.0, "k-out", atDiv);
        arrive.set(`file:${log}`, filed);
        end = trip(STATION.ductTop, toTray(b), 800, 0.4, "k-tag", atDiv);
        break;
      }
      case "edit":
        end = trip(STATION.modelFront, [{ to: [12.5, 16.55, 1.6] }, { to: slot(b) }], 900, 0.6, "k-edit", s);
        break;
      case "summary":
        end = trip(STATION.press, [{ to: slot(b) }], 500, 0.8, "k-sum", s + 700);
        break;
    }
    arrive.set(b.id, end);
  }

  // New files on the shelves that were not offloaded output.
  const newScratch = step.scratch.filter((n) => !(prev?.scratch ?? []).includes(n) && !arrive.has(`file:${n}`));
  for (const n of newScratch) arrive.set(`file:${n}`, trip(STATION.bench, [{ to: shelfPoint("scratch", step.scratch.indexOf(n)), arc: 2.5 }], 800, 0.5, "k-out", t + 300));
  const newPersistent = step.persistent.filter((n) => !(prev?.persistent ?? []).includes(n));
  for (const n of newPersistent) arrive.set(`file:${n}`, trip(STATION.modelTop, [{ to: shelfPoint("persistent", step.persistent.indexOf(n)), arc: 3 }], 1000, 0.5, "k-edit", t));

  // To-dos ticked this step light up.
  step.todos.forEach((todo, k) => {
    if (todo.done && prev?.todos[k] && !prev.todos[k].done) arrive.set(`tick:${k}`, t + 300);
  });

  // Shipping: along the belt to the gate, then on to a slot.
  if (step.gate === "waiting") {
    arrive.set("parked", trip(STATION.modelOut, [{ to: add(STATION.gate, [-0.5, 0, 0]) }], 1300, 0.7, "k-edit", t));
  } else if (step.gate === "approved" && shipped) {
    arrive.set("ship", trip(add(STATION.gate, [-0.5, 0, 0]), [{ to: STATION.branch, arc: 1 }], 900, 0.7, "k-edit", t + 300));
  } else if (shipped === "main") {
    arrive.set("ship", trip(STATION.modelOut, [{ to: STATION.main, arc: 0.6 }], 1600, 0.7, "bad", t));
  }

  const end = Math.max(think, ...trips.map((x) => x.start + x.dur), ...arrive.values());
  return { trips, arrive, think, scanTo, end };
}

// ---------- The player ----------

interface Live {
  trip: Trip;
  el: SVGGElement | null;
  pts: W[];
  lens: number[];
  total: number;
}

const NS = "http://www.w3.org/2000/svg";

export class Engine {
  private svg: SVGSVGElement | null = null;
  private fx: SVGGElement | null = null;
  private gears: SVGGElement[] = [];
  private live: Live[] = [];
  private stepAt = 0;
  private think = 0;
  private scanTo = 0;
  private scan: SVGPolygonElement | null = null;
  private puffs: { el: SVGCircleElement; born: number; x: number; y: number }[] = [];
  private lastPuff = 0;
  private angle = 0;
  private belt = 0;
  private last = performance.now();
  readonly reduced: boolean;

  constructor() {
    this.reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!this.reduced) requestAnimationFrame((t) => this.frame(t));
  }

  /** Call after each re-draw of the figure, with the step's plan. */
  attach(svg: SVGSVGElement, p: Plan) {
    this.svg = svg;
    this.fx = svg.querySelector("#fx");
    this.gears = [...svg.querySelectorAll<SVGGElement>(".gear")];
    this.puffs = [];
    this.stepAt = performance.now();
    this.think = p.think;
    this.scanTo = p.scanTo;
    this.live = [];
    if (this.reduced || !this.fx) return;
    this.scan = document.createElementNS(NS, "polygon");
    this.scan.setAttribute("class", "scan");
    this.fx.appendChild(this.scan);
    for (const trip of p.trips) {
      const pts = [trip.from, ...trip.legs.map((l) => l.to)];
      const lens = pts.slice(1).map((q, i) => Math.hypot(q[0] - pts[i][0], q[1] - pts[i][1], q[2] - pts[i][2]) + (trip.legs[i].arc ?? 0));
      this.live.push({ trip, el: null, pts, lens, total: lens.reduce((a, b) => a + b, 0) || 1 });
    }
    this.frame(performance.now());
  }

  private frame(now: number) {
    const dt = Math.min(64, now - this.last);
    this.last = now;
    const t = now - this.stepAt;
    const thinking = t < this.think;

    // Gears idle slowly and race while the model is called.
    this.angle += dt * (thinking ? 0.5 : 0.04);
    for (const g of this.gears) {
      const dir = Number(g.dataset.dir ?? 1);
      g.setAttribute("transform", `rotate(${((this.angle * dir) % 360).toFixed(1)})`);
    }

    // Belts always run; faster while work is moving.
    this.belt -= dt * (t < 2600 ? 0.03 : 0.012);
    this.svg?.style.setProperty("--belt", `${this.belt.toFixed(1)}px`);

    // The scan light reads the whole window, left to right, on every model call.
    if (this.scan) {
      if (thinking && this.scanTo > TRAY.x0) {
        const x = TRAY.x0 + (this.scanTo - TRAY.x0) * (t / this.think);
        this.scan.setAttribute("points", scanPane(x).map((p) => p.map((n) => n.toFixed(1)).join(",")).join(" "));
        this.scan.style.opacity = "1";
      } else this.scan.style.opacity = "0";
    }

    // Steam from the model's stack while it works.
    if (this.fx && thinking && now - this.lastPuff > 140) {
      this.lastPuff = now;
      const [x, y] = project(STATION.modelTop);
      const el = document.createElementNS(NS, "circle");
      el.setAttribute("class", "puff");
      this.fx.appendChild(el);
      this.puffs.push({ el, born: now, x: x + (Math.random() - 0.5) * 14, y });
    }
    this.puffs = this.puffs.filter((p) => {
      const age = (now - p.born) / 1200;
      if (age >= 1) {
        p.el.remove();
        return false;
      }
      p.el.setAttribute("cx", (p.x + age * 10).toFixed(1));
      p.el.setAttribute("cy", (p.y - age * 46).toFixed(1));
      p.el.setAttribute("r", (3 + age * 9).toFixed(1));
      p.el.style.opacity = (0.5 * (1 - age)).toFixed(2);
      return true;
    });

    // Crates.
    for (const l of this.live) {
      const u = (t - l.trip.start) / l.trip.dur;
      if (u < 0) continue;
      if (u >= 1) {
        l.el?.remove();
        l.el = null;
        continue;
      }
      if (!l.el && this.fx) {
        l.el = document.createElementNS(NS, "g");
        l.el.setAttribute("class", "crate");
        l.el.innerHTML = crate(l.trip.size * 1.5, l.trip.cls);
        this.fx.appendChild(l.el);
      }
      const e = u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2;
      let d = e * l.total;
      let k = 0;
      while (k < l.lens.length - 1 && d > l.lens[k]) d -= l.lens[k++];
      const s = Math.min(1, d / l.lens[k]);
      const a = l.pts[k], b = l.pts[k + 1];
      const lift = (l.trip.legs[k].arc ?? 0) * 4 * s * (1 - s);
      const [x, y] = project([a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s + lift]);
      l.el!.setAttribute("transform", `translate(${x.toFixed(1)},${y.toFixed(1)})`);
    }

    requestAnimationFrame((n) => this.frame(n));
  }
}
