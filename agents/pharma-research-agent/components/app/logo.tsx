/** Wordmark: the app icon (lines of a document under a magnifier) in the brand blue. */
export function Logo({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <svg viewBox="0 0 32 32" className="size-6 shrink-0" aria-hidden="true">
        <rect width="32" height="32" rx="7.5" className="fill-primary" />
        <g className="stroke-primary-foreground" strokeWidth="2.6" strokeLinecap="round" fill="none">
          <path d="M8 9h16M8 14h6.5M8 19h4M22.9 22.5l2.7 2.7" />
          <circle cx="19.6" cy="19.2" r="4.4" />
        </g>
      </svg>
      <span className="text-[15px] font-semibold tracking-tight">Pharma Research</span>
    </span>
  );
}
