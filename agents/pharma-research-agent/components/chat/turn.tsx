"use client";
import { AlertTriangle, Check, Copy, Download, FileText, ListTree, PenLine, RotateCw, ShieldAlert, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ReportArticle } from "@/components/report/report-article";
import { SourcesPanel } from "@/components/report/sources-panel";
import { Verification } from "@/components/report/verification";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useReportStream, type Snapshot } from "@/hooks/use-report-stream";
import { blocks, numbered, numbering, referenceLine } from "@/lib/citations";
import { parseReport } from "@/agent/report-format";
import { isTerminal, phase, screenNotice, thoughtTitles, type RunState } from "@/lib/run-state";
import { ActivityTrail } from "./activity-trail";
import { Feedback } from "./feedback";
import { SourceStrip } from "./source-strip";

function asMarkdown(state: RunState): string {
  const r = state.result!;
  const nums = numbering(r);
  const out = [`# ${r.title}`, "", ...blocks(r.answer).map((b) => numbered(b.items.join("\n"), nums)), ""];
  for (const s of r.sections) out.push(`## ${s.heading}`, "", numbered(s.body, nums), "");
  if (r.limitations.length) out.push("## Limitations", "", ...r.limitations.map((l) => `- ${numbered(l, nums)}`), "");
  out.push("## References", "");
  for (const [id, n] of nums) {
    const s = state.sources.get(id);
    out.push(`${n}. ${s ? `${referenceLine(s)}. ${s.url}` : id}`);
  }
  return out.join("\n");
}

/** A heading in Title Case from the model's thought summary, as a sentence: "Weighing trial evidence". */
const sentence = (t: string) => t.charAt(0) + t.slice(1).replace(/\b([A-Z])([a-z]+)\b/g, (_, a: string, b: string) => a.toLowerCase() + b);

/**
 * Holds the answer's place while the writer thinks: what it is doing now, and
 * a sheen shaped like the answer to come (a title, then paragraphs).
 */
function Composing({ thought }: { thought?: string }) {
  const now = thought ? sentence(thought) : "Reading the findings";
  return (
    <div role="status" aria-live="polite" className="rounded-xl border bg-card px-5 pt-4 pb-5">
      <div className="flex items-center gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
          <PenLine className="size-4 animate-[write_1.4s_ease-in-out_infinite]" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <p className="text-[14px] font-medium">Writing the answer</p>
          <p key={now} className="truncate text-[13px] text-muted-foreground animate-in fade-in-0 slide-in-from-bottom-1 duration-300">
            {now}…
          </p>
        </div>
      </div>
      <div className="mt-5 space-y-2.5" aria-hidden="true">
        <div className="shimmer h-5 w-[46%] rounded-md" />
        <div className="h-1" />
        {[96, 91, 94, 58].map((w, i) => (
          <div key={i} className="shimmer h-3.5 rounded" style={{ width: `${w}%` }} />
        ))}
        <div className="h-2" />
        {[93, 72].map((w, i) => (
          <div key={i} className="shimmer h-3.5 rounded" style={{ width: `${w}%` }} />
        ))}
      </div>
    </div>
  );
}

/**
 * The input guard's notice: why a question was not researched, or why the
 * answer covers the general evidence instead of the reader's own situation.
 */
function ScreenNotice({ outcome, detail }: { outcome: "block" | "redirect"; detail: string }) {
  const redirect = outcome === "redirect";
  const Icon = redirect ? ShieldCheck : ShieldAlert;
  return (
    <div role={redirect ? "note" : "status"} className={redirect ? "flex gap-3 rounded-xl border border-primary/20 bg-primary/5 px-4 py-3.5" : "flex gap-3 rounded-xl border border-warning/30 bg-warning-soft px-4 py-3.5"}>
      <Icon className={redirect ? "mt-0.5 size-5 shrink-0 text-primary" : "mt-0.5 size-5 shrink-0 text-warning"} aria-hidden="true" />
      <div className="min-w-0">
        <p className="text-[14px] font-medium">{redirect ? "General evidence, not personal advice" : "This question wasn't researched"}</p>
        <p className="mt-1 text-[13.5px] leading-relaxed text-muted-foreground">{detail}</p>
      </div>
    </div>
  );
}

export function Turn({ initial, share, onRetry, onStatus }: { initial: Snapshot; share?: string; onRetry?: (query: string) => void; onStatus?: (id: string, status: string) => void }) {
  const { state, connected } = useReportStream(initial, share);
  const r = state.report;
  const running = !isTerminal(r.status);
  const failed = r.status === "failed" || r.status === "cancelled";
  // While streaming, the draft is parsed with the same parser the server uses.
  const shown = state.result ?? (state.draft ? parseReport(state.draft, r.query) : undefined);
  const nums = useMemo(() => (shown ? numbering(shown) : new Map<string, number>()), [shown]);
  const [sheet, setSheet] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const qs = share ? `&share=${share}` : "";

  useEffect(() => {
    onStatus?.(r.id, r.status);
  }, [r.id, r.status, onStatus]);

  const openSources = (id?: string) => {
    setActive(id ?? null);
    setSheet(true);
  };
  const sources = [...state.sources.values()];
  const notice = screenNotice(state);

  return (
    <article className="scroll-mt-20" id={`turn-${r.id}`} aria-labelledby={`q-${r.id}`}>
      <div className="flex justify-end">
        <h2 id={`q-${r.id}`} className="max-w-[85%] rounded-2xl rounded-br-md bg-secondary px-4 py-2.5 text-[15px] leading-relaxed font-normal text-secondary-foreground">
          {r.query}
        </h2>
      </div>

      <div className="mt-5 space-y-5">
        <ActivityTrail state={state} />
        {!connected && running && <p className="text-[12.5px] text-warning">Reconnecting… the research continues on the server.</p>}

        {failed && (
          <div role="alert" className="flex gap-3 rounded-xl border border-destructive/30 bg-danger-soft p-4">
            <AlertTriangle className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="text-[14px] font-medium">This research didn&apos;t finish.</p>
              <p className="mt-1 text-[13px] text-muted-foreground">{state.error ?? r.error ?? "An unexpected error stopped the run."}</p>
            </div>
            {onRetry && (
              <Button size="sm" variant="outline" onClick={() => onRetry(r.query)}>
                <RotateCw className="size-4" /> Try again
              </Button>
            )}
          </div>
        )}

        {sources.length > 0 && <SourceStrip sources={sources} nums={nums} onOpen={openSources} />}

        {notice && <ScreenNotice outcome={notice.outcome as "block" | "redirect"} detail={notice.detail} />}

        {!shown && running && phase(state) === "writing" && <Composing thought={thoughtTitles(state.thoughts.get("synthesis")?.text ?? "").at(-1)} />}

        {shown && (
          <div className={running && !state.result ? "streaming" : undefined} aria-busy={running && !state.result}>
            <h3 className="mb-4 text-[19px] leading-snug font-semibold tracking-tight">{shown.title}</h3>
            <ReportArticle report={shown} nums={nums} sources={state.sources} active={active} onCite={openSources} />
          </div>
        )}

        {state.result && r.status === "completed" && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
            <Verification confidence={state.result.confidence} evals={state.evals} />
            <div className="flex items-center gap-1">
              {!share && <Feedback reportId={r.id} initial={initial.feedback} />}
              {!share && <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    aria-label="Copy as Markdown"
                    onClick={async () => {
                      await navigator.clipboard.writeText(asMarkdown(state));
                      setCopied(true);
                      toast.success("Copied with references");
                      setTimeout(() => setCopied(false), 1500);
                    }}
                  >
                    {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Copy as Markdown</TooltipContent>
              </Tooltip>
              <DropdownMenu>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="size-8" aria-label="Export">
                        <Download className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                  </TooltipTrigger>
                  <TooltipContent>Export</TooltipContent>
                </Tooltip>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem asChild>
                    <a href={`/api/reports/${r.id}/export?format=pdf${qs}`}>
                      <FileText className="size-4" /> PDF document
                    </a>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <a href={`/api/reports/${r.id}/export?format=docx${qs}`}>
                      <FileText className="size-4" /> Word document (.docx)
                    </a>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              {!share && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button asChild variant="ghost" size="icon" className="size-8" aria-label="Run details">
                      <Link href={`/r/${r.threadId}/details?turn=${r.id}`}>
                        <ListTree className="size-4" />
                      </Link>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Run details: plan, trace, evals, cost</TooltipContent>
                </Tooltip>
              )}
              {onRetry && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon" className="size-8" aria-label="Run again" onClick={() => onRetry(r.query)}>
                      <RotateCw className="size-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Run again</TooltipContent>
                </Tooltip>
              )}
            </div>
          </div>
        )}
      </div>

      <Sheet open={sheet} onOpenChange={setSheet}>
        <SheetContent side="right" className="w-full gap-0 overflow-y-auto p-0 sm:max-w-[440px]">
          <SheetHeader className="border-b px-5 py-4">
            <SheetTitle>Sources</SheetTitle>
            <SheetDescription className="line-clamp-1">{r.query}</SheetDescription>
          </SheetHeader>
          <div className="px-5 py-4">
            <SourcesPanel sources={state.sources} nums={nums} active={active} />
          </div>
        </SheetContent>
      </Sheet>
    </article>
  );
}
