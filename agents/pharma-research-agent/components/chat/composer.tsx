"use client";
import { ArrowUp, Loader2 } from "lucide-react";
import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const MIN = 12;
const MAX = 500;

/**
 * The message box: Enter sends, Shift+Enter adds a line. Used for the first
 * question (home) and for follow-ups (bottom of a conversation).
 */
export function Composer({
  onSubmit,
  placeholder,
  disabled,
  disabledReason,
  autoFocus,
  initial = "",
  size = "md",
}: {
  onSubmit: (query: string) => Promise<string | null>;
  placeholder: string;
  disabled?: boolean;
  disabledReason?: string;
  autoFocus?: boolean;
  initial?: string;
  size?: "md" | "lg";
}) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  const trimmed = value.trim();
  const blocked = disabled || busy;

  async function send() {
    if (blocked) return;
    if (trimmed.length < MIN) {
      setError(`Add a little more detail — at least ${MIN} characters.`);
      return;
    }
    setBusy(true);
    setError(null);
    const err = await onSubmit(trimmed);
    setBusy(false);
    if (err) setError(err);
    else setValue("");
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <label htmlFor={id} className="sr-only">
        {placeholder}
      </label>
      <div
        className={cn(
          "flex items-end gap-2 rounded-2xl border bg-card p-2 shadow-sm transition-[border-color,box-shadow] duration-150 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/15",
          error && "border-destructive",
        )}
      >
        <textarea
          id={id}
          ref={ref}
          value={value}
          autoFocus={autoFocus}
          maxLength={MAX}
          rows={size === "lg" ? 3 : 1}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError(null);
            e.target.style.height = "auto";
            e.target.style.height = `${Math.min(e.target.scrollHeight, 220)}px`;
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={placeholder}
          aria-invalid={!!error}
          aria-describedby={`${id}-msg`}
          className={cn("max-h-[220px] min-h-10 flex-1 resize-none bg-transparent px-2.5 py-2 leading-relaxed outline-none placeholder:text-muted-foreground/80", size === "lg" ? "text-[16px]" : "text-[15px]")}
        />
        <Button type="submit" size="icon" disabled={blocked || !trimmed} className="size-9 shrink-0 rounded-xl" aria-label="Send">
          {busy ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
        </Button>
      </div>
      <p id={`${id}-msg`} role={error ? "alert" : undefined} className={cn("mt-1.5 min-h-4 px-1 text-[12px]", error ? "text-destructive" : "text-muted-foreground")}>
        {error ?? (disabled ? disabledReason : "Enter to send · Shift+Enter for a new line")}
      </p>
    </form>
  );
}
