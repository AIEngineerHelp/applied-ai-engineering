// Builds the recorded run from the corpus: the raw sources, the pages the scripted agent writes at
// each step, and everything code derives from them (diffs, index, log, graph, lint, retrieval).
// Node only. The browser loads the result from results/run.json.

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { diffStats, lineDiff, type DiffLine } from "./diff.ts";
import { forceLayout, type Layout } from "./layout.ts";
import { lint, type LintResult } from "./lint.ts";
import { QUESTIONS } from "./questions.ts";
import { resolveAll, type Fact, type RankTier, type Resolution } from "./resolve.ts";
import { chunkSources, checkFacts, retrieveChunks, retrievePages, type FactResult, type RawSource } from "./retrieve.ts";
import { applyEdits, buildGraph, buildIndex, currentLines, formatLog, type Claim, type Graph, type LogEntry, type PageType, type Wiki } from "./wiki.ts";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CORPUS = join(ROOT, "corpus");

export interface Change {
  slug: string;
  path: string;
  type: PageType;
  status: "created" | "updated";
  added: number;
  removed: number;
  diff: DiffLine[];
}

/**
 * Which source passages drive which edits. Each quote is verbatim text from the step's raw source;
 * each anchor is a substring of a changed line on `page`. Written by hand with the pages.
 */
export interface SourceLink {
  page: string;
  quotes: string[];
  anchors: string[];
}

export interface Step {
  n: number;
  kind: "ingest" | "lint";
  date: string;
  title: string;
  /** The page the app opens first for this step: the most instructive change. */
  focus: string;
  /** One short sentence for the app's subtitle. */
  caption: string;
  links?: SourceLink[];
  /** For the walkthrough: the page to show, a one-sentence lede, the source sentences that matter
   * (verbatim), and what the agent did, in plain words. Written by hand. */
  show: string;
  lede: string;
  key: string[];
  did: string[];
  source?: string;
  verdict: string;
  lesson: string;
  changes: Change[];
  pages: { slug: string; path: string; type: PageType; title: string; text: string }[];
  index: string;
  log: string;
  graph: Graph;
  claims: { current: number; superseded: number; disputed: number };
}

export interface QuestionResult {
  id: string;
  text: string;
  wikiAnswer: string;
  wiki: { slug: string; path: string; score: number; lines: { text: string; struck: boolean }[] }[];
  rag: { id: string; file: string; date: string; heading: string; text: string; score: number }[];
  wikiFacts: FactResult[];
  ragFacts: FactResult[];
}

export interface Conflicts {
  ranking: RankTier[];
  keys: Record<string, { label: string; scopes: string[] }>;
  facts: Fact[];
  results: Resolution[];
  /** Two extra synthetic sources, used only by the conflict example (not by the walkthrough). */
  reviewSources: { file: string; title: string; date: string; text: string }[];
}

export function loadConflicts(): Conflicts {
  const data = JSON.parse(readFileSync(join(CORPUS, "conflicts.json"), "utf8")) as Omit<Conflicts, "results" | "reviewSources">;
  const dir = join(CORPUS, "review");
  const reviewSources = readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((file) => {
      const text = readFileSync(join(dir, file), "utf8");
      return { file, date: file.slice(0, 10), title: /^# (.+)$/m.exec(text)?.[1] ?? file, text };
    });
  return { ...data, results: resolveAll(data.facts, data.ranking, data.keys), reviewSources };
}

export interface Run {
  note: string;
  schema: string;
  sources: RawSource[];
  chunkCount: number;
  steps: Step[];
  lintBefore: LintResult;
  lintAfter: LintResult;
  layout: Layout;
  questions: QuestionResult[];
  k: { chunks: number; pages: number };
  conflicts: Conflicts;
}

export const K_CHUNKS = 3;
export const K_PAGES = 2;

export function loadSources(): RawSource[] {
  const dir = join(CORPUS, "raw");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((file) => {
      const text = readFileSync(join(dir, file), "utf8");
      return { file, date: file.slice(0, 10), title: /^# (.+)$/m.exec(text)?.[1] ?? file, text };
    });
}

interface StepFiles {
  meta: { kind: "ingest" | "lint"; date: string; title: string; focus: string; caption: string; source?: string; verdict: string; lesson: string; links?: SourceLink[]; show: string; lede: string; key: string[]; did: string[] };
  files: { slug: string; text: string }[];
}

export function loadSteps(): StepFiles[] {
  const dir = join(CORPUS, "steps");
  return readdirSync(dir)
    .filter((d) => /^\d\d-/.test(d))
    .sort()
    .map((d) => ({
      meta: JSON.parse(readFileSync(join(dir, d, "step.json"), "utf8")),
      files: readdirSync(join(dir, d))
        .filter((f) => f.endsWith(".md"))
        .sort()
        .map((f) => ({ slug: f.replace(/\.md$/, ""), text: readFileSync(join(dir, d, f), "utf8") })),
    }));
}

/** Plays every step and returns the wiki after each one (index 0 is the empty wiki). */
export function playSteps(steps: StepFiles[]): Wiki[] {
  const states: Wiki[] = [new Map()];
  for (const s of steps) states.push(applyEdits(states[states.length - 1], s.files));
  return states;
}

const countClaims = (wiki: Wiki) => {
  const all: Claim[] = [...wiki.values()].flatMap((p) => p.claims);
  return {
    current: all.filter((c) => c.status === "current").length,
    superseded: all.filter((c) => c.status === "superseded").length,
    disputed: all.filter((c) => c.status === "disputed").length,
  };
};

export function buildRun(): Run {
  const sources = loadSources();
  const stepFiles = loadSteps();
  const states = playSteps(stepFiles);
  const log: LogEntry[] = [];
  const lintBefore = lint(states[stepFiles.findIndex((s) => s.meta.kind === "lint")]);

  const steps: Step[] = stepFiles.map((s, i) => {
    const before = states[i];
    const after = states[i + 1];
    const changes: Change[] = s.files.map((f) => {
      const page = after.get(f.slug)!;
      const old = before.get(f.slug);
      const diff = lineDiff(old?.text ?? "", page.text);
      return { slug: f.slug, path: page.path, type: page.type, status: old ? "updated" : "created", ...diffStats(diff), diff };
    });
    // Created pages first, then updates; each group in wiki order.
    changes.sort((a, b) => (a.status === b.status ? 0 : a.status === "created" ? -1 : 1));

    const created = changes.filter((c) => c.status === "created").map((c) => `[[${c.slug}]]`);
    const updated = changes.filter((c) => c.status === "updated").map((c) => `[[${c.slug}]]`);
    const lines = [
      ...(s.meta.source ? [`- source: raw/${s.meta.source}`] : []),
      ...(s.meta.kind === "lint"
        ? lintBefore.checks.filter((c) => c.count > 0).map((c) => `- found: ${c.count} × ${c.label.toLowerCase()}`)
        : []),
      ...(created.length ? [`- created: ${created.join(", ")}`] : []),
      ...(updated.length ? [`- updated: ${updated.join(", ")}`] : []),
    ];
    log.push({ date: s.meta.date, kind: s.meta.kind, title: s.meta.title, lines });

    return {
      n: i + 1,
      ...s.meta,
      changes,
      pages: [...after.values()].map((p) => ({ slug: p.slug, path: p.path, type: p.type, title: p.title, text: p.text })),
      index: buildIndex(after),
      log: formatLog(log),
      graph: buildGraph(after),
      claims: countClaims(after),
    };
  });

  const final = states[states.length - 1];
  const chunks = chunkSources(sources);
  const questions: QuestionResult[] = QUESTIONS.map((q) => {
    const pages = retrievePages(final, q.text, K_PAGES);
    const hits = retrieveChunks(chunks, q.text, K_CHUNKS);
    return {
      id: q.id,
      text: q.text,
      wikiAnswer: q.wikiAnswer,
      wiki: pages.map(({ item, score }) => ({
        slug: item.slug,
        path: item.path,
        score,
        lines: item.text
          .replace(/^---\n[\s\S]*?\n---\n/, "")
          .split("\n")
          .filter((l) => l.trim() !== "")
          .map((text) => ({ text, struck: /^- ~~/.test(text) })),
      })),
      rag: hits.map(({ item, score }) => ({ ...item, score })),
      wikiFacts: checkFacts(q.facts, pages.map(({ item }) => ({ id: item.slug, text: currentLines(item).join("\n") }))),
      ragFacts: checkFacts(q.facts, hits.map(({ item }) => ({ id: item.id, text: item.text }))),
    };
  });

  return {
    note:
      "Generated by `npm run data` from corpus/. Pages and step notes are scripted by hand; diffs, index, log, graph, lint and retrieval are computed by code.",
    schema: readFileSync(join(CORPUS, "schema.md"), "utf8"),
    sources,
    chunkCount: chunks.length,
    steps,
    lintBefore,
    lintAfter: lint(final),
    layout: forceLayout(buildGraph(final)),
    questions,
    k: { chunks: K_CHUNKS, pages: K_PAGES },
    conflicts: loadConflicts(),
  };
}

/** The final wiki as files, for results/wiki/: every page plus index.md and log.md. */
export function finalWikiFiles(run: Run): { path: string; text: string }[] {
  const last = run.steps[run.steps.length - 1];
  return [
    ...last.pages.map((p) => ({ path: p.path, text: p.text })),
    { path: "index.md", text: last.index },
    { path: "log.md", text: last.log },
  ];
}
