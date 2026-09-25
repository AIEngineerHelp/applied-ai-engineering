import type { Report } from '@/lib/types';
import { EmptyState } from '../ui/Card';
import { CopyButton } from '../ui/CopyButton';
import { Markdown } from '../ui/Markdown';
import { Skeleton } from '../ui/Skeleton';

const FAILED_PREFIX = 'Automated report generation failed';

export function ReportPanel({ report, active }: { report: Report | null; active: boolean }) {
  if (!report) {
    return active ? (
      <div className="space-y-3" aria-busy="true">
        <p className="text-[13px] text-fg-muted">The report is written once the investigation completes.</p>
        <Skeleton className="h-5 w-1/3" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-5/6" />
      </div>
    ) : (
      <EmptyState title="This run did not produce a report." className="px-0 text-left" />
    );
  }

  const failed = report.summary?.startsWith(FAILED_PREFIX);
  const links = Object.entries(report.links ?? {}).filter(([, href]) => /^https?:\/\//i.test(href));

  return (
    <div className="space-y-4">
      {report.summary && (
        <div className="flex gap-2.5">
          {failed && <span aria-hidden className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-warning" />}
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-fg-muted">Summary</p>
            <p className="mt-1 max-w-3xl text-[14px] leading-relaxed whitespace-pre-line text-fg">{report.summary}</p>
          </div>
        </div>
      )}

      {report.markdown?.trim() && (
        <div className="rounded-md border border-border">
          <div className="flex items-center justify-between border-b border-border px-4 py-1.5 sm:px-5">
            <span className="text-[13px] font-medium text-fg-muted">Postmortem</span>
            <CopyButton value={report.markdown} label="Copy report as Markdown" />
          </div>
          <article className="px-4 py-5 sm:px-6">
            <Markdown source={report.markdown} className="max-w-[80ch]" />
          </article>
        </div>
      )}

      {links.length > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
          {links.map(([label, href]) => (
            <a
              key={label}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded text-link hover:underline"
            >
              {label}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
