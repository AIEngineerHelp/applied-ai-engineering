// Locate an extraction in its source text, so the app can highlight each
// entity mention and the sentence each relation came from. Extractors return
// names and evidence as strings, not offsets, so the offsets are recomputed.

import type { Extraction } from "./schema.ts";

export interface Span {
  start: number;
  end: number;
}

export interface Piece {
  text: string;
  entity: string | null; // the extracted name, if this piece is a mention
  relations: number[]; // indexes of the relations whose evidence covers this piece
}

const isWord = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c);

/** Every whole-word occurrence of each extracted name; longer names win overlaps. */
export function mentionSpans(text: string, x: Extraction): (Span & { name: string })[] {
  const names = [...new Set(x.entities.map((e) => e.name))].sort((a, b) => b.length - a.length);
  const spans: (Span & { name: string })[] = [];
  for (const name of names) {
    for (let at = text.indexOf(name); at !== -1; at = text.indexOf(name, at + 1)) {
      const end = at + name.length;
      if (isWord(text[at - 1]) || isWord(text[end])) continue;
      if (spans.some((s) => at < s.end && end > s.start)) continue;
      spans.push({ start: at, end, name });
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

export function evidenceSpans(text: string, x: Extraction): (Span & { relation: number })[] {
  return x.relations.flatMap((r, relation) => {
    const at = text.indexOf(r.evidence);
    return at === -1 ? [] : [{ start: at, end: at + r.evidence.length, relation }];
  });
}

/** Cut the text at every span boundary, labelling each piece. */
export function pieces(text: string, x: Extraction): Piece[] {
  const mentions = mentionSpans(text, x);
  const evidence = evidenceSpans(text, x);
  const cuts = new Set([0, text.length]);
  for (const s of [...mentions, ...evidence]) cuts.add(s.start).add(s.end);
  const sorted = [...cuts].sort((a, b) => a - b);
  const out: Piece[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const [a, b] = [sorted[i], sorted[i + 1]];
    out.push({
      text: text.slice(a, b),
      entity: mentions.find((m) => m.start <= a && b <= m.end)?.name ?? null,
      relations: evidence.filter((e) => e.start <= a && b <= e.end).map((e) => e.relation),
    });
  }
  return out;
}
