import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { Logo } from "@/components/app/logo";
import { ReportsProvider } from "@/components/app/reports-provider";
import { ThemeToggle } from "@/components/app/theme-toggle";
import { Button } from "@/components/ui/button";
import { ReportSkeleton } from "@/components/report/report-skeleton";
import { ReportView } from "@/components/report/report-view";
import { getSharedReport, reportSnapshot } from "@/lib/reports";

async function Loader({ params }: { params: Promise<{ shareId: string }> }) {
  // A report is always read at request time (it is private, and it changes while running).
  await connection();
  const { shareId } = await params;
  const row = await getSharedReport(shareId);
  if (!row) notFound();
  return <ReportView initial={await reportSnapshot(row)} share={shareId} />;
}

/** A shared report: read-only, no workspace sidebar. */
export default function SharedReport({ params }: PageProps<"/s/[shareId]">) {
  return (
    <ReportsProvider>
      <header className="sticky top-0 z-30 border-b bg-background/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1240px] items-center justify-between px-4 sm:px-6 lg:px-10">
          <Link href="/" aria-label="Pharma Research home">
            <Logo />
          </Link>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <Button asChild size="sm">
              <Link href="/">Start your own research</Link>
            </Button>
          </div>
        </div>
      </header>
      <main id="main">
        <Suspense fallback={<ReportSkeleton />}>
          <Loader params={params} />
        </Suspense>
      </main>
    </ReportsProvider>
  );
}
