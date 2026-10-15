// The UI: one research run, drawn top to bottom in the order of the
// architecture — query, orchestration and skills, parallel sub-agents,
// knowledge bases, virtual file system, synthesis, evals and traces.
// Live runs stream over server-sent events; saved runs replay the same events.

import type { EvalResult, Finding, Plan, Report, RunEvent, Source, SourceKind, Span, Usage } from "../src/types.ts";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

const KB: Record<SourceKind, { name: string; holds: string; icon: string }> = {
  pubmed: { name: "PubMed", holds: "Published studies", icon: "M4 3h8v10H4z M6 6h4 M6 8h4 M6 10h2" },
  trials: { name: "ClinicalTrials.gov", holds: "Registered trials", icon: "M3 8h3l2-4 2 8 2-4h1" },
  fda: { name: "openFDA", holds: "Labels and FAERS", icon: "M5 3h6v3l2 6H3l2-6z M5 3h6" },
  web: { name: "Web search", holds: "Regulators and news", icon: "M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z M2.5 8h11 M8 2.5c2 2 2 9 0 11 M8 2.5c-2 2-2 9 0 11" },
};

const EXAMPLES = [
  "What is the evidence on GLP-1 receptor agonists and acute pancreatitis risk?",
  "How safe and effective is semaglutide in heart failure with preserved ejection fraction?",
  "What do trials and FDA labels say about SGLT2 inhibitors and diabetic ketoacidosis?",
  "What is known about tirzepatide for obstructive sleep apnea?",
];

// ---------- State ----------

interface State {
  id: string;
  query: string;
  model: string;
  mode: string;
  skills: { name: string; description: string }[];
  plan?: Plan;
  loaded: string[];
  spans: Map<string, Span>;
  files: Map<string, { path: string; bytes: number; by: string; content: string }>;
  sources: Map<string, Source>;
  sourcesBy: Map<string, Set<string>>;
  findings: Map<string, Finding>;
  report?: Report;
  evals?: EvalResult[];
  usage?: Usage & { calls: number; toolCalls: number };
  error?: string;
  done?: number;
  live: boolean;
}

let S: State | null = null;
const blank = (): State => ({
  id: "", query: "", model: "", mode: "", skills: [], loaded: [], spans: new Map(), files: new Map(), sources: new Map(),
  sourcesBy: new Map(), findings: new Map(), live: false,
});

function apply(e: RunEvent) {
  if (!S) S = blank();
  switch (e.type) {
    case "run": Object.assign(S, { id: e.id, query: e.query, model: e.model, mode: e.mode }); break;
    case "skills": S.skills = e.available; break;
    case "plan": S.plan = e.plan; S.loaded = e.loaded; break;
    case "span": S.spans.set(e.span.id, e.span); break;
    case "file": S.files.set(e.path, { path: e.path, bytes: e.bytes, by: e.by, content: e.content }); break;
    case "sources": {
      const set = S.sourcesBy.get(e.subtask) ?? new Set<string>();
      for (const s of e.sources) { S.sources.set(s.id, s); set.add(s.id); }
      S.sourcesBy.set(e.subtask, set);
      break;
    }
    case "finding": S.findings.set(e.finding.subtask, e.finding); break;
    case "report": S.report = e.report; break;
    case "evals": S.evals = e.evals; break;
    case "usage": S.usage = { ...e.usage, calls: e.calls, toolCalls: e.toolCalls }; break;
    case "error": S.error = e.message; break;
    case "done": S.done = e.ms; S.live = false; break;
  }
  schedule();
}

let frame = 0;
function schedule() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    render();
  });
}

// ---------- Helpers ----------

const fmtMs = (ms?: number) => (ms === undefined ? "" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
const fmtN = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const icon = (d: string, cls = "size-4") => `<svg viewBox="0 0 16 16" class="${cls}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
const spinner = `<span class="spin" aria-hidden="true"></span>`;
const statusChip = (st: "waiting" | "running" | "done" | "error", label?: string) =>
  `<span class="chip chip-${st}">${st === "running" ? spinner : ""}${esc(label ?? st)}</span>`;

function spanByName(prefix: string): Span | undefined {
  return [...(S?.spans.values() ?? [])].find((s) => s.name.startsWith(prefix));
}
const children = (id?: string) => [...(S?.spans.values() ?? [])].filter((s) => s.parent === id).sort((a, b) => a.start - b.start);

/** Turns [PMID:123] style ids into clickable chips. */
function cite(text: string): string {
  return esc(text).replace(/\[((?:PMID|NCT|FDA|FAERS|WEB)[^\]\s]*)\]/g, (_, id: string) => {
    const known = S?.sources.has(id);
    return `<button type="button" class="cite${known ? "" : " cite-bad"}" data-source="${esc(id)}" title="${known ? esc(S!.sources.get(id)!.title) : "Not a retrieved source"}">${esc(id.replace(/^PMID:/, "PMID ").replace(/^FDA:.*/, "FDA label").replace(/^FAERS:.*/, "FAERS"))}</button>`;
  });
}

/** A tiny markdown renderer: paragraphs, bullets, bold. */
function md(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split("\n");
      if (lines.every((l) => /^\s*[-*] /.test(l))) return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*] /, ""))}</li>`).join("")}</ul>`;
      return `<p>${inline(block)}</p>`;
    })
    .join("");
}
const inline = (t: string) => cite(t).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

// ---------- Sections ----------

function section(n: string, title: string, sub: string, body: string, extra = "") {
  return `<section class="stage">
    <div class="stage-head"><span class="stage-num">${n}</span><h2>${esc(title)}</h2><span class="stage-sub">${esc(sub)}</span>${extra}</div>
    ${body}
  </section>`;
}
const arrow = `<div class="flow" aria-hidden="true"><span></span></div>`;

function queryCard(): string {
  const st = S!.error ? "error" : S!.done !== undefined ? "done" : "running";
  const u = S!.usage;
  return `<section class="stage stage-query">
    <div class="flex flex-wrap items-start gap-3">
      <div class="min-w-0 flex-1">
        <div class="mb-1 flex items-center gap-2"><span class="stage-num">1</span><span class="label">Research query</span></div>
        <p class="font-serif text-[21px] leading-snug">${esc(S!.query)}</p>
      </div>
      <div class="flex flex-col items-end gap-1.5 text-right">
        ${statusChip(st, st === "running" ? "researching" : st === "done" ? `done in ${fmtMs(S!.done)}` : "failed")}
        <span class="font-mono text-[11px] text-muted">${esc(S!.model)} · ${S!.mode === "live" ? "live" : "replay"} · ${esc(S!.id)}</span>
        ${u ? `<span class="font-mono text-[11px] text-muted">${u.calls} model calls · ${u.toolCalls} tool calls · ${fmtN(u.input + u.output + u.thinking)} tokens${u.cost !== undefined ? ` · $${u.cost.toFixed(4)}` : ""}</span>` : ""}
      </div>
    </div>
    ${S!.error ? `<p class="mt-3 rounded-lg px-3 py-2 text-[13px]" style="background:var(--bad-soft);color:var(--bad)">${esc(S!.error)}</p>` : ""}
  </section>`;
}

function orchestration(): string {
  const span = spanByName("orchestrator");
  const st = !span ? "waiting" : span.status === "running" ? "running" : span.status === "error" ? "error" : "done";
  const plan = S!.plan;
  const orch = `<div class="card">
    <div class="card-head"><b>Orchestrator</b>${statusChip(st, st === "running" ? "planning" : st)}${span?.end !== undefined ? `<span class="ml-auto font-mono text-[11px] text-muted">${fmtMs(span.end - span.start)}</span>` : ""}</div>
    ${plan ? `<p class="mb-2 text-ink-2">${esc(plan.focus)}</p>
      <ol class="space-y-1.5">${plan.subtasks.map((t) => `<li class="flex gap-2 text-[13px]"><span class="kb kb-${t.source}">${esc(KB[t.source].name)}</span><span class="min-w-0">${esc(t.question)}</span></li>`).join("")}</ol>`
      : `<p class="text-muted">Reads the query and the skill index, then splits the work into subtasks for parallel sub-agents.</p>`}
  </div>`;
  const loaded = new Set(S!.loaded);
  const skills = `<div class="card">
    <div class="card-head"><b>Skills layer</b><span class="ml-auto font-mono text-[11px] text-muted">${plan ? `${loaded.size} of ${S!.skills.length} loaded` : `${S!.skills.length} available`}</span></div>
    <p class="mb-2 text-[12.5px] text-muted">The orchestrator sees only these one-line descriptions. A skill's full playbook is loaded into a sub-agent only when the plan assigns it.</p>
    <div class="space-y-1.5">${S!.skills.map((s) => `<div class="skill${loaded.has(s.name) ? " skill-on" : ""}"><span class="font-mono text-[12px]">${esc(s.name)}</span><span class="text-[12px] text-muted">${esc(s.description)}</span></div>`).join("")}</div>
  </div>`;
  return section("2", "Orchestration", "plan the work and pick the skills", `<div class="grid gap-3 md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">${orch}${skills}</div>`);
}

function agents(): string {
  const plan = S!.plan;
  if (!plan) return section("3", "Parallel research sub-agents", "one per subtask, each on one knowledge base", `<div class="card text-muted">Waiting for the plan.</div>`);
  const lanes = plan.subtasks.map((t) => {
    const span = spanByName(`${t.id} ·`);
    const finding = S!.findings.get(t.id);
    const st = !span ? "waiting" : span.status === "running" ? "running" : span.status === "error" ? "error" : "done";
    const steps = children(span?.id);
    const nSources = S!.sourcesBy.get(t.id)?.size ?? 0;
    const activity = steps
      .map((s) => {
        const running = s.status === "running";
        const isTool = s.kind === "tool";
        const label = isTool ? `${esc(s.name)}(${esc(String(s.attrs.args ?? "").slice(0, 70))})` : esc(s.name.replace(`${t.id} `, ""));
        const right = isTool ? (s.attrs.results !== undefined ? `${s.attrs.results} results` : "") : s.attrs.calls ? `→ ${esc(s.attrs.calls)}` : s.attrs.results !== undefined ? `${s.attrs.results} sources` : "";
        return `<li class="act act-${s.kind}${running ? " act-run" : ""}${s.status === "error" ? " act-err" : ""}"><span class="act-dot"></span><span class="min-w-0 truncate font-mono">${label}</span><span class="ml-auto shrink-0 text-muted">${running ? spinner : esc(right)}</span></li>`;
      })
      .join("");
    return `<div class="card lane">
      <div class="card-head"><span class="kb kb-${t.source}">${esc(KB[t.source].name)}</span><b class="font-mono text-[12px]">${esc(t.id)}</b>${statusChip(st)}</div>
      <p class="mb-2 text-[13px] leading-snug">${esc(t.question)}</p>
      ${t.skills.length ? `<div class="mb-2 flex flex-wrap gap-1">${t.skills.map((s) => `<span class="tag">${esc(s)}</span>`).join("")}</div>` : ""}
      <ul class="acts">${activity || `<li class="act text-muted">Queued.</li>`}</ul>
      <div class="mt-2 flex items-center gap-3 border-t border-rule pt-2 text-[12px] text-muted">
        <span>${nSources} sources</span>
        ${finding ? `<span>${finding.claims.length} claims</span>${finding.gaps.length ? `<span>${finding.gaps.length} gaps</span>` : ""}<button type="button" class="link ml-auto" data-file="/findings/${esc(t.id)}.md">Finding →</button>` : ""}
      </div>
    </div>`;
  });
  const cols = Math.min(4, plan.subtasks.length);
  return section("3", "Parallel research sub-agents", "one per subtask, each on one knowledge base, running at the same time",
    `<div class="grid gap-3 sm:grid-cols-2 ${cols >= 3 ? "xl:grid-cols-3" : ""} ${cols >= 4 ? "2xl:grid-cols-4" : ""}">${lanes.join("")}</div>`);
}

function knowledge(): string {
  const used = new Set(S!.plan?.subtasks.map((t) => t.source));
  const tiles = (Object.keys(KB) as SourceKind[]).map((k) => {
    const n = [...S!.sources.values()].filter((s) => s.kind === k).length;
    return `<div class="kbtile${used.has(k) ? " kbtile-on" : ""}">
      <span class="kb-icon kb-${k}">${icon(KB[k].icon)}</span>
      <div class="min-w-0"><b class="block text-[13px]">${KB[k].name}</b><span class="text-[11.5px] text-muted">${KB[k].holds}</span></div>
      <span class="ml-auto font-mono text-[18px]">${n}</span>
    </div>`;
  });
  return section("4", "Knowledge bases", "free public APIs, queried live", `<div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">${tiles.join("")}</div>`);
}

function filesystem(): string {
  const files = [...S!.files.values()].sort((a, b) => a.path.localeCompare(b.path, "en", { numeric: true }));
  const groups = new Map<string, typeof files>();
  for (const f of files) {
    const dir = f.path.split("/").slice(0, -1).join("/") || "/";
    groups.set(dir, [...(groups.get(dir) ?? []), f]);
  }
  const total = files.reduce((n, f) => n + f.bytes, 0);
  const body = files.length
    ? `<div class="grid gap-x-6 gap-y-3 md:grid-cols-2 xl:grid-cols-3">${[...groups.entries()]
        .map(([dir, list]) => `<div><div class="mb-1 font-mono text-[11.5px] text-muted">${esc(dir === "/" ? "/" : `${dir}/`)} <span class="text-faint">${list.length}</span></div>
          <ul class="space-y-0.5">${list.slice(0, 14).map((f) => `<li><button type="button" class="file" data-file="${esc(f.path)}"><span class="truncate">${esc(f.path.split("/").pop())}</span><span class="ml-auto shrink-0 text-faint">${fmtN(f.bytes)}</span></button></li>`).join("")}${list.length > 14 ? `<li class="pl-2 text-[11.5px] text-faint">+ ${list.length - 14} more</li>` : ""}</ul></div>`)
        .join("")}</div>`
    : `<p class="text-muted">Empty. Sub-agents write sources and findings here.</p>`;
  return section("5", "Virtual file system", "sub-agents write here; synthesis reads from here", `<div class="card">${body}</div>`,
    `<span class="ml-auto font-mono text-[11px] text-muted">${files.length} files · ${fmtN(total)} chars</span>`);
}

function synthesis(): string {
  const span = spanByName("synthesis");
  const st = !span ? "waiting" : span.status === "running" ? "running" : span.status === "error" ? "error" : "done";
  const r = S!.report;
  const body = r
    ? `<article class="report">
        <div class="flex flex-wrap items-baseline gap-3"><h3 class="font-serif text-[24px] leading-tight">${esc(r.title)}</h3><span class="chip conf-${r.confidence}">${esc(r.confidence)} confidence</span></div>
        <div class="answer">${md(r.answer)}</div>
        ${r.sections.map((s) => `<h4>${esc(s.heading)}</h4>${md(s.body)}`).join("")}
        ${r.limitations.length ? `<h4>Limitations</h4><ul>${r.limitations.map((l) => `<li>${inline(l)}</li>`).join("")}</ul>` : ""}
      </article>`
    : `<p class="text-muted">${st === "running" ? `${spinner} Reading the findings and the source catalogue from the file system…` : "Writes one cited report from the files, after every sub-agent finishes."}</p>`;
  return section("6", "Synthesis agent", "one cited report, from the files only", `<div class="card">${body}</div>`, `<span class="ml-auto">${statusChip(st)}</span>`);
}

function evalsAndTraces(): string {
  const evals = S!.evals;
  const evalHtml = evals
    ? evals.map((e) => {
        const pct = Math.round(e.score * 100);
        const tone = e.score >= 0.85 ? "good" : e.score >= 0.6 ? "mid" : "bad";
        return `<div class="eval">
          <div class="flex items-baseline gap-2"><b class="text-[13px]">${esc(e.name)}</b><span class="tag">${e.method === "judge" ? "LLM judge" : "check"}</span><span class="ml-auto font-mono text-[15px] score-${tone}">${pct}%</span></div>
          <div class="ebar"><i class="score-bg-${tone}" style="width:${pct}%"></i></div>
          <p class="text-[12px] text-muted">${esc(e.detail)}</p>
          ${e.items?.length ? `<button type="button" class="link text-[12px]" data-verdicts="1">See the judge's verdicts →</button>` : ""}
        </div>`;
      }).join("")
    : `<p class="text-muted">Run after the report: four deterministic checks and one LLM-judge check.</p>`;

  // Trace waterfall: every span on one time axis, indented by depth.
  // Tree order: each span followed by its children, so tool calls sit under their agent.
  const all = [...S!.spans.values()];
  const spans: Span[] = [];
  const visit = (parent?: string) => {
    for (const s of all.filter((x) => x.parent === parent).sort((x, y) => x.start - y.start)) {
      spans.push(s);
      visit(s.id);
    }
  };
  visit(undefined);
  const endAll = Math.max(1, S!.done ?? 0, ...spans.map((s) => s.end ?? s.start));
  const depth = (s: Span): number => (s.parent ? 1 + depth(S!.spans.get(s.parent)!) : 0);
  const rows = spans.filter((s) => s.kind !== "run").map((s) => {
    const left = (s.start / endAll) * 100;
    const width = Math.max(0.4, (((s.end ?? endAll) - s.start) / endAll) * 100);
    const tip = `${s.name} · ${fmtMs((s.end ?? endAll) - s.start)}${s.attrs.input ? ` · ${fmtN(Number(s.attrs.input))} in / ${fmtN(Number(s.attrs.output ?? 0))} out` : ""}${s.attrs.error ? ` · ${s.attrs.error}` : ""}`;
    return `<div class="trow" data-tip="${esc(tip)}"><span class="tname" style="padding-left:${Math.max(0, depth(s) - 1) * 12}px">${esc(s.name)}</span><span class="ttrack"><i class="tbar tbar-${s.kind}${s.status === "running" ? " tbar-run" : ""}${s.status === "error" ? " tbar-err" : ""}" style="left:${left}%;width:${width}%"></i></span></div>`;
  });
  const u = S!.usage;
  const totals = u
    ? `<div class="grid grid-cols-2 gap-3 sm:grid-cols-5">
        ${[["Model calls", String(u.calls)], ["Tool calls", String(u.toolCalls)], ["Input tokens", fmtN(u.input)], ["Output + thinking", fmtN(u.output + u.thinking)], ["Cost", u.cost !== undefined ? `$${u.cost.toFixed(4)}` : "not priced"]]
          .map(([k, v]) => `<div><div class="label">${k}</div><div class="font-mono text-[17px]">${v}</div></div>`).join("")}
      </div>`
    : "";
  return section("7", "Evals and traces", "is the report supported, and where did the time and tokens go",
    `<div class="grid gap-3 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.4fr)]">
      <div class="card space-y-3">${evalHtml}</div>
      <div class="card">${totals}<div class="mt-3 flex items-center gap-3 text-[11px] text-muted">${["agent", "llm", "tool", "eval"].map((k) => `<span class="flex items-center gap-1"><i class="legend tbar-${k}"></i>${k === "llm" ? "model call" : k}</span>`).join("")}<span class="ml-auto font-mono">${fmtMs(endAll)}</span></div>
        <div class="trace mt-2">${rows.join("")}</div></div>
    </div>`);
}

function render() {
  if (!S) return;
  $("#empty").hidden = true;
  const p = $("#pipeline");
  p.classList.remove("hidden");
  p.innerHTML = [queryCard(), arrow, orchestration(), arrow, agents(), arrow, knowledge(), arrow, filesystem(), arrow, synthesis(), arrow, evalsAndTraces()].join("");
  $("#run").toggleAttribute("disabled", !!S.live || !config.live);
}

// ---------- Sheets ----------

const sheet = () => $<HTMLDialogElement>("#sheet");
function openSheet(title: string, html: string) {
  $("#sheet-title").textContent = title;
  $("#sheet-body").innerHTML = html;
  if (!sheet().open) sheet().showModal();
}
function showFile(path: string) {
  const f = S?.files.get(path);
  if (!f) return;
  openSheet(path, `<p class="mb-3 font-mono text-[11.5px] text-muted">written by ${esc(f.by)} · ${fmtN(f.bytes)} chars</p><pre class="pre">${cite(f.content)}</pre>`);
}
function showSource(id: string) {
  const s = S?.sources.get(id);
  if (!s) return openSheet(id, `<p style="color:var(--bad)">This id is not among the sources the agents retrieved. A citation like this is what the "citation validity" check catches.</p>`);
  const meta = Object.entries(s.meta).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => `<span class="tag">${esc(k)}: ${esc(v)}</span>`).join(" ");
  openSheet(s.id, `<span class="kb kb-${s.kind}">${esc(KB[s.kind].name)}</span><h3 class="mt-2 mb-2 font-serif text-[20px] leading-snug">${esc(s.title)}</h3>
    <div class="mb-3 flex flex-wrap gap-1">${meta}</div>
    <a class="link mb-4 inline-block" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">Open the original →</a>
    <pre class="pre">${esc(s.text)}</pre>`);
}
function showVerdicts() {
  const g = S?.evals?.find((e) => e.items?.length);
  if (!g) return;
  openSheet("Groundedness: the judge's verdicts", `<p class="mb-3 text-muted">Each cited sentence of the report was checked against the text of the sources it cites.</p>
    <ul class="space-y-3">${g.items!.map((v) => `<li class="card"><span class="chip verdict-${esc(v.verdict)}">${esc(v.verdict)}</span><p class="mt-2 text-[13px]">${cite(v.text)}</p><p class="mt-1 text-[12px] text-muted">${esc(v.reason)}</p></li>`).join("")}</ul>`);
}
function showHow() {
  openSheet("How it works", `<div class="prose">
    <p>A <b>research query</b> goes to an <b>orchestrator</b>. It sees a <b>skills layer</b> as one line per skill, and splits the query into two to four subtasks, each tied to one knowledge base and the skills its sub-agent should load.</p>
    <p><b>Research sub-agents</b> run in parallel (at most four at once). Each has its own short tool loop — at most six turns — over one knowledge base: PubMed (NCBI E-utilities), ClinicalTrials.gov (API v2), openFDA (drug labels and FAERS report counts), or the web (Gemini with Google Search grounding). They get short excerpts back; the full documents are written to a <b>virtual file system</b>, and each sub-agent ends by writing a finding file with claims tied to source ids.</p>
    <p>The <b>synthesis agent</b> reads only the files — the findings and a catalogue of every source retrieved — and writes one cited report.</p>
    <p><b>Evals</b>: citation validity (every cited id is a retrieved source), citation coverage (sentences that cite something), subtasks answered, source diversity, and groundedness, where a judge model checks each cited sentence against the text of its sources. <b>Traces</b> record every agent, model call and tool call with timings and tokens.</p>
    <p class="text-muted">This is a teaching example, not medical advice. Model output can be wrong even when it is cited; open the sources.</p>
  </div>`);
}

// ---------- Runs: live and replay ----------

let config = { live: false, model: "", running: 0, static: false };

async function loadRuns() {
  let list: { id: string; query: string; at: string; sample: boolean; ms?: number }[] = [];
  try {
    const res = await fetch(config.static ? "runs/index.json" : "/api/runs");
    list = res.ok ? await res.json() : [];
  } catch {
    list = [];
  }
  $("#runs-count").textContent = String(list.length);
  $("#runs").innerHTML = list.length
    ? list.map((r) => `<button type="button" class="runrow" data-run="${esc(r.id)}"><span class="line-clamp-2 text-[12.5px] leading-snug">${esc(r.query)}</span><span class="font-mono text-[10.5px] text-faint">${esc(r.at.slice(0, 16).replace("T", " "))}${r.ms ? ` · ${fmtMs(r.ms)}` : ""}${r.sample ? " · sample" : ""}</span></button>`).join("")
    : `<p class="text-[12.5px] text-muted">No saved runs yet.</p>`;
}

let replayTimer = 0;
async function replay(id: string) {
  clearTimeout(replayTimer);
  const res = await fetch(config.static ? `runs/${id}.json` : `/api/runs/${id}`);
  if (!res.ok) return;
  const run = (await res.json()) as { events: RunEvent[] };
  S = blank();
  history.replaceState(null, "", `?run=${encodeURIComponent(id)}${location.hash}`);
  document.querySelectorAll<HTMLElement>(".runrow").forEach((b) => (b.dataset.on = String(b.dataset.run === id)));
  // Replay at about 4× real time, so the parallel lanes are visible.
  let i = 0;
  let last = 0;
  const step = () => {
    while (i < run.events.length) {
      const e = run.events[i];
      const t = e.type === "span" ? (e.span.end ?? e.span.start) : last;
      if (!reduced && t - last > 60) {
        replayTimer = window.setTimeout(step, Math.min(600, (t - last) / 4));
        last = t;
        return;
      }
      apply(e);
      i++;
    }
  };
  step();
}

async function startLive(query: string) {
  const res = await fetch("/api/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }) });
  const body = await res.json();
  if (!res.ok) {
    $("#run-note").textContent = body.error ?? "Could not start the run.";
    return;
  }
  clearTimeout(replayTimer);
  S = blank();
  S.live = true;
  history.replaceState(null, "", `?run=${encodeURIComponent(body.id)}`);
  const es = new EventSource(`/api/runs/${body.id}/events`);
  es.onmessage = (m) => apply(JSON.parse(m.data) as RunEvent);
  es.onerror = () => {
    es.close();
    if (S) S.live = false;
    void loadRuns();
    schedule();
  };
}

// ---------- Wiring ----------

async function init() {
  try {
    const res = await fetch("/api/config");
    if (!res.ok) throw new Error();
    config = { ...(await res.json()), static: false };
  } catch {
    config = { live: false, model: "", running: 0, static: true };
  }
  $("#mode").textContent = config.static ? "Replay only" : config.live ? `Live · ${config.model}` : "Replay only · no API key";
  $("#mode").classList.toggle("pill-live", config.live);
  $("#run").toggleAttribute("disabled", !config.live);
  $("#run-note").textContent = config.static
    ? "This deployed copy replays saved runs. Run it locally with a Gemini key to research live."
    : config.live ? "Live: uses your Gemini key (a few cents a run)." : "Add GEMINI_API_KEY to .env to run live.";
  $("#examples").innerHTML = EXAMPLES.map((q) => `<button type="button" class="example" data-example="${esc(q)}">${esc(q)}</button>`).join("");
  await loadRuns();
  const want = new URLSearchParams(location.search).get("run");
  const first = document.querySelector<HTMLElement>(".runrow");
  if (want) void replay(want);
  else if (first) void replay(first.dataset.run!);
}

document.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  const ex = t.closest<HTMLElement>("[data-example]");
  if (ex) ($<HTMLTextAreaElement>("#query").value = ex.dataset.example!);
  const run = t.closest<HTMLElement>("[data-run]");
  if (run) void replay(run.dataset.run!);
  const file = t.closest<HTMLElement>("[data-file]");
  if (file) showFile(file.dataset.file!);
  const src = t.closest<HTMLElement>("[data-source]");
  if (src) showSource(src.dataset.source!);
  if (t.closest("[data-verdicts]")) showVerdicts();
  if (t.closest("#how-open")) showHow();
  if (t.closest("#sheet-close") || t === sheet()) sheet().close();
});

$("#ask").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $<HTMLTextAreaElement>("#query").value.trim();
  if (q.length >= 10) void startLive(q);
});

// Trace tooltips.
document.addEventListener("mousemove", (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>("[data-tip]");
  const tip = $("#tip");
  if (!row) return void (tip.hidden = true);
  tip.textContent = row.dataset.tip!;
  tip.hidden = false;
  tip.style.left = `${Math.min(e.clientX + 12, innerWidth - tip.offsetWidth - 8)}px`;
  tip.style.top = `${e.clientY + 14}px`;
});

$("#theme").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem("pra-theme", next);
  } catch {
    // Storage can be unavailable; the theme still switches for this visit.
  }
});

void init();
