// The graph schema (data/schema.json) and everything derived from it: the
// structured-output JSON schema sent to Gemini, the schema text used in the
// extraction and text-to-Cypher prompts, and validation. One file, so the
// prompt and the checks cannot drift apart.

import SCHEMA_JSON from "../data/schema.json" with { type: "json" };

export interface RelationRule {
  from: string[];
  to: string[];
  description: string;
  properties: string[];
}
export interface Schema {
  description: string;
  entities: Record<string, string>;
  relations: Record<string, RelationRule>;
  properties: Record<string, string>;
}
export const SCHEMA = SCHEMA_JSON as Schema;
export const ENTITY_TYPES = Object.keys(SCHEMA.entities);
export const RELATION_TYPES = Object.keys(SCHEMA.relations);

export type Properties = Record<string, string | number>;

/** One relation as the extractor returns it: typed ends, a type, optional properties, and the exact quote. */
export interface RawRelation {
  source: string;
  source_type: string;
  relation: string;
  target: string;
  target_type: string;
  properties?: { key: string; value: string }[];
  quote: string;
}
export interface RawExtraction {
  entities: { name: string; type: string }[];
  relations: RawRelation[];
}

/** A relation that passed validation, with its properties as a plain object. */
export interface Triple {
  source: string;
  sourceType: string;
  relation: string;
  target: string;
  targetType: string;
  properties: Properties;
  quote: string;
}
export interface Reject {
  item: RawRelation | { name: string; type: string };
  reason: string;
}

/** The structured-output schema: what Gemini must return for one document. */
export function extractionJsonSchema() {
  return {
    type: "object",
    properties: {
      entities: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "The entity's name exactly as written in the text." },
            type: { type: "string", enum: ENTITY_TYPES },
          },
          required: ["name", "type"],
        },
      },
      relations: {
        type: "array",
        items: {
          type: "object",
          properties: {
            source: { type: "string", description: "Name of the source entity, exactly as in the entities list." },
            source_type: { type: "string", enum: ENTITY_TYPES },
            relation: { type: "string", enum: RELATION_TYPES },
            target: { type: "string", description: "Name of the target entity, exactly as in the entities list." },
            target_type: { type: "string", enum: ENTITY_TYPES },
            properties: {
              type: "array",
              items: {
                type: "object",
                properties: { key: { type: "string", enum: Object.keys(SCHEMA.properties) }, value: { type: "string" } },
                required: ["key", "value"],
              },
            },
            quote: { type: "string", description: "The exact words from the text that state this relation, copied verbatim." },
          },
          required: ["source", "source_type", "relation", "target", "target_type", "quote"],
        },
      },
    },
    required: ["entities", "relations"],
  };
}

/** The schema in plain words, for prompts. */
export function schemaText(): string {
  const ents = Object.entries(SCHEMA.entities).map(([t, d]) => `- ${t}: ${d}`);
  const rels = Object.entries(SCHEMA.relations).map(
    ([t, r]) => `- ${t}: (${r.from.join("|")}) -> (${r.to.join("|")}). ${r.description}${r.properties.length ? ` Properties: ${r.properties.join(", ")}.` : ""}`,
  );
  const props = Object.entries(SCHEMA.properties).map(([k, d]) => `- ${k}: ${d}`);
  return `Entity types:\n${ents.join("\n")}\n\nRelation types:\n${rels.join("\n")}\n\nRelation properties:\n${props.join("\n")}`;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Collapse whitespace and unify quote characters, so a quote can be matched across line breaks. */
export const normQuote = (s: string) => s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();

/** Is `quote` a verbatim span of `text` (ignoring runs of whitespace and curly quotes)? */
export const quoteInText = (quote: string, text: string) => normQuote(quote).length > 0 && normQuote(text).includes(normQuote(quote));

/**
 * Validate one document's extraction against the schema and the source text.
 * Rejected: unknown types, relations whose ends break the schema, relations
 * naming an entity that is not in the entity list, quotes that are not verbatim
 * in the text, and unknown or malformed properties. Exact duplicates are dropped.
 */
export function validateExtraction(x: RawExtraction, text: string): { entities: { name: string; type: string }[]; triples: Triple[]; rejects: Reject[] } {
  const rejects: Reject[] = [];
  const entities: { name: string; type: string }[] = [];
  for (const e of x.entities ?? []) {
    const name = e.name?.trim() ?? "";
    if (!ENTITY_TYPES.includes(e.type)) rejects.push({ item: e, reason: `unknown entity type ${e.type}` });
    else if (!name) rejects.push({ item: e, reason: "empty name" });
    else if (!entities.some((o) => o.name === name && o.type === e.type)) entities.push({ name, type: e.type });
  }
  const triples: Triple[] = [];
  for (const r of x.relations ?? []) {
    const rule = SCHEMA.relations[r.relation];
    if (!rule) {
      rejects.push({ item: r, reason: `unknown relation ${r.relation}` });
      continue;
    }
    if (!rule.from.includes(r.source_type) || !rule.to.includes(r.target_type)) {
      rejects.push({ item: r, reason: `${r.relation} cannot connect a ${r.source_type} to a ${r.target_type}` });
      continue;
    }
    const known = (name: string, type: string) => entities.some((e) => e.name === name.trim() && e.type === type);
    if (!known(r.source, r.source_type) || !known(r.target, r.target_type)) {
      rejects.push({ item: r, reason: "names an entity that is not in the entity list" });
      continue;
    }
    if (!quoteInText(r.quote ?? "", text)) {
      rejects.push({ item: r, reason: "quote is not verbatim in the source" });
      continue;
    }
    const properties: Properties = {};
    let bad = "";
    for (const p of r.properties ?? []) {
      if (!rule.properties.includes(p.key)) bad = `property "${p.key}" is not allowed on ${r.relation}`;
      else if ((p.key === "since" || p.key === "until" || p.key === "date") && !ISO.test(p.value)) bad = `property "${p.key}" is not an ISO date: "${p.value}"`;
      else if (p.key === "units") {
        const n = Number(String(p.value).replace(/,/g, ""));
        if (!Number.isFinite(n)) bad = `property "units" is not a number: "${p.value}"`;
        else properties.units = n;
      } else properties[p.key] = p.value;
      if (bad) break;
    }
    if (bad) {
      rejects.push({ item: r, reason: bad });
      continue;
    }
    const t: Triple = { source: r.source.trim(), sourceType: r.source_type, relation: r.relation, target: r.target.trim(), targetType: r.target_type, properties, quote: r.quote };
    if (!triples.some((o) => o.source === t.source && o.relation === t.relation && o.target === t.target && o.quote === t.quote)) triples.push(t);
  }
  return { entities, triples, rejects };
}
