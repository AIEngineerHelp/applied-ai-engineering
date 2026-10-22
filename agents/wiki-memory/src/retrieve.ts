// Retrieval for the comparison in step 3. The same BM25 scorer ranks two different things:
// chunks of the raw sources (plain chunk RAG) and pages of the finished wiki (a stand-in for an
// agent reading index.md and opening the most relevant pages). Nothing here calls a model.

import { currentLines, type Page, type Wiki } from "./wiki.ts";

export interface RawSource {
  file: string;
  title: string;
  date: string;
  text: string;
}

export interface Chunk {
  id: string;
  file: string;
  /** The source document's title. Prefixed to the chunk when ranking, a common chunking practice. */
  title: string;
  date: string;
  heading: string;
  text: string;
}

const STOPWORDS = new Set(
  "a an and are as at be by can do does for from has have how i if in is it its many much of on or our so that the their them then there these they this to was we were what when where which who why will with you your".split(" "),
);

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((t) => !STOPWORDS.has(t))
    .map((t) => (t.length > 3 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t));
}

/**
 * Splits each source into blocks separated by blank lines. A heading is joined to the block after it,
 * and the document title is dropped (it is shown as metadata). This is ordinary paragraph-level chunking.
 */
export function chunkSources(sources: RawSource[]): Chunk[] {
  const chunks: Chunk[] = [];
  for (const s of sources) {
    const blocks = s.text.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
    let heading = "";
    let n = 0;
    for (const block of blocks) {
      if (/^# /.test(block)) continue;
      if (/^## /.test(block) && !block.includes("\n")) {
        heading = block.replace(/^## /, "");
        continue;
      }
      n += 1;
      chunks.push({ id: `${s.file}#${n}`, file: s.file, title: s.title, date: s.date, heading, text: block });
    }
  }
  return chunks;
}

export interface Scored<T> {
  item: T;
  score: number;
}

/** Okapi BM25 with the usual defaults (k1 = 1.2, b = 0.75). Ties keep the input order. */
export function bm25<T>(items: T[], textOf: (item: T) => string, query: string, k1 = 1.2, b = 0.75): Scored<T>[] {
  const docs = items.map((item) => tokenize(textOf(item)));
  const avg = docs.reduce((n, d) => n + d.length, 0) / Math.max(docs.length, 1);
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const terms = [...new Set(tokenize(query))];
  return items
    .map((item, i) => {
      const d = docs[i];
      let score = 0;
      for (const t of terms) {
        const tf = d.filter((x) => x === t).length;
        if (tf === 0) continue;
        const n = df.get(t) ?? 0;
        const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
        score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * d.length) / avg)));
      }
      return { item, score: Math.round(score * 1000) / 1000, i };
    })
    .sort((x, y) => y.score - x.score || x.i - y.i)
    .map(({ item, score }) => ({ item, score }));
}

/** The text a page is ranked on: its index line (title and summary) and its current lines. */
export function pageSearchText(page: Page): string {
  return [page.title, page.summary, ...currentLines(page)].join("\n");
}

export function retrieveChunks(chunks: Chunk[], query: string, k: number): Scored<Chunk>[] {
  return bm25(chunks, (c) => `${c.title}\n${c.heading}\n${c.text}`, query).slice(0, k);
}

/**
 * Ranks the wiki's topic pages: entities, concepts and the overview. Source pages are left out because
 * they record what one source said; the topic pages hold the reconciled, current version.
 */
export function retrievePages(wiki: Wiki, query: string, k: number): Scored<Page>[] {
  const topics = [...wiki.values()].filter((p) => p.type !== "source");
  return bm25(topics, pageSearchText, query).slice(0, k);
}

export interface FactCheck {
  label: string;
  /** "needed": the answer needs it. "wrong": it states an outdated or incorrect value as current. */
  kind: "needed" | "wrong";
  pattern: RegExp;
  why?: string;
}

export interface FactResult {
  label: string;
  kind: FactCheck["kind"];
  why?: string;
  /** The pattern's source, so the app can highlight the matching text. Always case-insensitive. */
  pattern: string;
  found: boolean;
  /** Where it was found: chunk ids or page slugs. */
  where: string[];
}

/** Looks for each fact in each retrieved text. Texts are passed in already filtered (see currentLines). */
export function checkFacts(facts: FactCheck[], texts: { id: string; text: string }[]): FactResult[] {
  return facts.map((f) => {
    const where = texts.filter((t) => f.pattern.test(t.text.replace(/\s+/g, " "))).map((t) => t.id);
    return { label: f.label, kind: f.kind, why: f.why, pattern: f.pattern.source, found: where.length > 0, where };
  });
}
