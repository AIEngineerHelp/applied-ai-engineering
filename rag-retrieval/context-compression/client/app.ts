import { checkEvidence, compress, defaults, isModelMethod, type Options, type Result } from "../src/compress.ts";
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
const dropLabel = (text: string) => {
  const count = text.trim().split(/\s+/).length;
  return `${number(count)} ${count === 1 ? "word" : "words"} dropped`;
};
let scenario = scenarios[0];
let custom: string | null = null;
let result: Result;
let source = "";
let latestOptions: Options;
let annotations: Question["evidence"] = [];
let timer: ReturnType<typeof setTimeout>;
let exportTrace: unknown;
let currentKey = "";
let pending = false;
let browserQueryAware = true;
let previousMethod: Options["method"] = "relevance";
let running = false;
let backendCapabilities = { localModelsEnabled: false, compresrConfigured: false };
const modelResults = new Map<string, Result>();
const methodHelp: Record<string, string> = {
  relevance: "Lexical overlap ranks whole units. Fast and inspectable; misses synonyms.",
  mmr: "Maximal Marginal Relevance balances query overlap against similarity to units already selected. Jaccard overlap supplies the redundancy penalty here.",
  words: "Fine-grained lexical word deletion, with original offsets. It can break grammar or remove negation. This is not a learned token classifier.",
  truncate: "Keep a prefix. It ignores both the question and the reading focus.",
  semantic: "BGE embeddings compare the question with each unit using cosine similarity. Requires explicitly enabled local inference and cached weights. No downloads occur.",
  llmlingua2: "Published LLMLingua-2 token-classification checkpoint. Keep probabilities are averaged per whitespace word and packed by our budget controller. Task-agnostic: question and focus are ignored. Requires explicitly enabled local inference.",
  compresr: "Hosted Latte v2.1. Your source and question leave this device. A configured server key and explicit paid-call consent are required. The API returns text, not source offsets.",
};
const labels: Record<string, string> = {
  refund: "Refund exception", retention: "Data retention", recovery: "Recovery timeline",
  lock: "Restart safety condition", "cross-source": "Two sources required",
  pricing: "Focus: pricing complaints", launch: "Focus: launch correction",
};

function announce(text: string) { $("announcement").textContent = text; }
function getOptions(): Options {
  const method = select("method").value as Options["method"];
  if (method !== previousMethod) {
    if (!isModelMethod(previousMethod)) browserQueryAware = input("aware").checked;
    if (!isModelMethod(method)) input("aware").checked = browserQueryAware;
    previousMethod = method;
  }
  if (["truncate", "llmlingua2"].includes(method)) select("budget-mode").value = "fixed";
  if (method === "semantic" || method === "compresr") input("aware").checked = true;
  if (method === "llmlingua2") input("aware").checked = false;
  return {
    ...defaults, query: textarea("question").value, focus: scenario.id === "agent" ? textarea("focus").value : "",
    useFocus: input("use-focus").checked, queryAware: input("aware").checked,
    granularity: select("granularity").value as Options["granularity"], method: select("method").value as Options["method"],
    remove: Number(input("remove").value), dynamic: select("budget-mode").value === "dynamic",
    minFactor: Number(input("min-factor").value), maxFactor: Number(input("max-factor").value), threshold: Number(input("threshold").value), diversity: Number(input("diversity").value),
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
    currentKey = JSON.stringify([source, options]);
    pending = isModelMethod(options.method) && !modelResults.has(currentKey);
    result = pending
      ? compress(source, { ...options, method: "relevance", remove: 0, dynamic: false })
      : modelResults.get(currentKey) ?? compress(source, options);
    $("model-controls").hidden = !isModelMethod(options.method);
    $("paid-consent").hidden = options.method !== "compresr";
    $("method-description").textContent = methodHelp[options.method];
    $("diversity-controls").hidden = options.method !== "mmr";
    $("diversity-value").textContent = Number(options.diversity).toFixed(2);
    const available = options.method === "compresr" ? backendCapabilities.compresrConfigured : backendCapabilities.localModelsEnabled;
    $("backend-status").textContent = options.method === "compresr"
      ? available ? "Server key configured. This call may incur API charges." : "Not configured. Set COMPRESR_API_KEY on the server to use hosted compression."
      : available ? "Local inference explicitly enabled by server configuration. Cached weights only." : "Local inference is disabled. Do not enable it until the laptop owner authorizes it.";
    $<HTMLButtonElement>("run-model").disabled = running || !available;
    $("run-model").textContent = running ? "Compression running…" : "Run compression";
    const outputOnly = result.alignment === "unavailable";
    const sizes = select("granularity").options;
    sizes[0].text = options.method === "compresr" ? "Fine · API token-level" : options.method === "llmlingua2" ? "Word spans · token classifier" : options.method === "words" ? "Word spans · lexical" : "Sentence · more precise";
    sizes[1].text = options.method === "compresr" ? "Coarse · API paragraphs" : "Paragraph · more context";
    $("ranking-description").textContent = options.method === "semantic"
      ? "Cosine similarities from independent BGE unit embeddings, not probabilities or a correctness guarantee."
      : options.method === "llmlingua2" ? "Checkpoint token keep probabilities averaged per whitespace word; our packer enforces the displayed budget."
      : "Lexical overlap with an inverse-document-frequency weight, divided by √unique terms. Heading words count too. MMR adds a changing redundancy penalty during selection; displayed scores are base relevance. Evidence labels never influence selection.";
    latestOptions = options;
    const matchesPreset = options.query === question.text && (scenario.id !== "agent" || options.focus === question.focus);
    annotations = custom === null && matchesPreset ? question.evidence : [];
    const facts = checkEvidence(source, result.spans, annotations).map((fact) => outputOnly ? { ...fact, kept: result.text.includes(fact.quote) } : fact);
    const retained = facts.filter((e) => e.kept).length;
    const present = facts.filter((e) => e.present).length;
    $("fixed-controls").hidden = options.dynamic;
    $("dynamic-controls").hidden = !options.dynamic;
    $("remove-value").textContent = `${options.remove}%`;
    $("top-k-value").textContent = String(k);
    select("granularity").disabled = ["truncate", "words", "llmlingua2"].includes(options.method);
    select("budget-mode").disabled = ["truncate", "llmlingua2"].includes(options.method);
    input("aware").disabled = ["truncate", "semantic", "llmlingua2", "compresr"].includes(options.method);
    $("aware-hint").textContent = options.method === "llmlingua2" ? "Task-agnostic checkpoint; question and focus are ignored." : options.method === "truncate" ? "Truncation takes a prefix; relevance scoring is ignored." : options.queryAware ? "Rank units by overlap with the question." : "Rank by generic term rarity. The question is ignored.";
    $("source-meta").innerHTML = `<div><span class="eyebrow">${custom !== null ? "YOUR DOCUMENT" : escape(scenario.kind.toUpperCase())}</span><h3>${custom !== null ? "Custom context" : escape(scenario.origin)}</h3><p>${custom !== null ? options.method === "compresr" ? "Custom text is sent to Compresr only when you explicitly run hosted compression." : "Your text stays on this device." : escape(scenario.description)}</p>${retrieved && custom === null ? `<div class="retrieved">${retrieved.map((r) => `<span title="Lexical overlap: ${r.score} terms">${escape(r.passage.id)} · ${r.score} matches</span>`).join("")}</div>` : ""}</div><button id="export-trace" type="button" class="text-button" ${pending ? "disabled" : ""}>Export trace ↓</button>`;
    const ratio = result.compressedTokens ? `${(result.originalTokens / result.compressedTokens).toFixed(1)}×` : "—";
    $("metrics").innerHTML = `<div><span>Original tokens</span><strong>${number(result.originalTokens)}</strong></div><div><span>Kept tokens</span><strong class="blue-text">${number(result.compressedTokens)}<small> / ${number(result.budget)} budget</small></strong></div><div><span>Actual removal</span><strong>${Math.round(result.removed * 100)}<small>%</small></strong></div><div><span>Compression factor</span><strong>${ratio}</strong></div>`;
    if (pending) $("metrics").innerHTML = `<div><span>Original tokens</span><strong>${number(result.originalTokens)}</strong></div><div><span>Kept tokens</span><strong>—</strong></div><div><span>Actual removal</span><strong>—</strong></div><div><span>Method status</span><strong><small>Not run</small></strong></div>`;
    $("original-count").textContent = `${number(result.originalTokens)} tokens`;
    $("original").innerHTML = source ? result.segments.map((seg) => `<span class="source-span ${seg.kept ? "selected" : "unselected"}">${escape(seg.text)}</span>`).join("") : `<p class="empty">No source text. Paste a document below.</p>`;
    $("compressed").innerHTML = source ? result.segments.map((seg) => seg.kept
      ? `<span class="kept-span">${escape(seg.text)}</span>`
      : seg.text.trim() ? `<details class="cut"><summary>${dropLabel(seg.text)} <span aria-hidden="true">+</span></summary><div class="dropped-text">${escape(seg.text)}</div></details>` : "").join("") : `<p class="empty">Nothing to compress yet.</p>`;
    if (outputOnly) {
      $("original").textContent = source;
      $("compressed").innerHTML = `<p class="hint">Hosted output · no source offsets supplied. Expandable cuts are unavailable.</p><span class="kept-span">${escape(result.text)}</span>`;
    }
    if (pending) $("original").textContent = source;
    if (pending) $("compressed").innerHTML = `<p class="empty">${escape(methodHelp[options.method])}<br><br>Compression has not run. Use the explicit run button in settings when this backend is enabled.</p>`;
    if (!pending && !input("show-cuts").checked) $("compressed").textContent = result.text;
    if (!pending && source && !result.text) $("compressed").insertAdjacentHTML("afterbegin", `<p class="empty">No units fit this budget. Expand a cut below or increase the budget.</p>`);
    $("decision").innerHTML = `<span aria-hidden="true">↳</span> ${escape(pending ? "Awaiting an explicit compression run. No model request has been made for these settings." : result.reason)} <span class="hint">Dropped markers are for inspection only; copied context contains kept text and separators.</span>`;
    if (!pending && result.backend) $("decision").insertAdjacentHTML("beforeend", `<span class="hint">Measured round trip: ${Math.round(result.backend.durationMs)} ms, including cold model loading when applicable. ${result.backend.fallback ? "Raw fallback; compression failed." : ""}</span>`);
    $("evidence-score").textContent = pending ? "Not run" : facts.length ? `${retained} / ${facts.length} retained` : "Unscored";
    $("evidence-score").className = `evidence-score ${!pending && facts.length && retained === facts.length ? "pass" : !pending && facts.length ? "warn" : ""}`;
    $("evidence-description").textContent = pending ? "Evidence checks are pending; no model output exists for these settings." : outputOnly ? "Checks look for complete annotated quotes in the API output. Missing or paraphrased quotes count as not retained; no exact dropped-span attribution is claimed." : annotations.length ? `Of ${facts.length} expected facts, ${present} reached this input and ${retained} survived compression. This checks annotated spans, not answer correctness.` : "No annotated facts for custom text or an edited question. Inspect the source yourself; token reduction alone does not measure quality.";
    $("evidence").innerHTML = pending ? "" : facts.map((fact) => `<div class="fact ${fact.kept ? "pass" : "warn"}"><span class="fact-icon" aria-hidden="true">${fact.kept ? "✓" : "!"}</span><div><strong>${escape(fact.label)}</strong><blockquote>${escape(fact.quote)}</blockquote></div><span class="fact-status">${fact.kept ? "Retained" : fact.present ? "Dropped" : "Not retrieved"}</span></div>`).join("");
    $("lesson").hidden = pending || !annotations.length;
    $("lesson").textContent = question.lesson;
    $("ranking").innerHTML = pending || outputOnly ? `<p class="hint">${pending ? "Run the selected method to see its scores." : "Compresr does not return per-unit scores through this endpoint."}</p>` : `<table><caption class="sr-only">Source units ranked by relevance</caption><thead><tr><th scope="col">Unit / matching terms</th><th scope="col">Score</th><th scope="col">Decision</th></tr></thead><tbody>${[...result.units].sort((a, b) => b.score - a.score || a.id - b.id).map((unit) => `<tr><td><strong>#${unit.id + 1}</strong> ${escape(unit.text)}<small>${["semantic", "llmlingua2"].includes(options.method) ? "Model score" : options.queryAware ? unit.matches.length ? `Matches: ${escape(unit.matches.join(", "))}` : "No matching terms" : "Query awareness off"}</small></td><td>${unit.score.toFixed(3)}</td><td>${result.selected.includes(unit.id) ? "Kept" : result.spans.some((s) => s.start < unit.end && s.end > unit.start) ? "Partial" : "Dropped"}</td></tr>`).join("")}</tbody></table>`;
    exportTrace = { version: 1, scenario: scenario.id, custom: custom !== null, encoding: "cl100k_base", options, source, result, evidence: facts, pending, disclaimer: "Evidence retention is not answer accuracy. Backend metadata distinguishes model runs from offline baselines." };
    $("sweep-section").hidden = true;
    $("error").hidden = true;
    $<HTMLButtonElement>("copy").disabled = pending;
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
for (const id of ["method", "granularity", "budget-mode", "aware", "use-focus", "top-k", "show-cuts"]) $(id).addEventListener("change", update);
for (const id of ["remove", "question", "focus", "threshold", "min-factor", "max-factor", "diversity"]) $(id).addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(update, 150); });
$("copy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(result.text); announce("Kept context copied, without dropped markers."); $("copy").textContent = "Copied ✓"; setTimeout(() => { $("copy").textContent = "Copy kept text"; }, 1800); }
  catch { announce("Clipboard unavailable. Export the trace to get the kept context."); }
});
$("source-meta").addEventListener("click", (event) => {
  if (!(event.target as HTMLElement).closest("#export-trace") || pending || !$("error").hidden) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(exportTrace, null, 2)], { type: "application/json" }));
  const link = document.createElement("a"); link.href = url; link.download = `compression-${scenario.id}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$("apply-custom").addEventListener("click", () => { custom = textarea("custom-source").value; update(); announce("Custom document applied. Evidence checks are unavailable for this text."); $("lab").scrollIntoView({ behavior: "instant" }); });
$("restore-fixture").addEventListener("click", () => { custom = null; update(); announce("Example restored."); });
$("reset").addEventListener("click", () => {
  browserQueryAware = true; previousMethod = "relevance";
  input("aware").checked = true; input("use-focus").checked = true;
  select("method").value = "relevance"; select("granularity").value = "sentence"; select("budget-mode").value = "fixed";
  input("remove").value = "60"; input("min-factor").value = "2"; input("max-factor").value = "6"; input("threshold").value = "80"; input("top-k").value = "3"; input("diversity").value = "0.65";
  setScenario(scenario.id); announce("Experiment reset.");
});
$("stress").addEventListener("click", () => { select("budget-mode").value = "fixed"; input("remove").value = "90"; update(); $("lab").scrollIntoView({ behavior: "instant" }); announce("Target removal is now 90 percent."); });
$("sweep").addEventListener("click", () => {
  if (!$("error").hidden) { announce("Fix the invalid settings before comparing budgets."); return; }
  if (isModelMethod(latestOptions.method)) { announce("Model sweeps are disabled to avoid triggering repeated inference or paid calls. Compare one explicitly requested run at a time."); return; }
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
$("run-model").addEventListener("click", async () => {
  if (running) return;
  update();
  if (!$("error").hidden) return;
  const key = currentKey;
  const request = { source, options: latestOptions, allowPaid: input("allow-paid").checked, failOpen: input("fail-open").checked };
  running = true; update();
  try {
    const response = await fetch("/api/compress", { method: "POST", headers: { "Content-Type": "application/json", "X-Compression-Lab": "1" }, body: JSON.stringify(request), signal: AbortSignal.timeout(100000) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Compression failed.");
    if (modelResults.size >= 8) modelResults.delete(modelResults.keys().next().value!);
    modelResults.set(key, data as Result);
    running = false; update();
    announce(key === currentKey ? "Compression completed. Inspect the result and evidence checks." : "Earlier settings completed; current settings have not run.");
  } catch (error) {
    running = false; update();
    $("error").hidden = false;
    $("error").textContent = error instanceof Error ? error.message : "Compression failed.";
    announce("Compression did not complete. No new model result is available.");
  }
});
setScenario("document");
fetch("/api/capabilities").then(async (response) => {
  if (response.ok) backendCapabilities = await response.json();
  update();
}).catch(() => { /* Static export: offline methods remain available. */ });
