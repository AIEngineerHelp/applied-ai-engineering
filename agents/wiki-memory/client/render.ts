// Small HTML helpers: escaping, one-line markdown styling, and the diff view.
// Pure functions of their input, so tests can check them without a browser.

import type { DiffLine } from "../src/diff.ts";

export const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface Highlight {
  pattern: string;
  tone: "good" | "bad";
}

/** Wraps matches of each highlight pattern in a span. Runs on escaped text; patterns only match plain words. */
function highlight(html: string, highlights: Highlight[]): string {
  let out = html;
  for (const h of highlights) {
    const re = new RegExp(h.pattern, "gi");
    out = out.replace(re, (m) => `<mark class="hit-${h.tone}">${m}</mark>`);
  }
  return out;
}

/** Styles one line of markdown as it appears in a wiki page or a raw source. */
export function mdLine(line: string, highlights: Highlight[] = []): string {
  if (/^---$/.test(line) || /^(type|summary|sources|updated): /.test(line)) {
    return `<span class="md-meta">${esc(line)}</span>`;
  }
  if (/^#{1,3} /.test(line)) return `<span class="md-h">${esc(line)}</span>`;
  let html = esc(line);
  html = highlight(html, highlights);
  html = html.replace(/~~(.+?)~~/g, '<span class="md-struck">~~$1~~</span>');
  html = html.replace(/\[\[([a-z0-9-]+)\]\]/g, '<span class="md-link">[[$1]]</span>');
  html = html.replace(/`([^`]+)`/g, '<span class="md-code">`$1`</span>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong class="font-semibold">**$1**</strong>');
  return html;
}

const SIGN = { add: "+", del: "−", same: " " } as const;

/**
 * Renders a diff. Runs of unchanged lines longer than 2 * context + 1 fold into a single row, so a
 * change in a long page stays visible. Pass context = Infinity to show everything.
 */
export function diffHtml(diff: DiffLine[], context = 2): string {
  const rows: string[] = [];
  let i = 0;
  while (i < diff.length) {
    if (diff[i].op !== "same") {
      rows.push(lineRow(diff[i]));
      i++;
      continue;
    }
    let j = i;
    while (j < diff.length && diff[j].op === "same") j++;
    const run = diff.slice(i, j);
    const head = i === 0 ? 0 : context;
    const tail = j === diff.length ? 0 : context;
    if (run.length > head + tail + 1) {
      run.slice(0, head).forEach((d) => rows.push(lineRow(d)));
      const hidden = run.length - head - tail;
      rows.push(`<div class="ln-fold">⋯ ${hidden} unchanged line${hidden === 1 ? "" : "s"}</div>`);
      run.slice(run.length - tail).forEach((d) => rows.push(lineRow(d)));
    } else {
      run.forEach((d) => rows.push(lineRow(d)));
    }
    i = j;
  }
  return rows.join("");
}

function lineRow(d: DiffLine): string {
  return `<div class="ln" data-op="${d.op}"><span class="ln-sign">${SIGN[d.op]}</span><span class="ln-text">${mdLine(d.text) || "&nbsp;"}</span></div>`;
}

/** Renders text lines, marking the ones in `fresh` as new. */
export function linesHtml(text: string, fresh: Set<string> = new Set()): string {
  return text
    .replace(/\n$/, "")
    .split("\n")
    .map((l) => `<div class="ln" ${fresh.has(l) && l.trim() ? 'data-hl="true"' : ""}><span class="ln-text">${mdLine(l) || "&nbsp;"}</span></div>`)
    .join("");
}
