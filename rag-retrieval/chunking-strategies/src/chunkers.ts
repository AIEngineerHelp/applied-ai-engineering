// How we chunk a document, and a fixed-size split to compare it with.
//
//   structure  cut where the format says a unit ends (a heading, a function,
//              a clause, a row, a speaker turn), split long units recursively,
//              and attach the document title and section headings to each chunk
//   fixed      cut every N characters, wherever that lands
//
// Every chunk records which characters of the source it contains (`spans`), so
// the app can highlight it. Earlier spans are headings attached as context; the
// last span is the chunk's own text. `text` is what gets embedded.

import { CHARS_PER_TOKEN, estimateTokens } from "./tokens.ts";
import { trimRange, mergeRanges } from "./text.ts";
import { FORMATS, parseUnits, type Unit } from "./structure.ts";
import { findFigureBlocks, findReferences, type ReferenceKind } from "./figures.ts";
import type { Chunk, Doc, Range } from "./types.ts";

export type Method = "structure" | "fixed";

export const DEFAULT_SIZE = 400; // tokens
export const MIN_UNIT = 25; // tokens: a smaller standalone unit joins the next one

export function chunkDocument(doc: Doc, method: Method, { size = DEFAULT_SIZE } = {}): Chunk[] {
  const max = size * CHARS_PER_TOKEN;
  if (method === "fixed") {
    return fixedRanges(doc.text, max).map((r) => ({ docId: doc.id, spans: [r], text: doc.text.slice(r[0], r[1]) }));
  }
  return structureChunks(doc, max);
}

// Fixed windows, cut at exact character counts.
export function fixedRanges(text: string, max: number, start = 0, end = text.length): Range[] {
  const out: Range[] = [];
  for (let s = start; s < end; s += max) {
    const r = trimRange(text, [s, Math.min(s + max, end)]);
    if (r[1] > r[0]) out.push(r);
  }
  return out;
}

// Recursive splitting, for units longer than the limit: try the coarsest
// separator first (blank line, line break, sentence end, space), merge pieces
// up to the limit, and recurse into any piece that is still too long.
const SEPARATORS = ["\n\n", "\n", ". ", " ", ""];

export function recursiveRanges(text: string, [start, end]: Range, max: number, seps = SEPARATORS): Range[] {
  if (end - start <= max) {
    const r = trimRange(text, [start, end]);
    return r[1] > r[0] ? [r] : [];
  }
  const i = seps.findIndex((sep) => sep === "" || text.slice(start, end).includes(sep));
  const sep = seps[i];
  if (sep === "") return fixedRanges(text, max, start, end);
  // Pieces end just after each separator, so together they tile [start, end).
  const pieces: Range[] = [];
  let s = start;
  for (let at = text.indexOf(sep, start); at !== -1 && at + sep.length <= end; at = text.indexOf(sep, at + sep.length)) {
    pieces.push([s, at + sep.length]);
    s = at + sep.length;
  }
  if (s < end) pieces.push([s, end]);
  const out: Range[] = [];
  let group: Range | null = null;
  const flush = () => {
    if (group) {
      const r = trimRange(text, group);
      if (r[1] > r[0]) out.push(r);
    }
    group = null;
  };
  for (const p of pieces) {
    if (p[1] - p[0] > max) {
      flush();
      out.push(...recursiveRanges(text, p, max, seps.slice(i + 1)));
    } else if (group && p[1] - group[0] <= max) {
      group[1] = p[1];
    } else {
      flush();
      group = [p[0], p[1]];
    }
  }
  flush();
  return out;
}

// Structure units sized for indexing: units that are too long are split
// recursively and keep their headings; table rows and transcript turns are
// packed together; other units smaller than MIN_UNIT join their next sibling.
export function structureUnits(doc: Doc, max: number): Unit[] {
  const { text, format } = doc;
  const split = parseUnits(text, format).flatMap((u) =>
    u.range[1] - u.range[0] > max ? recursiveRanges(text, u.range, max).map((r) => ({ ...u, range: r })) : [u],
  );
  const key = (u: Unit) => JSON.stringify(u.ancestors);
  const out: Unit[] = [];
  if (FORMATS[format].pack) {
    for (const u of split) {
      const last = out[out.length - 1];
      if (last && key(last) === key(u) && u.range[1] - last.range[0] <= max) last.range = [last.range[0], u.range[1]];
      else out.push({ ...u, range: [u.range[0], u.range[1]] });
    }
    return out;
  }
  let carry: Unit | null = null;
  for (const u of split) {
    // Figures and slides always stay chunks of their own.
    if (u.kind) {
      if (carry) out.push(carry);
      carry = null;
      out.push(u);
      continue;
    }
    const joins = carry !== null && !carry.kind && key(carry) === key(u) && u.range[1] - carry.range[0] <= max;
    if (carry && !joins) out.push(carry);
    const unit: Unit = { ...u, range: joins ? [carry!.range[0], u.range[1]] : u.range };
    carry = null;
    if (estimateTokens(text.slice(unit.range[0], unit.range[1])) < MIN_UNIT) carry = unit;
    else out.push(unit);
  }
  if (carry) out.push(carry);
  return out;
}

function structureChunks(doc: Doc, max: number): Chunk[] {
  const units = structureUnits(doc, max);
  // A unit that is only a heading for others (a table's header row) is
  // attached to every chunk instead of being a chunk of its own.
  const headings = new Set(units.flatMap((u) => u.ancestors.map((a) => `${a[0]}:${a[1]}`)));
  const chunks: Chunk[] = units
    .filter((u) => !headings.has(`${u.range[0]}:${u.range[1]}`))
    .map((u) => {
      // Headings that are already inside the chunk aren't repeated.
      const ancestors = u.ancestors.filter(([s]) => s < u.range[0]);
      const header = [`Document: ${doc.title}`, ...ancestors.map((a) => doc.text.slice(a[0], a[1]))].join("\n");
      return {
        docId: doc.id,
        spans: [...mergeRanges(ancestors), u.range],
        text: `${header}\n\n${doc.text.slice(u.range[0], u.range[1])}`,
        label: u.ancestors.map((a) => firstLine(doc.text.slice(a[0], a[1]))).join(" › "),
      };
    });
  return doc.format === "figures" || doc.format === "slides" ? attachFigures(doc, chunks) : chunks;
}

const REASON: Record<ReferenceKind, (n: string) => string> = {
  explicit: (n) => `cites ${n} by name`,
  nearby: (n) => `points at ${n} (“below” / “above”)`,
  slide: (n) => `refers to ${n} (“the previous slide”)`,
  callout: (n) => `uses callout numbers defined in ${n}`,
};

// Give each figure's chunk its image and description, attach the sentences
// that refer to it, and link it both ways with the chunks those sentences sit
// in, so retrieving either one returns the other.
function attachFigures(doc: Doc, chunks: Chunk[]): Chunk[] {
  const text = doc.text;
  const blocks = findFigureBlocks(text);
  if (!blocks.length) return chunks;
  const meta = (src: string) => doc.images?.find((m) => m.file === src);
  const body = (c: Chunk) => c.spans[c.spans.length - 1];
  const owner = (at: number) => chunks.findIndex((c) => body(c)[0] <= at && at < body(c)[1]);
  const slideStarts = doc.format === "slides" ? [...text.matchAll(/^##\s+Slide\s+\d+/gim)].map((m) => m.index!) : undefined;
  const name = (i: number) => {
    if (blocks[i].number) return `Figure ${blocks[i].number}`;
    const slide = (slideStarts ?? []).filter((s) => s <= blocks[i].range[0]).length;
    return slide ? `the image on slide ${slide}` : "the image";
  };
  // A diagram whose description names numbered callouts defines "(4)"-style references.
  const callout = blocks.findIndex((b) => /callout/i.test(meta(b.src)?.description ?? ""));
  const refs = findReferences(text, blocks, { slideStarts, calloutFigure: callout >= 0 && !slideStarts ? callout : undefined });

  const out = chunks.map((c) => ({ ...c, spans: [...c.spans], links: [] as number[], linkReasons: [] as string[] }));
  const link = (a: number, b: number, reason: string) => {
    if (a < 0 || b < 0 || a === b || out[a].links.includes(b)) return;
    out[a].links.push(b);
    out[a].linkReasons.push(reason);
  };
  const cited = new Map<number, string[]>();

  blocks.forEach((b, i) => {
    const ci = owner(b.image[0]);
    if (ci < 0) return;
    const m = meta(b.src);
    out[ci].image = { file: b.src, alt: b.alt, number: b.number, description: m?.description };
    cited.set(ci, []);
  });
  for (const r of refs) {
    const fi = owner(blocks[r.figure].image[0]);
    const ti = owner(r.sentence[0]);
    if (fi < 0 || ti === fi) continue;
    const c = out[fi];
    c.spans = [...mergeRanges([...c.spans.slice(0, -1), r.sentence]), body(c)];
    cited.get(fi)!.push(text.slice(r.sentence[0], r.sentence[1]).replace(/^\s*([-*]|\d+\.)\s+/, ""));
    link(ti, fi, `This text ${REASON[r.kind](name(r.figure))}`);
    link(fi, ti, `Text here ${REASON[r.kind](name(r.figure))}`);
  }
  // The parts table that names each callout belongs with the diagram too.
  if (callout >= 0) {
    const fi = owner(blocks[callout].image[0]);
    const ti = out.findIndex((c) => /^\|\s*Callout\s*\|/im.test(text.slice(...body(c))));
    link(fi, ti, "The parts table names every callout in this diagram");
    link(ti, fi, `The table's callout numbers point into ${name(callout)}`);
  }

  // What gets embedded for a figure: its caption and headings (already there),
  // the vision model's description, and the sentences that cite it.
  for (const [ci, sentences] of cited) {
    const c = out[ci];
    const extra = [
      c.image?.description ? `Image description: ${c.image.description}` : "",
      sentences.length ? `Referenced in the text:\n${sentences.map((t) => `- ${t}`).join("\n")}` : "",
    ].filter(Boolean);
    if (extra.length) c.text = `${c.text}\n\n${extra.join("\n\n")}`;
  }
  return out.map((c) => (c.links.length ? c : { ...c, links: undefined, linkReasons: undefined }));
}

function firstLine(s: string): string {
  return s.split("\n")[0].replace(/^#+\s*/, "").trim();
}
