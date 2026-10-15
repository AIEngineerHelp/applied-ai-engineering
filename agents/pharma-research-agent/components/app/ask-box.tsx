"use client";
import { ArrowUp, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useRef, useState } from "react";
import { useReports } from "@/components/app/reports-provider";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const MIN = 12;
const MAX = 500;

export function AskBox({ initial = "", autoFocus = false }: { initial?: string; autoFocus?: boolean }) {
  const router = useRouter();
  const { refresh } = useReports();
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  const trimmed = value.trim();

  async function submit() {
    if (busy) return;
    if (trimmed.length < MIN) {
      setError(`Add a little more detail — at least ${MIN} characters.`);
      ref.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/research", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: trimmed }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Something went wrong. Please try again.");
      void refresh();
      router.push(`/r/${body.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className="w-full"
    >
      <label htmlFor={id} className="mb-2 block text-[13px] font-medium">
        Research question
      </label>
      <div
        className={cn(
          "rounded-xl border bg-card shadow-sm transition-[border-color,box-shadow] duration-150 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/15",
          error && "border-destructive focus-within:border-destructive focus-within:ring-destructive/15",
        )}
      >
        <textarea
          id={id}
          ref={ref}
          value={value}
          autoFocus={autoFocus}
          maxLength={MAX}
          rows={3}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder="e.g. What is the evidence on SGLT2 inhibitors and diabetic ketoacidosis in type 2 diabetes?"
          aria-invalid={!!error}
          aria-describedby={`${id}-help ${id}-error`}
          className="block w-full resize-none bg-transparent px-4 pt-3.5 pb-2 text-[15.5px] leading-relaxed outline-none placeholder:text-muted-foreground/80"
        />
        <div className="flex items-center justify-between gap-3 px-3 pb-3">
          <span id={`${id}-help`} className="pl-1 text-[12px] text-muted-foreground">
            Name the drug, population and outcome. <span className="hidden sm:inline">⌘↵ to run.</span>
          </span>
          <div className="flex items-center gap-3">
            <span className={cn("tabular text-[12px] text-muted-foreground", value.length > MAX - 40 && "text-warning")} aria-live="polite">
              {value.length}/{MAX}
            </span>
            <Button type="submit" disabled={busy} className="h-9 gap-1.5 px-3.5">
              {busy ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
              {busy ? "Starting" : "Research"}
            </Button>
          </div>
        </div>
      </div>
      <p id={`${id}-error`} role="alert" className="mt-2 min-h-5 text-[13px] text-destructive">
        {error}
      </p>
    </form>
  );
}
