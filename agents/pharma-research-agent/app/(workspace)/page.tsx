import { Suspense } from "react";
import { ExampleQuestions } from "@/components/app/example-questions";
import { HomeComposer } from "@/components/app/home-composer";
import { RecentReports } from "@/components/app/recent-reports";

async function Ask({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
  return <HomeComposer key={q ?? ""} initial={q ?? ""} />;
}

export default function Home({ searchParams }: PageProps<"/">) {
  return (
    <div className="mx-auto w-full max-w-[760px] px-4 pt-14 pb-20 sm:px-6 lg:pt-28">
      <h1 className="text-center text-[28px] leading-tight font-semibold tracking-tight sm:text-[32px]">What do you want to research?</h1>
      <p className="mx-auto mt-2 mb-8 max-w-[56ch] text-center text-[15px] leading-relaxed text-muted-foreground">
        Answers from published studies, registered trials, FDA labels and regulator announcements — with every claim cited to its source.
      </p>
      <Suspense fallback={<HomeComposer />}>
        <Ask searchParams={searchParams as Promise<{ q?: string }>} />
      </Suspense>
      <div className="mt-10 space-y-10">
        <ExampleQuestions />
        <RecentReports />
      </div>
      <p className="mt-12 text-center text-[12px] leading-relaxed text-muted-foreground">
        AI-generated from public sources. Not medical advice — check the cited sources before relying on an answer.
      </p>
    </div>
  );
}
