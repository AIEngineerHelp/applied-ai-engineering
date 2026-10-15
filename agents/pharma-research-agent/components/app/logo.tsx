/** Wordmark: a simple stacked-document glyph in the brand blue, no gimmicks. */
export function Logo({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <svg viewBox="0 0 24 24" className="size-6 shrink-0" aria-hidden="true">
        <rect x="3" y="2.5" width="18" height="19" rx="3.5" className="fill-primary" />
        <path d="M7.5 8h9M7.5 12h9M7.5 16h5.5" className="stroke-primary-foreground" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
      <span className="text-[15px] font-semibold tracking-tight">Pharma Research</span>
    </span>
  );
}
