import { cn } from "@/lib/utils";

/** A small status marker with an accessible label (never colour alone). */
export function StatusDot({ status, className }: { status: string; className?: string }) {
  const label = status === "completed" ? "Completed" : status === "failed" ? "Failed" : status === "cancelled" ? "Cancelled" : "In progress";
  return (
    <span className={cn("relative inline-flex size-2 shrink-0", className)} role="img" aria-label={label} title={label}>
      {(status === "running" || status === "queued") && <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary/60" />}
      <span
        className={cn(
          "relative inline-flex size-2 rounded-full",
          status === "completed" && "bg-success",
          status === "failed" && "bg-destructive",
          status === "cancelled" && "bg-muted-foreground",
          (status === "running" || status === "queued") && "bg-primary",
        )}
      />
    </span>
  );
}
