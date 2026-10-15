// What every node works with: a tracer, a virtual file system and an event
// writer for its run, all saving through the RunStore.

import type { EventWriter, RunStore } from "../store.ts";
import { throttle } from "../throttle.ts";
import { Tracer } from "../trace.ts";
import { VirtualFS } from "../vfs.ts";

export async function nodeContext(store: RunStore, runId: string, prefix: string) {
  const run = await store.get(runId);
  const sink = store.events(runId);
  // Span ids are prefixed per node, so a node that is run again reuses its ids and overwrites its own spans.
  const tracer = new Tracer((e) => sink.emit(e), { t0: run.startedAt.getTime(), prefix });
  const vfs = new VirtualFS((f) => sink.emit({ type: "file", path: f.path, bytes: f.content.length, by: f.by, content: f.content }));
  const done = async () => {
    await sink.flush();
    await store.addUsage(runId, { ...tracer.usage, calls: tracer.calls, toolCalls: tracer.toolCalls, priced: tracer.priced });
  };
  return { run, sink, tracer, vfs, done };
}

/** Streams thought summaries for many concurrent model calls, a few writes a second each. */
export function thoughtStream(sink: EventWriter, agent: string) {
  const streams = new Map<string, ReturnType<typeof throttle<{ text: string; done: boolean }>>>();
  return (key: string, text: string, done: boolean) => {
    let t = streams.get(key);
    if (!t) {
      t = throttle((v) => sink.emit({ type: "thought", key, agent, text: v.text, done: v.done }));
      streams.set(key, t);
    }
    t.push({ text, done });
    if (done) t.flush();
  };
}

/** The earlier turns, condensed for planning and writing a follow-up. Citations are stripped: a researched turn cites its own sources. */
export function conversationContext(turns: { query: string; report?: { answer: string; sections: { heading: string }[] } }[]): string | undefined {
  if (!turns.length) return undefined;
  const strip = (t: string) => t.replace(/\s*\[[^\]]+\]/g, "");
  return [
    "Earlier in this conversation:",
    ...turns.map((p, i) => `Q${i + 1}: ${p.query}\nA${i + 1}: ${strip(p.report?.answer ?? "").slice(0, 900)}${p.report?.sections.length ? `\n(Sections: ${p.report.sections.map((x) => x.heading).join("; ")})` : ""}`),
  ].join("\n");
}
