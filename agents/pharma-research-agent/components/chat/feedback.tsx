"use client";
// Thumbs up or down on an answer, with an optional comment. A thumbs down asks
// what went wrong: those notes become eval cases (scripts/export-feedback.ts).
import { ThumbsDown, ThumbsUp } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type Rating = "up" | "down" | null;

export function Feedback({ reportId, initial }: { reportId: string; initial?: { rating: "up" | "down"; comment: string | null } }) {
  const [rating, setRating] = useState<Rating>(initial?.rating ?? null);
  const [comment, setComment] = useState(initial?.comment ?? "");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function save(next: Rating, note?: string) {
    const prev = rating;
    setRating(next);
    setBusy(true);
    try {
      const res = await fetch(`/api/reports/${reportId}/feedback`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rating: next, ...(note ? { comment: note } : {}) }) });
      if (!res.ok) throw new Error();
      if (next) toast.success(next === "up" ? "Thanks for the feedback" : "Thanks, this helps us improve the answers");
    } catch {
      setRating(prev);
      toast.error("Couldn't save your feedback. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-1" role="group" aria-label="Rate this answer">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" className="size-8" aria-label="Good answer" aria-pressed={rating === "up"} disabled={busy} onClick={() => save(rating === "up" ? null : "up")}>
            <ThumbsUp className={cn("size-4", rating === "up" && "fill-current text-primary")} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Good answer</TooltipContent>
      </Tooltip>
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                aria-label="Bad answer"
                aria-pressed={rating === "down"}
                disabled={busy}
                onClick={(e) => {
                  // A second click clears the rating instead of reopening the form.
                  if (rating === "down") {
                    e.preventDefault();
                    void save(null);
                  }
                }}
              >
                <ThumbsDown className={cn("size-4", rating === "down" && "fill-current text-destructive")} />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>Bad answer</TooltipContent>
        </Tooltip>
        <PopoverContent align="end" className="w-80">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setOpen(false);
              void save("down", comment.trim() || undefined);
            }}
          >
            <label htmlFor={`fb-${reportId}`} className="text-[13.5px] font-medium">
              What was wrong with this answer?
            </label>
            <p className="mt-0.5 text-[12px] text-muted-foreground">Optional. Don&apos;t include personal health details.</p>
            <Textarea id={`fb-${reportId}`} value={comment} onChange={(e) => setComment(e.target.value)} maxLength={1000} rows={3} className="mt-2 text-[13.5px]" placeholder="e.g. it missed the STEP-HFpEF trial, or a number is wrong" />
            <div className="mt-2.5 flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => { setOpen(false); void save("down"); }}>
                Skip
              </Button>
              <Button type="submit" size="sm">
                Send
              </Button>
            </div>
          </form>
        </PopoverContent>
      </Popover>
    </div>
  );
}
