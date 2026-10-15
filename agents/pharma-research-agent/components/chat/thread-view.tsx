"use client";
// A research conversation: each question is a turn with its own live research
// run; follow-ups carry the earlier answers as context.
import { Check, Link2, MoreHorizontal, Share2, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useReports } from "@/components/app/reports-provider";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { Snapshot } from "@/hooks/use-report-stream";
import { Composer } from "./composer";
import { Turn } from "./turn";

function ShareDialog({ threadId, initial, open, onOpenChange }: { threadId: string; initial: string | null; open: boolean; onOpenChange: (v: boolean) => void }) {
  const [shareId, setShareId] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const url = shareId && typeof window !== "undefined" ? `${window.location.origin}/s/${shareId}` : "";
  async function toggle(on: boolean) {
    setBusy(true);
    try {
      const res = await fetch(`/api/reports/${threadId}/share`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ on }) });
      if (!res.ok) throw new Error();
      setShareId((await res.json()).shareId);
    } catch {
      toast.error("Couldn't update sharing. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Share conversation</DialogTitle>
          <DialogDescription>Anyone with the link can read every answer in this conversation and its sources. They can&apos;t ask follow-ups or delete it.</DialogDescription>
        </DialogHeader>
        <div className="flex items-center justify-between gap-4 rounded-lg border px-3.5 py-3">
          <Label htmlFor="share-switch" className="text-[13.5px]">
            Public link
          </Label>
          <Switch id="share-switch" checked={!!shareId} disabled={busy} onCheckedChange={toggle} />
        </div>
        {shareId && (
          <div className="flex gap-2">
            <Input readOnly value={url} aria-label="Share link" className="font-mono text-[12.5px]" onFocus={(e) => e.currentTarget.select()} />
            <Button
              variant="secondary"
              onClick={async () => {
                await navigator.clipboard.writeText(url);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? <Check className="size-4" /> : <Link2 className="size-4" />}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function ThreadView({ initial, threadId, share }: { initial: Snapshot[]; threadId: string; share?: string }) {
  const router = useRouter();
  const { refresh, remove } = useReports();
  const [turns, setTurns] = useState(initial);
  const [statuses, setStatuses] = useState<Record<string, string>>(() => Object.fromEntries(initial.map((t) => [t.report.id, t.report.status])));
  const [shareOpen, setShareOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const first = turns[0]?.report;
  const busy = Object.values(statuses).some((s) => s === "queued" || s === "running");
  const readOnly = !!share;

  const onStatus = useCallback((id: string, status: string) => {
    setStatuses((prev) => (prev[id] === status ? prev : { ...prev, [id]: status }));
    if (status === "completed" || status === "failed") void refresh();
  }, [refresh]);

  // Follow the answer as it streams, but only while the reader is at the bottom:
  // scrolling up to read stops the following, scrolling back down resumes it.
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = content.current;
    if (!el) return;
    const atBottom = () => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 96;
    let follow = atBottom();
    const onScroll = () => {
      follow = atBottom();
    };
    const grow = new ResizeObserver(() => {
      if (follow) window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" });
    });
    window.addEventListener("scroll", onScroll, { passive: true });
    grow.observe(el);
    return () => {
      window.removeEventListener("scroll", onScroll);
      grow.disconnect();
    };
  }, []);

  // A new turn scrolls into view.
  useEffect(() => {
    if (turns.length > initial.length) document.getElementById(`turn-${turns.at(-1)!.report.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [turns, initial.length]);

  async function ask(query: string, newThread = false): Promise<string | null> {
    const res = await fetch("/api/research", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(newThread ? { query } : { query, threadId }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return body.error ?? "Something went wrong. Please try again.";
    void refresh();
    if (newThread) {
      router.push(`/r/${body.threadId}`);
      return null;
    }
    const snap = await fetch(`/api/reports/${body.id}`, { cache: "no-store" }).then((r) => r.json() as Promise<Snapshot>);
    setTurns((prev) => [...prev, snap]);
    setStatuses((prev) => ({ ...prev, [body.id]: snap.report.status }));
    return null;
  }

  async function del() {
    const res = await fetch(`/api/reports/${threadId}`, { method: "DELETE" });
    if (!res.ok) return void toast.error("Couldn't delete the conversation.");
    remove(threadId);
    toast.success("Conversation deleted");
    router.push("/");
  }

  return (
    <div className="flex min-h-[calc(100dvh-3.5rem)] flex-col lg:min-h-dvh">
      <header className="sticky top-14 z-20 border-b bg-background/90 backdrop-blur lg:top-0">
        <div className="mx-auto flex h-14 max-w-[820px] items-center gap-3 px-4 sm:px-6">
          <h1 className="min-w-0 flex-1 truncate text-[14px] font-medium">{first?.title ?? first?.query}</h1>
          {!readOnly && (
            <>
              <Button variant="outline" size="sm" onClick={() => setShareOpen(true)}>
                <Share2 className="size-4" /> Share
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="size-8" aria-label="Conversation actions">
                    <MoreHorizontal className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem variant="destructive" onSelect={() => setConfirm(true)}>
                    <Trash2 className="size-4" /> Delete conversation
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}
        </div>
      </header>

      <div ref={content} className="mx-auto w-full max-w-[820px] flex-1 space-y-14 px-4 pt-8 pb-10 sm:px-6">
        {turns.map((t) => (
          <Turn key={t.report.id} initial={t} share={share} onStatus={onStatus} onRetry={readOnly ? undefined : (q) => void ask(q, true)} />
        ))}
        <div ref={bottom} />
        <p className="text-center text-[11.5px] text-muted-foreground">AI-generated from public sources. Not medical advice — check the cited sources before relying on an answer.</p>
      </div>

      {!readOnly && (
        <div className="sticky bottom-0 z-20 bg-gradient-to-t from-background from-70% to-transparent pt-6">
          <div className="mx-auto max-w-[820px] px-4 pb-3 sm:px-6">
            <Composer placeholder="Ask a follow-up…" onSubmit={(q) => ask(q)} disabled={busy} disabledReason="Wait for the current answer to finish before asking a follow-up." />
          </div>
        </div>
      )}

      {!readOnly && <ShareDialog threadId={threadId} initial={first?.shareId ?? null} open={shareOpen} onOpenChange={setShareOpen} />}
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this conversation?</AlertDialogTitle>
            <AlertDialogDescription>Every answer in it, with its sources and run history, will be removed, and shared links will stop working. This can&apos;t be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={del} className="bg-destructive text-white hover:bg-destructive/90">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
