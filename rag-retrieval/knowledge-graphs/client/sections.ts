// The plain-language sections that don't move: the problem, the payoff and the
// results table, when the graph loses (and where the model went wrong), who does
// what, taking it to production, and the about text. All numbers come from the
// recorded results through src/summary.ts.

import { pathSvg } from "./graph-svg.ts";
import { answers, costs, docById, esc, graph, MAIN, methodOf, money, plural, PROSE, questionById, questions, resolution, review, run1, variation } from "./data.ts";
import { METHOD_NAMES, METHODS, summarize } from "../src/summary.ts";
import type { Passage } from "../src/pipeline/ask.ts";

const $ = (id: string) => document.getElementById(id)!;
const SUMMARY = summarize(questions, answers.results);

function hits(passages: Passage[], compact = false): string {
  return passages
    .map(
      (p, i) => `<div class="hit"><div class="hit-src"><span>${esc(p.title)} · ${docById(p.doc).date}</span>${compact ? "" : `<span>match ${i + 1} · similarity ${p.score}</span>`}</div>
      <div class="hit-text">${esc(p.text)}</div></div>`,
    )
    .join("");
}

// ---------------------------------------------------------------- 1. the problem

export function renderProblem() {
  const q = questionById(MAIN);
  const vec = methodOf(MAIN, "vector");
  const tf = methodOf(MAIN, "tfidf");
  $("q-text").textContent = q.question;
  $("problem-hits").innerHTML = hits(vec.passages!);
  $("problem-tally").innerHTML = `<b>${vec.context.found} of ${vec.context.of}</b> customers found. Keyword search (TF-IDF) does no better: <b>${tf.context.found} of ${tf.context.of}</b>.`;
  $("problem-facts").innerHTML = `<table class="rtable">${q.items
    .map((it) => `<tr><td class="q">${esc(it.label)}</td><td>${it.support.map((s) => `“${esc(s.quote)}” <span class="caption">${esc(docById(s.doc).title)}</span>`).join("<br>")}</td></tr>`)
    .join("")}</table>`;
}

// ---------------------------------------------------------------- 4. the payoff and the table

const MAIN_START = "QX-7 radio chip";

export function renderPayoff() {
  const q = questionById(MAIN);
  const cy = methodOf(MAIN, "cypher");
  const vec = methodOf(MAIN, "vector");
  const att = cy.attempts![cy.attempts!.length - 1];
  const svg = pathSvg(MAIN_START, (cy.rows ?? []) as { customer: string; product: string }[]);
  $("payoff-body").innerHTML = `<div class="side">
      <h3 class="side-name">Knowledge graph</h3>
      <p class="caption mt-1">Gemini wrote the query; the guard checked it; Neo4j ran it read-only.</p>
      <pre class="cypher">${esc(att.cypher)}</pre>
      <div class="graph-wrap mt-4">${svg}</div>
      <p class="answer">${esc(cy.answer ?? "")}</p>
      <p class="tally"><b class="good">${cy.context.found} of ${cy.context.of}</b> facts the answer needs <span class="tag-measured">measured</span></p>
    </div>
    <div class="side">
      <h3 class="side-name">Chunk search</h3>
      <p class="caption mt-1">The same three paragraphs as at the start.</p>
      <div class="hits">${hits(vec.passages!, true)}</div>
      <p class="answer">${esc(vec.answer ?? "")}</p>
      <p class="tally"><b class="bad">${vec.context.found} of ${vec.context.of}</b> facts the answer needs <span class="tag-measured">measured</span></p>
    </div>`;
  void q;

  const cell = (c: (typeof SUMMARY.rows)[number]["cells"][keyof (typeof SUMMARY.rows)[number]["cells"]]) => {
    if (!c) return `<td class="num caption">–</td>`;
    const cls = c.found === c.of ? "full" : c.found === 0 && !c.countRight ? "none" : "";
    return `<td class="num"><span class="${cls}">${c.found}/${c.of}</span>${c.countRight && c.found < c.of ? '<br><span class="caption">count right, no names</span>' : ""}${c.judged ? ' <span class="caption">judge</span>' : ""}${c.wrong ? ` <span class="flag" title="An outdated or wrong value appeared">⚠ ${c.wrong}</span>` : ""}</td>`;
  };
  $("questions-table").innerHTML = `<p class="caption scroll-hint">Scroll sideways to see all five methods.</p><table class="rtable"><thead><tr><th>Question</th><th class="kind">Kind</th>${METHODS.map((m) => `<th>${esc(METHOD_NAMES[m])}</th>`).join("")}</tr></thead>
    <tbody>${SUMMARY.rows.map((r) => `<tr><td class="q">${esc(r.question)}</td><td class="caption kind">${esc(r.kind)}</td>${METHODS.map((m) => cell(r.cells[m])).join("")}</tr>`).join("")}
    <tr><td class="q"><strong>All questions</strong></td><td class="kind"></td>${SUMMARY.totals.map((t) => `<td class="num"><strong>${t.found}/${t.of}</strong><br><span class="caption">${t.complete} of ${t.questions} complete</span></td>`).join("")}</tr></tbody></table>`;
}

// ---------------------------------------------------------------- the ask panel

const EXAMPLES = ["Which products does Varnell Semiconductor supply parts for?", "Who manages the Pellham Labs account?", "Which components go into the Meridian flow meter?"];

export function renderAskPanel() {
  $("ask").innerHTML = `<h3 class="sub">Ask your own question</h3>
    <p class="caption mt-1">Gemini writes a Cypher query, the read-only guard checks it, and Neo4j runs it with a timeout. You see the query, the rows and the answer. This needs the app running locally with Neo4j and a Gemini key (see the README); the published site only replays the recorded runs above.</p>
    <textarea id="ask-q" rows="2" maxlength="300" aria-label="Your question" placeholder="e.g. Which customers use the Borealis controller?"></textarea>
    <div class="examples">${EXAMPLES.map((e) => `<button type="button" data-example="${esc(e)}">${esc(e)}</button>`).join("")}</div>
    <div class="mt-4 flex items-center gap-4"><button id="ask-go" type="button" class="btn">Ask</button><span id="ask-status" class="caption" aria-live="polite"></span></div>
    <div id="ask-out"></div>`;
  $("ask").addEventListener("click", (e) => {
    const ex = (e.target as HTMLElement).closest<HTMLElement>("[data-example]");
    if (ex) ($("ask-q") as HTMLTextAreaElement).value = ex.dataset.example!;
  });
  $("ask-go").addEventListener("click", async () => {
    const question = ($("ask-q") as HTMLTextAreaElement).value.trim();
    const btn = $("ask-go") as HTMLButtonElement;
    btn.disabled = true;
    $("ask-status").textContent = "Asking…";
    $("ask-out").innerHTML = "";
    try {
      const res = await fetch("api/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question }) });
      const body = (await res.json().catch(() => ({ error: "Asking needs the app running locally (npm start) with Neo4j and a Gemini key." }))) as {
        error?: string;
        answer?: string;
        attempts?: { cypher: string; ok: boolean; blocked: boolean; error: string | null; rows: unknown[]; ms: number }[];
      };
      if (!res.ok || body.error) {
        $("ask-status").textContent = body.error ?? `Not available here (HTTP ${res.status}). Run the app locally to ask your own questions.`;
        return;
      }
      $("ask-status").textContent = "";
      $("ask-out").innerHTML = (body.attempts ?? [])
        .map((a, i) => `<p class="label mt-6">${i === 0 ? "The query Gemini wrote" : "Its repair"}</p><pre class="cypher">${esc(a.cypher)}</pre>${a.ok ? `<pre class="rows">${esc(JSON.stringify(a.rows, null, 1))}</pre><p class="caption">${plural(a.rows.length, "row")} in ${a.ms} ms</p>` : `<p class="cypher-err">${a.blocked ? "Blocked by the guard: " : "Failed: "}${esc(a.error ?? "")}</p>`}`)
        .join("") + `<p class="label mt-6">The answer</p><p class="answer">${esc(body.answer ?? "")}</p>`;
    } catch {
      $("ask-status").textContent = "Not available here. Run the app locally (npm start) with Neo4j and a Gemini key to ask your own questions.";
    } finally {
      btn.disabled = false;
    }
  });
}

// ---------------------------------------------------------------- 5. when the graph loses, and the mistakes

export function renderLoses() {
  const q = questionById(PROSE);
  const vec = methodOf(PROSE, "vector");
  const cy = methodOf(PROSE, "cypher");
  const att = cy.attempts![cy.attempts!.length - 1];
  $("loses-body").innerHTML = `<div class="side">
      <h3 class="side-name">Chunk search</h3>
      <div class="hits">${hits(vec.passages!.slice(0, 1), true)}</div>
      <p class="answer">${esc(vec.answer ?? "")}</p>
      <p class="tally"><b class="good">${vec.context.found} of ${vec.context.of}</b> facts</p>
    </div>
    <div class="side">
      <h3 class="side-name">Knowledge graph</h3>
      <pre class="cypher">${esc(att.cypher)}</pre>
      <pre class="rows">${esc(JSON.stringify(cy.rows, null, 1))}</pre>
      <p class="answer">${esc(cy.answer ?? "")}</p>
      <p class="tally"><b class="bad">${cy.context.found} of ${cy.context.of}</b> facts. The graph knows the delay happened and who was involved; the recommendation was never a relation.</p>
    </div>`;
  void q;
  const hy = SUMMARY.totals.find((t) => t.method === "hybrid")!;
  const vt = SUMMARY.totals.find((t) => t.method === "vector")!;
  const ct = SUMMARY.totals.find((t) => t.method === "cypher")!;
  $("hybrid-note").innerHTML = `<strong>The usual answer is hybrid.</strong> Here, embeddings alone found ${vt.found} of ${vt.of} facts and Gemini's graph queries ${ct.found} of ${ct.of}. A simple hybrid (embedding hits, then the graph around the entities they mention) found ${hy.found} of ${hy.of}, and was complete on ${hy.complete} of ${hy.questions} questions. It still missed the QX-7 customers: the passages it starts from don't mention the products, so a one-hop expansion never reaches the customers.`;

  const upload = methodOf("upload-ticket", "cypher");
  const outage = methodOf("outage-customers", "cypher");
  const first = methodOf("lena-accounts", "cypher").firstTry;
  const items: { title: string; body: string; where: string }[] = [
    ...review.wrong.map((w) => ({ title: `A wrong fact: ${w.source} ${w.relation} ${w.target}`, body: w.why, where: `Extraction, ${docById(w.doc).title}` })),
    ...review.unsupported.map((w) => ({ title: `A fact the text doesn't state: ${w.source} ${w.relation} ${w.target}`, body: w.why, where: `Extraction, ${docById(w.doc).title}` })),
    ...review.typeErrors.map((t) => ({ title: `“${t.name}” typed as a ${t.extractedAs}`, body: t.why, where: `Extraction, ${docById(t.doc).title}` })),
    {
      title: "A split only a person caught: “A3” and “Atlas-3”",
      body: `No rule matches “A3” to “Atlas-3”, and the LLM answered “unsure”. Until a person approved the merge, Brightwater's order hung off a separate node, outside every Atlas-3 question.`,
      where: "Entity resolution",
    },
    {
      title: "A query that returned the wrong rows",
      body: `For “which team gets the ticket today?”, Gemini's query returned both owners of the gateway, the Firmware team (until 1 September) and the Data Platform team, without using the dates on the edges. Its answer: “${upload.answer ?? ""}”`,
      where: "Text-to-Cypher",
    },
    {
      title: "A query that returned nothing, then too much",
      body: `For the outage question, the first query looked for customers linked straight to the incident and returned 0 rows. The repair went through products and returned ${outage.rows?.length ?? 0} customers, including Varnell Bay Marina, which only became a customer a month after the outage.`,
      where: "Text-to-Cypher",
    },
    ...(first
      ? [{ title: "Rows without their query", body: `Asked to answer from the rows alone, Gemini said: “${first.answer}” The rows were the three right accounts; without the query, it couldn't tell what they meant. Giving it the query fixed this.`, where: "Answer writing" }]
      : []),
  ];
  $("mistakes").innerHTML = `<div class="ptable">${items.map((m) => `<div class="prow" role="row"><div class="p-problem">${esc(m.title)}</div><div>${esc(m.body)}</div><div class="caption">${esc(m.where)} <span class="tag-measured">measured</span></div></div>`).join("")}</div>`;
}

// ---------------------------------------------------------------- 6. roles note, about

export function renderRoles() {
  const after = resolution.reviewed.evaluation;
  $("roles-note").innerHTML = `<span class="tag-measured">measured</span> In this demo the LLM's part is real: Gemini (<code>${esc(run1.model)}</code>) extracted all 25 documents three times, checked ${resolution.pairs.filter((p) => p.decision !== "not checked").length} merge candidates, wrote a query for each question and wrote the answers. The code's part is real and tested. The person's part was played by the author: ${resolution.queue.length} merge decisions and a review of the extracted facts, both written by hand and marked as such. Result: ${after.clusters} entities, ${graph.edges.length} edges, ${plural(after.falseMerges.length, "false merge")}, ${plural(after.falseSplits.length, "false split")}.`;
  $("about-text").innerHTML = `Twenty-five synthetic documents about a fictional sensor maker, and 15 questions with gold answers, were written by hand before any model ran. Everything else is a recorded run: ${run1.model} for extraction (three runs agreeing at a Jaccard of ${variation.pairs.map((p) => p.jaccard.toFixed(2)).join(", ")}), ${answers.embeddingModel} for embeddings, Neo4j for the graph. In total ${costs.total.calls} model calls cost ${money(costs.total.cost)}. The page replays those runs; it calls no model unless you run it locally and ask your own question.`;
}

// ---------------------------------------------------------------- 7. production

interface Row {
  problem: string;
  wrong: string;
  handle: string;
  demo?: { href: string; label: string };
}

export function productionRows(): Row[] {
  const extractCost = costs.steps.find((s) => s.step === "extract");
  return [
    {
      problem: "Extraction quality and cost",
      wrong: `Every chunk is an LLM call, and extraction misses facts, adds implied ones and mistypes entities. In one run here: ${review.wrong.length} wrong and ${review.unsupported.length} unstated relation out of ${variation.runs[0].relations}, and ${review.typeErrors.length} type errors.`,
      handle: `Extract against a schema with structured output; require a verbatim quote and check it in code; review a sample; measure agreement between runs (here ${variation.pairs.map((p) => p.jaccard.toFixed(2)).join(", ")}). Tune prompts on your data: Microsoft GraphRAG's docs strongly encourage its auto-tuning. If indexing cost is the problem, LazyGraphRAG defers LLM use to query time (indexing at 0.1% of full GraphRAG's cost, by Microsoft's account). Here: ${extractCost ? money(extractCost.cost) : "–"} for three runs of 25 short documents.`,
      demo: { href: "#mistakes", label: "See the mistakes" },
    },
    {
      problem: "Schema design and change",
      wrong: "Too loose, and every sentence invents a relation name; too strict, and facts you need are dropped (here, every recommendation).",
      handle: "Start from the questions people ask. Keep the schema small, versioned and in one file used by both the prompt and the validation. Log what gets rejected or left unmapped and review it; re-extract affected documents when the schema changes.",
    },
    {
      problem: "Entity resolution errors",
      wrong: "A false merge joins unrelated facts; a false split breaks every path through that entity (here, “A3” cut Brightwater out of the Atlas-3 until a person merged it).",
      handle: "Rules within a type, refusing ambiguous names; embeddings to propose candidates; an LLM to check with context; a person for anything unsure. Keep merge decisions as data so they can be reviewed and undone, and measure them against a labelled sample. Neo4j's GraphRAG package ships exact, fuzzy and embedding-based resolvers.",
      demo: { href: "#theatre", label: "See the merge" },
    },
    {
      problem: "Stale facts and provenance",
      wrong: "Facts change (Osterby went from 420 to 510 units; the gateway changed owner), and an old edge looks as current as a new one.",
      handle: "Give every edge its source: document, date, quote and run, as here. Keep each value with the date it was stated, and prefer the latest when a question asks about now. When a source is deleted, retract the edges only it supports; re-extract a document when it changes.",
    },
    {
      problem: "Text-to-Cypher safety",
      wrong: "A model-written query can write, delete, or run until the database runs out of memory. A read transaction alone is not protection: the Neo4j driver manual says there is no security guarantee that a write in read mode is rejected.",
      handle: "Check the query text before it runs (as the guard here does: one read-only statement, bounded paths, a row limit). Connect as a read-only user where the plan allows it (Neo4j's built-in reader role); set server limits (db.transaction.timeout, db.memory.transaction.max); prefer query templates for frequent questions. LangChain's GraphCypherQAChain refuses to run until you set allow_dangerous_requests, for this reason.",
    },
    {
      problem: "Graph size and query latency",
      wrong: "Variable-length paths explode on a large graph, and name lookups without an index scan every node.",
      handle: "Add a uniqueness constraint on ids and search-performance indexes on the properties you match (Neo4j: they let the planner evaluate predicates more efficiently). Bound hops (5 here) and rows (100 here); precompute paths that are asked often.",
    },
    {
      problem: "Global questions",
      wrong: "“What are the main supply risks?” has no single entity to start from, and rows are not themes. Every method here scored 2 of 4 by the judge.",
      handle: "Summarise communities of the graph and answer from the summaries, as Microsoft GraphRAG's global search does with map-reduce over community reports; lower community levels give more detail at higher cost. One community-summary attempt here scored the same 2 of 4.",
    },
    {
      problem: "Hybrid vector + graph retrieval",
      wrong: "The graph misses prose; chunk search misses chains.",
      handle: "Combine them: vector hits, then the graph around the entities they mention (as here), or the graph first, then the passages its edges came from. Neo4j's VectorCypherRetriever and LightRAG's hybrid and mix modes are examples. Measure both on your questions.",
      demo: { href: "#loses", label: "See hybrid" },
    },
    {
      problem: "Permissions",
      wrong: "A graph merges facts from documents with different readers, and a traversal can walk into facts the person asking may not see.",
      handle: "Keep the source documents on every edge and filter by what the asker may read, at query time. Neo4j Enterprise supports fine-grained privileges (GRANT and DENY on labels, relationship types and properties); otherwise keep separate graphs per audience. Strip personal data before extraction.",
    },
  ];
}

export function renderProduction() {
  const step = (s: string) => `<span class="pbox">${s}</span>`;
  const arr = '<span class="arr" aria-hidden="true">→</span>';
  const ingest = ["New document", "Split into sections", "Extract with the schema (LLM)", "Check types and quotes (code)", "Resolve names: rules, embeddings, LLM, person", "MERGE into the graph, with sources", "Re-summarise communities"];
  const query = ["Question", "Cypher from a template or the LLM", "Guard: read-only, bounded", "Run as a read-only user, with a timeout", "Answer with the path and its quotes"];
  $("production-body").innerHTML = `<figure class="diagram" aria-label="The production pipeline">
      <div class="lane"><div class="lane-name">When a document arrives</div><div class="flow">${ingest.map(step).join(arr)}</div></div>
      <div class="lane"><div class="lane-name">When a question arrives</div><div class="flow">${query.map(step).join(arr)}${arr}<span class="pbox muted">Not in the graph: fall back to chunk search</span></div></div>
    </figure>
    <div class="ptable" role="table" aria-label="Problems at scale and how to handle them">
      <div class="prow phead" role="row"><div role="columnheader">Problem</div><div role="columnheader">What goes wrong</div><div role="columnheader">How to handle it</div></div>
      ${productionRows()
        .map(
          (r) => `<div class="prow" role="row"><div role="cell" class="p-problem">${esc(r.problem)}</div><div role="cell"><span class="p-k">What goes wrong</span>${esc(r.wrong)}</div><div role="cell"><span class="p-k">How to handle it</span>${esc(r.handle)}${r.demo ? ` <a class="p-demo" href="${r.demo.href}">${esc(r.demo.label)} ↑</a>` : ""}</div></div>`,
        )
        .join("")}
    </div>
    <p class="caption mt-4">Sources: <a href="https://microsoft.github.io/graphrag/prompt_tuning/overview/">GraphRAG prompt tuning</a> · <a href="https://www.microsoft.com/en-us/research/blog/lazygraphrag-setting-a-new-standard-for-quality-and-cost/">LazyGraphRAG</a> · <a href="https://microsoft.github.io/graphrag/query/global_search/">GraphRAG global search</a> · <a href="https://neo4j.com/docs/javascript-manual/current/transactions/">Neo4j driver: transactions</a> · <a href="https://neo4j.com/docs/operations-manual/current/authentication-authorization/built-in-roles/">Neo4j built-in roles</a> · <a href="https://neo4j.com/docs/operations-manual/current/configuration/configuration-settings/">Neo4j configuration settings</a> · <a href="https://neo4j.com/docs/operations-manual/current/authentication-authorization/manage-privileges/">Neo4j privileges</a> · <a href="https://neo4j.com/docs/cypher-manual/current/indexes/search-performance-indexes/overview/">Neo4j indexes</a> · <a href="https://reference.langchain.com/python/langchain-neo4j/chains/graph_qa/cypher/GraphCypherQAChain">GraphCypherQAChain</a> · <a href="https://neo4j.com/docs/neo4j-graphrag-python/current/user_guide_rag.html">neo4j-graphrag</a> · <a href="https://github.com/HKUDS/LightRAG">LightRAG</a></p>`;
}

