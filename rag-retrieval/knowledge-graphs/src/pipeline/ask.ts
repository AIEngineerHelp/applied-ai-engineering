// Step 4: answer every question with every method, and score each by code.
//
//   tfidf      top 3 paragraphs by TF-IDF (offline baseline)
//   vector     top 3 paragraphs by Gemini embeddings
//   cypher     Gemini writes Cypher from the schema; the guard checks it; Neo4j runs it read-only
//   gold       the hand-written Cypher for the question, on the same graph (separates query errors from graph errors)
//   hybrid     the vector hits, plus the graph neighbourhood of the entities those passages mention
//   community  for the global question only: summaries of graph communities, combined (GraphRAG-style)
//
// For vector, cypher, hybrid and community, Gemini also writes a short answer from
// that method's context, and the answer is scored too. The global question's
// answers are graded by an LLM judge, whose verdicts and reasons are recorded.

import type { Doc } from "../corpus.ts";
import type { Graph } from "../graph.ts";
import { chunkDocuments, TfIdfIndex, type Chunk } from "../retrieve.ts";
import { schemaText } from "../schema.ts";
import { scoreEither, scorePassages, scoreText, type Question, type Score } from "../score.ts";
import { cosine, embed, generateJson, generateText } from "./gemini.ts";
import { runReadOnly, type QueryRun } from "./neo4j.ts";

export const K = 3;

export interface Passage {
  id: string;
  doc: string;
  title: string;
  text: string;
  score: number;
}

export interface CypherAttempt {
  cypher: string;
  explanation: string;
  run: QueryRun;
}

export interface MethodResult {
  method: "tfidf" | "vector" | "cypher" | "gold" | "hybrid" | "community";
  passages?: Passage[];
  attempts?: CypherAttempt[]; // text-to-Cypher: the first try, then one repair if needed
  rows?: Record<string, unknown>[];
  edges?: { from: string; rel: string; to: string; quote: string }[];
  context: Score; // facts found in what the method retrieved
  answer?: string;
  answerScore?: Score; // facts found in the written answer
  firstTry?: { answer: string; answerScore: Score; note: string }; // an earlier answer kept as a recorded mistake
  judge?: { items: { label: string; present: boolean; reason: string }[]; found: number; of: number };
}

export interface QuestionResult {
  id: string;
  methods: MethodResult[];
}

const ANSWER_SYSTEM =
  "You answer questions about Corvane Instruments using only the context given. Be brief: one to three sentences. If the context does not contain the answer, say what is missing. Do not use outside knowledge.";

export function cypherSystem(graph: Graph) {
  const names: Record<string, string[]> = {};
  for (const n of graph.nodes) (names[n.type] ??= []).push(n.name);
  return `You translate questions into one read-only Cypher query for a Neo4j knowledge graph about Corvane Instruments.

${schemaText()}

How the graph is stored:
- Every node has the label Entity and one type label from the list above, and the properties name (the canonical name) and aliases (a list of other names).
- Relationships have the types above, and these properties: quotes (the source sentences), docs, doc_dates (ascending dates of the documents that stated it), first_seen, last_seen. When stated: since, until, units, role, date hold the latest value; <key>_values and <key>_dates hold every value with its date.
- Facts can change over time: prefer the most recent statement (since, last_seen) when the question asks about "today", "now" or a current value.

Entity names in the graph, by type:
${Object.entries(names).map(([t, ns]) => `- ${t}: ${ns.join(", ")}`).join("\n")}

Rules: match names case-insensitively with toLower(...) CONTAINS on name or aliases; return names and values, not whole nodes; at most 5 hops; only MATCH, OPTIONAL MATCH, WITH, UNWIND, WHERE, RETURN, ORDER BY, LIMIT.`;
}

const CYPHER_SCHEMA = {
  type: "object",
  properties: {
    cypher: { type: "string", description: "One read-only Cypher query." },
    explanation: { type: "string", description: "One sentence: which path the query follows." },
  },
  required: ["cypher", "explanation"],
};

export async function textToCypher(q: string, graph: Graph, label: string): Promise<CypherAttempt[]> {
  const system = cypherSystem(graph);
  const first = await generateJson<{ cypher: string; explanation: string }>({ step: "text-to-cypher", label, system, input: `Question: ${q}`, schema: CYPHER_SCHEMA });
  const attempts: CypherAttempt[] = [{ ...first.data, run: await runReadOnly(first.data.cypher) }];
  const last = attempts[0];
  // One repair attempt when the query failed or returned nothing, as many text-to-Cypher systems do.
  if (!last.run.ok || last.run.rows.length === 0) {
    const problem = last.run.ok ? "The query ran but returned no rows." : `The query failed: ${last.run.error}`;
    const fix = await generateJson<{ cypher: string; explanation: string }>({
      step: "text-to-cypher",
      label: `${label} (repair)`,
      system,
      input: `Question: ${q}\n\nYour previous query:\n${last.cypher}\n\n${problem}\nWrite a corrected query.`,
      schema: CYPHER_SCHEMA,
    });
    attempts.push({ ...fix.data, run: await runReadOnly(fix.data.cypher) });
  }
  return attempts;
}

/** Embeddings for every paragraph, computed once (document prefix with the document's title). */
export async function embedChunks(chunks: Chunk[]) {
  return embed({ step: "embed", label: "paragraphs", kind: "document", items: chunks.map((c) => ({ text: c.text, title: c.title })) });
}

const asPassage = (c: Chunk, score: number): Passage => ({ id: c.id, doc: c.document, title: c.title, text: c.text, score: Math.round(score * 1000) / 1000 });

export function vectorSearch(qv: number[], chunks: Chunk[], vectors: number[][], k = K): Passage[] {
  return chunks
    .map((c, i) => ({ c, s: cosine(qv, vectors[i]) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, k)
    .map(({ c, s }) => asPassage(c, s));
}

/** Entities a passage mentions: by any of their names, or because an edge's quote comes from it. */
export function entitiesIn(passages: Passage[], graph: Graph): string[] {
  const text = passages.map((p) => p.text.toLowerCase()).join("\n");
  const ids = new Set<string>();
  for (const n of graph.nodes) if ([n.name, ...n.aliases].some((a) => a.length > 2 && text.includes(a.toLowerCase()))) ids.add(n.id);
  return [...ids];
}

/**
 * Answers from query rows need the query beside them: rows like ["Osterby", "Calder"] mean nothing
 * on their own. The first recorded run used ANSWER_SYSTEM for rows too, and the model refused
 * ("the context does not mention Lena Vik"); that first try is kept in the results.
 */
export const GRAPH_ANSWER_SYSTEM =
  "You answer questions about Corvane Instruments from the result of a database query that was written to answer the question. The rows are the query's answer: read them together with the query. Be brief: one to three sentences. If the rows are empty or don't answer the question, say so. Do not use outside knowledge.";

export async function graphAnswer(label: string, question: string, attempt: CypherAttempt) {
  const r = attempt.run;
  const context = r.ok ? `Query:\n${r.cypher}\n\nWhat the query does: ${attempt.explanation}\n\nRows:\n${JSON.stringify(r.rows)}` : `The query failed: ${r.error}`;
  const { text } = await generateText({ step: "answer", label, system: GRAPH_ANSWER_SYSTEM, input: `${context}\n\nQuestion: ${question}` });
  return text.trim();
}

async function answer(label: string, question: string, context: string) {
  const { text } = await generateText({ step: "answer", label, system: ANSWER_SYSTEM, input: `Context:\n${context}\n\nQuestion: ${question}` });
  return text.trim();
}

export async function judge(q: Question, answerText: string, label: string) {
  const schema = {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: { type: "object", properties: { label: { type: "string" }, present: { type: "boolean" }, reason: { type: "string" } }, required: ["label", "present", "reason"] },
      },
    },
    required: ["items"],
  };
  const { data } = await generateJson<{ items: { label: string; present: boolean; reason: string }[] }>({
    step: "judge",
    label,
    system: "You grade an answer against a list of expected points. A point is present only if the answer states it, in any wording. Give one short reason per point.",
    input: `Question: ${q.question}\n\nExpected points:\n${q.items.map((it) => `- ${it.label}`).join("\n")}\n\nAnswer to grade:\n${answerText}`,
    schema,
  });
  const items = q.items.map((it) => data.items.find((x) => x.label === it.label) ?? { label: it.label, present: false, reason: "The judge did not return this point." });
  return { items, found: items.filter((i) => i.present).length, of: items.length };
}

/** Communities by label propagation (deterministic: fixed order, ties to the smallest label). */
export function communities(graph: Graph): string[][] {
  const label = new Map(graph.nodes.map((n) => [n.id, n.id]));
  const nbrs = new Map(graph.nodes.map((n) => [n.id, [] as string[]]));
  for (const e of graph.edges) {
    nbrs.get(e.source)!.push(e.target);
    nbrs.get(e.target)!.push(e.source);
  }
  const ids = graph.nodes.map((n) => n.id).sort();
  for (let it = 0; it < 20; it++) {
    let changed = false;
    for (const id of ids) {
      const counts = new Map<string, number>();
      for (const m of nbrs.get(id)!) counts.set(label.get(m)!, (counts.get(label.get(m)!) ?? 0) + 1);
      if (!counts.size) continue;
      const best = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
      if (best !== label.get(id)) {
        label.set(id, best);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const groups = new Map<string, string[]>();
  for (const [id, l] of label) groups.set(l, [...(groups.get(l) ?? []), id]);
  return [...groups.values()].filter((g) => g.length >= 3).sort((a, b) => b.length - a.length);
}

export async function communitySummaries(graph: Graph) {
  const name = (id: string) => graph.nodes.find((n) => n.id === id)!.name;
  const out: { members: string[]; summary: string }[] = [];
  for (const [i, members] of communities(graph).entries()) {
    const set = new Set(members);
    const facts = graph.edges.filter((e) => set.has(e.source) && set.has(e.target)).map((e) => `- ${name(e.source)} ${e.type} ${name(e.target)}: "${e.mentions.map((m) => m.quote).join('" / "')}"`);
    const { text } = await generateText({
      step: "community",
      label: `community ${i + 1}`,
      system: "You summarise one community of a knowledge graph for later questions. Four sentences at most. Mention risks, dependencies and changes over time when the facts show them.",
      input: `Entities: ${members.map(name).join(", ")}\n\nFacts:\n${facts.join("\n")}`,
    });
    out.push({ members: members.map(name), summary: text.trim() });
  }
  return out;
}

export async function askAll(o: { questions: Question[]; docs: Doc[]; graph: Graph }): Promise<{ results: QuestionResult[]; chunkVectors: number[][]; questionVectors: number[][]; summaries: { members: string[]; summary: string }[] }> {
  const chunks = chunkDocuments(o.docs);
  const tfidf = new TfIdfIndex(chunks);
  const chunkVectors = await embedChunks(chunks);
  const questionVectors = await embed({ step: "embed", label: "questions", kind: "query", items: o.questions.map((q) => ({ text: q.question })) });
  const summaries = await communitySummaries(o.graph);
  const name = (id: string) => o.graph.nodes.find((n) => n.id === id)?.name ?? id;
  const results: QuestionResult[] = [];

  for (const [qi, q] of o.questions.entries()) {
    console.log(`  ${q.id}`);
    const methods: MethodResult[] = [];
    const passagesText = (ps: Passage[]) => ps.map((p) => `[${p.title}] ${p.text}`).join("\n\n");

    const tf = tfidf.search(q.question, K).map((h) => asPassage(h.chunk, h.score));
    methods.push({ method: "tfidf", passages: tf, context: scorePassages(q, tf) });

    const vec = vectorSearch(questionVectors[qi], chunks, chunkVectors);
    const vecAnswer = await answer(`${q.id} vector`, q.question, passagesText(vec));
    methods.push({ method: "vector", passages: vec, context: scorePassages(q, vec), answer: vecAnswer, answerScore: scoreText(q, vecAnswer) });

    const attempts = await textToCypher(q.question, o.graph, q.id);
    const final = attempts[attempts.length - 1].run;
    const rowsText = JSON.stringify(final.rows);
    const cyAnswer = await graphAnswer(`${q.id} cypher`, q.question, attempts[attempts.length - 1]);
    methods.push({ method: "cypher", attempts, rows: final.rows, context: scoreText(q, rowsText), answer: cyAnswer, answerScore: scoreText(q, cyAnswer) });

    const gold = await runReadOnly(q.cypher);
    methods.push({ method: "gold", attempts: [{ cypher: q.cypher, explanation: "Hand-written gold query.", run: gold }], rows: gold.rows, context: scoreText(q, JSON.stringify(gold.rows)) });

    // Hybrid: vector hits → the entities they mention → one hop around them in Neo4j.
    const ids = entitiesIn(vec, o.graph);
    const hood = await runReadOnly(
      "MATCH (n:Entity)-[r]-(m:Entity) WHERE n.id IN $ids RETURN DISTINCT startNode(r).name AS from, type(r) AS rel, endNode(r).name AS to, r.quotes[size(r.quotes) - 1] AS quote LIMIT 100",
      { ids },
    );
    const edges = hood.rows as { from: string; rel: string; to: string; quote: string }[];
    const edgesText = edges.map((e) => `${e.from} ${e.rel} ${e.to} ("${e.quote}")`).join("\n");
    const hyAnswer = await answer(`${q.id} hybrid`, q.question, `${passagesText(vec)}\n\nGraph facts around the entities in these passages:\n${edgesText}`);
    methods.push({
      method: "hybrid",
      passages: vec,
      edges,
      context: scoreEither(scorePassages(q, vec), scoreText(q, edgesText)),
      answer: hyAnswer,
      answerScore: scoreText(q, hyAnswer),
    });

    if (q.judge) {
      const ctx = summaries.map((s, i) => `Community ${i + 1} (${s.members.join(", ")}): ${s.summary}`).join("\n\n");
      const coAnswer = await answer(`${q.id} community`, q.question, ctx);
      methods.push({ method: "community", context: scoreText(q, ctx), answer: coAnswer, answerScore: scoreText(q, coAnswer) });
      for (const m of methods.filter((x) => x.answer)) m.judge = await judge(q, m.answer!, `${q.id} ${m.method}`);
    }
    void name;
    results.push({ id: q.id, methods });
  }
  return { results, chunkVectors, questionVectors, summaries };
}
