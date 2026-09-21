"use strict";
const $ = (selector) => document.querySelector(selector);
const escapeHTML = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const state = {
  ready: false,
  llm: false,
  search: null,
  answer: null,
  selected: new Set(),
  epoch: 0,
  answerEpoch: 0,
  generating: false,
  summary: null,
};
const niceName = {
  lexical: "Lexical / BM25",
  dense: "Dense",
  hybrid: "Hybrid / RRF",
  hybrid_expanded: "Hybrid + expansion",
  hybrid_weighted: "Weighted hybrid + expansion",
};
const metric = (value, digits = 3) =>
  value == null
    ? '<span class="pending-metric">Pending</span>'
    : Number(value).toFixed(digits);

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(
      "The server could not complete this request. Please try again or check the app connection.",
    );
  }
  if (!response.ok) {
    const message =
      typeof body.detail === "string"
        ? body.detail
        : body.detail?.[0]?.msg || "The request failed. Please try again.";
    throw new Error(message);
  }
  return body;
}

function showError(message) {
  $("#form-error").textContent = message;
  $("#form-error").hidden = !message;
}

async function refreshStatus() {
  try {
    const result = await api("/api/status");
    state.ready = result.ready;
    state.llm = result.llm.available;
    document.querySelectorAll('input[name="mode"]').forEach((input) => {
      input.disabled = input.value === "best" ? !result.best_ready : input.value !== "lexical" && !result.dense_ready;
      if (input.disabled && input.checked) {
        document.querySelector('input[name="mode"][value="lexical"]').checked = true;
      }
    });
    $("#search-button").disabled = !state.ready || !$("#loading-search").hidden;
    $("#answer-model").textContent =
      result.llm.model + " · " + result.llm.provider;
    if (result.manifest) {
      const count = result.manifest.passages.toLocaleString();
      $("#collection-count").textContent = `${count} indexed passages`;
      $("#passage-count").innerHTML = `${count}<span>passages</span>`;
      $("#footer-status").textContent =
        `${count} passages · ${result.manifest.questions.toLocaleString()} questions · Local workspace`;
    }
    if (result.error) {
      showError(
        "The indexes are not ready. Run “uv run python -m scripts.prepare”, then restart the app.",
      );
    }
    if (!result.ready && !result.error) setTimeout(refreshStatus, 3000);
    else if (!state.llm) setTimeout(refreshStatus, 10000);
  } catch {
    setTimeout(refreshStatus, 5000);
  }
}

async function loadExamples() {
  try {
    const examples = await api("/api/questions");
    const candidates = examples.length
      ? examples.slice(0, 3)
      : [
          { question: "What is the role of BRCA1 in DNA repair?" },
          { question: "How does metformin affect type 2 diabetes?" },
          { question: "What causes familial Parkinson disease?" },
        ];
    $("#sample-questions").replaceChildren();
    for (const example of candidates) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "sample-button";
      button.textContent =
        example.question.length > 52
          ? example.question.slice(0, 49) + "…"
          : example.question;
      button.title = example.question;
      button.addEventListener("click", () => {
        $("#question").value = example.question;
        if (state.ready) $("#search-form").requestSubmit();
        else $("#question").focus();
      });
      $("#sample-questions").append(button);
    }
  } catch {
    /* Search remains usable if examples are unavailable. */
  }
}

function renderEvidence() {
  const result = state.search;
  if (result.variant) $("#expand").checked = result.configuration.expand;
  $("#results").hidden = false;
  $("#welcome").hidden = true;
  $("#results-title").textContent =
    `${result.evidence.length} passages, ranked by ${niceName[result.variant] || (result.mode === "hybrid" ? "hybrid search" : result.mode + " search")}`;
  $("#retrieval-time").textContent =
    `${Math.round(result.retrieval_ms)} ms retrieval`;
  $("#score-type").textContent = result.score_type;
  $("#evidence-count").textContent = `(${result.evidence.length})`;
  $("#query-trail").innerHTML =
    `<span class="small-label">SEARCH QUERIES</span>` +
    result.queries
      .map(
        (q, i) =>
          `<span class="query-chip ${i === 0 ? "original" : ""}" title="${i === 0 ? "Original question" : "Query expansion"}">${escapeHTML(q)}</span>`,
      )
      .join("");
  $("#evidence-list").innerHTML = result.evidence.length
    ? result.evidence
        .map((p) => {
          const excerpt =
            p.text.length > 600
              ? p.text.slice(0, 600).replace(/\s+\S*$/, "") + "…"
              : p.text;
          const detail =
            p.text.length > 600
              ? `<details class="evidence-details"><summary>Read full passage</summary><p class="evidence-text">${escapeHTML(p.text)}</p></details>`
              : "";
          return `<article class="evidence-card ${state.selected.has(p.id) ? "selected" : ""}" id="passage-${escapeHTML(p.id)}" tabindex="-1"><div class="evidence-header"><span class="rank-tag">${String(p.rank).padStart(2, "0")}</span><span class="passage-id">PMID ${escapeHTML(p.id)}</span><span class="score-tag" title="${escapeHTML(result.score_type)}">${Number(p.score).toFixed(4)}</span></div><p class="evidence-text">${escapeHTML(excerpt)}</p>${detail}<div class="evidence-footer"><a class="source-link" href="${escapeHTML(p.source_url)}" target="_blank" rel="noopener noreferrer">PubMed record ↗</a><label class="select-label"><input type="checkbox" data-passage="${escapeHTML(p.id)}" ${state.selected.has(p.id) ? "checked" : ""}>Use in answer</label></div><div class="component-scores">${p.lexical_score != null ? "Original query BM25 " + Number(p.lexical_score).toFixed(2) : ""}${p.lexical_score != null && p.dense_score != null ? " · " : ""}${p.dense_score != null ? "Original query cosine " + Number(p.dense_score).toFixed(3) : ""}</div></article>`;
        })
        .join("")
    : '<div class="empty-result">No matching passages were found. Try another biomedical term or enable dense retrieval.</div>';
  updateSelection();
}

function updateSelection() {
  $("#selection-count").textContent =
    `${state.selected.size} selected for the answer`;
  $("#regenerate-answer").disabled =
    state.selected.size === 0 || state.generating;
  for (const checkbox of document.querySelectorAll("[data-passage]")) {
    const selected = state.selected.has(checkbox.dataset.passage);
    checkbox.checked = selected;
    checkbox.closest(".evidence-card").classList.toggle("selected", selected);
    checkbox.disabled = !selected && state.selected.size >= 5;
  }
  if (state.answer) {
    const used = new Set(state.answer.context.map((p) => p.id));
    const stale =
      used.size !== state.selected.size ||
      [...used].some((id) => !state.selected.has(id));
    let notice = $("#selection-stale");
    if (stale && !notice) {
      notice = document.createElement("p");
      notice.id = "selection-stale";
      notice.className = "stale-note";
      notice.textContent =
        "Your selection changed. Generate a new answer to use these passages.";
      $("#answer-content .answer-body").prepend(notice);
    } else if (!stale && notice) notice.remove();
  }
}

function renderAnswer(answer) {
  state.answer = answer;
  let content;
  if (answer.status === "insufficient_evidence") {
    content = `<div class="answer-state"><span aria-hidden="true">△</span> Insufficient evidence</div><p>${escapeHTML(answer.reason || "The selected passages do not support a reliable answer to this question.")}</p>`;
  } else {
    content =
      `<div class="answer-state" style="color:var(--green)"><span aria-hidden="true">✓</span> Citation IDs validated</div>` +
      answer.claims
        .map(
          (claim) =>
            `<p>${escapeHTML(claim.text)} ${claim.passage_ids.map((id) => `<a class="citation-link" href="#passage-${encodeURIComponent(id)}" data-citation="${escapeHTML(id)}" aria-label="Inspect cited passage ${escapeHTML(id)}">${escapeHTML(id)}</a>`).join("")}</p>`,
        )
        .join("");
  }
  const usage = answer.usage;
  const cost =
    usage?.cost_usd == null
      ? "Cost not configured"
      : usage.cost_usd === 0
        ? "$0 API charges · local inference"
        : "$" + Number(usage.cost_usd).toFixed(5) + " estimated API cost";
  const metadata = usage
    ? `<div class="answer-usage">${(usage.latency_ms / 1000).toFixed(1)} s generation · ${usage.input_tokens + usage.output_tokens} tokens<br>${escapeHTML(cost)}</div>`
    : "";
  const context = `<details class="context-details"><summary>Inspect exact context sent to the model (${answer.context.length} passages)</summary>${answer.context.map((p) => `<pre><strong>PMID ${escapeHTML(p.id)}</strong>\n${escapeHTML(p.text)}</pre>`).join("")}</details>`;
  $("#answer-content").innerHTML =
    `<div class="answer-body">${content}${metadata}${context}</div>`;
  $("#answer-actions").hidden = false;
  updateSelection();
}

async function requestAnswer() {
  if (!state.search || !state.selected.size) return;
  const epoch = state.epoch;
  const answerEpoch = ++state.answerEpoch;
  const ids = [...state.selected];
  state.answer = null;
  state.generating = true;
  updateSelection();
  $("#answer-actions").hidden = false;
  $("#answer-content").innerHTML =
    '<div class="answer-loading" role="status"><span class="spinner"></span><div>Reading the selected evidence…<br><span class="selection-note">The first local answer may take a little longer.</span></div></div>';
  try {
    const answer = await api("/api/answer", {
      method: "POST",
      body: JSON.stringify({
        search_id: state.search.search_id,
        passage_ids: ids,
      }),
    });
    if (epoch !== state.epoch || answerEpoch !== state.answerEpoch) return;
    renderAnswer(answer);
  } catch (error) {
    if (epoch !== state.epoch || answerEpoch !== state.answerEpoch) return;
    $("#answer-content").innerHTML =
      `<div class="answer-body"><div class="answer-state">Answer unavailable</div><p>${escapeHTML(error.message)}</p></div>`;
    refreshStatus();
  } finally {
    if (epoch === state.epoch && answerEpoch === state.answerEpoch) {
      state.generating = false;
      updateSelection();
    }
  }
}

$("#search-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = $("#question").value.trim();
  if (query.length < 3)
    return showError("Enter a biomedical question of at least 3 characters.");
  const epoch = ++state.epoch;
  state.answerEpoch++;
  state.answer = null;
  state.generating = false;
  showError("");
  $("#search-button").disabled = true;
  $("#search-button span:first-child").textContent = "Searching";
  $("#loading-search").hidden = false;
  $("#results").hidden = true;
  $("#welcome").hidden = true;
  try {
    const result = await api("/api/search", {
      method: "POST",
      body: JSON.stringify({
        query,
        mode: $('input[name="mode"]:checked').value,
        expand: $("#expand").checked,
        top_k: Number($("#top-k").value),
      }),
    });
    if (epoch !== state.epoch) return;
    state.search = result;
    state.selected = new Set(
      result.evidence.filter((p) => p.selected).map((p) => p.id),
    );
    renderEvidence();
    $("#answer-actions").hidden = false;
    if (state.llm && state.selected.size) requestAnswer();
    else
      $("#answer-content").innerHTML =
        `<div class="answer-body"><div class="answer-state">${result.evidence.length ? "Model connection needed" : "Insufficient evidence"}</div><p>${result.evidence.length ? "Your evidence is ready. Add your Gemini API key to the server configuration, restart the app, then choose “Answer from selection”." : "No passages were retrieved. Try a different query or search mode."}</p></div>`;
  } catch (error) {
    if (epoch === state.epoch) {
      showError(error.message);
      $("#welcome").hidden = false;
    }
  } finally {
    if (epoch === state.epoch) {
      $("#loading-search").hidden = true;
      $("#search-button").disabled = !state.ready;
      $("#search-button span:first-child").textContent = "Search evidence";
    }
  }
});

$("#evidence-list").addEventListener("change", (event) => {
  const input = event.target.closest("[data-passage]");
  if (!input) return;
  if (input.checked && state.selected.size < 5)
    state.selected.add(input.dataset.passage);
  else state.selected.delete(input.dataset.passage);
  updateSelection();
});
$("#regenerate-answer").addEventListener("click", requestAnswer);
$("#answer-content").addEventListener("click", (event) => {
  const link = event.target.closest("[data-citation]");
  if (!link) return;
  const passage = document.getElementById("passage-" + link.dataset.citation);
  if (passage) {
    event.preventDefault();
    passage.scrollIntoView({
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
      block: "center",
    });
    passage.focus({ preventScroll: true });
    passage.classList.add("highlighted");
    setTimeout(() => passage.classList.remove("highlighted"), 2200);
  }
});
document.addEventListener("keydown", (event) => {
  if (
    (event.metaKey || event.ctrlKey) &&
    event.key === "Enter" &&
    !$("#search-view").hidden &&
    !$("#search-button").disabled
  )
    $("#search-form").requestSubmit();
});
document.querySelectorAll('input[name="mode"]').forEach((input) =>
  input.addEventListener("change", () => {
    $("#expand").disabled = input.value === "best" && input.checked;
  }),
);
$("#export-search").addEventListener("click", () => {
  if (!state.search) return;
  const url = URL.createObjectURL(
    new Blob(
      [JSON.stringify({ search: state.search, answer: state.answer }, null, 2)],
      { type: "application/json" },
    ),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "helix-evidence-" + state.search.search_id + ".json";
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

const evaluationColumnHelp = {
  "CONFIGURATION": "The retrieval method and settings used for this run. Every configuration searches the same fixed 100 evaluation questions.",
  "RECALL@5": "Fraction of known relevant passages found in the first 5 results, averaged across evaluation questions. Finding 2 of 3 relevant passages gives 0.667 (66.7%). Higher is better.",
  "RECALL@10": "Fraction of known relevant passages found in the first 10 results, averaged across evaluation questions. Finding all 3 of 3 relevant passages gives 1.000. Higher is better.",
  "MRR@10": "Mean reciprocal rank of the first relevant passage within the top 10. Rank 1 gives 1; rank 2 gives 0.5; no relevant result gives 0. Higher is better.",
  "nDCG@10": "Ranking quality in the top 10 compared with an ideal ranking. Relevant passages nearer the top receive more credit. Scores range from 0 to 1; higher is better.",
  "MEAN LATENCY": "Average retrieval time across the evaluation questions, in milliseconds. Includes query embedding, expansion, and ranking; excludes initial index loading and final answer generation. Lower is faster.",
  "p95 LATENCY": "95th percentile of retrieval time, in milliseconds: approximately 95% of searches finish within this time. Shows slower searches that the average may hide. Lower is faster.",
  "JUDGED QUERIES": "Number of questions with completed LLM-judge results out of the fixed 100. A partial count means the judge scores cover only that completed subset.",
  "CORRECTNESS": "Average LLM-judge score for how accurately and completely the answer matches the question and reference answer. Scores range from 0 to 1; higher is better. Pending means no completed judge results.",
  "GROUNDEDNESS": "Average LLM-judge score for how much of the answer is directly supported by the selected passages. Higher is better. An abstention with no claims is assigned 1, so this score alone does not prove answer correctness.",
  "CONTEXT RELEVANCE": "Average LLM-judge score for the proportion of selected context useful for answering the question. Scores range from 0 to 1; higher is better.",
  "CITATION VALIDITY": "Fraction of generated responses that pass code checks for citation IDs and answer structure. Claims must cite IDs from the selected context. Passing these checks does not prove that the passage supports the claim. Pending means no generated responses."
};

function evaluationHeading(label) {
  const help = escapeHTML(evaluationColumnHelp[label]);
  return `<th scope="col"><span class="metric-help" tabindex="0" title="${help}" aria-label="${escapeHTML(label)}: ${help}">${escapeHTML(label)}</span></th>`;
}

async function renderEvaluation() {
  const container = $("#evaluation-content");
  container.innerHTML =
    '<div class="loading-strip" style="margin-top:30px"><span class="spinner"></span>Loading experiment results…</div>';
  try {
    const result = await api("/api/experiments");
    state.summary = result;
    if (result.status === "not_run") {
      container.innerHTML = `<div class="evaluation-explainer"><h3>The evaluation workspace is ready.</h3><p>The fixed query set and evaluator are included. Run the benchmark to populate measured results here.</p><code class="code-line">uv run python -m scripts.evaluate</code><p>For full answer generation and LLM-judge evaluation on all 100 queries per configuration:</p><code class="code-line">uv run python -m scripts.evaluate --answers</code><p>Scores stay pending until their corresponding experiment actually runs.</p></div>`;
      return;
    }
    const best = result.configurations.find(
      (row) => row.name === result.best_hybrid,
    );
    const header = `<div class="evaluation-cards"><div class="metric-card"><span class="small-label">FIXED EVALUATION SET</span><h2>${result.queries}<span style="font-family:var(--sans);font-size:12px;color:var(--muted)"> questions</span></h2><p>Same IDs in every configuration · seed 42</p></div><div class="metric-card"><span class="small-label">SELECTED HYBRID</span><h2 style="font-size:28px">${escapeHTML(niceName[result.best_hybrid])}</h2><p>nDCG@10 ${metric(best.ndcg_at_10)} · Recall@10 tie-break</p></div></div>`;
    const table = `<div class="table-card"><div class="table-card-head"><h2>Retrieval comparison</h2><a class="text-button" href="/api/experiments/report" download>Download report ↓</a></div><div class="table-scroll"><table><caption class="sr-only">Five retrieval variants measured on the same 100 queries</caption><thead><tr>${evaluationHeading("CONFIGURATION")}${evaluationHeading("RECALL@5")}${evaluationHeading("RECALL@10")}${evaluationHeading("MRR@10")}${evaluationHeading("nDCG@10")}${evaluationHeading("MEAN LATENCY")}${evaluationHeading("p95 LATENCY")}</tr></thead><tbody>${result.configurations.map((row) => `<tr class="${row.name === result.best_hybrid ? "winner" : ""}"><td>${escapeHTML(niceName[row.name])}${row.name === result.best_hybrid ? '<span class="winner-badge">BEST HYBRID</span>' : ""}</td><td>${metric(row.recall_at_5)}</td><td>${metric(row.recall_at_10)}</td><td>${metric(row.mrr_at_10)}</td><td>${metric(row.ndcg_at_10)}</td><td>${metric(row.latency_mean_ms, 1)} ms</td><td>${metric(row.latency_p95_ms, 1)} ms</td></tr>`).join("")}</tbody></table></div><p class="eval-note">Macro averages on dataset relevance labels. Latency includes query embedding and fusion, excludes initial index/model load. Embedding model for this run: ${escapeHTML(result.manifest.embedding_model)} (${escapeHTML(result.manifest.embedding_backend)}). Run ${escapeHTML(result.run_id)}.</p></div>`;
    container.innerHTML = header + table;
  } catch (error) {
    container.innerHTML = `<div class="error-message" role="alert">${escapeHTML(error.message)}</div>`;
  }
}

function switchView(view) {
  for (const section of document.querySelectorAll(".view"))
    section.hidden = section.id !== view + "-view";
  for (const button of document.querySelectorAll("[data-view]")) {
    button.classList.toggle("active", button.dataset.view === view);
    if (button.dataset.view === view)
      button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  if (view === "evaluation") renderEvaluation();
  history.replaceState(null, "", view === "search" ? "/" : "/#" + view);
  $("#main").focus({ preventScroll: true });
}
document
  .querySelectorAll("[data-view]")
  .forEach((button) =>
    button.addEventListener("click", () => switchView(button.dataset.view)),
  );
if (["evaluation", "system"].includes(location.hash.slice(1)))
  switchView(location.hash.slice(1));
refreshStatus();
loadExamples();
