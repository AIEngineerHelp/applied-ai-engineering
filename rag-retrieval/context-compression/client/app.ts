import { checkEvidence, compress, defaults, type Options, type Result } from "../src/compress.ts";
import { formatPassages, retrieve, scenarios, type Question } from "../src/fixtures.ts";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element: ${id}`);
  return element as T;
};
const input = (id: string) => $<HTMLInputElement>(id);
const select = (id: string) => $<HTMLSelectElement>(id);
const textarea = (id: string) => $<HTMLTextAreaElement>(id);
const escape = (value: string): string => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const number = (n: number) => n.toLocaleString("en-US");
let scenario = scenarios[0];
let custom: string | null = null;
let result: Result;
let source = "";
let latestOptions: Options;
let annotations: Question["evidence"] = [];
let timer: ReturnType<typeof setTimeout>;
let exportTrace: unknown;
const labels: Record<string, string> = {
  refund: "Refund exception", retention: "Data retention", recovery: "Recovery timeline",
  lock: "Restart safety condition", "cross-source": "Two sources required",
  pricing: "Focus: pricing complaints", launch: "Focus: launch correction",
};

function announce(text: string) { $("announcement").textContent = text; }
function getOptions(): Options {
  if (select("method").value === "truncate") select("budget-mode").value = "fixed";
  return {
    ...defaults, query: textarea("question").value, focus: scenario.id === "agent" ? textarea("focus").value : "",
    useFocus: input("use-focus").checked, queryAware: input("aware").checked,
    granularity: select("granularity").value as Options["granularity"], method: select("method").value as Options["method"],
    remove: Number(input("remove").value), dynamic: select("budget-mode").value === "dynamic",
    minFactor: Number(input("min-factor").value), maxFactor: Number(input("max-factor").value), threshold: Number(input("threshold").value),
  };
}
function activeQuestion() { return scenario.questions.find((q) => q.id === select("question-preset").value) ?? scenario.questions[0]; }

function setScenario(id: string) {
  scenario = scenarios.find((s) => s.id === id) ?? scenarios[0];
  custom = null;
  $("scenario-tabs").innerHTML = scenarios.map((s, i) => `<button type="button" data-scenario="${s.id}" aria-pressed="${s.id === scenario.id}"><span class="tab-number">0${i + 1}</span><span>${s.title}<small>${s.kind}</small></span><span class="tab-arrow" aria-hidden="true">↗</span></button>`).join("");
  select("question-preset").innerHTML = scenario.questions.map((q) => `<option value="${q.id}">${labels[q.id]}</option>`).join("");
  $("focus-group").hidden = scenario.id !== "agent";
  $("retrieval-group").hidden = scenario.id !== "rag";
  applyQuestion();
}
function applyQuestion() {
  const question = activeQuestion();
  textarea("question").value = question.text;
  textarea("focus").value = question.focus ?? "";
  update();
}
function update() {
  clearTimeout(timer);
  try {
    const options = getOptions();
    const question = activeQuestion();
    const k = Number(input("top-k").value);
    const retrieved = scenario.id === "rag" ? retrieve(scenario.passages, options.query, k) : null;
    source = custom ?? formatPassages(retrieved ? retrieved.map((r) => r.passage) : scenario.passages);
    result = compress(source, options);
    latestOptions = options;
    const matchesPreset = options.query === question.text && (scenario.id !== "agent" || options.focus === question.focus);
    annotations = custom === null && matchesPreset ? question.evidence : [];
    const facts = checkEvidence(source, result.spans, annotations);
    const retained = facts.filter((e) => e.kept).length;
    const present = facts.filter((e) => e.present).length;
    $("fixed-controls").hidden = options.dynamic;
    $("dynamic-controls").hidden = !options.dynamic;
    $("remove-value").textContent = `${options.remove}%`;
    $("top-k-value").textContent = String(k);
    select("granularity").disabled = options.method === "truncate";
    select("budget-mode").disabled = options.method === "truncate";
    input("aware").disabled = options.method === "truncate";
    $("aware-hint").textContent = options.method === "truncate" ? "Truncation takes a prefix; relevance scoring is ignored." : options.queryAware ? "Rank units by overlap with the question." : "Rank by generic term rarity. The question is ignored.";
    $("source-meta").innerHTML = `<div><span class="eyebrow">${custom !== null ? "YOUR DOCUMENT" : escape(scenario.kind.toUpperCase())}</span><h3>${custom !== null ? "Custom context" : escape(scenario.origin)}</h3><p>${custom !== null ? "Your text stays in memory in this browser tab." : escape(scenario.description)}</p>${retrieved && custom === null ? `<div class="retrieved">${retrieved.map((r) => `<span title="Lexical overlap: ${r.score} terms">${escape(r.passage.id)} · ${r.score} matches</span>`).join("")}</div>` : ""}</div><button id="export-trace" type="button" class="text-button">Export trace ↓</button>`;
    const ratio = result.compressedTokens ? `${(result.originalTokens / result.compressedTokens).toFixed(1)}×` : "—";
    $("metrics").innerHTML = `<div><span>Original tokens</span><strong>${number(result.originalTokens)}</strong></div><div><span>Kept tokens</span><strong class="blue-text">${number(result.compressedTokens)}<small> / ${number(result.budget)} budget</small></strong></div><div><span>Actual removal</span><strong>${Math.round(result.removed * 100)}<small>%</small></strong></div><div><span>Compression factor</span><strong>${ratio}</strong></div>`;
    $("original-count").textContent = `${number(result.originalTokens)} tokens`;
    $("original").innerHTML = source ? result.segments.map((seg) => `<span class="source-span ${seg.kept ? "selected" : "unselected"}">${escape(seg.text)}</span>`).join("") : `<p class="empty">No source text. Paste a document below.</p>`;
    $("compressed").innerHTML = source ? result.segments.map((seg) => seg.kept
      ? `<span class="kept-span">${escape(seg.text)}</span>`
      : seg.text.trim() ? `<details class="cut"><summary>${number(seg.text.trim().split(/\s+/).length)} words dropped <span aria-hidden="true">+</span></summary><div class="dropped-text">${escape(seg.text)}</div></details>` : "").join("") : `<p class="empty">Nothing to compress yet.</p>`;
    if (source && !result.text) $("compressed").insertAdjacentHTML("afterbegin", `<p class="empty">No units fit this budget. Expand a cut below or increase the budget.</p>`);
    $("decision").innerHTML = `<span aria-hidden="true">↳</span> ${escape(result.reason)} <span class="hint">Dropped markers are for inspection only; copied context contains kept text and separators.</span>`;
    $("evidence-score").textContent = facts.length ? `${retained} / ${facts.length} retained` : "Unscored";
    $("evidence-score").className = `evidence-score ${facts.length && retained === facts.length ? "pass" : facts.length ? "warn" : ""}`;
    $("evidence-description").textContent = annotations.length ? `Of ${facts.length} expected facts, ${present} reached this input and ${retained} survived compression. This checks annotated spans, not answer correctness.` : "No annotated facts for custom text or an edited question. Inspect the source yourself; token reduction alone does not measure quality.";
    $("evidence").innerHTML = facts.map((fact) => `<div class="fact ${fact.kept ? "pass" : "warn"}"><span class="fact-icon" aria-hidden="true">${fact.kept ? "✓" : "!"}</span><div><strong>${escape(fact.label)}</strong><blockquote>${escape(fact.quote)}</blockquote></div><span class="fact-status">${fact.kept ? "Retained" : fact.present ? "Dropped" : "Not retrieved"}</span></div>`).join("");
    $("lesson").hidden = !annotations.length;
    $("lesson").textContent = question.lesson;
    $("ranking").innerHTML = `<table><caption class="sr-only">Source units ranked by relevance</caption><thead><tr><th scope="col">Unit / matching terms</th><th scope="col">Score</th><th scope="col">Decision</th></tr></thead><tbody>${[...result.units].sort((a, b) => b.score - a.score || a.id - b.id).map((unit) => `<tr><td><strong>#${unit.id + 1}</strong> ${escape(unit.text)}<small>${options.queryAware ? unit.matches.length ? `Matches: ${escape(unit.matches.join(", "))}` : "No matching terms" : "Query awareness off"}</small></td><td>${unit.score.toFixed(3)}</td><td>${result.selected.includes(unit.id) ? "Kept" : result.spans.some((s) => s.start < unit.end && s.end > unit.start) ? "Partial" : "Dropped"}</td></tr>`).join("")}</tbody></table>`;
    exportTrace = { version: 1, scenario: scenario.id, custom: custom !== null, encoding: "cl100k_base", options, source, result, evidence: facts, disclaimer: "Offline lexical baseline; evidence retention is not answer accuracy. No LLM calls." };
    $("sweep-section").hidden = true;
    $("error").hidden = true;
    $<HTMLButtonElement>("copy").disabled = false;
  } catch (error) {
    $("error").textContent = (error instanceof Error ? error.message : "Could not compress the text.") + " Showing the last valid result.";
    $("error").hidden = false;
    $<HTMLButtonElement>("copy").disabled = true;
    announce("Settings are invalid. The displayed result is from the last valid settings.");
  }
}

$("scenario-tabs").addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-scenario]");
  if (button) setScenario(button.dataset.scenario!);
});
select("question-preset").addEventListener("change", applyQuestion);
for (const id of ["method", "granularity", "budget-mode", "aware", "use-focus", "top-k"]) $(id).addEventListener("change", update);
for (const id of ["remove", "question", "focus", "threshold", "min-factor", "max-factor"]) $(id).addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(update, 150); });
$("copy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(result.text); announce("Kept context copied, without dropped markers."); $("copy").textContent = "Copied ✓"; setTimeout(() => { $("copy").textContent = "Copy kept text"; }, 1800); }
  catch { announce("Clipboard unavailable. Export the trace to get the kept context."); }
});
$("source-meta").addEventListener("click", (event) => {
  if (!(event.target as HTMLElement).closest("#export-trace") || !$("error").hidden) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(exportTrace, null, 2)], { type: "application/json" }));
  const link = document.createElement("a"); link.href = url; link.download = `compression-${scenario.id}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$("apply-custom").addEventListener("click", () => { custom = textarea("custom-source").value; update(); announce("Custom document applied. Evidence checks are unavailable for this text."); $("lab").scrollIntoView({ behavior: "instant" }); });
$("restore-fixture").addEventListener("click", () => { custom = null; update(); announce("Example restored."); });
$("reset").addEventListener("click", () => {
  input("aware").checked = true; input("use-focus").checked = true;
  select("method").value = "relevance"; select("granularity").value = "sentence"; select("budget-mode").value = "fixed";
  input("remove").value = "60"; input("min-factor").value = "2"; input("max-factor").value = "6"; input("threshold").value = "80"; input("top-k").value = "3";
  setScenario(scenario.id); announce("Experiment reset.");
});
$("stress").addEventListener("click", () => { select("budget-mode").value = "fixed"; input("remove").value = "90"; update(); $("lab").scrollIntoView({ behavior: "instant" }); announce("Target removal is now 90 percent."); });
$("sweep").addEventListener("click", () => {
  if (!$("error").hidden) { announce("Fix the invalid settings before comparing budgets."); return; }
  const rows = [0, 25, 50, 75, 90].map((remove) => {
    const run = compress(source, { ...latestOptions, dynamic: false, remove });
    const facts = checkEvidence(source, run.spans, annotations);
    return `<tr><th scope="row">${remove}% target</th><td><div class="budget-bar"><span style="width:${run.originalTokens ? 100 * run.compressedTokens / run.originalTokens : 0}%"></span></div>${run.compressedTokens} tokens</td><td>${Math.round(run.removed * 100)}% removed</td><td>${facts.length ? `${facts.filter((f) => f.kept).length} / ${facts.length} facts` : "Unscored"}</td></tr>`;
  });
  $("sweep-results").innerHTML = `<table><caption class="sr-only">Comparison across five token budgets</caption><thead><tr><th scope="col">Removal</th><th scope="col">Kept context</th><th scope="col">Actual result</th><th scope="col">Evidence retained</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
  $("sweep-section").hidden = false; $("sweep-section").scrollIntoView({ behavior: "instant" });
});
$("toggle-settings").addEventListener("click", () => {
  const collapsed = $("settings").classList.toggle("collapsed");
  $("toggle-settings").setAttribute("aria-expanded", String(!collapsed));
  $("toggle-settings").textContent = collapsed ? "Adjust compression settings +" : "Hide compression settings −";
});
setScenario("document");
