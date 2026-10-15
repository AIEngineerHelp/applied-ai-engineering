"use client";
// Keeps a report's state live: applies events from the server-sent stream,
// reconnects with the last sequence number if the connection drops, and
// reloads the final snapshot when the run finishes.
import { useEffect, useRef, useState } from "react";
import type { SerializedReport } from "@/lib/reports";
import type { Source } from "@/agent/types";
import { apply, cloneState, initialState, isTerminal, type RunState } from "@/lib/run-state";

export interface Snapshot {
  report: SerializedReport;
  sources: Source[];
  events: unknown[];
  lastSeq: number;
}

export function useReportStream(initial: Snapshot, share?: string) {
  const [state, setState] = useState<RunState>(() => initialState(initial.report, initial.sources, initial.events as never[]));
  const [connected, setConnected] = useState(true);
  const seq = useRef(initial.lastSeq);
  const id = initial.report.id;
  const terminal = isTerminal(state.report.status);

  useEffect(() => {
    if (terminal) return;
    let es: EventSource | null = null;
    let retry = 0;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;

    const reload = async () => {
      const res = await fetch(`/api/reports/${id}${share ? `?share=${share}` : ""}`, { cache: "no-store" });
      if (!res.ok) return;
      const snap = (await res.json()) as Snapshot;
      seq.current = snap.lastSeq;
      setState(initialState(snap.report, snap.sources, snap.events as never[]));
    };

    const connect = () => {
      const qs = new URLSearchParams({ after: String(seq.current) });
      if (share) qs.set("share", share);
      es = new EventSource(`/api/reports/${id}/events?${qs}`);
      es.onopen = () => {
        retry = 0;
        setConnected(true);
      };
      es.onmessage = (m) => {
        const msg = JSON.parse(m.data) as { seq?: number; event?: unknown; status?: SerializedReport["status"] };
        if (msg.event && msg.seq) {
          seq.current = msg.seq;
          setState((prev) => {
            const next = cloneState(prev);
            apply(next, msg.event as never);
            if (msg.status) next.report = { ...next.report, status: msg.status };
            return next;
          });
        } else if (msg.status) {
          setState((prev) => (prev.report.status === msg.status ? prev : { ...prev, report: { ...prev.report, status: msg.status! } }));
          if (isTerminal(msg.status)) {
            stopped = true;
            es?.close();
            void reload();
          }
        }
      };
      es.onerror = () => {
        es?.close();
        if (stopped) return;
        setConnected(false);
        // Back off and resume from the last event we saw.
        timer = setTimeout(connect, Math.min(10_000, 800 * 2 ** retry++));
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      es?.close();
    };
  }, [id, share, terminal]);

  return { state, connected };
}
