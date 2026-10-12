// The factory's motion. `plan()` turns one step of the run into a short
// sequence of beats — one thing happening at a time, each with a caption, a
// spotlight on the parts involved, and labelled crates moving between
// stations. `Engine` plays the beats with requestAnimationFrame and keeps the
// belts, gears, scan light and steam moving.

import { WINDOW, fmt, type Block, type PartId, type Step } from "../src/harness.ts";
import { STATION, crate, project, scanPane, shelfPoint, slotPoint, slots, TRAY, type W } from "./figure.ts";

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
  label?: string;
}

/** Things the spotlight can light: parts, and the fixed pieces of the factory. */
export type Lit = PartId | "model" | "window" | "belt" | "outbox" | "feed" | "return";

export interface Beat {
  start: number;
  end: number;
  caption: string;
  lit: Lit[];
  /** Gauge values to move to when the beat ends. */
  used?: number;
  billed?: number;
  tone?: "bad" | "good" | "pause";
}

export interface Plan {
  beats: Beat[];
  trips: Trip[];
  /** When each arriving thing should appear, ms from the step start. */
  arrive: Map<string, number>;
  /** The model call: when the scan light runs. */
  think: { start: number; end: number } | null;
  scanTo: number;
  /** Blocks pressed out of the window this step. */
  leaving: Block[];
  end: number;
}

const add = (a: W, b: W): W => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sum = (blocks: Block[]) => blocks.reduce((n, b) => n + b.tokens, 0);
const tok = (n: number) => fmt(n, false);
const short = (s: string, n = 24) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * The beats for one step, given the step before it.
 * `pace` stretches every duration: 1 is normal, more is slower.
 */
export function plan(prev: Step | undefined, step: Step, on: Set<PartId>, shipped: "branch" | "main" | null, pace = 1): Plan {
  const beats: Beat[] = [];
  const trips: Trip[] = [];
  const arrive = new Map<string, number>();
  const ms = (n: number) => n * pace;

  const prevBlocks = prev?.blocks ?? [];
  const used0 = sum(prevBlocks);
  let used = used0;
  const isCall = !!prev && step.calls > prev.calls;
  let think: Plan["think"] = null;
  let leaving: Block[] = [];

  const place = slots(step.blocks);
  const slot = (b: Block) => slotPoint(place.get(b.id)!);
  const big = (tokens: number) => Math.min(1.5, 0.5 + Math.sqrt(tokens / 1000) * 0.16);

  let t = ms(250);
  /** A beat; `fn` schedules its trips from `s` and returns when they finish. */
  const beat = (caption: string, lit: Lit[], fn?: (s: number) => number, min = 1200, extra: Partial<Beat> = {}) => {
    const s = t;
    const end = Math.max(s + ms(min), fn ? fn(s) : s);
    const b: Beat = { start: s, end, caption, lit, ...extra };
    beats.push(b);
    t = end + ms(450);
    return b;
  };
  const trip = (from: W, legs: Leg[], dur: number, size: number, cls: string, start: number, label?: string) => {
    trips.push({ from, legs, start, dur: ms(dur), size, cls, label });
    return start + ms(dur);
  };
  /** A crate that lands in the window: its block appears as it touches down. */
  const land = (b: Block, end: number) => {
    arrive.set(b.id, end - ms(150));
    used += b.tokens;
    return end;
  };
  const viaReturn = (b: Block): Leg[] => [{ to: STATION.ductBottom }, { to: STATION.trayEntry }, { to: slot(b) }];
  const fresh = step.blocks.filter((b) => !prevBlocks.some((p) => p.id === b.id));
  const newScratch = step.scratch.filter((n) => !(prev?.scratch ?? []).includes(n));
  const subStart = (prev?.subagents[0] ?? 0) === 0 && step.subagents[0] > 0;

  /**
   * The model call. It comes after this step's inputs have landed: the model
   * re-reads the whole window as it is now, and that whole window is billed.
   */
  const call = () => {
    if (!isCall || think) return;
    const b = beat(`Model call — it re-reads the whole window: ${tok(step.used)} tokens, billed again`, ["model", "window", "feed"], undefined, 1800, {
      billed: step.billed,
    });
    think = { start: b.start, end: b.end };
  };

  // 2. Writing a script on the bench comes before running it.
  if (step.active.includes("code")) {
    beat("It writes a 12-line repro script on the workbench", ["model", "code"], (s) => {
      arrive.set("write", s + ms(700));
      return trip(STATION.modelOut, [{ to: STATION.bench, arc: 3 }], 1300, 0.45, "acc", s, "repro.ts");
    });
    const script = newScratch.find((n) => n.endsWith(".ts"));
    if (script)
      beat("…and saves it on the scratch shelf", ["code", "filesystem"], (s) => {
        const end = trip(STATION.bench, [{ to: shelfPoint("scratch", step.scratch.indexOf(script)), arc: 2.5 }], 1300, 0.5, "k-out", s, "repro.ts");
        arrive.set(`file:${script}`, end - ms(150));
        return end;
      });
  }

  // 3. A command goes out to the terminal.
  const scripted = step.active.includes("code");
  if (step.active.includes("repl") && step.call) {
    const safe = on.has("sandbox");
    const what = scripted ? "the script" : short(step.call, 32);
    beat(`It runs ${what} ${safe ? "inside the sandbox" : "on your own machine — no sandbox"}`, ["model", "repl", safe ? "sandbox" : "repl"], (s) =>
      trip(STATION.modelOut, [{ to: STATION.terminal, arc: 3 }], 1400, 0.5, "acc", s, scripted ? "npx tsx repro.ts" : short(step.call!, 22)),
    1200, safe ? {} : { tone: "bad" });
  }

  // 4. A subagent: a brief out, then files into its own window.
  if (subStart) {
    beat("It hands a short brief to the explorer subagent", ["model", "subagents"], (s) => trip(STATION.modelTop, [{ to: STATION.sub[0], arc: 3 }], 1400, 0.5, "acc", s, "brief"));
    const side = step.billed - prev!.billed - step.used;
    beat(`The explorer reads 14 files in its own window — ${tok(110_000)}, none of it in the main window (its own calls cost ${tok(side)}, once)`, ["subagents", "repl"], (s) => {
      let end = s;
      for (let i = 0; i < 6; i++) end = trip(add(STATION.terminal, [0, 0, 1]), [{ to: STATION.sub[0], arc: 3.5 }], 1200, 0.55, "k-file", s + ms(i * 260), i === 0 ? "14 files" : undefined);
      arrive.set("sub:0", end - ms(300));
      return end;
    }, 1200, { billed: prev!.billed + (step.billed - prev!.billed - step.used) });
  }

  // 5. The press, when the window passed the threshold.
  if (step.pressing) {
    leaving = prevBlocks.filter((b) => !b.pinned);
    const kept = sum(prevBlocks.filter((b) => b.pinned));
    beat("The window passed 160k — the press squeezes out the old turns", ["summarization", "window"], (s) => {
      arrive.set("press", s);
      arrive.set("leave", s + ms(500));
      return s + ms(1800);
    }, 1800, { used: kept });
    used = kept;
  }

  // 6. Each new block in the window arrives from where it came from.
  for (const b of fresh) {
    const sky = add(slot(b), [0, 0, 6]);
    const after = () => ({ used: used + b.tokens });
    switch (b.kind) {
      case "system":
        beat(`The harness writes the system prompt and tool definitions — ${tok(b.tokens)} tokens`, ["window"], (s) => land(b, trip(sky, [{ to: slot(b) }], 1200, 0.8, "k-ins", s, "system prompt")), 1200, after());
        break;
      case "task":
        beat(`The task arrives — ${tok(b.tokens)} tokens`, ["window"], (s) => land(b, trip(sky, [{ to: slot(b) }], 1200, 0.5, "k-ins", s, "task")), 1200, after());
        break;
      case "memory":
        beat(`Memory opens: AGENTS.md and saved notes go in — ${tok(b.tokens)} tokens`, ["memory", "window"], (s) => {
          arrive.set("drawer", s);
          return land(b, trip(STATION.cabinet, [{ to: slot(b), arc: 3 }], 1500, 0.6, "k-ins", s + ms(450), "AGENTS.md"));
        }, 1200, after());
        break;
      case "skill":
        if (step.skillOut !== null)
          beat(`The task matches “debugging-tests”, so only now is its full card pulled — ${tok(b.tokens)}`, ["skills", "window"], (s) => {
            arrive.set("lift", s);
            return land(b, trip(STATION.rack, [{ to: slot(b), arc: 4 }], 1600, 0.7, "k-ins", s + ms(700), "debugging-tests"));
          }, 1200, after());
        else if (on.has("skills"))
          beat(`The skill rack adds only each card’s name and one line — ${tok(b.tokens)} for all 8`, ["skills", "window"], (s) => land(b, trip(STATION.rack, [{ to: slot(b), arc: 4 }], 1600, 0.45, "k-ins", s, "8 descriptions")), 1200, after());
        else
          beat(`No skill rack: all 8 playbooks go in up front — ${tok(b.tokens)} on every call`, ["window"], (s) => land(b, trip(sky, [{ to: slot(b) }], 1400, 1.4, "k-ins", s, "8 playbooks")), 1200, { ...after(), tone: "bad" });
        break;
      case "plan":
        beat("It writes a five-item to-do list on the board", ["model", "planning"], (s) => {
          const end = trip(STATION.modelTop, [{ to: STATION.board, arc: 2.5 }], 1300, 0.5, "acc", s, "to-dos");
          for (let k = 0; k < 5; k++) arrive.set(`todo:${k}`, end + ms(k * 120));
          return end + ms(700);
        });
        beat(`The list also stays in the window — ${tok(b.tokens)} tokens`, ["planning", "window"], (s) => land(b, trip(STATION.board, [{ to: slot(b), arc: 4 }], 1600, 0.5, "k-ins", s, "to-do list")), 1200, after());
        break;
      case "report":
        beat(`The explorer sends back only a short report — ${tok(b.tokens)} tokens`, ["subagents", "window"], (s) => land(b, trip(STATION.sub[0], [{ to: slot(b), arc: 4 }], 1600, 0.6, "k-rep", s, "report")), 1200, after());
        break;
      case "file":
        beat(`No subagent: all 14 files go into the main window — ${tok(b.tokens)}`, ["repl", "return", "window"], (s) => land(b, trip(STATION.terminal, [{ to: STATION.ductTop, arc: 2 }, ...viaReturn(b)], 2300, big(b.tokens), "k-file", s, `${tok(b.tokens)} of files`)), 1200, { ...after(), tone: "bad" });
        break;
      case "output": {
        const large = b.tokens > 5_000;
        beat(
          large
            ? `No diverter: the whole ${tok(b.tokens)} output comes back into the window`
            : scripted
              ? `The script prints the wrong delivery day — a time zone bug, in ${tok(b.tokens)} tokens`
              : `The output comes back into the window — ${tok(b.tokens)} tokens`,
          ["repl", "return", "window"],
          (s) => land(b, trip(STATION.terminal, [{ to: STATION.ductTop, arc: 2 }, ...viaReturn(b)], 2200, big(b.tokens), "k-out", s, `${tok(b.tokens)} output`)),
          1200,
          large ? { ...after(), tone: "bad" } : after(),
        );
        break;
      }
      case "tag": {
        const log = step.scratch.at(-1)!;
        const full = b.full ?? 0;
        beat(`The output is ${tok(full)} — the diverter files all of it on the scratch shelf`, ["repl", "offloading", "filesystem"], (s) => {
          const atDiv = trip(STATION.terminal, [{ to: STATION.ductTop, arc: 2 }], 1000, big(full), "k-out", s, `${tok(full)} log`);
          arrive.set("flap", atDiv - ms(150));
          const filed = trip(STATION.ductTop, [{ to: shelfPoint("scratch", step.scratch.length - 1), arc: 3 }], 1400, big(full), "k-out", atDiv, log.replace("scratch/", ""));
          arrive.set(`file:${log}`, filed - ms(150));
          return filed;
        });
        beat(`Only its path, head and tail go into the window — ${tok(b.tokens)} tokens`, ["offloading", "return", "window"], (s) => land(b, trip(STATION.ductTop, viaReturn(b), 1700, 0.45, "k-tag", s, "path + head/tail")), 1200, after());
        break;
      }
      case "edit": {
        const note = step.persistent.find((n) => !(prev?.persistent ?? []).includes(n));
        if (note)
          beat("It saves what it learned to persistent memory, for the next session", ["model", "memory", "filesystem", "window"], (s) => {
            const filed = trip(STATION.modelTop, [{ to: shelfPoint("persistent", step.persistent.indexOf(note)), arc: 3 }], 1600, 0.5, "k-edit", s, note.replace("memory/", ""));
            arrive.set(`file:${note}`, filed - ms(150));
            return Math.max(filed, land(b, trip(STATION.modelFront, [{ to: [12.5, 16.55, 1.6] }, { to: slot(b) }], 1600, 0.45, "k-edit", s + ms(300))));
          }, 1200, { ...after(), tone: "good" });
        else
          beat(`It writes the change to date.ts — ${tok(b.tokens)} tokens in the window`, ["model", "feed", "window"], (s) => land(b, trip(STATION.modelFront, [{ to: [12.5, 16.55, 1.6] }, { to: slot(b) }], 1600, 0.6, "k-edit", s, "edit")), 1200, after());
        break;
      }
      case "summary":
        beat(`A ${tok(b.tokens)} summary takes their place, and the run carries on`, ["summarization", "window"], (s) => land(b, trip(STATION.press, [{ to: slot(b) }], 1000, 0.9, "k-sum", s, "summary")), 1200, { ...after(), tone: "good" });
        break;
    }
  }

  // 7. To-dos ticked this step (after shipping, when the step ships).
  const ticks = () => step.todos.forEach((todo, k) => {
    if (todo.done && prev?.todos[k] && !prev.todos[k].done)
      beat(`It ticks “${todo.text}” off the list`, ["planning"], (s) => {
        arrive.set(`tick:${k}`, s + ms(300));
        return s + ms(1000);
      }, 1000);
  });
  if (!shipped) ticks();

  // 8. The model reads the result — before anything is shipped.
  if (step.gate !== "waiting" && !shipped) call();

  // 9. Shipping: along the belt to the gate, then on to a slot.
  if (step.gate === "waiting") {
    beat("It ships the change — the gate stops it until a person looks", ["model", "belt", "hitl"], (s) => {
      const end = trip(STATION.modelOut, [{ to: add(STATION.gate, [-0.5, 0, 0]) }], 2000, 0.7, "k-edit", s, "git push");
      arrive.set("parked", end - ms(150));
      return end;
    }, 1200, { tone: "pause" });
  } else if (step.gate === "approved" && shipped) {
    beat("A person approves, sending it to a review branch instead of main", ["hitl", "outbox"], (s) => {
      arrive.set("gate", s);
      const end = trip(add(STATION.gate, [-0.5, 0, 0]), [{ to: STATION.branch, arc: 1.2 }], 1500, 0.7, "k-edit", s + ms(500), "pull request");
      arrive.set("ship", end - ms(150));
      return end;
    }, 1200, { tone: "good" });
  } else if (shipped === "main") {
    beat("No gate: the change goes straight to main, unread", ["model", "belt", "outbox"], (s) => {
      const end = trip(STATION.modelOut, [{ to: STATION.main, arc: 0.6 }], 2400, 0.7, "bad", s, "git push main");
      arrive.set("ship", end - ms(150));
      return end;
    }, 1200, { tone: "bad" });
  }

  if (shipped) ticks();
  call();

  // 10. Steps where nothing moves still say what happened.
  if (step.used > WINDOW && !fresh.length) beat(`${tok(step.used)} does not fit in the 200k window — the run stops`, ["window", "model"], undefined, 2000, { tone: "bad" });
  else if (!beats.length || (beats.length === 1 && think)) {
    // Only a model call happened: say what it decided, before the call.
    const only = beats.pop();
    t = only ? only.start : t;
    think = null;
    beat(step.title, step.active.length ? step.active : ["model"], undefined, 1800, step.tone === "info" ? {} : { tone: step.tone });
    if (only) call();
  }

  const scanTo = TRAY.x0 + Math.min(TRAY.len + 0.6, (step.used / WINDOW) * TRAY.len);
  const end = Math.max(0, ...beats.map((b) => b.end), ...trips.map((x) => x.start + x.dur));
  return { beats, trips, arrive, think, scanTo, leaving, end };
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
const ease = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2);

export interface Hooks {
  /** A beat started; null when the step's beats are over. */
  beat: (b: Beat | null, index: number, count: number) => void;
  /** A beat ended: move the gauges. */
  gauges: (used?: number, billed?: number) => void;
}

export class Engine {
  private svg: SVGSVGElement | null = null;
  private fx: SVGGElement | null = null;
  private gears: SVGGElement[] = [];
  private live: Live[] = [];
  private plan: Plan | null = null;
  private stepAt = 0;
  private beatIndex = -2;
  private gaugeDone = new Set<number>();
  private scan: SVGPolygonElement | null = null;
  private puffs: { el: SVGCircleElement; born: number; x: number; y: number }[] = [];
  private lastPuff = 0;
  private angle = 0;
  private belt = 0;
  private last = performance.now();
  readonly reduced: boolean;

  constructor(private hooks: Hooks) {
    this.reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!this.reduced) requestAnimationFrame((t) => this.frame(t));
  }

  /** Call after each re-draw of the figure, with the step's plan. */
  attach(svg: SVGSVGElement, p: Plan) {
    this.svg = svg;
    this.fx = svg.querySelector("#fx");
    this.gears = [...svg.querySelectorAll<SVGGElement>(".gear")];
    this.puffs = [];
    this.plan = p;
    this.stepAt = performance.now();
    // -1 = "before the first beat"; the step-over signal only fires after a beat has run.
    this.beatIndex = -1;
    this.gaugeDone = new Set();
    this.live = [];
    this.scan = null;
    if (this.reduced || !this.fx) {
      this.hooks.beat(null, -1, 0);
      return;
    }
    this.scan = document.createElementNS(NS, "polygon");
    this.scan.setAttribute("class", "scan");
    this.fx.appendChild(this.scan);
    for (const trip of p.trips) {
      const pts = [trip.from, ...trip.legs.map((l) => l.to)];
      const lens = pts.slice(1).map((q, i) => Math.hypot(q[0] - pts[i][0], q[1] - pts[i][1], q[2] - pts[i][2]) + (trip.legs[i].arc ?? 0) * 1.5);
      this.live.push({ trip, el: null, pts, lens, total: lens.reduce((a, b) => a + b, 0) || 1 });
    }
    this.frame(performance.now(), true);
  }

  private spotlight(lit: Lit[] | null) {
    if (!this.svg) return;
    this.svg.classList.toggle("spot", !!lit);
    const set = new Set<string>(lit ?? []);
    this.svg.querySelectorAll<SVGElement>("[data-part], [data-core]").forEach((el) => {
      el.classList.toggle("lit", set.has(el.dataset.part ?? el.dataset.core ?? ""));
    });
  }

  private frame(now: number, once = false) {
    const dt = Math.min(64, Math.max(0, now - this.last));
    this.last = now;
    const t = now - this.stepAt;
    const p = this.plan;
    const think = p?.think;
    const thinking = !!think && t >= think.start && t < think.end;

    // The current beat drives the caption and the spotlight.
    if (p) {
      let idx = -1;
      p.beats.forEach((b, i) => {
        if (t >= b.start) idx = i;
      });
      const last = p.beats.length - 1;
      const shown = last < 0 || (idx === last && t > p.beats[last].end + 300) ? -1 : idx;
      if (shown !== this.beatIndex) {
        this.beatIndex = shown;
        const b = shown >= 0 ? p.beats[shown] : null;
        this.spotlight(b ? b.lit : null);
        this.hooks.beat(b, shown, p.beats.length);
      }
      p.beats.forEach((b, i) => {
        if (t >= b.end && !this.gaugeDone.has(i)) {
          this.gaugeDone.add(i);
          if (b.used !== undefined || b.billed !== undefined) this.hooks.gauges(b.used, b.billed);
        }
      });
    }

    // Gears idle slowly and race while the model is called.
    this.svg?.classList.toggle("thinking-now", thinking);
    this.angle += dt * (thinking ? 0.28 : 0.03);
    for (const g of this.gears) g.setAttribute("transform", `rotate(${((this.angle * Number(g.dataset.dir ?? 1)) % 360).toFixed(1)})`);

    // Belts always run.
    this.belt -= dt * 0.016;
    this.svg?.style.setProperty("--belt", `${this.belt.toFixed(1)}px`);

    // The scan light reads the whole window, left to right, during a model call.
    if (this.scan && p) {
      if (thinking && think && p.scanTo > TRAY.x0) {
        const span = think.end - think.start;
        const u = Math.min(1, (t - think.start) / (span * 0.85));
        const x = TRAY.x0 + (p.scanTo - TRAY.x0) * ease(u);
        this.scan.setAttribute("points", scanPane(x).map((q) => q.map((n) => n.toFixed(1)).join(",")).join(" "));
        this.scan.style.opacity = Math.min(1, (t - think.start) / 200, (think.end - t) / 300).toFixed(2);
      } else this.scan.style.opacity = "0";
    }

    // Steam from the model's stack while it works.
    if (this.fx && thinking && now - this.lastPuff > 170) {
      this.lastPuff = now;
      const [x, y] = project(STATION.modelTop);
      const el = document.createElementNS(NS, "circle");
      el.setAttribute("class", "puff");
      this.fx.insertBefore(el, this.fx.firstChild);
      this.puffs.push({ el, born: now, x: x + (Math.random() - 0.5) * 14, y });
    }
    this.puffs = this.puffs.filter((q) => {
      const age = (now - q.born) / 1500;
      if (age >= 1) {
        q.el.remove();
        return false;
      }
      q.el.setAttribute("cx", (q.x + age * 12).toFixed(1));
      q.el.setAttribute("cy", (q.y - age * 50).toFixed(1));
      q.el.setAttribute("r", (3 + age * 10).toFixed(1));
      q.el.style.opacity = (0.45 * (1 - age)).toFixed(2);
      return true;
    });

    // Crates: fade in, travel, fade out as their block appears.
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
        l.el.innerHTML = crate(l.trip.size * 1.5, l.trip.cls, l.trip.label);
        this.fx.appendChild(l.el);
      }
      let d = ease(u) * l.total;
      let k = 0;
      while (k < l.lens.length - 1 && d > l.lens[k]) d -= l.lens[k++];
      const s = Math.min(1, d / l.lens[k]);
      const a = l.pts[k], b = l.pts[k + 1];
      const lift = (l.trip.legs[k].arc ?? 0) * 4 * s * (1 - s);
      const [x, y] = project([a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s + lift]);
      const fade = Math.min(1, u / 0.1, (1 - u) / 0.08);
      const scale = 0.75 + 0.25 * Math.min(1, u / 0.15);
      l.el!.setAttribute("transform", `translate(${x.toFixed(1)},${y.toFixed(1)}) scale(${scale.toFixed(3)})`);
      l.el!.style.opacity = fade.toFixed(2);
    }

    if (!once) requestAnimationFrame((n) => this.frame(n));
  }
}
