import { terms, type Method, type Options, type Result, type Span } from "./compress.ts";

export const methodNames: Record<Method, string> = {
  relevance: "Lexical relevance",
  mmr: "MMR",
  words: "Lexical word deletion",
  truncate: "Prefix truncation",
  semantic: "BGE semantic selection",
  llmlingua2: "LLMLingua-2",
  compresr: "Hosted Latte",
  laya: "Laya relevance",
  llmlingua: "LLMLingua",
  longllmlingua: "LongLLMLingua",
};
export interface CutExplanation {
  technique: string;
  how: string;
  queryTerms?: string[];
  reasons: { text: string; reason: string; calculation?: string[] }[];
}
export function explainCut(cut: Span, result: Result, options: Options): CutExplanation {
  const technique = methodNames[options.method];
  if (options.method === "truncate")
    return {
      technique,
      how: `Kept a source prefix within ${result.budget} tokens. This text falls after the cutoff; relevance was not considered.`,
      reasons: [],
    };
  const how =
    options.method === "mmr"
      ? "MMR considers relevance and repetition after each accepted unit. It then checks whether the candidate, headings and separators fit. The scores below are base relevance, not MMR priority."
      : options.method === "words"
        ? "Scored whitespace words by lexical overlap, then tried them in score order. This is word deletion, not a learned token model."
        : options.method === "relevance"
          ? "Scored sentences or paragraphs by weighted term overlap, then tried them in score order. Required headings and separators count toward the budget."
          : "Used model scores to rank source units, then checked each candidate against the token budget with its required headings and separators.";
  const lexical = ["relevance", "mmr", "words"].includes(options.method);
  const source = result.segments.map((segment) => segment.text).join("");
  const unitTerms = result.units.map((unit) =>
    terms(
      unit.text +
        " " +
        unit.headings.map((heading) => source.slice(heading.start, heading.end)).join(" "),
    ),
  );
  const queryTerms =
    lexical && options.queryAware
      ? terms(options.query + (options.useFocus && options.focus ? `\n${options.focus}` : ""))
      : undefined;
  const reasons: CutExplanation["reasons"] = result.units
    .filter((unit) => unit.start < cut.end && unit.end > cut.start)
    .map((unit) => {
      const decision = result.decisions?.find((d) => d.id === unit.id);
      const score = `Score ${unit.score.toFixed(3)}`;
      const matches =
        options.method === "relevance" || options.method === "mmr" || options.method === "words"
          ? options.queryAware
            ? `; matched terms: ${unit.matches.join(", ") || "none"}`
            : "; generic rarity scoring; question ignored"
          : "";
      const reason =
        decision?.outcome === "no-relevance"
          ? `${score}${matches}. Skipped: query-aware selection excludes units with a nonpositive score.`
          : decision?.outcome === "over-budget"
            ? `${score}${matches}. Skipped: adding it at its turn would produce ${decision.candidateTokens} tokens, over the ${result.budget}-token budget.`
            : "No per-unit decision is available for this span; no model explanation is inferred.";
      let calculation: string[] | undefined;
      if (lexical) {
        const words = unitTerms[result.units.indexOf(unit)];
        const contributors = options.queryAware ? unit.matches : words;
        const weights = contributors.map((term) => {
          const df = unitTerms.reduce(
            (count, doc) => count + doc.filter((word) => word === term).length,
            0,
          );
          return { term, df, weight: Math.log(1 + result.units.length / Math.max(1, df)) };
        });
        const sum = weights.reduce((total, item) => total + item.weight, 0);
        calculation = [
          `Normalize this unit${unit.headings.length ? " plus its required headings" : ""}: lowercase, remove common words, deduplicate terms and strip a trailing “s” from words longer than four characters. Terms: ${words.join(", ") || "none"}.`,
          options.queryAware
            ? `Compare with the normalized question${options.useFocus && options.focus ? " and read focus" : ""}: ${contributors.length ? `matching terms are ${contributors.join(", ")}` : "no terms match, so the relevance sum is 0"}.`
            : "Query awareness is off: every unit term contributes a rarity weight; the question is ignored.",
          ...(weights.length
            ? [
                `Weight each contributing term by ln(1 + N / df), where N = ${result.units.length} source units and df is its frequency across the normalized source-unit term lists. ${weights.map((item) => `${item.term}: df=${item.df}, weight=${item.weight.toFixed(3)}`).join("; ")}.`,
              ]
            : []),
          `Divide the weight sum by √(unique unit terms): ${sum.toFixed(3)} / √${Math.max(1, words.length)} = ${unit.score.toFixed(3)}. This is a ranking score, not a probability.`,
        ];
      }
      return { text: unit.text.trim(), reason, calculation };
    });
  if (!reasons.length)
    reasons.push({
      text: "Heading or separator",
      reason:
        "This span was not required by any selected body unit. Headings are kept as dependencies, not independently ranked.",
    });
  return { technique, how, queryTerms, reasons };
}
