// Entity resolution, stage 2. After the rules (src/resolve.ts), embed every
// remaining name, pair names of the same type whose embeddings are close, and
// ask Gemini whether each pair is the same entity, with the sentences each name
// came from. "same" merges, "different" stays apart, "unsure" waits for a person.
// The result is then scored against the hand-written gold entity list.

import type { Doc } from "../corpus.ts";
import { goldAnyType, goldOf } from "../gold.ts";
import { clusterByRules, mergeClusters, type Cluster, type Mention } from "../resolve.ts";
import type { ExtractionRun } from "./extract.ts";
import { cosine, embed, generateJson } from "./gemini.ts";

/** Pairs at or above this cosine similarity are sent to the LLM. Chosen before looking at the LLM's answers. */
export const CANDIDATE_COSINE = 0.7;

export interface PairDecision {
  a: string;
  b: string;
  type: string;
  cosine: number;
  decision: "same" | "different" | "unsure" | "not checked";
  reason?: string;
}

export interface Resolution {
  clusters: Cluster[];
  ambiguous: { name: string; type: string; candidates: string[] }[];
  pairs: PairDecision[];
  queue: PairDecision[];
  evaluation: Evaluation;
}

export interface Evaluation {
  surfaces: number;
  clusters: number;
  goldEntitiesSeen: number;
  falseMerges: { cluster: string; gold: string[]; members: string[] }[];
  falseSplits: { gold: string; clusters: string[] }[];
  unmapped: { name: string; type: string; docs: string[] }[];
  typeErrors: { name: string; extractedAs: string; goldType: string; docs: string[] }[];
}

/** Sentences from the documents that mention a name, as context for the LLM. */
function contextFor(name: string, docIds: string[], docs: Doc[]): string[] {
  const out: string[] = [];
  for (const id of docIds) {
    const d = docs.find((x) => x.id === id);
    if (!d) continue;
    for (const s of d.text.split(/(?<=[.!?])\s+/)) if (s.includes(name)) out.push(`${d.title}: ${s}`);
  }
  return out.slice(0, 3);
}

export function mentionsOf(run: ExtractionRun): Mention[] {
  return run.docs.flatMap((d) => d.entities.map((e) => ({ name: e.name, type: e.type, docs: [d.doc] })));
}

export async function resolveRun(run: ExtractionRun, docs: Doc[]): Promise<Resolution> {
  const { clusters: ruleClusters, ambiguous } = clusterByRules(mentionsOf(run));
  let clusters = ruleClusters.map((c) => ({ ...c, members: [...c.members] }));

  // Embed each cluster's canonical name with its type.
  const vectors = await embed({ step: "resolve", label: "entity names", kind: "document", items: clusters.map((c) => ({ text: `${c.type}: ${c.name}` })) });
  const vec = new Map(clusters.map((c, i) => [c.id, vectors[i]]));
  const pairs: PairDecision[] = [];
  for (let i = 0; i < clusters.length; i++)
    for (let j = i + 1; j < clusters.length; j++) {
      const a = clusters[i];
      const b = clusters[j];
      if (a.type !== b.type) continue;
      const cos = cosine(vec.get(a.id)!, vec.get(b.id)!);
      if (cos >= 0.55) pairs.push({ a: a.name, b: b.name, type: a.type, cosine: Math.round(cos * 1000) / 1000, decision: "not checked" });
    }
  pairs.sort((x, y) => y.cosine - x.cosine);

  // Ask the LLM about the close pairs.
  const SCHEMA = {
    type: "object",
    properties: {
      decision: { type: "string", enum: ["same", "different", "unsure"] },
      reason: { type: "string", description: "One sentence." },
    },
    required: ["decision", "reason"],
  };
  for (const p of pairs.filter((x) => x.cosine >= CANDIDATE_COSINE)) {
    const ca = clusters.find((c) => c.name === p.a)!;
    const cb = clusters.find((c) => c.name === p.b)!;
    const input = `Two names were extracted from company documents of Corvane Instruments, both as type ${p.type}.

Name A: "${p.a}"
${contextFor(p.a, ca.docs, docs).map((s) => `- ${s}`).join("\n")}

Name B: "${p.b}"
${contextFor(p.b, cb.docs, docs).map((s) => `- ${s}`).join("\n")}

Do A and B refer to the same real-world ${p.type.toLowerCase()}? Answer "same" only if the sentences make it clear, "different" if they are clearly different things, and "unsure" otherwise.`;
    const { data } = await generateJson<{ decision: PairDecision["decision"]; reason: string }>({
      step: "resolve",
      label: `${p.a} | ${p.b}`,
      system: "You check entity resolution for a knowledge graph. Be conservative: a wrong merge connects unrelated facts.",
      input,
      schema: SCHEMA,
    });
    p.decision = data.decision;
    p.reason = data.reason;
  }

  // Apply the confirmed merges.
  for (const p of pairs.filter((x) => x.decision === "same")) {
    const ia = clusters.findIndex((c) => c.members.some((m) => m.name === p.a) && c.type === p.type);
    const ib = clusters.findIndex((c) => c.members.some((m) => m.name === p.b) && c.type === p.type);
    if (ia < 0 || ib < 0 || ia === ib) continue;
    const merged = mergeClusters(clusters[ia], clusters[ib], `cosine ${p.cosine}: ${p.reason}`);
    clusters = clusters.filter((_, k) => k !== ia && k !== ib).concat(merged);
  }
  clusters.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
  const queue = pairs.filter((x) => x.decision === "unsure");
  return { clusters, ambiguous, pairs, queue, evaluation: evaluate(clusters, run) };
}

export interface ReviewDecision {
  a: string;
  b: string;
  type: string;
  decision: "same" | "different";
  note: string;
}

/** Apply a person's decisions on the queued pairs. Returns new clusters; the input is not changed. */
export function applyReview(clusters: Cluster[], decisions: ReviewDecision[]): Cluster[] {
  let out = clusters.map((c) => ({ ...c, members: [...c.members] }));
  for (const d of decisions.filter((x) => x.decision === "same")) {
    const ia = out.findIndex((c) => c.type === d.type && c.members.some((m) => m.name === d.a));
    const ib = out.findIndex((c) => c.type === d.type && c.members.some((m) => m.name === d.b));
    if (ia < 0 || ib < 0 || ia === ib) continue;
    const merged = mergeClusters(out[ia], out[ib], d.note, "person: approved");
    out = out.filter((_, k) => k !== ia && k !== ib).concat(merged);
  }
  return out.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
}

/** Compare clusters with the gold entity list: false merges, false splits, names that fit no gold entity. */
export function evaluate(clusters: Cluster[], run: ExtractionRun): Evaluation {
  const surfaces = clusters.flatMap((c) => c.members.map((m) => ({ ...m, cluster: c })));
  const falseMerges: Evaluation["falseMerges"] = [];
  for (const c of clusters) {
    const golds = [...new Set(c.members.map((m) => goldOf(m.name, c.type)?.name).filter((x): x is string => !!x))];
    if (golds.length > 1) falseMerges.push({ cluster: c.name, gold: golds, members: c.members.map((m) => m.name) });
  }
  const byGold = new Map<string, Set<string>>();
  for (const s of surfaces) {
    const g = goldOf(s.name, s.cluster.type);
    if (g) byGold.set(g.name, new Set([...(byGold.get(g.name) ?? []), s.cluster.name]));
  }
  const falseSplits = [...byGold].filter(([, cs]) => cs.size > 1).map(([gold, cs]) => ({ gold, clusters: [...cs] }));
  const docsOf = (name: string, type: string) => run.docs.filter((d) => d.entities.some((e) => e.name === name && e.type === type)).map((d) => d.doc);
  const unmapped: Evaluation["unmapped"] = [];
  const typeErrors: Evaluation["typeErrors"] = [];
  for (const s of surfaces) {
    if (goldOf(s.name, s.cluster.type)) continue;
    const other = goldAnyType(s.name);
    if (other) typeErrors.push({ name: s.name, extractedAs: s.cluster.type, goldType: other.type, docs: docsOf(s.name, s.cluster.type) });
    else unmapped.push({ name: s.name, type: s.cluster.type, docs: docsOf(s.name, s.cluster.type) });
  }
  return { surfaces: surfaces.length, clusters: clusters.length, goldEntitiesSeen: byGold.size, falseMerges, falseSplits, unmapped, typeErrors };
}
