// Types and fetchers for the Python API (voiceagent/api.py).

export type Models = { stt: string; llm: string; tts: string };

export type Call = {
  id: string;
  started_at: number;
  ended_at: number | null;
  source: "browser" | "sip" | "simulation";
  pipeline: string;
  models: Models;
  caller_phone: string | null;
  patient_id: string | null;
  scenario: string | null;
  end_status: string | null;
  transfer_to: string | null;
  cost_usd: number | null;
  usage: { models: Record<string, Record<string, number>>; unpriced: string[]; prices_checked: string } | null;
  summary: PostCall | null;
};

export type PostCall = {
  call_id: string;
  end_status: string;
  intent: string;
  summary: string;
  follow_up_needed: boolean;
  summary_source: string;
  actions: Record<string, unknown>[];
  transfer: { destination: string; label: string; reason: string; mode?: string } | null;
  guard: string | null;
  crm_degraded: boolean;
  duration_seconds: number;
};

export type CallEvent = { seq: number; at: number; kind: string; data: Record<string, any> };
export type CallDetail = Call & { events: CallEvent[] };

export type Percentiles = { p50: number | null; p95: number | null; n: number };
export type Stats = {
  calls: number;
  pipelines: Record<
    string,
    {
      calls: number;
      end_status: Record<string, number>;
      minutes: number;
      cost_usd: number;
      cost_per_minute: number | null;
      latency: Record<string, Percentiles>;
    }
  >;
  latency_parts: { key: string; label: string }[];
  tools: Record<string, { outcomes: Record<string, number>; total: number; p50_ms: number | null }>;
  crm_attempts: Record<string, number>;
  guards: Record<string, number>;
};

export type Config = {
  clinic: { name: string; timezone: string; agent_name: string };
  gemini_key: boolean;
  livekit_url: string;
  livekit_cloud: boolean;
  default_pipeline: "realtime" | "cascade";
  models: { realtime: { llm: string; voice: string }; cascade: Models };
  callers: { phone: string; name: string; patient_id: string | null }[];
  prices: { checked: string; table: Record<string, Record<string, number>> };
};

export type Check = { check: string; passed: boolean; detail: string };
export type ScenarioResult = {
  scenario: string;
  title: string;
  call_id: string;
  passed: boolean;
  checks: Check[];
  seconds: number;
  transcript: { role: string; text: string }[];
};
export type SimulationReport = {
  ran_at: string;
  mode: "scripted" | "live";
  model: string;
  passed: number;
  total: number;
  results: ScenarioResult[];
};
export type Scenario = {
  name: string;
  title: string;
  phone: string | null;
  turns: string[];
  fault: { mode: string; count: number; path_prefix: string } | null;
  expect: Record<string, unknown>;
};

export type Fault = { mode: string; count: number; probability: number; path_prefix: string; latency_ms: number };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail ?? `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  config: () => request<Config>("/api/config"),
  stats: (source?: string) => request<Stats>(`/api/stats${source ? `?source=${source}` : ""}`),
  calls: () => request<{ data: Call[] }>("/api/calls").then((r) => r.data),
  call: (id: string) => request<CallDetail>(`/api/calls/${id}`),
  workflow: () => request<{ workflow: any; knowledge: string[]; yaml: string }>("/api/workflow"),
  simulations: () =>
    request<{ scenarios: Scenario[]; reports: Partial<Record<"scripted" | "live", SimulationReport>> }>(
      "/api/simulations",
    ),
  runSimulation: () => request<SimulationReport>("/api/simulations/run", { method: "POST", body: "{}" }),
  faults: () => request<{ fault: Fault; remaining: number; recent: { path: string; fault: string; method: string; at: string }[] }>("/api/faults"),
  setFault: (fault: Partial<Fault>) => request("/api/faults", { method: "PUT", body: JSON.stringify(fault) }),
  session: (pipeline: string, caller_phone: string | null) =>
    request<{ url: string; token: string; room: string }>("/api/session", {
      method: "POST",
      body: JSON.stringify({ pipeline, caller_phone }),
    }),
  webhooks: () =>
    request<{
      received: { id: number; received_at: number; idempotency_key: string; signature_ok: number; duplicate: number; body: string }[];
      outbox: { call_id: string; attempts: number; status: string; last_error: string | null; updated_at: number }[];
    }>("/api/webhooks"),
};
