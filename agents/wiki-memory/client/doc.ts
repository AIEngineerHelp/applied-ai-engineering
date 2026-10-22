// Typesets a wiki page as a document and shows an edit as tracked changes: inserted words, deleted
// words, and claims struck through as superseded. Pure string functions, so tests can check them.

import type { DiffLine } from "../src/diff.ts";
import { CLAIM } from "../src/wiki.ts";
import { esc } from "./render.ts";

export type Change = "same" | "ins" | "del" | "mod" | "strike";

export interface Block {
  kind: "h1" | "h2" | "p" | "li" | "claim";
  html: string;
  change: Change;
}

// Wiki links, code spans, struck spans and bold are single tokens; then whitespace, words, punctuation.
const TOKEN = /\[\[[a-z0-9-]+\]\]|`[^`]+`|~~.+?~~|\*\*.+?\*\*|\s+|[A-Za-z0-9][A-Za-z0-9'’\-/#.,:]*[A-Za-z0-9]|[A-Za-z0-9]|./g;

export const tokenize = (line: string) => line.match(TOKEN) ?? [];

/** Inline markdown for one token or run of text: wiki links, code, struck text and bold. */
export function inline(text: string): string {
  return esc(text)
    .replace(/~~(.+?)~~/g, (_, inner: string) => `<s>${inner}</s>`)
    .replace(/\[\[([a-z0-9-]+)\]\]/g, '<span class="wl">$1</span>')
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

/** Word-level diff of two lines, as HTML with <del> and <ins> runs. */
export function wordDiff(a: string, b: string): string {
  const x = tokenize(a);
  const y = tokenize(b);
  const lcs: number[][] = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const parts: { op: "same" | "del" | "ins"; text: string }[] = [];
  const push = (op: "same" | "del" | "ins", text: string) => {
    const last = parts[parts.length - 1];
    if (last && last.op === op) last.text += text;
    else parts.push({ op, text });
  };
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      push("same", x[i]);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) push("del", x[i++]);
    else push("ins", y[j++]);
  }
  while (i < x.length) push("del", x[i++]);
  while (j < y.length) push("ins", y[j++]);
  return parts.map((p) => (p.op === "same" ? inline(p.text) : `<${p.op}>${inline(p.text)}</${p.op}>`)).join("");
}

function similarity(a: string, b: string): number {
  const x = new Set(tokenize(a).filter((t) => t.trim()));
  const y = new Set(tokenize(b).filter((t) => t.trim()));
  const shared = [...x].filter((t) => y.has(t)).length;
  return shared / Math.max(1, Math.max(x.size, y.size));
}

interface ParsedClaim {
  key: string;
  value: string;
  asOf: string;
  source: string;
  struck: boolean;
  note: string;
}

export function parseClaim(line: string): ParsedClaim | null {
  const c = CLAIM.exec(line);
  return c ? { key: c[2], value: c[3], asOf: c[4], source: c[5], struck: Boolean(c[1]), note: (c[6] ?? "").trim() } : null;
}

/** A claim as a small typeset row: key, value, and where it comes from. */
export function claimHtml(c: ParsedClaim, animateStrike = false): string {
  const value = c.struck || animateStrike ? `<s class="cv-s">${esc(c.value)}</s>` : esc(c.value);
  const note = c.note ? ` <span class="cn">${inline(c.note)}</span>` : "";
  return `<span class="ck">${esc(c.key)}</span><span class="cv">${value}</span><span class="cm">as of ${c.asOf} · <span class="wl">${c.source}</span>${note}</span>`;
}

function kindOf(line: string): Block["kind"] {
  if (line.startsWith("# ")) return "h1";
  if (line.startsWith("## ")) return "h2";
  if (parseClaim(line)) return "claim";
  if (line.startsWith("- ")) return "li";
  return "p";
}

const body = (line: string) => line.replace(/^#{1,2} |^- /, "");

function plainBlock(line: string, change: Change): Block {
  const kind = kindOf(line);
  const c = kind === "claim" ? parseClaim(line) : null;
  return { kind, change, html: c ? claimHtml(c) : inline(body(line)) };
}

/**
 * Turns a page diff into typeset blocks with tracked changes. Front matter is skipped. Within a run of
 * changed lines, a deleted claim that comes back struck through becomes one "strike" block; other
 * deleted and added lines that mostly match become one block with word-level changes.
 */
export function trackedBlocks(diff: DiffLine[]): Block[] {
  // Skip everything up to the second "---" of the new version (the front matter).
  let fences = 0;
  let start = 0;
  for (let k = 0; k < diff.length; k++) {
    if (diff[k].op !== "del" && diff[k].text === "---") fences++;
    if (fences === 2) {
      start = k + 1;
      break;
    }
  }
  const lines = diff.slice(start).filter((d) => d.text.trim() !== "");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].op === "same") {
      blocks.push(plainBlock(lines[i].text, "same"));
      i++;
      continue;
    }
    const dels: string[] = [];
    const adds: string[] = [];
    while (i < lines.length && lines[i].op !== "same") {
      (lines[i].op === "del" ? dels : adds).push(lines[i].text);
      i++;
    }
    const used = new Set<number>();
    const pairOf = new Map<number, number>();
    adds.forEach((add, ai) => {
      const ca = parseClaim(add);
      let best = -1;
      let bestScore = 0.34;
      dels.forEach((del, di) => {
        if (used.has(di)) return;
        const cd = parseClaim(del);
        if (ca && cd && ca.struck && !cd.struck && ca.key === cd.key && ca.value === cd.value) {
          best = di;
          bestScore = 2;
          return;
        }
        if (kindOf(add) !== kindOf(del) || (ca && cd && ca.key !== cd.key)) return;
        const s = similarity(add, del);
        if (s > bestScore) {
          best = di;
          bestScore = s;
        }
      });
      if (best >= 0) {
        used.add(best);
        pairOf.set(ai, best);
      }
    });
    dels.forEach((del, di) => {
      if (!used.has(di)) blocks.push(plainBlock(del, "del"));
    });
    adds.forEach((add, ai) => {
      const di = pairOf.get(ai);
      if (di === undefined) {
        blocks.push(plainBlock(add, "ins"));
        return;
      }
      const del = dels[di];
      const ca = parseClaim(add);
      const cd = parseClaim(del);
      if (ca && cd && ca.struck && !cd.struck) {
        blocks.push({ kind: "claim", change: "strike", html: claimHtml(ca, true) });
      } else {
        blocks.push({ kind: kindOf(add), change: "mod", html: kindOf(add) === "claim" ? claimHtml(ca!) : wordDiff(body(del), body(add)) });
      }
    });
  }
  return blocks;
}

/** The page's front matter, for the small line under its title. */
export function pageMeta(text: string): { type: string; updated: string; sources: number } {
  const m = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
  const get = (k: string) => new RegExp(`^${k}: (.*)$`, "m").exec(m)?.[1] ?? "";
  const sources = get("sources").replace(/^\[|\]$/g, "").split(",").filter((s) => s.trim()).length;
  return { type: get("type"), updated: get("updated"), sources };
}
