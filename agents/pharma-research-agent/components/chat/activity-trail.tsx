"use client";
// What the agents are doing, as one chronological feed: one short line per
// action, in the order it happened. The searches run in parallel underneath,
// but the reader follows a single story, newest line at the bottom.
import { Brain, Check, ChevronDown, FileSearch, ListChecks, Loader2, PenLine, ShieldCheck, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { KB, KbIcon } from "@/components/report/kb";
import type { SourceKind, Span } from "@/lib/research/types";
import { agents, isTerminal, phase, thoughtTitles, type RunState } from "@/lib/run-state";
import { cn } from "@/lib/utils";

interface Line {
  key: string;
  /** ms since the run started, for ordering. */
  at: number;
  icon: React.ReactNode;
  text: React.ReactNode;
  state: "running" | "done" | "failed";
}

const NOUN: Record<SourceKind, [string, string]> = {
  pubmed: ["study", "studies"],
  trials: ["trial", "trials"],
  fda: ["label record", "label records"],
  web: ["page", "pages"],
};
const count = (n: number, [one, many]: [string, string]) => `${n} ${n === 1 ? one : many}`;

/** The search a tool call ran, in plain words: the query, trial terms or drug name. */
function searchTerms(span: Span): string {
  try {
    const a = JSON.parse(String(span.attrs.args ?? "{}")) as Record<string, unknown>;
    const q = a.query ?? [a.intervention, a.condition].filter(Boolean).join(" · ") ?? "";
    return String(q || a.generic_name || "").replace(/\s+/g, " ").trim();
  } catch {
    return "";
  }
}

function lines(state: RunState): Line[] {
  const out: Line[] = [];
  const spans = [...state.spans.values()];
  const orchestrator = spans.find((s) => s.kind === "agent" && s.name === "orchestrator");
  const plan = state.thoughts.get("plan");

  // 1. Thinking about the question: each thought heading becomes a line.
  const titles = thoughtTitles(plan?.text ?? "");
  if (!titles.length && state.report.status !== "queued") {
    out.push({ key: "think", at: 0, icon: <Brain className="size-3.5" />, text: "Reading the question", state: state.plan ? "done" : "running" });
  }
  titles.forEach((t, i) =>
    out.push({ key: `think-${i}`, at: i * 0.001, icon: <Brain className="size-3.5" />, text: t, state: state.plan || i < titles.length - 1 ? "done" : "running" }),
  );

  // 2. The plan, in one line.
  if (state.plan) {
    const kinds = [...new Set(state.plan.subtasks.map((t) => t.source))];
    out.push({
      key: "plan",
      at: orchestrator?.end ?? 1,
      icon: <ListChecks className="size-3.5" />,
      text: `Planned ${state.plan.subtasks.length} searches across ${kinds.map((k) => KB[k].name).join(", ")}`,
      state: "done",
    });
  }

  // 3. Each search, as it starts; the same line updates when results come back.
  const agentOf = new Map(spans.filter((s) => s.kind === "agent").map((s) => [s.id, s]));
  const rows = agents(state);
  for (const tool of spans.filter((s) => s.kind === "tool").sort((a, b) => a.start - b.start)) {
    const agent = agentOf.get(tool.parent ?? "");
    const row = rows.find((r) => agent?.name.startsWith(`${r.task.id} ·`));
    if (!row) continue;
    const kind = row.task.source;
    const terms = searchTerms(tool);
    const n = Number(tool.attrs.results ?? 0);
    const running = tool.status === "running";
    const what = tool.name === "get_drug_label" ? "the FDA label" : tool.name === "count_adverse_events" ? "FAERS reports" : KB[kind].name;
    out.push({
      key: tool.id,
      at: tool.start,
      icon: <KbIcon kind={kind} className="size-3.5 text-current" />,
      state: tool.status === "error" ? "failed" : running ? "running" : "done",
      text: (
        <>
          {running ? "Searching" : "Searched"} {what}
          {terms && tool.name !== "get_drug_label" && tool.name !== "count_adverse_events" ? <span className="text-muted-foreground"> for “{terms.length > 70 ? `${terms.slice(0, 69)}…` : terms}”</span> : terms ? <span className="text-muted-foreground"> for {terms}</span> : null}
          {!running && <span className="text-muted-foreground"> — {n ? count(n, NOUN[kind]) : "nothing found"}</span>}
        </>
      ),
    });
  }
  // Web search has no tool calls: one line for the grounded search.
  for (const r of rows.filter((x) => x.task.source === "web" && x.status !== "queued")) {
    const span = spans.find((s) => s.kind === "agent" && s.name.startsWith(`${r.task.id} ·`));
    out.push({
      key: `${r.task.id}-web`,
      at: span?.start ?? 2,
      icon: <KbIcon kind="web" className="size-3.5 text-current" />,
      state: r.status === "running" ? "running" : r.status === "failed" ? "failed" : "done",
      text: (
        <>
          {r.status === "running" ? "Searching the web" : "Searched the web"}
          {r.status !== "running" && <span className="text-muted-foreground"> — {count(r.sources, NOUN.web)}</span>}
        </>
      ),
    });
  }

  // 4. Each source's findings, when its sub-agent finishes.
  for (const r of rows) {
    const f = state.findings.get(r.task.id);
    if (!f) continue;
    const span = spans.find((s) => s.kind === "agent" && s.name.startsWith(`${r.task.id} ·`));
    out.push({
      key: `${r.task.id}-done`,
      at: span?.end ?? 3,
      icon: <FileSearch className="size-3.5" />,
      state: r.status === "failed" ? "failed" : "done",
      text: r.status === "failed" ? `No usable results from ${KB[r.task.source].name}` : `Read ${count(r.sources, ["source", "sources"])} from ${KB[r.task.source].name} — ${count(r.claims, ["finding", "findings"])}`,
    });
  }

  // 5. Writing and checking.
  const synth = spans.find((s) => s.kind === "agent" && s.name === "synthesis");
  if (synth || state.draft || state.result) {
    out.push({ key: "write", at: synth?.start ?? 4, icon: <PenLine className="size-3.5" />, text: state.result ? "Wrote the report" : "Writing the report", state: state.result ? "done" : "running" });
  }
  const evals = spans.find((s) => s.kind === "eval");
  if (evals || state.evals) {
    const v = state.evals?.find((e) => e.name === "Citation validity");
    out.push({
      key: "verify",
      at: evals?.start ?? 5,
      icon: <ShieldCheck className="size-3.5" />,
      text: v ? `Checked every citation — ${Math.round(v.score * 100)}% trace to a retrieved source` : "Checking citations against the sources",
      state: state.evals ? "done" : "running",
    });
  }
  return out.sort((a, b) => a.at - b.at);
}

function fmtElapsed(ms: number) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

export function ActivityTrail({ state }: { state: RunState }) {
  const running = !isTerminal(state.report.status);
  const writing = !!state.draft || !!state.result;
  const [open, setOpen] = useState<boolean | null>(null);
  // Open while the agents work; folds into a summary once the answer starts streaming.
  const expanded = open ?? (running && !writing);
  const feed = useMemo(() => lines(state), [state]);
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    if (running && list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [feed.length, running]);

  const current = [...feed].reverse().find((l) => l.state === "running");
  const searches = [...state.spans.values()].filter((s) => s.kind === "tool").length;
  const elapsed = state.report.durationMs ?? state.doneMs;
  const p = phase(state);
  const summary = running
    ? (current?.text ?? (p === "queued" ? "Starting…" : "Working…"))
    : `Researched${elapsed ? ` for ${fmtElapsed(elapsed)}` : ""} · ${searches} ${searches === 1 ? "search" : "searches"} · ${state.sources.size} sources`;

  return (
    <section aria-label="Research activity" className="rounded-xl border bg-card">
      <button
        type="button"
        onClick={() => setOpen(!expanded)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2.5 rounded-xl px-4 py-3 text-left text-[13.5px] transition-colors hover:bg-muted/50"
      >
        {running ? <Loader2 className="size-4 shrink-0 animate-spin text-primary" aria-hidden="true" /> : <Check className="size-4 shrink-0 text-success" aria-hidden="true" />}
        <span className={cn("min-w-0 flex-1 truncate", running && "font-medium")} aria-live="polite">
          {summary}
        </span>
        <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform duration-200", expanded && "rotate-180")} aria-hidden="true" />
      </button>

      {expanded && (
        <ol ref={list} className="max-h-80 space-y-0.5 overflow-y-auto border-t px-4 py-3" aria-label="Steps">
          {feed.map((l) => (
            <li key={l.key} className="flex items-start gap-2.5 py-1 text-[13.5px] leading-snug animate-in fade-in-0 slide-in-from-bottom-1 duration-200">
              <span className={cn("mt-px grid size-5 shrink-0 place-items-center rounded-md", l.state === "running" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground")}>
                {l.state === "running" ? <Loader2 className="size-3 animate-spin" aria-label="In progress" /> : l.icon}
              </span>
              <span className={cn("min-w-0 flex-1", l.state === "running" ? "text-foreground" : "text-foreground/80", l.state === "failed" && "text-destructive")}>{l.text}</span>
              {l.state === "failed" && <X className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-label="Failed" />}
            </li>
          ))}
          {!feed.length && <li className="py-1 text-[13.5px] text-muted-foreground">Starting…</li>}
        </ol>
      )}
    </section>
  );
}
