// The corpus: 25 short markdown documents with a small front matter block.
// Paragraphs are the chunks for retrieval; quotes must appear verbatim in `text`.

export interface Doc {
  id: string;
  title: string;
  kind: string;
  date: string; // YYYY-MM-DD
  paragraphs: string[];
  text: string; // paragraphs joined by blank lines
}

export function parseDoc(raw: string): Doc {
  const m = /^---\n([\s\S]*?)\n---\n+([\s\S]*)$/.exec(raw);
  if (!m) throw new Error("A corpus document must start with a front matter block");
  const meta = Object.fromEntries(
    m[1].split("\n").map((line) => {
      const i = line.indexOf(":");
      return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
    }),
  );
  for (const k of ["id", "title", "kind", "date"]) if (!meta[k]) throw new Error(`Missing "${k}" in front matter`);
  const paragraphs = m[2].trim().split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return { id: meta.id, title: meta.title, kind: meta.kind, date: meta.date, paragraphs, text: paragraphs.join("\n\n") };
}
