"use client";
import { Menu, Plus, Search } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { Logo } from "@/components/app/logo";
import { useReports } from "@/components/app/reports-provider";
import { StatusDot } from "@/components/app/status-dot";
import { ThemeToggle } from "@/components/app/theme-toggle";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

function groupLabel(iso: string, now: Date): string {
  const d = new Date(iso);
  const days = Math.floor((new Date(now.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "Previous 7 days";
  if (days < 30) return "Previous 30 days";
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function ReportNav({ onNavigate }: { onNavigate?: () => void }) {
  const { reports } = useReports();
  const pathname = usePathname();
  const [q, setQ] = useState("");
  const groups = useMemo(() => {
    // Only runs once the list has loaded in the browser, never during prerender.
    if (!reports) return [];
    const now = new Date();
    const list = (reports ?? []).filter((r) => !q || `${r.title ?? ""} ${r.query}`.toLowerCase().includes(q.toLowerCase()));
    const out = new Map<string, typeof list>();
    for (const r of list) {
      const g = groupLabel(r.createdAt, now);
      out.set(g, [...(out.get(g) ?? []), r]);
    }
    return [...out.entries()];
  }, [reports, q]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-3 pb-2">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search reports" aria-label="Search reports" className="h-8 bg-background pl-8 text-[13px]" />
        </div>
      </div>
      <nav aria-label="Reports" className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {reports === null ? (
          <div className="space-y-2 px-1 pt-2">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-7 w-full" />
            ))}
          </div>
        ) : groups.length === 0 ? (
          <p className="px-2 pt-3 text-[13px] text-muted-foreground">{q ? "No reports match." : "Your reports will appear here."}</p>
        ) : (
          groups.map(([label, items]) => (
            <div key={label} className="mt-3 first:mt-1">
              <div className="px-2 pb-1 text-[11.5px] font-medium text-muted-foreground">{label}</div>
              <ul className="space-y-px">
                {items.map((r) => {
                  const active = pathname.startsWith(`/r/${r.id}`);
                  return (
                    <li key={r.id}>
                      <Link
                        href={`/r/${r.id}`}
                        onClick={onNavigate}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "group flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] leading-snug transition-colors",
                          active ? "bg-sidebar-accent font-medium text-foreground" : "text-foreground/80 hover:bg-sidebar-accent/70 hover:text-foreground",
                        )}
                      >
                        <span className="min-w-0 flex-1 truncate">{r.title ?? r.query}</span>
                        {r.status !== "completed" && <StatusDot status={r.status} />}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))
        )}
      </nav>
    </div>
  );
}

function SidebarBody({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <>
      <div className="flex h-14 items-center justify-between px-4">
        <Link href="/" onClick={onNavigate} className="rounded-md" aria-label="Pharma Research home">
          <Logo />
        </Link>
      </div>
      <div className="px-3 pb-3">
        <Button asChild className="w-full justify-start gap-2" size="sm">
          <Link href="/" onClick={onNavigate}>
            <Plus className="size-4" /> New research
          </Link>
        </Button>
      </div>
      {/* Reads the URL to mark the open report, so it streams in behind its own boundary. */}
      <Suspense fallback={<div className="flex-1" />}>
        <ReportNav onNavigate={onNavigate} />
      </Suspense>
      <div className="flex items-center justify-between border-t border-sidebar-border px-3 py-2 text-[12px] text-muted-foreground">
        <span>Reports are private to this browser</span>
        <ThemeToggle />
      </div>
    </>
  );
}

export function Sidebar() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <aside className="sticky top-0 hidden h-dvh w-[264px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar lg:flex">
        <SidebarBody />
      </aside>
      <div className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-background/90 px-3 backdrop-blur lg:hidden">
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" className="size-10" aria-label="Open menu">
              <Menu className="size-5" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="flex w-[300px] flex-col gap-0 bg-sidebar p-0">
            <SheetHeader className="sr-only">
              <SheetTitle>Menu</SheetTitle>
            </SheetHeader>
            <SidebarBody onNavigate={() => setOpen(false)} />
          </SheetContent>
        </Sheet>
        <Link href="/" aria-label="Pharma Research home">
          <Logo />
        </Link>
      </div>
    </>
  );
}
