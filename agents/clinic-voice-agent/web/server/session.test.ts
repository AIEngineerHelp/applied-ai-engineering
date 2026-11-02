import { describe, expect, it } from "vitest";
import { cleanFault, handleSession, normalizePhone, type SessionDeps } from "./session";

const ENV = { LIVEKIT_URL: "wss://demo.livekit.cloud", LIVEKIT_API_KEY: "APIkey", LIVEKIT_API_SECRET: "a-secret-that-is-long-enough-for-hs256" };

function deps(over: Partial<SessionDeps> = {}): SessionDeps {
  const counts = new Map<string, number>();
  return {
    env: ENV,
    activeCalls: async () => 0,
    count: async (key) => {
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return counts.get(key)!;
    },
    newId: () => "abc123def4",
    ...over,
  };
}

function post(body: unknown, ip = "203.0.113.7"): Request {
  return new Request("https://demo.example/api/session", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

function claims(token: string): Record<string, any> {
  return JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
}

const CALLER = { caller_name: "  Anjali   Desai ", caller_phone: "+91 98765-43210" };

describe("POST /api/session", () => {
  it("returns a token whose room dispatches the agent with the caller", async () => {
    const res = await handleSession(post({ ...CALLER, crm_fault: { mode: "slow", latency_ms: 99_000 } }), deps());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ url: ENV.LIVEKIT_URL, room: "call-abc123def4" });
    const c = claims(body.token);
    expect(c.video).toMatchObject({ roomJoin: true, room: "call-abc123def4", canUpdateOwnMetadata: true });
    const dispatch = c.roomConfig.agents[0];
    expect(dispatch.agentName).toBe("clinic-agent");
    expect(JSON.parse(dispatch.metadata)).toEqual({
      pipeline: "realtime",
      caller_phone: "+919876543210",
      caller_name: "Anjali Desai",
      crm_fault: { mode: "slow", count: 0, probability: 1, path_prefix: "", latency_ms: 5000 },
    });
  });

  it("explains itself when live calls are not configured", async () => {
    const res = await handleSession(post(CALLER), deps({ env: {} }));
    expect(res.status).toBe(503);
  });

  it("rejects a bad phone number or an empty name", async () => {
    expect((await handleSession(post({ caller_name: "A", caller_phone: "12" }), deps())).status).toBe(400);
    expect((await handleSession(post({ caller_name: "  ", caller_phone: "+919876543210" }), deps())).status).toBe(400);
  });

  it("says the line is busy at the concurrency limit", async () => {
    const res = await handleSession(post(CALLER), deps({ activeCalls: async () => 2 }));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
  });

  it("limits each visitor per hour and everyone per day", async () => {
    const d = deps({ env: { ...ENV, CALLS_PER_IP_PER_HOUR: "2", CALLS_PER_DAY: "3" } });
    const statuses = [];
    for (const ip of ["198.51.100.1", "198.51.100.1", "198.51.100.1"]) statuses.push((await handleSession(post(CALLER, ip), d)).status);
    expect(statuses).toEqual([200, 200, 429]);
    // Another visitor still gets one more call; then the day's total is used up.
    expect((await handleSession(post(CALLER, "198.51.100.2"), d)).status).toBe(200);
    expect((await handleSession(post(CALLER, "198.51.100.3"), d)).status).toBe(429);
  });

  it("refuses calls when the limits cannot be checked", async () => {
    const res = await handleSession(post(CALLER), deps({ count: async () => { throw new Error("redis down"); } }));
    expect(res.status).toBe(503);
  });
});

describe("input cleaning", () => {
  it("normalizes phone numbers like the Python API", () => {
    expect(normalizePhone("+91 98765 43210")).toBe("+919876543210");
    expect(normalizePhone("123")).toBeNull();
  });

  it("keeps only known fault modes with bounded numbers", () => {
    expect(cleanFault({ mode: "explode" })).toBeNull();
    expect(cleanFault({ mode: "rate_limit", count: 500 })).toMatchObject({ mode: "rate_limit", count: 10 });
  });
});
