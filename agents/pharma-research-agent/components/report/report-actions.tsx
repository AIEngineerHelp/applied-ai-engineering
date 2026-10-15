"use client";
import { Check, Copy, Download, FileText, Link2, ListTree, MoreHorizontal, RotateCw, Share2, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { useReports } from "@/components/app/reports-provider";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { blocks, numbered, numbering, referenceLine } from "@/lib/citations";
import type { RunState } from "@/lib/run-state";

function asMarkdown(state: RunState): string {
  const r = state.result!;
  const nums = numbering(r);
  const out = [`# ${r.title}`, "", `*${state.report.query}*`, "", ...blocks(r.answer).map((b) => numbered(b.items.join("\n"), nums)), ""];
  for (const s of r.sections) out.push(`## ${s.heading}`, "", numbered(s.body, nums), "");
  if (r.limitations.length) out.push("## Limitations", "", ...r.limitations.map((l) => `- ${numbered(l, nums)}`), "");
  out.push("## References", "");
  for (const [id, n] of nums) {
    const s = state.sources.get(id);
    out.push(`${n}. ${s ? `${referenceLine(s)}. ${s.url}` : id}`);
  }
  return out.join("\n");
}

function ShareDialog({ open, onOpenChange, state }: { open: boolean; onOpenChange: (v: boolean) => void; state: RunState }) {
  const [shareId, setShareId] = useState<string | null>(state.report.shareId);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const url = shareId && typeof window !== "undefined" ? `${window.location.origin}/s/${shareId}` : "";
  async function toggle(on: boolean) {
    setBusy(true);
    try {
      const res = await fetch(`/api/reports/${state.report.id}/share`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ on }) });
      if (!res.ok) throw new Error();
      setShareId((await res.json()).shareId);
      toast.success(on ? "Public link created" : "Public link turned off");
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
          <DialogTitle>Share report</DialogTitle>
          <DialogDescription>Anyone with the link can read this report and its sources. They can&apos;t edit or delete it.</DialogDescription>
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

export function ReportActions({ state, readOnly }: { state: RunState; readOnly?: boolean }) {
  const router = useRouter();
  const { refresh, remove } = useReports();
  const [share, setShare] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const r = state.report;
  const ready = !!state.result && r.status === "completed";
  const shareQs = readOnly && r.shareId ? `&share=${r.shareId}` : "";

  async function rerun() {
    const res = await fetch("/api/research", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: r.query }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return void toast.error(body.error ?? "Couldn't start a new run.");
    void refresh();
    router.push(`/r/${body.id}`);
  }
  async function del() {
    const res = await fetch(`/api/reports/${r.id}`, { method: "DELETE" });
    if (!res.ok) return void toast.error("Couldn't delete the report.");
    remove(r.id);
    toast.success("Report deleted");
    router.push("/");
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {!readOnly && ready && (
        <Button variant="outline" size="sm" onClick={() => setShare(true)}>
          <Share2 className="size-4" /> Share
        </Button>
      )}
      {ready && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              <Download className="size-4" /> Export
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem asChild>
              <a href={`/api/reports/${r.id}/export?format=pdf${shareQs}`}>
                <FileText className="size-4" /> PDF document
              </a>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <a href={`/api/reports/${r.id}/export?format=docx${shareQs}`}>
                <FileText className="size-4" /> Word document (.docx)
              </a>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={async () => {
                await navigator.clipboard.writeText(asMarkdown(state));
                toast.success("Copied as Markdown, with references");
              }}
            >
              <Copy className="size-4" /> Copy as Markdown
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {!readOnly && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-8" aria-label="More actions">
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem asChild>
              <Link href={`/r/${r.id}/details`}>
                <ListTree className="size-4" /> Run details
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={rerun}>
              <RotateCw className="size-4" /> Run again
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => setConfirm(true)}>
              <Trash2 className="size-4" /> Delete report
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {!readOnly && <ShareDialog open={share} onOpenChange={setShare} state={state} />}
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this report?</AlertDialogTitle>
            <AlertDialogDescription>The report, its sources and its run history will be removed. Shared links will stop working. This can&apos;t be undone.</AlertDialogDescription>
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
