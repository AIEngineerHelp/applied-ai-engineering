// The technique tour: one chapter per browser technique, stepped through on the
// same handbook and question. All numbers come from src/tour.ts.
import { jaccard, type Unit } from "../src/compress.ts";
import {
  breakingCases,
  compareAll,
  lexicalWalkthrough,
  mmrWalkthrough,
  sentenceCoverage,
  tourExample,
  tourMethods,
  truncationWalkthrough,
  wordWalkthrough,
  type FactCheck,
  type TourMethod,
} from "../src/tour.ts";

export interface LabRequest {
  method: TourMethod;
  remove: number;
  diversity?: number;
  query?: string;
}

const esc = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
const short = (text: string, max = 92) => {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
};
const fmt = (n: number, digits = 2) => n.toFixed(digits);
const { source, evidence, question } = tourExample;
const factStart = evidence.map((e) => source.indexOf(e.quote));
const isFact = (u: { start: number; end: number }) =>
  evidence.some((e, i) => u.start < factStart[i] + e.quote.length && u.end > factStart[i]);

// ---------- Shared visuals ----------

/** A map of the handbook: one bar per sentence, filled by how much of it survived. */
function docMap(coverage: { unit: Unit; kept: number }[], opts: { neutral?: boolean } = {}) {
  const maxLen = Math.max(...coverage.map((c) => c.unit.end - c.unit.start));
  const groups: { heading: string; rows: string[] }[] = [];
  for (const { unit, kept } of coverage) {
    const h = unit.headings.at(-1);
    const heading = h ? source.slice(h.start, h.end).replace(/^#+\s*|\s*\[[^\]]+\]\s*$/g, "") : "";
    if (groups.at(-1)?.heading !== heading) groups.push({ heading, rows: [] });
    const width = 18 + (82 * (unit.end - unit.start)) / maxLen;
    const fill = opts.neutral ? 0 : Math.round(kept * 100);
    groups
      .at(-1)!
      .rows.push(
        `<span class="map-row${isFact(unit) ? " is-fact" : ""}" title="${esc(short(unit.text, 160))}"><span class="map-bar" style="width:${width}%"><span style="width:${fill}%"></span></span>${isFact(unit) ? '<span class="map-fact">fact</span>' : ""}</span>`,
      );
  }
  return `<div class="doc-map${opts.neutral ? " neutral" : ""}">${groups
    .map(
      (g) =>
        `<div class="map-section"><span class="map-heading">${esc(g.heading)}</span>${g.rows.join("")}</div>`,
    )
    .join("")}</div>`;
}

function verdict(facts: FactCheck[]) {
  const [rule, exception] = facts;
  const summary =
    rule.kept && exception.kept
      ? "Both facts survived. An answerer has what it needs to say “no, the export removes the refund.”"
      : !exception.kept && !rule.kept
        ? "Both facts are gone. An answerer can’t know the policy, and may guess."
        : !exception.kept
          ? "The exception is gone. An answerer would likely say “yes, within 30 days”: the wrong answer."
          : "The general rule is gone. The exception alone still says no, but the answer loses the 30-day context.";
  return `<div class="verdict ${rule.kept && exception.kept ? "good" : "bad"}"><ul>${facts
    .map(
      (f) =>
        `<li class="${f.kept ? "kept" : "lost"}"><span aria-hidden="true">${f.kept ? "✓" : "✕"}</span><span><strong>${esc(f.label)}</strong> ${f.kept ? "kept" : "lost"}</span></li>`,
    )
    .join("")}</ul><p>${summary}</p></div>`;
}

function meter(used: number, budget: number, total: number) {
  return `<div class="meter" role="img" aria-label="${used} of ${budget} budget tokens used; source is ${total} tokens"><div class="meter-track"><span class="meter-budget" style="width:${(100 * budget) / total}%"></span><span class="meter-used" style="width:${(100 * used) / total}%"></span></div><div class="meter-legend"><span><i class="used"></i>${used} tokens kept</span><span><i class="budget"></i>${budget}-token budget</span><span>${total} in the handbook</span></div></div>`;
}

// ---------- Chapters ----------

interface Step {
  title: string;
  body: string;
  visual: string;
}
interface Chapter {
  method: TourMethod;
  name: string;
  idea: string;
  steps: () => Step[];
  goodAt: string;
  breaksWhen: string;
  seenIn: string;
  demoLabel: string;
  demo: () => string;
  demoLab: LabRequest;
}

function lexicalSteps(): Step[] {
  const w = lexicalWalkthrough();
  const { result } = w;
  const sections = new Set(result.units.map((u) => u.headings.at(-1)?.start)).size;
  const weights = [...w.weights].sort((a, b) => b.weight - a.weight);
  const maxWeight = Math.max(...weights.map((x) => x.weight));
  const top = w.topCalculation!;
  const sum = top.contributions.reduce((s, c) => s + c.weight, 0);
  const maxScore = w.ranked[0].score;
  const skipped = w.pack.filter((p) => p.outcome === "over-budget");
  const keptCount = w.pack.filter((p) => p.outcome === "kept").length;
  return [
    {
      title: "Cut the handbook into sentences",
      body: `<p>The handbook becomes <strong>${result.units.length} sentences</strong> in ${sections} sections. Each one remembers exactly where it sits in the original text, so whatever is kept can be copied out word for word.</p><p>Headings are never scored. A heading travels with any sentence kept under it, because “30 days” means little without knowing it’s the refund policy.</p>`,
      visual: `${docMap(sentenceCoverage(source, result), { neutral: true })}<p class="visual-note">Each bar is one sentence, sized by its length. The two sentences that answer the question are marked <span class="map-fact">fact</span>. The method doesn’t know that; we use the marks only to check the result.</p>`,
    },
    {
      title: "Reduce the question to its key words",
      body: `<p>Words like “can”, “I”, “a” and “for” appear everywhere and say nothing about the topic, so they’re dropped. A trailing “s” is trimmed from longer words so “archives” matches “archive”.</p><p>What’s left is <strong>${w.question.terms.length} search terms</strong>.</p>`,
      visual: `<p class="q-original">“${esc(question)}”</p><div class="word-flow">${w.question.steps
        .map((s) =>
          s.term === null
            ? `<span class="word dropped">${esc(s.word)}</span>`
            : s.term !== s.word
              ? `<span class="word kept">${esc(s.word)} <b>→ ${esc(s.term)}</b></span>`
              : `<span class="word kept">${esc(s.word)}</span>`,
        )
        .join(
          "",
        )}</div><div class="legend-row"><span><i class="key kept"></i>search term</span><span><i class="key dropped"></i>filler word, ignored</span></div>`,
    },
    {
      title: "Give rare words more weight",
      body: `<p>A word found in many sentences is a weak clue. A word found in only one or two is a strong one. Each term’s weight is</p><p class="formula">weight = ln(1 + ${result.units.length} ÷ sentences containing the word)</p><p>“${esc(weights[0].term)}” appears in ${weights[0].df} sentence${weights[0].df === 1 ? "" : "s"}, so it counts the most. “${esc(weights.at(-1)!.term)}” appears in ${weights.at(-1)!.df}, so it counts the least.</p>`,
      visual: `<table class="weights"><thead><tr><th scope="col">Term</th><th scope="col">In sentences</th><th scope="col">Weight</th></tr></thead><tbody>${weights
        .map(
          (x) =>
            `<tr><th scope="row">${esc(x.term)}</th><td>${x.df} of ${result.units.length}</td><td><span class="bar"><span style="width:${(100 * x.weight) / maxWeight}%"></span></span>${fmt(x.weight)}</td></tr>`,
        )
        .join("")}</tbody></table>`,
    },
    {
      title: "Score every sentence",
      body: `<p>A sentence’s score is the sum of the weights of the question words it contains, divided by √(its number of distinct words) so that long sentences don’t win just by being long.</p><p><strong>${w.zeroScore} of ${result.units.length}</strong> sentences share no word with the question and score 0.</p><div class="calc"><span class="calc-label">How the top sentence scores</span><q>${esc(short(top.unit.text, 140))}</q><p>${top.contributions.map((c) => `${esc(c.term)} ${fmt(c.weight)}`).join(" + ")} = ${fmt(sum)}<br>${fmt(sum)} ÷ √${top.uniqueTerms} = <strong>${fmt(top.unit.score)}</strong></p></div>`,
      visual: `<ol class="score-list">${w.ranked
        .slice(0, 12)
        .map(
          (u) =>
            `<li class="${isFact(u) ? "is-fact" : ""}"><span class="score-bar"><span style="width:${(100 * u.score) / maxScore}%"></span></span><span class="score-value">${fmt(u.score)}</span><span class="score-text">${esc(short(u.text, 70))}${isFact(u) ? ' <span class="map-fact">fact</span>' : ""}</span><span class="score-terms">${u.matches.map(esc).join(" · ")}</span></li>`,
        )
        .join(
          "",
        )}</ol><p class="visual-note">Top 12 of ${w.ranked.length} sentences with a nonzero score.</p>`,
    },
    {
      title: "Pack the best sentences into the budget",
      body: `<p>The budget is ${result.budget} tokens: 40% of the ${result.originalTokens}-token handbook. Sentences go in best-first. Each one is accepted only if it, its heading and the blank lines between still fit.</p><p>${keptCount} sentences fit.${skipped.length ? ` “${esc(short(skipped[0].unit.text, 60))}” would have pushed the total over ${result.budget}, so the packer skipped it and tried the next one.` : ""} The kept sentences are then put back in their original order.</p>`,
      visual: `${meter(result.compressedTokens, result.budget, result.originalTokens)}<ol class="pack-list">${w.pack
        .filter((p) => p.outcome !== "no-relevance")
        .map(
          (p) =>
            `<li class="${p.outcome}${isFact(p.unit) ? " is-fact" : ""}"><span class="pack-outcome">${p.outcome === "kept" ? `✓ ${p.tokensAfter}` : "skip"}</span><span>${esc(short(p.unit.text, 80))}${isFact(p.unit) ? ' <span class="map-fact">fact</span>' : ""}</span></li>`,
        )
        .join(
          "",
        )}</ol><p class="visual-note">“✓ 49” means the context is 49 tokens after adding this sentence and its heading.</p>`,
    },
    {
      title: "Read the result",
      body: `<p>${result.compressedTokens} of ${result.originalTokens} tokens are kept, a ${Math.round(result.removed * 100)}% cut. The refund section survives almost whole, and unrelated sections are reduced to the few sentences that mention “annual” or “client”.</p>`,
      visual: `${docMap(sentenceCoverage(source, result))}${verdict(w.facts)}`,
    },
  ];
}

function mmrSteps(): Step[] {
  const m = mmrWalkthrough();
  const lex = lexicalWalkthrough();
  const kept = m.rounds.filter((r) => r.outcome === "kept");
  const lexOrder = lex.pack.filter((p) => p.outcome === "kept").map((p) => p.unit.id);
  const firstDiff = kept.findIndex((r, i) => r.unit.id !== lexOrder[i]);
  const sameSet = [...m.result.selected].sort().join() === [...lex.result.selected].sort().join();
  // Explain the first round where MMR and plain ranking disagree, with real numbers.
  let diffNote = "";
  if (firstDiff >= 0) {
    const lexChoice = lex.result.units[lexOrder[firstDiff]];
    const before = kept.slice(0, firstDiff).map((r) => r.unit);
    const overlap = Math.max(0, ...before.map((u) => jaccard(lexChoice.text, u.text)));
    const relevance = lexChoice.score / lex.ranked[0].score;
    const priority = m.weight * relevance - (1 - m.weight) * overlap;
    const picked = kept[firstDiff];
    diffNote = `<p>Round ${firstDiff + 1} is where they part ways. Plain ranking would take “${esc(short(lexChoice.text, 50))}” next (relevance ${fmt(relevance)}). It shares ${Math.round(overlap * 100)}% of its words with a sentence already kept, so its priority drops to ${fmt(priority)}, just below “${esc(short(picked.unit.text, 52))}” at ${fmt(picked.priority)}.</p>`;
  }
  return [
    {
      title: "Start from the same relevance scores",
      body: `<p>MMR (maximal marginal relevance) uses the lexical scores from the previous chapter, rescaled so the best sentence is 1.0.</p><p>Plain lexical ranking has a blind spot: if three sentences say nearly the same thing, it happily keeps all three. MMR asks a second question at every pick: <em>is this new, or have I already got it?</em></p>`,
      visual: `<ol class="score-list">${lex.ranked
        .slice(0, 6)
        .map(
          (u) =>
            `<li><span class="score-bar"><span style="width:${(100 * u.score) / lex.ranked[0].score}%"></span></span><span class="score-value">${fmt(u.score / lex.ranked[0].score)}</span><span class="score-text">${esc(short(u.text, 70))}</span></li>`,
        )
        .join("")}</ol>`,
    },
    {
      title: "Penalize look-alikes after every pick",
      body: `<p>Each round, every remaining sentence gets a priority:</p><p class="formula">priority = λ × relevance − (1 − λ) × overlap</p><p><strong>Overlap</strong> compares the sentence with the most similar one already kept: shared words ÷ all words in the two (Jaccard similarity). With λ = ${m.weight}, relevance matters most and repetition costs a little.</p>`,
      visual: `<div class="formula-card"><div><span>λ</span><strong>${m.weight}</strong><small>relevance weight</small></div><div><span>1 − λ</span><strong>${fmt(1 - m.weight)}</strong><small>repetition penalty</small></div></div><p class="visual-note">λ = 1 is plain lexical ranking. λ = 0 ignores the question and only seeks variety.</p>`,
    },
    {
      title: "Watch the rounds",
      body: `<p>The priority is recomputed after each accepted sentence, so a sentence can slide down the queue once something similar is in.</p>${diffNote}`,
      visual: `<table class="rounds"><thead><tr><th scope="col">Round</th><th scope="col">Picked</th><th scope="col">Relevance</th><th scope="col">Overlap</th><th scope="col">Priority</th></tr></thead><tbody>${kept
        .slice(0, 8)
        .map(
          (r, i) =>
            `<tr class="${i === firstDiff ? "changed" : ""}"><td>${i + 1}</td><td>${esc(short(r.unit.text, 64))}${r.similarTo ? `<small>closest kept: ${esc(short(r.similarTo.text, 40))}</small>` : ""}</td><td>${fmt(r.relevance)}</td><td>${fmt(r.similarity)}</td><td>${fmt(r.priority)}</td></tr>`,
        )
        .join("")}</tbody></table>`,
    },
    {
      title: "Read the result",
      body: sameSet
        ? `<p>On this handbook MMR ends up with the <strong>same sentences</strong> as plain lexical ranking, picked in a different order. The handbook has little repetition, so there’s little to penalize.</p><p>MMR earns its keep when retrieved passages repeat each other, such as five chunks of the same FAQ.</p>`
        : `<p>MMR keeps a different set of sentences from plain lexical ranking, trading some relevance for variety.</p>`,
      visual: `${docMap(sentenceCoverage(source, m.result))}${verdict(m.facts)}`,
    },
  ];
}

function wordSteps(): Step[] {
  const w = wordWalkthrough();
  return [
    {
      title: "Treat every word as a unit",
      body: `<p>Instead of whole sentences, word deletion scores each of the handbook’s <strong>${w.totalWords} words</strong> on its own. That allows much finer cuts: it can keep half a sentence.</p>`,
      visual: `<p class="big-number">${w.totalWords}<small>words, each scored on its own</small></p>`,
    },
    {
      title: "Keep only words that match the question",
      body: `<p>A word scores above zero only if it’s one of the question’s search terms. Every other word is dropped, including small ones like “not” that flip the meaning.</p><p>Here is the exception sentence, word by word:</p>`,
      visual: `<div class="word-flow">${w.inQuote
        .map(
          (x) =>
            `<span class="word ${x.kept ? "kept" : "dropped"}${x.word === "not" ? " flagged" : ""}">${esc(x.word)}</span>`,
        )
        .join(
          "",
        )}</div><p class="visual-note">“not” is a filler word to the scorer, so “is <s>not</s> refundable” becomes “refundable”.</p>`,
    },
    {
      title: "Read the result",
      body: `<p>The budget allowed ${w.result.budget} tokens, but only <strong>${w.result.compressedTokens}</strong> are used. Word deletion drops every non-matching word even when there’s room to spare. A bigger budget doesn’t help.</p><p>This is what the answering model would receive:</p>`,
      visual: `<pre class="kept-text">${esc(w.result.text.trim())}</pre>${meter(w.result.compressedTokens, w.result.budget, w.result.originalTokens)}${verdict(w.facts)}`,
    },
  ];
}

function truncationSteps(): Step[] {
  const t = truncationWalkthrough();
  return [
    {
      title: "Ignore the question",
      body: `<p>Truncation is the baseline every other method should beat. It doesn’t read the question at all; it keeps the beginning of the document.</p>`,
      visual: `<p class="q-original muted"><s>“${esc(question)}”</s></p><p class="visual-note">Not used.</p>`,
    },
    {
      title: `Keep the first ${t.result.budget} tokens`,
      body: `<p>The lab finds the longest start of the handbook that fits in ${t.result.budget} tokens. The cut can land anywhere, even mid-word. Here it falls inside the refund policy’s heading:</p>`,
      visual: `<pre class="kept-text cut-end">…${esc(t.tail.replace(/^\S*\s/, ""))}<span class="cut-mark" aria-label="cut here">✂</span></pre>${docMap(sentenceCoverage(source, t.result))}`,
    },
    {
      title: "Read the result",
      body: `<p>Sections near the top survive, and everything after the cut is gone, whatever it says. The refund policy is the third section, so neither fact is reached.</p>`,
      visual: `<ul class="section-states">${t.sections
        .map(
          (s) =>
            `<li class="${s.state}"><span>${s.state === "kept" ? "kept" : s.state === "cut" ? "cut off" : "dropped"}</span>${esc(s.title)}</li>`,
        )
        .join("")}</ul>${verdict(t.facts)}`,
    },
  ];
}

function demoCompare(
  beforeLabel: string,
  before: FactCheck[],
  afterLabel: string,
  after: FactCheck[],
  note: string,
) {
  const row = (label: string, facts: FactCheck[]) =>
    `<div class="demo-row"><span class="demo-label">${label}</span>${facts.map((f) => `<span class="chip ${f.kept ? "kept" : "lost"}">${f.kept ? "✓" : "✕"} ${esc(f.label.replace(/^The /, ""))}</span>`).join("")}</div>`;
  return `${row(beforeLabel, before)}${row(afterLabel, after)}<p>${note}</p>`;
}

const chapters: Chapter[] = [
  {
    method: "relevance",
    name: "Lexical relevance",
    idea: "Keep the sentences that share the most rare words with the question.",
    steps: lexicalSteps,
    goodAt:
      "Fast, free and fully explainable. Strong when the question and the document use the same words: product names, IDs, error codes.",
    breaksWhen:
      "The question uses different words than the document. “Money back” never matches “refund”.",
    seenIn:
      "Keyword (BM25-style) filters in RAG pipelines, and trimming logs or tool output before they reach a model.",
    demoLabel: "Ask the same thing in other words",
    demo: () => {
      const before = lexicalWalkthrough();
      const after = lexicalWalkthrough({ query: breakingCases.synonym });
      return `<p class="q-original">“${esc(breakingCases.synonym)}”</p>${demoCompare("Original question", before.facts, "Reworded", after.facts, `The reworded question’s terms are <strong>${after.question.terms.map(esc).join(", ")}</strong>. None of them appear in the general rule, so it scores 0 and is dropped. Same intent, different words, different context. Semantic methods like BGE (below) are built for this.`)}`;
    },
    demoLab: { method: "relevance", remove: 60, query: breakingCases.synonym },
  },
  {
    method: "mmr",
    name: "MMR · reduce repetition",
    idea: "Like lexical relevance, but each pick is penalized for repeating what’s already kept.",
    steps: mmrSteps,
    goodAt:
      "Removing near-duplicates so a small budget covers more ground. Useful when retrieved chunks overlap.",
    breaksWhen:
      "Two facts you need look alike. The second one is treated as a repeat and pushed out.",
    seenIn:
      "The “max marginal relevance” search option offered by many vector stores and RAG frameworks.",
    demoLabel: "Penalize repetition harder at a tight budget",
    demo: () => {
      const { diversity, remove } = breakingCases.mmr;
      const lex = lexicalWalkthrough({ remove });
      const m = mmrWalkthrough({ diversity, remove });
      const ruleStart = factStart[0];
      const rule = m.rounds.find((r) => r.unit.start <= ruleStart && r.unit.end > ruleStart);
      const why =
        rule && rule.similarTo
          ? ` When the general rule’s turn came, it overlapped ${Math.round(rule.similarity * 100)}% with an already kept sentence (“${esc(short(rule.similarTo.text, 60))}”), so its priority fell and the budget ran out first.`
          : "";
      return demoCompare(
        `Lexical, ${remove}% cut`,
        lex.facts,
        `MMR λ ${diversity}, ${remove}% cut`,
        m.facts,
        `With only ${m.result.budget} tokens and a stronger penalty, MMR drops the general rule. It shares “annual”, “subscription” and “refund” with the exception.${why}`,
      );
    },
    demoLab: { method: "mmr", remove: 85, diversity: 0.5 },
  },
  {
    method: "words",
    name: "Word deletion",
    idea: "Score every word on its own and keep only the ones that match the question.",
    steps: wordSteps,
    goodAt:
      "Very high compression. Names and numbers that match the question survive even when their sentence doesn’t.",
    breaksWhen:
      "Meaning depends on small words: not, only, except, before. Grammar falls apart, and the model has to guess.",
    seenIn:
      "The starting idea behind learned token-deletion compressors such as LLMLingua-2, which learn which small words matter.",
    demoLabel: "Give it nine times more room",
    demo: () => {
      const before = wordWalkthrough();
      const after = wordWalkthrough({ remove: 10 });
      return `${demoCompare(`${before.result.budget}-token budget`, before.facts, `${after.result.budget}-token budget`, after.facts, `With room for ${after.result.budget} tokens it still uses only ${after.result.compressedTokens}. The budget was never the problem. The rule “keep only matching words” throws away everything else, however much space is left.`)}`;
    },
    demoLab: { method: "words", remove: 10 },
  },
  {
    method: "truncate",
    name: "Prefix truncation",
    idea: "Keep the start of the document until the budget runs out.",
    steps: truncationSteps,
    goodAt:
      "Zero cost, nothing reordered or rewritten. Fine when the important part always comes first.",
    breaksWhen: "The answer sits after the cutoff. Position decides, not relevance.",
    seenIn:
      "The default fallback when text exceeds an input limit; many systems silently cut long inputs this way.",
    demoLabel: "Find how much it needs",
    demo: () => {
      const needed = [...Array(20).keys()]
        .map((i) => 95 - i * 5)
        .find((remove) => truncationWalkthrough({ remove }).facts.every((f) => f.kept));
      const lexNeeded = [...Array(20).keys()]
        .map((i) => 95 - i * 5)
        .find((remove) => lexicalWalkthrough({ remove }).facts.every((f) => f.kept));
      const keep = (cut: number | undefined) => (cut === undefined ? "—" : `${100 - cut}%`);
      return `<p>The smallest share of the handbook each method must keep so that both facts survive:</p><div class="need-grid"><div><span>Prefix truncation</span><strong>${keep(needed)}</strong><small>Everything up to the end of the refund section</small></div><div><span>Lexical relevance</span><strong>${keep(lexNeeded)}</strong><small>Only the sentences that match the question</small></div></div><p>Truncation pays for every section that happens to come first. A method that reads the question skips them.</p>`;
    },
    demoLab: { method: "truncate", remove: 60 },
  },
];

const names: Record<TourMethod, string> = {
  relevance: "Lexical relevance",
  mmr: "MMR",
  words: "Word deletion",
  truncate: "Prefix truncation",
};

function compareResults(remove: number) {
  const rows = compareAllCache(remove);
  const needed = Object.fromEntries(
    tourMethods.map((method) => [
      method,
      [...Array(20).keys()]
        .map((i) => 95 - i * 5)
        .find((r) =>
          compareAllCache(r)
            .find((x) => x.method === method)!
            .facts.every((f) => f.kept),
        ),
    ]),
  );
  return `<div class="compare-grid">${rows
    .map((row) => {
      const all = row.facts.every((f) => f.kept);
      return `<article class="compare-card ${all ? "good" : "bad"}"><h4>${names[row.method]}</h4><p class="compare-tokens"><strong>${row.result.compressedTokens}</strong> / ${row.result.budget} tokens</p>${docMap(row.coverage)}<ul class="compare-facts">${row.facts.map((f) => `<li class="${f.kept ? "kept" : "lost"}">${f.kept ? "✓" : "✕"} ${esc(f.label.replace(/^The /, ""))}</li>`).join("")}</ul><p class="compare-need">${!needed[row.method] ? "Loses a fact at every cut" : `Needs ${100 - needed[row.method]!}% of the handbook to keep both`}</p></article>`;
    })
    .join("")}</div>`;
}
const compareControls = (remove: number) =>
  `<div class="compare-controls"><label for="tour-remove">Remove <output id="tour-remove-value">${remove}%</output> of the handbook</label><input id="tour-remove" type="range" min="0" max="95" step="5" value="${remove}"><div class="range-ends"><span>Keep everything</span><span>Keep 5%</span></div></div><div id="compare-results" aria-live="polite">${compareResults(remove)}</div><p class="visual-note">Same handbook, question and budget for all four. Drag the slider to see which technique loses the facts first. Each bar is a sentence; the fill shows how much of it survived.</p>`;
const compareCache = new Map<number, ReturnType<typeof compareAll>>();
function compareAllCache(remove: number) {
  if (!compareCache.has(remove)) compareCache.set(remove, compareAll(remove));
  return compareCache.get(remove)!;
}

// ---------- Mounting ----------

export function initTour(root: HTMLElement, openInLab: (request: LabRequest) => void) {
  let active: TourMethod | "compare" = "relevance";
  let step = 0;
  let compareRemove = tourExample.remove;
  const stepCache = new Map<TourMethod, Step[]>();
  const stepsFor = (c: Chapter) => {
    if (!stepCache.has(c.method)) stepCache.set(c.method, c.steps());
    return stepCache.get(c.method)!;
  };

  root.innerHTML = `<div class="tour-tabs" role="tablist" aria-label="Techniques">${chapters
    .map(
      (c, i) =>
        `<button type="button" role="tab" id="tour-tab-${c.method}" data-tour="${c.method}" aria-controls="tour-panel"><span class="tab-number">0${i + 1}</span><span>${esc(c.name)}</span></button>`,
    )
    .join(
      "",
    )}<button type="button" role="tab" id="tour-tab-compare" data-tour="compare" aria-controls="tour-panel"><span class="tab-number">▸</span><span>Compare all four</span></button></div><div id="tour-panel" class="tour-panel" role="tabpanel"></div>`;
  const panel = root.querySelector<HTMLElement>("#tour-panel")!;

  function renderTabs() {
    root.querySelectorAll<HTMLButtonElement>("[data-tour]").forEach((b) => {
      const selected = b.dataset.tour === active;
      b.setAttribute("aria-selected", String(selected));
      b.tabIndex = selected ? 0 : -1;
    });
    panel.setAttribute("aria-labelledby", `tour-tab-${active}`);
  }

  function renderChapter() {
    const chapter = chapters.find((c) => c.method === active)!;
    const index = chapters.indexOf(chapter);
    const steps = stepsFor(chapter);
    const current = steps[step];
    panel.innerHTML = `<header class="chapter-head"><p class="eyebrow">Technique 0${index + 1} of 04</p><h3>${esc(chapter.name)}</h3><p class="chapter-idea">${esc(chapter.idea)}</p></header><div class="chapter-body"><ol class="step-rail" aria-label="Steps">${steps
      .map(
        (s, i) =>
          `<li><button type="button" data-step="${i}" ${i === step ? 'aria-current="step"' : ""} class="${i < step ? "done" : ""}"><span class="step-num">${i + 1}</span><span>${esc(s.title)}</span></button></li>`,
      )
      .join(
        "",
      )}</ol><div class="step-view" aria-live="polite"><div class="step-text"><p class="step-count">Step ${step + 1} of ${steps.length}</p><h4>${esc(current.title)}</h4>${current.body}<div class="step-nav"><button type="button" data-move="-1" ${step === 0 ? "disabled" : ""}>← Back</button><button type="button" data-move="1" class="primary">${step === steps.length - 1 ? (index < chapters.length - 1 ? `Next technique: ${esc(chapters[index + 1].name)} →` : "Compare all four →") : "Next step →"}</button></div></div><div class="step-visual">${current.visual}</div></div></div><div class="chapter-facts"><div><h5>Good at</h5><p>${esc(chapter.goodAt)}</p></div><div><h5>Breaks when</h5><p>${esc(chapter.breaksWhen)}</p></div><div><h5>Where you’ll meet it</h5><p>${esc(chapter.seenIn)}</p></div></div><details class="demo"><summary><span>See it break</span>${esc(chapter.demoLabel)} <span aria-hidden="true">+</span></summary><div class="demo-body">${chapter.demo()}<button type="button" class="text-button" data-lab="demo">Open this case in the lab ↓</button></div></details><div class="chapter-foot"><button type="button" class="text-button" data-lab="chapter">Try ${esc(chapter.name)} on your own settings in the lab ↓</button></div>`;
  }

  function renderCompare() {
    panel.innerHTML = `<header class="chapter-head"><p class="eyebrow">Side by side</p><h3>Compare all four</h3><p class="chapter-idea">One budget, four techniques, the same two facts to keep.</p></header>${compareControls(compareRemove)}`;
  }

  function render() {
    renderTabs();
    if (active === "compare") renderCompare();
    else renderChapter();
  }

  root.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>(
      "[data-tour],[data-step],[data-move],[data-lab]",
    );
    if (!target) return;
    if (target.dataset.tour) {
      active = target.dataset.tour as TourMethod | "compare";
      step = 0;
      render();
      return;
    }
    if (target.dataset.step) {
      step = Number(target.dataset.step);
      render();
      return;
    }
    if (target.dataset.move) {
      const chapter = chapters.find((c) => c.method === active)!;
      const next = step + Number(target.dataset.move);
      if (next >= stepsFor(chapter).length) {
        const i = chapters.indexOf(chapter);
        active = i < chapters.length - 1 ? chapters[i + 1].method : "compare";
        step = 0;
        render();
        root.querySelector<HTMLElement>(`#tour-tab-${active}`)?.focus({ preventScroll: true });
      } else {
        step = Math.max(0, next);
        render();
      }
      return;
    }
    if (target.dataset.lab) {
      const chapter = chapters.find((c) => c.method === active)!;
      openInLab(
        target.dataset.lab === "demo"
          ? chapter.demoLab
          : { method: chapter.method, remove: tourExample.remove },
      );
    }
  });
  root.addEventListener("keydown", (event) => {
    const tab = (event.target as HTMLElement).closest<HTMLElement>("[role=tab]");
    if (!tab || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    const tabs = [...root.querySelectorAll<HTMLElement>("[role=tab]")];
    const next =
      tabs[(tabs.indexOf(tab) + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
    next.click();
    next.focus();
  });
  root.addEventListener("input", (event) => {
    const target = event.target as HTMLInputElement;
    if (target.id !== "tour-remove") return;
    compareRemove = Number(target.value);
    root.querySelector("#tour-remove-value")!.textContent = `${compareRemove}%`;
    root.querySelector("#compare-results")!.innerHTML = compareResults(compareRemove);
  });
  render();
}
