"use client";
import { ArrowLeft, FileText } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { KB, KbIcon } from "@/components/report/kb";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useReportStream, type Snapshot } from "@/hooks/use-report-stream";
import type { Span } from "@/lib/research/types";
import { agents, liveUsage, type RunState } from "@/lib/run-state";
import { cn } from "@/lib/utils";

const fmtN = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
const fmtMs = (ms?: number) => (ms === undefined ? "—" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border bg-card px-4 py-3">
      <div className="text-[12px] text-muted-foreground">{label}</div>
      <div className="tabular mt-1 text-[20px] font-semibold tracking-tight">{value}</div>
      {hint && <div className="mt-0.5 text-[11.5px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

function Overview({ s }: { s: RunState }) {
  const r = s.report;
  const live = liveUsage(s);
  const done = r.status === "completed" || r.status === "failed";
  const cost = done ? r.costUsd : live.cost;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Duration" value={fmtMs(r.durationMs ?? s.doneMs)} />
        <Stat label="Model calls" value={String(done ? r.modelCalls : live.calls)} hint={`${done ? r.toolCalls : live.tools} tool calls`} />
        <Stat label="Tokens" value={fmtN(done ? r.tokensIn + r.tokensOut : live.input + live.output)} hint={`${fmtN(done ? r.tokensIn : live.input)} in · ${fmtN(done ? r.tokensOut : live.output)} out`} />
        <Stat label="Model cost" value={cost === null || cost === undefined ? "Not priced" : `$${cost.toFixed(4)}`} hint={r.model} />
      </div>
      {s.plan && (
        <section className="rounded-lg border bg-card p-4">
          <h3 className="text-[13px] font-semibold">Plan</h3>
          <p className="mt-1 text-[13.5px] text-muted-foreground">{s.plan.focus}</p>
          <ol className="mt-3 space-y-2">
            {s.plan.subtasks.map((t) => (
              <li key={t.id} className="flex gap-3 text-[13.5px]">
                <KbIcon kind={t.source} className="mt-0.5" />
                <div>
                  <div>{t.question}</div>
                  <div className="mt-0.5 text-[12px] text-muted-foreground">
                    {KB[t.source].name}
                    {t.skills.length ? ` · skills: ${t.skills.join(", ")}` : ""}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}
      {s.skills.length > 0 && (
        <section className="rounded-lg border bg-card p-4">
          <h3 className="text-[13px] font-semibold">Skills</h3>
          <p className="mt-1 text-[12.5px] text-muted-foreground">The planner sees only one line per skill; a skill&apos;s full playbook is loaded into a sub-agent only when assigned.</p>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {s.skills.map((k) => (
              <li key={k.name} className={cn("rounded-md border px-3 py-2", s.loaded.includes(k.name) && "border-ring/40 bg-accent/50")}>
                <div className="flex items-center gap-2 font-mono text-[12px]">
                  {k.name}
                  {s.loaded.includes(k.name) && <Badge variant="secondary">loaded</Badge>}
                </div>
                <div className="mt-0.5 text-[12px] text-muted-foreground">{k.description}</div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Agents({ s }: { s: RunState }) {
  return (
    <div className="space-y-3">
      {agents(s).map(({ task, status, sources, steps }) => {
        const f = s.findings.get(task.id);
        return (
          <section key={task.id} className="rounded-lg border bg-card p-4">
            <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
              <KbIcon kind={task.source} /> {KB[task.source].name} · {task.id} · <span className="capitalize">{status}</span> · {sources} sources
            </div>
            <p className="mt-1.5 text-[14px] font-medium">{task.question}</p>
            {steps.length > 0 && (
              <ol className="mt-3 space-y-1 border-l pl-4">
                {steps.map((x) => (
                  <li key={x.id} className="text-[12.5px]">
                    <span className={cn("font-mono", x.kind === "tool" ? "text-foreground" : "text-muted-foreground")}>{x.kind === "tool" ? `${x.name}(${String(x.attrs.args ?? "").slice(0, 120)})` : x.name}</span>
                    <span className="text-muted-foreground">
                      {" "}
                      · {fmtMs(x.end !== undefined ? x.end - x.start : undefined)}
                      {x.kind === "tool" && x.attrs.results !== undefined ? ` · ${x.attrs.results} results` : ""}
                      {x.kind === "llm" && x.attrs.calls ? ` → ${x.attrs.calls}` : ""}
                    </span>
                  </li>
                ))}
              </ol>
            )}
            {f && (
              <div className="mt-3 rounded-md bg-muted px-3 py-2.5">
                <p className="text-[13px]">{f.summary}</p>
                {f.gaps.length > 0 && <p className="mt-1.5 text-[12px] text-muted-foreground">Gaps: {f.gaps.join("; ")}</p>}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

const BAR: Record<Span["kind"], string> = { run: "bg-muted-foreground/30", agent: "bg-primary/35", llm: "bg-primary", tool: "bg-warning", vfs: "bg-muted-foreground", eval: "bg-success" };

function Trace({ s }: { s: RunState }) {
  const rows = useMemo(() => {
    const all = [...s.spans.values()];
    const out: { span: Span; depth: number }[] = [];
    const visit = (parent: string | undefined, depth: number) => {
      for (const x of all.filter((y) => y.parent === parent).sort((a, b) => a.start - b.start)) {
        out.push({ span: x, depth });
        visit(x.id, depth + 1);
      }
    };
    visit(undefined, 0);
    return out;
  }, [s.spans]);
  const end = Math.max(1, s.doneMs ?? 0, ...rows.map((r) => r.span.end ?? r.span.start));
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="mb-3 flex flex-wrap items-center gap-4 text-[12px] text-muted-foreground">
        {(["agent", "llm", "tool", "eval"] as const).map((k) => (
          <span key={k} className="flex items-center gap-1.5">
            <i className={cn("inline-block h-2 w-3 rounded-sm", BAR[k])} aria-hidden="true" />
            {k === "llm" ? "model call" : k}
          </span>
        ))}
        <span className="tabular ml-auto">{fmtMs(end)}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-[12px]">
          <caption className="sr-only">Timeline of every agent, model call and tool call</caption>
          <tbody>
            {rows.map(({ span, depth }) => (
              <tr key={span.id} className="hover:bg-muted/50">
                <td className="w-[38%] py-1 pr-3">
                  <span className="block truncate font-mono" style={{ paddingLeft: depth * 12 }} title={span.name}>
                    {span.name}
                  </span>
                </td>
                <td className="py-1">
                  <div className="relative h-3 rounded bg-muted">
                    <div
                      className={cn("absolute top-0 h-full rounded", BAR[span.kind], span.status === "error" && "bg-destructive", span.status === "running" && "animate-pulse")}
                      style={{ left: `${(span.start / end) * 100}%`, width: `${Math.max(0.5, (((span.end ?? end) - span.start) / end) * 100)}%` }}
                    />
                  </div>
                </td>
                <td className="tabular w-20 py-1 pl-3 text-right text-muted-foreground">{fmtMs(span.end !== undefined ? span.end - span.start : undefined)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const VERDICT: Record<string, string> = { supported: "bg-success-soft text-success", partial: "bg-warning-soft text-warning", unsupported: "bg-danger-soft text-destructive" };

function Evaluation({ s }: { s: RunState }) {
  if (!s.evals) return <p className="text-[13.5px] text-muted-foreground">Evaluations run after the report is written.</p>;
  const judged = s.evals.find((e) => e.items?.length);
  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2">
        {s.evals.map((e) => {
          const pct = Math.round(e.score * 100);
          return (
            <div key={e.name} className="rounded-lg border bg-card p-4">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[13.5px] font-medium">{e.name}</span>
                <span className="tabular text-[18px] font-semibold">{pct}%</span>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={e.name}>
                <div className={cn("h-full rounded-full", e.score >= 0.85 ? "bg-success" : e.score >= 0.6 ? "bg-warning" : "bg-destructive")} style={{ width: `${pct}%` }} />
              </div>
              <p className="mt-2 text-[12.5px] text-muted-foreground">{e.detail}</p>
              <p className="mt-1 text-[11.5px] text-muted-foreground">{e.method === "judge" ? "Checked by a judge model" : "Deterministic check"}</p>
            </div>
          );
        })}
      </div>
      {judged && (
        <section>
          <h3 className="mb-2 text-[13px] font-semibold">Judge verdicts</h3>
          <ul className="divide-y rounded-lg border bg-card">
            {judged.items!.map((v, i) => (
              <li key={i} className="px-4 py-3">
                <span className={cn("inline-flex h-5 items-center rounded px-1.5 text-[11.5px] font-medium capitalize", VERDICT[v.verdict] ?? "bg-muted")}>{v.verdict}</span>
                <p className="mt-1.5 text-[13.5px]">{v.text.replace(/\s*\[[^\]]+\]/g, "")}</p>
                <p className="mt-1 text-[12.5px] text-muted-foreground">{v.reason}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Files({ s }: { s: RunState }) {
  const [open, setOpen] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");
  const files = [...s.files.values()].sort((a, b) => a.path.localeCompare(b.path, "en", { numeric: true }));
  async function show(path: string) {
    setOpen(path);
    setContent("Loading…");
    const res = await fetch(`/api/reports/${s.report.id}/files?path=${encodeURIComponent(path)}`);
    setContent(res.ok ? (await res.json()).content : "Couldn't load this file.");
  }
  return (
    <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
      <ul className="max-h-[560px] overflow-y-auto rounded-lg border bg-card p-1.5">
        {files.map((f) => (
          <li key={f.path}>
            <button type="button" onClick={() => show(f.path)} className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left font-mono text-[12px] hover:bg-muted", open === f.path && "bg-accent")}>
              <FileText className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{f.path}</span>
              <span className="tabular text-muted-foreground">{fmtN(f.bytes)}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="min-h-[200px] rounded-lg border bg-card">
        {open ? (
          <>
            <div className="border-b px-4 py-2 font-mono text-[12px] text-muted-foreground">{open}</div>
            <pre className="max-h-[520px] overflow-auto px-4 py-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap">{content}</pre>
          </>
        ) : (
          <p className="p-4 text-[13px] text-muted-foreground">The agents&apos; shared file system: the plan, every source they read, each sub-agent&apos;s findings and the report. Select a file to read it.</p>
        )}
      </div>
    </div>
  );
}

export function RunDetails({ initial }: { initial: Snapshot }) {
  const { state } = useReportStream(initial);
  return (
    <div className="mx-auto w-full max-w-[1240px] px-4 pt-6 pb-24 sm:px-6 lg:px-10 lg:pt-10">
      <Link href={`/r/${state.report.threadId}#turn-${state.report.id}`} className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Back to conversation
      </Link>
      <h1 className="mt-3 text-[22px] font-semibold tracking-tight">Run details</h1>
      <p className="mt-1 max-w-[80ch] text-[13.5px] text-muted-foreground">{state.report.query}</p>
      <Tabs defaultValue="overview" className="mt-6">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="agents">Agents</TabsTrigger>
          <TabsTrigger value="trace">Trace</TabsTrigger>
          <TabsTrigger value="evaluation">Evaluation</TabsTrigger>
          <TabsTrigger value="files">Files</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="mt-5"><Overview s={state} /></TabsContent>
        <TabsContent value="agents" className="mt-5"><Agents s={state} /></TabsContent>
        <TabsContent value="trace" className="mt-5"><Trace s={state} /></TabsContent>
        <TabsContent value="evaluation" className="mt-5"><Evaluation s={state} /></TabsContent>
        <TabsContent value="files" className="mt-5"><Files s={state} /></TabsContent>
      </Tabs>
    </div>
  );
}
