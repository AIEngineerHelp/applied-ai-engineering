import { performance } from "node:perf_hooks";
import { ACTIONS, KINDS, type Action, type Kind } from "./game.js";
import { CRITERIA, INSTRUCTION, obstacleState } from "./players.js";

export const JEV_URL = "https://api.typesafe.ai/v1/systemone";

export function configuration(env: Record<string, string | undefined> = process.env) {
  const rate = (key: string) =>
    env[key]?.trim() && Number.isFinite(Number(env[key])) && Number(env[key]) >= 0
      ? Number(env[key])
      : null;
  const timeout = Number(env.TYPESAFE_TIMEOUT_MS);
  return {
    live: env.ENABLE_LIVE === "true" && !!env.TYPESAFE_API_KEY,
    model: env.TYPESAFE_MODEL || "jev-latest",
    key: env.TYPESAFE_API_KEY,
    // A game decision is useless after a few seconds, so fail fast.
    timeoutMs: Number.isInteger(timeout) && timeout >= 500 && timeout <= 30000 ? timeout : 5000,
    host: env.HOST || "127.0.0.1",
    allowedHosts: new Set(
      (env.ALLOWED_HOSTS || "127.0.0.1,localhost")
        .split(",")
        .map((host) => host.trim().toLowerCase())
        .filter(Boolean),
    ),
    rates: [rate("TYPESAFE_INPUT_USD_PER_MILLION"), rate("TYPESAFE_OUTPUT_USD_PER_MILLION")],
  };
}
export type Config = ReturnType<typeof configuration>;

/** One Choice question per obstacle; see docs.typesafe.ai/primitives/choice. */
export function jevRequest(kind: Kind, model: string) {
  return {
    model,
    state: obstacleState(kind),
    questions: {
      action: { type: "choice", instructions: INSTRUCTION, criteria: CRITERIA },
    },
  };
}

export interface JevDecision {
  action: Action;
  confidence: number;
  probabilities: Record<string, number> | null;
  ms: number;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedUsd: number | null;
}

export function createJevPlayer({
  config = configuration(),
  fetchFn = fetch,
}: { config?: Config; fetchFn?: typeof fetch } = {}) {
  return async function decide(kind: Kind, signal?: AbortSignal): Promise<JevDecision> {
    if (!KINDS.includes(kind)) throw new Error("Unknown obstacle kind.");
    const started = performance.now();
    let data;
    try {
      // No automatic retries: a retried decision would arrive too late to matter.
      const response = await fetchFn(JEV_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.key}`,
        },
        body: JSON.stringify(jevRequest(kind, config.model)),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)])
          : AbortSignal.timeout(config.timeoutMs),
      });
      // Do not surface raw upstream error bodies: they may echo request data.
      if (!response.ok)
        throw new Error(
          response.status === 429 || response.status === 529
            ? `Jev is rate limited or overloaded (HTTP ${response.status}).`
            : `Jev request failed (HTTP ${response.status}). Check the API key, model, and quota.`,
        );
      data = await response.json();
    } catch (error) {
      if (error.name === "TimeoutError") throw new Error("Jev request timed out.");
      if (error.name === "AbortError") throw new Error("Jev request was cancelled.");
      throw error;
    }
    const answer = data?.answers?.action;
    if (
      !answer ||
      !ACTIONS.includes(answer.choice) ||
      !Number.isFinite(answer.confidence) ||
      answer.confidence < 0 ||
      answer.confidence > 1
    )
      throw new Error("Jev returned an invalid answer.");
    const inputTokens = data.usage?.input_tokens ?? null;
    const outputTokens = data.usage?.output_tokens ?? null;
    const [inputRate, outputRate] = config.rates;
    return {
      action: answer.choice,
      confidence: answer.confidence,
      probabilities: answer.probabilities ?? null,
      ms: Math.round(performance.now() - started),
      model: data.model ?? config.model,
      inputTokens,
      outputTokens,
      estimatedUsd:
        Number.isFinite(inputTokens) && Number.isFinite(outputTokens) && inputRate !== null && outputRate !== null
          ? (inputTokens * inputRate + outputTokens * outputRate) / 1e6
          : null,
    };
  };
}
export type DecideFn = ReturnType<typeof createJevPlayer>;
