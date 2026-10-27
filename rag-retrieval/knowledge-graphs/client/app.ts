// One page, three steps: extract (highlight a document's entities and
// relations), merge (add them to the graph), ask (traverse the graph next to
// chunk retrieval, with a computed verdict).

import { DOCUMENTS, EXTRACTIONS, QUESTIONS } from "../src/data.ts";
import { buildGraph, type Hop } from "../src/graph.ts";
import { lookup } from "../src/resolve.ts";
import { chunkDocuments, docText, TfIdfIndex } from "../src/retrieve.ts";
import { compare, type Comparison } from "../src/compare.ts";
import { ENTITY_TYPES } from "../src/schema.ts";
import { pieces } from "../src/spans.ts";
import LAYOUT from "../data/layout.json" with { type: "json" };
import { GraphView } from "./graph-view.ts";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

const graph = buildGraph(EXTRACTIONS);
const index = new TfIdfIndex(chunkDocuments(DOCUMENTS));
const docById = new Map(DOCUMENTS.map((d) => [d.id, d]));
const extractionOf = new Map(EXTRACTIONS.map((x) => [x.document, x]));
const name = (id: string) => graph.nodes.get(id)!.name;
const typeOf = (id: string) => graph.nodes.get(id)!.type;
const docTitle = (id: string) => docById.get(id)!.title;

const params = new URLSearchParams(location.search);
const state = {
  doc: docById.has(params.get("doc") ?? "") ? params.get("doc")! : DOCUMENTS[0].id,
  added: [] as string[], // documents in the graph, in the order they were added
  question: QUESTIONS.some((q) => q.id === params.get("q")) ? params.get("q") : (null as string | null),
  k: 3,
  mode: "doc" as "doc" | "question",
};

// Timers for staged animation, one group per step, so a new question doesn't
// cut the document's highlighting short (and the reverse).
type Group = "doc" | "path";
const timers: Record<Group, number[]> = { doc: [], path: [] };
const later = (group: Group, fn: () => void, ms: number) => {
  if (reduced() || ms === 0) fn();
  else timers[group].push(window.setTimeout(fn, ms));
};
const clearTimers = (...groups: Group[]) => {
  for (const g of groups) {
    timers[g].forEach(clearTimeout);
    timers[g] = [];
  }
};

// --- Step pills ---------------------------------------------------------------

function renderSteps() {
  const all = state.added.length === DOCUMENTS.length;
  const visible = visibleNodes();
  const steps = [
    { n: 1, label: `Extract · ${state.added.length} of ${DOCUMENTS.length} documents read`, done: state.added.length > 0 },
    { n: 2, label: `Merge · ${visible.size} entities, ${visibleEdges().size} relations`, done: all },
    { n: 3, label: state.question ? "Ask · compared" : "Ask · pick a question", done: !!state.question },
  ];
  const active = state.question ? 3 : all ? 3 : state.added.length > 1 ? 2 : 1;
  $("steps").innerHTML = steps
    .map((s) => `<li class="pill ${s.done && s.n !== active ? "done" : ""} ${s.n === active ? "active" : ""}"><span class="n">${s.done && s.n !== active ? "✓" : s.n}</span>${s.label}</li>`)
    .join("");
}

// --- Step 1: the document -------------------------------------------------------

function renderDocTabs() {
  $("docs").innerHTML = DOCUMENTS.map(
    (d) => `<button type="button" role="tab" class="doc-tab ${state.added.includes(d.id) ? "added" : ""}" data-doc="${d.id}" aria-selected="${d.id === state.doc}">
      <svg class="tick" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7"/></svg>
      <span class="kind">${esc(d.kind)}</span><span class="name">${esc(d.title)}</span></button>`,
  ).join("");
}

function renderDoc() {
  const doc = docById.get(state.doc)!;
  const x = extractionOf.get(doc.id)!;
  const text = docText(doc);
  const types = new Map(x.entities.map((e) => [e.name, e.type]));

  // The document, with every mention and evidence span as its own element.
  let n = 0;
  const html = pieces(text, x)
    .map((p) => {
      let inner = esc(p.text).replace(/\n\n/g, "</p><p>");
      if (p.entity) {
        const type = types.get(p.entity)!;
        inner = `<span class="ent" data-type="${type}" data-label="${type}" data-i="${n++}">${inner}</span>`;
      }
      return p.relations.length ? `<span class="ev" data-rels="${p.relations.join(" ")}">${inner}</span>` : inner;
    })
    .join("");
  $("doc").innerHTML = `<h3 class="mb-2 text-[17px] font-semibold tracking-tight">${esc(doc.title)}</h3>
    <div class="space-y-2.5 text-[14.5px] leading-[1.75] text-zinc-700 dark:text-zinc-300"><p>${html}</p></div>`;

  // Relations, in the extracted (unmerged) names.
  $("rel-count").textContent = `· ${x.relations.length} extracted`;
  $("relations").innerHTML = x.relations
    .map(
      (r, i) => `<li class="rel-row" data-rel="${i}" tabindex="0">
        <span class="chip" data-type="${types.get(r.source)}">${esc(r.source)}</span>
        <span class="rtype">─${r.type}→</span>
        <span class="chip" data-type="${types.get(r.target)}">${esc(r.target)}</span>
        ${r.properties ? `<span class="font-mono text-[11px] text-zinc-500">{${esc(Object.entries(r.properties).map(([k, v]) => `${k}: ${v}`).join(", "))}}</span>` : ""}
      </li>`,
    )
    .join("");

  // Entity resolution for this document: names that became another node's alias.
  const merges = x.entities
    .map((e) => ({ e, id: lookup(graph.resolution, e.type, e.name)! }))
    .filter(({ e, id }) => name(id) !== e.name)
    .map(({ e, id }) => {
      const m = graph.nodes.get(id)!.merges.find((mm) => mm.alias === e.name)!;
      return `<li class="flex flex-wrap items-center gap-1.5 text-[13px]"><span class="chip" data-type="${e.type}">${esc(e.name)}</span><span class="text-zinc-400">→</span><span class="chip" data-type="${e.type}">${esc(name(id))}</span><span class="text-xs text-zinc-500">${m.reason}</span></li>`;
    });
  $("merges").innerHTML = merges.length
    ? `<h3 class="sub-title">Entity resolution</h3><p class="mb-1.5 text-[13px] text-zinc-500">These names were merged into an existing entity instead of becoming new nodes.</p><ul class="grid gap-1.5">${merges.join("")}</ul>`
    : "";

  // Stagger the highlights in, as if the extractor were returning them.
  const ents = [...$("doc").querySelectorAll<HTMLElement>(".ent")];
  const rows = [...$("relations").querySelectorAll<HTMLElement>(".rel-row")];
  const step = Math.min(45, 700 / Math.max(1, ents.length));
  ents.forEach((e, i) => later("doc", () => e.classList.add("on"), 60 + i * step));
  rows.forEach((r, i) => later("doc", () => r.classList.add("on"), 120 + ents.length * step + i * 60));

  // Hovering a relation shows the sentence it was extracted from.
  for (const row of rows) {
    const show = (on: boolean) =>
      $("doc").querySelectorAll<HTMLElement>(".ev").forEach((s) => s.classList.toggle("hl", on && s.dataset.rels!.split(" ").includes(row.dataset.rel!)));
    row.addEventListener("pointerenter", () => show(true));
    row.addEventListener("pointerleave", () => show(false));
    row.addEventListener("focus", () => show(true));
    row.addEventListener("blur", () => show(false));
  }
}

// --- Step 2: the graph ---------------------------------------------------------------

const view = new GraphView($("graph") as unknown as SVGSVGElement, graph, LAYOUT as Record<string, number[]>, showNode);

function visibleNodes(docs = state.added) {
  return new Set([...graph.nodes.values()].filter((e) => e.mentions.some((m) => docs.includes(m.document))).map((e) => e.id));
}
function visibleEdges(docs = state.added) {
  return new Set(graph.edges.filter((e) => e.evidence.some((v) => docs.includes(v.document))).map((e) => e.id));
}

function renderLegend() {
  $("legend").innerHTML =
    ENTITY_TYPES.map((t) => `<li class="flex items-center gap-1.5" data-type="${t}"><i class="inline-block size-2.5 rounded-full bg-[var(--c)]"></i>${t}</li>`).join("") +
    `<li class="flex items-center gap-1.5"><svg class="size-3.5" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-dasharray="2.5 2.5"/></svg>merged from several names</li>`;
}

function showNode(id: string | null) {
  const info = $("node-info");
  if (!id) {
    info.innerHTML = state.mode === "question" && state.question
      ? "The highlighted path is the traversal for the selected question."
      : "Hover or tap a node to see where it came from. Names shown are the merged names.";
    return;
  }
  const e = graph.nodes.get(id)!;
  const docs = [...new Set(e.mentions.map((m) => m.document))];
  const degree = graph.edges.filter((x) => x.source === id || x.target === id).length;
  const props = Object.entries(e.properties);
  info.innerHTML = `<b class="font-semibold text-zinc-900 dark:text-zinc-100">${esc(e.name)}</b> <span class="text-zinc-500">${e.type} · ${degree} relation${degree === 1 ? "" : "s"}</span><br>
    ${e.aliases.length ? `Also written as ${e.aliases.map((a) => `“${esc(a)}”`).join(", ")}. ` : ""}Mentioned in ${docs.map((d) => esc(docTitle(d))).join(", ")}.${props.length ? ` <span class="font-mono text-[11.5px]">{${esc(props.map(([k, v]) => `${k}: ${v}`).join(", "))}}</span>` : ""}`;
}

function renderGraph(hot: { nodes: Set<string>; edges: Set<string> } = { nodes: new Set(), edges: new Set() }) {
  const doc = extractionOf.get(state.doc)!;
  const current = new Set(doc.entities.map((e) => lookup(graph.resolution, e.type, e.name)!));
  view.update({
    visibleNodes: visibleNodes(),
    visibleEdges: visibleEdges(),
    current,
    hotNodes: hot.nodes,
    hotEdges: hot.edges,
    focus: state.mode === "question" && hot.nodes.size > 0,
  });
  const n = visibleNodes().size;
  const mentions = EXTRACTIONS.filter((x) => state.added.includes(x.document)).reduce((s, x) => s + x.entities.length, 0);
  $("graph-stats").textContent = `${state.added.length} of ${DOCUMENTS.length} documents · ${mentions} extracted names resolved to ${n} entities · ${visibleEdges().size} relations`;
  ($("add-all") as HTMLButtonElement).disabled = state.added.length === DOCUMENTS.length;
  showNode(null);
}

function selectDoc(id: string) {
  clearTimers("doc", "path");
  state.doc = id;
  state.mode = "doc";
  if (!state.added.includes(id)) state.added.push(id);
  renderDocTabs();
  renderDoc();
  renderGraph();
  renderSteps();
  renderQuestions();
}

// --- Step 3: questions ------------------------------------------------------------------

function renderQuestions() {
  $("questions").innerHTML = QUESTIONS.map(
    (q) => `<button type="button" class="q-card" data-q="${q.id}" aria-pressed="${q.id === state.question}"><span class="q-kind">${esc(q.kind)}</span><span>${esc(q.question)}</span></button>`,
  ).join("");
}

const check = `<svg class="size-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7"/></svg>`;
const cross = `<svg class="size-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="m4.5 4.5 7 7m0-7-7 7"/></svg>`;
const verdictStyle: Record<Comparison["verdict"]["winner"], string> = {
  graph: "border-teal-600/40 bg-teal-50 dark:border-teal-400/30 dark:bg-teal-400/10",
  chunks: "border-amber-500/50 bg-amber-50 dark:border-amber-400/30 dark:bg-amber-400/10",
  both: "border-zinc-300 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800/50",
  neither: "border-rose-500/40 bg-rose-50 dark:border-rose-400/30 dark:bg-rose-400/10",
};
const tagStyle: Record<Comparison["verdict"]["winner"], string> = {
  graph: "tag-comp",
  chunks: "bg-amber-100 text-amber-800 dark:bg-amber-400/15 dark:text-amber-300",
  both: "bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200",
  neither: "bg-rose-100 text-rose-800 dark:bg-rose-400/15 dark:text-rose-300",
};
const verdictLabel: Record<Comparison["verdict"]["winner"], string> = {
  graph: "Graph wins",
  chunks: "Chunk search wins",
  both: "Tie",
  neither: "Both miss",
};

function hopHtml(h: Hop, i: number) {
  const e = h.edge;
  const forward = h.from === e.source;
  const chip = (id: string) => `<span class="chip" data-type="${typeOf(id)}">${esc(name(id))}</span>`;
  const arrow = forward ? `<span class="rtype">─${e.type}→</span>` : `<span class="rtype">←${e.type}─</span>`;
  const props = Object.entries(e.properties);
  return `<li class="hop" data-hop="${i}"><span class="hop-n">${i + 1}</span><div class="min-w-0">
    <div class="flex flex-wrap items-center gap-1.5">${chip(h.from)}${arrow}${chip(h.to)}</div>
    <div class="mt-0.5 text-xs text-zinc-500">from ${e.evidence.map((v) => esc(docTitle(v.document))).join(" and ")}${props.length ? ` · <span class="font-mono">{${esc(props.map(([k, v]) => `${k}: ${v}`).join(", "))}}</span>` : ""}</div></div></li>`;
}

function highlightFacts(text: string, facts: Comparison["facts"]) {
  let out = esc(text);
  for (const f of facts) {
    const ev = esc(f.evidence);
    if (out.includes(ev)) out = out.replace(ev, `<mark class="fact-hl">${ev}</mark>`);
  }
  return out;
}

function renderResult() {
  const q = QUESTIONS.find((x) => x.id === state.question);
  if (!q) {
    $("result").innerHTML = `<p class="rounded-xl border border-dashed border-zinc-300 px-4 py-6 text-center text-[14px] text-zinc-500 dark:border-zinc-700">Pick a question above. The graph will light up the path it follows, hop by hop, next to the passages chunk search returns.</p>`;
    return;
  }
  const r = compare(graph, index, q, state.k);
  const count = (key: "byChunks" | "byGraph" | "byHybrid") => r.facts.filter((f) => f[key]).length;
  const n = r.facts.length;
  const s = q.strategy;
  const graphReturns =
    s.type === "neighbourhood"
      ? `${r.hops.length} relations around ${esc(name(r.hops[0]?.from ?? ""))}. None of them says what was recommended.`
      : s.type === "path"
        ? `A ${r.hops.length}-hop path.`
        : `${s.count ? `count = ${r.answerIds.length}: ` : ""}${r.answerIds.map((id) => `<span class="chip" data-type="${typeOf(id)}">${esc(name(id))}</span>`).join(" ")}`;

  $("result").innerHTML = `
    <div class="mb-4 rounded-xl border px-4 py-3 ${verdictStyle[r.verdict.winner]}">
      <p class="flex flex-wrap items-center gap-2 text-[15px] font-semibold"><span class="tag ${tagStyle[r.verdict.winner]}">${verdictLabel[r.verdict.winner]}</span>${esc(r.verdict.headline)}</p>
      <p class="mt-1 text-[13.5px] leading-relaxed text-zinc-700 dark:text-zinc-300">${esc(r.verdict.detail)}</p>
      <p class="mt-2 text-[13.5px] leading-relaxed"><span class="font-semibold">Correct answer:</span> ${esc(q.answer)}</p>
    </div>

    <div class="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-2">
      <div class="min-w-0">
        <div class="mb-2 flex items-center justify-between gap-2"><h3 class="text-[14px] font-semibold">Graph traversal</h3><span class="text-[12.5px] text-zinc-500">${count("byGraph")} of ${n} facts</span></div>
        <details class="group mb-2 rounded-lg border border-zinc-200 dark:border-zinc-800">
          <summary class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[12.5px] text-zinc-600 select-none dark:text-zinc-400"><span class="tag tag-script">Scripted</span>The query, as text-to-Cypher would write it</summary>
          <pre class="overflow-x-auto border-t border-zinc-200 px-3 py-2 font-mono text-[11.5px] leading-relaxed dark:border-zinc-800">${esc(q.cypher)}</pre>
        </details>
        <ol class="grid gap-1" id="hops">${r.hops.map(hopHtml).join("")}</ol>
        <p class="mt-2 text-[13px] text-zinc-600 dark:text-zinc-400"><span class="font-medium text-zinc-900 dark:text-zinc-100">Returns:</span> ${graphReturns}</p>
      </div>
      <div class="min-w-0">
        <div class="mb-2 flex items-center justify-between gap-2"><h3 class="text-[14px] font-semibold">Chunk search <span class="font-normal text-zinc-500">· TF-IDF, top ${state.k}</span></h3><span class="text-[12.5px] text-zinc-500">${count("byChunks")} of ${n} facts</span></div>
        <ol class="grid gap-2">${r.hits
          .map(
            (h, i) => `<li class="hit"><div class="mb-1 flex items-center justify-between gap-2 text-xs text-zinc-500"><span><b class="font-semibold text-zinc-700 dark:text-zinc-300">#${i + 1}</b> · ${esc(h.chunk.title)} ¶${h.chunk.index}</span><span class="font-mono">${h.score.toFixed(3)}</span></div>
              <p class="text-[13.5px] leading-relaxed">${highlightFacts(h.chunk.text, r.facts)}</p></li>`,
          )
          .join("")}</ol>
      </div>
    </div>

    <h3 class="mt-5 mb-2 text-[14px] font-semibold">What the answer needs</h3>
    <div class="overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
      <table class="w-full min-w-[620px] text-left text-[13px]">
        <thead class="bg-zinc-50 text-xs text-zinc-500 dark:bg-zinc-800/50"><tr>
          <th class="px-3 py-2 font-semibold">Fact</th><th class="px-3 py-2 font-semibold">Stated in</th>
          <th class="px-3 py-2 font-semibold">Chunk search</th><th class="px-3 py-2 font-semibold">Graph</th><th class="px-3 py-2 font-semibold">Hybrid</th>
        </tr></thead>
        <tbody class="divide-y divide-zinc-200 dark:divide-zinc-800">${r.facts
          .map((f) => {
            const c = index.chunks.find((x) => x.id === f.chunk)!;
            return `<tr>
              <td class="px-3 py-2">${esc(f.label)}</td>
              <td class="px-3 py-2 text-zinc-500">${esc(c.title)} ¶${c.index}</td>
              <td class="px-3 py-2">${f.byChunks ? `<span class="yes">${check}ranked ${f.rank}</span>` : `<span class="no">${cross}${f.score ? `ranked ${f.rank} of ${index.chunks.length}` : "no shared words"}</span>`}</td>
              <td class="px-3 py-2">${f.byGraph ? `<span class="yes">${check}edge returned</span>` : `<span class="no">${cross}${f.triple ? "not on the path" : "never extracted"}</span>`}</td>
              <td class="px-3 py-2">${f.byHybrid ? `<span class="yes">${check}found</span>` : `<span class="no">${cross}missed</span>`}</td>
            </tr>`;
          })
          .join("")}</tbody>
      </table>
    </div>
    <p class="mt-2 text-[12.5px] text-zinc-500">Hybrid returns the graph's edges plus the paragraphs they were extracted from, plus the top ${state.k} chunks. Totals: chunk search ${count("byChunks")}/${n}, graph ${count("byGraph")}/${n}, hybrid ${count("byHybrid")}/${n}.</p>`;

  // Light the traversal up hop by hop, in the list and in the graph.
  const hot = { nodes: new Set<string>(), edges: new Set<string>() };
  const items = [...$("result").querySelectorAll<HTMLElement>(".hop")];
  const startIds = r.hops.length ? [r.hops[0].from] : [];
  startIds.forEach((id) => hot.nodes.add(id));
  renderGraph(hot);
  const gap = s.type === "neighbourhood" ? 120 : 280;
  r.hops.forEach((h, i) =>
    later("path", () => {
      hot.nodes.add(h.from).add(h.to);
      hot.edges.add(h.edge.id);
      items[i]?.classList.add("on");
      renderGraph(hot);
    }, 200 + i * gap),
  );
}

function selectQuestion(id: string) {
  clearTimers("path");
  state.question = id;
  state.mode = "question";
  // The comparison uses the whole corpus, so put every document in the graph.
  for (const d of DOCUMENTS) if (!state.added.includes(d.id)) state.added.push(d.id);
  renderDocTabs();
  renderQuestions();
  renderSteps();
  renderResult();
}

// --- Wiring ----------------------------------------------------------------------------------

$("docs").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-doc]");
  if (b) selectDoc(b.dataset.doc!);
});
$("docs").addEventListener("keydown", (e) => {
  if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
  const i = DOCUMENTS.findIndex((d) => d.id === state.doc);
  const next = DOCUMENTS[(i + (e.key === "ArrowRight" ? 1 : DOCUMENTS.length - 1)) % DOCUMENTS.length];
  selectDoc(next.id);
  $("docs").querySelector<HTMLElement>(`[data-doc="${next.id}"]`)?.focus();
});
$("add-all").addEventListener("click", () => {
  clearTimers("doc", "path");
  for (const d of DOCUMENTS) if (!state.added.includes(d.id)) state.added.push(d.id);
  state.mode = "doc";
  renderDocTabs();
  renderDoc();
  renderGraph();
  renderSteps();
});
$("questions").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-q]");
  if (b) selectQuestion(b.dataset.q!);
});
$("k").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-k]");
  if (!b) return;
  state.k = Number(b.dataset.k);
  $("k").querySelectorAll("[data-k]").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
  if (state.question) selectQuestion(state.question);
});
$("theme").addEventListener("click", () => {
  const root = document.documentElement;
  root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
  try {
    localStorage.setItem("kg-theme", root.dataset.theme);
  } catch {
    // Private mode: the choice just isn't remembered.
  }
});

renderLegend();
selectDoc(state.doc);
renderResult();
if (state.question) selectQuestion(state.question);
