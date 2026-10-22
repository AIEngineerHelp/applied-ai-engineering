// The app teaches one idea in order: the problem (plain retrieval returns conflicting passages),
// the idea (the agent keeps its own pages), a walkthrough the reader steps through (five documents and
// one check), the payoff (the same question, answered from one page) and a recap.
// Nothing moves or scrolls unless the reader clicks. The optional Play mode advances one step at a
// time on a calm timer that the speed control scales.
// All data comes from results/run.json (built by `npm run data`); this file only presents it.

import runJson from "../results/run.json" with { type: "json" };
import type { Change, QuestionResult, Run, Step } from "../src/build.ts";
import type { FactResult } from "../src/retrieve.ts";
import { parseSpeed, SceneClock, SPEEDS } from "./clock.ts";
import { inline, pageMeta, sourceHtml, trackedBlocks, type Block } from "./doc.ts";
import { edgeKey, mapSvg } from "./map.ts";
import { esc } from "./render.ts";

const RUN = runJson as unknown as Run;
const INGESTS = RUN.steps.filter((s) => s.kind === "ingest");
const FIX = RUN.steps.find((s) => s.kind === "lint")!;
const LAST = INGESTS[INGESTS.length - 1];
const STEPS: Step[] = [...INGESTS, FIX];
const QUESTION = RUN.questions.find((q) => q.id === "retention")!;

const params = new URLSearchParams(location.search);
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const root = document.documentElement;
const $ = (id: string) => document.getElementById(id)!;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const longDate = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
};
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const titleOf = (file: string) => RUN.sources.find((s) => s.file === file)!;

// ---------------------------------------------------------------- 1. the problem

/** Inline markdown with every "N days" marked, so the conflicting numbers stand out. */
function withDays(text: string): string {
  return inline(text).replace(/\b(\d+) days\b/g, '<span class="num">$1 days</span>');
}

/** The lines of a retrieved chunk that state an answer (or the first line if none do). */
function answerLines(text: string, facts: FactResult[]): string[] {
  const lines = text.split("\n").filter((l) => l.trim());
  const hit = lines.filter((l) => facts.some((f) => new RegExp(f.pattern, "i").test(l)) || /\b\d+ days\b/.test(l));
  return (hit.length ? hit : lines.slice(0, 1)).map((l) => l.replace(/^- /, "").replace(/^\*\*[^*]+\*\*\s*/, ""));
}

function hitsHtml(q: QuestionResult, compact = false): string {
  return q.rag
    .map((c, i) => {
      const src = titleOf(c.file);
      const lines = answerLines(c.text, q.ragFacts);
      const when = src.title.includes(String(src.date.slice(0, 4))) ? "" : ` · ${longDate(src.date)}`;
      // In the payoff, say which passages are outdated (computed fact checks); at the start, don't.
      const wrong = compact ? q.ragFacts.filter((f) => f.kind === "wrong" && f.where.includes(c.id)) : [];
      return `<div class="hit" data-outdated="${wrong.length > 0}"><div class="hit-src"><span>${esc(src.title)}${when}</span>${compact ? "" : `<span>match ${i + 1}</span>`}</div>
        <div class="hit-text">${lines.map(withDays).join(" ")}</div>${wrong.length ? `<p class="hit-note">Outdated: ${wrong.map((w) => esc(w.why ?? "")).join("; ")}.</p>` : ""}</div>`;
    })
    .join("");
}

function renderProblem() {
  $("q-text").textContent = QUESTION.text;
  $("problem-hits").innerHTML = hitsHtml(QUESTION);
}

// ---------------------------------------------------------------- 3. the walkthrough

let current = 0;

/** A page change, typeset as tracked edits. Unchanged stretches fold into one quiet line. */
function pageDiffHtml(step: Step, change: Change): string {
  const page = step.pages.find((p) => p.slug === change.slug)!;
  const meta = pageMeta(page.text);
  const isNew = change.status === "created";
  const blocks = trackedBlocks(change.diff);
  const keep = blocks.map((b, i) => {
    if (isNew || b.change !== "same" || b.kind === "h1") return true;
    if (b.kind !== "h2") return false;
    // Keep a section heading if the section it opens contains a change.
    for (let j = i + 1; j < blocks.length && blocks[j].kind !== "h2"; j++) if (blocks[j].change !== "same") return true;
    return false;
  });
  const out: string[] = [];
  let folded = 0;
  const flush = () => {
    if (folded) out.push(`<div class="fold-row">⋯ ${plural(folded, "unchanged line")}</div>`);
    folded = 0;
  };
  blocks.forEach((b: Block, i) => {
    if (!keep[i]) {
      folded++;
      return;
    }
    flush();
    const cls = `b-${b.kind}${b.change !== "same" && !isNew ? ` chg-${b.change}` : ""}`;
    if (b.kind === "h1") {
      out.push(`<h1>${b.html}</h1><div class="page-sub">${cap(meta.type)} page · ${isNew ? "new" : `revised ${longDate(meta.updated)}`} · <code>wiki/${esc(change.path)}</code></div>`);
    } else if (b.kind === "h2") {
      // Plain-language section names: "Claims" are the facts that can change.
      const name = b.html === "Claims" ? "Facts that can change (with source and date)" : b.html;
      out.push(`<div class="${cls}">${name}</div>`);
    } else out.push(`<div class="${cls}">${b.html}</div>`);
  });
  flush();
  return `<div class="page">${out.join("")}</div>`;
}

function stepHtml(n: number): string {
  const step = STEPS[n];
  const isCheck = step.kind === "lint";
  const prev = n > 0 ? STEPS[n - 1] : null;
  const change = step.changes.find((c) => c.slug === step.show) ?? step.changes[0];
  const created = step.changes.filter((c) => c.status === "created").length;
  const revised = step.changes.length - created;
  const newLinks = step.graph.edges.length - (prev?.graph.edges.length ?? 0);

  // (a) the new document, or the check
  let partA: string;
  if (isCheck) {
    const rows = RUN.lintBefore.findings
      .filter((f) => f.kind === "contradiction")
      .map((f) => {
        const key = f.claims.map((c) => c.key).sort((a, b) => a.length - b.length)[0];
        const what = key.startsWith("export.retention") ? "How long exports are kept" : "When exports run";
        return `<table class="conflicts"><caption>${what}, on the <code>${esc(f.claims[0].page)}</code> page:</caption>${f.claims
          .map((c) => `<tr class="${c.source === "src-faq-draft" ? "bad" : ""}"><td>${esc(c.value)}</td><td>${sourceLabel(c.source)}</td></tr>`)
          .join("")}</table>`;
      })
      .join("");
    const missing = RUN.lintBefore.findings.find((f) => f.kind === "missing-page");
    partA = `<div class="part"><div class="part-h"><span class="label">The check · <b>lint</b></span><span class="caption">computed</span></div>
      ${rows}
      ${missing ? `<p class="caption mt-3">Also found: four pages link to a page for Jun Park that doesn't exist yet.</p>` : ""}</div>`;
  } else {
    const src = titleOf(step.source!);
    const marks = step.key.map((quote, i) => ({ n: i + 1, quote, at: 0 }));
    partA = `<div class="part"><div class="part-h"><span class="label">New document · <b>${esc(src.title)}</b></span><span class="caption">${longDate(src.date)}</span></div>
      ${step.key.map((q) => `<p class="quote">${inline(q)}</p>`).join("")}
      <details class="fold"><summary>Show the full document</summary><div class="fold-body"><div class="page source">${sourceHtml(src.text, marks)}</div></div></details></div>`;
  }

  // (b) what the agent did
  const did = `<div class="part"><div class="part-h"><span class="label">${isCheck ? "What the agent proposes" : "What the agent did"}</span></div>
    <ul class="did">${step.did.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>
    <p class="caption mt-3">${
      isCheck
        ? `A person approves. Lint then runs again and finds ${plural(RUN.lintAfter.findings.length, "problem")}.`
        : `Counted from the page files: ${plural(created, "page")} created, ${revised} revised, ${plural(newLinks, "new link")}.`
    }</p></div>`;

  // (c) the page change that matters most
  const partC = `<div class="part"><div class="part-h"><span class="label">${isCheck ? "The page after the fix" : "The page change that matters most"}</span><span class="caption">before → after</span></div>
    ${pageDiffHtml(step, change)}
    <div class="legend">${change.status === "created" ? "<span>A new page: everything on it was written by this step.</span>" : "<span><ins>added</ins></span><span><s>crossed out</s>, kept with the reason</span><span><del>removed</del></span>"}<span>Other pages changed: ${step.changes.filter((c) => c.slug !== change.slug).map((c) => esc(c.slug)).join(", ")}</span></div></div>`;

  // Optional, collapsed: the map, the index and the log.
  const before = new Set((prev?.graph.edges ?? []).map((e) => edgeKey(e.from, e.to)));
  const map = mapSvg(step.graph, RUN.layout, {
    width: 440,
    height: 300,
    still: true,
    created: new Set(step.changes.filter((c) => c.status === "created").map((c) => c.slug)),
    touched: new Set(step.changes.filter((c) => c.status === "updated").map((c) => c.slug)),
    newEdges: new Set(step.graph.edges.map((e) => edgeKey(e.from, e.to)).filter((k) => !before.has(k))),
    fontSize: 11,
  });
  const fileHtml = (text: string, old: string | undefined) => {
    const seen = new Set((old ?? "").split("\n"));
    return text
      .replace(/\n$/, "")
      .split("\n")
      .map((l) => `<div class="${l.trim() && !seen.has(l) ? "new" : ""}">${esc(l) || "&nbsp;"}</div>`)
      .join("");
  };
  const extras = `<details class="fold"><summary>Map of the wiki: ${plural(step.pages.length, "page")}, ${plural(step.graph.edges.length, "link")}</summary><div class="fold-body">${map}<p class="caption mt-2">Filled: pages created by this step. Ringed: pages it revised.</p></div></details>
    <details class="fold"><summary>index.md and log.md</summary><div class="fold-body fold-grid"><div><p class="label mb-2">index.md</p><div class="file">${fileHtml(step.index, prev?.index)}</div></div><div><p class="label mb-2">log.md</p><div class="file">${fileHtml(step.log, prev?.log)}</div></div></div><p class="caption">Lines added by this step are shaded.</p></details>`;

  return `<p class="step-lede">${esc(step.lede)}</p>${partA}${did}${partC}${extras}`;
}

function sourceLabel(slug: string): string {
  const names: Record<string, string> = {
    "src-kickoff": "kickoff notes, 2 March",
    "src-design-doc": "approved design doc, 16 March",
    "src-inc-482": "incident report, 7 April",
    "src-support-thread": "Amara's decision in the chat thread, 20 April",
    "src-faq-draft": "unreviewed FAQ draft, 5 May",
  };
  return esc(names[slug] ?? slug);
}

const STEP_NAMES = ["Kickoff notes", "Design doc", "Incident report", "Chat thread", "Draft FAQ", "The check"];

function renderSteps() {
  $("steps").innerHTML = STEP_NAMES.map(
    (name, i) => `<li><button type="button" data-step="${i}" ${i === current ? 'aria-current="step"' : ""} data-done="${i < current}">${i + 1}. ${name}</button></li>`,
  ).join("");
  ($("prev") as HTMLButtonElement).disabled = current === 0;
  $("next").textContent = current === STEPS.length - 1 ? "See the payoff →" : "Next →";
}

/** Shows step n. The only motion is one short fade of the new step's content. */
function show(n: number, fade = true) {
  current = Math.max(0, Math.min(STEPS.length - 1, n));
  const el = $("step");
  el.innerHTML = stepHtml(current);
  renderSteps();
  if (fade && !REDUCED) {
    el.classList.remove("fade");
    void el.offsetWidth;
    el.classList.add("fade");
  }
  clock.restart();
}

// ---------------------------------------------------------------- optional Play mode

// One clock; the speed control scales it. Play moves to the next step every STEP_MS of clock time.
const STEP_MS = 14000;
function initialSpeed(): number {
  const fromUrl = parseSpeed(params.get("speed"));
  if (fromUrl) return fromUrl;
  try {
    return parseSpeed(localStorage.getItem("wiki-memory-speed")) ?? 1;
  } catch {
    return 1;
  }
}
const clock = new SceneClock(() => performance.now(), initialSpeed());
let playing = false;
let playTimer = 0;

function renderSpeed() {
  $("speed").innerHTML = SPEEDS.map(
    (s) => `<button type="button" class="speed-opt" data-speed="${s}" aria-pressed="${s === clock.speed}" aria-label="${s}× speed">${s}×</button>`,
  ).join("");
}

function setSpeed(speed: number) {
  if (speed === clock.speed) return;
  clock.setSpeed(speed);
  renderSpeed();
  if (playing) schedulePlay();
  try {
    localStorage.setItem("wiki-memory-speed", String(speed));
  } catch {
    // Storage may be unavailable; the speed still applies for this visit.
  }
}

function schedulePlay() {
  clearTimeout(playTimer);
  if (!playing) return;
  playTimer = window.setTimeout(() => {
    if (current >= STEPS.length - 1) return setPlaying(false);
    show(current + 1);
    schedulePlay();
  }, clock.wallUntil(STEP_MS));
}

function setPlaying(on: boolean) {
  playing = on;
  $("play").setAttribute("aria-pressed", String(on));
  $("play").textContent = on ? "Pause" : "Play";
  if (on) clock.restart();
  schedulePlay();
}

// ---------------------------------------------------------------- 4. the payoff

function renderPayoff() {
  const q = QUESTION;
  const page = FIX.pages.find((p) => p.slug === "export-retention")!;
  const claims = trackedBlocks(page.text.split("\n").map((text) => ({ op: "same" as const, text }))).filter((b) => b.kind === "claim");
  const tally = (facts: FactResult[]) => {
    const need = facts.filter((f) => f.kind === "needed");
    const bad = facts.filter((f) => f.kind === "wrong" && f.found).length;
    return `<p class="tally"><b>${need.filter((f) => f.found).length} of ${need.length}</b> facts the answer needs · <b class="${bad ? "bad" : "good"}">${plural(bad, "outdated statement")}</b> <span class="caption">(computed)</span></p>`;
  };
  $("payoff-body").innerHTML = `<div class="side">
      <h3 class="side-name">Wiki memory</h3>
      <p class="caption mt-1">The agent reads the index and opens one page, <code>export-retention</code>.</p>
      <p class="answer">${esc(q.wikiAnswer.replace(/ Sources:.*$/, ""))}</p>
      <div class="page">${claims.map((b) => `<div class="b-claim">${b.html}</div>`).join("")}</div>
      ${tally(q.wikiFacts)}
      <p class="caption">The answer is written by hand from the page; the page and the fact check are computed.</p>
    </div>
    <div class="side">
      <h3 class="side-name">Plain retrieval</h3>
      <p class="caption mt-1">The same three passages as at the start.</p>
      <div class="hits">${hitsHtml(q, true)}</div>
      ${tally(q.ragFacts)}
    </div>`;
  $("more-questions").innerHTML = RUN.questions
    .filter((x) => x.id !== q.id)
    .map((x) => {
      const ragBad = x.ragFacts.filter((f) => f.kind === "wrong" && f.found).length;
      const verdict = ragBad
        ? `Both find the answer, but plain retrieval also returns ${plural(ragBad, "outdated statement")}: the March design doc's 100 and 80 requests per second.`
        : "A draw: the whole answer sits in one document that nothing contradicts, so plain retrieval does as well as the wiki.";
      return `<div class="mq"><p class="sub !text-[17px] !text-[var(--ink)]">${esc(x.text)}</p><p>${esc(verdict)}</p><p class="caption">Wiki: ${esc(x.wikiAnswer.replace(/ Sources:.*$/, ""))}</p></div>`;
    })
    .join("");
}

// ---------------------------------------------------------------- wiring

document.addEventListener("click", (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-step], [data-speed], #prev, #next, #play, #theme");
  if (!el) return;
  if (el.dataset.speed) setSpeed(Number(el.dataset.speed));
  else if (el.dataset.step) {
    setPlaying(false);
    show(Number(el.dataset.step));
  } else if (el.id === "prev") {
    setPlaying(false);
    show(current - 1);
  } else if (el.id === "next") {
    setPlaying(false);
    if (current === STEPS.length - 1) {
      $("payoff").scrollIntoView({ behavior: REDUCED ? "auto" : "smooth" });
      return;
    }
    show(current + 1);
    // The reader clicked Next at the bottom of a long step: bring the new step's top into view.
    const top = $("walk").querySelector(".stepbar")!.getBoundingClientRect().top;
    // Instant, so the fade is the only motion a click causes.
    if (top < 0) $("walk").querySelector(".stepbar")!.scrollIntoView({ behavior: "auto" });
  } else if (el.id === "play") setPlaying(!playing);
  else if (el.id === "theme") {
    root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
    try {
      localStorage.setItem("wiki-memory-theme", root.dataset.theme);
    } catch {
      // The theme still applies for this visit.
    }
    $("theme").textContent = root.dataset.theme === "dark" ? "Light" : "Dark";
  }
});

// ---------------------------------------------------------------- start

$("theme").textContent = root.dataset.theme === "dark" ? "Light" : "Dark";
renderProblem();
renderSpeed();
show(Math.max(0, (Number(params.get("step")) || 1) - 1), false);
renderPayoff();
// Review hook: ?only=<section id> shows one section, so screenshots start at its top.
const only = params.get("only");
if (only && document.getElementById(only)) for (const s of document.querySelectorAll("main > section")) (s as HTMLElement).hidden = s.id !== only;
if (params.get("play") === "1") setPlaying(true);
