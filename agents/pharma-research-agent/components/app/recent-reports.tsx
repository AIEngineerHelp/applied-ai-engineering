"use client";
import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { useReports } from "@/components/app/reports-provider";
import { StatusDot } from "@/components/app/status-dot";
import { Skeleton } from "@/components/ui/skeleton";

export function RecentReports() {
  const { reports } = useReports();
  if (reports === null)
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-14 w-full" />
        ))}
      </div>
    );
  if (!reports.length) return null;
  return (
    <section aria-labelledby="recent-heading">
      <h2 id="recent-heading" className="mb-3 text-[13px] font-semibold">
        Recent reports
      </h2>
      <ul className="divide-y overflow-hidden rounded-xl border bg-card">
        {reports.slice(0, 5).map((r) => (
          <li key={r.id}>
            <Link href={`/r/${r.id}`} className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/60">
              <StatusDot status={r.status} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-medium">{r.title ?? r.query}</span>
                <span className="block text-[12px] text-muted-foreground">
                  {new Date(r.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
                  {r.confidence ? ` · ${r.confidence} confidence` : ""}
                </span>
              </span>
              <ChevronRight className="size-4 text-muted-foreground transition-transform duration-150 group-hover:translate-x-0.5" aria-hidden="true" />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
