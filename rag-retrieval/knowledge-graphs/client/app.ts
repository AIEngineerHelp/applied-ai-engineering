// The page: an opening, then a stage with three chapters (extract, merge,
// ask). engine.ts draws the graph; scenes.ts stages each chapter as a
// timeline; src/ computes everything that is shown.
//
// URL hooks: ?scene=hero|extract|merge|ask, &doc=<id>, &q=<id>, &k=3|5,
// &t=<seconds> freezes the scene at that moment (for screenshots),
// &theme=light|dark.

import { DOCUMENTS, EXTRACTIONS, QUESTIONS } from "../src/data.ts";
import { buildGraph, sentence, type Hop } from "../src/graph.ts";
import { chunkDocuments, docText, TfIdfIndex } from "../src/retrieve.ts";
import { compare } from "../src/compare.ts";
import { pieces } from "../src/spans.ts";
import { ENTITY_TYPES } from "../src/schema.ts";
import LAYOUT from "../data/layout.json" with { type: "json" };
import { Engine, HOME, SHAPES, type Palette, type Rect } from "./engine.ts";
import { askScene, extractScene, heroScene, litBy, mergeScene, type Scene } from "./scenes.ts";
import { Sequence } from "./timeline.ts";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const layout = LAYOUT as Record<string, number[]>;
const glyph = (type: string) => SHAPES[type]?.glyph ?? "●";

const graph = buildGraph(EXTRACTIONS);
const index = new TfIdfIndex(chunkDocuments(DOCUMENTS));
const nameOf = (id: string) => graph.nodes.get(id)!.name;
const typeOf = (id: string) => graph.nodes.get(id)!.type;
const titleOf = (doc: string) => DOCUMENTS.find((d) => d.id === doc)!.title;

const params = new URLSearchParams(location.search);
const tParam = params.has("t") ? Number(params.get("t")) : null;
const sceneParam = params.get("scene") ?? "hero";
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

type Chapter = "extract" | "merge" | "ask";
const state = {
  chapter: "extract" as Chapter,
  doc: DOCUMENTS[0].id,
  added: [] as string[],
  question: QUESTIONS[0].id,
  k: Number(params.get("k")) === 5 ? 5 : 3,
  heroActive: true,
};

const engine = new Engine($("back") as HTMLCanvasElement, $("front") as HTMLCanvasElement, graph, layout);
engine.reduced = reduced;
engine.frozen = tParam !== null;
function readPalette() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string) => cs.getPropertyValue(n).trim();
  engine.palette = { paper: v("--paper"), ink: v("--ink"), grey: v("--grey"), faint: v("--faint"), rule: v("--rule"), accent: v("--accent") } as Palette;
}
readPalette();

const frozenFor = (scene: string) => (tParam !== null && sceneParam === scene ? tParam : null);
const start = (s: Scene) => {
  if (reduced && tParam === null) s.seq.skip();
  return s;
};
let hero = start(heroScene(graph, layout, frozenFor("hero")));
let stage: Scene = idle();

function idle(): Scene {
  return {
    seq: new Sequence(0, [{ at: 0, caption: "" }]),
    frame: () => {
      const { nodes, edges } = litBy(graph, state.added);
      return { nodes: new Map([...nodes].map((id) => [id, { lit: 1 }])), edges: new Map([...edges].map((id) => [id, { draw: 1 }])), ghost: 1, labels: [], camera: { ...HOME } };
    },
  };
}

$("legend").innerHTML = ENTITY_TYPES.map((t) => `<li><b>${glyph(t)}</b>${t}</li>`).join("");

// --- Chapters ------------------------------------------------------------------

function setChapter(c: Chapter, opts: { scroll?: boolean } = {}) {
  state.chapter = c;
  document.querySelectorAll<HTMLElement>("[data-chapter]").forEach((b) => b.setAttribute("aria-current", String(b.dataset.chapter === c)));
  engine.userCamera = null;
  $("faceoff").className = "faceoff pointer-events-auto";
  if (c === "extract") renderExtract();
  if (c === "merge") renderMerge();
  if (c === "ask") renderAsk();
  if (opts.scroll) $("stage").scrollIntoView({ behavior: reduced || tParam !== null ? "auto" : "smooth" });
}

// --- 1 Extract -------------------------------------------------------------------

function renderExtract() {
  $("panel").innerHTML = `
    <p class="kicker">Chapter 1</p>
    <h2 class="scene-title mt-2">Extract</h2>
    <p class="scene-lede">Pick a document. The extractor marks the entities in it, and each one becomes a node. A name it has seen before in another form joins that node.</p>
    <p class="note mt-2">Extraction results are hand-written fixtures in the format an LLM returns.</p>
    <div id="docs" class="doclist"></div>
    <article id="doc" class="doc mt-7"></article>
    <div class="mt-6"><p class="label">Relations</p><ul id="rels"></ul></div>
    <div id="fusions" class="mt-5"></div>
    <div class="mt-8"><button id="next-doc" type="button" class="btn-ink"></button></div>`;
  renderDocButtons();
  playDoc(state.doc);
  $("next-doc").addEventListener("click", () => {
    const next = DOCUMENTS.find((d) => !state.added.includes(d.id));
    if (next) playDoc(next.id);
    else setChapter("merge");
  });
}

function renderDocButtons() {
  const docs = document.getElementById("docs");
  if (!docs) return;
  docs.innerHTML = DOCUMENTS.map(
    (d) => `<button type="button" class="docrow" data-doc="${d.id}" aria-pressed="${d.id === state.doc}"><span class="kind">${esc(d.kind)}</span><span>${esc(d.title)}</span>${state.added.includes(d.id) ? '<span class="done">read</span>' : ""}</button>`,
  ).join("");
  const next = DOCUMENTS.find((d) => !state.added.includes(d.id));
  const btn = document.getElementById("next-doc");
  if (btn) btn.textContent = next ? `Next: ${next.title}` : "Continue to Merge";
}

function playDoc(docId: string) {
  state.doc = docId;
  const prior = state.added.filter((d) => d !== docId);
  if (!state.added.includes(docId)) state.added.push(docId);
  const doc = DOCUMENTS.find((d) => d.id === docId)!;
  const x = EXTRACTIONS.find((e) => e.document === docId)!;
  const types = new Map(x.entities.map((e) => [e.name, e.type]));
  const html = pieces(docText(doc), x)
    .map((pc) => {
      const t = esc(pc.text).replace(/\n\n/g, "</p><p>");
      return pc.entity ? `<span class="ent" data-name="${esc(pc.entity)}" data-glyph="${glyph(types.get(pc.entity)!)}">${t}</span>` : t;
    })
    .join("");
  $("doc").innerHTML = `<p class="!opacity-100 text-[11.5px] text-[var(--faint)]">${esc(doc.kind)}</p>
    <h3 class="serif mt-1 text-[22px] leading-snug">${esc(doc.title)}</h3>
    <div class="body mt-3 space-y-3 text-[15px] leading-[1.75] text-[var(--ink-2)]"><p>${html}</p></div>`;
  const ename = (n: string) => `<span class="ename text-[var(--ink)]" data-glyph="${glyph(types.get(n)!)}">${esc(n)}</span>`;
  $("rels").innerHTML = x.relations
    .map((r) => `<li class="rel">${ename(r.source)}<span class="rtype">${r.type}</span>${ename(r.target)}${r.properties ? `<span class="rtype">{${esc(Object.entries(r.properties).map(([k, v]) => `${k}: ${v}`).join(", "))}}</span>` : ""}</li>`)
    .join("");
  const paras = () => [...$("doc").querySelectorAll<HTMLElement>(".body > p")];
  const spans = new Map<string, HTMLElement[]>();
  $("doc").querySelectorAll<HTMLElement>(".ent").forEach((s) => spans.set(s.dataset.name!, [...(spans.get(s.dataset.name!) ?? []), s]));
  const scene = extractScene(
    graph,
    engine,
    docId,
    prior,
    {
      spanRect: (n) => spans.get(n)?.[0]?.getBoundingClientRect() ?? null,
      setSpanState: (n, st) => spans.get(n)?.forEach((s) => (s.className = `ent ${st === "idle" ? "" : st}`)),
      setParagraphs: (v) => paras().forEach((p, i) => p.classList.toggle("in", i < v)),
      setRelations: (v) => $("rels").querySelectorAll("li").forEach((li, i) => li.classList.toggle("in", i < v)),
    },
    frozenFor("extract"),
  );
  $("fusions").innerHTML = scene.fusions.length
    ? `<p class="label">Entity resolution</p>` +
      scene.fusions.map((f) => `<p class="py-0.5 text-[12.5px] text-[var(--ink-2)]">${ename(f.alias)} <span class="text-[var(--faint)]">→</span> <span class="text-[var(--ink)]">${esc(f.canonical)}</span> <span class="note">· ${f.reason}</span></p>`).join("") +
      `<p class="note mt-1">Resolution is computed by src/resolve.ts.</p>`
    : "";
  stage = start(scene);
  renderDocButtons();
}

// --- 2 Merge ---------------------------------------------------------------------

function renderMerge() {
  const groups = [...graph.nodes.values()].filter((e) => e.aliases.length);
  const names = EXTRACTIONS.reduce((s, x) => s + x.entities.length, 0);
  const rels = EXTRACTIONS.reduce((s, x) => s + x.relations.length, 0);
  $("panel").innerHTML = `
    <p class="kicker">Chapter 2</p>
    <h2 class="scene-title mt-2">Merge</h2>
    <p class="scene-lede">The extractor reads one document at a time, so one supplier comes back as “Varnell Semi”, “Varnell” and “Varnell Semiconductor”. Entity resolution merges names of the same type that are equal after normalizing, or where each word of the shorter name starts the matching word of the longer one. Numbers must match exactly, and a name that could fit two entities is left alone.</p>
    <dl class="mt-7 grid grid-cols-2 border-y border-[var(--rule)] py-4">
      <div><dt class="label !mb-1">Names → entities</dt><dd class="serif text-[28px]">${names} → ${graph.nodes.size}</dd></div>
      <div><dt class="label !mb-1">Relations → edges</dt><dd class="serif text-[28px]">${rels} → ${graph.edges.length}</dd></div>
    </dl>
    <ul class="mt-5 grid gap-2">${groups
      .map((g) => `<li class="text-[13px] text-[var(--ink-2)]">${g.aliases.map((a) => `“${esc(a)}”`).join(", ")} <span class="text-[var(--faint)]">→</span> <span class="text-[var(--ink)]">${glyph(g.type)} ${esc(g.name)}</span> <span class="note">· ${g.merges[0].reason}</span></li>`)
      .join("")}</ul>
    <p class="mt-5 text-[13px] leading-relaxed text-[var(--grey)]">Two relations were stated in two documents each, so each became one edge with two pieces of evidence.</p>
    <p class="note mt-2">All of this is computed by src/resolve.ts and src/graph.ts.</p>
    <div class="mt-8"><button id="to-ask" type="button" class="btn-ink">Continue to Ask</button></div>`;
  $("to-ask").addEventListener("click", () => setChapter("ask"));
  state.added = DOCUMENTS.map((d) => d.id);
  stage = start(mergeScene(graph, engine, layout, frozenFor("merge")));
}

// --- 3 Ask --------------------------------------------------------------------------

function renderAsk() {
  state.added = DOCUMENTS.map((d) => d.id);
  $("panel").innerHTML = `
    <p class="kicker">Chapter 3</p>
    <h2 class="scene-title mt-2">Ask</h2>
    <p class="scene-lede">Pick a question. The graph follows relations from the entity it names; chunk search returns the passages most similar to it.</p>
    <div id="qs" class="mt-5 border-t border-[var(--rule)]"></div>
    <div class="mt-7"><p class="label">Graph traversal</p><ol id="hops"></ol><p class="note mt-1">The query is scripted; running it is computed.</p></div>
    <div class="mt-7 flex items-baseline justify-between gap-3">
      <p class="label">Chunk search · TF-IDF</p>
      <div id="k" role="radiogroup" aria-label="Chunks returned" class="seg-group">
        <button type="button" role="radio" data-k="3" aria-checked="${state.k === 3}" class="seg">top 3</button>
        <button type="button" role="radio" data-k="5" aria-checked="${state.k === 5}" class="seg">top 5</button>
      </div>
    </div>
    <ol id="passages" class="border-t border-[var(--rule)]"></ol>
    <div class="mt-7"><p class="label">What the answer needs</p><ul id="facts"></ul></div>`;
  $("k").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-k]");
    if (!b) return;
    state.k = Number(b.dataset.k);
    $("k").querySelectorAll("[data-k]").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
    playQuestion(state.question);
  });
  $("passages").addEventListener("click", (e) => (e.target as HTMLElement).closest(".passage")?.classList.toggle("open"));
  renderQuestions();
  playQuestion(state.question);
}

function renderQuestions() {
  $("qs").innerHTML = QUESTIONS.map(
    (q) => `<button type="button" class="qrow" data-q="${q.id}" aria-pressed="${q.id === state.question}"><span class="kind">${esc(q.kind)}</span>${esc(q.question)}</button>`,
  ).join("");
}

function hopHtml(h: Hop, i: number) {
  const fwd = h.from === h.edge.source;
  const n = (id: string) => `<span class="text-[var(--ink)]">${glyph(typeOf(id))} ${esc(nameOf(id))}</span>`;
  return `<li class="hop"><span class="hop-n">${i + 1}</span><span>${n(h.from)} <span class="rtype">${fwd ? `${h.edge.type} →` : `← ${h.edge.type}`}</span> ${n(h.to)}</span></li>`;
}

function playQuestion(id: string) {
  state.question = id;
  renderQuestions();
  const q = QUESTIONS.find((x) => x.id === id)!;
  const r = compare(graph, index, q, state.k);
  const n = r.facts.length;
  const g = r.facts.filter((f) => f.byGraph).length;
  const c = r.facts.filter((f) => f.byChunks).length;

  $("hops").innerHTML = r.hops.map(hopHtml).join("");
  $("passages").innerHTML = r.hits
    .map((h, i) => {
      let text = esc(h.chunk.text);
      for (const f of r.facts) if (text.includes(esc(f.evidence))) text = text.replace(esc(f.evidence), `<mark>${esc(f.evidence)}</mark>`);
      return `<li><button type="button" class="passage"><span class="meta"><span>${i + 1}. ${esc(h.chunk.title)}, ¶${h.chunk.index}</span><span class="font-mono">${h.score.toFixed(3)}</span></span><span class="body">${text}</span></button></li>`;
    })
    .join("");
  $("facts").innerHTML = r.facts
    .map((f) => {
      const how = f.byChunks ? `chunk search, rank ${f.rank}` : f.score ? `chunk search ranked it ${f.rank} of ${index.chunks.length}` : "no words in common with the question";
      const graphHow = f.byGraph ? "graph: on the path" : f.triple ? "graph: not on the path" : "graph: never extracted";
      return `<li class="fact ${f.byChunks ? "hit" : "miss"}"><span class="mk">${f.byChunks ? "✓" : "–"}</span><span>${esc(f.label)}<span class="note block">${how} · ${graphHow}</span></span></li>`;
    })
    .join("");

  const winner = r.verdict.winner;
  const gWin = winner === "graph" || winner === "both";
  const cWin = winner === "chunks" || winner === "both";
  $("faceoff").innerHTML = `
    <div class="grid grid-cols-2 border-b border-[var(--rule)]">
      <div class="score ${gWin ? "win" : ""}"><p class="lbl">Graph traversal</p><p class="num">${g}<small> / ${n}</small></p></div>
      <div class="score ${cWin ? "win" : ""} border-l border-[var(--rule)]"><p class="lbl">Chunk search, top ${state.k}</p><p class="num">${c}<small> / ${n}</small></p></div>
    </div>
    <div class="px-4 pt-3 pb-3.5 md:px-5">
      <p class="text-[14px] font-medium text-[var(--ink)]">${esc(r.verdict.headline)}.</p>
      <p class="mt-1 hidden text-[12.5px] leading-relaxed text-[var(--grey)] md:block">${esc(r.verdict.detail)}</p>
      <p class="mt-1.5 hidden text-[12.5px] leading-relaxed text-[var(--ink-2)] md:block"><span class="text-[var(--grey)]">Correct answer:</span> ${esc(q.answer)}</p>
    </div>`;

  const passages = [...$("passages").querySelectorAll<HTMLElement>(".passage")];
  const facts = [...$("facts").children] as HTMLElement[];
  const scene = askScene(
    graph,
    engine,
    r,
    {
      apply(t, times) {
        passages.forEach((p, i) => p.classList.toggle("in", t >= 0.3 + i * 0.15));
        $("hops").querySelectorAll(".hop").forEach((h, i) => h.classList.toggle("on", t >= times.hops[i] + 0.4));
        facts.forEach((f) => f.classList.toggle("in", t >= times.verdict));
        const fo = $("faceoff");
        const landed = t >= times.verdict;
        if (landed !== fo.classList.contains("in")) fo.classList.toggle("in", landed);
      },
    },
    frozenFor("ask"),
  );
  stage = start(scene);
}

// --- Frame loop ---------------------------------------------------------------------

const rectOf = (el: HTMLElement): Rect => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
};
/**
 * The part of the graph's slot that no overlay covers: below the legend and
 * controls, and above the caption, or above the verdict once it has landed.
 * The engine fits and clips the graph to this rectangle.
 */
function clearArea(): Rect {
  const slot = $("slot").getBoundingClientRect();
  const top = $("toprow").getBoundingClientRect();
  const faceoff = $("faceoff");
  const below = faceoff.classList.contains("in") ? faceoff.getBoundingClientRect() : $("caption").getBoundingClientRect();
  const y0 = Math.max(slot.top, top.bottom + 10);
  const y1 = Math.min(slot.bottom, (below.height ? below.top : slot.bottom - 56) - 10);
  return { x: slot.left + 8, y: y0, w: slot.width - 16, h: Math.max(120, y1 - y0) };
}
let lastCaption = "";
let lastHeroCaption = "";
function setCaption(el: HTMLElement, text: string, last: string) {
  if (text === last) return last;
  el.textContent = text;
  el.classList.remove("swap");
  void el.offsetWidth;
  el.classList.add("swap");
  return text;
}

function loop() {
  const heroRect = $("hero").getBoundingClientRect();
  state.heroActive = !$("hero").hidden && heroRect.bottom > innerHeight * 0.45;
  const scene = state.heroActive ? hero : stage;
  const t = scene.seq.t;
  const frame = scene.frame(t);
  if (!state.heroActive) scene.dom?.(t);
  engine.render(frame, state.heroActive ? rectOf($("hero-slot")) : clearArea());
  lastHeroCaption = setCaption($("hero-caption"), hero.seq.caption, lastHeroCaption);
  const verdictShown = state.chapter === "ask" && $("faceoff").classList.contains("in");
  lastCaption = setCaption($("caption"), verdictShown ? "" : stage.seq.caption, lastCaption);
  $("controls").classList.toggle("paused", !stage.seq.playing);
  $("progress-bar").style.width = `${stage.seq.duration ? (stage.seq.t / stage.seq.duration) * 100 : 100}%`;
  requestAnimationFrame(loop);
}

// --- Interaction --------------------------------------------------------------------

$("cta").addEventListener("click", () => setChapter("extract", { scroll: true }));
$("skip").addEventListener("click", () => setChapter("ask", { scroll: true }));
$("chapters").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-chapter]");
  if (b) setChapter(b.dataset.chapter as Chapter, { scroll: true });
});
$("panel").addEventListener("click", (e) => {
  const d = (e.target as HTMLElement).closest<HTMLElement>("[data-doc]");
  if (d) playDoc(d.dataset.doc!);
  const q = (e.target as HTMLElement).closest<HTMLElement>("[data-q]");
  if (q) {
    playQuestion(q.dataset.q!);
    if (innerWidth < 1024) $("stage").scrollIntoView({ behavior: reduced ? "auto" : "smooth" });
  }
});
$("controls").addEventListener("click", (e) => {
  const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
  const s = stage.seq;
  if (act === "replay") {
    engine.userCamera = null;
    s.seek(0);
    s.play();
  } else if (act === "prev") s.prev();
  else if (act === "next") s.next();
  else if (act === "toggle") s.toggle();
  else if (act === "skip") s.skip();
});
addEventListener("keydown", (e) => {
  if (state.heroActive || (e.target as HTMLElement).closest("input, textarea")) return;
  if (e.key === " " && !(e.target as HTMLElement).closest("button")) {
    e.preventDefault();
    stage.seq.toggle();
  } else if (e.key === "ArrowRight") stage.seq.next();
  else if (e.key === "ArrowLeft") stage.seq.prev();
});

const slot = $("slot");
const tip = $("tip");
let drag: { x: number; y: number; cx: number; cy: number } | null = null;
function showTip(id: string | null, x = 0, y = 0) {
  engine.hover = id;
  if (!id) {
    tip.classList.remove("on");
    return;
  }
  const e = graph.nodes.get(id)!;
  const docs = [...new Set(e.mentions.map((m) => m.document))];
  const rel = graph.edges.filter((x) => x.source === id || x.target === id);
  tip.innerHTML = `<p class="text-[var(--ink)]"><span class="font-medium">${glyph(e.type)} ${esc(e.name)}</span> <span class="text-[var(--faint)]">${e.type}</span></p>
    ${e.aliases.length ? `<p class="mt-1">Also written ${e.aliases.map((a) => `“${esc(a)}”`).join(", ")}</p>` : ""}
    <p class="mt-1">${rel.map((d) => esc(sentence(graph, d))).join(" · ")}</p>
    <p class="note mt-1">From ${docs.map((d) => esc(titleOf(d))).join(", ")}</p>`;
  tip.style.left = `${Math.min(innerWidth - 300, x + 14)}px`;
  tip.style.top = `${Math.min(innerHeight - 140, y + 14)}px`;
  tip.classList.add("on");
}
slot.addEventListener("pointermove", (e) => {
  if (drag) {
    const s = engine.scale();
    engine.userCamera = { x: drag.cx - (e.clientX - drag.x) / s, y: drag.cy - (e.clientY - drag.y) / s, z: engine.camera.z };
    return;
  }
  const id = engine.hit(e.clientX, e.clientY);
  showTip(id, e.clientX, e.clientY);
  slot.style.cursor = id ? "pointer" : "grab";
});
slot.addEventListener("pointerleave", () => showTip(null));
slot.addEventListener("pointerdown", (e) => {
  const id = engine.hit(e.clientX, e.clientY);
  if (id) {
    showTip(id, e.clientX, e.clientY);
    return;
  }
  drag = { x: e.clientX, y: e.clientY, cx: engine.camera.x, cy: engine.camera.y };
  slot.setPointerCapture(e.pointerId);
});
slot.addEventListener("pointerup", () => (drag = null));
slot.addEventListener(
  "wheel",
  (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const c = engine.userCamera ?? engine.camera;
    engine.userCamera = { ...c, z: Math.max(0.7, Math.min(2.5, c.z * Math.exp(-e.deltaY * 0.01))) };
  },
  { passive: false },
);
document.querySelector(".zoom")!.addEventListener("click", (e) => {
  const z = (e.target as HTMLElement).closest<HTMLElement>("[data-zoom]")?.dataset.zoom;
  const c = engine.userCamera ?? engine.camera;
  if (z === "in") engine.userCamera = { ...c, z: Math.min(2.5, c.z * 1.25) };
  if (z === "out") engine.userCamera = { ...c, z: Math.max(0.7, c.z / 1.25) };
  if (z === "reset") engine.userCamera = null;
});
$("theme").addEventListener("click", () => {
  const root = document.documentElement;
  root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
  readPalette();
  try {
    localStorage.setItem("kg-theme", root.dataset.theme);
  } catch {
    // The choice just isn't remembered.
  }
});

// --- Start ----------------------------------------------------------------------------

if (params.get("doc") && DOCUMENTS.some((d) => d.id === params.get("doc"))) {
  const i = DOCUMENTS.findIndex((d) => d.id === params.get("doc"));
  state.added = DOCUMENTS.slice(0, i).map((d) => d.id);
  state.doc = DOCUMENTS[i].id;
}
if (QUESTIONS.some((q) => q.id === params.get("q"))) state.question = params.get("q")!;
const first = (["extract", "merge", "ask"] as Chapter[]).includes(sceneParam as Chapter) ? (sceneParam as Chapter) : "extract";
setChapter(first);
if (sceneParam !== "hero") {
  // A link to a chapter opens straight on the stage.
  $("hero").hidden = true;
} else {
  // The stage waits until the visitor arrives, so its first scene plays on screen.
  stage = idle();
  state.added = [];
  renderDocButtons();
  let started = false;
  new IntersectionObserver(
    (entries) => {
      if (!started && entries.some((e) => e.isIntersecting)) {
        started = true;
        if (state.chapter === "extract" && state.added.length === 0) playDoc(state.doc);
      }
    },
    { threshold: 0.35 },
  ).observe($("stage"));
}
requestAnimationFrame(loop);
