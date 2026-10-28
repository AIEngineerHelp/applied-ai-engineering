// Small shared pieces of markup: icons, status pills and labels. No state here.

import { esc } from "./logic.ts";
import type { SetName, Version } from "./types.ts";

export const VERSION_LABEL: Record<Version, string> = { naive: "Naive prompt", hardened: "Hardened prompt" };
export const SET_LABEL: Record<SetName, string> = { seeded: "Seeded attacks", recorded: "First recording" };
export const SET_HINT: Record<SetName, string> = {
  seeded: "Each attack starts from its own example question, persona and tactic. Recorded 2026-10-27.",
  recorded: "All ten attacks share one brief, so they came out nearly identical. Recorded 2026-10-14.",
};

const ICONS: Record<string, string> = {
  shield: '<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/><path d="M9 12l2 2 4-4"/>',
  grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  left: '<path d="M15 6l-6 6 6 6"/>',
  right: '<path d="M9 6l6 6-6 6"/>',
  play: '<path d="M7 5l12 7-12 7z" fill="currentColor"/>',
  bolt: '<path d="M13 3L5 14h6l-1 7 8-11h-6z"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  user: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c1.2-3.5 4-5 7-5s5.8 1.5 7 5"/>',
  bot: '<rect x="5" y="8" width="14" height="11" rx="3"/><path d="M12 4v4M9.5 13h.01M14.5 13h.01"/>',
  book: '<path d="M5 4h9a3 3 0 013 3v13H8a3 3 0 01-3-3z"/><path d="M5 17a3 3 0 013-3h9"/>',
  chart: '<path d="M5 19V5M5 19h14"/><path d="M9 15v-4M13 15V8M17 15v-6"/>',
  home: '<path d="M4 11l8-6 8 6v8a1 1 0 01-1 1h-4v-6h-6v6H5a1 1 0 01-1-1z"/>',
  loop: '<path d="M4 12a8 8 0 0114-5.3L20 9"/><path d="M20 4v5h-5"/><path d="M20 12a8 8 0 01-14 5.3L4 15"/><path d="M4 20v-5h5"/>',
  scale: '<path d="M12 4v16M7 20h10M5 8h14"/><path d="M5 8l-3 6a3 3 0 006 0zM19 8l-3 6a3 3 0 006 0z"/>',
};

export function icon(name: string, size = 16): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}

export const STATUS: Record<string, { label: string; text: string; bg: string; dot: string }> = {
  passed: { label: "Kept the rule", text: "text-pass", bg: "bg-pass-soft", dot: "bg-pass" },
  failed: { label: "Broke the rule", text: "text-fail", bg: "bg-fail-soft", dot: "bg-fail" },
  error: { label: "Errored", text: "text-warn", bg: "bg-warn-soft", dot: "bg-warn" },
  running: { label: "Running", text: "text-accent", bg: "bg-accent-soft", dot: "bg-accent" },
  queued: { label: "Queued", text: "text-ink-3", bg: "bg-sunk", dot: "bg-line-2" },
};

export function pill(status: string, label = STATUS[status].label): string {
  const s = STATUS[status];
  return `<span class="inline-flex items-center gap-1.5 rounded-full ${s.bg} ${s.text} px-2.5 py-0.5 text-xs font-medium whitespace-nowrap"><span class="size-1.5 rounded-full ${s.dot} ${status === "running" ? "animate-pulse" : ""}"></span>${esc(label)}</span>`;
}

/** A compact verdict chip: who said it, and pass or fail. */
export function chip(who: string, passed: boolean | null | undefined): string {
  if (passed == null) return `<span class="inline-flex items-center gap-1 rounded border border-line px-1.5 py-0.5 text-[11px] text-ink-3">${esc(who)} —</span>`;
  return `<span class="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] ${passed ? "bg-pass-soft text-pass" : "bg-fail-soft text-fail"}">${icon(passed ? "check" : "x", 11)}${esc(who)}</span>`;
}

/** Short display names for the judges and the keyword check. */
export function raterName(id: string): string {
  if (id === "keyword") return "Keyword check";
  if (id.endsWith("(second run)")) return `${id.replace(" (second run)", "")}, second run`;
  return id;
}

export function agentShort(name: string): string {
  return name.split(",")[0];
}
