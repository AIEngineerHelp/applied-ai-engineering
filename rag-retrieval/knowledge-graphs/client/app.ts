// The page: an opening shot, then a stage with three chapters (extract,
// merge, ask). The graph is drawn on a fixed canvas by engine.ts; scenes.ts
// stages each chapter as a timeline; src/ computes everything shown.
//
// URL hooks: ?scene=hero|extract|merge|ask, &doc=<id>, &q=<id>, &k=3|5,
// &t=<seconds> freezes the scene at that moment (for screenshots),
// &theme=light|dark.

import { DOCUMENTS, EXTRACTIONS, QUESTIONS } from "../src/data.ts";
import { buildGraph, sentence, type Hop } from "../src/graph.ts";
import { chunkDocuments, docText, TfIdfIndex } from "../src/retrieve.ts";
import { compare } from "../src/compare.ts";
import { pieces } from "../src/spans.ts";
import LAYOUT from "../data/layout.json" with { type: "json" };
import { Engine, HOME, type Rect } from "./engine.ts";
import { askScene, extractScene, heroScene, litBy, mergeScene, type Scene } from "./scenes.ts";
import { Sequence, ease, span } from "./timeline.ts";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const layout = LAYOUT as Record<string, number[]>;

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
engine.dark = document.documentElement.dataset.theme !== "light";
engine.reduced = reduced;
engine.frozen = tParam !== null;

const frozenFor = (scene: string) => (tParam !== null && sceneParam === scene ? tParam : null);
const start = (s: Scene) => {
  if (reduced && tParam === null) s.seq.skip();
  return s;
};

let hero = start(heroScene(graph, engine, layout, frozenFor("hero")));
let stage: Scene = idle();

function idle(): Scene {
  const seq = new Sequence(0, [{ at: 0, caption: "" }]);
  return {
    seq,
    frame: () => {
      const { nodes, edges } = litBy(graph, state.added);
      return {
        nodes: new Map([...nodes].map((id) => [id, { lit: 1 }])),
        edges: new Map([...edges].map((id) => [id, { draw: 1 }])),
        ghost: 0.55,
        labels: [],
        flashes: [],
        camera: { ...HOME },
      };
    },
  };
}

// --- Chapters ------------------------------------------------------------------

function setChapter(c: Chapter, opts: { scroll?: boolean; play?: boolean } = {}) {
  state.chapter = c;
  document.querySelectorAll<HTMLElement>("[data-chapter]").forEach((b) => b.setAttribute("aria-current", String(b.dataset.chapter === c)));
  engine.userCamera = null;
  $("faceoff").className = "faceoff pointer-events-auto";
  if (c === "extract") renderExtract();
  if (c === "merge") renderMerge();
  if (c === "ask") renderAsk();
  if (opts.scroll) $("stage").scrollIntoView({ behavior: reduced || tParam !== null ? "auto" : "smooth" });
}

// --- 01 Extract ----------------------------------------------------------------

function renderExtract() {
  const p = $("panel");
  p.innerHTML = `
    <div class="flex items-center gap-2"><span class="eyebrow">Chapter 01</span><span class="tag">extraction: fixture</span></div>
    <h2 class="scene-title mt-2">Extract</h2>
    <p class="scene-lede">Pick a document. The extractor marks its entities, then each one flies into the graph. Names it has seen before fuse with their node.</p>
    <div id="docs" class="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-2 xl:grid-cols-3"></div>
    <article id="doc" class="doc mt-6"></article>
    <div class="mt-5"><p class="mb-1 font-mono text-[10.5px] tracking-wider text-[var(--faint)] uppercase">Relations</p><ul id="rels"></ul></div>
    <div id="fusions" class="mt-4"></div>
    <div class="mt-7 flex flex-wrap gap-3"><button id="next-doc" type="button" class="cta"></button></div>`;
  renderDocButtons();
  playDoc(state.doc);
  $("next-doc").addEventListener("click", () => {
    const next = DOCUMENTS.find((d) => !state.added.includes(d.id));
    if (next) playDoc(next.id);
    else setChapter("merge", { play: true });
  });
}

function renderDocButtons() {
  $("docs").innerHTML = DOCUMENTS.map(
    (d) => `<button type="button" class="chip-btn" data-doc="${d.id}" aria-pressed="${d.id === state.doc}">${state.added.includes(d.id) ? '<i class="done"></i>' : ""}<span class="k">${esc(d.kind)}</span><span class="n">${esc(d.title)}</span></button>`,
  ).join("");
  const next = DOCUMENTS.find((d) => !state.added.includes(d.id));
  const btn = document.getElementById("next-doc");
  if (btn) btn.innerHTML = next ? `Next: ${esc(next.title)} <span aria-hidden="true">→</span>` : `Continue: resolve every name <span aria-hidden="true">→</span>`;
}

function playDoc(docId: string) {
  state.doc = docId;
  const prior = state.added.filter((d) => d !== docId);
  if (!state.added.includes(docId)) state.added.push(docId);
  const doc = DOCUMENTS.find((d) => d.id === docId)!;
  const x = EXTRACTIONS.find((e) => e.document === docId)!;
  const types = new Map(x.entities.map((e) => [e.name, e.type]));

  // The document, one element per paragraph, mentions wrapped.
  const html = pieces(docText(doc), x)
    .map((pc) => {
      const t = esc(pc.text).replace(/\n\n/g, "</p><p>");
      return pc.entity ? `<span class="ent" data-name="${esc(pc.entity)}" data-type="${types.get(pc.entity)}">${t}</span>` : t;
    })
    .join("");
  $("doc").innerHTML = `<p class="!opacity-100 !transform-none !filter-none font-mono text-[10.5px] tracking-wider text-[var(--faint)] uppercase">${esc(doc.kind)}</p>
    <h3 class="display mt-1 text-[26px] leading-tight !opacity-100">${esc(doc.title)}</h3>
    <div class="mt-3 space-y-3 text-[15px] leading-[1.75] text-[var(--ink)]"><p>${html}</p></div>`;
  $("rels").innerHTML = x.relations
    .map(
      (r) => `<li class="rel"><span class="pill" data-type="${types.get(r.source)}">${esc(r.source)}</span><span class="rtype">─${r.type}→</span><span class="pill" data-type="${types.get(r.target)}">${esc(r.target)}</span>${r.properties ? `<span class="font-mono text-[10.5px] text-[var(--faint)]">{${esc(Object.entries(r.properties).map(([k, v]) => `${k}: ${v}`).join(", "))}}</span>` : ""}</li>`,
    )
    .join("");

  const paras = () => [...$("doc").querySelectorAll<HTMLElement>(".space-y-3 > p")];
  const spans = new Map<string, HTMLElement[]>();
  $("doc").querySelectorAll<HTMLElement>(".ent").forEach((s) => spans.set(s.dataset.name!, [...(spans.get(s.dataset.name!) ?? []), s]));
  const scene = extractScene(graph, engine, docId, prior, {
    spanRect: (n) => spans.get(n)?.[0]?.getBoundingClientRect() ?? null,
    setSpanState: (n, st) => spans.get(n)?.forEach((s) => s.className = `ent ${st === "idle" ? "" : st}`),
    setParagraphs: (v) => paras().forEach((p, i) => p.classList.toggle("in", i < v)),
    setRelations: (v) => $("rels").querySelectorAll("li").forEach((li, i) => li.classList.toggle("in", i < v)),
  }, frozenFor("extract"));
  $("fusions").innerHTML = scene.fusions.length
    ? `<p class="mb-2 font-mono text-[10.5px] tracking-wider text-[var(--faint)] uppercase">Entity resolution <span class="tag tag-live ml-1">computed</span></p>` +
      scene.fusions.map((f) => `<p class="flex flex-wrap items-center gap-1.5 py-0.5 text-[12.5px]"><span class="pill" data-type="${types.get(f.alias)}">${esc(f.alias)}</span><span class="text-[var(--faint)]">fuses with</span><span class="pill" data-type="${types.get(f.alias)}">${esc(f.canonical)}</span><span class="text-[11.5px] text-[var(--faint)]">${f.reason}</span></p>`).join("")
    : "";
  stage = start(scene);
  renderDocButtons();
}

// --- 02 Merge ----------------------------------------------------------------------

function renderMerge() {
  const groups = [...graph.nodes.values()].filter((e) => e.aliases.length);
  const names = EXTRACTIONS.reduce((s, x) => s + x.entities.length, 0);
  const rels = EXTRACTIONS.reduce((s, x) => s + x.relations.length, 0);
  $("panel").innerHTML = `
    <div class="flex items-center gap-2"><span class="eyebrow">Chapter 02</span><span class="tag tag-live">computed</span></div>
    <h2 class="scene-title mt-2">Merge</h2>
    <p class="scene-lede">The extractor reads one document at a time, so the same supplier comes back as “Varnell Semi”, “Varnell” and “Varnell Semiconductor”. Entity resolution fuses names of the same type that are equal after normalizing, or where each word of the short name starts the matching word of the long one. Numbers must match exactly, and a name that could fit two entities is left alone.</p>
    <div class="mt-6 grid grid-cols-2 gap-3">
      <div class="score !px-0"><p class="lbl">Names → entities</p><p class="num">${names}<small> → </small>${graph.nodes.size}</p></div>
      <div class="score !px-0"><p class="lbl">Relations → edges</p><p class="num">${rels}<small> → </small>${graph.edges.length}</p></div>
    </div>
    <ul class="mt-5 grid gap-2.5">${groups
      .map(
        (g) => `<li class="flex flex-wrap items-center gap-1.5 text-[13px]">${g.aliases.map((a) => `<span class="pill" data-type="${g.type}">${esc(a)}</span>`).join("")}<span class="text-[var(--faint)]">→</span><span class="pill" data-type="${g.type}">${esc(g.name)}</span><span class="text-[11.5px] text-[var(--faint)]">${g.merges[0].reason}</span></li>`,
      )
      .join("")}</ul>
    <p class="mt-5 text-[13px] leading-relaxed text-[var(--muted)]">Two relations were stated in two documents each (the Hardware team owns the Borealis design; Tomas Berg, also written “T. Berg”, leads the Hardware team). Each became one edge with two pieces of evidence.</p>
    <div class="mt-7"><button id="to-ask" type="button" class="cta">Continue: ask a question <span aria-hidden="true">→</span></button></div>`;
  $("to-ask").addEventListener("click", () => setChapter("ask"));
  state.added = DOCUMENTS.map((d) => d.id);
  stage = start(mergeScene(graph, engine, layout, frozenFor("merge")));
}

// --- 03 Ask ----------------------------------------------------------------------

function renderAsk() {
  state.added = DOCUMENTS.map((d) => d.id);
  $("panel").innerHTML = `
    <div class="flex items-center gap-2"><span class="eyebrow">Chapter 03</span></div>
    <h2 class="scene-title mt-2">Ask</h2>
    <p class="scene-lede">Pick a question. The graph follows relations from the entity it names; chunk search returns the most similar passages.</p>
    <div id="qs" class="mt-4 grid gap-1.5 xl:grid-cols-2"></div>
    <div class="mt-6"><p class="mb-2 flex items-center gap-2 font-mono text-[10.5px] tracking-wider text-[var(--faint)] uppercase">Graph traversal <span class="tag tag-live">computed</span></p><ol id="hops" class="hops"></ol></div>
    <div class="mt-6 flex items-center justify-between gap-3">
      <p class="font-mono text-[10.5px] tracking-wider text-[var(--faint)] uppercase">Chunk search · TF-IDF</p>
      <div id="k" role="radiogroup" aria-label="Chunks returned" class="seg-group">
        <button type="button" role="radio" data-k="3" aria-checked="${state.k === 3}" class="seg">Top 3</button>
        <button type="button" role="radio" data-k="5" aria-checked="${state.k === 5}" class="seg">Top 5</button>
      </div>
    </div>
    <ol id="passages" class="mt-3 grid gap-2"></ol>
    <p class="mt-6 mb-2 font-mono text-[10.5px] tracking-wider text-[var(--faint)] uppercase">What the answer needs</p>
    <ul id="facts" class="grid gap-1.5"></ul>
    <details class="mt-5 rounded-xl p-3 text-[12.5px] [box-shadow:0_0_0_1px_var(--line)]"><summary class="cursor-pointer text-[var(--muted)]">The graph query <span class="tag ml-1">scripted</span></summary><pre id="cypher" class="mt-2 overflow-x-auto font-mono text-[11.5px] leading-relaxed text-[var(--muted)]"></pre></details>`;
  $("k").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-k]");
    if (!b) return;
    state.k = Number(b.dataset.k);
    $("k").querySelectorAll("[data-k]").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
    playQuestion(state.question);
  });
  renderQuestions();
  playQuestion(state.question);
}

function renderQuestions() {
  $("qs").innerHTML = QUESTIONS.map(
    (q) => `<button type="button" class="chip-btn !py-2" data-q="${q.id}" aria-pressed="${q.id === state.question}"><span class="k">${esc(q.kind)}</span><span class="n !text-[12.5px] !font-normal">${esc(q.question)}</span></button>`,
  ).join("");
}

function hopHtml(h: Hop, i: number) {
  const fwd = h.from === h.edge.source;
  const pill = (id: string) => `<span class="pill" data-type="${typeOf(id)}">${esc(nameOf(id))}</span>`;
  return `<li class="hop"><span class="hop-n">${i + 1}</span><span class="flex flex-wrap items-center gap-1">${pill(h.from)}<span class="rtype">${fwd ? `─${h.edge.type}→` : `←${h.edge.type}─`}</span>${pill(h.to)}</span></li>`;
}

function playQuestion(id: string) {
  state.question = id;
  renderQuestions();
  const q = QUESTIONS.find((x) => x.id === id)!;
  const r = compare(graph, index, q, state.k);
  const n = r.facts.length;
  const g = r.facts.filter((f) => f.byGraph).length;
  const c = r.facts.filter((f) => f.byChunks).length;
  $("cypher").textContent = q.cypher;

  $("passages").innerHTML = r.hits
    .map((h, i) => {
      let text = esc(h.chunk.text);
      for (const f of r.facts) if (text.includes(esc(f.evidence))) text = text.replace(esc(f.evidence), `<mark class="fact-hit">${esc(f.evidence)}</mark>`);
      return `<li class="passage"><div class="mb-1 flex items-center justify-between gap-2 font-mono text-[10.5px] text-[var(--faint)]"><span>#${i + 1} · ${esc(h.chunk.title)} ¶${h.chunk.index}</span><span>${h.score.toFixed(3)}</span></div><p class="text-[13.5px] leading-relaxed text-[var(--muted)]">${text}</p></li>`;
    })
    .join("");
  $("facts").innerHTML = r.facts
    .map((f) => {
      const where = index.chunks.find((x) => x.id === f.chunk)!;
      const chunkSays = f.byChunks ? `chunk search: ranked ${f.rank}` : f.score ? `chunk search: ranked ${f.rank} of ${index.chunks.length}` : "chunk search: no shared words";
      const graphSays = f.byGraph ? "graph: edge returned" : f.triple ? "graph: not on the path" : "graph: never extracted";
      return `<li class="fact ${f.byChunks ? "hit" : "miss"}" data-graph="${f.byGraph}"><span class="dot"></span><span><span class="block font-medium ${f.byChunks ? "text-[var(--ink)]" : ""}">${esc(f.label)}</span><span class="font-mono text-[10.5px] text-[var(--faint)]">${esc(where.title)} ¶${where.index} · ${chunkSays} · ${graphSays}</span></span></li>`;
    })
    .join("");

  $("hops").innerHTML = r.hops.map(hopHtml).join("");

  const winner = r.verdict.winner;
  const gWin = winner === "graph" || winner === "both";
  const cWin = winner === "chunks" || winner === "both";
  $("faceoff").innerHTML = `
    <div class="grid grid-cols-2">
      <div class="score ${gWin ? "win" : "lose"}"><p class="lbl">Graph traversal</p><p class="num"><span data-count="${g}">0</span><small> / ${n}</small></p></div>
      <div class="score ${cWin ? "win" : "lose"} [box-shadow:-1px_0_0_var(--line)]"><p class="lbl">Chunk search · top ${state.k}</p><p class="num"><span data-count="${c}">0</span><small> / ${n}</small></p></div>
    </div>
    <div class="px-4 pt-2.5 pb-3 [box-shadow:0_-1px_0_var(--line)] md:px-5 md:pt-3 md:pb-4">
      <p class="text-[14.5px] font-semibold md:text-[15.5px]">${esc(r.verdict.headline)}</p>
      <p class="mt-1 hidden text-[12.5px] leading-relaxed text-[var(--muted)] md:block">${esc(r.verdict.detail)}</p>
      <p class="mt-1.5 hidden text-[12.5px] leading-relaxed md:block"><span class="text-[var(--faint)]">Correct answer:</span> ${esc(q.answer)}</p>
    </div>`;

  const passages = [...$("passages").children] as HTMLElement[];
  const facts = [...$("facts").children] as HTMLElement[];
  const counts = [...$("faceoff").querySelectorAll<HTMLElement>("[data-count]")];
  const scene = askScene(graph, engine, r, {
    apply(t, times) {
      passages.forEach((p, i) => p.classList.toggle("in", t >= 0.35 + i * 0.22));
      $("hops").querySelectorAll(".hop").forEach((h, i) => h.classList.toggle("on", t >= times.hops[i] + 0.4));
      facts.forEach((f, i) => f.classList.toggle("in", t >= times.verdict - 0.2 + i * 0.06));
      const landed = t >= times.verdict;
      const fo = $("faceoff");
      if (landed !== fo.classList.contains("in")) fo.classList.toggle("in", landed);
      const k = ease.out(span(t, times.verdict + 0.15, 0.8));
      counts.forEach((el) => (el.textContent = String(Math.round(Number(el.dataset.count) * k))));
    },
  }, frozenFor("ask"));
  stage = start(scene);
}

// --- Frame loop -------------------------------------------------------------------

const rectOf = (el: HTMLElement): Rect => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
};
/**
 * The part of the graph's slot that no overlay covers: below the scene
 * controls, and above the caption, or above the verdict once it has landed.
 * The engine fits the graph into this rectangle, so overlays never hide it.
 */
function clearArea(): Rect {
  const slot = $("slot").getBoundingClientRect();
  const controls = $("controls").getBoundingClientRect();
  const faceoff = $("faceoff");
  const below = faceoff.classList.contains("in") ? faceoff.getBoundingClientRect() : $("caption").getBoundingClientRect();
  const top = Math.max(slot.top, controls.bottom + 8);
  const bottom = Math.min(slot.bottom, (below.height ? below.top : slot.bottom - 56) - 8);
  return { x: slot.left, y: top, w: slot.width, h: Math.max(120, bottom - top) };
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
  ($("progress-bar") as HTMLElement).style.width = `${stage.seq.duration ? (stage.seq.t / stage.seq.duration) * 100 : 100}%`;
  requestAnimationFrame(loop);
}

// --- Interaction -----------------------------------------------------------------

$("cta").addEventListener("click", () => {
  setChapter("extract", { scroll: true });
});
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

// Pan, zoom and inspect the graph.
const slot = $("slot");
let drag: { x: number; y: number; cx: number; cy: number } | null = null;
const tip = $("tip");
function showTip(id: string | null, x = 0, y = 0) {
  engine.hover = id;
  if (!id) {
    tip.classList.remove("on");
    return;
  }
  const e = graph.nodes.get(id)!;
  const docs = [...new Set(e.mentions.map((m) => m.document))];
  const deg = graph.edges.filter((x) => x.source === id || x.target === id);
  const props = Object.entries(e.properties);
  tip.innerHTML = `<p class="flex items-center gap-2"><span class="pill" data-type="${e.type}">${esc(e.name)}</span><span class="text-[11px] text-[var(--faint)]">${e.type}</span></p>
    ${e.aliases.length ? `<p class="mt-1.5 text-[var(--muted)]">Also written ${e.aliases.map((a) => `“${esc(a)}”`).join(", ")}</p>` : ""}
    <p class="mt-1 text-[var(--muted)]">${deg.map((d) => esc(sentence(graph, d))).join(" · ")}</p>
    <p class="mt-1 text-[11px] text-[var(--faint)]">From ${docs.map((d) => esc(titleOf(d))).join(", ")}${props.length ? ` · ${esc(props.map(([k, v]) => `${k}: ${v}`).join(", "))}` : ""}</p>`;
  tip.style.left = `${Math.min(innerWidth - 300, x + 16)}px`;
  tip.style.top = `${Math.min(innerHeight - 140, y + 16)}px`;
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
    engine.userCamera = engine.fit([id, ...graph.edges.filter((x) => x.source === id || x.target === id).flatMap((x) => [x.source, x.target])], 1.8);
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
    if (!e.ctrlKey && !e.metaKey) return; // plain scrolling still scrolls the page
    e.preventDefault();
    const c = engine.userCamera ?? engine.camera;
    engine.userCamera = { ...c, z: Math.max(0.6, Math.min(3, c.z * Math.exp(-e.deltaY * 0.01))) };
  },
  { passive: false },
);
document.querySelector(".zoom")!.addEventListener("click", (e) => {
  const z = (e.target as HTMLElement).closest<HTMLElement>("[data-zoom]")?.dataset.zoom;
  const c = engine.userCamera ?? engine.camera;
  if (z === "in") engine.userCamera = { ...c, z: Math.min(3, c.z * 1.3) };
  if (z === "out") engine.userCamera = { ...c, z: Math.max(0.6, c.z / 1.3) };
  if (z === "reset") engine.userCamera = null;
});

$("theme").addEventListener("click", () => {
  const root = document.documentElement;
  root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
  engine.dark = root.dataset.theme === "dark";
  try {
    localStorage.setItem("kg-theme", root.dataset.theme);
  } catch {
    // The choice just isn't remembered.
  }
});

// --- Start -------------------------------------------------------------------------

if (params.get("doc") && DOCUMENTS.some((d) => d.id === params.get("doc"))) {
  // Documents before the requested one count as already extracted.
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
  let started = false;
  new IntersectionObserver((entries) => {
    if (!started && entries.some((e) => e.isIntersecting)) {
      started = true;
      if (state.chapter === "extract" && state.added.length === 0) playDoc(state.doc);
    }
  }, { threshold: 0.35 }).observe($("stage"));
  // The extract panel is rendered, but nothing is "added" until it plays.
  state.added = [];
  renderDocButtons();
}
requestAnimationFrame(loop);
