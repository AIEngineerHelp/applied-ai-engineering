// The lint pass: checks that code can run over the whole wiki at once.
// A real agent would also ask a model to look for contradictions written in prose; here, conflicting
// values only count when both are recorded as claims, which keeps the check exact and testable.

import type { Claim, Wiki } from "./wiki.ts";

export type FindingKind = "contradiction" | "missing-page" | "orphan" | "uncited-claim";

export interface Finding {
  kind: FindingKind;
  title: string;
  detail: string;
  /** Pages involved, in the order they should be read. */
  pages: string[];
  /** For contradictions: the claims that disagree. */
  claims: Claim[];
  suggestion: string;
}

export interface LintResult {
  checks: { kind: FindingKind; label: string; count: number }[];
  findings: Finding[];
}

/** Two keys describe the same fact when they are equal or one is a parent of the other ("a.b" and "a.b.c"). */
export function keysOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
}

const normalize = (v: string) => v.trim().toLowerCase().replace(/\s+/g, " ");

export function lint(wiki: Wiki): LintResult {
  const findings: Finding[] = [];
  const current = [...wiki.values()].flatMap((p) => p.claims.filter((c) => c.status === "current"));

  // 1. Contradictions: join current claims whose keys overlap into groups, then report every group
  //    that contains an overlapping pair with different values.
  const groups: Claim[][] = [];
  for (const claim of current) {
    const joined = groups.filter((g) => g.some((c) => keysOverlap(c.key, claim.key)));
    const merged = [...joined.flat(), claim];
    for (const g of joined) groups.splice(groups.indexOf(g), 1);
    groups.push(merged);
  }
  for (const group of groups) {
    const conflict = group.some((x) => group.some((y) => keysOverlap(x.key, y.key) && normalize(x.value) !== normalize(y.value)));
    if (!conflict) continue;
    const values = new Set(group.map((c) => normalize(c.value)));
    const root = group.map((c) => c.key).sort((a, b) => a.length - b.length)[0];
    const newest = [...group].sort((a, b) => b.asOf.localeCompare(a.asOf))[0];
    findings.push({
      kind: "contradiction",
      title: `\`${root}\` has ${values.size} different values`,
      detail: group.map((c) => `${c.value} (${c.source}, ${c.asOf})`).join(" vs "),
      pages: [...new Set(group.flatMap((c) => [c.page, c.source]))],
      claims: group,
      suggestion: `Ask the owner which value is right. Don't keep the newest by default: the newest here comes from ${newest.source}. Strike the losing claim through as disputed and say why.`,
    });
  }

  // 2. Missing pages: links to pages that don't exist.
  const missing = new Map<string, string[]>();
  for (const p of wiki.values()) {
    for (const target of p.links) {
      if (!wiki.has(target)) missing.set(target, [...(missing.get(target) ?? []), p.slug]);
    }
  }
  for (const [target, from] of missing) {
    findings.push({
      kind: "missing-page",
      title: `[[${target}]] is linked but has no page`,
      detail: `Linked from ${from.length} page${from.length === 1 ? "" : "s"}: ${from.join(", ")}.`,
      pages: from,
      claims: [],
      suggestion: `Create ${target} from what the linking pages and their sources already say.`,
    });
  }

  // 3. Orphans: pages that nothing links to (the overview is the entry point, so it is exempt).
  for (const p of wiki.values()) {
    if (p.type === "overview") continue;
    const inbound = [...wiki.values()].some((q) => q.slug !== p.slug && q.links.includes(p.slug));
    if (!inbound) {
      findings.push({
        kind: "orphan",
        title: `${p.slug} has no inbound links`,
        detail: "No other page links here, so a reader following links will never reach it.",
        pages: [p.slug],
        claims: [],
        suggestion: "Link it from the pages it relates to, or merge it into one of them.",
      });
    }
  }

  // 4. Uncited claims: current claims whose source page doesn't exist.
  for (const c of current) {
    if (!wiki.has(c.source)) {
      findings.push({
        kind: "uncited-claim",
        title: `\`${c.key}\` on ${c.page} cites a missing source`,
        detail: `Cites [[${c.source}]], which is not a page.`,
        pages: [c.page],
        claims: [c],
        suggestion: "Find the source and add its page, or remove the claim.",
      });
    }
  }

  const count = (kind: FindingKind) => findings.filter((f) => f.kind === kind).length;
  return {
    checks: [
      { kind: "contradiction", label: "Contradicting claims", count: count("contradiction") },
      { kind: "missing-page", label: "Links to missing pages", count: count("missing-page") },
      { kind: "orphan", label: "Pages nothing links to", count: count("orphan") },
      { kind: "uncited-claim", label: "Claims without a source page", count: count("uncited-claim") },
    ],
    findings,
  };
}
