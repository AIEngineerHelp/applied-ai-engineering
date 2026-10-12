// The page: the factory, its step bar and gauges, the parts list, and the
// About panel. Everything is computed from src/harness.ts.

import { ALL_PARTS, GROUPS, PARTS, PROBLEMS, TASK, WINDOW, effective, fmt, partById, run, type PartId, type Run } from "../src/harness.ts";
import { Engine, plan } from "./engine.ts";
import { LEGEND, PART_NUMBER, drawFigure } from "./figure.ts";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Long enough for each step's trips to land, with a beat to read. */
const STEP_MIN = 2900;
const STEP_PAD = 900;

const engine = new Engine();

const state = {
  installed: new Set<PartId>(ALL_PARTS),
  run: run(ALL_PARTS) as Run,
  index: 0,
  playing: false,
  selected: null as PartId | null,
  hovered: null as PartId | null,
  timer: 0,
  /** How long the current step's choreography lasts. */
  stepEnd: 0,
};

// ---------- URL: ?off=subagents,offloading&step=4 ----------

function readUrl() {
  const q = new URLSearchParams(location.search);
  const off = (q.get("off") ?? "").split(",").filter((x): x is PartId => (ALL_PARTS as string[]).includes(x));
  state.installed = new Set(ALL_PARTS.filter((p) => !off.includes(p)));
  state.run = run(state.installed);
  const step = Number(q.get("step"));
  state.index = Number.isFinite(step) && step > 0 ? Math.min(step - 1, state.run.steps.length - 1) : 0;
}

function writeUrl() {
  const q = new URLSearchParams(location.search);
  q.delete("off");
  q.delete("step");
  const off = ALL_PARTS.filter((p) => !state.installed.has(p));
  if (off.length) q.set("off", off.join(","));
  if (state.index > 0) q.set("step", String(state.index + 1));
  const s = q.toString();
  history.replaceState(null, "", s ? `?${s}` : location.pathname);
}

// ---------- The factory ----------

function lastCall(upto: number): string {
  for (let i = upto; i >= 0; i--) {
    const s = state.run.steps[i];
    if (s.call && s.active.includes("repl")) return s.call;
  }
  return "";
}

function shipped(): "branch" | "main" | null {
  const r = state.run;
  if (!r.finished || state.index !== r.steps.length - 1) return null;
  return state.installed.has("hitl") ? "branch" : "main";
}

/** Draws the factory for the current step and starts its choreography. */
function drawFactory(animate: boolean) {
  const steps = state.run.steps;
  const step = steps[state.index];
  const prev = steps[state.index - 1];
  const on = effective(state.installed);
  const ship = shipped();
  const p = animate && !engine.reduced ? plan(prev, step, on, ship) : { trips: [], arrive: new Map<string, number>(), think: 0, scanTo: 0, end: 0 };
  state.stepEnd = p.end;
  $("#figure").innerHTML = drawFigure({
    on,
    step,
    arrive: p.arrive,
    lastCall: lastCall(state.index),
    shipped: ship,
    thinking: p.think > 0,
    alarm: step.used > WINDOW,
  });
  engine.attach(document.querySelector<SVGSVGElement>(".machine")!, p);
  applyFocus();
}

/** Dims everything except the hovered or selected part. */
function applyFocus() {
  const svg = document.querySelector(".machine");
  if (!svg) return;
  const id = state.hovered ?? state.selected;
  svg.classList.toggle("focusing", !!id);
  svg.querySelectorAll("[data-part]").forEach((el) => el.classList.toggle("focus", el.getAttribute("data-part") === id));
  showPartCard(id);
  document.querySelectorAll<HTMLElement>(".prow").forEach((row) => (row.dataset.selected = String(row.dataset.part === id)));
}

function showPartCard(id: PartId | null) {
  const card = $("#partcard");
  if (!id) {
    card.hidden = true;
    return;
  }
  const p = partById(id);
  const on = effective(state.installed);
  const group = GROUPS.find((g) => g.id === p.group)!;
  const missing = p.needs.filter((n) => !on.has(n)).map((n) => partById(n).name);
  card.innerHTML = `
    <div class="mb-1 flex items-center gap-2"><span class="pnum">${PART_NUMBER[id]}</span><b class="text-[13.5px]">${esc(p.name)}</b></div>
    <div class="mb-2 font-mono text-[10.5px] tracking-wide text-muted uppercase">${esc(group.name)} · ${esc(p.object)}</div>
    <p class="mb-2 text-ink-2">${esc(p.does)}</p>
    <p class="text-muted"><b class="font-medium text-ink-2">Without it:</b> ${esc(p.without)}</p>
    ${!on.has(id) ? `<p class="mt-2 font-medium" style="color:var(--accent)">${missing.length && state.installed.has(id) ? `Not working: it needs ${esc(missing.join(" and "))}.` : "Pulled out of this factory."}</p>` : ""}`;
  card.hidden = false;
}

// ---------- Step bar, gauges ----------

/** Counts a number up to its new value as the crates land. */
const shown = { used: 0, billed: 0 };
let tweenFrame = 0;
function tweenGauges(to: { used: number; billed: number }, delay: number) {
  cancelAnimationFrame(tweenFrame);
  const from = { ...shown };
  const t0 = performance.now() + delay;
  const dur = engine.reduced ? 0 : 600;
  const tick = (now: number) => {
    const u = dur ? Math.max(0, Math.min(1, (now - t0) / dur)) : 1;
    shown.used = from.used + (to.used - from.used) * u;
    shown.billed = from.billed + (to.billed - from.billed) * u;
    paintGauges();
    if (u < 1) tweenFrame = requestAnimationFrame(tick);
  };
  tweenFrame = requestAnimationFrame(tick);
}

function paintGauges() {
  const over = shown.used > WINDOW;
  $("#m-used").textContent = `${fmt(Math.round(shown.used), false)} / 200k`;
  const bar = $("#m-bar");
  bar.style.width = `${Math.min(100, (shown.used / WINDOW) * 100)}%`;
  bar.dataset.over = String(over);
  $("#m-billed").textContent = fmt(Math.round(shown.billed), false);
}

function drawStepInfo(animate: boolean) {
  const steps = state.run.steps;
  const s = steps[state.index];
  const toneColor = { bad: "var(--bad)", good: "var(--good)", pause: "var(--accent)", info: "var(--muted)" }[s.tone];
  const toneName = { bad: "Went wrong", good: "Harness at work", pause: "Waiting for a person", info: "Step" }[s.tone];
  const parts = s.active.map((id) => `<span class="pnum !size-[18px] !text-[10px]" title="${esc(partById(id).name)}">${PART_NUMBER[id]}</span>`).join("");
  $("#narration").innerHTML = `
    <div class="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
      <span class="text-[10.5px] font-semibold tracking-wide uppercase" style="color:${toneColor}">${toneName}</span>
      <h3 class="font-serif text-[19px] leading-tight">${esc(s.title)}</h3>
      <span class="flex gap-1 self-center">${parts}</span>
      ${s.call ? `<code class="!bg-well !text-[11.5px] text-ink-2">${esc(s.call)}</code>` : ""}
    </div>
    <p class="mt-1 text-[13.5px] leading-snug text-ink-2">${esc(s.text)}</p>`;

  $("#dots").innerHTML = steps
    .map((x, i) => `<button class="dot" type="button" data-i="${i}" data-tone="${x.tone}" data-state="${i < state.index ? "done" : i === state.index ? "now" : "todo"}" title="${i + 1}. ${esc(x.title)}" aria-label="Step ${i + 1}: ${esc(x.title)}"></button>`)
    .join("");
  $("#counter").textContent = `${state.index + 1} / ${steps.length}`;
  playIcon();

  $("#m-calls").textContent = String(s.calls);
  if (animate) tweenGauges({ used: s.used, billed: s.billed }, Math.max(0, state.stepEnd - 600));
  else {
    shown.used = s.used;
    shown.billed = s.billed;
    paintGauges();
  }
  $("#m-problems").innerHTML = s.problems.length
    ? s.problems.map((p) => `<li class="flex gap-1.5" style="color:var(--bad)"><span aria-hidden="true">×</span>${esc(PROBLEMS[p])}</li>`).join("")
    : `<li class="text-muted">None</li>`;

  const last = state.index === steps.length - 1;
  const r = state.run;
  $("#outcome").innerHTML = !last
    ? ""
    : r.problems.length
      ? `<div class="rounded-lg px-3 py-2.5 text-[12.5px] leading-snug" style="background:var(--bad-soft);color:var(--bad)"><b>${r.finished ? "Finished, with problems." : "The run stopped."}</b> ${r.calls} calls, ${fmt(r.billed)} billed, peak window ${fmt(r.peak, false)}.</div>`
      : `<div class="rounded-lg px-3 py-2.5 text-[12.5px] leading-snug" style="background:var(--good-soft);color:var(--good)"><b>Clean run.</b> Fixed, verified, reviewed and remembered: ${r.calls} calls, ${fmt(r.billed)} billed.</div>`;
}

function playIcon() {
  $("#play-icon").innerHTML = state.playing ? `<path d="M4.5 3h2.5v10H4.5zM9 3h2.5v10H9z"/>` : `<path d="M5 3v10l8-5z"/>`;
  $("#play").setAttribute("aria-label", state.playing ? "Pause" : "Play");
}

function drawParts() {
  const on = effective(state.installed);
  const active = new Set(state.run.steps[state.index].active);
  $("#parts").innerHTML = GROUPS.map(
    (g) => `
    <div>
      <div class="pgroup-name">${esc(g.name)}</div>
      ${PARTS.filter((p) => p.group === g.id)
        .map((p) => {
          const installed = state.installed.has(p.id);
          const works = on.has(p.id);
          const note = installed && !works ? `<div class="pnote">needs ${esc(p.needs.filter((n) => !on.has(n)).map((n) => partById(n).name).join(", "))}</div>` : "";
          return `<div class="prow" data-part="${p.id}" data-on="${works}" data-active="${active.has(p.id)}">
            <span class="pnum">${PART_NUMBER[p.id]}</span>
            <span class="min-w-0"><span class="pname block leading-tight">${esc(p.name)}</span>${note}</span>
            <button class="switch" type="button" role="switch" aria-checked="${installed}" aria-label="${esc(p.name)}" data-toggle="${p.id}"></button>
          </div>`;
        })
        .join("")}
    </div>`,
  ).join("");
  $("#installed-count").textContent = `${on.size} of ${ALL_PARTS.length} working`;
}

function render(animate = true) {
  drawFactory(animate);
  drawStepInfo(animate);
  drawParts();
  writeUrl();
}

// ---------- Playing ----------

function go(i: number, animate = true) {
  state.index = Math.max(0, Math.min(state.run.steps.length - 1, i));
  render(animate);
}

function stop() {
  state.playing = false;
  clearTimeout(state.timer);
}

function schedule() {
  clearTimeout(state.timer);
  if (!state.playing) return;
  state.timer = window.setTimeout(() => {
    if (!state.playing) return;
    if (state.index >= state.run.steps.length - 1) {
      stop();
      playIcon();
      return;
    }
    go(state.index + 1);
    schedule();
  }, Math.max(STEP_MIN, state.stepEnd + STEP_PAD));
}

function play() {
  state.playing = true;
  if (state.index >= state.run.steps.length - 1) go(0);
  else playIcon();
  schedule();
}

function setInstalled(next: Set<PartId>, autoplay = true) {
  stop();
  state.installed = next;
  state.run = run(next);
  state.index = 0;
  shown.used = 0;
  shown.billed = 0;
  render();
  if (autoplay) {
    state.playing = true;
    playIcon();
    schedule();
  }
}

const without = (ids: PartId[]) => new Set(ALL_PARTS.filter((p) => !ids.includes(p)));

// ---------- About panel ----------

/** "Write & run code" → "write & run code", but "REPL" stays "REPL". */
const lower = (name: string) => (name === name.toUpperCase() ? name : name[0].toLowerCase() + name.slice(1));

function drawAbout() {
  $("#board").innerHTML = GROUPS.map(
    (g) => `
    <div class="bg-card px-4 py-4">
      <div class="mb-1 font-mono text-[11px] tracking-wide uppercase" style="color:var(--accent)">${esc(g.name)}</div>
      <p class="!mb-3 !text-[13px] leading-snug text-muted">${esc(g.job)}</p>
      <ul class="!m-0 !list-none space-y-2 !p-0 text-[13px]">
        ${PARTS.filter((p) => p.group === g.id)
          .map((p) => `<li class="!m-0 !p-0 before:!hidden"><div class="flex items-center gap-2"><span class="pnum">${PART_NUMBER[p.id]}</span><b class="font-medium">${esc(p.name)}</b><span class="ml-auto font-mono text-[10.5px] text-faint">${esc(p.object.toLowerCase())}</span></div><div class="mt-0.5 pl-7 text-[12.5px] leading-snug text-muted">${esc(p.does)}</div></li>`)
          .join("")}
      </ul>
    </div>`,
  ).join("");

  const full = run(ALL_PARTS);
  const ratio = (n: number, base: number) => {
    const r = n / base;
    const pct = Math.round((r - 1) * 100);
    return `<span class="x">${r >= 1.5 ? `×${r.toFixed(1)}` : pct === 0 ? "same" : `${pct > 0 ? "+" : "−"}${Math.abs(pct)}%`}</span>`;
  };
  const row = (label: string, off: PartId[], r: Run, extra = "") => `<tr data-off="${off.join(",")}">
    <td>${label}${extra}</td>
    <td class="num">${fmt(r.peak, false)} ${ratio(r.peak, full.peak)}</td>
    <td class="num">${fmt(r.billed, false)} ${ratio(r.billed, full.billed)}</td>
    <td class="num">${r.calls}</td>
    <td>${r.problems.length ? r.problems.map((p) => `<span class="prob">${esc(PROBLEMS[p])}</span>`).join(" ") : `<span class="ok">None</span>`}</td>
  </tr>`;
  const rows = [row("Full harness", [], full)];
  for (const p of PARTS) {
    const lost = ALL_PARTS.filter((x) => x !== p.id && !effective(without([p.id])).has(x));
    const extra = lost.length ? `<div class="x mt-0.5">also stops ${lost.map((x) => esc(lower(partById(x).name))).join(", ")}</div>` : "";
    rows.push(row(`<span class="pnum mr-1.5 inline-grid">${PART_NUMBER[p.id]}</span>Without ${esc(lower(p.name))}`, [p.id], run(without([p.id])), extra));
  }
  const combo: PartId[] = ["subagents", "offloading", "summarization"];
  rows.push(row("Without subagents, offloading and summarization", combo, run(without(combo))));
  rows.push(row("Bare model: no parts at all", ALL_PARTS, run([])));
  $("#all-parts").innerHTML = `<thead><tr><th>Factory</th><th class="!text-right">Peak window</th><th class="!text-right">Tokens billed</th><th class="!text-right">Calls</th><th>Problems</th></tr></thead><tbody>${rows.join("")}</tbody>`;
}

// ---------- Events ----------

function wire() {
  $("#task").textContent = TASK;
  const legend = LEGEND.map((l) => `<span><span class="swatch ${l.cls}"></span>${esc(l.name)}</span>`).join("");
  $("#legend").innerHTML = legend;

  $("#play").addEventListener("click", () => (state.playing ? (stop(), playIcon()) : play()));
  $("#next").addEventListener("click", () => (stop(), go(state.index + 1)));
  $("#prev").addEventListener("click", () => (stop(), go(state.index - 1, false)));
  $("#reset").addEventListener("click", () => (stop(), (shown.used = 0), (shown.billed = 0), go(0)));
  $("#dots").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-i]");
    if (b) (stop(), go(Number(b.dataset.i), Number(b.dataset.i) === state.index + 1));
  });

  $("#parts").addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const sw = t.closest<HTMLElement>("[data-toggle]");
    if (sw) {
      const id = sw.dataset.toggle as PartId;
      const next = new Set(state.installed);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      state.selected = id;
      setInstalled(next);
      return;
    }
    const rowEl = t.closest<HTMLElement>(".prow");
    if (rowEl) {
      const id = rowEl.dataset.part as PartId;
      state.selected = state.selected === id ? null : id;
      applyFocus();
    }
  });
  $("#parts").addEventListener("mouseover", (e) => {
    const id = ((e.target as HTMLElement).closest<HTMLElement>(".prow")?.dataset.part as PartId) ?? null;
    if (id !== state.hovered) ((state.hovered = id), applyFocus());
  });
  $("#parts").addEventListener("mouseleave", () => ((state.hovered = null), applyFocus()));

  document.querySelectorAll<HTMLElement>("[data-preset]").forEach((b) =>
    b.addEventListener("click", () => {
      const v = b.dataset.preset!;
      state.selected = null;
      setInstalled(v === "all" ? new Set(ALL_PARTS) : v === "none" ? new Set() : without(v.split(",") as PartId[]));
    }),
  );

  // Hover and click on the drawing itself.
  const fig = $("#figure");
  const tip = $("#tip");
  fig.addEventListener("mousemove", (e) => {
    const t = e.target as Element;
    const id = (t.closest("[data-part]")?.getAttribute("data-part") as PartId) ?? null;
    if (id !== state.hovered) ((state.hovered = id), applyFocus());
    const tipEl = t.closest("[data-tip]");
    if (tipEl) {
      const box = fig.getBoundingClientRect();
      tip.textContent = tipEl.getAttribute("data-tip");
      tip.hidden = false;
      const x = Math.min(e.clientX - box.left + 12, box.width - tip.offsetWidth - 8);
      tip.style.left = `${Math.max(8, x)}px`;
      tip.style.top = `${e.clientY - box.top + 16}px`;
    } else tip.hidden = true;
  });
  fig.addEventListener("mouseleave", () => {
    state.hovered = null;
    tip.hidden = true;
    applyFocus();
  });
  fig.addEventListener("click", (e) => {
    const id = ((e.target as Element).closest("[data-part]")?.getAttribute("data-part") as PartId) ?? null;
    state.selected = id && state.selected !== id ? id : null;
    applyFocus();
  });

  // About panel; a table row loads that factory.
  const about = $<HTMLDialogElement>("#about");
  $("#about-open").addEventListener("click", () => about.showModal());
  $("#about-close").addEventListener("click", () => about.close());
  about.addEventListener("click", (e) => {
    if (e.target === about) about.close();
    const tr = (e.target as HTMLElement).closest<HTMLElement>("tr[data-off]");
    if (tr) {
      about.close();
      state.selected = null;
      setInstalled(without((tr.dataset.off ?? "").split(",").filter(Boolean) as PartId[]));
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || about.open) return;
    const tag = (e.target as HTMLElement).tagName;
    if (e.key === " " && tag !== "BUTTON") {
      e.preventDefault();
      if (state.playing) (stop(), playIcon());
      else play();
    } else if (e.key === "ArrowRight") (stop(), go(state.index + 1));
    else if (e.key === "ArrowLeft") (stop(), go(state.index - 1, false));
    else if (e.key === "r" || e.key === "R") (stop(), (shown.used = 0), (shown.billed = 0), go(0));
    else if (e.key === "Escape") ((state.selected = null), applyFocus());
  });

  $("#theme").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("harness-theme", next);
    } catch {
      // Storage can be unavailable; the theme still switches for this visit.
    }
  });
}

readUrl();
wire();
drawAbout();
const deepLinked = state.index > 0;
render(!deepLinked);
// A fresh visit starts the factory; a deep link holds the chosen step.
if (!deepLinked && !engine.reduced) {
  state.playing = true;
  playIcon();
  schedule();
}
