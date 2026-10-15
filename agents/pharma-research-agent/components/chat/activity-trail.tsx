"use client";
// What the agents are doing, as one chronological feed: one short line per
// action, in the order it happened. The searches run in parallel underneath,
// but the reader follows a single story, newest line at the bottom.
import { Brain, Check, ChevronDown, FileSearch, ListChecks, Loader2, PenLine, ShieldAlert, ShieldCheck, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { KB, KbIcon } from "@/components/report/kb";
import type { SourceKind, Span } from "@/agent/types";
import { agents, isTerminal, phase, thoughtSections, type RunState } from "@/lib/run-state";
import { cn } from "@/lib/utils";

interface Line {
  key: string;
  /** ms since the run started, for ordering. */
  at: number;
  icon: React.ReactNode;
  text: React.ReactNode;
  /** A short explanation under the step: what it does, or what the agent is thinking. */
  detail?: string;
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

  // 0. The input guard: was the question screened, refused or redirected?
  const screen = state.guardrails.get("input:screen");
  const pii = state.guardrails.get("input:personal-data");
  if (state.report.status !== "queued") {
    out.push({
      key: "screen",
      at: -1,
      icon: screen?.outcome === "pass" ? <ShieldCheck className="size-3.5" /> : <ShieldAlert className="size-3.5" />,
      text: !screen
        ? "Checking the question"
        : screen.outcome === "block"
          ? "Didn't research this question"
          : screen.outcome === "redirect"
            ? "Turned a personal question into a general evidence question"
            : `Checked the question${pii?.outcome === "redact" ? " and removed personal details" : ""}`,
      detail: !screen
        ? "Looking for personal details, off-topic or harmful requests, and attempts to change the assistant's instructions."
        : screen.outcome === "pass"
          ? [pii?.outcome === "redact" ? pii.detail : "", screen.detail.replace(/^On topic\.\s*/, "") || "It is a question about medicines and clinical evidence, so research can start."].filter(Boolean).join(" ")
          : screen.detail,
      state: screen ? "done" : "running",
    });
  }
  if (screen?.outcome === "block") return out;

  // Retrieved text that looked like instructions to the model, by sub-agent.
  for (const d of state.guardrails.values()) {
    if (d.stage !== "retrieval") continue;
    out.push({ key: `guard-${d.check}`, at: 2.5, icon: <ShieldAlert className="size-3.5" />, text: "Removed text in the results that looked like instructions to an AI", detail: d.detail, state: "done" });
  }

  // 1. Thinking about the question: each thought heading becomes a line.
  // Under each heading, the paragraph the planner wrote: what it is actually weighing.
  const thoughts = thoughtSections(plan?.text ?? "");
  if (!thoughts.length && screen && state.report.status !== "queued") {
    out.push({ key: "think", at: 0, icon: <Brain className="size-3.5" />, text: "Reading the question", detail: "The planner reads the question and a one-line list of research skills before choosing where to search.", state: state.plan ? "done" : "running" });
  }
  thoughts.forEach((t, i) =>
    out.push({ key: `think-${i}`, at: i * 0.001, icon: <Brain className="size-3.5" />, text: t.title, detail: t.body || undefined, state: state.plan || i < thoughts.length - 1 ? "done" : "running" }),
  );

  // 2. The plan, in one line.
  if (state.plan?.mode === "answer") {
    out.push({ key: "plan", at: orchestrator?.end ?? 1, icon: <ListChecks className="size-3.5" />, text: "No new search needed — answering from the earlier research", detail: state.plan.reason ?? "The earlier answers and their sources already cover this follow-up.", state: "done" });
  } else if (state.plan) {
    const kinds = [...new Set(state.plan.subtasks.map((t) => t.source))];
    out.push({
      key: "plan",
      at: orchestrator?.end ?? 1,
      icon: <ListChecks className="size-3.5" />,
      text: `Planned ${state.plan.subtasks.length} searches across ${kinds.map((k) => KB[k].name).join(", ")}`,
      detail: `${state.plan.focus} Each source gets its own research agent, and they run at the same time.`,
      state: "done",
    });
  }

  // 3. Each search, as it starts; the same line updates when results come back.
  const agentOf = new Map(spans.filter((s) => s.kind === "agent").map((s) => [s.id, s]));
  const rows = agents(state);
  const explained = new Set<string>();
  for (const tool of spans.filter((s) => s.kind === "tool").sort((a, b) => a.start - b.start)) {
    const agent = agentOf.get(tool.parent ?? "");
    const row = rows.find((r) => agent?.name.startsWith(`${r.task.id} ·`));
    if (!row) continue;
    const kind = row.task.source;
    const terms = searchTerms(tool);
    const n = Number(tool.attrs.results ?? 0);
    const running = tool.status === "running";
    const what = tool.name === "get_drug_label" ? "the FDA label" : tool.name === "count_adverse_events" ? "FAERS reports" : KB[kind].name;
    // The agent's question goes under its first search only, so it is said once.
    const first = !explained.has(row.task.id);
    explained.add(row.task.id);
    out.push({
      key: tool.id,
      at: tool.start,
      icon: <KbIcon kind={kind} className="size-3.5 text-current" />,
      detail: first ? row.task.question : undefined,
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
      detail: r.task.question,
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
      detail: f.summary || undefined,
    });
  }

  // 5. Writing and checking.
  const synth = spans.find((s) => s.kind === "agent" && s.name === "synthesis");
  // The writing itself is shown in the answer's place; the list keeps one line for the record.
  if (state.draft || state.result) {
    out.push({
      key: "write",
      at: synth?.start ?? 4,
      icon: <PenLine className="size-3.5" />,
      text: state.result ? "Wrote the answer" : "Writing the answer",
      detail: `The writer combines the findings into one answer from the saved research files, citing a retrieved source for every claim.`,
      state: state.result ? "done" : "running",
    });
  }
  const evals = spans.find((s) => s.kind === "eval");
  if (evals || state.evals) {
    const v = state.evals?.find((e) => e.name === "Citation validity");
    out.push({
      key: "verify",
      at: evals?.start ?? 5,
      icon: <ShieldCheck className="size-3.5" />,
      text: v ? `Checked every citation — ${Math.round(v.score * 100)}% trace to a retrieved source` : "Checking citations against the sources",
      detail: state.evals?.find((e) => e.name === "Groundedness")?.detail ?? "A judge model reads each cited sentence next to the passage it cites and decides whether the source supports it.",
      state: state.evals ? "done" : "running",
    });
  }
  // 6. The output guard's safety check on the finished answer.
  const policy = state.guardrails.get("output:policy");
  const outGuard = spans.find((s) => s.kind === "agent" && s.name === "output guard");
  if (outGuard || policy) {
    const removed = ["output:policy", "output:citations"].map((k) => state.guardrails.get(k)).filter((d) => d?.outcome === "remove").length;
    out.push({
      key: "safety",
      at: outGuard?.start ?? 4.5,
      icon: <ShieldCheck className="size-3.5" />,
      text: !policy ? "Checking the answer against the safety rules" : policy.outcome === "flag" ? "The safety check could not run on this answer" : removed ? "Safety check removed content that broke the rules" : "Safety check passed",
      detail: policy?.detail ?? "Removing citations to sources nobody retrieved, personal details, and sentences that give personal advice or overstate the evidence.",
      state: policy ? (policy.outcome === "flag" ? "failed" : "done") : "running",
    });
  }
  return out.sort((a, b) => a.at - b.at);
}

const STAGE: Record<ReturnType<typeof phase>, string> = {
  queued: "Starting…",
  planning: "Planning the research",
  researching: "Researching the sources",
  writing: "Writing the answer",
  verifying: "Checking the answer",
  done: "Done",
  failed: "Stopped",
};

function fmtElapsed(ms: number) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

export function ActivityTrail({ state }: { state: RunState }) {
  const running = !isTerminal(state.report.status);
  const p = phase(state);
  // The list is about research: open while the agents plan and search, folded
  // once writing starts (the answer's place shows the writing from then on).
  const researching = p === "queued" || p === "planning" || p === "researching";
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = open ?? (running && researching);
  const feed = useMemo(() => lines(state), [state]);
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    if (running && list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [feed.length, running]);

  const current = [...feed].reverse().find((l) => l.state === "running");
  const searches = [...state.spans.values()].filter((s) => s.kind === "tool").length;
  const elapsed = state.report.durationMs ?? state.doneMs;
  const reused = state.plan?.mode === "answer";
  const done = `${reused ? "Used the earlier research" : `Researched · ${searches} ${searches === 1 ? "search" : "searches"}`} · ${state.sources.size} sources`;
  // Spinning only while this card is where the work is: research, then checking.
  const busy = running && (researching || p === "verifying");
  const blocked = state.guardrails.get("input:screen")?.outcome === "block";
  const summary = !running
    ? blocked
      ? "Checked the question · not researched"
      : reused
      ? `Answered from the earlier research${elapsed ? ` in ${fmtElapsed(elapsed)}` : ""} · ${state.sources.size} sources`
      : `Researched${elapsed ? ` for ${fmtElapsed(elapsed)}` : ""} · ${searches} ${searches === 1 ? "search" : "searches"} · ${state.sources.size} sources`
    : p === "verifying"
      ? "Checking every citation against its source"
      : !researching
        ? done
        : expanded
          ? STAGE[p] // the open list already shows the live step
          : (current?.text ?? STAGE[p]);

  return (
    <section aria-label="Research activity" className="rounded-xl border bg-card">
      <button
        type="button"
        onClick={() => setOpen(!expanded)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2.5 rounded-xl px-4 py-3 text-left text-[13.5px] transition-colors hover:bg-muted/50"
      >
        {busy ? <Loader2 className="size-4 shrink-0 animate-spin text-primary" aria-hidden="true" /> : <Check className="size-4 shrink-0 text-success" aria-hidden="true" />}
        <span className={cn("min-w-0 flex-1 truncate", busy && "font-medium")} aria-live="polite">
          {summary}
        </span>
        <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform duration-200", expanded && "rotate-180")} aria-hidden="true" />
      </button>

      {expanded && (
        <ol ref={list} className="max-h-[28rem] space-y-1 overflow-y-auto border-t px-4 py-3" aria-label="Steps">
          {feed.map((l) => (
            <li key={l.key} className="flex items-start gap-2.5 py-1 text-[13.5px] leading-snug animate-in fade-in-0 slide-in-from-bottom-1 duration-200">
              <span className={cn("mt-px grid size-5 shrink-0 place-items-center rounded-md", l.state === "running" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground")}>
                {l.state === "running" ? <Loader2 className="size-3 animate-spin" aria-label="In progress" /> : l.icon}
              </span>
              <span className="min-w-0 flex-1">
                <span className={cn("block", l.state === "running" ? "text-foreground" : "text-foreground/80", l.state === "failed" && "text-destructive")}>{l.text}</span>
                {l.detail && <span className="mt-0.5 block line-clamp-2 text-[12.5px] leading-snug text-muted-foreground">{l.detail}</span>}
              </span>
              {l.state === "failed" && <X className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-label="Failed" />}
            </li>
          ))}
          {!feed.length && <li className="py-1 text-[13.5px] text-muted-foreground">Starting…</li>}
        </ol>
      )}
    </section>
  );
}
