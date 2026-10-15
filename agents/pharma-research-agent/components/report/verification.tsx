"use client";
import { CircleCheck, CircleAlert, Info } from "lucide-react";
import Link from "next/link";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { EvalResult } from "@/agent/types";
import { cn } from "@/lib/utils";

const CONFIDENCE: Record<string, { label: string; tip: string; cls: string }> = {
  high: { label: "High confidence", tip: "Consistent results from meta-analyses or several large randomised trials.", cls: "bg-success-soft text-success" },
  moderate: { label: "Moderate confidence", tip: "Some randomised evidence, or consistent observational evidence.", cls: "bg-warning-soft text-warning" },
  low: { label: "Low confidence", tip: "Small studies, case reports, report counts only, or conflicting results.", cls: "bg-danger-soft text-destructive" },
};

function Check({ label, value, tip, ok }: { label: string; value: string; tip: string; ok: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="inline-flex items-center gap-1.5 rounded-md text-[12.5px] text-muted-foreground outline-offset-2">
          {ok ? <CircleCheck className="size-3.5 text-success" aria-hidden="true" /> : <CircleAlert className="size-3.5 text-warning" aria-hidden="true" />}
          <span>
            {label} <span className="tabular font-medium text-foreground">{value}</span>
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">{tip}</TooltipContent>
    </Tooltip>
  );
}

/** How well the report checks out, in plain words, with the details one click away. */
export function Verification({ confidence, evals, detailsHref }: { confidence?: string | null; evals?: EvalResult[]; detailsHref?: string }) {
  const c = confidence ? CONFIDENCE[confidence] : undefined;
  const validity = evals?.find((e) => e.name === "Citation validity");
  const grounded = evals?.find((e) => e.name === "Groundedness");
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      {c && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0} className={cn("inline-flex h-6 items-center gap-1 rounded-md px-2 text-[12px] font-medium", c.cls)}>
              {c.label}
              <Info className="size-3" aria-hidden="true" />
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-72">{c.tip} Graded by the agent from the evidence it found.</TooltipContent>
        </Tooltip>
      )}
      {validity && (
        <Check label="Citations verified" value={`${Math.round(validity.score * 100)}%`} ok={validity.score >= 0.99} tip="Share of citations that point to a source the agents actually retrieved. Anything below 100% means a citation could not be traced." />
      )}
      {grounded && grounded.detail && !grounded.detail.startsWith("Not judged") && (
        <Check label="Claims supported" value={`${Math.round(grounded.score * 100)}%`} ok={grounded.score >= 0.8} tip="A second model checked a sample of cited sentences against the text of their sources. Partly supported claims count as half." />
      )}
      {detailsHref && (
        <Link href={detailsHref} className="text-[12.5px] font-medium text-primary hover:underline">
          How this was researched
        </Link>
      )}
    </div>
  );
}
