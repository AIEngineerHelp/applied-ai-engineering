import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { ThreadView } from "@/components/chat/thread-view";
import { ReportSkeleton } from "@/components/report/report-skeleton";
import { getReport, getThread, reportSnapshot } from "@/lib/reports";
import { workspaceId } from "@/lib/workspace";

async function Loader({ params }: { params: Promise<{ id: string }> }) {
  // A conversation is private and changes while it runs: always read at request time.
  await connection();
  const { id } = await params;
  const access = { workspaceId: await workspaceId() };
  const turns = await getThread(id, access);
  if (!turns.length) {
    // A link to a single turn opens its conversation.
    const turn = await getReport(id, access);
    if (turn) redirect(`/r/${turn.threadId}#turn-${turn.id}`);
    notFound();
  }
  return <ThreadView threadId={id} initial={await Promise.all(turns.map(reportSnapshot))} />;
}

export default function ThreadPage({ params }: PageProps<"/r/[id]">) {
  return (
    <Suspense fallback={<ReportSkeleton />}>
      <Loader params={params} />
    </Suspense>
  );
}
