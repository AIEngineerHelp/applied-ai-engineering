// The guided app: 1. ingest five sources, 2. lint the wiki, 3. ask a question.
// All data comes from results/run.json, built by `npm run data`; this file only presents it.

import runJson from "../results/run.json" with { type: "json" };
import type { Change, QuestionResult, Run, Step } from "../src/build.ts";
import type { Finding } from "../src/lint.ts";
import type { FactResult } from "../src/retrieve.ts";
import { edgeKey, graphSvg, LEGEND, type GraphMarks } from "./graph.ts";
import { diffHtml, esc, linesHtml, mdLine, type Highlight } from "./render.ts";

const RUN = runJson as unknown as Run;
const INGESTS = RUN.steps.filter((s) => s.kind === "ingest");
const FIX = RUN.steps.find((s) => s.kind === "lint")!;
const LAST_INGEST = INGESTS[INGESTS.length - 1];

type View = 1 | 2 | 3;
type Tab = "index" | "log" | "schema";

interface State {
  view: View;
  /** Sources ingested so far, 0 to 5. */
  n: number;
  file: string | null;
  tab: Tab;
  fixed: boolean;
  finding: number;
  q: string;
}

const params = new URLSearchParams(location.search);
const state: State = {
  view: clampView(Number(params.get("step") ?? 1)),
  n: Math.max(0, Math.min(INGESTS.length, Number(params.get("n") ?? 0) || 0)),
  file: null,
  tab: "index",
  fixed: params.get("fixed") === "1",
  finding: 0,
  q: RUN.questions.some((q) => q.id === params.get("q")) ? params.get("q")! : RUN.questions[0].id,
};
if (state.view > 1 && !params.has("n")) state.n = INGESTS.length;

function clampView(v: number): View {
  return v === 2 || v === 3 ? v : 1;
}

const $ = (id: string) => document.getElementById(id)!;

// ---------------------------------------------------------------- shell

function render() {
  renderStepper();
  const stage = $("stage");
  if (state.view === 1) stage.innerHTML = ingestView();
  else if (state.view === 2) stage.innerHTML = lintView();
  else stage.innerHTML = askView();
  $("verdict").innerHTML = verdictHtml();
  $("verdict").dataset.tone = verdictTone();
  const log = document.querySelector<HTMLElement>("[data-scroll-end]");
  if (log) log.scrollTop = log.scrollHeight;
  syncUrl();
}

function syncUrl() {
  const p = new URLSearchParams();
  p.set("step", String(state.view));
  if (state.view === 1) p.set("n", String(state.n));
  if (state.view === 2 && state.fixed) p.set("fixed", "1");
  if (state.view === 3) p.set("q", state.q);
  const theme = params.get("theme");
  if (theme) p.set("theme", theme);
  history.replaceState(null, "", `?${p}`);
}

function renderStepper() {
  const steps: { v: View; title: string; sub: string }[] = [
    { v: 1, title: "Ingest", sub: "Five sources, one at a time" },
    { v: 2, title: "Lint", sub: "Check the whole wiki" },
    { v: 3, title: "Ask", sub: "Wiki pages vs chunk RAG" },
  ];
  const done = (v: View) => (v === 1 ? state.n === INGESTS.length : v === 2 ? state.fixed || state.view === 3 : false);
  $("stepper").innerHTML = steps
    .map(
      (s) => `<li><button type="button" class="step w-full" data-view="${s.v}" ${state.view === s.v ? 'aria-current="step"' : ""} data-done="${done(s.v) && state.view !== s.v}">
        <span class="step-num">${done(s.v) && state.view !== s.v ? "✓" : s.v}</span>
        <span class="min-w-0"><span class="block text-[14px] font-semibold leading-tight">${s.title}</span><span class="hidden truncate text-[12px] text-muted sm:block">${s.sub}</span></span>
      </button></li>`,
    )
    .join("");
}

// ---------------------------------------------------------------- verdicts

function verdictTone(): string {
  if (state.view === 2) return state.fixed ? "good" : "warn";
  if (state.view === 3) {
    const q = currentQuestion();
    return wrongCount(q.ragFacts) > 0 ? "warn" : "good";
  }
  return "accent";
}

function verdictHtml(): string {
  let kicker = "";
  let text = "";
  let lesson = "";
  let actions = "";
  let tags = "";
  if (state.view === 1) {
    const step = state.n > 0 ? INGESTS[state.n - 1] : null;
    kicker = state.n === 0 ? "Step 1 · Ingest" : `Step 1 · Ingested source ${state.n} of ${INGESTS.length}`;
    text = step
      ? step.verdict
      : `The wiki is empty. Five sources about one small project are waiting: kickoff notes, a design doc, an incident report, a chat thread and a draft FAQ. Ingest them one at a time and watch the agent write and rewrite its pages.`;
    lesson = step?.lesson ?? "Each ingest shows the pages the agent wrote as a diff, the links it added, and the new lines in the index and log.";
    tags = step ? `<span class="tag tag-scripted">Scripted pages</span><span class="tag tag-computed">Computed diffs, links, index, log</span>` : "";
    const next =
      state.n < INGESTS.length
        ? `<button type="button" class="btn btn-primary" data-act="next">${state.n === 0 ? "Ingest the first source" : `Ingest source ${state.n + 1}`} <span aria-hidden="true">→</span></button>`
        : `<button type="button" class="btn btn-primary" data-act="to-lint">Next: lint the wiki <span aria-hidden="true">→</span></button>`;
    actions = `<button type="button" class="btn" data-act="prev" ${state.n === 0 ? "disabled" : ""} aria-label="Previous source"><span aria-hidden="true">←</span> Back</button>${next}`;
  } else if (state.view === 2) {
    const before = RUN.lintBefore;
    const claims = LAST_INGEST.claims.current;
    if (!state.fixed) {
      kicker = "Step 2 · Lint";
      const c = before.checks.find((x) => x.kind === "contradiction")!.count;
      const m = before.checks.find((x) => x.kind === "missing-page")!.count;
      text = `Lint compared all ${claims} current claims across ${LAST_INGEST.pages.length} pages and found ${plural(c, "contradiction")} and ${plural(m, "link")} to a page that doesn't exist. The draft FAQ disagrees with the approved design and with Amara's decision.`;
      lesson = "No single ingest could see this: each one only opened the pages its source was about. Lint reads every claim at once, then proposes fixes for a person to approve.";
      tags = `<span class="tag tag-computed">Computed lint</span>`;
      actions = `<button type="button" class="btn" data-act="to-ingest"><span aria-hidden="true">←</span> Ingest</button><button type="button" class="btn btn-primary" data-act="fix">Apply the approved fixes</button>`;
    } else {
      kicker = "Step 2 · Fixed";
      text = `${FIX.verdict} Lint now finds ${RUN.lintAfter.findings.length} problems.`;
      lesson = FIX.lesson;
      tags = `<span class="tag tag-scripted">Scripted fix</span><span class="tag tag-computed">Computed re-lint</span>`;
      actions = `<button type="button" class="btn" data-act="unfix">Undo fixes</button><button type="button" class="btn btn-primary" data-act="to-ask">Next: ask a question <span aria-hidden="true">→</span></button>`;
    }
  } else {
    const q = currentQuestion();
    kicker = "Step 3 · Ask";
    const wNeed = neededFound(q.wikiFacts);
    const rNeed = neededFound(q.ragFacts);
    const rWrong = wrongCount(q.ragFacts);
    const wWrong = wrongCount(q.wikiFacts);
    const total = q.wikiFacts.filter((f) => f.kind === "needed").length;
    if (rWrong > 0 && wWrong === 0) {
      text = `Both found the current answer (${wNeed} of ${total} facts in the wiki pages, ${rNeed} of ${total} in the chunks). But chunk RAG also returned ${plural(rWrong, "outdated or wrong statement")}, and nothing in the chunks says which version is current. The wiki pages had already settled that when the sources were ingested.`;
      lesson = "RAG leaves reconciling sources to the model at question time, every time. The wiki does it once, at ingest and lint, and keeps the result.";
    } else if (rNeed < total && wNeed === total) {
      text = `The wiki pages contain all ${total} facts the answer needs; the top chunks contain ${rNeed}.`;
      lesson = "A compiled page gathers facts that are spread across several sources.";
    } else {
      text = `Both approaches found everything the answer needs (${wNeed} of ${total}) and nothing misleading. When one source holds the whole answer and nothing has changed since, plain chunk RAG does as well as the wiki.`;
      lesson = "Wiki memory pays off when sources update or contradict each other; for single-source lookups it adds upkeep without a better answer.";
    }
    tags = `<span class="tag tag-computed">Computed BM25 and fact checks</span>`;
    actions = `<button type="button" class="btn" data-act="to-lint"><span aria-hidden="true">←</span> Lint</button><button type="button" class="btn" data-act="restart">Start over</button>`;
  }
  return `<div class="flex flex-col gap-3 md:flex-row md:items-center md:gap-6">
    <div class="min-w-0 flex-1 fade-in">
      <div class="flex flex-wrap items-center gap-2"><span class="kicker">${kicker}</span>${tags}</div>
      <p class="mt-1.5 text-[15.5px] leading-[1.55] text-ink">${esc(text)}</p>
      <p class="mt-1 text-[13.5px] leading-[1.55] text-muted">${esc(lesson)}</p>
    </div>
    <div class="flex shrink-0 flex-wrap gap-2">${actions}</div>
  </div>`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const neededFound = (facts: FactResult[]) => facts.filter((f) => f.kind === "needed" && f.found).length;
const wrongCount = (facts: FactResult[]) => facts.filter((f) => f.kind === "wrong" && f.found).length;
const currentQuestion = () => RUN.questions.find((q) => q.id === state.q)!;

// ---------------------------------------------------------------- step 1: ingest

function ingestView(): string {
  const step = state.n > 0 ? INGESTS[state.n - 1] : null;
  const prev = state.n > 1 ? INGESTS[state.n - 2] : null;
  return `<div class="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)] xl:grid-cols-[300px_minmax(0,1fr)_minmax(0,430px)]">
    ${sourcesCard()}
    ${changesCard(step?.changes ?? [], step ? "Pages written by this ingest" : "Pages", step?.focus)}
    <div class="grid gap-4 lg:col-span-2 lg:grid-cols-2 xl:col-span-1 xl:grid-cols-1 xl:content-start">
      ${graphCard(step, marksForStep(step, prev))}
      ${filesCard(step, prev)}
    </div>
  </div>`;
}

function sourcesCard(): string {
  const current = state.n > 0 ? RUN.sources[state.n - 1] : null;
  const rows = RUN.sources
    .map((s, i) => {
      const st = i < state.n - 1 ? "done" : i === state.n - 1 ? "now" : "todo";
      return `<li><button type="button" class="src-row" data-goto="${i + 1}" data-state="${st}" ${st === "now" ? 'aria-current="true"' : ""}>
        <span class="src-dot"></span>
        <span class="min-w-0 flex-1"><span class="block truncate text-[13px] font-medium">${esc(INGESTS[i].title)}</span><span class="mono block text-[11px] text-muted">${s.date}</span></span>
      </button></li>`;
    })
    .join("");
  const raw = current
    ? `<div class="border-t border-rule">
        <div class="px-4 pt-3 pb-1"><span class="card-title">Raw source</span><span class="mono block truncate text-[11px] text-muted">raw/${esc(current.file)}</span></div>
        <div class="code max-h-[220px] overflow-auto pb-3 fade-in lg:max-h-[340px]">${linesHtml(current.text)}</div>
      </div>`
    : `<div class="border-t border-rule px-4 py-4 text-[13px] leading-relaxed text-muted">Raw sources are never edited. The agent reads each one and writes only to the wiki.</div>`;
  return `<section class="card self-start overflow-hidden" aria-label="Sources">
    <div class="card-head"><span class="card-title">Sources</span><span class="mono text-[11px] text-muted">${state.n} of ${RUN.sources.length} ingested</span></div>
    <ol class="p-1.5">${rows}</ol>
    ${raw}
  </section>`;
}

function changesCard(changes: Change[], title: string, focus?: string): string {
  if (changes.length === 0) {
    return `<section class="card self-start" aria-label="${title}">
      <div class="card-head"><span class="card-title">${title}</span></div>
      <div class="grid min-h-[280px] place-items-center px-6 py-10 text-center">
        <div class="max-w-sm">
          <p class="font-serif text-[19px]">No pages yet</p>
          <p class="mt-2 text-[13.5px] leading-relaxed text-muted">The first ingest will create a page for the source, one for each person, system and policy it mentions, and an overview. Later ingests mostly rewrite those pages.</p>
        </div>
      </div>
    </section>`;
  }
  const selected = changes.find((c) => c.slug === state.file) ?? changes.find((c) => c.slug === focus) ?? changes[0];
  const created = changes.filter((c) => c.status === "created").length;
  const updated = changes.length - created;
  const chips = changes
    .map(
      (c) => `<button type="button" class="chip" data-file="${c.slug}" aria-pressed="${c.slug === selected.slug}">
        <span class="tag tag-${c.status}">${c.status === "created" ? "new" : "edit"}</span>
        <span class="mono truncate text-[12px]">${esc(c.path)}</span>
        <span class="mono shrink-0 text-[11px]"><span class="text-add">+${c.added}</span>${c.removed ? ` <span class="text-del">−${c.removed}</span>` : ""}</span>
      </button>`,
    )
    .join("");
  return `<section class="card self-start overflow-hidden" aria-label="${title}">
    <div class="card-head"><span class="card-title">${title}</span><span class="text-[12px] text-muted">${created} created · ${updated} updated</span></div>
    <div class="flex flex-wrap gap-1.5 border-b border-rule px-3 py-3">${chips}</div>
    <div class="flex items-center justify-between gap-3 px-4 pt-3 pb-1">
      <span class="mono truncate text-[12px] font-medium">wiki/${esc(selected.path)}</span>
      <span class="shrink-0 text-[11.5px] text-muted">${selected.status === "created" ? "new page" : "diff against the previous version"}</span>
    </div>
    <div class="code max-h-[560px] overflow-auto pb-3 fade-in" data-diff>${diffHtml(selected.diff)}</div>
  </section>`;
}

function marksForStep(step: Step | null, prev: Step | null): GraphMarks {
  if (!step) return {};
  const before = new Set((prev?.graph.edges ?? []).map((e) => edgeKey(e.from, e.to)));
  return {
    created: new Set(step.changes.filter((c) => c.status === "created").map((c) => c.slug)),
    touched: new Set(step.changes.filter((c) => c.status === "updated").map((c) => c.slug)),
    newEdges: new Set(step.graph.edges.map((e) => edgeKey(e.from, e.to)).filter((k) => !before.has(k))),
  };
}

function graphCard(step: Step | null, marks: GraphMarks): string {
  const pages = step?.pages.length ?? 0;
  const links = step?.graph.edges.length ?? 0;
  const claims = step?.claims ?? { current: 0, superseded: 0, disputed: 0 };
  const newLinks = marks.newEdges?.size ?? 0;
  const body = step
    ? graphSvg(step.graph, RUN.layout, marks)
    : `<div class="grid aspect-[3/2] place-items-center text-[13px] text-muted">The link graph appears with the first page.</div>`;
  return `<section class="card overflow-hidden" aria-label="Link graph">
    <div class="card-head"><span class="card-title">Link graph</span>${newLinks ? `<span class="text-[12px] text-accent">+${plural(newLinks, "new link")}</span>` : ""}</div>
    <div class="grid grid-cols-4 gap-2 border-b border-rule px-4 py-3">
      <div class="stat"><span class="stat-num">${pages}</span><span class="stat-label">pages</span></div>
      <div class="stat"><span class="stat-num">${links}</span><span class="stat-label">links</span></div>
      <div class="stat"><span class="stat-num">${claims.current}</span><span class="stat-label">current claims</span></div>
      <div class="stat"><span class="stat-num">${claims.superseded + claims.disputed}</span><span class="stat-label">struck through</span></div>
    </div>
    <div class="px-2 pt-1">${body}</div>
    <div class="border-t border-rule px-4 py-2.5">${LEGEND}</div>
  </section>`;
}

function filesCard(step: Step | null, prev: Step | null): string {
  const tabs: [Tab, string][] = [
    ["index", "index.md"],
    ["log", "log.md"],
    ["schema", "schema.md"],
  ];
  let content: string;
  let note: string;
  if (state.tab === "schema") {
    content = linesHtml(RUN.schema);
    note = "How the agent is told to keep the wiki";
  } else if (!step) {
    content = `<div class="px-4 py-6 text-[13px] text-muted">Empty until the first ingest.</div>`;
    note = "";
  } else {
    const text = state.tab === "index" ? step.index : step.log;
    const old = new Set(((state.tab === "index" ? prev?.index : prev?.log) ?? "").split("\n"));
    const fresh = new Set(text.split("\n").filter((l) => !old.has(l)));
    content = linesHtml(text, fresh);
    note = state.tab === "index" ? "Rebuilt after every change" : "Append-only";
  }
  return `<section class="card overflow-hidden" aria-label="Index, log and schema">
    <div class="card-head"><div class="tabs" role="tablist">${tabs
      .map(([id, label]) => `<button type="button" role="tab" class="tab" data-tab="${id}" aria-selected="${state.tab === id}">${label}</button>`)
      .join("")}</div><span class="hidden truncate text-[11.5px] text-muted sm:block">${note}</span></div>
    <div class="code max-h-[300px] overflow-auto py-2" ${state.tab === "log" ? "data-scroll-end" : ""}>${content}</div>
  </section>`;
}

// ---------------------------------------------------------------- step 2: lint

function lintView(): string {
  const result = state.fixed ? RUN.lintAfter : RUN.lintBefore;
  const findings = RUN.lintBefore.findings;
  const finding = findings[Math.min(state.finding, findings.length - 1)];
  const checks = result.checks
    .map(
      (c) => `<li class="flex items-center justify-between gap-3 px-4 py-2">
        <span class="text-[13px]">${c.label}</span>
        ${c.count > 0 ? `<span class="tag ${c.kind === "contradiction" ? "tag-warn" : "tag-bad"}">${c.count} found</span>` : `<span class="tag tag-good">✓ none</span>`}
      </li>`,
    )
    .join("");
  const list = findings
    .map(
      (f, i) => `<li><button type="button" class="chip w-full flex-col !items-start !gap-1 !px-3 !py-2.5" data-finding="${i}" aria-pressed="${!state.fixed && i === state.finding}">
        <span class="flex items-center gap-2">${kindTag(f)}${state.fixed ? '<span class="tag tag-good">resolved</span>' : ""}</span>
        <span class="text-[13px] font-medium ${state.fixed ? "text-muted line-through decoration-faint" : ""}">${inlineMd(f.title)}</span>
      </button></li>`,
    )
    .join("");
  const flagged = new Set(state.fixed ? [] : finding.pages);
  const graphStep = state.fixed ? FIX : LAST_INGEST;
  const marks: GraphMarks = state.fixed
    ? marksForStep(FIX, LAST_INGEST)
    : { flagged, focus: new Set([...finding.pages, ...finding.claims.map((c) => c.page)]) };
  if (!state.fixed && finding.kind === "missing-page") {
    const target = /\[\[([a-z0-9-]+)\]\]/.exec(finding.title)?.[1];
    if (target) {
      marks.flagged!.add(target);
      marks.focus!.add(target);
    }
  }
  return `<div class="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)] xl:grid-cols-[320px_minmax(0,1fr)_minmax(0,430px)]">
    <section class="card self-start overflow-hidden" aria-label="Lint checks">
      <div class="card-head"><span class="card-title">${state.fixed ? "Lint again, after fixes" : "Lint checks"}</span><span class="mono text-[11px] text-muted">${LAST_INGEST.pages.length} pages</span></div>
      <ul class="divide-y divide-rule border-b border-rule">${checks}</ul>
      <div class="px-4 pt-3 pb-1 card-title">Findings</div>
      <ul class="space-y-1.5 px-3 pb-3">${list}</ul>
    </section>
    ${state.fixed ? changesCard(FIX.changes, "Pages changed by the fixes", FIX.focus) : findingCard(finding)}
    <div class="lg:col-span-2 xl:col-span-1">${graphCard(graphStep, marks)}</div>
  </div>`;
}

function kindTag(f: Finding): string {
  const label = { contradiction: "Contradiction", "missing-page": "Missing page", orphan: "Orphan", "uncited-claim": "Uncited claim" }[f.kind];
  return `<span class="tag ${f.kind === "contradiction" ? "tag-warn" : "tag-bad"}">${label}</span>`;
}

/** Inline markdown for short labels: code spans and wiki links only. */
function inlineMd(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[\[([a-z0-9-]+)\]\]/g, '<span class="md-link mono text-[0.92em]">[[$1]]</span>');
}

function findingCard(f: Finding): string {
  let body = "";
  if (f.kind === "contradiction") {
    body = `<p class="px-4 pt-3 text-[13px] leading-relaxed text-muted">These claims describe the same fact and are all marked current. The agent recorded each one when its source was ingested.</p>
      <ul class="grid gap-2 p-4 sm:grid-cols-2">${f.claims
        .map((c) => {
          const page = LAST_INGEST.pages.find((p) => p.slug === c.page)!;
          const draft = c.source === "src-faq-draft";
          return `<li class="rounded-lg border ${draft ? "border-warn bg-warn-soft" : "border-rule"} p-3">
            <div class="mono text-[11px] text-muted">wiki/${esc(page.path)}</div>
            <div class="mono mt-1 text-[12px]">${esc(c.key)}</div>
            <div class="mt-1 font-serif text-[22px] leading-tight">${esc(c.value)}</div>
            <div class="mt-1.5 text-[12px] text-muted">from <span class="md-link mono">[[${esc(c.source)}]]</span> · as of ${c.asOf}</div>
            ${draft ? `<div class="mt-1.5 text-[12px] font-medium text-warn">An unreviewed draft</div>` : ""}
          </li>`;
        })
        .join("")}</ul>`;
  } else {
    const target = /\[\[([a-z0-9-]+)\]\]/.exec(f.title)?.[1] ?? "";
    const rows = f.pages
      .map((slug) => {
        const page = LAST_INGEST.pages.find((p) => p.slug === slug)!;
        const lines = page.text.split("\n").filter((l) => l.includes(`[[${target}]]`));
        return `<li class="rounded-lg border border-rule">
          <div class="mono border-b border-rule px-3 py-1.5 text-[11px] text-muted">wiki/${esc(page.path)}</div>
          <div class="code py-1.5">${lines.map((l) => `<div class="ln"><span class="ln-text">${mdLine(l)}</span></div>`).join("")}</div>
        </li>`;
      })
      .join("");
    body = `<p class="px-4 pt-3 text-[13px] leading-relaxed text-muted">${esc(f.detail)} A reader who follows any of these links finds nothing.</p><ul class="grid gap-2 p-4">${rows}</ul>`;
  }
  return `<section class="card self-start overflow-hidden" aria-label="Finding">
    <div class="card-head"><span class="flex min-w-0 items-center gap-2">${kindTag(f)}<span class="truncate text-[13px] font-medium">${inlineMd(f.title)}</span></span></div>
    <div class="fade-in">${body}
      <div class="mx-4 mb-4 rounded-lg bg-well px-3.5 py-3 text-[13px] leading-relaxed"><span class="font-semibold">Proposed fix.</span> ${esc(f.suggestion)}</div>
    </div>
  </section>`;
}

// ---------------------------------------------------------------- step 3: ask

function askView(): string {
  const q = currentQuestion();
  const chips = RUN.questions
    .map((x) => `<button type="button" class="chip !px-3 !py-2 !text-[13.5px]" data-q="${x.id}" aria-pressed="${x.id === q.id}">${esc(x.text)}</button>`)
    .join("");
  return `<div class="card mb-4 px-4 py-3">
      <div class="card-title mb-2">Pick a question</div>
      <div class="flex flex-wrap gap-2">${chips}</div>
    </div>
    <div class="grid gap-4 lg:grid-cols-2">
      ${wikiCard(q)}
      ${ragCard(q)}
    </div>`;
}

function highlightsFor(facts: FactResult[]): Highlight[] {
  return facts.map((f) => ({ pattern: f.pattern, tone: f.kind === "needed" ? "good" : "bad" }));
}

function scoreboard(facts: FactResult[]): string {
  const need = facts.filter((f) => f.kind === "needed");
  const wrong = facts.filter((f) => f.kind === "wrong");
  const found = need.filter((f) => f.found).length;
  const bad = wrong.filter((f) => f.found).length;
  const rows = facts
    .filter((f) => f.kind === "needed" || f.found)
    .map((f) => {
      const ok = f.kind === "needed" ? f.found : !f.found;
      const icon = ok ? `<span class="text-add">✓</span>` : `<span class="${f.kind === "wrong" ? "text-del" : "text-warn"}">${f.kind === "wrong" ? "!" : "✗"}</span>`;
      const label = f.kind === "needed" ? (f.found ? f.label : `${f.label} (missing)`) : `${f.label}`;
      return `<li class="flex gap-2.5 text-[13px] leading-snug"><span class="mono w-3 shrink-0 font-semibold">${icon}</span><span>${esc(label)}${f.kind === "wrong" && f.why ? `<span class="block text-[12px] text-muted">${esc(f.why)}</span>` : ""}</span></li>`;
    })
    .join("");
  return `<div class="grid grid-cols-2 gap-3 border-b border-rule px-4 py-3">
      <div class="stat"><span class="stat-num ${found === need.length ? "text-add" : "text-warn"}">${found}/${need.length}</span><span class="stat-label">facts the answer needs</span></div>
      <div class="stat"><span class="stat-num ${bad ? "text-del" : "text-add"}">${bad}</span><span class="stat-label">outdated or wrong statements</span></div>
    </div>
    <ul class="space-y-1.5 border-b border-rule px-4 py-3">${rows}</ul>`;
}

function wikiCard(q: QuestionResult): string {
  const hl = highlightsFor(q.wikiFacts);
  const pages = q.wiki
    .map(
      (p, i) => `<li class="rounded-lg border border-rule">
        <div class="flex items-center justify-between gap-2 border-b border-rule px-3 py-1.5"><span class="mono truncate text-[11.5px]">${i + 1}. wiki/${esc(p.path)}</span><span class="mono shrink-0 text-[11px] text-muted">BM25 ${p.score.toFixed(2)}</span></div>
        <div class="code max-h-[300px] overflow-auto py-1.5">${p.lines
          .map((l) => `<div class="ln"><span class="ln-text">${mdLine(l.text, l.struck ? [] : hl)}</span></div>`)
          .join("")}</div>
      </li>`,
    )
    .join("");
  return `<section class="card self-start overflow-hidden" aria-label="Wiki memory">
    <div class="card-head"><span class="flex items-center gap-2"><span class="legend-dot" style="background:var(--n-entity)"></span><span class="text-[14px] font-semibold">Wiki memory</span></span><span class="text-[12px] text-muted">top ${RUN.k.pages} topic pages</span></div>
    ${scoreboard(q.wikiFacts)}
    <ul class="space-y-2 p-3 fade-in">${pages}</ul>
    <div class="mx-3 mb-3 rounded-lg bg-well px-3.5 py-3">
      <div class="flex items-center gap-2"><span class="card-title">Example answer</span><span class="tag tag-scripted">Scripted</span></div>
      <p class="mt-1.5 text-[13.5px] leading-relaxed">${esc(q.wikiAnswer)}</p>
    </div>
  </section>`;
}

function ragCard(q: QuestionResult): string {
  const hl = highlightsFor(q.ragFacts);
  const chunks = q.rag
    .map((c, i) => {
      const wrong = q.ragFacts.filter((f) => f.kind === "wrong" && f.where.includes(c.id));
      const source = RUN.sources.find((s) => s.file === c.file)!;
      return `<li class="rounded-lg border ${wrong.length ? "border-del" : "border-rule"}">
        <div class="flex items-center justify-between gap-2 border-b border-rule px-3 py-1.5">
          <span class="min-w-0"><span class="mono block truncate text-[11.5px]">${i + 1}. raw/${esc(c.file)}</span><span class="block truncate text-[11.5px] text-muted">${esc(source.title)}${c.heading ? ` › ${esc(c.heading)}` : ""}</span></span>
          <span class="flex shrink-0 flex-col items-end gap-1"><span class="mono text-[11px] text-muted">BM25 ${c.score.toFixed(2)}</span>${wrong.length ? `<span class="tag tag-bad">outdated</span>` : ""}</span>
        </div>
        <div class="code py-1.5">${c.text
          .split("\n")
          .map((l) => `<div class="ln"><span class="ln-text">${mdLine(l, hl)}</span></div>`)
          .join("")}</div>
        ${wrong.length ? `<div class="border-t border-rule px-3 py-1.5 text-[12px] text-del">${wrong.map((w) => esc(w.why ?? "")).join(" · ")}</div>` : ""}
      </li>`;
    })
    .join("");
  return `<section class="card self-start overflow-hidden" aria-label="Chunk RAG">
    <div class="card-head"><span class="flex items-center gap-2"><span class="legend-dot" style="background:var(--n-source)"></span><span class="text-[14px] font-semibold">Chunk RAG</span></span><span class="text-[12px] text-muted">top ${RUN.k.chunks} of ${RUN.chunkCount} raw chunks</span></div>
    ${scoreboard(q.ragFacts)}
    <ul class="space-y-2 p-3 fade-in">${chunks}</ul>
  </section>`;
}

// ---------------------------------------------------------------- events

function go(view: View) {
  state.view = view;
  if (view > 1) state.n = INGESTS.length;
  state.file = null;
  render();
  window.scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}

document.addEventListener("click", (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>("button, [data-goto]");
  if (!el) return;
  const d = el.dataset;
  if (d.view) go(Number(d.view) as View);
  else if (d.goto) {
    state.n = Number(d.goto);
    state.file = null;
    render();
  } else if (d.file) {
    state.file = d.file;
    render();
  } else if (d.tab) {
    state.tab = d.tab as Tab;
    render();
  } else if (d.finding) {
    state.finding = Number(d.finding);
    if (state.fixed) state.fixed = false;
    render();
  } else if (d.q) {
    state.q = d.q;
    render();
  } else if (d.act) {
    act(d.act);
  }
});

function act(a: string) {
  if (a === "next" && state.n < INGESTS.length) {
    state.n += 1;
    state.file = null;
    render();
  } else if (a === "prev" && state.n > 0) {
    state.n -= 1;
    state.file = null;
    render();
  } else if (a === "to-lint") go(2);
  else if (a === "to-ask") {
    state.fixed = true;
    go(3);
  } else if (a === "to-ingest") go(1);
  else if (a === "fix") {
    state.fixed = true;
    state.file = null;
    render();
  } else if (a === "unfix") {
    state.fixed = false;
    render();
  } else if (a === "restart") {
    state.n = 0;
    state.fixed = false;
    state.finding = 0;
    state.view = 1;
    render();
    window.scrollTo({ top: 0 });
  }
}

document.addEventListener("keydown", (e) => {
  if (state.view !== 1 || e.metaKey || e.ctrlKey || e.altKey) return;
  if ((e.target as HTMLElement).closest("input, textarea")) return;
  if (e.key === "ArrowRight") act("next");
  if (e.key === "ArrowLeft") act("prev");
});

$("theme").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem("wiki-memory-theme", next);
  } catch {
    // Storage can be unavailable; the theme still switches for this visit.
  }
});

$("about-chunks").textContent = String(RUN.chunkCount);
$("about-k-chunks").textContent = String(RUN.k.chunks);
$("about-k-pages").textContent = String(RUN.k.pages);

render();
