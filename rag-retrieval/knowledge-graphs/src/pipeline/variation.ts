// How much do repeated extraction runs agree? Each run's triples are mapped to
// gold entity names (so "Varnell Semi" and "Varnell" count as the same thing),
// then compared as sets of (source, relation, target).

import { goldOf } from "../gold.ts";
import type { ExtractionRun } from "./extract.ts";

export const tripleKey = (t: { source: string; sourceType: string; relation: string; target: string; targetType: string }) => {
  const s = goldOf(t.source, t.sourceType)?.name ?? `?${t.source}`;
  const o = goldOf(t.target, t.targetType)?.name ?? `?${t.target}`;
  return `${s} -${t.relation}-> ${o}`;
};

export function variation(runs: ExtractionRun[]) {
  const sets = runs.map((r) => new Set(r.docs.flatMap((d) => d.triples.map(tripleKey))));
  const union = new Set(sets.flatMap((s) => [...s]));
  const inAll = [...union].filter((k) => sets.every((s) => s.has(k)));
  const inOne = [...union].filter((k) => sets.filter((s) => s.has(k)).length === 1);
  const jaccard = (a: Set<string>, b: Set<string>) => [...a].filter((k) => b.has(k)).length / new Set([...a, ...b]).size;
  const pairs: { a: number; b: number; jaccard: number }[] = [];
  for (let i = 0; i < sets.length; i++) for (let j = i + 1; j < sets.length; j++) pairs.push({ a: runs[i].run, b: runs[j].run, jaccard: Math.round(jaccard(sets[i], sets[j]) * 1000) / 1000 });
  const perRun = runs.map((r, i) => ({
    run: r.run,
    entities: r.docs.reduce((s, d) => s + d.entities.length, 0),
    relations: r.docs.reduce((s, d) => s + d.triples.length, 0),
    distinct: sets[i].size,
    rejects: r.docs.reduce((s, d) => s + d.rejects.length, 0),
    cost: Math.round(r.docs.reduce((s, d) => s + d.usage.cost, 0) * 10000) / 10000,
  }));
  // Per document: how many distinct facts each run found, to show where runs disagree most.
  const perDoc = runs[0].docs.map((d) => {
    const counts = runs.map((r) => new Set(r.docs.find((x) => x.doc === d.doc)!.triples.map(tripleKey)));
    const u = new Set(counts.flatMap((s) => [...s]));
    return { doc: d.doc, counts: counts.map((s) => s.size), agreed: [...u].filter((k) => counts.every((s) => s.has(k))).length, union: u.size };
  });
  return { runs: perRun, pairs, union: union.size, inAll: inAll.length, inOne: inOne.length, onlyInOne: inOne.sort(), perDoc };
}
