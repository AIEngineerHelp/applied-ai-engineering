"use client";
import { CornerDownLeft } from "lucide-react";
import { useRouter } from "next/navigation";

const EXAMPLES = [
  "What is the evidence on GLP-1 receptor agonists and acute pancreatitis risk?",
  "How effective and safe is semaglutide in heart failure with preserved ejection fraction?",
  "What do FDA labels and trials say about SGLT2 inhibitors and diabetic ketoacidosis?",
  "What is known about tirzepatide for obstructive sleep apnea?",
];

/** Clicking an example fills the box via the URL, so the question is shareable and editable. */
export function ExampleQuestions() {
  const router = useRouter();
  return (
    <section aria-labelledby="examples-heading">
      <h2 id="examples-heading" className="mb-3 text-[13px] font-semibold">
        Examples
      </h2>
      <ul className="grid gap-2 sm:grid-cols-2">
        {EXAMPLES.map((q) => (
          <li key={q}>
            <button
              type="button"
              onClick={() => router.push(`/?q=${encodeURIComponent(q)}`)}
              className="group flex h-full w-full items-start gap-3 rounded-lg border bg-card px-3.5 py-3 text-left text-[13.5px] leading-snug transition-colors hover:border-ring/50 hover:bg-accent/40"
            >
              <span className="flex-1">{q}</span>
              <CornerDownLeft className="mt-0.5 size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
