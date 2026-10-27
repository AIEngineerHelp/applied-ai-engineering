// The system prompt Gemini gets when it writes Cypher: the schema, how the graph is
// stored, every entity name by type, and the rules. Pure (no I/O), so the page can
// render the same text from results/graph.json that the recorded runs used.

import type { Graph } from "./graph.ts";
import { schemaText } from "./schema.ts";

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
