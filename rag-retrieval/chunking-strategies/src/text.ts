// Range helpers. A range is [start, end) in the source text, so every chunk
// can point back to exactly where it came from.

import type { Range } from "./types.ts";

// Trim whitespace from both ends of a range.
export function trimRange(text: string, [s, e]: Range): Range {
  while (s < e && /\s/.test(text[s])) s++;
  while (e > s && /\s/.test(text[e - 1])) e--;
  return [s, e];
}

// Merge overlapping or touching ranges (sorted output).
export function mergeRanges(ranges: Range[]): Range[] {
  const sorted = ranges.map((r): Range => [r[0], r[1]]).sort((a, b) => a[0] - b[0]);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push(r);
  }
  return out;
}
