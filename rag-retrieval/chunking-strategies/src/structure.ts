// Document-structure parsers. Each one turns a document into "units", the
// smallest pieces its format defines, and records the headings each unit sits
// under ("ancestors"), so a chunk can carry its section path with it.
//
//   markdown    a section per heading (help centers, docs, reports)
//   code        top-level functions, classes and module code; classes split by method
//   table       one row per unit; the header row is every row's ancestor
//   contract    one clause per unit, under its numbered article
//   transcript  one speaker turn per unit
//   figures     Markdown sections, with each figure (image + caption) as its own unit
//   slides      one slide per unit, image and speaker notes included
//
// `pack` tells the chunker whether small neighbouring units belong together
// (table rows, transcript turns) or stand alone (sections, clauses, functions).

import { trimRange } from "./text.ts";
import { findFigureBlocks } from "./figures.ts";
import type { Format, Range } from "./types.ts";

export interface Unit {
  range: Range;
  ancestors: Range[];
  /** Figures and slides are never merged with their neighbours. */
  kind?: "figure" | "slide";
}

export const FORMATS: Record<Format, { label: string; pack: boolean; unit: string }> = {
  markdown: { label: "Markdown", pack: false, unit: "a section under each heading" },
  code: { label: "Source code", pack: false, unit: "a function, a class method, or a block of module code" },
  table: { label: "Table (CSV)", pack: true, unit: "rows, packed up to the size limit" },
  contract: { label: "Contract", pack: false, unit: "a numbered clause, under its article" },
  transcript: { label: "Transcript", pack: true, unit: "speaker turns, packed up to the size limit" },
  figures: { label: "Document with figures", pack: false, unit: "a section under each heading; each figure with its caption on its own" },
  slides: { label: "Slide deck", pack: false, unit: "one slide, with its image and speaker notes" },
};

// Guess the format from a file name and its content, for pasted documents.
export function detectFormat(text: string, name = ""): Format {
  if (/\.py$|\.[jt]sx?$/i.test(name)) return "code";
  if (/\.csv$/i.test(name)) return "table";
  if (/\.(md|markdown)$/i.test(name)) return "markdown";
  const ls = text.split("\n").slice(0, 400);
  const count = (re: RegExp) => ls.filter((l) => re.test(l)).length;
  if (count(/^\[\d{1,2}:\d{2}(:\d{2})?\]/) >= 3) return "transcript";
  if (count(/^\s*(def |class |import |from \S+ import |function |const |export )/) >= 3) return "code";
  if (count(/^#{1,6}\s/) >= 2) return "markdown";
  if (count(/^\d+\.\d+\s/) >= 3) return "contract";
  const commas = ls.filter((l) => l.trim()).map((l) => l.split(",").length);
  if (commas.length >= 5 && commas.every((n) => n === commas[0] && n >= 3)) return "table";
  return "markdown";
}

interface Line {
  s: number;
  e: number;
  text: string;
}

function lines(text: string): Line[] {
  const out: Line[] = [];
  let s = 0;
  for (const line of text.split("\n")) {
    out.push({ s, e: s + line.length, text: line });
    s += line.length + 1;
  }
  return out;
}

export function parseUnits(text: string, format: Format): Unit[] {
  const parse = { markdown, code, table, contract, transcript, figures, slides }[format] ?? markdown;
  return parse(text)
    .map((u) => ({ ...u, range: trimRange(text, u.range) }))
    .filter((u) => u.range[1] > u.range[0]);
}

// Markdown sections, cut around each figure so the image and its caption
// form a unit of their own under the same headings.
function figures(text: string): Unit[] {
  const blocks = findFigureBlocks(text);
  return markdown(text).flatMap((u) => {
    const inside = blocks.filter((b) => b.range[0] >= u.range[0] && b.range[1] <= u.range[1]);
    if (!inside.length) return [u];
    const out: Unit[] = [];
    let at = u.range[0];
    for (const b of inside) {
      if (b.range[0] > at) out.push({ range: [at, b.range[0]], ancestors: u.ancestors });
      out.push({ range: b.range, ancestors: u.ancestors, kind: "figure" });
      at = b.range[1];
    }
    if (at < u.range[1]) out.push({ range: [at, u.range[1]], ancestors: u.ancestors });
    return out;
  });
}

// "## Slide N: Title" starts a slide; the slide keeps its title, bullets,
// image and notes together.
function slides(text: string): Unit[] {
  return sections(text, (line) => {
    if (/^##\s+Slide\s+\d+/i.test(line)) return { level: 2, titled: false };
    if (/^#\s/.test(line)) return { level: 1, titled: true };
    return { level: 0, titled: false };
  }).map((u) => (/^##\s+Slide/i.test(text.slice(u.range[0], u.range[0] + 12)) ? { ...u, kind: "slide" as const } : u));
}

interface Section extends Unit {
  heading?: Range;
}

// A section starts at a heading line and runs to the next heading, so its
// heading stays inside it. `headingLevel` returns 0 for ordinary lines. With
// `titled` false (contract clauses), the opening line is content, not a title.
type Level = (line: string) => { level: number; titled: boolean };

function sections(text: string, headingLevel: Level): Section[] {
  const out: Section[] = [];
  const stack: { level: number; range: Range }[] = [];
  let fence = false;
  let current: Section = { range: [0, 0], ancestors: [] };
  for (const l of lines(text)) {
    if (/^\s*(```|~~~)/.test(l.text)) fence = !fence;
    const { level, titled } = fence ? { level: 0, titled: false } : headingLevel(l.text);
    if (level) {
      current.range[1] = l.s;
      out.push(current);
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      current = { range: [l.s, l.e], ancestors: stack.map((x) => x.range), heading: titled ? [l.s, l.e] : undefined };
      stack.push({ level, range: [l.s, l.e] });
    } else {
      current.range[1] = l.e;
    }
  }
  out.push(current);
  return mergeHeadingOnly(text, out);
}

// A heading with no text of its own (an H2 directly followed by an H3) joins
// the next unit, so it isn't indexed as an empty chunk.
function mergeHeadingOnly(text: string, units: Section[]): Section[] {
  const out: Section[] = [];
  let carry: number | null = null;
  for (const u of units) {
    const body = text.slice(u.heading ? u.heading[1] : u.range[0], u.range[1]).trim();
    if (!body && u.heading) {
      carry ??= u.range[0];
      continue;
    }
    out.push(carry === null ? u : { ...u, range: [carry, u.range[1]] });
    carry = null;
  }
  if (carry !== null && out.length) out[out.length - 1].range[1] = text.length;
  return out;
}

function markdown(text: string): Unit[] {
  return sections(text, (line) => ({ level: line.match(/^(#{1,6})\s+\S/)?.[1].length ?? 0, titled: true }));
}

// Numbered articles ("9. LIMITATION OF LIABILITY") are level 1, clauses
// ("9.3 ...") level 2.
function contract(text: string): Unit[] {
  return sections(text, (line) => {
    if (/^\d+\.\s+[A-Z][A-Z0-9 ,;:&'()/-]+$/.test(line.trim())) return { level: 1, titled: true };
    if (/^\d+\.\d+(\.\d+)?\.?\s/.test(line)) return { level: 2, titled: false };
    return { level: 0, titled: false };
  });
}

interface CodeUnit extends Unit {
  block: "module" | "def" | "class";
  line: Range;
}

function code(text: string): Unit[] {
  const ls = lines(text);
  const units: CodeUnit[] = [];
  let current: CodeUnit | null = null;
  const start = (i: number, block: CodeUnit["block"]) => {
    // Comments and decorators directly above a definition belong to it.
    let j = i;
    while (j > 0 && /^(#|@)/.test(ls[j - 1].text)) j--;
    if (current) {
      current.range[1] = ls[j].s;
      if (current.range[1] > current.range[0]) units.push(current);
    }
    current = { range: [ls[j].s, ls[i].e], block, ancestors: [], line: [ls[i].s, ls[i].e] };
  };
  for (let i = 0; i < ls.length; i++) {
    const t = ls[i].text;
    const c = current as CodeUnit | null;
    if (/^(async\s+def|def|class)\s/.test(t)) start(i, t.startsWith("class") ? "class" : "def");
    else if (/^[A-Za-z_]/.test(t) && c && c.block !== "module") start(i, "module");
    else if (!c) current = { range: [0, ls[i].e], block: "module", ancestors: [], line: [0, ls[i].e] };
    else c.range[1] = ls[i].e;
  }
  if (current) units.push(current);
  return units.flatMap((u) => (u.block === "class" ? splitClass(ls, u) : [u]));
}

// A class becomes a header (signature, docstring, attributes) and one unit per
// method, each with the class line as its ancestor.
function splitClass(ls: Line[], cls: CodeUnit): Unit[] {
  const inside = ls.filter((l) => l.s >= cls.range[0] && l.e <= cls.range[1]);
  const cuts: number[] = [];
  for (let i = 0; i < inside.length; i++) {
    if (/^ {4}(async\s+)?def\s/.test(inside[i].text)) {
      let j = i;
      while (j > 0 && /^ {4}(@|#)/.test(inside[j - 1].text)) j--;
      cuts.push(inside[j].s);
    }
  }
  if (!cuts.length) return [cls];
  const bounds = [cls.range[0], ...cuts, cls.range[1]];
  return bounds.slice(0, -1).map((s, i) => ({ range: [s, bounds[i + 1]] as Range, ancestors: i === 0 ? [] : [cls.line] }));
}

function table(text: string): Unit[] {
  const ls = lines(text).filter((l) => l.text.trim());
  if (!ls.length) return [];
  const header: Range = [ls[0].s, ls[0].e];
  return [{ range: header, ancestors: [] }, ...ls.slice(1).map((l) => ({ range: [l.s, l.e] as Range, ancestors: [header] }))];
}

function transcript(text: string): Unit[] {
  const units: Unit[] = [];
  let current: Unit = { range: [0, 0], ancestors: [] };
  for (const l of lines(text)) {
    if (/^\[\d{1,2}:\d{2}(:\d{2})?\]/.test(l.text)) {
      current.range[1] = l.s;
      units.push(current);
      current = { range: [l.s, l.e], ancestors: [] };
    } else {
      current.range[1] = l.e;
    }
  }
  units.push(current);
  return units;
}
