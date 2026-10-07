// Figures and the text that refers to them.
//
// A PDF or slide parser (Docling, LlamaParse, Unstructured, Azure Document
// Intelligence) turns each image into an element with its caption. Converted
// to Markdown, that looks like:
//
//   ![alt text](figures/net-latency.svg)
//
//   *Figure 2. Weekly p95 webhook latency.*
//
// The image's meaning has to reach the index somehow, and so do the links
// between the image and the sentences that talk about it. We find four kinds
// of reference, the ones production pipelines use:
//
//   explicit   "Figure 2", "Fig. 2"
//   nearby     "the chart below", "the diagram above": the next or previous figure
//   slide      "the diagram on the previous slide"
//   callout    "(4)" in a procedure, pointing at a numbered callout in a parts diagram

import type { Range } from "./types.ts";

export interface FigureBlock {
  /** Image line plus caption, if there is one. */
  range: Range;
  image: Range;
  caption?: Range;
  src: string;
  alt: string;
  number?: number;
}

export type ReferenceKind = "explicit" | "nearby" | "slide" | "callout";

export interface Reference {
  /** Index into the figure blocks. */
  figure: number;
  /** The sentence (or list item) that makes the reference. */
  sentence: Range;
  kind: ReferenceKind;
}

const IMAGE = /^!\[([^\]]*)\]\(([^)\s]+)\)[ \t]*$/gm;
const CAPTION = /^\*\s*Fig(?:ure|\.)\s*(\d+)[.:][^\n]*\*[ \t]*$/;

export function findFigureBlocks(text: string): FigureBlock[] {
  const out: FigureBlock[] = [];
  for (const m of text.matchAll(IMAGE)) {
    const s = m.index!;
    const e = s + m[0].trimEnd().length;
    // The caption is the next non-blank line, if it looks like one.
    const rest = text.slice(e);
    const next = rest.match(/^\s*\n([^\n]*)/);
    let caption: Range | undefined;
    let number: number | undefined;
    if (next) {
      const line = next[1];
      const c = line.match(CAPTION);
      if (c) {
        const cs = e + next[0].length - line.length;
        caption = [cs, cs + line.trimEnd().length];
        number = Number(c[1]);
      }
    }
    out.push({ range: [s, caption ? caption[1] : e], image: [s, e], caption, src: m[2], alt: m[1], number });
  }
  return out;
}

// The sentence around position `at`: from the previous sentence end (or line
// start) to the next one (or line end). List items and table rows are kept whole.
export function sentenceAround(text: string, at: number): Range {
  const lineStart = text.lastIndexOf("\n", at - 1) + 1;
  let lineEnd = text.indexOf("\n", at);
  if (lineEnd === -1) lineEnd = text.length;
  const line = text.slice(lineStart, lineEnd);
  if (/^\s*([-*|]|\d+\.)\s/.test(line) || line.startsWith(">")) return [lineStart, lineEnd];
  let s = lineStart;
  // Include the character at `at` so a sentence end right before the match is seen.
  for (const m of text.slice(lineStart, at + 1).matchAll(/[.!?]["')]?\s+(?=[A-Z("])/g)) s = lineStart + m.index! + m[0].length;
  const after = text.slice(at, lineEnd).match(/[.!?]["')]?(\s|$)/);
  const e = after ? at + after.index! + after[0].trimEnd().length : lineEnd;
  return [s, e];
}

export function findReferences(text: string, blocks: FigureBlock[], opts: { slideStarts?: number[]; calloutFigure?: number } = {}): Reference[] {
  const out: Reference[] = [];
  const inFigure = (at: number) => blocks.some((b) => at >= b.range[0] && at < b.range[1]);
  const add = (figure: number, at: number, kind: ReferenceKind) => {
    if (figure < 0 || figure >= blocks.length || inFigure(at)) return;
    const sentence = sentenceAround(text, at);
    if (!out.some((r) => r.figure === figure && r.sentence[0] === sentence[0])) out.push({ figure, sentence, kind });
  };

  // Explicit: "Figure 2", "Fig. 2", "Figures 2 and 3".
  for (const m of text.matchAll(/\bFig(?:ure|\.)s?\s*(\d+)(?:\s*(?:and|,|&)\s*(\d+))?/g)) {
    for (const n of [m[1], m[2]].filter(Boolean)) add(blocks.findIndex((b) => b.number === Number(n)), m.index!, "explicit");
  }

  // Nearby: "the chart below" means the next figure, "above" the previous one.
  for (const m of text.matchAll(/\b(?:the|this)\s+(?:diagram|chart|figure|image|graph|illustration|screenshot|picture|drawing|photo)\s+(below|above)\b/gi)) {
    const at = m.index!;
    const below = m[1].toLowerCase() === "below";
    const i = below ? blocks.findIndex((b) => b.range[0] > at) : findLastIndex(blocks, (b) => b.range[1] <= at);
    add(i, at, "nearby");
  }

  // Slides: "the diagram on the previous slide" means the last image before this slide.
  if (opts.slideStarts?.length) {
    for (const m of text.matchAll(/\b(previous|last)\s+slide\b/gi)) {
      const at = m.index!;
      const slide = findLastIndex(opts.slideStarts, (s) => s <= at);
      if (slide < 1) continue;
      const i = findLastIndex(blocks, (b) => b.range[0] < opts.slideStarts![slide] && b.range[0] >= opts.slideStarts![slide - 1]);
      add(i, at, "slide");
    }
  }

  // Callouts: "(4)" in a step points at callout 4 of the parts diagram.
  if (opts.calloutFigure !== undefined) {
    for (const m of text.matchAll(/\((\d{1,2})\)/g)) add(opts.calloutFigure, m.index!, "callout");
  }
  return out.sort((a, b) => a.sentence[0] - b.sentence[0]);
}

function findLastIndex<T>(xs: T[], f: (x: T) => boolean): number {
  for (let i = xs.length - 1; i >= 0; i--) if (f(xs[i])) return i;
  return -1;
}
