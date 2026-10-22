// The page: a plain-language intro (the problem and the idea, static), then the walkthrough, which
// plays by itself: each source sits next to the wiki page it changes, numbered passages highlight,
// then the edits apply, one thing at a time. Then the payoff and the recap (static).
// Timing runs on one clock that the speed control scales; ?t=<ms> freezes any moment for review.
// The reader always wins: any step, tab or Previous/Next click pauses autoplay, and any scroll in a
// pane stops auto-scrolling for that step.

import runJson from "../results/run.json" with { type: "json" };
import type { Change as PageChange, QuestionResult, Run, SourceLink, Step } from "../src/build.ts";
import type { FactResult } from "../src/retrieve.ts";
import { inline, pageMeta, parseClaim, sourceHtml, trackedBlocks, type Block, type SourceMark } from "./doc.ts";
import { edgeKey, mapSvg } from "./map.ts";
import { esc } from "./render.ts";
import { renderPayoff, renderProblem } from "./intro.ts";
import { parseSpeed, SceneClock, SPEEDS } from "./clock.ts";

const RUN = runJson as unknown as Run;
const INGESTS = RUN.steps.filter((s) => s.kind === "ingest");
const FIX = RUN.steps.find((s) => s.kind === "lint")!;
const LAST = INGESTS[INGESTS.length - 1];
const LINT_SCENE = INGESTS.length + 1;
const FIX_SCENE = INGESTS.length + 2;
const SCENES = FIX_SCENE + 1;

const params = new URLSearchParams(location.search);
const FROZEN = params.has("t") ? Math.max(0, Number(params.get("t")) || 0) : null;
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const root = document.documentElement;
if (FROZEN !== null) {
  root.classList.add("frozen");
  root.style.setProperty("--t", String(FROZEN));
}

const $ = (id: string) => document.getElementById(id)!;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const longDate = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
};

// ---------------------------------------------------------------- the story

let scene = 0;
let playing = false;
let started = false;
// One clock for everything time-based in the story. Speed comes from ?speed=, then the saved choice.
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
let docFile: string | null = null;
let marginTab: "map" | "index" | "log" = "map";
let timeline = { len: Infinity };

const sceneTime = () => (FROZEN !== null ? FROZEN : REDUCED ? 1e7 : clock.time());

function stepFor(i: number): Step | null {
  if (i >= 1 && i <= INGESTS.length) return INGESTS[i - 1];
  if (i === FIX_SCENE) return FIX;
  return null;
}

const prevOf = (i: number): Step | null => (i === FIX_SCENE ? LAST : i > 1 && i <= INGESTS.length ? INGESTS[i - 2] : null);

interface Beat {
  at: number;
  kicker: string;
  line: string;
}

function enter(i: number) {
  scene = Math.max(0, Math.min(SCENES - 1, i));
  clock.restart();
  docFile = null;
  renderChrome();
  const { beats, len } = renderScene();
  timeline = { len };
  renderCaption(beats);
  applyRate();
  scheduleFollow();
  tick();
}

/** Renders the two panes and the map for the scene, and returns its subtitles and length. */
function renderScene(): { beats: Beat[]; len: number } {
  const doc = $("doc");
  const src = $("src");
  const note = $("doc-note");
  if (scene === 0) {
    setLabels("Raw sources", "", "Wiki page", "wiki/");
    src.innerHTML = `<div class="page seq" style="--d:0"><h1>Five sources</h1><div class="page-sub">Never edited. The agent only reads them.</div>
      <ol class="src-index mt-4">${RUN.sources
        .map((s, k) => `<li><button type="button" data-scene="${k + 1}">${esc(INGESTS[k].title)}<span class="d">${s.date} · raw/${esc(s.file)}</span></button></li>`)
        .join("")}</ol></div>`;
    doc.innerHTML = `<article class="page seq" style="--d:150">
        <h1>An empty wiki</h1>
        <div class="b-p">Press play. Each source opens on the left, and the agent's edits appear here on the right as tracked changes: <ins>added words</ins>, <del>removed words</del>, and old values struck through rather than deleted.</div>
        <div class="b-p">A number such as <span class="lnum">1</span> joins a highlighted passage in the source to the edit it caused. Hover or tap either one to see both.</div>
      </article>`;
    note.textContent = "";
    renderMargin(null, {});
    return { beats: [{ at: 0, kicker: "Before the first source", line: "The wiki is empty. Five sources are waiting to be filed." }], len: Infinity };
  }

  if (scene === LINT_SCENE) {
    setLabels("Lint report", "computed by src/lint.ts", "Wiki page", "wiki/concepts/export-retention.md");
    src.innerHTML = lintReport(300, true);
    doc.innerHTML = conflictPage(1700);
    note.textContent = "Lint compares the claims on every page. The page on the right is unchanged; it simply holds both values.";
    const flagAt = 2500;
    renderMargin(LAST, { flagAt });
    const c = RUN.lintBefore.checks.find((x) => x.kind === "contradiction")!.count;
    const m = RUN.lintBefore.checks.find((x) => x.kind === "missing-page")!.count;
    return {
      beats: [
        { at: 0, kicker: "Lint · the whole wiki at once", line: `Lint reads all ${LAST.claims.current} current claims on all ${LAST.pages.length} pages.` },
        { at: flagAt, kicker: "Lint · computed", line: `It finds <span class="bad">${plural(c, "contradiction")}</span> and ${plural(m, "link")} to a page that doesn't exist.` },
        { at: flagAt + 1800, kicker: "Why no single ingest caught it", line: "Each ingest only opened the pages its source was about. Lint proposes fixes; a person decides." },
      ],
      len: flagAt + 7000,
    };
  }

  const step = stepFor(scene)!;
  const change = step.changes.find((c) => c.slug === (docFile ?? step.focus)) ?? step.changes[0];
  const { html, end, marks } = pageHtml(step, change, 300, 900);
  doc.innerHTML = html;
  setLabels(scene === FIX_SCENE ? "Lint report" : "Source", scene === FIX_SCENE ? "approved fixes" : `raw/${step.source}`, change.status === "created" ? "New wiki page" : "Wiki page · tracked changes", `wiki/${change.path}`);
  if (scene === FIX_SCENE) {
    src.innerHTML = lintReport(0, false);
    note.textContent = "Page text written by hand. Tracked changes and counts computed from it.";
  } else {
    const raw = RUN.sources.find((s) => s.file === step.source)!;
    src.innerHTML = `<div class="page seq" style="--d:0">${sourceHtml(raw.text, marks)}</div>`;
    note.textContent = "Source and page text written by hand; numbered links stored with the step. Tracked changes and counts computed.";
  }
  doc.scrollTop = 0;
  src.scrollTop = 0;
  const created = step.changes.filter((c) => c.status === "created").length;
  const revised = step.changes.length - created;
  const mapAt = end + 300;
  const edgesAt = mapAt + (created ? 350 : 0);
  renderMargin(step, { nodeAt: mapAt, edgeAt: edgesAt });
  const newLinks = step.graph.edges.length - (prevOf(scene)?.graph.edges.length ?? 0);
  const countLine = `The agent ${created ? `created ${plural(created, "page")}` : "created no pages"}${revised ? ` and revised ${revised}` : ""}, adding ${plural(newLinks, "link")}.`;
  const last = edgesAt + 1100;
  if (scene === FIX_SCENE) {
    return {
      beats: [
        { at: 0, kicker: "Fix · approved by a person", line: "The proposed fixes are approved and applied." },
        { at: mapAt, kicker: "Fix · computed", line: countLine },
        { at: last, kicker: "Lint again · computed", line: `<span class="good">${plural(RUN.lintAfter.findings.length, "problem")}</span>. The draft's claims stay on the page, marked disputed.` },
      ],
      len: last + 5000,
    };
  }
  return {
    beats: [
      { at: 0, kicker: `Source ${scene} of ${INGESTS.length} · ${longDate(RUN.sources[scene - 1].date)}`, line: `<em>${esc(step.title)}</em> arrives. Each numbered passage on the left becomes the edit with the same number.` },
      { at: mapAt, kicker: "Ingest · computed", line: countLine },
      { at: last, kicker: "What changed", line: esc(step.caption) },
    ],
    len: last + 5200,
  };
}

function setLabels(srcLabel: string, srcPath: string, docLabel: string, docPath: string) {
  $("src-label").textContent = srcLabel;
  $("src-path").textContent = srcPath;
  $("doc-label").textContent = docLabel;
  $("doc-path").textContent = docPath;
}

/**
 * A wiki page typeset with tracked changes. Changes reveal one at a time from `from`. When a change has
 * a linked source passage, the passage is highlighted first and the edit follows half a second later.
 */
function pageHtml(step: Step, change: PageChange, docAt: number, from: number): { html: string; end: number; marks: SourceMark[] } {
  const page = step.pages.find((p) => p.slug === change.slug)!;
  const meta = pageMeta(page.text);
  const isNew = change.status === "created";
  const blocks = trackedBlocks(change.diff);
  const links = (step.links ?? []).filter((l) => l.page === change.slug);
  // Number links in the order their first edit appears on the page.
  const linksOf = (b: Block) => links.filter((l) => b.change !== "same" && l.anchors.some((a) => b.raw.includes(a)));
  const order: SourceLink[] = [];
  for (const b of blocks) for (const l of linksOf(b)) if (!order.includes(l)) order.push(l);
  const number = (l: SourceLink) => order.indexOf(l) + 1;
  const hlAt = new Map<SourceLink, number>();
  let cursor = from;
  const render = (b: Block) => {
    let at = 0;
    const ls = linksOf(b);
    if (b.change !== "same") {
      const fresh = ls.filter((l) => !hlAt.has(l));
      if (fresh.length) {
        fresh.forEach((l) => hlAt.set(l, cursor));
        at = cursor + 500;
        cursor += 1000;
      } else {
        at = cursor;
        cursor += ls.length ? 400 : isNew ? 90 : 300;
      }
    }
    const kind = isNew && b.change === "ins" ? "new" : b.change;
    const cls = `b-${b.kind}${b.change === "same" ? "" : ` chg chg-${kind}`}`;
    const attrs = `${b.change === "same" ? "" : ` style="--d:${Math.round(at)}"`}${ls.length ? ` data-link="${ls.map(number).join(" ")}"` : ""}`;
    const gutter = ls.length ? `<span class="gutter">${ls.map((l) => `<span class="lnum">${number(l)}</span>`).join("")}</span>` : "";
    if (b.kind === "h1") {
      return `<h1 class="${cls}"${attrs}>${b.html}</h1><div class="page-sub${b.change === "same" ? "" : " chg"}"${b.change === "same" ? "" : ` style="--d:${Math.round(at)}"`}>${cap(meta.type)} · ${isNew ? "new page" : `revised ${longDate(meta.updated)}`} · ${plural(meta.sources || 1, "source")}</div>`;
    }
    return `<div class="${cls}"${attrs}>${gutter}${b.html}</div>`;
  };
  // Plain-language section name: "Claims" are the facts that can change.
  for (const b of blocks) if (b.kind === "h2" && b.html === "Claims") b.html = "Facts that can change (with source and date)";
  const body = blocks.map(render).join("");
  const others = step.changes
    .map((c) => `<button type="button" data-file="${c.slug}" ${c.slug === change.slug ? 'aria-current="true"' : ""}>${esc(c.slug)}</button>`)
    .join(", ");
  const html = `<article class="page seq" style="--d:${docFile === null ? docAt : 0}">
      ${body}
      <div class="page-foot">This ${scene === FIX_SCENE ? "fix" : "source"} changed ${plural(step.changes.length, "page")}: ${others}.</div>
    </article>`;
  const marks: SourceMark[] = order.flatMap((l) => l.quotes.map((quote) => ({ n: number(l), quote, at: Math.round(hlAt.get(l) ?? from) })));
  return { html, end: cursor + 300, marks };
}

/**
 * Auto-scroll. The panes follow the edits only at discrete moments: once when each edit (or source
 * highlight) is revealed, scheduled when the scene starts. Never per frame, never from hover or from
 * a scroll event. As soon as the reader wheels, touches, drags or uses the keyboard in either pane,
 * auto-scroll stops for the rest of the scene; it resumes on the next scene or on Play.
 */
let autoScroll = true;
let followTimers: number[] = [];

function scheduleFollow() {
  autoScroll = true;
  if (FROZEN !== null || REDUCED) {
    // One placement for the frame being shown.
    followTimers.forEach((h) => clearTimeout(h));
    followTimers = [];
    for (const pane of [$("src"), $("doc")]) followOnce(pane, sceneTime(), false);
    return;
  }
  rescheduleFollow();
}

/** (Re)schedules the auto-scrolls still ahead in this scene, in wall time at the current speed. */
function rescheduleFollow() {
  followTimers.forEach((h) => clearTimeout(h));
  followTimers = [];
  if (!autoScroll || FROZEN !== null || REDUCED) return;
  const now = sceneTime();
  for (const pane of [$("src"), $("doc")]) {
    const times = [...new Set([...pane.querySelectorAll<HTMLElement>(".chg, .src-hl, .conflict")].map(revealAt))].filter((at) => at >= now - 1).sort((a, b) => a - b);
    for (const at of times) followTimers.push(window.setTimeout(() => followOnce(pane, at, true), clock.wallUntil(at) + 60));
  }
}

const revealAt = (el: HTMLElement) => Number(el.style.getPropertyValue("--d") || 0);

/** Brings the newest item revealed by time t into view, starting at a block boundary. One call. */
function followOnce(pane: HTMLElement, t: number, smooth: boolean) {
  if (!autoScroll) return;
  const items = [...pane.querySelectorAll<HTMLElement>(".chg, .src-hl, .conflict")].filter((el) => revealAt(el) <= t);
  // The most recently revealed item; on a tie, the last in reading order.
  const el = items.reduce<HTMLElement | undefined>((best, x) => (!best || revealAt(x) >= revealAt(best) ? x : best), undefined);
  if (!el) return;
  const pr = pane.getBoundingClientRect();
  const y = (r: DOMRect) => r.top - pr.top + pane.scrollTop;
  const blocks = [...pane.querySelectorAll<HTMLElement>(".page > *")];
  const block = blocks.find((b) => b.contains(el)) ?? el;
  const blockTop = y(block.getBoundingClientRect());
  const want = blockTop + block.offsetHeight + 8;
  const view = pane.clientHeight;
  if (blockTop >= pane.scrollTop && want <= pane.scrollTop + view) return;
  // The smallest scroll that starts at a block boundary and shows the whole block.
  let target = 0;
  for (let i = 0; i < blocks.length; i++) {
    const top = y(blocks[i].getBoundingClientRect());
    const prevBottom = i > 0 ? y(blocks[i - 1].getBoundingClientRect()) + blocks[i - 1].offsetHeight : 0;
    target = i === 0 ? 0 : Math.max(prevBottom, top - 14);
    if (target + view >= want || blocks[i] === block) break;
  }
  if (Math.abs(pane.scrollTop - target) > 2) pane.scrollTo({ top: target, behavior: smooth && !REDUCED ? "smooth" : "auto" });
}

/** Any direct input in a pane hands scrolling to the reader for the rest of the scene. */
function takeControl() {
  autoScroll = false;
  followTimers.forEach((h) => clearTimeout(h));
  followTimers = [];
}
for (const id of ["src", "doc"]) {
  const pane = $(id);
  pane.tabIndex = 0;
  for (const type of ["wheel", "touchstart", "pointerdown", "keydown"] as const) pane.addEventListener(type, takeControl, { passive: true });
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function lintReport(d0: number, animate: boolean): string {
  let d = d0 + 500;
  const seq = (at: number) => (animate ? ` seq" style="--d:${at}` : "");
  const items = RUN.lintBefore.findings.map((f, idx) => {
    const at = d;
    d += 500;
    if (f.kind === "contradiction") {
      const key = f.claims.map((c) => c.key).sort((a, b) => a.length - b.length)[0];
      const onPage = f.claims.some((c) => c.page === "export-retention");
      const rows = f.claims
        .map((c) => `<tr class="${c.source === "src-faq-draft" ? "bad" : ""}"><td>${esc(c.value)}</td><td class="src">${esc(c.source)} · ${c.asOf}</td></tr>`)
        .join("");
      return `<div class="report-item${seq(at)}"${onPage ? ' data-link="1"' : ""}><h3>${onPage ? '<span class="lnum">1</span>' : `<span class="n">${idx + 1}.</span>`}Contradiction in <code>${esc(key)}</code></h3>
        <table class="report-table">${rows}</table>
        <p class="report-note">The draft FAQ disagrees with ${f.claims.length > 2 ? "the 20 April decision" : "the approved design"}${onPage ? "" : `, on <button type="button" data-file="ledger-export" class="text-[var(--accent)]">ledger-export</button>`}. Don't keep the newest value by default: the newest here is the draft's.</p></div>`;
    }
    const target = /\[\[([a-z0-9-]+)\]\]/.exec(f.title)?.[1] ?? "";
    return `<div class="report-item${seq(at)}"><h3><span class="n">${idx + 1}.</span>Missing page: <code>${esc(target)}</code></h3>
      <p class="report-note">${esc(f.detail)} Proposed fix: write the page from what those pages already say.</p></div>`;
  });
  return `<article class="page${animate ? ` seq" style="--d:${d0}` : ""}">
      <h1>Lint report</h1>
      <div class="page-sub">${longDate(FIX.date)} · ${LAST.pages.length} pages · ${LAST.claims.current} current claims</div>
      ${items.join("")}
    </article>`;
}

/** The export-retention page as lint sees it, with the claims that disagree marked. */
function conflictPage(at: number): string {
  const page = LAST.pages.find((p) => p.slug === "export-retention")!;
  const meta = pageMeta(page.text);
  const blocks = trackedBlocks(page.text.split("\n").map((text) => ({ op: "same" as const, text })));
  const conflicting = new Set(RUN.lintBefore.findings.flatMap((f) => f.claims).filter((c) => c.page === "export-retention").map((c) => c.line));
  const body = blocks
    .map((b) => {
      if (b.kind === "h1") return `<h1>${b.html}</h1><div class="page-sub">${cap(meta.type)} · as of ${longDate(meta.updated)} · ${plural(meta.sources, "source")}</div>`;
      const hit = conflicting.has(b.raw);
      return `<div class="b-${b.kind}${hit ? ` conflict seq" style="--d:${at}" data-link="1` : ""}">${hit ? '<span class="gutter"><span class="lnum">1</span></span>' : ""}${b.html}</div>`;
    })
    .join("");
  return `<article class="page seq" style="--d:300">${body}</article>`;
}

/** Pages to flag in lint: pages with conflicting claims, their sources, and the missing page. */
function lintFlags() {
  const nodes = new Set<string>();
  const pairs: [string, string][] = [];
  for (const f of RUN.lintBefore.findings) {
    if (f.kind === "contradiction") {
      f.claims.forEach((c) => {
        nodes.add(c.page);
        nodes.add(c.source);
      });
      const newest = [...f.claims].sort((a, b) => b.asOf.localeCompare(a.asOf))[0];
      for (const c of f.claims) {
        if (c.source !== newest.source && !pairs.some((p) => p[0] === newest.source && p[1] === c.source)) pairs.push([newest.source, c.source]);
      }
    } else if (f.kind === "missing-page") {
      const target = /\[\[([a-z0-9-]+)\]\]/.exec(f.title)?.[1];
      if (target) nodes.add(target);
    }
  }
  return { nodes, pairs };
}

// ---------------------------------------------------------------- the margin: map, index, log

let marginArgs: { step: Step | null; o: { nodeAt?: number; edgeAt?: number; flagAt?: number } } = { step: null, o: {} };

function renderMargin(step: Step | null, o: { nodeAt?: number; edgeAt?: number; flagAt?: number }) {
  marginArgs = { step, o };
  document.querySelectorAll<HTMLElement>(".tab").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.tab === marginTab)));
  const body = $("margin-body");
  if (!step) {
    body.innerHTML = `<p class="caption">The map of pages and links appears with the first page.</p>`;
    return;
  }
  const prev = scene === LINT_SCENE ? null : prevOf(scene);
  if (marginTab !== "map") {
    const text = marginTab === "index" ? step.index : step.log;
    const old = scene === LINT_SCENE ? null : new Set(((marginTab === "index" ? prev?.index : prev?.log) ?? "").split("\n"));
    const lines = text
      .replace(/\n$/, "")
      .split("\n")
      .map((l) => {
        const cls = old && l.trim() && !old.has(l) ? "new" : /^#/.test(l) ? "h" : "";
        return `<div class="${cls}">${esc(l) || "&nbsp;"}</div>`;
      })
      .join("");
    body.innerHTML = `<div class="file">${lines}</div><p class="caption mt-4">${marginTab === "index" ? "Rebuilt after every change. New lines are shaded." : "Append-only. New lines are shaded."}</p>`;
    return;
  }
  const isLint = scene === LINT_SCENE;
  const created = isLint ? new Set<string>() : new Set(step.changes.filter((c) => c.status === "created").map((c) => c.slug));
  const touched = isLint ? new Set<string>() : new Set(step.changes.filter((c) => c.status === "updated").map((c) => c.slug));
  const before = new Set((prev?.graph.edges ?? []).map((e) => edgeKey(e.from, e.to)));
  const newEdges = isLint ? new Set<string>() : new Set(step.graph.edges.map((e) => edgeKey(e.from, e.to)).filter((k) => !before.has(k)));
  const flags = isLint ? lintFlags() : { nodes: new Set<string>(), pairs: [] as [string, string][] };
  const svg = mapSvg(step.graph, RUN.layout, {
    width: 340,
    height: 240,
    created,
    touched,
    newEdges,
    flagged: flags.nodes,
    pairs: flags.pairs,
    nodeAt: o.nodeAt ?? 0,
    edgeAt: o.edgeAt ?? 0,
    flagAt: o.flagAt ?? 0,
    span: 1000,
    fontSize: 10.5,
  });
  const key = isLint
    ? `<span><i style="border:1px solid var(--del)"></i>pages and sources that disagree</span><span><i style="border:1px dashed var(--del)"></i>page that doesn't exist</span>`
    : `<span><i style="background:var(--accent)"></i>created</span><span><i style="border:1.5px solid var(--accent)"></i>revised</span><span><i style="background:var(--muted)"></i>unchanged</span>`;
  body.innerHTML = `${svg}<div class="key caption">${key}</div><p class="caption mt-3">${step.pages.length} pages, ${step.graph.edges.length} links. The map is only an outline; the pages hold the knowledge.</p>`;
}

// ---------------------------------------------------------------- chrome

const CHAPTERS = ["Kickoff", "Design doc", "Incident", "Chat thread", "Draft FAQ"];

function renderChrome() {
  const actOne = scene <= INGESTS.length;
  $("act-num").textContent = actOne ? "Act one" : "Act two";
  $("act-title").textContent = actOne ? "Ingest" : scene === LINT_SCENE ? "Lint" : "Fix";
  const chap = (i: number, label: string) => {
    const state = i < scene ? "done" : i === scene ? "now" : "todo";
    return `<li><button type="button" class="chap" data-scene="${i}" data-state="${state}" ${i === scene ? 'aria-current="step"' : ""}>${label}</button></li>`;
  };
  $("chapters").innerHTML = [
    ...CHAPTERS.map((l, k) => chap(k + 1, l)),
    `<li class="chap-sep" aria-hidden="true">/</li>`,
    chap(LINT_SCENE, "Lint"),
    chap(FIX_SCENE, "Fix"),
    `<li class="chap-sep" aria-hidden="true">/</li>`,
    `<li><a class="chap" href="#payoff">Payoff</a></li>`,
  ].join("");
  ($("prev") as HTMLButtonElement).disabled = scene === 0;
  $("next").textContent = scene === FIX_SCENE ? "See the payoff →" : "Next →";
  renderPlay();
}

/** Runs every CSS animation on the page at the clock's speed. playbackRate keeps each one's position. */
function applyRate() {
  if (FROZEN !== null || REDUCED || !document.getAnimations) return;
  for (const a of document.getAnimations()) a.playbackRate = clock.speed;
}

function setSpeed(speed: number) {
  if (speed === clock.speed) return;
  clock.setSpeed(speed);
  applyRate();
  rescheduleFollow();
  renderSpeed();
  try {
    localStorage.setItem("wiki-memory-speed", String(speed));
  } catch {
    // Storage may be unavailable; the speed still applies for this visit.
  }
}

function renderSpeed() {
  $("speed").innerHTML = SPEEDS.map(
    (s) => `<button type="button" class="speed-opt" data-speed="${s}" aria-pressed="${s === clock.speed}" aria-label="${s}× speed">${s}×</button>`,
  ).join("");
}

function renderPlay() {
  const btn = $("play");
  btn.setAttribute("aria-pressed", String(playing));
  btn.innerHTML = playing
    ? `<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="3" width="3" height="10" rx="0.5"/><rect x="9" y="3" width="3" height="10" rx="0.5"/></svg><span>Pause</span>`
    : `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 2.8v10.4L13 8z"/></svg><span>${REDUCED ? "Step through" : "Play"}</span>`;
}

/** The plain-language lines for the step: one caption, then what the agent did. Static: nothing fades. */
function renderCaption(_beats: Beat[]) {
  let kicker: string;
  let line: string;
  let label = "What the agent did";
  let did: string[] = [];
  if (scene === 0) {
    kicker = "Before the first document";
    line = "The wiki is empty. Five documents are waiting to be read.";
  } else if (scene === LINT_SCENE) {
    kicker = "The check · lint";
    line = FIX.lede;
    label = "What the agent proposes";
    did = FIX.did;
  } else if (scene === FIX_SCENE) {
    kicker = "The fix";
    line = `A person approves the fixes. Lint runs again and finds ${plural(RUN.lintAfter.findings.length, "problem")}.`;
    label = "What was applied";
    did = FIX.did;
  } else {
    const step = INGESTS[scene - 1];
    kicker = `Document ${scene} of ${INGESTS.length} · ${longDate(RUN.sources[scene - 1].date)}`;
    line = step.lede;
    did = step.did;
  }
  $("caption").innerHTML = `<div class="beat-kicker">${esc(kicker)}</div><div class="beat-line">${esc(line)}</div>`;
  $("did").innerHTML = did.length ? `<span class="did-label">${label}</span><ul>${did.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>` : "";
}

// ---------------------------------------------------------------- playback

function tick() {
  const t = sceneTime();
  $("progress").style.width = Number.isFinite(timeline.len) ? `${clamp(t / timeline.len) * 100}%` : "0%";
  if (playing && FROZEN === null && t > timeline.len) {
    if (scene >= FIX_SCENE) {
      playing = false;
      renderPlay();
    } else enter(scene + 1);
  }
}

function next() {
  if (scene >= FIX_SCENE) {
    playing = false;
    renderPlay();
    $("payoff").scrollIntoView({ behavior: REDUCED ? "auto" : "smooth" });
  } else enter(scene + 1);
}

function prev() {
  if (scene > 0) enter(scene - 1);
}

function togglePlay() {
  if (REDUCED) {
    // No autoplay with reduced motion: the button steps, and every step shows its final state.
    started = true;
    next();
    return;
  }
  playing = !playing;
  started = true;
  if (playing) autoScroll = true;
  if (playing && (scene === 0 || (scene === FIX_SCENE && sceneTime() > timeline.len))) enter(1);
  renderPlay();
}

// ---------------------------------------------------------------- wiring

document.addEventListener("click", (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-scene], [data-file], [data-tab], [data-speed], #play, #next, #prev, #theme");
  if (!el) return;
  if (el.dataset.speed) {
    setSpeed(Number(el.dataset.speed));
    return;
  }
  if (el.id === "play") togglePlay();
  else if (el.id === "next" || el.id === "prev") {
    playing = false;
    started = true;
    if (el.id === "next") next();
    else prev();
    renderPlay();
  } else if (el.id === "theme") toggleTheme();
  else if (el.dataset.scene) {
    playing = false;
    started = true;
    enter(Number(el.dataset.scene));
  } else if (el.dataset.file) {
    playing = false;
    renderPlay();
    openFile(el.dataset.file);
  } else if (el.dataset.tab) {
    playing = false;
    renderPlay();
    marginTab = el.dataset.tab as typeof marginTab;
    renderMargin(marginArgs.step, {});
  }
});

function openFile(slug: string) {
  const step = stepFor(scene);
  if (!step) return;
  const change = step.changes.find((c) => c.slug === slug);
  if (!change) return;
  docFile = slug;
  const { html, marks } = pageHtml(step, change, 0, 100);
  $("doc").innerHTML = html;
  applyRate();
  $("doc-path").textContent = `wiki/${change.path}`;
  $("doc-label").textContent = change.status === "created" ? "New wiki page" : "Wiki page · tracked changes";
  if (scene !== FIX_SCENE) {
    const raw = RUN.sources.find((s) => s.file === step.source)!;
    $("src").innerHTML = `<div class="page">${sourceHtml(raw.text, marks)}</div>`;
  }
  $("src").scrollTop = 0;
  $("doc").scrollTop = 0;
}

document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const r = $("theatre").getBoundingClientRect();
  if (r.bottom < innerHeight * 0.3 || r.top > innerHeight * 0.7) return;
  // Keys inside a focused pane scroll that pane; they never step scenes or toggle play.
  if ((e.target as HTMLElement).closest(".doc")) return;
  if (e.key === "ArrowRight") {
    playing = false;
    next();
  } else if (e.key === "ArrowLeft") {
    playing = false;
    prev();
  } else if (e.key === " " && !(e.target as HTMLElement).closest("button, a")) {
    e.preventDefault();
    togglePlay();
  }
});

// Hover or tap a numbered passage or edit to highlight both ends of the link.
function linkOf(el: EventTarget | null): string | null {
  const host = (el as HTMLElement | null)?.closest?.<HTMLElement>("[data-link]");
  return host?.dataset.link?.split(" ")[0] ?? null;
}
let hotLink: string | null = null;
/** Highlights both ends of a link by toggling a class on existing nodes. Never scrolls. */
function highlightLink(n: string | null) {
  if (n === hotLink) return;
  hotLink = n;
  document.querySelectorAll(".hot").forEach((el) => el.classList.remove("hot"));
  if (n) document.querySelectorAll(`[data-link~="${n}"]`).forEach((el) => el.classList.add("hot"));
}
document.addEventListener("pointerover", (e) => highlightLink(linkOf(e.target)));
document.addEventListener("click", (e) => {
  const n = linkOf(e.target);
  if (!n) return;
  highlightLink(n);
  // On tap, bring the other end into view inside the other pane, once. This is reader input, so
  // auto-scroll stops; the scrolled pane does nothing in response.
  takeControl();
  const from = (e.target as HTMLElement).closest(".doc");
  for (const pane of [$("src"), $("doc")]) {
    if (pane === from) continue;
    const el = pane.querySelector<HTMLElement>(`[data-link~="${n}"]`);
    if (el) pane.scrollTo({ top: Math.max(0, el.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop - 40), behavior: REDUCED ? "auto" : "smooth" });
  }
});

function renderThemeLabel() {
  $("theme").textContent = root.dataset.theme === "dark" ? "Light" : "Dark";
}

function toggleTheme() {
  root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
  try {
    localStorage.setItem("wiki-memory-theme", root.dataset.theme);
  } catch {
    // Storage may be unavailable; the theme still applies for this visit.
  }
  renderThemeLabel();
}

// Autoplay starts once, when the walkthrough is half in view (never with reduced motion).
const io = new IntersectionObserver(
  (entries) => {
    for (const en of entries) {
      if (en.intersectionRatio >= 0.5 && !started && FROZEN === null) {
        started = true;
        if (REDUCED) enter(1);
        else {
          playing = true;
          enter(1);
        }
      }
    }
  },
  { threshold: [0, 0.5] },
);
io.observe($("theatre"));

// ---------------------------------------------------------------- start

renderProblem();
renderPayoff();
renderSpeed();
renderThemeLabel();
if (params.has("scene")) started = true;
const fileParam = params.get("file");
if (fileParam === "@index" || fileParam === "@log") marginTab = fileParam === "@index" ? "index" : "log";
enter(params.has("scene") ? Number(params.get("scene")) || 0 : 0);
if (fileParam && !fileParam.startsWith("@")) openFile(fileParam);
if (params.get("play") === "1" && !REDUCED) {
  started = true;
  playing = true;
  renderPlay();
}
// Review hooks: ?only=<section id> (or ?solo with ?scene) shows one section, so screenshots start at its top.
const only = params.get("only") ?? (params.has("solo") && params.has("scene") ? "theatre" : null);
if (only && document.getElementById(only)) for (const sec of document.querySelectorAll("main > section")) (sec as HTMLElement).hidden = sec.id !== only;
else if (params.has("scene")) {
  root.style.scrollBehavior = "auto";
  $("theatre").scrollIntoView();
  root.style.scrollBehavior = "";
}
applyRate();
if (FROZEN === null && !REDUCED) setInterval(tick, 100);
