// The Vercel function for POST /api/session (Node.js runtime, Web handler). `python -m
// voiceagent export-site` bundles this file and livekit-server-sdk into site/api/session.js,
// so the deployment needs no node_modules. Configuration comes from the Vercel project's
// environment: LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, and optionally the Upstash
// variables and limits listed in the README ("Deploy").
import { RoomServiceClient } from "livekit-server-sdk";
import { handleSession, upstashCounter } from "./session";

declare const process: { env: Record<string, string | undefined> };

export const config = { runtime: "nodejs", maxDuration: 10 };

export async function POST(request: Request): Promise<Response> {
  const env = process.env;
  const host = env.LIVEKIT_URL?.replace(/^ws/, "http");
  const rooms = host && env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET
    ? new RoomServiceClient(host, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET)
    : null;
  const redisUrl = env.KV_REST_API_URL ?? env.UPSTASH_REDIS_REST_URL;
  const redisToken = env.KV_REST_API_TOKEN ?? env.UPSTASH_REDIS_REST_TOKEN;
  return handleSession(request, {
    env,
    // A call room with someone still in it is a call in progress.
    activeCalls: async () =>
      rooms ? (await rooms.listRooms()).filter((r) => r.name.startsWith("call-") && r.numParticipants > 0).length : 0,
    count: redisUrl && redisToken ? upstashCounter(redisUrl, redisToken) : null,
    newId: () => crypto.randomUUID().replace(/-/g, "").slice(0, 10),
  });
}
