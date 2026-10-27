// Entity resolution, stage 1: deterministic rules. Extractors read one document
// at a time, so the same supplier arrives as "Varnell Semi", "Varnell" and
// "Varnell Semiconductor". The rules here are conservative:
//
//   1. Only names of the same entity type can merge.
//   2. Two names merge when they are equal after normalising case and
//      punctuation ("Atlas 3" = "Atlas-3"), or when every word of the shorter
//      name starts the matching word of the longer one ("Varnell Semi" →
//      "Varnell Semiconductor", "T. Berg" → "Tomas Berg"). Numbers must match.
//   3. A name that matches more than one entity is left alone and reported.
//
// Stage 2 (src/pipeline/resolve-run.ts) proposes further merges from embedding
// similarity and asks an LLM to confirm them; anything uncertain goes to a person.

export type MergeHow = "rule: same name after normalizing" | "rule: abbreviation or initial" | "llm: confirmed" | "person: approved";

export interface Mention {
  name: string;
  type: string;
  docs: string[];
}

export interface Cluster {
  id: string;
  name: string; // canonical: the most complete form seen
  type: string;
  members: { name: string; how: MergeHow | "first"; detail?: string }[];
  docs: string[];
}

export const tokens = (name: string): string[] =>
  name
    .toLowerCase()
    .replace(/['’]s\b/g, "")
    .replace(/[-_/]/g, " ")
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .split(/\s+/)
    .filter(Boolean)
    .filter((w, i, all) => !(i === 0 && w === "the" && all.length > 1));

export const slug = (name: string) => tokens(name).join("-");

/** Why the rules say `a` and `b` are the same entity, or null. */
export function sameByRule(a: string, b: string): MergeHow | null {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.length || !tb.length) return null;
  if (ta.join(" ") === tb.join(" ")) return "rule: same name after normalizing";
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const ok = short.every((w, i) => (/^\d+$/.test(w) ? long[i] === w : long[i].startsWith(w)));
  return ok ? "rule: abbreviation or initial" : null;
}

/**
 * Cluster mentions by the rules. Longest names go first and become canonical, so
 * the result does not depend on document order. Returns the clusters and the
 * names the rules refused because they fit more than one cluster.
 */
export function clusterByRules(mentions: Mention[]): { clusters: Cluster[]; ambiguous: { name: string; type: string; candidates: string[] }[] } {
  const forms = new Map<string, Mention>();
  for (const m of mentions) {
    const key = `${m.type}|${m.name}`;
    const f = forms.get(key) ?? { name: m.name, type: m.type, docs: [] };
    f.docs = [...new Set([...f.docs, ...m.docs])];
    forms.set(key, f);
  }
  const ordered = [...forms.values()].sort(
    (a, b) => tokens(b.name).length - tokens(a.name).length || b.name.length - a.name.length || b.docs.length - a.docs.length || a.name.localeCompare(b.name),
  );
  const clusters: Cluster[] = [];
  const ambiguous: { name: string; type: string; candidates: string[] }[] = [];
  for (const f of ordered) {
    const hits = clusters
      .filter((c) => c.type === f.type)
      .map((c) => ({ c, how: sameByRule(f.name, c.name) }))
      .filter((h): h is { c: Cluster; how: MergeHow } => h.how !== null);
    if (hits.length === 1) {
      hits[0].c.members.push({ name: f.name, how: hits[0].how });
      hits[0].c.docs = [...new Set([...hits[0].c.docs, ...f.docs])];
      continue;
    }
    if (hits.length > 1) ambiguous.push({ name: f.name, type: f.type, candidates: hits.map((h) => h.c.name) });
    let id = `${f.type.toLowerCase()}:${slug(f.name)}`;
    while (clusters.some((c) => c.id === id)) id += "-2";
    clusters.push({ id, name: f.name, type: f.type, members: [{ name: f.name, how: "first" }], docs: [...f.docs] });
  }
  return { clusters, ambiguous };
}

/** Merge cluster `b` into `a` (stage 2). The longer name stays canonical. */
export function mergeClusters(a: Cluster, b: Cluster, detail: string, how: MergeHow = "llm: confirmed"): Cluster {
  const [head, tail] = a.name.length >= b.name.length ? [a, b] : [b, a];
  return {
    id: head.id,
    name: head.name,
    type: head.type,
    members: [...head.members, ...tail.members.map((m) => ({ name: m.name, how, detail }))],
    docs: [...new Set([...head.docs, ...tail.docs])],
  };
}
