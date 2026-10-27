// A Vercel function (Node.js runtime, Web handler) for "Ask your own question".
// Not deployed. Before deploying: set GEMINI_API_KEY and the NEO4J_* variables
// (AuraDB), use a database user with read-only rights where the plan allows it,
// and replace the in-memory rate limit with a shared store.
import { handleAsk } from "../src/ask-endpoint.ts";
import { liveAskDeps } from "../src/pipeline/ask-deps.ts";

export const config = { runtime: "nodejs", maxDuration: 30 };

export async function POST(request: Request): Promise<Response> {
  return handleAsk(request, liveAskDeps());
}
