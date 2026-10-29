import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { compress, defaults, isModelMethod, splitUnits, validate, type Options, type Result } from "./compress.ts";
import { hostedResult, rawFallback, scoredUnits, semanticScoring } from "./model-results.ts";
import { countTokens } from "./tokens.ts";

export interface BackendConfig { enableLocal: boolean; python: string; apiKey?: string }
export interface BackendRequest { source: string; options: Options; allowPaid: boolean; failOpen: boolean }
export type LocalRunner = (payload: object, python: string) => Promise<Record<string, unknown>>;
const worker = fileURLToPath(new URL("../models/worker.py", import.meta.url));
export const configFromEnv = (): BackendConfig => ({
  enableLocal: process.env.ENABLE_LOCAL_MODELS === "1",
  python: process.env.COMPRESSION_PYTHON ?? fileURLToPath(new URL("../models/.venv/bin/python", import.meta.url)),
  apiKey: process.env.COMPRESR_API_KEY,
});
export const capabilities = (config: BackendConfig) => ({
  localModelsEnabled: config.enableLocal, compresrConfigured: Boolean(config.apiKey),
  note: "Local model execution is disabled unless ENABLE_LOCAL_MODELS=1 is explicitly set. Models are never downloaded by the app.",
});

export const runLocal: LocalRunner = (payload, python) => new Promise((resolve, reject) => {
  // No shell, no user-supplied executable, offline model loading only.
  const child = spawn(python, [worker], { env: { ...process.env, ENABLE_LOCAL_MODELS: "1", HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", TOKENIZERS_PARALLELISM: "false" }, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  let settled = false;
  const finish = (error?: Error) => {
    if (settled) return; settled = true; clearTimeout(timeout);
    if (error) { child.kill("SIGKILL"); reject(error); }
    else { try { resolve(JSON.parse(output)); } catch { reject(new Error("Local worker returned invalid JSON.")); } }
  };
  const timeout = setTimeout(() => finish(new Error("Local model timed out after 90 seconds.")), 90_000);
  child.on("error", () => finish(new Error("Local Python environment is unavailable. Follow models/README.md after authorizing local inference.")));
  child.stdout.on("data", (data) => { output += data; if (output.length > 2_000_000) finish(new Error("Model response exceeded the size limit.")); });
  // Do not expose source text or arbitrary library diagnostics in API errors.
  child.stderr.resume();
  child.stdin.on("error", () => {});
  child.on("close", (code) => finish(code === 0 ? undefined : new Error("Local model failed. Check that dependencies and model files are installed; downloads are disabled.")));
  child.stdin.end(JSON.stringify(payload));
});

export function parseRequest(raw: unknown): BackendRequest {
  if (!raw || typeof raw !== "object") throw new Error("Expected a JSON object.");
  const value = raw as Record<string, unknown>;
  if (typeof value.source !== "string" || value.source.length > 12000) throw new Error("Source must be text of at most 12,000 characters.");
  if (!value.options || typeof value.options !== "object") throw new Error("Options are required.");
  const options = { ...defaults, ...value.options } as Options;
  for (const key of ["queryAware", "dynamic", "useFocus"] as const) if (typeof options[key] !== "boolean") throw new Error(`Invalid ${key} setting.`);
  validate(options);
  if (!isModelMethod(options.method)) throw new Error("Use the browser for offline methods.");
  return { source: value.source, options, allowPaid: value.allowPaid === true, failOpen: value.failOpen === true };
}

export async function runBackend(request: BackendRequest, config: BackendConfig, dependencies: { local?: LocalRunner; fetch?: typeof fetch } = {}): Promise<Result> {
  const { source, options, allowPaid, failOpen } = request;
  validate(options);
  const method = options.method;
  // Configuration and consent failures are never disguised as successful fallbacks.
  if (method === "compresr") {
    if (!config.apiKey) throw new Error("COMPRESR_API_KEY is not configured on the server.");
    if (!allowPaid) throw new Error("Explicit paid-call consent is required for Compresr.");
    if (!options.query.trim()) throw new Error("Compresr requires a non-empty question.");
    if (!options.queryAware) throw new Error("Compresr requires query-aware mode.");
  } else {
    if (!["semantic", "llmlingua2"].includes(method)) throw new Error("Unknown model method.");
    if (!config.enableLocal) throw new Error("Local model execution is disabled. Do not enable it until the laptop owner authorizes inference.");
    if (method === "semantic" && (!options.queryAware || !options.query.trim())) throw new Error("Semantic selection requires a question and query-aware mode.");
    if (method === "llmlingua2" && (options.dynamic || options.queryAware)) throw new Error("LLMLingua-2 uses fixed, task-agnostic word selection in this lab.");
  }
  const started = performance.now();
  if (!source || countTokens(source) < options.threshold || options.remove === 0 && !options.dynamic) {
    const result = compress(source, { ...options, method: "relevance" });
    return { ...result, backend: { method, model: "pass-through", durationMs: 0, fallback: false } };
  }
  try {
    if (method === "compresr") {
      const body: Record<string, unknown> = { context: source, query: options.query + (options.useFocus && options.focus ? `\nFocus of this read: ${options.focus}` : ""),
        compression_model_name: "latte_v2.1", coarse: options.granularity === "paragraph", disable_placeholders: true };
      if (options.dynamic) Object.assign(body, { dynamic: true, dynamic_min_ratio: options.minFactor, dynamic_max_ratio: options.maxFactor });
      else body.target_compression_ratio = options.remove / 100;
      const response = await (dependencies.fetch ?? fetch)("https://api.compresr.ai/api/compress/question-specific/", {
        method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": config.apiKey! }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000), redirect: "error",
      });
      if (!response.ok) throw new Error(`Compresr failed with HTTP ${response.status}.`);
      const data = await response.json() as { data?: { compressed_context?: unknown } };
      if (typeof data.data?.compressed_context !== "string" || data.data.compressed_context.length > 24000) throw new Error("Invalid Compresr response.");
      const result = hostedResult(source, data.data.compressed_context, options, "latte_v2.1", performance.now() - started);
      if (options.dynamic) { result.budget = Math.floor(result.originalTokens / options.minFactor); result.reason += ` Dynamic API mode: ${options.minFactor}×–${options.maxFactor}×; displayed budget is the upper bound, not the model's chosen target.`; }
      return result;
    }
    const units = splitUnits(source, options.granularity);
    if (method === "semantic" && units.length > 256) throw new Error("Semantic mode supports at most 256 units. Use paragraph units or shorter text.");
    const payload = { method, source, query: options.query + (options.useFocus && options.focus ? `\n${options.focus}` : ""), units: units.map((u) => u.headings.map((h) => source.slice(h.start, h.end)).join("") + u.text) };
    const output = await (dependencies.local ?? runLocal)(payload, config.python);
    if (typeof output.model !== "string") throw new Error("Missing local model identity.");
    const scoring = method === "semantic"
      ? semanticScoring(source, units, output.scores, output.model)
      : { units: scoredUnits(source, output.units), separator: "", description: `Published LLMLingua-2 checkpoint ${output.model}; token keep probabilities averaged per whitespace word, then our strict budget packer. Not the full reference library pipeline. Question and focus are ignored.` };
    if (typeof output.warning === "string") scoring.description += ` ${output.warning}`;
    const result = compress(source, options, scoring);
    return { ...result, backend: { method, model: output.model, durationMs: performance.now() - started, fallback: false } };
  } catch (error) {
    if (failOpen) return rawFallback(source, options, method, performance.now() - started);
    throw error;
  }
}
