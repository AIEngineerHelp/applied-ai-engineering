// Citation numbering shared by the screen, PDF and DOCX exports: sources are
// numbered in order of first citation, like a paper's reference list.
import type { Report, Source } from "../agent/types";

export const CITE_RE = /\[((?:PMID|NCT|FDA|FAERS|WEB)[^\]\s]*)\]/g;

/** Ids in order of first citation across answer, sections and limitations. */
export function citationOrder(report: Report): string[] {
  const text = [report.answer, ...report.sections.map((s) => s.body), ...report.limitations].join("\n");
  const seen = new Set<string>();
  for (const m of text.matchAll(CITE_RE)) seen.add(m[1]);
  return [...seen];
}

export function numbering(report: Report): Map<string, number> {
  return new Map(citationOrder(report).map((id, i) => [id, i + 1]));
}

/**
 * Splits text into plain runs and citation groups. Adjacent citations like
 * "[A] [B]" or "[A], [B]" become one group: [1, 2].
 */
export type Piece = { kind: "text"; text: string } | { kind: "cite"; ids: string[] };
export function splitCitations(text: string): Piece[] {
  const out: Piece[] = [];
  const re = /(?:\s*\[(?:PMID|NCT|FDA|FAERS|WEB)[^\]\s]*\](?:\s*,)?)+/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push({ kind: "text", text: text.slice(last, m.index) });
    out.push({ kind: "cite", ids: [...m[0].matchAll(CITE_RE)].map((x) => x[1]) });
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

/** Plain text with citations as [1, 2], for exports. */
export function numbered(text: string, nums: Map<string, number>): string {
  return splitCitations(text)
    .map((p) => (p.kind === "text" ? p.text : ` [${p.ids.map((id) => nums.get(id) ?? "?").join(", ")}]`))
    .join("")
    .replace(/\s+([.,;:])/g, "$1");
}

export const KIND_LABEL: Record<Source["kind"], string> = { pubmed: "PubMed", trials: "ClinicalTrials.gov", fda: "FDA", web: "Web" };

/** One reference-list line for a source. */
export function referenceLine(s: Source): string {
  const bits = [s.title];
  if (s.kind === "pubmed") bits.push([s.meta.journal, s.meta.year].filter(Boolean).join(", "), s.id.replace("PMID:", "PMID "));
  else if (s.kind === "trials") bits.push([s.meta.phase, String(s.meta.status ?? "").toLowerCase()].filter(Boolean).join(", "), s.id);
  else if (s.kind === "fda") bits.push(s.meta.effective ? `label effective ${s.meta.effective}` : "openFDA");
  else bits.push(String(s.meta.host ?? "web"));
  return bits.filter(Boolean).join(". ");
}

/** Splits prose into paragraphs (blank lines) and bullet lists. */
export function blocks(text: string): { kind: "p" | "ul"; items: string[] }[] {
  return text
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean)
    .map((b) => {
      const lines = b.split("\n");
      return lines.every((l) => /^\s*[-*] /.test(l)) ? { kind: "ul" as const, items: lines.map((l) => l.replace(/^\s*[-*] /, "")) } : { kind: "p" as const, items: [b.replace(/\n/g, " ")] };
    });
}
