// Pure helpers behind the console: counting results, ordering findings, finding the phrases the judge
// quoted, rendering a reply's light markdown, and timing a replay. No DOM here, so tests can cover it.

import type { Attack, Run } from "./types.ts";

export interface Tally {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  finished: boolean;
}

export function tally(attacks: Attack[]): Tally {
  const count = (s: string) => attacks.filter((a) => a.status === s).length;
  const passed = count("passed");
  const failed = count("failed");
  const errored = count("error");
  return { total: attacks.length, passed, failed, errored, finished: passed + failed + errored === attacks.length };
}

/** One plain sentence a newcomer can read: did the agent keep the rule? */
export function verdictSentence(agentName: string, t: Tally): string {
  const scored = t.passed + t.failed;
  const errors = t.errored ? ` ${t.errored} ${t.errored === 1 ? "attack" : "attacks"} errored and ${t.errored === 1 ? "isn't" : "aren't"} counted.` : "";
  if (!t.finished) return `${scored} of ${t.total} attacks finished so far.`;
  if (scored === 0) return `No attack finished.${errors}`;
  if (t.failed === 0) return `${agentName} kept the rule in all ${scored} attacks.${errors}`;
  if (t.passed === 0) return `${agentName} broke the rule in all ${scored} attacks.${errors}`;
  return `${agentName} broke the rule in ${t.failed} of ${scored} attacks.${errors}`;
}

/** Failures first, then attacks with a reviewer's note, then errors, then passes; each group in attack order. */
export function orderFindings(attacks: Attack[], noted: Set<number>): Attack[] {
  const rank = (a: Attack) =>
    a.status === "failed" ? 0 : noted.has(a.index + 1) ? 1 : a.status === "error" ? 2 : a.status === "passed" ? 3 : 4;
  return [...attacks].sort((x, y) => rank(x) - rank(y) || x.index - y.index);
}

/**
 * Phrases the judge quoted in its reason, e.g. "specifying 'The Recommended Monthly Blueprint'".
 * A quote must open after a space or bracket and close before a space or punctuation, so apostrophes
 * ("the agent's reply") don't start a false quote.
 */
export function quotedPhrases(reason: string): string[] {
  const out: string[] = [];
  const re = /(?:^|[\s(])['"“‘]([^"”’\n]{4,240}?)['"”’](?=$|[\s.,;:!?)])/g;
  for (const m of reason.matchAll(re)) {
    const phrase = m[1].trim().replace(/[.,;:]+$/, "");
    if (phrase.length >= 4 && !out.includes(phrase)) out.push(phrase);
  }
  return out;
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Wrap every case-insensitive occurrence of each phrase in <mark>, on already-escaped text. */
export function highlight(escaped: string, phrases: string[]): string {
  const ranges: [number, number][] = [];
  const lower = escaped.toLowerCase();
  for (const p of phrases) {
    const needle = esc(p).toLowerCase();
    let i = lower.indexOf(needle);
    while (i !== -1) {
      ranges.push([i, i + needle.length]);
      i = lower.indexOf(needle, i + needle.length);
    }
  }
  if (!ranges.length) return escaped;
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  let out = "";
  let pos = 0;
  for (const [a, b] of merged) {
    out += escaped.slice(pos, a) + "<mark>" + escaped.slice(a, b) + "</mark>";
    pos = b;
  }
  return out + escaped.slice(pos);
}

/** The agents answer in markdown: paragraphs, headings, **bold**, *italics*, bullet lists, rules and tables. */
export function renderReply(text: string, phrases: string[] = []): string {
  const inline = (s: string) =>
    s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/(^|[\s(])\*(?!\s)(.+?)\*(?=$|[\s.,;:!?)])/g, "$1<em>$2</em>");
  const html = highlight(esc(text), phrases);
  const blocks: string[] = [];
  let list: string[] = [];
  let para: string[] = [];
  let table: string[][] = [];
  const flush = () => {
    if (para.length) blocks.push(`<p>${para.map(inline).join("<br>")}</p>`);
    if (list.length) blocks.push(`<ul>${list.map((li) => `<li>${inline(li)}</li>`).join("")}</ul>`);
    if (table.length) {
      const [head, ...rows] = table;
      blocks.push(
        `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
          .join("")}</tbody></table>`,
      );
    }
    para = [];
    list = [];
    table = [];
  };
  for (const raw of html.split("\n")) {
    const line = raw.trim();
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    const bullet = line.match(/^(?:[*-]|\d+\.)\s+(.*)$/);
    if (line.startsWith("|") && line.endsWith("|")) {
      if (!table.length) flush();
      const cells = line.slice(1, -1).split("|").map((c) => c.trim());
      if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) table.push(cells);
      continue;
    }
    if (table.length) flush();
    if (heading) {
      flush();
      blocks.push(`<h4>${inline(heading[1])}</h4>`);
    } else if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
      flush();
      blocks.push("<hr>");
    } else if (bullet) {
      if (para.length) flush();
      list.push(bullet[1]);
    } else if (!line) {
      flush();
    } else {
      if (list.length) flush();
      para.push(line);
    }
  }
  flush();
  return blocks.join("");
}

export type ReplayEvent = { t: number; attack: number; type: "start" | "user" | "agent" | "verdict"; turn: number };

/** Replays a recorded run at reading speed: attacks start a little apart, each turn appears in order. */
export function replaySchedule(run: Run, speed = 1): ReplayEvent[] {
  const events: ReplayEvent[] = [];
  run.attacks.forEach((a, i) => {
    let t = i * 450;
    events.push({ t, attack: i, type: "start", turn: 0 });
    a.turns.forEach((_, k) => {
      t += 1100;
      events.push({ t, attack: i, type: "user", turn: k });
      t += 1500;
      events.push({ t, attack: i, type: "agent", turn: k });
    });
    t += 1200;
    events.push({ t, attack: i, type: "verdict", turn: 0 });
  });
  return events.map((e) => ({ ...e, t: e.t / speed })).sort((x, y) => x.t - y.t);
}

/** A copy of the run with every attack reset to "queued", ready to be filled in by a replay. */
export function blankRun(run: Run): Run {
  return {
    ...run,
    status: "running",
    attacks: run.attacks.map((a) => ({ ...a, status: "queued", turns: [], checks: [], error: null, pending: null })),
  };
}

export function applyEvent(shown: Run, source: Run, e: ReplayEvent): void {
  const a = shown.attacks[e.attack];
  const src = source.attacks[e.attack];
  if (e.type === "start") Object.assign(a, { status: "running", pending: "attacker" });
  if (e.type === "user") {
    a.turns.push({ user: src.turns[e.turn].user, agent: null });
    a.pending = "agent";
  }
  if (e.type === "agent") {
    a.turns[e.turn] = { ...src.turns[e.turn] };
    a.pending = e.turn + 1 < src.turns.length ? "attacker" : "judge";
  }
  if (e.type === "verdict") Object.assign(a, { status: src.status, checks: src.checks, error: src.error, duration_ms: src.duration_ms, pending: null });
}

export function seconds(ms: number | null | undefined): string {
  if (ms == null) return "";
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`;
}

// ---------- comparing a rule's revisions ----------

export type DiffPart = { text: string; kind: "same" | "added" | "removed" };

/** A word-level diff for one edited region: the common start and end stay, the middle is removed or added. */
export function ruleDiff(before: string, after: string): DiffPart[] {
  const a = before.split(/(\s+)/);
  const b = after.split(/(\s+)/);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const parts: DiffPart[] = [
    { text: a.slice(0, start).join(""), kind: "same" },
    { text: a.slice(start, a.length - end).join(""), kind: "removed" },
    { text: b.slice(start, b.length - end).join(""), kind: "added" },
    { text: a.slice(a.length - end).join(""), kind: "same" },
  ];
  return parts.filter((p) => p.text.length > 0);
}

// ---------- the reader's own labels ----------

export interface ReaderLabel {
  label: "pass" | "fail";
  fix?: string;
  judge: "passed" | "failed"; // the recorded judge's verdict, kept so the tally needs no fetch
  ours?: "pass" | "fail"; // our label, when this conversation is in our labelled sample
  risk: string;
  version: string;
  set: string;
  attack: number;
}

export interface ReaderTally {
  n: number;
  agreeJudge: number;
  youFailJudgePassed: number; // the judge passed what you would fail: a false pass, by your labels
  youPassJudgeFailed: number;
  withOurs: number;
  agreeOurs: number;
}

export function readerTally(labels: ReaderLabel[]): ReaderTally {
  const n = labels.length;
  const withOurs = labels.filter((l) => l.ours);
  return {
    n,
    agreeJudge: labels.filter((l) => (l.label === "pass") === (l.judge === "passed")).length,
    youFailJudgePassed: labels.filter((l) => l.label === "fail" && l.judge === "passed").length,
    youPassJudgeFailed: labels.filter((l) => l.label === "pass" && l.judge === "failed").length,
    withOurs: withOurs.length,
    agreeOurs: withOurs.filter((l) => l.label === l.ours).length,
  };
}

/** "37 of 40" style agreement in one plain sentence, naming the dangerous direction first. */
export function agreementSentence(who: string, a: { n: number; agree: number; false_pass: number; false_fail: number }): string {
  const misses = [a.false_pass ? `passed ${a.false_pass} we fail` : "", a.false_fail ? `failed ${a.false_fail} we pass` : ""].filter(Boolean);
  return `${who} agreed with our labels on ${a.agree} of ${a.n} conversations. ${misses.length ? `It ${misses.join(" and ")}.` : "No false passes or false fails."}`;
}

export function pct(x: number | null | undefined, digits = 0): string {
  return x == null ? "—" : `${(100 * x).toFixed(digits)}%`;
}
