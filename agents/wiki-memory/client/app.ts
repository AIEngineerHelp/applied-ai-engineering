// The app: an opening figure, then the story in scenes, then the face-off. All data comes from
// results/run.json (built by `npm run data`); this file only presents it.
//   Act one  - each source is a scene: the page it changes most is typeset with tracked changes,
//              then the small map shows the pages and links it added
//   Act two  - lint finds the contradictions; the fix resolves them
//   Act three- the face-off: wiki pages against chunk RAG, verdict last
// Motion is CSS with per-element delays (--d, ms). ?t=<ms> freezes every animation at that moment.

import runJson from "../results/run.json" with { type: "json" };
import type { Change as PageChange, QuestionResult, Run, Step } from "../src/build.ts";
import type { FactResult } from "../src/retrieve.ts";
import { inline, pageMeta, parseClaim, trackedBlocks, type Block } from "./doc.ts";
import { edgeKey, mapSvg } from "./map.ts";
import { esc } from "./render.ts";

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

// ---------------------------------------------------------------- opening figure

function renderHero() {
  const g = FIX.graph;
  $("hero-map").innerHTML = mapSvg(g, RUN.layout, {
    width: 640,
    height: 430,
    appear: new Set(g.nodes.map((n) => n.id)),
    newEdges: new Set(g.edges.map((e) => edgeKey(e.from, e.to))),
    labelAll: true,
    nodeAt: 300,
    edgeAt: 1300,
    span: 1100,
    fontSize: 12,
  });
}

// ---------------------------------------------------------------- the story

let scene = 0;
let playing = false;
let started = false;
let sceneStart = performance.now();
let docFile: string | null = null;
let marginTab: "map" | "index" | "log" = "map";
let timeline = { len: Infinity };

const sceneTime = () => (FROZEN !== null ? FROZEN : REDUCED ? 1e7 : performance.now() - sceneStart);

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
  sceneStart = performance.now();
  docFile = null;
  renderChrome();
  const { beats, len } = renderScene();
  timeline = { len };
  renderCaption(beats);
  tick();
}

/** Renders the document and the map for the scene, and returns its subtitles and length. */
function renderScene(): { beats: Beat[]; len: number } {
  const doc = $("doc");
  const note = $("doc-note");
  if (scene === 0) {
    doc.innerHTML = `<article class="page seq" style="--d:0">
        <div class="page-path">wiki/</div>
        <h1>An empty wiki</h1>
        <div class="b-p">Five raw sources about one small project are waiting: kickoff notes, a design document, an incident report, a chat thread and a draft FAQ.</div>
        <div class="b-p">Press play. For each source, the agent writes a page about it and revises the pages about every person, system and policy it mentions. Each revision appears here as tracked changes: <ins>added words</ins>, <del>removed words</del>, and old values struck through rather than deleted.</div>
      </article>`;
    note.textContent = "";
    renderMargin(null, {});
    return { beats: [{ at: 0, kicker: "Before the first source", line: "The wiki is empty. Five sources are waiting to be filed." }], len: Infinity };
  }

  if (scene === LINT_SCENE) {
    const d0 = 300;
    doc.innerHTML = lintReport(d0);
    note.textContent = "Findings computed by src/lint.ts from the pages above.";
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
  const { html, end } = pageHtml(step, change, 300, 900);
  doc.innerHTML = html;
  scrollToChanges();
  note.textContent = "Page text written by hand. Tracked changes, links and counts computed from it.";
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
      { at: 0, kicker: `Source ${scene} of ${INGESTS.length} · ${longDate(RUN.sources[scene - 1].date)}`, line: `<em>${esc(step.title)}</em> arrives. The agent reads it and starts editing.` },
      { at: mapAt, kicker: "Ingest · computed", line: countLine },
      { at: last, kicker: "What changed", line: esc(step.caption) },
    ],
    len: last + 5200,
  };
}

/** A wiki page typeset with tracked changes. Changed blocks reveal one at a time from `from`. */
function pageHtml(step: Step, change: PageChange, docAt: number, from: number): { html: string; end: number } {
  const page = step.pages.find((p) => p.slug === change.slug)!;
  const meta = pageMeta(page.text);
  const isNew = change.status === "created";
  const blocks = trackedBlocks(change.diff);
  const changed = blocks.filter((b) => b.change !== "same").length;
  const stagger = isNew ? Math.min(110, 1100 / Math.max(changed, 1)) : Math.min(420, 1200 / Math.max(changed, 1));
  let k = 0;
  const render = (b: Block) => {
    const at = b.change === "same" ? 0 : Math.round(from + k++ * stagger);
    const change = isNew && b.change === "ins" ? "new" : b.change;
    const cls = `b-${b.kind}${b.change === "same" ? "" : ` chg chg-${change}`}`;
    const style = b.change === "same" ? "" : ` style="--d:${at}"`;
    if (b.kind === "h1") {
      return `<h1 class="${cls}"${style}>${b.html}</h1><div class="page-sub${b.change === "same" ? "" : " chg"}"${style}>${cap(meta.type)} · ${isNew ? "new page" : `revised ${longDate(meta.updated)}`} · ${plural(meta.sources || 1, "source")}</div>`;
    }
    return `<div class="${cls}"${style}>${b.html}</div>`;
  };
  const others = step.changes
    .map((c) => `<button type="button" data-file="${c.slug}" ${c.slug === change.slug ? 'aria-current="true"' : ""}>${esc(c.slug)}</button>`)
    .join(", ");
  const html = `<article class="page seq" style="--d:${docFile === null ? docAt : 0}">
      <div class="page-path">wiki/${esc(change.path)}</div>
      ${blocks.map(render).join("")}
      <div class="page-foot">This ${scene === FIX_SCENE ? "fix" : "source"} changed ${plural(step.changes.length, "page")}: ${others}.</div>
    </article>`;
  return { html, end: from + Math.max(0, k - 1) * stagger + 600 };
}

/** Scrolls the page so its tracked changes are in view. */
function scrollToChanges() {
  const doc = $("doc");
  const changed = doc.querySelectorAll<HTMLElement>(".chg");
  if (!changed.length) return;
  const top = (el: HTMLElement) => el.getBoundingClientRect().top - doc.getBoundingClientRect().top + doc.scrollTop;
  const first = top(changed[0]);
  const lastEl = changed[changed.length - 1];
  const lastBottom = top(lastEl) + lastEl.offsetHeight;
  // Prefer the last change (often the struck-through value); keep the first in view when both fit.
  const toLast = lastBottom - doc.clientHeight + 40;
  doc.scrollTop = Math.max(0, toLast <= first - 60 ? first - 60 : toLast);
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function lintReport(d0: number): string {
  let d = d0 + 500;
  const items = RUN.lintBefore.findings.map((f, idx) => {
    const at = d;
    d += 500;
    if (f.kind === "contradiction") {
      const key = f.claims.map((c) => c.key).sort((a, b) => a.length - b.length)[0];
      const rows = f.claims
        .map((c) => `<tr class="${c.source === "src-faq-draft" ? "bad" : ""}"><td>${esc(c.value)}</td><td class="src">${esc(c.source)} · ${c.asOf}</td></tr>`)
        .join("");
      return `<div class="report-item seq" style="--d:${at}"><h3><span class="n">${idx + 1}.</span>Contradiction in <code>${esc(key)}</code></h3>
        <table class="report-table">${rows}</table>
        <p class="report-note">The draft FAQ disagrees with ${f.claims.length > 2 ? "the 20 April decision" : "the approved design"}. Don't keep the newest value by default: the newest here is the draft's.</p></div>`;
    }
    const target = /\[\[([a-z0-9-]+)\]\]/.exec(f.title)?.[1] ?? "";
    return `<div class="report-item seq" style="--d:${at}"><h3><span class="n">${idx + 1}.</span>Missing page: <code>${esc(target)}</code></h3>
      <p class="report-note">${esc(f.detail)} Proposed fix: write the page from what those pages already say.</p></div>`;
  });
  return `<article class="page seq" style="--d:${d0}">
      <div class="page-path">lint report</div>
      <h1>Lint report</h1>
      <div class="page-sub">${longDate(FIX.date)} · ${LAST.pages.length} pages · ${LAST.claims.current} current claims</div>
      ${items.join("")}
    </article>`;
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
    `<li><a class="chap" href="#faceoff">Face-off</a></li>`,
  ].join("");
  $("queue").innerHTML = RUN.sources
    .map((s, k) => {
      const n = k + 1;
      const state = scene > INGESTS.length || n < scene ? "done" : n === scene ? "now" : "todo";
      return `<li><button type="button" class="qitem" data-scene="${n}" data-state="${state}"><span class="qt">${esc(INGESTS[k].title)}</span><span class="qd">${s.date}</span></button></li>`;
    })
    .join("");
  ($("prev") as HTMLButtonElement).disabled = scene === 0;
  $("next").textContent = scene === FIX_SCENE ? "Face-off →" : "Next →";
  renderPlay();
}

function renderPlay() {
  $("play").textContent = playing ? "Pause" : "Play";
}

function renderCaption(beats: Beat[]) {
  $("caption").innerHTML = beats
    .map((b, i) => {
      const end = beats[i + 1]?.at;
      return `<div class="beat" style="--d:${b.at};${end !== undefined ? `--e:${end - 200}` : ""}"><div class="beat-kicker">${b.kicker}</div><div class="beat-line">${b.line}</div></div>`;
    })
    .join("");
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
    $("faceoff").scrollIntoView({ behavior: REDUCED ? "auto" : "smooth" });
  } else enter(scene + 1);
}

function prev() {
  if (scene > 0) enter(scene - 1);
}

function togglePlay() {
  playing = !playing;
  started = true;
  if (playing && (scene === 0 || (scene === FIX_SCENE && sceneTime() > timeline.len))) enter(1);
  renderPlay();
}

// ---------------------------------------------------------------- the face-off

let question = RUN.questions.some((q) => q.id === params.get("ask")) ? params.get("ask")! : RUN.questions[0].id;

function renderQuestions() {
  $("questions").innerHTML = RUN.questions
    .map((q) => `<button type="button" role="tab" class="qtab" data-q="${q.id}" aria-selected="${q.id === question}">${esc(q.text)}</button>`)
    .join("");
}

/** Inline markdown with fact matches marked: green for what the answer needs, red for what misleads. */
function marked(raw: string, facts: FactResult[]): string {
  const res = facts.map((f) => ({ re: new RegExp(f.pattern, "i"), tone: f.kind === "needed" ? "good" : "bad" }));
  let out = "";
  let rest = raw;
  for (;;) {
    let best: { i: number; len: number; tone: string } | null = null;
    for (const r of res) {
      const m = r.re.exec(rest);
      if (m && (!best || m.index < best.i)) best = { i: m.index, len: m[0].length, tone: r.tone };
    }
    if (!best || best.len === 0) break;
    out += inline(rest.slice(0, best.i)) + `<mark class="${best.tone}">${inline(rest.slice(best.i, best.i + best.len))}</mark>`;
    rest = rest.slice(best.i + best.len);
  }
  return out + inline(rest);
}

/** One line of a wiki page in an excerpt. Claims read as plain text, so marks never split a code span. */
function excerptLine(text: string, struck: boolean, facts: FactResult[]): string {
  const c = parseClaim(text);
  if (!c) return marked(text.replace(/^- /, ""), facts);
  const plain = `${c.key}: ${c.value}`;
  const meta = `<span class="caption"> · as of ${c.asOf}, ${esc(c.source)}${c.note ? `, ${esc(c.note.replace(/\[\[|\]\]/g, ""))}` : ""}</span>`;
  return struck ? `<s>${esc(plain)}</s>${meta}` : `${marked(plain, facts)}${meta}`;
}

const neededOf = (f: FactResult[]) => f.filter((x) => x.kind === "needed");
const wrongFound = (f: FactResult[]) => f.filter((x) => x.kind === "wrong" && x.found).length;

function renderFaceoff() {
  const q = RUN.questions.find((x) => x.id === question)!;
  // Excerpts alternate sides, one at a time; the tallies follow; the verdict comes last.
  const order: string[] = [];
  for (let i = 0; i < Math.max(q.wiki.length, q.rag.length); i++) {
    if (i < q.wiki.length) order.push(`w${i}`);
    if (i < q.rag.length) order.push(`r${i}`);
  }
  const at = (id: string) => 250 + order.indexOf(id) * 260;
  const tallyAt = 250 + order.length * 260 + 150;
  $("arena").innerHTML = side(q, "wiki", at, tallyAt) + side(q, "rag", at, tallyAt + 200);
  $("verdict").innerHTML = verdictHtml(q, tallyAt + 900);
}

function side(q: QuestionResult, which: "wiki" | "rag", at: (id: string) => number, tallyAt: number): string {
  const facts = which === "wiki" ? q.wikiFacts : q.ragFacts;
  const need = neededOf(facts);
  const found = need.filter((f) => f.found).length;
  const bad = wrongFound(facts);
  const excerpts =
    which === "wiki"
      ? q.wiki
          .map((p, i) => {
            const res = facts.map((f) => new RegExp(f.pattern, "i"));
            const lines = p.lines.filter((l) => l.struck || res.some((r) => r.test(l.text)));
            const shown = (lines.length ? lines : p.lines.filter((l) => !l.text.startsWith("#")).slice(0, 2)).slice(0, 6);
            const title = p.lines.find((l) => l.text.startsWith("# "))?.text.slice(2) ?? "";
            return `<div class="excerpt seq" style="--d:${at(`w${i}`)}">
              <div class="excerpt-head"><span>wiki/${esc(p.path)}</span><span>BM25 ${p.score.toFixed(2)}</span></div>
              <div class="excerpt-sub">${esc(title)}</div>
              <div class="excerpt-body">${shown.map((l) => `<p>${excerptLine(l.text, l.struck, facts)}</p>`).join("")}</div>
            </div>`;
          })
          .join("")
      : q.rag
          .map((c, i) => {
            const wrong = facts.filter((f) => f.kind === "wrong" && f.where.includes(c.id));
            const title = RUN.sources.find((s) => s.file === c.file)?.title ?? "";
            return `<div class="excerpt seq" style="--d:${at(`r${i}`)}" data-bad="${wrong.length > 0}">
              <div class="excerpt-head"><span>raw/${esc(c.file)}</span><span>BM25 ${c.score.toFixed(2)}</span></div>
              <div class="excerpt-sub">${esc(title)}${c.heading ? ` › ${esc(c.heading)}` : ""}</div>
              <div class="excerpt-body">${c.text
                .split("\n")
                .map((l) => `<p>${marked(l, facts)}</p>`)
                .join("")}</div>
              ${wrong.length ? `<p class="excerpt-note">Outdated: ${wrong.map((w) => esc(w.why ?? "")).join("; ")}.</p>` : ""}
            </div>`;
          })
          .join("");
  const factRows = facts
    .filter((f) => f.kind === "needed" || f.found)
    .map((f) => {
      const ok = f.kind === "needed" && f.found;
      return `<div class="fact" data-ok="${ok}"><b>${ok ? "✓" : "✕"}</b><span>${esc(f.kind === "needed" && !f.found ? `${f.label} (missing)` : f.label)}${f.kind === "wrong" && f.why ? `<small>${esc(f.why)}</small>` : ""}</span></div>`;
    })
    .join("");
  const answer =
    which === "wiki"
      ? `<div class="answer seq" style="--d:${tallyAt + 200}">${esc(q.wikiAnswer)}<p class="caption mt-2">Example answer from these pages, written by hand.</p></div>`
      : "";
  return `<div class="side">
    <h3 class="side-name">${which === "wiki" ? "Wiki memory" : "Chunk RAG"}</h3>
    <p class="caption side-how">${which === "wiki" ? `Top ${RUN.k.pages} topic pages, ranked by BM25` : `Top ${RUN.k.chunks} of ${RUN.chunkCount} raw paragraph chunks, ranked by BM25`}</p>
    ${excerpts}
    <div class="tally seq" style="--d:${tallyAt}">
      <div class="tally-line"><span class="num">${found} of ${need.length}</span> facts the answer needs · <span class="num" style="color:${bad ? "var(--del)" : "inherit"}">${bad}</span> outdated</div>
      <div class="facts">${factRows}</div>
    </div>
    ${answer}
  </div>`;
}

function verdictHtml(q: QuestionResult, at: number): string {
  const total = neededOf(q.wikiFacts).length;
  const rNeed = neededOf(q.ragFacts).filter((f) => f.found).length;
  const rWrong = wrongFound(q.ragFacts);
  let line: string;
  let sub: string;
  if (rWrong > 0) {
    line = `Both found the answer. Chunk RAG also brought back <em>${plural(rWrong, "outdated statement")}</em>, with nothing to say which is current.`;
    sub = "The model has to sort that out on every question. The wiki sorted it out once, when the sources were filed.";
  } else if (rNeed < total) {
    line = `The wiki pages hold all ${total} facts; the top chunks hold ${rNeed}.`;
    sub = "A page gathers facts that are spread across several sources.";
  } else {
    line = `A draw. When one source holds the whole answer, <em>chunk RAG is enough</em>.`;
    sub = "Wiki memory pays off when sources change or disagree. For a single-source lookup it adds upkeep without a better answer.";
  }
  return `<p class="eyebrow seq" style="--d:${at}">Verdict · computed</p><p class="verdict-line seq" style="--d:${at + 100}">${line}</p><p class="verdict-sub seq" style="--d:${at + 300}">${sub}</p>`;
}

// ---------------------------------------------------------------- wiring

document.addEventListener("click", (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-scene], [data-file], [data-q], [data-tab], #play, #next, #prev, #cta, #theme");
  if (!el) return;
  if (el.id === "play") togglePlay();
  else if (el.id === "next") next();
  else if (el.id === "prev") prev();
  else if (el.id === "cta") {
    $("theatre").scrollIntoView({ behavior: REDUCED ? "auto" : "smooth" });
    started = true;
    playing = true;
    setTimeout(() => enter(1), REDUCED ? 0 : 500);
  } else if (el.id === "theme") toggleTheme();
  else if (el.dataset.scene) {
    playing = false;
    started = true;
    enter(Number(el.dataset.scene));
  } else if (el.dataset.file) {
    openFile(el.dataset.file);
  } else if (el.dataset.tab) {
    marginTab = el.dataset.tab as typeof marginTab;
    renderMargin(marginArgs.step, {});
  } else if (el.dataset.q) {
    question = el.dataset.q;
    renderQuestions();
    renderFaceoff();
  }
});

function openFile(slug: string) {
  const step = stepFor(scene);
  if (!step) return;
  const change = step.changes.find((c) => c.slug === slug);
  if (!change) return;
  docFile = slug;
  $("doc").innerHTML = pageHtml(step, change, 0, 100).html;
  scrollToChanges();
}

document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const r = $("theatre").getBoundingClientRect();
  if (r.bottom < innerHeight * 0.3 || r.top > innerHeight * 0.7) return;
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

let faceoffShown = false;
const io = new IntersectionObserver(
  (entries) => {
    for (const en of entries) {
      if (en.target.id === "theatre" && en.intersectionRatio >= 0.5 && !started && FROZEN === null) {
        started = true;
        playing = true;
        enter(1);
      }
      if (en.target.id === "faceoff" && en.isIntersecting && !faceoffShown) {
        faceoffShown = true;
        renderFaceoff();
      }
    }
  },
  { threshold: [0, 0.5] },
);
["theatre", "faceoff"].forEach((id) => io.observe($(id)));

// ---------------------------------------------------------------- start

$("about-chunks").textContent = String(RUN.chunkCount);
renderThemeLabel();
renderHero();
renderQuestions();
if (params.has("scene")) started = true;
const fileParam = params.get("file");
if (fileParam === "@index" || fileParam === "@log") marginTab = fileParam === "@index" ? "index" : "log";
enter(params.has("scene") ? Number(params.get("scene")) || 0 : 0);
if (fileParam && !fileParam.startsWith("@")) openFile(fileParam);
if (params.has("ask")) {
  faceoffShown = true;
  renderFaceoff();
}
const jump = params.has("ask") ? "faceoff" : params.has("scene") ? "theatre" : null;
// Review hook: ?solo shows only the section being reviewed, so headless screenshots start at its top.
if (jump && params.has("solo")) for (const id of ["hero", "theatre", "faceoff", "about"]) if (id !== jump) $(id).hidden = true;
if (jump && !params.has("solo")) {
  root.style.scrollBehavior = "auto";
  $(jump).scrollIntoView();
  root.style.scrollBehavior = "";
}
if (FROZEN === null && !REDUCED) setInterval(tick, 100);
