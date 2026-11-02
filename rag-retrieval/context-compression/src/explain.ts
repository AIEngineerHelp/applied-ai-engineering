import type { Method, Options, Result, Span } from "./compress.ts";

export const methodNames: Record<Method, string> = {
  relevance: "Lexical relevance", mmr: "MMR", words: "Lexical word deletion", truncate: "Prefix truncation",
  semantic: "BGE semantic selection", llmlingua2: "LLMLingua-2", compresr: "Hosted Latte",
  laya: "Laya relevance", llmlingua: "LLMLingua", longllmlingua: "LongLLMLingua",
};
export interface CutExplanation { technique: string; how: string; reasons: { text: string; reason: string }[] }
export function explainCut(cut: Span, result: Result, options: Options): CutExplanation {
  const technique = methodNames[options.method];
  if (options.method === "truncate") return { technique,
    how: `Kept a source prefix within ${result.budget} tokens. This text falls after the cutoff; relevance was not considered.`, reasons: [] };
  const how = options.method === "mmr"
    ? "MMR considers relevance and repetition after each accepted unit. It then checks whether the candidate, headings and separators fit. The scores below are base relevance, not MMR priority."
    : options.method === "words"
      ? "Scored whitespace words by lexical overlap, then tried them in score order. This is word deletion, not a learned token model."
      : options.method === "relevance"
        ? "Scored sentences or paragraphs by weighted term overlap, then tried them in score order. Required headings and separators count toward the budget."
        : "Used model scores to rank source units, then checked each candidate against the token budget with its required headings and separators.";
  const reasons = result.units.filter((unit) => unit.start < cut.end && unit.end > cut.start).map((unit) => {
    const decision = result.decisions?.find((d) => d.id === unit.id);
    const score = `Score ${unit.score.toFixed(3)}`;
    const matches = options.method === "relevance" || options.method === "mmr" || options.method === "words"
      ? options.queryAware ? `; matched terms: ${unit.matches.join(", ") || "none"}` : "; generic rarity scoring; question ignored" : "";
    const reason = decision?.outcome === "no-relevance"
      ? `${score}${matches}. Skipped: query-aware selection excludes units with a nonpositive score.`
      : decision?.outcome === "over-budget"
        ? `${score}${matches}. Skipped: adding it at its turn would produce ${decision.candidateTokens} tokens, over the ${result.budget}-token budget.`
        : "No per-unit decision is available for this span; no model explanation is inferred.";
    return { text: unit.text.trim(), reason };
  });
  if (!reasons.length) reasons.push({ text: "Heading or separator", reason: "This span was not required by any selected body unit. Headings are kept as dependencies, not independently ranked." });
  return { technique, how, reasons };
}
