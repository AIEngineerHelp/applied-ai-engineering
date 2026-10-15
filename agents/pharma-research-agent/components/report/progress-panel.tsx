"use client";
import { Check, Loader2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { agents, phase, type RunState } from "@/lib/run-state";
import { cn } from "@/lib/utils";
import { KB, KbIcon } from "./kb";

const STAGES = [
  { key: "planning", label: "Plan" },
  { key: "researching", label: "Research" },
  { key: "writing", label: "Write" },
  { key: "verifying", label: "Verify" },
] as const;
const ORDER = ["queued", "planning", "researching", "writing", "verifying", "done"];
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function Elapsed({ since }: { since: string }) {
  // The clock starts in the browser, never during prerender.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const t = setInterval(tick, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, []);
  const s = now === null ? 0 : Math.max(0, Math.floor((now - new Date(since).getTime()) / 1000));
  return (
    <span className="tabular">
      {Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}
    </span>
  );
}

const MESSAGE: Record<string, string> = {
  queued: "Starting the research job…",
  planning: "Planning the research: splitting your question into focused sub-questions.",
  researching: "Searching the sources in parallel.",
  writing: "Writing the report from what was found.",
  verifying: "Checking every citation against the retrieved sources.",
};

export function ProgressPanel({ state, connected }: { state: RunState; connected: boolean }) {
  const p = phase(state);
  const idx = ORDER.indexOf(p);
  const rows = agents(state);
  const done = rows.filter((r) => r.status === "done" || r.status === "failed").length;

  return (
    <section aria-labelledby="progress-heading" className="rounded-xl border bg-card p-5 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="progress-heading" className="text-[15px] font-semibold">
          Researching
        </h2>
        <span className="text-[12.5px] text-muted-foreground">
          <Elapsed since={state.report.createdAt} /> elapsed · usually 1–3 minutes
        </span>
      </div>
      <p className="mt-1 text-[13.5px] text-muted-foreground" aria-live="polite">
        {p === "researching" && rows.length ? `Searching ${rows.length} sources in parallel — ${done} of ${rows.length} finished.` : MESSAGE[p] ?? ""}
      </p>
      {!connected && <p className="mt-2 text-[12.5px] text-warning">Reconnecting… the research continues on the server.</p>}

      <ol className="mt-5 grid grid-cols-4 gap-2" aria-label="Progress">
        {STAGES.map((s) => {
          const i = ORDER.indexOf(s.key);
          const state_ = idx > i ? "done" : idx === i ? "current" : "todo";
          return (
            <li key={s.key} className="min-w-0">
              <div className={cn("h-1 rounded-full bg-muted", state_ === "done" && "bg-primary", state_ === "current" && "overflow-hidden bg-primary/25")}>
                {state_ === "current" && <div className="h-full w-1/3 animate-[progress_1.4s_ease-in-out_infinite] rounded-full bg-primary motion-reduce:animate-none" />}
              </div>
              <div className={cn("mt-2 text-[12px]", state_ === "todo" ? "text-muted-foreground" : "font-medium")} aria-current={state_ === "current" ? "step" : undefined}>
                {s.label}
              </div>
            </li>
          );
        })}
      </ol>

      {rows.length > 0 && (
        <ul className="mt-5 divide-y rounded-lg border">
          {rows.map(({ task, status, sources, claims, steps }) => {
            const last = [...steps].reverse().find((x) => x.kind === "tool");
            return (
              <li key={task.id} className="flex items-start gap-3 px-3.5 py-3">
                <KbIcon kind={task.source} className="mt-0.5" />
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] font-medium text-muted-foreground">{KB[task.source].name}</div>
                  <div className="text-[13.5px] leading-snug">{task.question}</div>
                  {status === "running" && last && (
                    <div className="mt-1 truncate font-mono text-[11.5px] text-muted-foreground">
                      {last.name}
                      {last.status === "running" ? "…" : ` → ${last.attrs.results ?? 0} results`}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2 pt-0.5 text-[12px] text-muted-foreground">
                  {status === "running" && (
                    <>
                      <span className="tabular hidden sm:inline">{plural(sources, "source")}</span>
                      <Loader2 className="size-3.5 animate-spin text-primary" aria-label="Running" />
                    </>
                  )}
                  {status === "done" && (
                    <>
                      <span className="tabular">
                        {plural(sources, "source")} · {plural(claims, "finding")}
                      </span>
                      <Check className="size-3.5 text-success" aria-label="Done" />
                    </>
                  )}
                  {status === "failed" && (
                    <>
                      <span>No results</span>
                      <X className="size-3.5 text-destructive" aria-label="Failed" />
                    </>
                  )}
                  {status === "queued" && <span>Queued</span>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
