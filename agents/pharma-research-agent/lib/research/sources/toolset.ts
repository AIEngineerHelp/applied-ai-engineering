// A knowledge base, as a sub-agent sees it: a few tools the model can call,
// and the code that runs them. Every result is normalised into Sources so it
// can be cited, saved to the virtual file system and checked by the evals.

import type { ToolDecl } from "../llm.ts";
import type { Source, SourceKind } from "../types.ts";

export interface ToolOutput {
  /** What goes back to the model: short and structured. */
  forModel: unknown;
  /** Full documents, saved to the file system and the source registry. */
  sources: Source[];
}

export interface Toolset {
  kind: SourceKind;
  tools: ToolDecl[];
  call(name: string, args: Record<string, unknown>): Promise<ToolOutput>;
}

/** Fetch with a timeout and bounded retries on 429 and 5xx. */
export async function getJson(url: string, opts: { timeoutMs?: number; retries?: number; text?: boolean } = {}): Promise<unknown> {
  const { timeoutMs = 15_000, retries = 2 } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "user-agent": "pharma-research-agent/0.1 (aiengineer.help example)", accept: opts.text ? "text/plain, application/xml" : "application/json" },
      });
      if (res.status === 404) return opts.text ? "" : null;
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}: ${(await res.text()).slice(0, 200)}`);
      return opts.text ? await res.text() : await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
    }
  }
  throw lastErr;
}

/** Spaces requests to one host, e.g. NCBI's three per second without a key. */
export function limiter(perSecond: number) {
  let next = 0;
  return async () => {
    const now = Date.now();
    const at = Math.max(now, next);
    next = at + 1000 / perSecond;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  };
}

export const clip = (s: string | undefined, n: number) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
