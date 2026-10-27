// The hand-written gold entity list (data/gold-entities.json): every real entity
// in the corpus and the names that refer to it. Used only to evaluate the
// pipeline (false merges, false splits, extraction agreement), never to build it.

import GOLD from "../data/gold-entities.json" with { type: "json" };

export interface GoldEntity {
  type: string;
  name: string;
  aliases: string[];
}
export const GOLD_ENTITIES = GOLD as GoldEntity[];

/** Lower case, hyphens and slashes to spaces, other punctuation removed, a leading "the" dropped. */
export const normName = (s: string) =>
  s
    .toLowerCase()
    .replace(/[-_/]/g, " ")
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^the /, "");

const byAlias = new Map<string, GoldEntity[]>();
for (const g of GOLD_ENTITIES)
  for (const a of g.aliases) {
    const k = normName(a);
    const list = byAlias.get(k) ?? [];
    if (!list.includes(g)) byAlias.set(k, [...list, g]);
  }

/** The gold entity a surface name refers to, or null if it matches none (or is ambiguous). Type must agree. */
export function goldOf(name: string, type: string): GoldEntity | null {
  const hits = (byAlias.get(normName(name)) ?? []).filter((g) => g.type === type);
  return hits.length === 1 ? hits[0] : null;
}

/** The gold entity by name alone, ignoring the extracted type (to spot type errors). */
export function goldAnyType(name: string): GoldEntity | null {
  const hits = byAlias.get(normName(name)) ?? [];
  return hits.length === 1 ? hits[0] : null;
}
