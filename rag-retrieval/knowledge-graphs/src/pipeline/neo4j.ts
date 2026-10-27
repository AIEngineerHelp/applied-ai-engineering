// Neo4j: load the graph (idempotent MERGE, provenance on every node and edge)
// and run read-only queries. The connection comes from NEO4J_URI,
// NEO4J_USERNAME and NEO4J_PASSWORD, so local Docker and Neo4j AuraDB differ
// only in configuration. The Cypher is the same.

import neo4j, { type Driver } from "neo4j-driver";
import { guardCypher } from "../cypher-guard.ts";
import { edgeProperties, type Graph } from "../graph.ts";
import { ENTITY_TYPES, RELATION_TYPES } from "../schema.ts";

let driver: Driver | null = null;
export function db(): Driver {
  const { NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD } = process.env;
  if (!NEO4J_URI || !NEO4J_USERNAME || !NEO4J_PASSWORD) throw new Error("Set NEO4J_URI, NEO4J_USERNAME and NEO4J_PASSWORD in .env (see .env.example).");
  driver ??= neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USERNAME, NEO4J_PASSWORD), { connectionTimeout: 10_000 });
  return driver;
}
export async function closeDb() {
  await driver?.close();
  driver = null;
}

/**
 * Replace the knowledge graph with `graph`: delete every :Entity node (and so its
 * relationships), then MERGE the graph. Idempotent, and it leaves other data, such
 * as the :AskLog rate-limit nodes, in place. Labels and relationship types come only
 * from the schema. No model calls.
 */
export async function loadGraph(graph: Graph) {
  const session = db().session({ defaultAccessMode: neo4j.session.WRITE });
  try {
    await session.run("MATCH (n:Entity) DETACH DELETE n");
    await session.run("CREATE CONSTRAINT entity_id IF NOT EXISTS FOR (n:Entity) REQUIRE n.id IS UNIQUE");
    for (const type of ENTITY_TYPES) {
      const rows = graph.nodes.filter((n) => n.type === type).map((n) => ({ id: n.id, name: n.name, aliases: n.aliases, docs: n.docs }));
      if (!rows.length) continue;
      await session.run(
        `UNWIND $rows AS r MERGE (n:Entity {id: r.id}) SET n:${type}, n.name = r.name, n.aliases = r.aliases, n.docs = r.docs, n.run = $run`,
        { rows, run: graph.run },
      );
    }
    for (const type of RELATION_TYPES) {
      const rows = graph.edges.filter((e) => e.type === type).map((e) => ({ source: e.source, target: e.target, props: edgeProperties(e, graph.run) }));
      if (!rows.length) continue;
      await session.run(
        `UNWIND $rows AS r MATCH (a:Entity {id: r.source}), (b:Entity {id: r.target}) MERGE (a)-[e:${type}]->(b) SET e += r.props`,
        { rows },
      );
    }
    const counts = await session.run("MATCH (n:Entity) WITH count(n) AS nodes MATCH (:Entity)-[r]->(:Entity) RETURN nodes, count(r) AS edges");
    return { nodes: Number(counts.records[0].get("nodes")), edges: Number(counts.records[0].get("edges")) };
  } finally {
    await session.close();
  }
}

/** Driver values (integers, nodes, relationships, paths) to plain JSON. */
export function plain(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (neo4j.isInt(v)) return (v as { toNumber(): number }).toNumber();
  if (Array.isArray(v)) return v.map(plain);
  if (neo4j.isNode(v as never)) {
    const n = v as unknown as { labels: string[]; properties: Record<string, unknown> };
    return { labels: n.labels.filter((l) => l !== "Entity"), ...(plain(n.properties) as object) };
  }
  if (neo4j.isRelationship(v as never)) {
    const r = v as unknown as { type: string; properties: Record<string, unknown> };
    return { type: r.type, ...(plain(r.properties) as object) };
  }
  if (neo4j.isPath(v as never)) {
    const p = v as unknown as { segments: { start: unknown; relationship: { type: string }; end: unknown }[] };
    return p.segments.map((s) => ({ from: (plain(s.start) as { name?: string }).name, rel: s.relationship.type, to: (plain(s.end) as { name?: string }).name }));
  }
  if (typeof v === "object") return Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, plain(x)]));
  return v;
}

export interface QueryRun {
  cypher: string; // as run (after the guard added a LIMIT, if it did)
  ok: boolean;
  rows: Record<string, unknown>[];
  error: string | null;
  blocked: boolean; // stopped by the guard, never sent to the database
  ms: number;
}

/** Guard, then run in a read transaction with a server-side timeout. */
export async function runReadOnly(cypher: string, params: Record<string, unknown> = {}, timeoutMs = Number(process.env.ASK_QUERY_TIMEOUT_MS) || 5000): Promise<QueryRun> {
  const g = guardCypher(cypher);
  if (!g.ok) return { cypher, ok: false, rows: [], error: g.reason, blocked: true, ms: 0 };
  const started = Date.now();
  const session = db().session({ defaultAccessMode: neo4j.session.READ });
  try {
    const res = await session.executeRead((tx) => tx.run(g.cypher, params), { timeout: timeoutMs });
    // A query over unlabelled nodes could still reach the rate-limit log: drop any row that carries its fields.
    const rows = res.records.map((r) => Object.fromEntries(r.keys.map((k) => [String(k), plain(r.get(k))]))).filter((row) => !JSON.stringify(row).includes('"ipHash"'));
    return { cypher: g.cypher, ok: true, rows, error: null, blocked: false, ms: Date.now() - started };
  } catch (e) {
    const msg = String((e as Error).message ?? e).split("\n")[0];
    return { cypher: g.cypher, ok: false, rows: [], error: msg, blocked: false, ms: Date.now() - started };
  } finally {
    await session.close();
  }
}
