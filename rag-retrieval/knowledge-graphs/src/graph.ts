// A small in-memory property graph and the three traversals the app uses:
// a fixed relationship pattern (what a Cypher MATCH does), the shortest path
// between two entities, and an entity's neighbourhood (local search).

import { RELATION_TYPES, type Extraction, type Properties, type RelationType } from "./schema.ts";
import { lookup, resolve, type Entity, type Resolution } from "./resolve.ts";

export interface Edge {
  id: string;
  source: string; // entity id
  type: RelationType;
  target: string; // entity id
  properties: Properties;
  /** Where each copy of this relation was stated. Duplicates across documents merge into one edge. */
  evidence: { document: string; text: string }[];
}

export interface Graph {
  nodes: Map<string, Entity>;
  edges: Edge[];
  resolution: Resolution;
}

export function buildGraph(extractions: Extraction[]): Graph {
  const resolution = resolve(extractions);
  const nodes = new Map(resolution.entities.map((e) => [e.id, e]));
  const edges = new Map<string, Edge>();
  for (const x of extractions) {
    const typeOf = new Map(x.entities.map((e) => [e.name, e.type]));
    for (const r of x.relations) {
      const source = lookup(resolution, typeOf.get(r.source) ?? "", r.source);
      const target = lookup(resolution, typeOf.get(r.target) ?? "", r.target);
      if (!source || !target) throw new Error(`Relation ${r.source} ${r.type} ${r.target} in ${x.document} names an unknown entity`);
      const id = `${source}|${r.type}|${target}`;
      const edge = edges.get(id) ?? { id, source, type: r.type, target, properties: {}, evidence: [] };
      Object.assign(edge.properties, r.properties ?? {});
      edge.evidence.push({ document: x.document, text: r.evidence });
      edges.set(id, edge);
    }
  }
  return { nodes, edges: [...edges.values()], resolution };
}

export const findByName = (g: Graph, name: string): Entity | undefined =>
  [...g.nodes.values()].find((e) => e.name === name || e.aliases.includes(name));

/** Entities named in a question, longest names first, without overlapping matches. */
export function linkEntities(g: Graph, text: string): string[] {
  const lower = text.toLowerCase();
  const names = [...g.nodes.values()]
    .flatMap((e) => [e.name, ...e.aliases].map((n) => ({ id: e.id, n: n.toLowerCase() })))
    .sort((a, b) => b.n.length - a.n.length);
  const taken: [number, number][] = [];
  const found: { id: string; at: number }[] = [];
  for (const { id, n } of names) {
    let from = 0;
    for (let at = lower.indexOf(n, from); at !== -1; at = lower.indexOf(n, from)) {
      from = at + 1;
      const end = at + n.length;
      const bounded = !/[\p{L}\p{N}]/u.test(lower[at - 1] ?? " ") && !/[\p{L}\p{N}]/u.test(lower[end] ?? " ");
      if (!bounded || taken.some(([s, e]) => at < e && end > s)) continue;
      taken.push([at, end]);
      found.push({ id, at });
    }
  }
  return [...new Set(found.sort((a, b) => a.at - b.at).map((f) => f.id))];
}

/** One hop of a pattern: follow `rel` outward or inward, optionally to a node type. */
export interface Step {
  rel: RelationType;
  dir: "out" | "in";
}

/** One edge walked in a given direction, for display: from → to. */
export interface Hop {
  edge: Edge;
  from: string;
  to: string;
}

/**
 * Every path from `start` that follows the steps in order, like
 * MATCH (start)-[:A]->()-[:B]->()<-[:C]-(end). Returns the paths and the
 * distinct end nodes.
 */
export function followPattern(g: Graph, start: string, steps: Step[]): { paths: Hop[][]; ends: string[] } {
  let paths: Hop[][] = [[]];
  let heads = [start];
  for (const step of steps) {
    const nextPaths: Hop[][] = [];
    const nextHeads: string[] = [];
    paths.forEach((path, i) => {
      const at = heads[i];
      for (const edge of g.edges) {
        if (edge.type !== step.rel) continue;
        const to = step.dir === "out" ? (edge.source === at ? edge.target : null) : edge.target === at ? edge.source : null;
        if (!to || path.some((h) => h.from === to)) continue; // no cycles
        nextPaths.push([...path, { edge, from: at, to }]);
        nextHeads.push(to);
      }
    });
    paths = nextPaths;
    heads = nextHeads;
  }
  return { paths, ends: [...new Set(heads)] };
}

/** Shortest path between two entities, ignoring edge direction (breadth-first). */
export function shortestPath(g: Graph, from: string, to: string, maxHops = 6): Hop[] | null {
  const prev = new Map<string, Hop | null>([[from, null]]);
  let frontier = [from];
  for (let depth = 0; depth < maxHops && frontier.length && !prev.has(to); depth++) {
    const next: string[] = [];
    for (const at of frontier) {
      for (const edge of g.edges) {
        const other = edge.source === at ? edge.target : edge.target === at ? edge.source : null;
        if (!other || prev.has(other)) continue;
        prev.set(other, { edge, from: at, to: other });
        next.push(other);
      }
    }
    frontier = next;
  }
  if (!prev.has(to)) return null;
  const hops: Hop[] = [];
  for (let h = prev.get(to); h; h = prev.get(h.from)) hops.unshift(h);
  return hops;
}

/** Every edge touching the given entities, out to `depth` hops (local search). */
export function neighbourhood(g: Graph, ids: string[], depth = 1): Hop[] {
  const seen = new Set(ids);
  const hops: Hop[] = [];
  const used = new Set<string>();
  let frontier = [...ids];
  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const at of frontier) {
      for (const edge of g.edges) {
        if (used.has(edge.id)) continue;
        const other = edge.source === at ? edge.target : edge.target === at ? edge.source : null;
        if (!other) continue;
        used.add(edge.id);
        hops.push({ edge, from: at, to: other });
        if (!seen.has(other)) {
          seen.add(other);
          next.push(other);
        }
      }
    }
    frontier = next;
  }
  return hops;
}

/** "Varnell Semiconductor supplies QX-7 radio chip", in the edge's own direction. */
export function sentence(g: Graph, edge: Edge): string {
  const name = (id: string) => g.nodes.get(id)?.name ?? id;
  return `${name(edge.source)} ${RELATION_TYPES[edge.type].reads} ${name(edge.target)}`;
}
