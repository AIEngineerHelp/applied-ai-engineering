// The plain-language parts of the page that don't move: the problem (what plain retrieval returns
// for one question) and the payoff (the same question answered from one wiki page).

import runJson from "../results/run.json" with { type: "json" };
import type { QuestionResult, Run } from "../src/build.ts";
import type { FactResult } from "../src/retrieve.ts";
import { inline, trackedBlocks } from "./doc.ts";
import { esc } from "./render.ts";

const RUN = runJson as unknown as Run;
const FIX = RUN.steps.find((s) => s.kind === "lint")!;
const QUESTION = RUN.questions.find((q) => q.id === "retention")!;
const $ = (id: string) => document.getElementById(id)!;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const longDate = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
};
const titleOf = (file: string) => RUN.sources.find((s) => s.file === file)!;

// ---------------------------------------------------------------- 1. the problem

/** Inline markdown with every "N days" marked, so the conflicting numbers stand out. */
function withDays(text: string): string {
  return inline(text).replace(/\b(\d+) days\b/g, '<span class="num">$1 days</span>');
}

/** The lines of a retrieved chunk that state an answer (or the first line if none do). */
function answerLines(text: string, facts: FactResult[]): string[] {
  const lines = text.split("\n").filter((l) => l.trim());
  const hit = lines.filter((l) => facts.some((f) => new RegExp(f.pattern, "i").test(l)) || /\b\d+ days\b/.test(l));
  return (hit.length ? hit : lines.slice(0, 1)).map((l) => l.replace(/^- /, "").replace(/^\*\*[^*]+\*\*\s*/, ""));
}

function hitsHtml(q: QuestionResult, compact = false): string {
  return q.rag
    .map((c, i) => {
      const src = titleOf(c.file);
      const lines = answerLines(c.text, q.ragFacts);
      const when = src.title.includes(String(src.date.slice(0, 4))) ? "" : ` · ${longDate(src.date)}`;
      // In the payoff, say which passages are outdated (computed fact checks); at the start, don't.
      const wrong = compact ? q.ragFacts.filter((f) => f.kind === "wrong" && f.where.includes(c.id)) : [];
      return `<div class="hit" data-outdated="${wrong.length > 0}"><div class="hit-src"><span>${esc(src.title)}${when}</span>${compact ? "" : `<span>match ${i + 1}</span>`}</div>
        <div class="hit-text">${lines.map(withDays).join(" ")}</div>${wrong.length ? `<p class="hit-note">Outdated: ${wrong.map((w) => esc(w.why ?? "")).join("; ")}.</p>` : ""}</div>`;
    })
    .join("");
}

export function renderProblem() {
  $("q-text").textContent = QUESTION.text;
  $("problem-hits").innerHTML = hitsHtml(QUESTION);
}

// ---------------------------------------------------------------- 4. the payoff

export function renderPayoff() {
  const q = QUESTION;
  const page = FIX.pages.find((p) => p.slug === "export-retention")!;
  const claims = trackedBlocks(page.text.split("\n").map((text) => ({ op: "same" as const, text }))).filter((b) => b.kind === "claim");
  const tally = (facts: FactResult[]) => {
    const need = facts.filter((f) => f.kind === "needed");
    const bad = facts.filter((f) => f.kind === "wrong" && f.found).length;
    return `<p class="tally"><b>${need.filter((f) => f.found).length} of ${need.length}</b> facts the answer needs · <b class="${bad ? "bad" : "good"}">${plural(bad, "outdated statement")}</b> <span class="caption">(computed)</span></p>`;
  };
  $("payoff-body").innerHTML = `<div class="side">
      <h3 class="side-name">Wiki memory</h3>
      <p class="caption mt-1">The agent reads the index and opens one page, <code>export-retention</code>.</p>
      <p class="answer">${esc(q.wikiAnswer.replace(/ Sources:.*$/, ""))}</p>
      <div class="page">${claims.map((b) => `<div class="b-claim">${b.html}</div>`).join("")}</div>
      ${tally(q.wikiFacts)}
      <p class="caption">The answer is written by hand from the page; the page and the fact check are computed.</p>
    </div>
    <div class="side">
      <h3 class="side-name">Plain retrieval</h3>
      <p class="caption mt-1">The same three passages as at the start.</p>
      <div class="hits">${hitsHtml(q, true)}</div>
      ${tally(q.ragFacts)}
    </div>`;
  $("more-questions").innerHTML = RUN.questions
    .filter((x) => x.id !== q.id)
    .map((x) => {
      const ragBad = x.ragFacts.filter((f) => f.kind === "wrong" && f.found).length;
      const verdict = ragBad
        ? `Both find the answer, but plain retrieval also returns ${plural(ragBad, "outdated statement")}: the March design doc's 100 and 80 requests per second.`
        : "A draw: the whole answer sits in one document that nothing contradicts, so plain retrieval does as well as the wiki.";
      return `<div class="mq"><p class="sub !text-[17px] !text-[var(--ink)]">${esc(x.text)}</p><p>${esc(verdict)}</p><p class="caption">Wiki: ${esc(x.wikiAnswer.replace(/ Sources:.*$/, ""))}</p></div>`;
    })
    .join("");
}

