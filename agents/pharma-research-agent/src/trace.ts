// Tracing: every agent, model call, tool call and file write becomes a span
// with a start, an end and attributes (tokens, cost, result counts). Spans are
// streamed to the UI as they open and close, and saved with the run.

import type { RunEvent, Span, Usage } from "./types.ts";

export class Tracer {
  private t0 = Date.now();
  private n = 0;
  readonly spans: Span[] = [];
  readonly usage: Usage = { input: 0, output: 0, thinking: 0, cost: 0 };
  calls = 0;
  toolCalls = 0;
  private priced = true;

  constructor(private emit: (e: RunEvent) => void) {}

  now(): number {
    return Date.now() - this.t0;
  }

  open(kind: Span["kind"], name: string, parent?: string, attrs: Span["attrs"] = {}): Span {
    const span: Span = { id: `s${++this.n}`, parent, kind, name, start: this.now(), status: "running", attrs };
    this.spans.push(span);
    this.emit({ type: "span", span: { ...span } });
    return span;
  }

  close(span: Span, attrs: Span["attrs"] = {}, status: Span["status"] = "ok"): Span {
    span.end = this.now();
    span.status = status;
    Object.assign(span.attrs, attrs);
    this.emit({ type: "span", span: { ...span } });
    return span;
  }

  /** Runs `fn` inside a span; errors close the span as failed and rethrow. */
  async wrap<T>(kind: Span["kind"], name: string, parent: string | undefined, fn: (span: Span) => Promise<T>, attrs: Span["attrs"] = {}): Promise<T> {
    const span = this.open(kind, name, parent, attrs);
    try {
      const out = await fn(span);
      if (span.status === "running") this.close(span);
      return out;
    } catch (err) {
      this.close(span, { error: (err as Error).message.slice(0, 300) }, "error");
      throw err;
    }
  }

  /** Adds one model call's usage; cost stays unknown if any call is unpriced. */
  addUsage(u: Usage) {
    this.calls += 1;
    this.usage.input += u.input;
    this.usage.output += u.output;
    this.usage.thinking += u.thinking;
    if (u.cost === undefined) this.priced = false;
    else this.usage.cost = (this.usage.cost ?? 0) + u.cost;
    this.emitUsage();
  }

  addToolCall() {
    this.toolCalls += 1;
    this.emitUsage();
  }

  private emitUsage() {
    this.emit({ type: "usage", usage: { ...this.usage, cost: this.priced ? this.usage.cost : undefined }, calls: this.calls, toolCalls: this.toolCalls });
  }
}
