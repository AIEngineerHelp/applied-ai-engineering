// The graph schema (ontology) for the sample corpus: which kinds of node and
// relationship the extractor may produce, and which node types each
// relationship may connect. Extraction output that breaks it is rejected by
// validateExtraction(), the same job strict_mode does in LangChain's
// LLMGraphTransformer or SchemaLLMPathExtractor in LlamaIndex.

export const ENTITY_TYPES = ["Person", "Team", "Service", "Product", "Component", "Company", "Customer"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const RELATION_TYPES = {
  LEADS: { from: ["Person"], to: ["Team"], reads: "leads" },
  OWNS: { from: ["Team"], to: ["Service", "Product"], reads: "owns" },
  CONNECTS_VIA: { from: ["Product"], to: ["Service"], reads: "connects via" },
  PART_OF: { from: ["Component"], to: ["Product"], reads: "is part of" },
  SUPPLIES: { from: ["Company"], to: ["Component"], reads: "supplies" },
  REPLACES: { from: ["Component"], to: ["Component"], reads: "replaces" },
  USES: { from: ["Customer"], to: ["Product"], reads: "uses" },
  DELAYED: { from: ["Company"], to: ["Component"], reads: "delayed" },
} as const satisfies Record<string, { from: readonly EntityType[]; to: readonly EntityType[]; reads: string }>;
export type RelationType = keyof typeof RELATION_TYPES;

export type Properties = Record<string, string | number | boolean>;

/** One document's extraction result, as an LLM returns it (before resolution). */
export interface Extraction {
  document: string;
  source: "fixture" | "gemini";
  model?: string;
  note?: string;
  entities: { name: string; type: EntityType; properties?: Properties }[];
  relations: { source: string; type: RelationType; target: string; properties?: Properties; evidence: string }[];
}

/** JSON Schema sent to Gemini as the structured-output format (live mode). */
export const EXTRACTION_JSON_SCHEMA = {
  type: "object",
  properties: {
    entities: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "The entity exactly as written in the text." },
          type: { type: "string", enum: [...ENTITY_TYPES] },
          properties: { type: "object", description: "Optional facts about the entity, e.g. {\"battery_life\": \"five years\"}." },
        },
        required: ["name", "type"],
      },
    },
    relations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          source: { type: "string", description: "Name of an entity in the entities list." },
          type: { type: "string", enum: Object.keys(RELATION_TYPES) },
          target: { type: "string", description: "Name of an entity in the entities list." },
          properties: { type: "object" },
          evidence: { type: "string", description: "The exact span of text that states this relation." },
        },
        required: ["source", "type", "target", "evidence"],
      },
    },
  },
  required: ["entities", "relations"],
} as const;

/** Problems with an extraction: unknown types, dangling names, schema violations, evidence not in the text. */
export function validateExtraction(x: Extraction, text: string): string[] {
  const problems: string[] = [];
  const types = new Map<string, EntityType>();
  for (const e of x.entities) {
    if (!(ENTITY_TYPES as readonly string[]).includes(e.type)) problems.push(`unknown entity type ${e.type} for "${e.name}"`);
    if (!text.includes(e.name)) problems.push(`entity "${e.name}" does not appear in the text`);
    types.set(e.name, e.type);
  }
  for (const r of x.relations) {
    const rule = RELATION_TYPES[r.type as RelationType];
    if (!rule) {
      problems.push(`unknown relation type ${r.type}`);
      continue;
    }
    const s = types.get(r.source);
    const t = types.get(r.target);
    if (!s) problems.push(`relation source "${r.source}" is not an extracted entity`);
    if (!t) problems.push(`relation target "${r.target}" is not an extracted entity`);
    if (s && !(rule.from as readonly string[]).includes(s)) problems.push(`${r.type} cannot start at a ${s}`);
    if (t && !(rule.to as readonly string[]).includes(t)) problems.push(`${r.type} cannot end at a ${t}`);
    if (!text.includes(r.evidence)) problems.push(`evidence for ${r.source} ${r.type} ${r.target} is not in the text`);
  }
  return problems;
}
