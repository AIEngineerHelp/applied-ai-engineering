// Render a document the way it looks (Markdown formatted, a CSV as a table,
// code highlighted, a contract and a transcript laid out) with the chunks drawn
// on top.
//
// Every piece of rendered text keeps its character offsets in the source, so
// chunk tints, attached-context outlines and cut marks line up exactly with
// what the chunker produced. A block (a paragraph, table row or code line) that
// sits inside one chunk is tinted as a whole; a block that a chunk boundary
// cuts through is tinted piece by piece.

import type { Format, Range } from "../src/types.ts";

export interface Paint {
  text: string;
  /** Each chunk's own text, in order. */
  bodies: Range[];
  /** Context ranges attached to the selected chunk. */
  context: Range[];
  selected: number;
  /** Offsets where a chunk ends inside a sentence or line. */
  cuts: Set<number>;
  tints: string[];
  /** Chunks returned together with the selected one (a figure and the text citing it). */
  linked: Set<number>;
  /** Base URL for images referenced by the document. */
  assetBase: string;
}

interface Token {
  s: number;
  e: number;
  cls: string;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function renderPreview(format: Format, p: Paint): string {
  const r = new Renderer(p);
  switch (format) {
    case "markdown":
    case "figures":
      return r.markdown();
    case "slides":
      return r.slides();
    case "code":
      return r.code();
    case "table":
      return r.table();
    case "contract":
      return r.contract();
    case "transcript":
      return r.transcript();
  }
}

interface Line {
  s: number;
  e: number;
  t: string;
}

class Renderer {
  private lines: Line[] = [];
  // Chunk numbers are drawn in document order, at the first rendered piece at
  // or after each chunk's start (a start can fall on text that isn't shown,
  // such as a comma between table cells or a code fence).
  private nextBadge = 0;
  // While rendering inside a block already tinted with chunk `outer` (a slide
  // card), inner blocks of the same chunk don't tint again.
  private outer = -1;

  constructor(private p: Paint) {
    let s = 0;
    for (const t of p.text.split("\n")) {
      this.lines.push({ s, e: s + t.length, t });
      s += t.length + 1;
    }
  }

  // ---------- Chunk geometry ----------

  /** The chunk whose own text contains position `at`, or -1. */
  private chunkAt(at: number): number {
    const b = this.p.bodies;
    let lo = 0;
    let hi = b.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (at < b[mid][0]) hi = mid - 1;
      else if (at >= b[mid][1]) lo = mid + 1;
      else return mid;
    }
    return -1;
  }

  /** The single chunk that holds all non-space text of [s, e), or -1. */
  private soleChunk(s: number, e: number): number {
    const t = this.p.text;
    while (s < e && /\s/.test(t[s])) s++;
    while (e > s && /\s/.test(t[e - 1])) e--;
    if (s >= e) return -1;
    const i = this.chunkAt(s);
    return i >= 0 && this.p.bodies[i][1] >= e ? i : -1;
  }

  /** Classes and attributes that tint a whole block with one chunk. */
  private blockAttrs(s: number, e: number, base = ""): { attrs: string; whole: boolean } {
    const i = this.soleChunk(s, e);
    if (i < 0) return { attrs: `class="${base}"`, whole: false };
    if (i === this.outer) return { attrs: `class="${base}"`, whole: true };
    return { attrs: `class="pv ${base} ${this.p.tints[i % this.p.tints.length]} ${this.state(i)}" data-i="${i}"`, whole: true };
  }

  private state(i: number): string {
    return i === this.p.selected ? "sel" : this.p.linked.has(i) ? "linked" : "dim";
  }

  /**
   * Inline text for [s, e). Splits at chunk, context, token and cut boundaries;
   * `whole` means the enclosing block already carries the chunk tint.
   */
  private inline(s: number, e: number, tokens: Token[] = [], whole = false): string {
    const { text, bodies, context, cuts } = this.p;
    if (e <= s) return "";
    const cutAt = new Set<number>();
    const marks = [s, e];
    const add = (x: number) => x > s && x < e && marks.push(x);
    for (const [a, b] of bodies) {
      if (b < s || a > e) continue;
      add(a);
      add(b);
    }
    for (const [a, b] of context) add(a), add(b);
    for (const t of tokens) add(t.s), add(t.e);
    for (const c of cuts) if (c > s && c <= e) cutAt.add(c), add(c);
    const points = [...new Set(marks)].sort((a, b) => a - b);
    let out = "";
    for (let k = 0; k < points.length - 1; k++) {
      const a = points[k];
      const b = points[k + 1];
      out += this.badgesUpTo(a);
      const tok = tokens.filter((t) => t.s <= a && t.e >= b).map((t) => t.cls);
      if (!tok.includes("hide")) {
        const cls = [...tok];
        const i = this.chunkAt(a);
        const attrs: string[] = [];
        if (!whole && i >= 0) {
          cls.push("pv", this.p.tints[i % this.p.tints.length], this.state(i));
          attrs.push(`data-i="${i}"`);
        }
        if (context.some(([x, y]) => a >= x && b <= y)) cls.push("ctx");
        const piece = esc(text.slice(a, b));
        out += cls.length ? `<span class="${cls.join(" ")}" ${attrs.join(" ")}>${piece}</span>` : piece;
      }
      if (cutAt.has(b)) out += `<i class="cut" title="This cut falls inside a sentence or line"></i>`;
    }
    return out;
  }

  private badgesUpTo(at: number): string {
    let out = "";
    while (this.nextBadge < this.p.bodies.length && this.p.bodies[this.nextBadge][0] <= at) out += this.badge(this.nextBadge++);
    return out;
  }

  private badge(i: number): string {
    return `<span class="pv-badge${i === this.p.selected ? " sel" : ""}" data-i="${i}">${i + 1}</span>`;
  }

  // ---------- Markdown ----------

  markdown(): string {
    return `<article class="pv-doc max-w-[780px] font-sans text-[15px] text-zinc-800 dark:text-zinc-200">${this.blocks(this.lines)}</article>`;
  }

  // Markdown blocks for a run of lines (the whole document, or one slide).
  private blocks(L: Line[]): string {
    let out = "";
    let i = 0;
    while (i < L.length) {
      const l = L[i];
      if (!l.t.trim()) {
        i++;
        continue;
      }
      // Fenced code block
      if (/^\s*(```|~~~)/.test(l.t)) {
        let j = i + 1;
        while (j < L.length && !/^\s*(```|~~~)/.test(L[j].t)) j++;
        const inner = L.slice(i + 1, j);
        const end = L[Math.min(j, L.length - 1)].e;
        const { attrs, whole } = this.blockAttrs(l.s, end, "my-3 overflow-x-auto rounded-lg border border-zinc-200 bg-zinc-100/70 px-3.5 py-3 font-mono text-[12.5px] leading-relaxed whitespace-pre dark:border-zinc-700 dark:bg-zinc-800/60");
        out += `<pre ${attrs}>${this.badgesUpTo(inner[0]?.s ?? l.e)}${inner.map((x) => this.inline(x.s, x.e, [], whole)).join("\n")}</pre>`;
        i = j + 1;
        continue;
      }
      // Image, rendered as a figure
      const img = l.t.match(/^!\[([^\]]*)\]\(([^)\s]+)\)\s*$/);
      if (img) {
        const { attrs } = this.blockAttrs(l.s, l.e, "my-4 rounded-xl p-2");
        out += `<figure ${attrs}>${this.badgesUpTo(l.e)}<img src="${esc(this.p.assetBase + img[2])}" alt="${esc(img[1])}" loading="lazy" class="mx-auto block max-h-[340px] w-auto max-w-full rounded-lg border border-zinc-200 bg-white dark:border-zinc-700"></figure>`;
        i++;
        continue;
      }
      // Figure caption: *Figure N. ...*
      if (/^\*\s*Fig(?:ure|\.)\s*\d+[.:].*\*\s*$/.test(l.t)) {
        const { attrs, whole } = this.blockAttrs(l.s, l.e, "-mt-2 mb-4 text-center text-[13.5px] text-zinc-600 italic dark:text-zinc-400");
        out += `<p ${attrs}>${this.inline(l.s, l.e, [{ s: l.s, e: l.s + 1, cls: "hide" }, { s: l.s + l.t.trimEnd().length - 1, e: l.e, cls: "hide" }], whole)}</p>`;
        i++;
        continue;
      }
      // Speaker notes / quote: > Notes: ...
      if (/^>\s?/.test(l.t)) {
        const { attrs, whole } = this.blockAttrs(l.s, l.e, "my-3 rounded-lg border-l-[3px] border-amber-400 bg-amber-50 px-3 py-2 text-[13.5px] leading-relaxed text-zinc-700 dark:bg-amber-950/30 dark:text-zinc-300");
        const m = l.t.match(/^>\s?/)!;
        out += `<div ${attrs}>${this.inline(l.s, l.e, [{ s: l.s, e: l.s + m[0].length, cls: "hide" }, ...this.notesLabel(l.s + m[0].length, l.e)], whole)}</div>`;
        i++;
        continue;
      }
      // Heading
      const h = l.t.match(/^(#{1,6})\s+/);
      if (h) {
        const level = h[1].length;
        const size = ["", "text-[26px] font-bold tracking-tight mt-1 mb-3", "text-xl font-bold tracking-tight mt-7 mb-2.5", "text-[17px] font-semibold mt-5 mb-2", "text-[15px] font-semibold mt-4 mb-1.5", "font-semibold mt-3 mb-1", "font-semibold mt-3 mb-1"][level];
        const { attrs, whole } = this.blockAttrs(l.s, l.e, size);
        out += `<h${Math.min(level + 1, 6)} ${attrs}>${this.inline(l.s, l.e, [{ s: l.s, e: l.s + h[0].length, cls: "hide" }], whole)}</h${Math.min(level + 1, 6)}>`;
        i++;
        continue;
      }
      // Table
      if (/^\s*\|/.test(l.t)) {
        let j = i;
        while (j < L.length && /^\s*\|/.test(L[j].t)) j++;
        out += this.mdTable(L.slice(i, j));
        i = j;
        continue;
      }
      // List
      const li = /^\s*([-*]|\d+\.)\s+/;
      if (li.test(l.t)) {
        const ordered = /^\s*\d+\./.test(l.t);
        let j = i;
        let items = "";
        while (j < L.length && li.test(L[j].t)) {
          const x = L[j];
          const m = x.t.match(li)!;
          const { attrs, whole } = this.blockAttrs(x.s, x.e, "my-1 pl-1");
          items += `<li ${attrs}>${this.inline(x.s, x.e, [{ s: x.s, e: x.s + m[0].length, cls: "hide" }, ...this.mdInline(x.s + m[0].length, x.e)], whole)}</li>`;
          j++;
        }
        out += `<${ordered ? "ol" : "ul"} class="my-2.5 ${ordered ? "list-decimal" : "list-disc"} pl-6 marker:text-zinc-400">${items}</${ordered ? "ol" : "ul"}>`;
        i = j;
        continue;
      }
      // Paragraph: consecutive plain lines
      let j = i;
      while (j + 1 < L.length && L[j + 1].t.trim() && !/^(#{1,6}\s|\s*\||\s*([-*]|\d+\.)\s|\s*```|!\[|>)/.test(L[j + 1].t)) j++;
      const { attrs, whole } = this.blockAttrs(l.s, L[j].e, "my-2.5 leading-relaxed");
      out += `<p ${attrs}>${this.inline(l.s, L[j].e, this.mdInline(l.s, L[j].e), whole)}</p>`;
      i = j + 1;
    }
    return out;
  }

  private notesLabel(s: number, e: number): Token[] {
    const m = this.p.text.slice(s, e).match(/^Notes:/);
    return m ? [{ s, e: s + m[0].length, cls: "font-semibold text-amber-700 dark:text-amber-300" }] : [];
  }

  // ---------- Slides ----------

  // Each "## Slide N: Title" section becomes a 16:9-ish card; the notes sit under it.
  slides(): string {
    const L = this.lines;
    const starts = L.map((l, i) => (/^##\s+Slide\s+\d+/i.test(l.t) ? i : -1)).filter((i) => i >= 0);
    let out = starts[0] > 0 ? this.blocks(L.slice(0, starts[0])) : "";
    starts.forEach((a, k) => {
      const lines = L.slice(a, starts[k + 1] ?? L.length);
      const head = lines[0];
      const m = head.t.match(/^##\s+Slide\s+(\d+):?\s*/i)!;
      const last = [...lines].reverse().find((l) => l.t.trim())!;
      const { attrs } = this.blockAttrs(head.s, last.e, "my-5 rounded-2xl p-1.5");
      this.outer = this.soleChunk(head.s, last.e);
      const notes = lines.filter((l) => /^>/.test(l.t));
      const content = lines.slice(1).filter((l) => !/^>/.test(l.t));
      out += `<section ${attrs}>
        <div class="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-700 dark:bg-zinc-900">
          <div class="flex items-center justify-between border-b border-zinc-100 px-4 py-1.5 text-[11px] font-semibold tracking-wider text-zinc-400 uppercase dark:border-zinc-800">${this.badgesUpTo(head.s)}<span>Slide ${m[1]}</span></div>
          <div class="px-6 pt-4 pb-5">
            <h2 class="mb-3 text-[22px] font-bold tracking-tight">${this.inline(head.s, head.e, [{ s: head.s, e: head.s + m[0].length, cls: "hide" }], this.outer >= 0)}</h2>
            <div class="text-[14.5px] [&_figure]:my-2 [&_img]:max-h-[260px]">${this.blocks(content)}</div>
          </div>
        </div>
        ${notes.length ? `<div class="px-1 [&>div]:mb-0">${this.blocks(notes)}</div>` : ""}
      </section>`;
      this.outer = -1;
    });
    return `<div class="pv-doc max-w-[820px] font-sans text-zinc-800 dark:text-zinc-200">${out}</div>`;
  }

  // `code`, **bold** and [links](url), with the markers hidden.
  private mdInline(s: number, e: number): Token[] {
    const t = this.p.text.slice(s, e);
    const out: Token[] = [];
    for (const m of t.matchAll(/`([^`\n]+)`|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\(([^)\n]+)\)/g)) {
      const a = s + m.index!;
      const b = a + m[0].length;
      if (m[1] !== undefined) {
        out.push({ s: a, e: a + 1, cls: "hide" }, { s: a + 1, e: b - 1, cls: "md-code" }, { s: b - 1, e: b, cls: "hide" });
      } else if (m[2] !== undefined) {
        out.push({ s: a, e: a + 2, cls: "hide" }, { s: a + 2, e: b - 2, cls: "font-semibold" }, { s: b - 2, e: b, cls: "hide" });
      } else {
        const close = a + 1 + m[3].length;
        out.push({ s: a, e: a + 1, cls: "hide" }, { s: a + 1, e: close, cls: "md-link" }, { s: close, e: b, cls: "hide" });
      }
    }
    return out;
  }

  private mdTable(rows: Line[]): string {
    const isRule = (l: Line) => /^\s*\|?\s*:?-{2,}/.test(l.t);
    // Cells between the pipes; the leading and trailing pipes are optional.
    const cells = (l: Line): Range[] => {
      const t = l.t.trimEnd();
      const last = t.endsWith("|") ? t.length - 1 : t.length;
      const out: Range[] = [];
      let a = t.indexOf("|") + 1;
      for (let k = a; k <= last; k++) {
        if (k === last || t[k] === "|") {
          out.push([l.s + a, l.s + k]);
          a = k + 1;
        }
      }
      return out;
    };
    const header = rows[0];
    const body = rows.slice(1).filter((r) => !isRule(r));
    const row = (l: Line, cell: "th" | "td") => {
      const { attrs, whole } = this.blockAttrs(l.s, l.e);
      return `<tr ${attrs}>${cells(l).map(([x, y]) => `<${cell} class="border-b border-zinc-200 px-3 py-2 text-left align-top dark:border-zinc-700 ${cell === "th" ? "text-xs font-semibold text-zinc-600 dark:text-zinc-300" : ""}">${this.inline(x, y, this.mdInline(x, y), whole)}</${cell}>`).join("")}</tr>`;
    };
    return `<div class="my-4 overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-700"><table class="w-full border-collapse text-[13.5px]"><thead class="bg-zinc-50 dark:bg-zinc-800/60">${row(header, "th")}</thead><tbody>${body.map((r) => row(r, "td")).join("")}</tbody></table></div>`;
  }

  // ---------- Code ----------

  code(): string {
    const tokens = pythonTokens(this.p.text);
    let k = 0;
    const rows = this.lines.map((l, n) => {
      // Tokens are sorted; advance to the ones on this line.
      while (k < tokens.length && tokens[k].e <= l.s) k++;
      const mine: Token[] = [];
      for (let q = k; q < tokens.length && tokens[q].s < l.e; q++) mine.push({ s: Math.max(tokens[q].s, l.s), e: Math.min(tokens[q].e, l.e), cls: tokens[q].cls });
      // Blank lines inside a chunk keep its tint, so a function reads as one block.
      const inside = l.t.trim() ? this.soleChunk(l.s, l.e) : this.chunkAt(l.s);
      const tint = inside >= 0 ? `pv ${this.p.tints[inside % this.p.tints.length]} ${inside === this.p.selected ? "sel" : "dim"}` : "";
      const data = inside >= 0 ? `data-i="${inside}"` : "";
      return `<div class="flex ${tint}" ${data}><span class="w-10 flex-none pr-3 text-right text-zinc-400 select-none dark:text-zinc-600">${n + 1}</span><span class="min-w-0 flex-1 whitespace-pre-wrap">${this.inline(l.s, l.e, mine, inside >= 0) || " "}</span></div>`;
    });
    return `<div class="pv-doc font-mono text-[12.5px] leading-[1.65]">${rows.join("")}</div>`;
  }

  // ---------- Table (CSV) ----------

  table(): string {
    const rows = this.lines.filter((l) => l.t.trim());
    const cells = (l: Line): Range[] => {
      const out: Range[] = [];
      let a = 0;
      let quoted = false;
      for (let k = 0; k <= l.t.length; k++) {
        const c = l.t[k];
        if (c === '"') quoted = !quoted;
        if (k === l.t.length || (c === "," && !quoted)) {
          out.push([l.s + a, l.s + k]);
          a = k + 1;
        }
      }
      return out;
    };
    const tr = (l: Line, cell: "th" | "td") => {
      const { attrs, whole } = this.blockAttrs(l.s, l.e);
      const ctx = this.p.context.some(([a, b]) => a <= l.s && b >= l.e);
      return `<tr ${attrs}>${cells(l)
        .map(([x, y], c) => `<${cell} class="border-b border-zinc-200 px-2.5 py-1.5 text-left whitespace-nowrap dark:border-zinc-700 ${cell === "th" ? `font-mono text-[11px] font-semibold text-zinc-600 dark:text-zinc-300 ${ctx ? "bg-teal-50 dark:bg-teal-950/40" : ""}` : c === 0 ? "font-mono text-[11.5px]" : ""}">${this.inline(x, y, [], whole) || "&nbsp;"}</${cell}>`)
        .join("")}</tr>`;
    };
    const [header, ...body] = rows;
    const headerCtx = this.p.context.length > 0;
    return `<div class="pv-doc">
      ${headerCtx ? `<p class="mb-2 text-xs text-teal-700 dark:text-teal-300">The header row (outlined) is attached to every chunk.</p>` : ""}
      <div class="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-700"><table class="w-full border-collapse font-sans text-[12.5px]"><thead class="sticky top-0 bg-zinc-50 dark:bg-zinc-800">${tr(header, "th")}</thead><tbody>${body.map((l) => tr(l, "td")).join("")}</tbody></table></div>
    </div>`;
  }

  // ---------- Contract ----------

  contract(): string {
    let out = "";
    let first = true;
    for (const l of this.lines) {
      if (!l.t.trim()) continue;
      const article = /^\d+\.\s+[A-Z][A-Z0-9 ,;:&'()/-]+$/.test(l.t.trim());
      const clause = l.t.match(/^(\d+\.\d+(\.\d+)?\.?)\s/);
      const columns = / {3,}/.test(l.t);
      let cls = "my-2.5 leading-relaxed";
      const tokens: Token[] = [];
      if (first && l.t === l.t.toUpperCase()) cls = "mb-5 text-center text-lg font-bold tracking-[0.2em]";
      else if (article) cls = "mt-7 mb-2.5 text-[13px] font-bold tracking-widest text-zinc-900 dark:text-zinc-100";
      else if (columns) cls = "my-0.5 font-mono text-[12.5px] whitespace-pre";
      if (clause) {
        tokens.push({ s: l.s, e: l.s + clause[1].length, cls: "font-semibold text-zinc-900 dark:text-zinc-100" });
        // "9.3 Exceptions." — the clause title, if any
        const title = l.t.slice(clause[0].length).match(/^([A-Z][\w ,'&-]{1,40}\.)\s/);
        if (title) tokens.push({ s: l.s + clause[0].length, e: l.s + clause[0].length + title[1].length, cls: "font-semibold" });
      }
      const { attrs, whole } = this.blockAttrs(l.s, l.e, cls);
      out += `<p ${attrs}>${this.inline(l.s, l.e, tokens, whole)}</p>`;
      first = false;
    }
    return `<article class="pv-doc max-w-[760px] font-serif text-[15px] text-zinc-800 dark:text-zinc-200">${out}</article>`;
  }

  // ---------- Transcript ----------

  transcript(): string {
    let out = "";
    let first = true;
    for (const l of this.lines) {
      if (!l.t.trim()) continue;
      const m = l.t.match(/^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s+([^(:]+?)(\s*\([^)]*\))?:\s/);
      if (!m) {
        const { attrs, whole } = this.blockAttrs(l.s, l.e, first ? "mb-1 text-lg font-bold tracking-tight" : "mb-1 text-[13.5px] text-zinc-500");
        out += `<p ${attrs}>${this.inline(l.s, l.e, [], whole)}</p>`;
        first = false;
        continue;
      }
      const timeEnd = l.s + m[1].length + 2;
      const nameStart = l.s + m[0].indexOf(m[2]);
      const nameEnd = nameStart + m[2].length;
      const roleEnd = nameEnd + (m[3]?.length ?? 0);
      const textStart = l.s + m[0].length;
      const { attrs, whole } = this.blockAttrs(l.s, l.e, "my-1.5 grid grid-cols-[76px_minmax(0,1fr)] gap-3 rounded-lg px-2 py-2");
      out += `<div ${attrs}>
        <span class="pt-0.5 font-mono text-[11.5px] text-zinc-500">${this.inline(l.s, timeEnd, [{ s: l.s, e: l.s + 1, cls: "hide" }, { s: timeEnd - 1, e: timeEnd, cls: "hide" }], whole)}</span>
        <div class="min-w-0"><div class="mb-0.5 text-[13.5px]"><b class="font-semibold">${this.inline(nameStart, nameEnd, [], whole)}</b><span class="text-zinc-500">${this.inline(nameEnd, roleEnd, [], whole)}</span></div>
        <p class="leading-relaxed">${this.inline(textStart, l.e, [], whole)}</p></div>
      </div>`;
    }
    return `<article class="pv-doc max-w-[820px] font-sans text-[14.5px] text-zinc-800 dark:text-zinc-200">${out}</article>`;
  }
}

// A small Python highlighter: comments, strings (including triple-quoted),
// decorators, keywords, numbers, and the names after def and class.
const KEYWORDS = new Set(
  "False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield".split(" "),
);

export function pythonTokens(text: string): Token[] {
  const out: Token[] = [];
  const re = /(#[^\n]*)|("""[\s\S]*?"""|'''[\s\S]*?'''|[rbfu]?"(?:\\.|[^"\\\n])*"|[rbfu]?'(?:\\.|[^'\\\n])*')|(@[\w.]+)|\b(\d[\d_]*(?:\.\d+)?)\b|\b([A-Za-z_]\w*)\b/g;
  let afterDef = false;
  for (const m of text.matchAll(re)) {
    const s = m.index!;
    const e = s + m[0].length;
    if (m[1]) out.push({ s, e, cls: "tok-com" });
    else if (m[2]) out.push({ s, e, cls: "tok-str" });
    else if (m[3]) out.push({ s, e, cls: "tok-dec" });
    else if (m[4]) out.push({ s, e, cls: "tok-num" });
    else if (m[5]) {
      if (afterDef) out.push({ s, e, cls: "tok-fn" });
      else if (KEYWORDS.has(m[5])) out.push({ s, e, cls: "tok-kw" });
      else if (/^[A-Z][A-Z0-9_]{2,}$/.test(m[5])) out.push({ s, e, cls: "tok-const" });
      afterDef = m[5] === "def" || m[5] === "class";
      continue;
    }
    afterDef = false;
  }
  return out;
}
