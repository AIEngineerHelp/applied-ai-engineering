import { BookOpenText, FlaskConical, Globe, ShieldCheck } from "lucide-react";
import type { SourceKind } from "@/lib/research/types";
import { cn } from "@/lib/utils";

export const KB: Record<SourceKind, { name: string; short: string; Icon: typeof BookOpenText }> = {
  pubmed: { name: "PubMed", short: "PubMed", Icon: BookOpenText },
  trials: { name: "ClinicalTrials.gov", short: "Trials", Icon: FlaskConical },
  fda: { name: "FDA labels & FAERS", short: "FDA", Icon: ShieldCheck },
  web: { name: "Web", short: "Web", Icon: Globe },
};

export function KbIcon({ kind, className }: { kind: SourceKind; className?: string }) {
  const { Icon, name } = KB[kind];
  return <Icon className={cn("size-4 shrink-0 text-muted-foreground", className)} aria-label={name} />;
}
