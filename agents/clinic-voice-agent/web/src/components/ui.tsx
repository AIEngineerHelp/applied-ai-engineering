import type { ReactNode } from "react";

export function Card({ title, aside, children, className = "" }: { title?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-rule bg-card ${className}`}>
      {title && (
        <header className="flex items-baseline justify-between gap-4 border-b border-rule px-5 py-3.5">
          <h2 className="text-[13px] font-medium tracking-wide text-ink-2 uppercase">{title}</h2>
          {aside && <div className="text-[13px] text-ink-3">{aside}</div>}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

export function Stat({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[12px] tracking-wide text-ink-3 uppercase">{label}</div>
      <div className="mt-1 font-serif text-[30px] leading-tight text-ink tabular-nums">{value}</div>
      {note && <div className="mt-0.5 text-[13px] text-ink-3">{note}</div>}
    </div>
  );
}

const TONES = {
  neutral: "bg-paper text-ink-2 border-rule-2",
  good: "bg-accent-soft text-accent border-transparent",
  warn: "bg-warn-soft text-warn border-transparent",
  bad: "bg-bad-soft text-bad border-transparent",
} as const;

export type Tone = keyof typeof TONES;

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[12px] font-medium whitespace-nowrap ${TONES[tone]}`}>
      {children}
    </span>
  );
}

export function statusTone(status: string | null): Tone {
  if (status === "resolved") return "good";
  if (status === "transferred") return "neutral";
  if (status === "error" || status === "timed_out") return "bad";
  return "warn";
}

export function outcomeTone(outcome: string): Tone {
  if (outcome === "ok") return "good";
  if (outcome === "refused" || outcome === "retryable") return "warn";
  return "bad";
}

export function PageHeader({ title, lede, aside }: { title: string; lede: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="max-w-2xl">
        <h1 className="font-serif text-[34px] leading-tight text-ink">{title}</h1>
        <p className="mt-2 text-[15px] leading-relaxed text-ink-2">{lede}</p>
      </div>
      {aside}
    </div>
  );
}

export function Button({
  children,
  onClick,
  variant = "primary",
  disabled,
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "quiet" | "danger";
  disabled?: boolean;
  type?: "button" | "submit";
}) {
  const styles = {
    primary: "bg-ink text-paper hover:bg-ink-2",
    quiet: "border border-rule-2 bg-card text-ink hover:bg-paper",
    danger: "bg-bad text-white hover:opacity-90",
  }[variant];
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex cursor-pointer items-center justify-center gap-2 rounded-lg px-4 py-2 text-[14px] font-medium transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-paper focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40 ${styles}`}
    >
      {children}
    </button>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-dashed border-rule-2 px-5 py-8 text-center text-[14px] text-ink-3">{children}</div>;
}

export function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono text-[12.5px] text-ink-2">{children}</span>;
}
