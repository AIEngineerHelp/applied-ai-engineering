"use client";
import { ChevronDown, ExternalLink } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { Source, SourceKind } from "@/agent/types";
import { cn } from "@/lib/utils";
import { KB, KbIcon } from "./kb";

function meta(s: Source): string {
  const m = s.meta;
  if (s.kind === "pubmed") return [m.journal, m.year, m.type && m.type !== "Journal Article" ? m.type : null].filter(Boolean).join(" · ");
  if (s.kind === "trials") return [s.id, m.phase, String(m.status ?? "").toLowerCase().replace(/_/g, " "), m.enrollment ? `n = ${Number(m.enrollment).toLocaleString("en-US")}` : null, m.results ? "results posted" : null].filter(Boolean).join(" · ");
  if (s.kind === "fda") return m.effective ? `Label effective ${m.effective}` : "FDA Adverse Event Reporting System";
  return String(m.host ?? "");
}

function SourceCard({ s, n, active }: { s: Source; n?: number; active: boolean }) {
  const ref = useRef<HTMLLIElement>(null);
  const [open, setOpen] = useState(false);
  // Opening the excerpt follows from becoming active: derived during render, not in an effect.
  const [wasActive, setWasActive] = useState(active);
  if (active !== wasActive) {
    setWasActive(active);
    if (active) setOpen(true);
  }
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [active]);
  return (
    <li ref={ref} id={`source-${s.id}`} className={cn("rounded-lg border bg-card px-3.5 py-3 transition-[border-color,box-shadow] duration-200", active && "border-ring shadow-[0_0_0_3px] shadow-ring/15")}>
      <div className="flex items-start gap-2.5">
        {n ? (
          <span className="cite-chip mt-0.5 shrink-0 translate-y-0" aria-hidden="true">
            {n}
          </span>
        ) : (
          <KbIcon kind={s.kind} className="mt-0.5" />
        )}
        <div className="min-w-0 flex-1">
          <a href={s.url} target="_blank" rel="noopener noreferrer" className="group text-[13.5px] leading-snug font-medium hover:text-primary hover:underline">
            {s.title}
            <ExternalLink className="ml-1 inline size-3 -translate-y-px text-muted-foreground group-hover:text-primary" aria-label="(opens in a new tab)" />
          </a>
          <div className="mt-1 flex items-center gap-1.5 text-[12px] text-muted-foreground">
            {n ? <KbIcon kind={s.kind} className="size-3.5" /> : null}
            <span className="min-w-0 truncate">{meta(s)}</span>
          </div>
          {s.text && (
            <Collapsible open={open} onOpenChange={setOpen}>
              <CollapsibleTrigger className="mt-1.5 inline-flex items-center gap-1 text-[12px] font-medium text-primary hover:underline">
                {open ? "Hide excerpt" : "Show excerpt"}
                <ChevronDown className={cn("size-3 transition-transform duration-150", open && "rotate-180")} aria-hidden="true" />
              </CollapsibleTrigger>
              <CollapsibleContent>
                <p className="mt-2 max-h-56 overflow-y-auto rounded-md bg-muted px-3 py-2 text-[12.5px] leading-relaxed whitespace-pre-line text-foreground/85">{s.text}</p>
              </CollapsibleContent>
            </Collapsible>
          )}
        </div>
      </div>
    </li>
  );
}

export function SourcesPanel({ sources, nums, active }: { sources: Map<string, Source>; nums: Map<string, number>; active: string | null }) {
  const [filter, setFilter] = useState<SourceKind | "all">("all");
  const all = useMemo(() => [...sources.values()], [sources]);
  const counts = useMemo(() => {
    const c = new Map<SourceKind, number>();
    for (const s of all) c.set(s.kind, (c.get(s.kind) ?? 0) + 1);
    return c;
  }, [all]);
  const shown = all.filter((s) => filter === "all" || s.kind === filter);
  const cited = shown.filter((s) => nums.has(s.id)).sort((a, b) => nums.get(a.id)! - nums.get(b.id)!);
  const other = shown.filter((s) => !nums.has(s.id));
  const [showOther, setShowOther] = useState(nums.size === 0);

  return (
    <section aria-labelledby="sources-heading">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 id="sources-heading" className="text-[14px] font-semibold">
          Sources
        </h2>
        <span className="tabular text-[12px] text-muted-foreground">
          {nums.size ? `${nums.size} cited · ` : ""}
          {all.length} retrieved
        </span>
      </div>
      {counts.size > 1 && (
        <div className="mb-3 flex flex-wrap gap-1.5" role="group" aria-label="Filter sources">
          {(["all", ...counts.keys()] as const).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={filter === k}
              onClick={() => setFilter(k)}
              className={cn(
                "h-7 rounded-md border px-2.5 text-[12px] transition-colors",
                filter === k ? "border-primary bg-primary text-primary-foreground" : "bg-card text-foreground/80 hover:border-ring/50",
              )}
            >
              {k === "all" ? "All" : KB[k].short} <span className="tabular opacity-70">{k === "all" ? all.length : counts.get(k)}</span>
            </button>
          ))}
        </div>
      )}
      {all.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-6 text-center text-[13px] text-muted-foreground">Sources appear here as the agents find them.</p>
      ) : (
        <>
          <ul className="space-y-2">
            {cited.map((s) => (
              <SourceCard key={s.id} s={s} n={nums.get(s.id)} active={active === s.id} />
            ))}
          </ul>
          {other.length > 0 && (
            <div className="mt-4">
              {nums.size > 0 && (
                <button type="button" onClick={() => setShowOther((v) => !v)} className="mb-2 inline-flex items-center gap-1 text-[12.5px] font-medium text-muted-foreground hover:text-foreground" aria-expanded={showOther}>
                  <ChevronDown className={cn("size-3.5 transition-transform", showOther && "rotate-180")} aria-hidden="true" />
                  Also retrieved, not cited ({other.length})
                </button>
              )}
              {showOther && (
                <ul className="space-y-2">
                  {other.map((s) => (
                    <SourceCard key={s.id} s={s} active={active === s.id} />
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
