// POST /api/session on the hosted demo: checks the limits, then returns a LiveKit token
// whose room dispatches the clinic agent (hosted on LiveKit Cloud) with the caller's name,
// number and chosen CRM fault. Locally, voiceagent/api.py serves the same route.
//
// Every visitor's call spends the deployer's Gemini key, so the limits come first:
//   - at most MAX_CONCURRENT_CALLS calls at once, counted from LiveKit's live rooms
//   - CALLS_PER_IP_PER_HOUR per visitor and CALLS_PER_DAY in total, counted in Redis
//     (Upstash over REST) when it is configured; without Redis only the first applies
// The agent itself ends every hosted call after MAX_CALL_SECONDS (see the README).

import { AccessToken, RoomAgentDispatch, RoomConfiguration } from "livekit-server-sdk";

export type Env = Record<string, string | undefined>;

export type Counter = (key: string, windowSeconds: number) => Promise<number>;

export type SessionDeps = {
  env: Env;
  activeCalls: () => Promise<number>;
  count: Counter | null; // null when no Redis is configured
  newId: () => string;
};

const FAULT_MODES = new Set(["none", "slow", "error_500", "rate_limit", "timeout", "bad_data", "down", "lost_response"]);

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

function number(env: Env, key: string, fallback: number): number {
  const n = Number(env[key]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** The same rules as voiceagent/api.py: 7 to 15 digits, stored with a leading "+". */
export function normalizePhone(raw: unknown): string | null {
  const digits = String(raw ?? "").replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15 ? `+${digits}` : null;
}

/** Only known fault modes and small numbers get through to the agent. */
export function cleanFault(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const f = raw as Record<string, unknown>;
  if (typeof f.mode !== "string" || !FAULT_MODES.has(f.mode)) return null;
  const clamp = (v: unknown, max: number) => Math.min(Math.max(Number(v) || 0, 0), max);
  return {
    mode: f.mode,
    count: clamp(f.count, 10),
    probability: f.probability === undefined ? 1 : clamp(f.probability, 1),
    path_prefix: typeof f.path_prefix === "string" ? f.path_prefix.slice(0, 40) : "",
    latency_ms: clamp(f.latency_ms ?? 2500, 5000),
  };
}

async function visitorKey(request: Request, salt: string): Promise<string> {
  const ip = (request.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}:${ip}`));
  return [...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function handleSession(request: Request, deps: SessionDeps): Promise<Response> {
  const { env } = deps;
  if (request.method !== "POST") return json(405, { detail: "Use POST." });
  if (!env.LIVEKIT_URL || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) {
    return json(503, { detail: "Live calls are not configured on this deployment. Run it locally to call the agent." });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json(400, { detail: "Send JSON." });
  }
  const phone = normalizePhone(body.caller_phone);
  if (!phone) return json(400, { detail: "Enter a phone number with 7 to 15 digits, including the country code." });
  const name = body.caller_name === undefined ? null : String(body.caller_name).split(/\s+/).filter(Boolean).join(" ").slice(0, 60);
  if (name === "") return json(400, { detail: "Enter a name and a phone number." });

  // Limits, cheapest first. If a limit cannot be checked, refuse: an open line spends money.
  try {
    if ((await deps.activeCalls()) >= number(env, "MAX_CONCURRENT_CALLS", 2)) {
      return json(429, { detail: "Meera is on other calls right now. Try again in a minute." }, { "retry-after": "60" });
    }
    if (deps.count) {
      const visitor = await visitorKey(request, env.RATE_LIMIT_SALT ?? "clinic-voice-agent");
      const hour = Math.floor(Date.now() / 3_600_000);
      const day = new Date().toISOString().slice(0, 10);
      if ((await deps.count(`clinic:ip:${visitor}:${hour}`, 3600)) > number(env, "CALLS_PER_IP_PER_HOUR", 3)) {
        return json(429, { detail: "That's the limit of demo calls for this hour. Please try again later." }, { "retry-after": "3600" });
      }
      if ((await deps.count(`clinic:day:${day}`, 86_400)) > number(env, "CALLS_PER_DAY", 40)) {
        return json(429, { detail: "Today's demo calls are used up. Please try again tomorrow, or run it locally." });
      }
    }
  } catch {
    return json(503, { detail: "The call limits could not be checked, so calls are paused. Please try again shortly." });
  }

  const room = `call-${deps.newId()}`;
  const metadata = JSON.stringify({
    pipeline: "realtime",
    caller_phone: phone,
    ...(name ? { caller_name: name } : {}),
    ...(cleanFault(body.crm_fault) ? { crm_fault: cleanFault(body.crm_fault) } : {}),
  });
  const token = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
    identity: `caller-${deps.newId().slice(0, 6)}`,
    name: "Browser caller",
    ttl: "10m",
  });
  token.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true, canPublishData: true, canUpdateOwnMetadata: true });
  token.roomConfig = new RoomConfiguration({
    agents: [new RoomAgentDispatch({ agentName: env.AGENT_NAME ?? "clinic-agent", metadata })],
  });
  return json(200, { url: env.LIVEKIT_URL, token: await token.toJwt(), room });
}

/** Counts in Upstash Redis over REST: INCR, and start the window on the first hit. */
export function upstashCounter(url: string, token: string): Counter {
  return async (key, windowSeconds) => {
    const res = await fetch(`${url.replace(/\/$/, "")}/pipeline`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify([["INCR", key], ["EXPIRE", key, String(windowSeconds), "NX"]]),
    });
    if (!res.ok) throw new Error(`Redis answered ${res.status}`);
    const [incr] = (await res.json()) as { result: number }[];
    return incr.result;
  };
}
