"use client";
import { Fragment } from "react";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { blocks, splitCitations } from "@/lib/citations";
import type { Report, Source } from "@/lib/research/types";
import { KB } from "./kb";

interface Props {
  report: Report;
  nums: Map<string, number>;
  sources: Map<string, Source>;
  active: string | null;
  onCite: (id: string) => void;
}

function Cite({ ids, nums, sources, active, onCite }: { ids: string[] } & Omit<Props, "report">) {
  return (
    <span className="whitespace-nowrap">
      {ids.map((id) => {
        const n = nums.get(id);
        const s = sources.get(id);
        if (!n) return null;
        return (
          <HoverCard key={id} openDelay={200} closeDelay={80}>
            <HoverCardTrigger asChild>
              <button type="button" className="cite-chip" data-active={active === id} onClick={() => onCite(id)} aria-label={`Source ${n}${s ? `: ${s.title}` : ""}`}>
                {n}
              </button>
            </HoverCardTrigger>
            {s && (
              <HoverCardContent side="top" className="w-80 font-sans">
                <div className="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{KB[s.kind].name}</div>
                <div className="text-[13px] leading-snug font-medium">{s.title}</div>
                <div className="mt-1 text-[12px] text-muted-foreground">{[s.meta.journal, s.meta.year, s.meta.phase, s.meta.status].filter(Boolean).join(" · ")}</div>
              </HoverCardContent>
            )}
          </HoverCard>
        );
      })}
    </span>
  );
}

function Prose({ text, ...rest }: { text: string } & Omit<Props, "report">) {
  const render = (t: string) =>
    splitCitations(t).map((p, i) =>
      p.kind === "text" ? <Fragment key={i}>{p.text.replace(/\*\*(.+?)\*\*/g, "$1")}</Fragment> : <Cite key={i} ids={p.ids} {...rest} />,
    );
  return (
    <>
      {blocks(text).map((b, i) =>
        b.kind === "p" ? (
          <p key={i}>{render(b.items[0])}</p>
        ) : (
          <ul key={i}>
            {b.items.map((item, j) => (
              <li key={j}>{render(item)}</li>
            ))}
          </ul>
        ),
      )}
    </>
  );
}

export function ReportArticle({ report, ...rest }: Props) {
  return (
    <div className="prose-report">
      <div className="mb-8 border-l-2 border-primary pl-5 text-[18.5px] leading-[1.65]">
        <Prose text={report.answer} {...rest} />
      </div>
      {report.sections.map((s, i) => (
        <section key={i} aria-labelledby={`sec-${i}`}>
          <h2 id={`sec-${i}`}>{s.heading}</h2>
          <Prose text={s.body} {...rest} />
        </section>
      ))}
      {report.limitations.length > 0 && (
        <section aria-labelledby="sec-limits">
          <h2 id="sec-limits">Limitations</h2>
          <ul>
            {report.limitations.map((l, i) => (
              <li key={i}>
                <Prose text={l} {...rest} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
