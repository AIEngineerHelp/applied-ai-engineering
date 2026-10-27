// Entity resolution: decide which extracted names refer to the same thing.
//
// Extractors see one chunk at a time, so the same company comes back as
// "Varnell Semi", "Varnell" and "Varnell Semiconductor". Without resolution
// the graph gets three disconnected nodes and every multi-hop path through
// them breaks. The rules here are deliberately simple and conservative:
//
//   1. Only names of the same entity type can merge.
//   2. Two names merge when they are equal after normalizing case and
//      punctuation ("Atlas 3" = "Atlas-3"), or when every word of the shorter
//      name is the start of the matching word in the longer one ("Varnell
//      Semi" → "Varnell Semiconductor", "T. Berg" → "Tomas Berg").
//   3. A name that matches more than one entity is left alone and reported as
//      ambiguous rather than guessed.
//
// Production systems add embedding similarity and an LLM or human check for
// borderline pairs; see the README.

import type { EntityType, Extraction, Properties } from "./schema.ts";

export type MergeReason = "same name after normalizing" | "abbreviation or initial";

export interface Entity {
  id: string;
  name: string; // canonical name: the most complete form seen
  type: EntityType;
  aliases: string[]; // every other surface form merged into this entity
  merges: { alias: string; reason: MergeReason }[];
  mentions: { document: string; name: string }[];
  properties: Properties;
}

export interface Resolution {
  entities: Entity[];
  /** `${type}|${surface name}` → entity id */
  index: Map<string, string>;
  ambiguous: { name: string; type: EntityType; candidates: string[] }[];
}

export const tokens = (name: string): string[] =>
  name
    .toLowerCase()
    .replace(/[-_/]/g, " ")
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .split(/\s+/)
    .filter(Boolean);

export const slug = (name: string) => tokens(name).join("-");

/** Why `a` and `b` name the same entity, or null if they don't. */
export function sameEntity(a: string, b: string): MergeReason | null {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.join(" ") === tb.join(" ")) return "same name after normalizing";
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  if (short.length === 0) return null;
  // Every word of the short name must start the word in the same position of
  // the long one. Numbers must match exactly, so PM-1 never merges with PM-2.
  const ok = short.every((w, i) => (/^\d+$/.test(w) ? long[i] === w : long[i].startsWith(w)));
  return ok ? "abbreviation or initial" : null;
}

const key = (type: string, name: string) => `${type}|${name}`;

export function resolve(extractions: Extraction[]): Resolution {
  // Every distinct (type, surface form), with where it was mentioned.
  const forms = new Map<string, { name: string; type: EntityType; mentions: Entity["mentions"]; properties: Properties }>();
  for (const x of extractions) {
    for (const e of x.entities) {
      const k = key(e.type, e.name);
      const form = forms.get(k) ?? { name: e.name, type: e.type, mentions: [], properties: {} };
      form.mentions.push({ document: x.document, name: e.name });
      Object.assign(form.properties, e.properties ?? {});
      forms.set(k, form);
    }
  }

  // Most complete names first, so they become the canonical names and the
  // shorter forms are compared against them. The order is fully determined,
  // so the result never depends on the order of the documents.
  const ordered = [...forms.values()].sort(
    (a, b) =>
      tokens(b.name).length - tokens(a.name).length ||
      b.name.length - a.name.length ||
      b.mentions.length - a.mentions.length ||
      a.name.localeCompare(b.name),
  );

  const entities: Entity[] = [];
  const index = new Map<string, string>();
  const ambiguous: Resolution["ambiguous"] = [];
  for (const form of ordered) {
    const candidates = entities
      .filter((e) => e.type === form.type)
      .map((e) => ({ e, reason: sameEntity(form.name, e.name) }))
      .filter((c): c is { e: Entity; reason: MergeReason } => c.reason !== null);
    if (candidates.length === 1) {
      const { e, reason } = candidates[0];
      e.aliases.push(form.name);
      e.merges.push({ alias: form.name, reason });
      e.mentions.push(...form.mentions);
      for (const [p, v] of Object.entries(form.properties)) if (!(p in e.properties)) e.properties[p] = v;
      index.set(key(form.type, form.name), e.id);
      continue;
    }
    if (candidates.length > 1) {
      ambiguous.push({ name: form.name, type: form.type, candidates: candidates.map((c) => c.e.name) });
    }
    let id = slug(form.name);
    while (entities.some((e) => e.id === id)) id += "-2";
    entities.push({ id, name: form.name, type: form.type, aliases: [], merges: [], mentions: [...form.mentions], properties: { ...form.properties } });
    index.set(key(form.type, form.name), id);
  }
  return { entities, index, ambiguous };
}

export const lookup = (r: Resolution, type: string, name: string) => r.index.get(key(type, name));
