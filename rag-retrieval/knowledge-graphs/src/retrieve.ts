// The chunk-retrieval baseline: one chunk per paragraph, with the document
// title attached, ranked by TF-IDF cosine similarity to the question.
//
// TF-IDF is a stand-in for an embedding model so the comparison runs offline
// and gives the same answer every time. Embeddings also match synonyms
// ("upload" ~ "sends readings"), which TF-IDF does not; that helps with
// wording, but not with the failure this example is about: a chunk that
// shares no subject with the question (an org chart, for a question about a
// customer) is far from the question in any similarity space.

export interface Doc {
  id: string;
  title: string;
  kind: string;
  paragraphs: string[];
}

export interface Chunk {
  id: string; // "customers#2"
  document: string;
  title: string;
  index: number; // 1-based paragraph number
  text: string; // the paragraph
}

export const docText = (d: Doc) => d.paragraphs.join("\n\n");

export function chunkDocuments(docs: Doc[]): Chunk[] {
  return docs.flatMap((d) =>
    d.paragraphs.map((text, i) => ({ id: `${d.id}#${i + 1}`, document: d.id, title: d.title, index: i + 1, text })),
  );
}

const STOP = new Set(
  "a an and are as at be because by can could did do does for from has have how i if in into is it its of on or our should so that the their them then there these they this to us was we were what when which who why will with would".split(
    " ",
  ),
);

/** Light suffix stripping so "readings" matches "reading" and "supplies" matches "supply". */
export function stem(w: string): string {
  if (w.length <= 3 || /^\d/.test(w)) return w;
  if (w.endsWith("ies") && w.length > 4) return `${w.slice(0, -3)}y`;
  if (w.endsWith("ing") && w.length > 5) return w.slice(0, -3);
  if (w.endsWith("ed") && w.length > 4) return w.slice(0, -2);
  if (/(ss|us)$/.test(w)) return w;
  if (/(ch|sh|x)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith("s")) return w.slice(0, -1);
  return w;
}

export const terms = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && !STOP.has(w))
    .map(stem);

export interface Hit {
  chunk: Chunk;
  score: number;
}

export class TfIdfIndex {
  private vectors: Map<string, number>[];
  private idf = new Map<string, number>();

  constructor(readonly chunks: Chunk[]) {
    const docs = chunks.map((c) => terms(`${c.title}\n${c.text}`));
    const df = new Map<string, number>();
    for (const t of docs) for (const w of new Set(t)) df.set(w, (df.get(w) ?? 0) + 1);
    const n = chunks.length;
    for (const [w, f] of df) this.idf.set(w, Math.log((n + 1) / (f + 1)) + 1);
    this.vectors = docs.map((t) => this.vector(t));
  }

  private vector(t: string[]): Map<string, number> {
    const tf = new Map<string, number>();
    for (const w of t) tf.set(w, (tf.get(w) ?? 0) + 1);
    const v = new Map<string, number>();
    for (const [w, f] of tf) {
      const idf = this.idf.get(w);
      if (idf) v.set(w, (1 + Math.log(f)) * idf);
    }
    const norm = Math.hypot(...v.values()) || 1;
    for (const [w, x] of v) v.set(w, x / norm);
    return v;
  }

  /** Top-k chunks by cosine similarity. Ties keep corpus order. */
  search(query: string, k = 3): Hit[] {
    const q = this.vector(terms(query));
    return this.chunks
      .map((chunk, i) => {
        let score = 0;
        for (const [w, x] of q) score += x * (this.vectors[i].get(w) ?? 0);
        return { chunk, score, i };
      })
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .slice(0, k)
      .map(({ chunk, score }) => ({ chunk, score: Math.round(score * 1000) / 1000 }));
  }
}
