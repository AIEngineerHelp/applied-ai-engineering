// Two explainers built from the real code and the recorded runs:
//   "Who writes the query?"      the text-to-Cypher prompt (rendered by the same
//                                 cypherSystem() the runs used) and one recorded query
//   "When extraction goes wrong" the three ways extraction fails, with recorded evidence

import { cypherSystem } from "../src/cypher-prompt.ts";
import { goldMisses, summarize } from "../src/summary.ts";
import { answers, docById, esc, graph, methodOf, queryExample, questions, resolution, review, variation } from "./data.ts";

const $ = (id: string) => document.getElementById(id)!;
const SUMMARY = summarize(questions, answers.results);
const total = (m: string) => SUMMARY.totals.find((t) => t.method === m)!;
const num = (n: number) => `<span class="lnum">${n}</span>`;

// ---------------------------------------------------------------- the prompt, in four parts

/** Lines of the prompt that produced a piece of the recorded query, by link number. */
export const PROMPT_LINKS: { n: number; line: (l: string) => boolean; query: string; why: string }[] = [
  { n: 1, line: (l) => l.startsWith("- MANAGES_ACCOUNT:"), query: "MANAGES_ACCOUNT", why: "The relation, its direction (Person → Customer) and its meaning come from the schema." },
  { n: 2, line: (l) => l.startsWith("Rules:"), query: "toLower(c.name) CONTAINS", why: "Case-insensitive matching on the name or the aliases comes from the rules." },
  { n: 3, line: (l) => l.startsWith("- Facts can change over time"), query: "ORDER BY r.since DESC", why: "Sorting by the date and keeping one row comes from the line about time." },
];

export function promptParts(prompt: string) {
  const at = (marker: string) => prompt.indexOf(marker);
  const cuts = [0, at("How the graph is stored:"), at("Entity names in the graph, by type:"), at("Rules:"), prompt.length];
  const names = [
    ["The schema", "From data/schema.json: every entity type and relation, with its direction, meaning and properties."],
    ["How the graph is stored", "Labels, the properties on nodes and edges, and how changing facts are kept."],
    ["The entity names", `All ${graph.nodes.length} names, by type, so the query can use the graph's spelling.`],
    ["The rules", "How to match names, what to return, and which Cypher clauses are allowed."],
  ];
  return names.map(([title, note], i) => ({ title, note, text: prompt.slice(cuts[i], cuts[i + 1]).trim() }));
}

function promptBlock(text: string): string {
  return text
    .split("\n")
    .map((l) => {
      const link = PROMPT_LINKS.find((p) => p.line(l));
      return link ? `<span class="p-hit" data-link="q${link.n}">${num(link.n)}${esc(l)}</span>` : esc(l);
    })
    .join("\n");
}

/** The recorded query with the pieces that came from the prompt numbered. */
function annotatedQuery(cypher: string): string {
  let html = esc(cypher);
  for (const p of PROMPT_LINKS) {
    const i = html.indexOf(esc(p.query));
    if (i < 0) continue;
    const end = p.n === 2 ? html.indexOf("\n", i) : p.n === 3 ? html.length : i + esc(p.query).length;
    html = `${html.slice(0, i)}<span class="q-hit" data-link="q${p.n}">${num(p.n)}${html.slice(i, end)}</span>${html.slice(end)}`;
  }
  return html;
}

/** Hover or tap a number to light up both ends, as in the walkthrough. Never scrolls. */
function linkHover(root: HTMLElement) {
  const set = (n: string | null) => {
    root.querySelectorAll(".hot").forEach((el) => el.classList.remove("hot"));
    if (n) root.querySelectorAll(`[data-link="${n}"]`).forEach((el) => el.classList.add("hot"));
  };
  const linkOf = (t: EventTarget | null) => (t as HTMLElement | null)?.closest?.<HTMLElement>("[data-link]")?.dataset.link ?? null;
  root.addEventListener("pointerover", (e) => set(linkOf(e.target)));
  root.addEventListener("click", (e) => set(linkOf(e.target)));
}

export function renderQuery() {
  const prompt = cypherSystem(graph);
  const parts = promptParts(prompt);
  const ex = queryExample;
  const att = ex.attempts[ex.attempts.length - 1];
  const llm = total("cypher");
  const gold = total("gold");
  const lena = methodOf("lena-accounts", "cypher").firstTry;
  const repaired = answers.results.filter((r) => (r.methods.find((m) => m.method === "cypher")?.attempts?.length ?? 0) > 1).length;
  const step = (s: string, cls = "") => `<span class="box ${cls}">${s}</span>`;
  const arr = '<span class="arr" aria-hidden="true">→</span>';
  const keyLines = PROMPT_LINKS.map((p) => {
    const line = prompt.split("\n").find(p.line) ?? "";
    return `<li data-link="q${p.n}">${num(p.n)}<div><code>${esc(line)}</code><p class="caption">${esc(p.why)}</p></div></li>`;
  }).join("");

  $("query-body").innerHTML = `
    <figure class="diagram" aria-label="From a question to an answer">
      <div class="flow">${[step("Question"), step("Gemini, given the schema and the entity names"), step("Cypher"), step("Guard: read-only, bounded"), step("Neo4j, read-only, with a timeout"), step("Rows"), step("Gemini writes the answer from the query and the rows", "good")].join(arr)}</div>
      <figcaption class="caption">Neo4j only runs Cypher. Everything before the guard happens outside the database.</figcaption>
    </figure>

    <h3 class="sub mt-14">What Gemini is given</h3>
    <p class="prose-p">One system prompt, written by code from the schema file and the graph, then the question. It asks for structured output, <code>{cypher, explanation}</code>, at temperature 0. The prompt has four parts:</p>
    <ol class="parts">${parts.map((p, i) => `<li><span class="part-n">${i + 1}</span><div><strong>${esc(p.title)}.</strong> ${esc(p.note)}</div></li>`).join("")}</ol>
    <details class="prompt">
      <summary>Show the whole prompt (${prompt.split("\n").length} lines, exactly as sent)</summary>
      ${parts.map((p, i) => `<div class="prompt-part"><p class="label">${i + 1} · ${esc(p.title)}</p><pre class="cypher">${promptBlock(p.text)}</pre></div>`).join("")}
    </details>
    ${(() => {
      const twice = [...new Set(graph.nodes.map((n) => n.name))].filter((nm) => graph.nodes.filter((n) => n.name === nm).length > 1);
      return twice.length ? `<p class="caption mt-3">Extraction mistakes reach the prompt too: ${twice.map((t) => `“${esc(t)}” is listed under ${graph.nodes.filter((n) => n.name === t).map((n) => n.type).join(" and ")}`).join("; ")}, because one document typed it wrongly.</p>` : "";
    })()}

    <h3 class="sub mt-14">Where each piece of a query comes from</h3>
    <p class="prose-p">Asked “${esc(ex.question)}”, Gemini wrote this query. The numbers join each piece to the prompt line that produced it.</p>
    <div class="link-grid">
      <div>
        <p class="label">The query Gemini wrote <span class="tag-measured">measured</span></p>
        <pre class="cypher">${annotatedQuery(att.cypher)}</pre>
        <p class="label mt-4">Neo4j returned</p>
        <pre class="rows">${esc(JSON.stringify(att.rows))}</pre>
        <p class="label mt-4">The answer</p>
        <p class="answer">${esc(ex.answer)}</p>
        <p class="caption">${ex.calls.length} calls, ${ex.calls.reduce((s, c) => s + c.input + c.output + c.thought, 0).toLocaleString("en")} tokens, $${ex.cost.toFixed(4)}.</p>
      </div>
      <div>
        <p class="label">The prompt lines behind it</p>
        <ol class="key-lines">${keyLines}</ol>
      </div>
    </div>
    <p class="kg"><strong>A pitfall in this exact query.</strong> No document gives a start date for Pellham Labs' account manager, so <code>since</code> is null. In Cypher, <code>ORDER BY … DESC</code> puts nulls first, so with two managers, one undated and one dated, <code>LIMIT 1</code> would pick the undated one. The fix is a prompt rule (“order by <code>coalesce(r.since, r.last_seen)</code>”) or a template that does it. The recorded prompt is left unchanged, so the recorded runs stay valid.</p>
    <p class="kg"><strong>When the query fails or returns nothing,</strong> Gemini gets one repair try, with its query and the error. That happened on ${repaired} of 15 questions: the outage query returned 0 rows, and the repair returned 6, one of them wrong. <strong>The answer step needs the query beside the rows.</strong> Given rows alone, Gemini said “${esc(lena?.answer ?? "")}”</p>

    <h3 class="sub mt-14">Three ways to get the query</h3>
    <div class="roles ways">
      <div><h3 class="sub">The LLM writes it</h3>
        <p class="way-stat"><b>${llm.found}/${llm.of}</b> facts, ${llm.complete} of ${llm.questions} questions complete</p>
        <p>Handles any question the schema can express. It can be confidently wrong: asked which team gets the ticket today, its query returned both owners of the gateway; asked about the outage, it returned a customer who signed a month later. Every query needs the guard.</p></div>
      <div><h3 class="sub">A person writes it</h3>
        <p class="way-stat"><b>${gold.found}/${gold.of}</b> facts, ${gold.complete} of ${gold.questions} questions complete</p>
        <p>The gold queries in this example. Accurate and reviewable, but someone has to write one for every question shape, and a new kind of question has none.</p></div>
      <div><h3 class="sub">Templates, chosen by the LLM</h3>
        <p class="way-stat"><span class="tag-scripted">not built in this example</span></p>
        <p>A person writes parameterised queries; the LLM only picks one and fills in the values. No model-written Cypher runs.</p>
        <pre class="cypher">// account_manager
MATCH (p:Person)-[r:MANAGES_ACCOUNT]->(c:Customer)
WHERE toLower(c.name) = toLower($customer)
   OR toLower($customer)
      IN [a IN c.aliases | toLower(a)]
RETURN p.name AS manager, r.since AS since
ORDER BY coalesce(r.since, r.last_seen) DESC
LIMIT 1</pre>
        <p class="label mt-3">What the LLM returns</p>
        <pre class="cypher">{"template": "account_manager",
 "params": {"customer": "Pellham Labs"}}</pre></div>
    </div>
    <p class="kg"><strong>What teams usually do:</strong> templates for the common questions, an LLM-written query behind a guard as the fallback, and text search when the graph returns nothing.</p>

    <h3 class="sub mt-14">What to pass as context</h3>
    <table class="rtable mt-4"><thead><tr><th>Give the model</th><th>Why</th><th>Here</th></tr></thead><tbody>
      <tr><td class="q">The schema, with directions and meanings</td><td>So it picks the right relation and points it the right way.</td><td>${prompt.split("\n").filter((l) => /^- [A-Z_]+: \(/.test(l)).length} relation types, each with “(from) → (to)” and a sentence</td></tr>
      <tr><td class="q">How time is stored</td><td>“Today” questions need the latest value, not every value.</td><td>since, until, <code>&lt;key&gt;_values</code>, last_seen</td></tr>
      <tr><td class="q">Entity names, or only the ones the question links to</td><td>So it matches the graph's spelling and aliases.</td><td>All ${graph.nodes.length} names</td></tr>
      <tr><td class="q">Rules</td><td>Case-insensitive matching, what to return, allowed clauses, a hop limit.</td><td>One line</td></tr>
      <tr><td class="q">A few example questions with their queries</td><td>Shows the patterns your graph uses.</td><td>Not used</td></tr>
    </tbody></table>
    <p class="caption mt-3">Listing every name only works at ${graph.nodes.length} entities. At scale, find the names in the question first, with a full-text or vector index over entity names (entity linking), and pass only those.</p>`;
  linkHover($("query-body"));
}

// ---------------------------------------------------------------- when extraction goes wrong

export function renderExtraction() {
  const misses = goldMisses(questions, answers.results);
  const gold = total("gold");
  const hybrid = total("hybrid");
  const prose = questions.filter((q) => q.kind === "Detail in prose").map((q) => ({ q, h: methodOf(q.id, "hybrid").context, c: methodOf(q.id, "cypher").context }));
  const proseH = prose.reduce((s, p) => s + p.h.found, 0);
  const proseC = prose.reduce((s, p) => s + p.c.found, 0);
  const proseOf = prose.reduce((s, p) => s + p.h.of, 0);
  const tg = resolution.withoutTypeGuard[0];
  const queued = resolution.queue.length;
  const reviewed = resolution.reviewed.evaluation;
  const card = (n: number, title: string, body: string) => `<div class="fail"><p class="fail-n">${n}</p><h3 class="sub">${title}</h3>${body}</div>`;

  $("extraction-body").innerHTML = `<div class="fails">
    ${card(
      1,
      "Facts the schema has no place for",
      `<p>Even the hand-written queries, run on this graph, missed ${misses.scored.length} of ${gold.of} facts. Extraction never made them edges, because the schema has no relation for a recommendation or a reason:</p>
      <ul>${misses.scored.map((m) => `<li>${esc(m.label)} <span class="caption">(${esc(m.question)})</span></li>`).join("")}</ul>
      ${misses.judged.length ? `<p class="caption">On the global question too: ${misses.judged.map((m) => `“${esc(m.label)}”`).join(", ")}.</p>` : ""}`,
    )}
    ${card(
      2,
      "Wrong or unstated facts",
      `<p>Every quote was verbatim and every type allowed, so validation passed them all:</p>
      <ul>${[...review.wrong, ...review.unsupported].map((w) => `<li><code>${esc(w.source)} ${esc(w.relation)} ${esc(w.target)}</code> <span class="caption">${esc(docById(w.doc).title)}</span></li>`).join("")}
      <li>${review.typeErrors.map((t) => `“${esc(t.name)}” as a ${esc(t.extractedAs)}`).join(", and ")}</li></ul>
      <p>Run again, the same prompt gives slightly different facts: ${variation.inAll} of ${variation.union} appeared in all three runs, ${variation.inOne} in only one.</p>`,
    )}
    ${card(
      3,
      "Bad merges and splits",
      `<ul><li><strong>A split:</strong> “A3” stayed apart from Atlas-3 until a person merged it. Until then every Atlas-3 question would have missed Brightwater Aquaculture's order.</li>
      <li><strong>A merge prevented:</strong> without the rule that only names of the same type merge, “${esc(tg?.members[0].name ?? "")}” (an incident) would have merged into “${esc(tg?.members[1].name ?? "")}” (the service), joining the outage to everything the service touches.</li></ul>`,
    )}
  </div>
  <p class="kg"><strong>The errors are silent and confident.</strong> A wrong edge returns rows like a right one, and a missing edge returns nothing, which reads as “no”. Every mistake is listed in <a href="#mistakes">Where the model went wrong</a>.</p>

  <h3 class="sub mt-14">Defences, in order</h3>
  <ol class="defences">
    <li><strong>Keep the source text, and search it too.</strong> On the prose questions the hybrid found ${proseH} of ${proseOf} facts and the graph ${proseC}; overall the hybrid was complete on ${hybrid.complete} of ${hybrid.questions} questions.</li>
    <li><strong>Measure extraction on its own.</strong> Run hand-written queries on the graph: what they miss (here ${misses.scored.length} of ${gold.of}) is an extraction or schema problem, not a query problem.</li>
    <li><strong>Validate in code:</strong> the schema, a verbatim quote for every fact, well-formed dates. This catches invented quotes and impossible relations; it cannot catch a misreading like the LX-4.</li>
    <li><strong>Design the schema around the questions you expect.</strong> If people will ask why, a reason needs somewhere to go, or the question goes to text search.</li>
    <li><strong>Send unsure merges to a person.</strong> Here ${queued} pairs went to review, and the graph ended with ${reviewed.falseMerges.length} false merges and ${reviewed.falseSplits.length} false splits.</li>
    <li><strong>Store time on every relation,</strong> so “today” questions can pick the latest fact.</li>
    <li><strong>Extract more than once</strong> and review the facts that appear in only one run (${variation.inOne} here).</li>
  </ol>`;
}
