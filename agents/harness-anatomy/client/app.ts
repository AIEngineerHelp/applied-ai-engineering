// The page: the machine, its transport and meters, the parts list, and the
// tables in the article. Everything is computed from src/harness.ts.

import { ALL_PARTS, GROUPS, PARTS, PROBLEMS, TASK, WINDOW, effective, fmt, partById, run, type PartId, type Run } from "../src/harness.ts";
import { LEGEND, PART_NUMBER, drawFigure } from "./figure.ts";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

const STEP_MS = 1900;

const state = {
  installed: new Set<PartId>(ALL_PARTS),
  run: run(ALL_PARTS) as Run,
  index: 0,
  playing: false,
  selected: null as PartId | null,
  hovered: null as PartId | null,
  timer: 0 as number,
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
  const off = ALL_PARTS.filter((p) => !state.installed.has(p));
  const q = new URLSearchParams();
  if (off.length) q.set("off", off.join(","));
  if (state.index > 0) q.set("step", String(state.index + 1));
  const s = q.toString();
  history.replaceState(null, "", s ? `?${s}${location.hash}` : `${location.pathname}${location.hash}`);
}

// ---------- The machine ----------

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

function drawMachine() {
  const steps = state.run.steps;
  const step = steps[state.index];
  const prev = new Set((steps[state.index - 1]?.blocks ?? []).map((b) => b.id));
  const fresh = new Set(step.blocks.filter((b) => !prev.has(b.id)).map((b) => b.id));
  $("#figure").innerHTML = drawFigure({
    on: effective(state.installed),
    step,
    fresh: state.index === 0 ? new Set() : fresh,
    lastCall: lastCall(state.index),
    shipped: shipped(),
  });
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
  const on = effective(state.installed).has(id);
  const group = GROUPS.find((g) => g.id === p.group)!;
  const missing = p.needs.filter((n) => !effective(state.installed).has(n)).map((n) => partById(n).name);
  card.innerHTML = `
    <div class="mb-1 flex items-center gap-2"><span class="pnum">${PART_NUMBER[id]}</span><b class="text-[13.5px]">${esc(p.name)}</b></div>
    <div class="mb-2 font-mono text-[10.5px] tracking-wide text-muted uppercase">${esc(group.name)} · ${esc(p.object)}</div>
    <p class="mb-2 text-ink-2">${esc(p.does)}</p>
    <p class="text-muted"><b class="font-medium text-ink-2">Without it:</b> ${esc(p.without)}</p>
    ${!on ? `<p class="mt-2 font-medium" style="color:var(--accent)">${missing.length && state.installed.has(id) ? `Not working: it needs ${esc(missing.join(" and "))}.` : "Pulled out of this machine."}</p>` : ""}`;
  card.hidden = false;
}

// ---------- Narration, meters, transport ----------

function drawNarration() {
  const s = state.run.steps[state.index];
  const tone = s.tone === "bad" ? "color:var(--bad)" : s.tone === "good" ? "color:var(--good)" : s.tone === "pause" ? "color:var(--accent)" : "color:var(--muted)";
  const toneName = { bad: "Went wrong", good: "Harness at work", pause: "Waiting for a person", info: "Step" }[s.tone];
  const last = state.index === state.run.steps.length - 1;
  const parts = s.active.map((id) => `<span class="pnum !size-[18px] !text-[10px]" title="${esc(partById(id).name)}">${PART_NUMBER[id]}</span>`).join("");
  let outcome = "";
  if (last) {
    const r = state.run;
    outcome = r.problems.length
      ? `<div class="mt-3 border-t border-rule pt-3 font-sans text-[13px]"><b>End of run.</b> ${r.problems.length} problem${r.problems.length > 1 ? "s" : ""}: ${r.problems.map((p) => esc(PROBLEMS[p].toLowerCase())).join("; ")}.</div>`
      : `<div class="mt-3 border-t border-rule pt-3 font-sans text-[13px]"><b class="ok">End of run.</b> Fixed, verified, reviewed and remembered, in ${r.calls} calls and ${fmt(r.billed)} billed.</div>`;
  }
  $("#narration").innerHTML = `
    <div class="mb-1.5 flex items-center gap-2 font-sans text-[11px] font-medium tracking-wide uppercase" style="${tone}">
      <span>${toneName}</span><span class="text-faint">·</span><span class="font-mono normal-case text-muted">${state.index + 1} / ${state.run.steps.length}</span>
      <span class="ml-auto flex gap-1">${parts}</span>
    </div>
    <h3 class="mb-1.5 font-serif text-[22px] leading-snug">${esc(s.title)}</h3>
    <p class="leading-relaxed text-ink-2">${esc(s.text)}</p>
    ${s.call ? `<div class="mt-2.5 inline-block rounded-md bg-well px-2 py-1 font-mono text-[12px] text-ink-2">${esc(s.call)}</div>` : ""}
    ${outcome}`;

  const over = s.used > WINDOW;
  $("#m-used").textContent = `${fmt(s.used, false)} / 200k`;
  const bar = $("#m-bar");
  bar.style.width = `${Math.min(100, (s.used / WINDOW) * 100)}%`;
  bar.dataset.over = String(over);
  $("#m-billed").textContent = fmt(s.billed, false);
  $("#m-calls").textContent = String(s.calls);
  $("#m-problems").innerHTML = s.problems.length
    ? s.problems.map((p) => `<li class="flex gap-1.5" style="color:var(--bad)"><span aria-hidden="true">×</span>${esc(PROBLEMS[p])}</li>`).join("")
    : `<li class="text-muted">None</li>`;
}

function drawTransport() {
  const steps = state.run.steps;
  $("#dots").innerHTML = steps
    .map((s, i) => `<button class="dot" type="button" data-i="${i}" data-tone="${s.tone}" data-state="${i < state.index ? "done" : i === state.index ? "now" : "todo"}" title="${i + 1}. ${esc(s.title)}" aria-label="Step ${i + 1}: ${esc(s.title)}"></button>`)
    .join("");
  $("#counter").textContent = `${state.index + 1}/${steps.length}`;
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

function render() {
  drawMachine();
  drawNarration();
  drawTransport();
  drawParts();
  writeUrl();
}

// ---------- Actions ----------

function go(i: number) {
  state.index = Math.max(0, Math.min(state.run.steps.length - 1, i));
  render();
}

function stop() {
  state.playing = false;
  clearTimeout(state.timer);
}

function play() {
  if (state.index >= state.run.steps.length - 1) state.index = 0;
  state.playing = true;
  render();
  const tick = () => {
    if (!state.playing) return;
    if (state.index >= state.run.steps.length - 1) {
      stop();
      drawTransport();
      return;
    }
    go(state.index + 1);
    state.timer = window.setTimeout(tick, STEP_MS);
  };
  state.timer = window.setTimeout(tick, reduced ? STEP_MS * 1.3 : STEP_MS);
}

function setInstalled(next: Set<PartId>, autoplay = true) {
  stop();
  state.installed = next;
  state.run = run(next);
  state.index = 0;
  if (autoplay) play();
  else render();
}

/** "Write & run code" → "write & run code", but "REPL" stays "REPL". */
const lower = (name: string) => (name === name.toUpperCase() ? name : name[0].toLowerCase() + name.slice(1));

const without = (ids: PartId[]) => new Set(ALL_PARTS.filter((p) => !ids.includes(p)));

// ---------- Article: the four-job board and the comparison tables ----------

function drawBoard() {
  $("#board").innerHTML = GROUPS.map(
    (g) => `
    <div class="board-col">
      <div class="mb-1 font-mono text-[11px] tracking-wide uppercase" style="color:var(--accent)">${esc(g.name)}</div>
      <p class="mb-3 text-[13px] leading-snug text-muted">${esc(g.job)}</p>
      <ul class="space-y-1.5 text-[13.5px]">
        ${PARTS.filter((p) => p.group === g.id)
          .map((p) => `<li class="flex items-center gap-2"><span class="pnum">${PART_NUMBER[p.id]}</span>${esc(p.name)}<span class="ml-auto font-mono text-[10.5px] text-faint">${esc(p.object.toLowerCase())}</span></li>`)
          .join("")}
      </ul>
    </div>`,
  ).join("");
}

const full = run(ALL_PARTS);

function ratio(n: number, base: number) {
  if (n === base) return `<span class="x">same</span>`;
  const r = n / base;
  const pct = Math.round((r - 1) * 100);
  return `<span class="x">${r >= 1.5 ? `×${r.toFixed(1)}` : pct === 0 ? "same" : `${pct > 0 ? "+" : "−"}${Math.abs(pct)}%`}</span>`;
}

function problemsCell(r: Run) {
  return r.problems.length ? r.problems.map((p) => `<span class="prob">${esc(PROBLEMS[p])}</span>`).join(" ") : `<span class="ok">None</span>`;
}

function row(label: string, off: PartId[], r: Run, extra = "") {
  return `<tr data-off="${off.join(",")}">
    <td>${label}${extra}</td>
    <td class="num">${fmt(r.peak, false)} ${ratio(r.peak, full.peak)}</td>
    <td class="num">${fmt(r.billed, false)} ${ratio(r.billed, full.billed)}</td>
    <td class="num">${r.calls}</td>
    <td>${problemsCell(r)}</td>
    <td><button class="try" type="button" data-try="${off.join(",")}">Run it ↑</button></td>
  </tr>`;
}

const HEAD = `<thead><tr><th>Machine</th><th class="!text-right">Peak window</th><th class="!text-right">Tokens billed</th><th class="!text-right">Calls</th><th>Problems</th><th></th></tr></thead>`;

function drawCompares() {
  // Extra rows that show a part doing work only when others are missing.
  const extras: Record<string, { label: string; off: PartId[] }[]> = {
    context: [
      { label: "Without subagents or offloading", off: ["subagents", "offloading"] },
      { label: "… and without summarization", off: ["subagents", "offloading", "summarization"] },
    ],
  };
  document.querySelectorAll<HTMLElement>("[data-compare]").forEach((el) => {
    const g = el.dataset.compare!;
    const rows = [row("Full harness", [], full)];
    for (const p of PARTS.filter((x) => x.group === g)) rows.push(row(`Without ${lower(p.name)}`, [p.id], run(without([p.id]))));
    for (const e of extras[g] ?? []) rows.push(row(e.label, e.off, run(without(e.off))));
    el.innerHTML = `<table>${HEAD}<tbody>${rows.join("")}</tbody></table>`;
  });

  const rows = [row("Full harness", [], full)];
  for (const p of PARTS) {
    const lost = ALL_PARTS.filter((x) => x !== p.id && !effective(without([p.id])).has(x));
    const extra = lost.length ? `<div class="x mt-0.5">also stops ${lost.map((x) => esc(lower(partById(x).name))).join(", ")}</div>` : "";
    rows.push(row(`<span class="pnum mr-1.5 inline-grid">${PART_NUMBER[p.id]}</span>Without ${esc(lower(p.name))}`, [p.id], run(without([p.id])), extra));
  }
  rows.push(row("Bare model: no parts at all", ALL_PARTS, run([])));
  $("#all-parts").innerHTML = `${HEAD}<tbody>${rows.join("")}</tbody>`;
}

// ---------- Events ----------

function wire() {
  $("#task").textContent = TASK;
  $("#legend").innerHTML = LEGEND.map((l) => `<span><span class="swatch ${l.cls}"></span>${esc(l.name)}</span>`).join("") +
    `<span class="ml-auto font-mono text-[10.5px] text-faint">one tray unit = 10k tokens · sizes are illustrative</span>`;

  $("#play").addEventListener("click", () => (state.playing ? (stop(), drawTransport()) : play()));
  $("#next").addEventListener("click", () => (stop(), go(state.index + 1)));
  $("#prev").addEventListener("click", () => (stop(), go(state.index - 1)));
  $("#reset").addEventListener("click", () => (stop(), go(0)));
  $("#dots").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-i]");
    if (b) (stop(), go(Number(b.dataset.i)));
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
    const rowEl = (e.target as HTMLElement).closest<HTMLElement>(".prow");
    const id = (rowEl?.dataset.part as PartId) ?? null;
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
    const partEl = t.closest("[data-part]");
    const id = (partEl?.getAttribute("data-part") as PartId) ?? null;
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

  // Article buttons and table rows load a machine and scroll back up to it.
  document.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const tryEl = t.closest<HTMLElement>("[data-try]") ?? t.closest<HTMLElement>("tr[data-off]");
    if (!tryEl || !tryEl.closest("article")) return;
    const off = (tryEl.dataset.try ?? tryEl.dataset.off ?? "").split(",").filter(Boolean) as PartId[];
    state.selected = null;
    setInstalled(without(off));
    $("#machine").scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
  });

  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    if (e.key === " " && tag !== "BUTTON") {
      e.preventDefault();
      if (state.playing) (stop(), drawTransport());
      else play();
    } else if (e.key === "ArrowRight") (stop(), go(state.index + 1));
    else if (e.key === "ArrowLeft") (stop(), go(state.index - 1));
    else if (e.key === "r" || e.key === "R") (stop(), go(0));
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
drawBoard();
drawCompares();
render();
