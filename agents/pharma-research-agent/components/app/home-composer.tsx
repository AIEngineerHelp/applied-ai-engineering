"use client";
import { useRouter } from "next/navigation";
import { Composer } from "@/components/chat/composer";
import { useReports } from "@/components/app/reports-provider";

export function HomeComposer({ initial }: { initial?: string }) {
  const router = useRouter();
  const { refresh } = useReports();
  return (
    <Composer
      size="lg"
      autoFocus
      initial={initial}
      placeholder="Ask a research question — e.g. What is the evidence on SGLT2 inhibitors and diabetic ketoacidosis?"
      onSubmit={async (query) => {
        const res = await fetch("/api/research", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }) });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) return body.error ?? "Something went wrong. Please try again.";
        void refresh();
        router.push(`/r/${body.threadId}`);
        return null;
      }}
    />
  );
}
