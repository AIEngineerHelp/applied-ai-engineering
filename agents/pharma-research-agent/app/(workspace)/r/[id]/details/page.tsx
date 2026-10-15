import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { RunDetails } from "@/components/details/run-details";
import { ReportSkeleton } from "@/components/report/report-skeleton";
import { getThread, reportSnapshot } from "@/lib/reports";
import { workspaceId } from "@/lib/workspace";

async function Loader({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ turn?: string }> }) {
  await connection();
  const [{ id }, { turn }] = await Promise.all([params, searchParams]);
  const turns = await getThread(id, { workspaceId: await workspaceId() });
  const row = turns.find((t) => t.id === turn) ?? turns.at(-1);
  if (!row) notFound();
  return <RunDetails initial={await reportSnapshot(row)} />;
}

export default function DetailsPage({ params, searchParams }: PageProps<"/r/[id]/details">) {
  return (
    <Suspense fallback={<ReportSkeleton />}>
      <Loader params={params} searchParams={searchParams as Promise<{ turn?: string }>} />
    </Suspense>
  );
}
