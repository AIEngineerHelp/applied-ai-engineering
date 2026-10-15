"use client";
// The workspace's report list, shared by the sidebar and the home page.
// Refreshes on navigation, after a new run, and every few seconds while any
// report is still running.
import { createContext, use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReportSummary } from "@/lib/reports";

type Item = Omit<ReportSummary, "createdAt"> & { createdAt: string };
interface Ctx {
  reports: Item[] | null;
  refresh: () => Promise<void>;
  remove: (id: string) => void;
}
const ReportsContext = createContext<Ctx | null>(null);

export function ReportsProvider({ children }: { children: React.ReactNode }) {
  const [reports, setReports] = useState<Item[] | null>(null);
  const inflight = useRef<Promise<void> | null>(null);
  const refresh = useCallback(async () => {
    inflight.current ??= fetch("/api/reports", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : []))
      .then((list: Item[]) => setReports(list))
      .catch(() => setReports((prev) => prev ?? []))
      .finally(() => (inflight.current = null));
    return inflight.current;
  }, []);
  const remove = useCallback((id: string) => setReports((prev) => prev?.filter((r) => r.id !== id) ?? prev), []);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  const running = reports?.some((r) => r.status === "queued" || r.status === "running");
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void refresh(), 4000);
    return () => clearInterval(t);
  }, [running, refresh]);

  const value = useMemo(() => ({ reports, refresh, remove }), [reports, refresh, remove]);
  return <ReportsContext value={value}>{children}</ReportsContext>;
}

export function useReports(): Ctx {
  const ctx = use(ReportsContext);
  if (!ctx) throw new Error("useReports must be used inside ReportsProvider");
  return ctx;
}
