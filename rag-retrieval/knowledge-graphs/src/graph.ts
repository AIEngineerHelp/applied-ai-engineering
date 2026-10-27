// Build the graph from validated triples and resolved entities. Every edge
// keeps its provenance: the documents, dates and exact quotes it came from, the
// extraction run, and any properties per mention (so a value that changed over
// time, like a unit count, keeps both values with their dates).

import type { Cluster } from "./resolve.ts";
import type { Triple } from "./schema.ts";

export interface GNode {
  id: string;
  name: string;
  type: string;
  aliases: string[];
  docs: string[];
}

export interface Mention {
  doc: string;
  date: string;
  quote: string;
  properties: Record<string, string | number>;
}

export interface GEdge {
  id: string; // source|TYPE|target
  source: string;
  type: string;
  target: string;
  mentions: Mention[]; // sorted by date
}

export interface Graph {
  run: string;
  nodes: GNode[];
  edges: GEdge[];
  dropped: { doc: string; triple: Triple; reason: string }[];
}

export function buildGraph(runId: string, clusters: Cluster[], docs: { doc: string; date: string; triples: Triple[] }[]): Graph {
  const find = (name: string, type: string) => clusters.find((c) => c.type === type && c.members.some((m) => m.name === name));
  const nodes = clusters.map((c) => ({ id: c.id, name: c.name, type: c.type, aliases: c.members.map((m) => m.name).filter((n) => n !== c.name), docs: c.docs }));
  const edges = new Map<string, GEdge>();
  const dropped: Graph["dropped"] = [];
  for (const d of docs) {
    for (const t of d.triples) {
      const s = find(t.source, t.sourceType);
      const o = find(t.target, t.targetType);
      if (!s || !o) {
        dropped.push({ doc: d.doc, triple: t, reason: "entity not resolved" });
        continue;
      }
      if (s.id === o.id) {
        dropped.push({ doc: d.doc, triple: t, reason: "both ends resolved to the same entity" });
        continue;
      }
      const id = `${s.id}|${t.relation}|${o.id}`;
      const e = edges.get(id) ?? { id, source: s.id, type: t.relation, target: o.id, mentions: [] };
      e.mentions.push({ doc: d.doc, date: d.date, quote: t.quote, properties: t.properties });
      edges.set(id, e);
    }
  }
  for (const e of edges.values()) e.mentions.sort((a, b) => a.date.localeCompare(b.date) || a.doc.localeCompare(b.doc));
  return { run: runId, nodes, edges: [...edges.values()], dropped };
}

/** Cypher-friendly relationship properties: lists in date order, plus first and last seen. */
export function edgeProperties(e: GEdge, run: string) {
  const props: Record<string, unknown> = {
    docs: e.mentions.map((m) => m.doc),
    doc_dates: e.mentions.map((m) => m.date),
    quotes: e.mentions.map((m) => m.quote),
    first_seen: e.mentions[0].date,
    last_seen: e.mentions[e.mentions.length - 1].date,
    run,
  };
  // A property stated in any mention keeps every value with the date it was stated
  // (Neo4j lists can't hold nulls, so only mentions that state it are listed), and
  // the latest value as a scalar: units: 510, units_values: [420, 510], units_dates: [...].
  const keys = [...new Set(e.mentions.flatMap((m) => Object.keys(m.properties)))];
  for (const k of keys) {
    const stated = e.mentions.filter((m) => m.properties[k] !== undefined);
    props[`${k}_values`] = stated.map((m) => m.properties[k]);
    props[`${k}_dates`] = stated.map((m) => m.date);
    props[k] = stated[stated.length - 1].properties[k];
  }
  return props;
}
