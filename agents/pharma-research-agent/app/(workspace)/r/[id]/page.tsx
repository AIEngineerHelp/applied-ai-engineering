import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { ReportSkeleton } from "@/components/report/report-skeleton";
import { ReportView } from "@/components/report/report-view";
import { getReport, reportSnapshot } from "@/lib/reports";
import { workspaceId } from "@/lib/workspace";

async function Loader({ params }: { params: Promise<{ id: string }> }) {
  // A report is always read at request time (it is private, and it changes while running).
  await connection();
  const { id } = await params;
  const row = await getReport(id, { workspaceId: await workspaceId() });
  if (!row) notFound();
  return <ReportView initial={await reportSnapshot(row)} />;
}

export default function ReportPage({ params }: PageProps<"/r/[id]">) {
  return (
    <Suspense fallback={<ReportSkeleton />}>
      <Loader params={params} />
    </Suspense>
  );
}
