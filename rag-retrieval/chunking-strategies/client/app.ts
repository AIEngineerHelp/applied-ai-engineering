// Pick a document type and see how it is chunked: every chunk highlighted in
// the document, the context it carries, and a fixed-size split for contrast.

import { chunkDocument } from "../src/chunkers.ts";
import { estimateTokens } from "../src/tokens.ts";
import type { Chunk, Doc, Format, Range } from "../src/types.ts";
import { renderPreview } from "./preview.ts";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

interface Recipe {
  headline: string;
  lede: string;
  split: string;
  together: string;
  attach: string;
  why: string;
}

// How we chunk each type, in plain words. The code that does it is
// structureUnits() in src/chunkers.ts and the parsers in src/structure.ts.
const RECIPES: Record<string, Recipe> = {
  "api-docs": {
    headline: "Developer docs: one chunk per section",
    lede: "Technical docs are already divided by their authors. Every heading starts a new topic, so that is where we cut.",
    split: "At every heading (#, ##, ###). A section longer than the limit is split at paragraphs.",
    together: "A heading with its text, and code blocks with the prose that explains them. A heading with no text of its own joins the next section.",
    attach: "The page title and the path of parent headings, e.g. “Webhooks › Retries and delivery”.",
    why: "A question like “how often are webhooks retried?” matches the words in the heading path even when the section body never repeats them.",
  },
  "help-center": {
    headline: "FAQ: one question and its answer per chunk",
    lede: "Each FAQ entry is a complete, self-contained answer. Splitting inside one loses the question; merging several mixes unrelated answers.",
    split: "At every question heading.",
    together: "The question and its whole answer, never split.",
    attach: "The category heading, e.g. “International shipping”.",
    why: "Many FAQs repeat near-identical questions in different categories (domestic vs international claims). The category is what tells them apart.",
  },
  "research-report": {
    headline: "Research report: sections, then paragraphs",
    lede: "Reports are long prose with few headings. We follow the sections, and split long sections at paragraph breaks so no paragraph is cut in half.",
    split: "At section headings; inside a long section, at paragraph breaks.",
    together: "Whole paragraphs. A sentence is never cut.",
    attach: "The report title and the section heading, e.g. “5 Results”.",
    why: "A number like “0.81 AUC” is meaningless without knowing it comes from the Results section of this report.",
  },
  "rate-engine": {
    headline: "Source code: one chunk per function",
    lede: "A function is the unit people ask about. Cutting by character count splits functions in half and glues the end of one to the start of the next.",
    split: "At each top-level function and class; a large class is split into one chunk per method.",
    together: "A function with its decorators, docstring and the comments directly above it. Small constants join the next block.",
    attach: "The file name, and for a method, its class line, e.g. “class RateCalculator:”.",
    why: "An embedding of three mixed functions matches none of them well. One function per chunk keeps each vector about one thing.",
  },
  "service-catalog": {
    headline: "Table (CSV): groups of rows, header repeated",
    lede: "A row like “TW-STD-USEAEUWE,…,sea,22,26,1360,3.14” is just numbers. Only the header row says that 22 and 26 are transit days.",
    split: "Between rows, packing as many whole rows as fit in the size limit.",
    together: "Every row is kept whole.",
    attach: "The table title and the header row, repeated in every chunk.",
    why: "Without the header, neither the retriever nor the model can tell which column a value belongs to.",
  },
  "master-services-agreement": {
    headline: "Contract: one chunk per numbered clause",
    lede: "Legal text is organized into numbered clauses, and each clause is one obligation, right or exception.",
    split: "At each numbered clause (1.1, 9.3, …).",
    together: "The whole clause, from its number to the next clause.",
    attach: "The agreement title and the article heading, e.g. “9. LIMITATION OF LIABILITY”.",
    why: "“Except as provided in Section 9.3…” only makes sense when you know which article and agreement the clause belongs to.",
  },
  "incident-review": {
    headline: "Meeting transcript: groups of whole speaker turns",
    lede: "A single turn is often too short to mean anything (“Yes, the second one.”), so we pack consecutive turns together, but never cut one in half.",
    split: "Between speaker turns, packing turns up to the size limit.",
    together: "Every speaker turn, with its timestamp and speaker name.",
    attach: "The meeting title and date.",
    why: "Decisions and corrections are spread across turns that refer back to each other; keeping neighbouring turns together keeps that thread.",
  },
  "network-report": {
    headline: "Report with charts: each figure is its own chunk, linked to the text that cites it",
    lede: "A PDF parser (Docling, LlamaParse, Unstructured) turns each chart into an image plus its caption. A text-only pipeline drops the image, and with it every number that only the chart shows. We give each figure its own chunk and link it to the sentences that talk about it, even when they are sections away.",
    split: "Text at headings, as for any report. Each figure (image + caption) is cut out as its own chunk.",
    together: "An image and its caption, always. Never a chart in one chunk and its caption in another.",
    attach: "To the figure: the section path, a vision model's description of the image, and every sentence that cites it (“as Figure 2 shows”, “the diagram below”). To the citing text: a link back to the figure.",
    why: "Figure 4's percentages exist only in the image. Without a description, no text search can find them; without the link, retrieving “as Figure 2 shows” returns a sentence about a chart the model never sees.",
  },
  "launch-deck": {
    headline: "Slide deck: one chunk per slide, image and speaker notes included",
    lede: "Slide text is terse; the meaning lives in the image and the speaker notes. So the slide is the unit: title, bullets, image description and notes travel together, the way the presenter meant them.",
    split: "At every slide.",
    together: "The slide title, its bullets, its image and its speaker notes.",
    attach: "The deck title and a vision model's description of the slide image. A slide that says “the diagram on the previous slide” is linked to that slide.",
    why: "On the accuracy slide, the 3.1 h → 1.4 h drop is only in the chart; the notes just say “the drop on this chart”. The image description is the only text that carries the number.",
  },
  "scanner-manual": {
    headline: "Manual with diagrams: steps linked to the parts diagram",
    lede: "Service steps say “Remove the four screws (4) and lift the battery door (3)”. The numbers are callouts on an exploded-view diagram, so a step is meaningless without the diagram and the parts table that name them.",
    split: "At headings; each figure (image + caption) is its own chunk; the parts table stays whole.",
    together: "An image with its caption; a procedure's numbered steps.",
    attach: "To the diagram: its description (every callout and the part it points at) and the steps that use its callout numbers. Every step chunk links to the diagram and the parts table.",
    why: "Ask “how do I replace the battery door?” and the step alone says “(3)”. The link brings back the diagram and table that say callout 3 is the battery door.",
  },
};

interface Entry extends Doc {
  file: string;
  kind: string;
}

const manifest: (Omit<Entry, "text" | "images"> & { images?: string })[] = await (await fetch("corpus/manifest.json")).json();
const docs: Entry[] = await Promise.all(
  manifest.map(async (m) => ({
    ...m,
    text: await (await fetch(`corpus/${m.file}`)).text(),
    images: m.images ? await (await fetch(`corpus/${m.images}`)).json() : undefined,
  })),
);

const ICONS: Record<Format, string> = {
  markdown: '<path d="M3 3h10v10H3z"/><path d="M5.5 6h5M5.5 8h5M5.5 10h3"/>',
  code: '<path d="m6 5-3 3 3 3M10 5l3 3-3 3"/>',
  table: '<path d="M2.5 3.5h11v9h-11zM2.5 6.5h11M2.5 9.5h11M6.5 3.5v9"/>',
  contract: '<path d="M4 2.5h6l2.5 2.5v8.5H4z"/><path d="M6 7h4.5M6 9h4.5M6 11h3"/>',
  transcript: '<path d="M2.5 4h8v5h-4l-2.5 2V9h-1.5z"/><path d="M12 6.5h1.5v5H12v1.5l-2-1.5H7"/>',
  figures: '<rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="m4.5 11 2.5-3 2 2 1.5-1.5 1.5 2.5"/><circle cx="6" cy="6" r="1"/>',
  slides: '<rect x="2" y="3" width="12" height="8" rx="1"/><path d="M8 11v2.5M5.5 13.5h5"/>',
};

// Full class names, so Tailwind can find them in this file.
const TINTS = ["bg-chunk-1", "bg-chunk-2", "bg-chunk-3", "bg-chunk-4", "bg-chunk-5", "bg-chunk-6"];
const RULE_DOTS = ["bg-blue-500", "bg-emerald-500", "bg-teal-500", "bg-amber-500"];

const state = { doc: "api-docs", method: "ours" as "ours" | "fixed", size: 400, selected: -1, view: "preview" as "preview" | "source" };
const params = new URLSearchParams(location.search);
if (docs.some((d) => d.id === params.get("type"))) state.doc = params.get("type")!;
if (params.get("method") === "fixed") state.method = "fixed";
if (params.get("view") === "source") state.view = "source";
if (Number(params.get("chunk")) > 0) state.selected = Number(params.get("chunk")) - 1;

// ---------- Sidebar ----------

$("types").innerHTML = docs
  .map(
    (d) => `<button type="button" role="tab" data-doc="${d.id}" class="flex flex-none items-center gap-2.5 rounded-xl border border-transparent px-2.5 py-2 text-left text-zinc-600 transition-[background-color,color,transform] duration-150 ease-out hover:bg-zinc-100 hover:text-zinc-900 active:scale-[0.98] aria-selected:border-zinc-200 aria-selected:bg-zinc-100 aria-selected:text-zinc-900 aria-selected:shadow-[inset_3px_0_0_var(--color-zinc-900)] md:w-full dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 dark:aria-selected:border-zinc-700 dark:aria-selected:bg-zinc-800 dark:aria-selected:text-zinc-100 dark:aria-selected:shadow-[inset_3px_0_0_var(--color-zinc-100)]">
      <svg class="size-[18px] flex-none" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">${ICONS[d.format]}</svg>
      <span class="grid min-w-0"><b class="text-sm font-semibold whitespace-nowrap">${esc(d.kind)}</b><small class="hidden truncate font-mono text-[11px] text-zinc-500 md:block">${esc(d.file)}</small></span>
    </button>`,
  )
  .join("");
$("types").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-doc]");
  if (!b) return;
  state.doc = b.dataset.doc!;
  state.selected = -1;
  history.replaceState(null, "", `?type=${state.doc}`);
  void render();
});

$("method").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-m]");
  if (!b) return;
  state.method = b.dataset.m as "ours" | "fixed";
  state.selected = -1;
  void render();
});
let timer: number | undefined;
$("size").addEventListener("input", (e) => {
  state.size = Number((e.target as HTMLInputElement).value);
  $("size-label").textContent = `${state.size} tokens`;
  clearTimeout(timer);
  timer = window.setTimeout(() => void render(), 100);
});
$("doc").addEventListener("click", (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-i]");
  if (!el) return;
  select(Number(el.dataset.i));
});
$("view").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-v]");
  if (!b) return;
  state.view = b.dataset.v as "preview" | "source";
  drawDoc();
});
$("links").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-i]");
  if (b) select(Number(b.dataset.i));
});
$("prev").addEventListener("click", () => select(state.selected - 1));
$("next").addEventListener("click", () => select(state.selected + 1));
$("doc").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowRight") select(state.selected + 1), e.preventDefault();
  if (e.key === "ArrowUp" || e.key === "ArrowLeft") select(state.selected - 1), e.preventDefault();
});
$("theme").addEventListener("click", () => {
  const root = document.documentElement;
  root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
  try {
    localStorage.setItem("chunking-theme", root.dataset.theme);
  } catch {
    // Not remembered; fine.
  }
});

// ---------- Rendering ----------

let chunks: Chunk[] = [];
let doc: Entry = docs[0];

// The part of the source a chunk is cut from (its last span; earlier spans
// are headings attached as context).
const body = (c: Chunk): Range => c.spans[c.spans.length - 1];

// A boundary is clean if it ends a sentence or a line.
function cleanEnd(text: string, at: number): boolean {
  if (at >= text.trimEnd().length) return true;
  if (/[.!?:;)"'`\]]$/.test(text.slice(Math.max(0, at - 1), at))) return true;
  return /^[ \t]*(\n|$)/.test(text.slice(at, at + 80));
}

async function render() {
  doc = docs.find((d) => d.id === state.doc)!;
  const recipe = RECIPES[doc.id];
  for (const b of $("types").querySelectorAll<HTMLButtonElement>("button")) b.setAttribute("aria-selected", String(b.dataset.doc === doc.id));
  for (const b of $("method").querySelectorAll<HTMLButtonElement>("button")) b.setAttribute("aria-selected", String(b.dataset.m === state.method));

  $("kind").textContent = doc.kind;
  $("headline").textContent = recipe.headline;
  $("lede").textContent = recipe.lede;
  $("rules").innerHTML = [
    ["Split at", recipe.split],
    ["Keep together", recipe.together],
    ["Attach to every chunk", recipe.attach],
    ["Why it matters", recipe.why],
  ]
    .map(
      ([t, d], i) =>
        `<div class="rounded-xl border border-zinc-200 bg-white px-3.5 py-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"><b class="mb-1.5 flex items-center gap-2 text-[11px] font-bold tracking-wider text-zinc-500 uppercase"><i class="size-2 rounded-sm ${RULE_DOTS[i]}"></i>${t}</b><p class="text-sm leading-normal">${esc(d)}</p></div>`,
    )
    .join("");
  const visual = doc.format === "figures" || doc.format === "slides";
  $("production").classList.toggle("hidden", !visual);
  if (visual) $("production").innerHTML = PRODUCTION;
  $("file").textContent = `${doc.file} · ${estimateTokens(doc.text).toLocaleString()} tokens`;

  chunks = chunkDocument(doc, state.method === "ours" ? "structure" : "fixed", { size: state.size });
  const sizes = chunks.map((c) => estimateTokens(c.text));
  const mean = Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length);
  const cuts = chunks.filter((c) => !cleanEnd(doc.text, body(c)[1])).length;
  $("summary").innerHTML =
    state.method === "ours"
      ? `<b class="font-semibold text-zinc-900 dark:text-zinc-100">${chunks.length} chunks</b>, ${mean} tokens on average. Every cut falls at a ${unitWord(doc.format)} boundary, and each chunk carries its context.`
      : `<b class="font-semibold text-zinc-900 dark:text-zinc-100">${chunks.length} chunks</b> of up to ${state.size} tokens. <b class="font-semibold text-red-600 dark:text-red-400">${cuts} of ${chunks.length} cuts</b> land inside a sentence, line or ${unitWord(doc.format)}, and no chunk knows which section it came from.`;
  // Start on the chunk that best shows the method: a linked figure if there is
  // one, else the first chunk that carries context.
  if (state.selected < 0) {
    // In the fixed-size view, a chunk that swallowed an image shows what is lost.
    const figure = chunks.findIndex((c) => (c.image && c.links?.length) || (state.method === "fixed" && /!\[[^\]]*\]\(/.test(c.text)));
    state.selected = figure >= 0 ? figure : Math.max(0, chunks.findIndex((c) => c.spans.length > 1));
  }
  state.selected = Math.min(state.selected, chunks.length - 1);
  drawDoc();
  drawChunk();
}

function unitWord(f: Format): string {
  return { markdown: "section", code: "function", table: "row", contract: "clause", transcript: "speaker-turn", figures: "section or figure", slides: "slide" }[f];
}

function drawDoc() {
  const text = doc.text;
  const sel = chunks[state.selected];
  const context = sel.spans.slice(0, -1);
  for (const b of $("view").querySelectorAll<HTMLButtonElement>("button")) b.setAttribute("aria-selected", String(b.dataset.v === state.view));
  const view = $("doc");
  if (state.view === "preview") {
    view.classList.remove("font-mono", "whitespace-pre-wrap", "text-[12.5px]");
    view.innerHTML = renderPreview(doc.format, {
      text,
      bodies: chunks.map(body),
      context,
      selected: state.selected,
      cuts: new Set(chunks.map((c) => body(c)[1]).filter((e) => !cleanEnd(text, e))),
      tints: TINTS,
      linked: new Set(sel.links ?? []),
      assetBase: "corpus/",
    });
    scrollToSelected();
    // Images change the layout as they load; keep the selection in view.
    for (const img of view.querySelectorAll("img")) img.addEventListener("load", scrollToSelected, { once: true });
    return;
  }
  view.classList.add("font-mono", "whitespace-pre-wrap", "text-[12.5px]");
  let html = "";
  let at = 0;
  chunks.forEach((c, i) => {
    const [s, e] = body(c);
    const lo = Math.max(s, at);
    if (lo > at) html += plain(at, lo, context);
    html += `<span class="ck ${TINTS[i % 6]}${i === state.selected ? " sel" : " dim"}" data-i="${i}" data-n="${i + 1}">${plain(lo, e, context)}</span>`;
    if (!cleanEnd(text, e)) html += `<i class="cut" title="This cut falls inside a sentence or line"></i>`;
    at = e;
  });
  html += plain(at, text.length, context);
  view.innerHTML = html;
  scrollToSelected();
}

// Keep the selected chunk in view, scrolling the document panel only.
function scrollToSelected() {
  const view = $("doc");
  const el = view.querySelector<HTMLElement>(`[data-i="${state.selected}"]`);
  if (!el) return;
  const top = el.getBoundingClientRect().top - view.getBoundingClientRect().top + view.scrollTop;
  if (top < view.scrollTop || top > view.scrollTop + view.clientHeight - 60) view.scrollTop = top - 40;
}

// Plain text, with any attached-context ranges outlined.
function plain(s: number, e: number, context: Range[]): string {
  let out = "";
  let at = s;
  for (const [a, b] of context) {
    const lo = Math.max(a, s);
    const hi = Math.min(b, e);
    if (lo >= hi) continue;
    out += esc(doc.text.slice(at, lo)) + `<mark class="ctx">${esc(doc.text.slice(lo, hi))}</mark>`;
    at = hi;
  }
  return out + esc(doc.text.slice(at, e));
}

// How production systems handle images, from their documentation (checked 2026-10-07).
const link = (href: string, text: string) => `<a href="${href}" target="_blank" rel="noopener" class="text-teal-700 underline decoration-teal-700/30 underline-offset-2 hover:decoration-teal-700 dark:text-teal-300">${text}</a>`;
const APPROACHES: { title: string; tag: string; body: string; who: string }[] = [
  {
    title: "1. Describe the image, embed the text",
    tag: "What this app shows",
    body: "A vision-language model writes a description of each meaningful image (chart values, diagram labels, callouts). The description is embedded with the caption and section, and the original image is stored and handed to a multimodal model at answer time. It costs one model call per image, and descriptions can miss visual relationships: AWS rates its own approach “Limited” for technical diagrams.",
    who: `${link("https://docs.unstructured.io/ui/enriching/image-descriptions", "Unstructured image descriptions")}, ${link("https://docling-project.github.io/docling/usage/enrichments/", "Docling picture description")}, ${link("https://learn.microsoft.com/en-us/azure/search/multimodal-search-overview", "Azure AI Search GenAI Prompt skill")}, ${link("https://docs.aws.amazon.com/bedrock/latest/userguide/kb-multimodal-choose-approach.html", "Bedrock Data Automation")}, ${link("https://docs.cloud.google.com/document-ai/docs/layout-parse-chunk", "Google Layout Parser image annotation")}, ${link("https://docs.databricks.com/aws/en/sql/language-manual/functions/ai_parse_document", "Databricks ai_parse_document")}`,
  },
  {
    title: "2. Embed the image itself",
    tag: "Multimodal embeddings",
    body: "A multimodal embedding model turns the image, or the image and its nearby text together, into one vector. Search can then match what the picture looks like, and even take an image as the query. Azure suggests this for photos and screenshots, and describing for diagrams and flowcharts; many systems store both.",
    who: `${link("https://ai.google.dev/gemini-api/docs/embeddings", "Gemini Embedding 2")} and ${link("https://docs.voyageai.com/docs/multimodal-embeddings", "Voyage multimodal-3.5")} (text and images interleaved in one input), ${link("https://docs.cohere.com/docs/cohere-embed", "Cohere Embed")}, ${link("https://docs.aws.amazon.com/bedrock/latest/userguide/kb-multimodal.html", "Amazon Nova Multimodal Embeddings")}`,
  },
  {
    title: "3. Embed whole pages, skip parsing",
    tag: "Page images",
    body: "ColPali embeds a screenshot of each page as about 1,024 patch vectors and scores them against the query with late interaction. In its paper it beat a parse-and-caption pipeline on the ViDoRe benchmark (nDCG@5 81.3 vs 67.0) and indexed pages faster (0.39 s vs 7.22 s per page). It suits slides and visually dense pages; text search usually runs alongside it.",
    who: `${link("https://arxiv.org/abs/2407.01449", "ColPali paper")}, ${link("https://blog.vespa.ai/scaling-colpali-to-billions/", "Vespa at scale")}, ${link("https://developers.llamaindex.ai/llamaparse/cloud-index/guides/retrieval/images/index.md", "LlamaCloud page screenshots")}`,
  },
];
const LINKS: [string, string][] = [
  ["Caption kept with the figure", `Parsers return the caption as part of the figure: ${link("https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/concept/analyze-document-response", "Document Intelligence")} <code>figures[].caption</code>, Unstructured <code>FigureCaption</code>, Docling captions in chunk metadata.`],
  ["Same section", `${link("https://docs.unstructured.io/open-source/core-functionality/chunking", "chunk_by_title")} keeps an image's description inside its section's chunk; Google keeps each chunk inside one layout block and adds its headings.`],
  ["Page and position", `Azure stores the page and bounding polygon of each image (<code>locationMetadata</code>); Databricks and Snowflake return bounding boxes, so an app can show the image next to the text it came from.`],
  ["Search text, return pixels", `Index the description, but keep a pointer to the original image and pass it to a multimodal model with the answer (${link("https://blog.langchain.com/semi-structured-multi-modal-rag", "LangChain multi-vector retriever")}, Bedrock's S3 figure files, Azure's image records).`],
  ["“See Figure 3” across the document", "We found no platform that documents resolving explicit references to a figure elsewhere in the document. This app does it with simple pattern matching (“Figure N”, “the chart below”, “previous slide”, callout numbers), which is easy to add after any of the parsers above."],
];
const PRODUCTION = `
  <div class="mb-4 flex flex-wrap items-baseline justify-between gap-2">
    <h2 id="production-title" class="text-lg font-bold tracking-tight">How production systems handle images</h2>
    <span class="text-xs text-zinc-500">From each vendor's documentation, checked 7 October 2026</span>
  </div>
  <p class="mb-4 max-w-3xl text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">First, a parser (Docling, Unstructured, LlamaParse, Azure Document Intelligence, Google Layout Parser) splits a PDF or slide deck into typed elements: headings, paragraphs, tables and pictures with their captions, page numbers and positions. Then the image's meaning has to reach the index in one of three ways:</p>
  <div class="grid gap-3 lg:grid-cols-3">${APPROACHES.map(
    (a) => `<div class="rounded-xl border border-zinc-200 p-4 dark:border-zinc-700"><p class="mb-1 text-[11px] font-bold tracking-widest text-teal-600 uppercase dark:text-teal-400">${a.tag}</p><h3 class="mb-2 font-semibold">${a.title}</h3><p class="mb-3 text-[13.5px] leading-relaxed">${a.body}</p><p class="text-[12.5px] leading-relaxed text-zinc-500"><b class="font-semibold text-zinc-600 dark:text-zinc-300">Used by:</b> ${a.who}</p></div>`,
  ).join("")}</div>
  <h3 class="mt-5 mb-2 font-semibold">How the image stays linked to its text</h3>
  <dl class="grid gap-x-5 gap-y-2 text-[13.5px] leading-relaxed sm:grid-cols-[200px_minmax(0,1fr)] [&_code]:rounded [&_code]:bg-zinc-100 [&_code]:px-1 [&_code]:font-mono [&_code]:text-[12px] dark:[&_code]:bg-zinc-800">${LINKS.map(([k, v]) => `<dt class="font-semibold">${k}</dt><dd class="mb-1.5 text-zinc-600 sm:mb-0 dark:text-zinc-400">${v}</dd>`).join("")}</dl>
  <p class="mt-4 text-xs text-zinc-500">In this demo, the image descriptions were written for the example to stand in for a vision model's output.</p>`;

const BOX = "mb-2.5 block rounded-lg border-[1.5px] border-dashed border-teal-500 px-2 py-1.5 text-teal-700 dark:text-teal-300";
const BOX_LABEL = "mb-1 block font-sans text-[10px] font-bold tracking-widest uppercase";

function drawChunk() {
  const c = chunks[state.selected];
  const [s, e] = body(c);
  const source = doc.text.slice(s, e);
  // Embedded text = attached context, the chunk's own text, then anything
  // added for a figure (its description and the sentences that cite it).
  const at = c.text.indexOf(source);
  const header = at > 0 ? c.text.slice(0, at) : "";
  const extra = at >= 0 ? c.text.slice(at + source.length).trim() : "";
  $("chunk-title").textContent = `Chunk ${state.selected + 1} of ${chunks.length}${c.image ? " · contains an image" : ""}`;

  const image = c.image
    ? `<span class="mb-2.5 block rounded-lg border border-zinc-200 bg-white p-2 font-sans dark:border-zinc-700"><img src="corpus/${esc(c.image.file)}" alt="${esc(c.image.alt)}" class="mx-auto block max-h-40 w-auto max-w-full"><span class="mt-1.5 block text-[11px] text-zinc-500">The image itself is stored with the chunk and passed to a multimodal model when this chunk is retrieved.</span></span>`
    : "";
  $("chunk").innerHTML =
    image +
    (header ? `<span class="${BOX}"><span class="${BOX_LABEL}">Context we attach</span>${esc(header.trimEnd())}</span>` : "") +
    `<span class="rounded-[3px] box-decoration-clone ${TINTS[state.selected % 6]}">${esc(source)}</span>` +
    (extra ? `<span class="${BOX} mt-2.5 mb-0"><span class="${BOX_LABEL}">Added so the image can be found by text (description stands in for a vision model's)</span>${esc(extra)}</span>` : "");

  const clean = cleanEnd(doc.text, e);
  const dropped = !c.image && /!\[[^\]]*\]\(/.test(source);
  const facts: [string, string, boolean?][] = [
    ["Size", `${estimateTokens(c.text)} tokens${header ? ` (${estimateTokens(header)} of them context)` : ""}`],
    ["Section", c.label || (state.method === "ours" ? "Top of the document" : "Unknown: fixed-size chunks don't track sections")],
    ["Ends", clean ? "At a clean boundary" : "Mid-sentence: the rest is in the next chunk", !clean],
  ];
  if (dropped) facts.push(["Image", "Only its file name and alt text are embedded. What the image shows is invisible to search.", true]);
  $("facts").innerHTML = facts.map(([k, v, bad]) => `<dt>${k}</dt><dd${bad ? ' class="text-red-600 dark:text-red-400"' : ""}>${esc(v)}</dd>`).join("");

  $("links").innerHTML = c.links?.length
    ? `<p class="mb-1.5 text-[11px] font-bold tracking-widest text-zinc-500 uppercase">Returned together with</p>` +
      c.links
        .map(
          (j, k) =>
            `<button type="button" data-i="${j}" class="mb-1.5 flex w-full items-start gap-2.5 rounded-lg border border-teal-500/40 bg-teal-50/60 px-2.5 py-2 text-left text-[13px] transition-colors hover:bg-teal-50 dark:bg-teal-950/30 dark:hover:bg-teal-950/60"><span class="mt-px rounded bg-teal-600 px-1.5 py-0.5 text-[10px] font-semibold text-white">${j + 1}</span><span><b class="font-semibold">${esc(chunkName(j))}</b><span class="block text-zinc-600 dark:text-zinc-400">${esc(c.linkReasons?.[k] ?? "")}</span></span></button>`,
        )
        .join("")
    : "";
  ($("prev") as HTMLButtonElement).disabled = state.selected === 0;
  ($("next") as HTMLButtonElement).disabled = state.selected === chunks.length - 1;
}

function chunkName(i: number): string {
  const c = chunks[i];
  if (c.image?.number) return `Chunk ${i + 1}: Figure ${c.image.number}`;
  const first = doc.text.slice(...body(c)).split("\n")[0].replace(/^#+\s*|^\d+\.\s*/, "");
  return `Chunk ${i + 1}: ${first.length > 60 ? `${first.slice(0, 57)}…` : first}`;
}

function select(i: number) {
  if (i < 0 || i >= chunks.length) return;
  state.selected = i;
  drawDoc();
  drawChunk();
}

await render();
