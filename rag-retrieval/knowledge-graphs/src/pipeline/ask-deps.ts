// The live dependencies of the "Ask your own question" endpoint: the recorded
// graph's entity names (for the text-to-Cypher prompt), Gemini and Neo4j.
import GRAPH from "../../results/graph.json" with { type: "json" };
import type { AskDeps } from "../ask-endpoint.ts";
import type { Graph } from "../graph.ts";
import { textToCypher } from "./ask.ts";
import { generateText } from "./gemini.ts";
import { neo4jLimitStore } from "./ask-log.ts";

export function liveAskDeps(): AskDeps {
  return {
    graph: () => GRAPH as Graph,
    configured: () => Boolean(process.env.GEMINI_API_KEY && process.env.NEO4J_URI && process.env.NEO4J_USERNAME && process.env.NEO4J_PASSWORD),
    limits: neo4jLimitStore,
    textToCypher: (q, graph) => textToCypher(q, graph, "ask"),
    answer: async (q, context) =>
      (
        await generateText({
          step: "ask-endpoint",
          label: q.slice(0, 60),
          system: "You answer questions about Corvane Instruments using only the query and its result rows given; the query shows what each column means. One to three sentences. If the rows don't answer the question, say so.",
          input: `${context}\n\nQuestion: ${q}`,
        })
      ).text.trim(),
  };
}
