"use client";
import type { Source } from "@/agent/types";
import { KB, KbIcon } from "@/components/report/kb";

/** The first few sources as compact cards above the answer, like a search result strip. */
export function SourceStrip({ sources, nums, onOpen }: { sources: Source[]; nums: Map<string, number>; onOpen: (id?: string) => void }) {
  if (!sources.length) return null;
  const ordered = [...sources].sort((a, b) => (nums.get(a.id) ?? 999) - (nums.get(b.id) ?? 999));
  const shown = ordered.slice(0, 4);
  const more = ordered.length - shown.length;
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-5" role="list" aria-label="Sources">
      {shown.map((s) => (
        <button
          key={s.id}
          type="button"
          role="listitem"
          onClick={() => onOpen(s.id)}
          className="group flex h-[84px] flex-col justify-between rounded-lg border bg-card px-3 py-2.5 text-left transition-colors hover:border-ring/50 hover:bg-accent/40"
        >
          <span className="line-clamp-2 text-[12.5px] leading-snug font-medium">{s.title}</span>
          <span className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
            <KbIcon kind={s.kind} className="size-3" />
            <span className="truncate">{KB[s.kind].short}{s.meta.year ? ` · ${s.meta.year}` : ""}</span>
            {nums.get(s.id) && <span className="ml-auto cite-chip translate-y-0">{nums.get(s.id)}</span>}
          </span>
        </button>
      ))}
      {more > 0 && (
        <button type="button" onClick={() => onOpen()} className="flex h-[84px] flex-col justify-center rounded-lg border border-dashed bg-card px-3 text-left text-[12.5px] text-muted-foreground transition-colors hover:border-ring/50 hover:text-foreground">
          <span className="font-medium text-foreground">+{more} more</span>
          <span>View all sources</span>
        </button>
      )}
    </div>
  );
}
