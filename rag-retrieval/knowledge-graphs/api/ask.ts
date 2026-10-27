// The Vercel function for "Ask your own question" (Node.js runtime, Web handler).
// `npm run export` bundles this file and everything it imports (including
// results/graph.json, for the entity names in the prompt) into dist/api/ask.js,
// so the deployment needs no node_modules and none of the Git-ignored files.
// Configuration comes from the environment: GEMINI_API_KEY, NEO4J_URI,
// NEO4J_USERNAME, NEO4J_PASSWORD, RATE_LIMIT_SALT, ASK_LIMIT_IP_PER_HOUR and
// ASK_LIMIT_PER_DAY (see README, "Deploy"). Without them it answers 503 and the
// page keeps replaying the recorded runs.
import { handleAsk } from "../src/ask-endpoint.ts";
import { liveAskDeps } from "../src/pipeline/ask-deps.ts";

export const config = { runtime: "nodejs", maxDuration: 30 };

export async function POST(request: Request): Promise<Response> {
  return handleAsk(request, liveAskDeps());
}
