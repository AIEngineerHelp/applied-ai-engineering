// Knowledge base 3: openFDA (https://open.fda.gov/apis/). Drug labels and
// FAERS adverse-event report counts. No key: 240 requests a minute, 1,000 a
// day per IP (OPENFDA_API_KEY raises the daily limit). "No matches" is a 404.

import type { Source } from "../types.ts";
import { clip, getJson, limiter, type Toolset } from "./toolset.ts";

const BASE = "https://api.fda.gov/drug";

const first = (v: unknown) => (Array.isArray(v) ? v.join(" ") : typeof v === "string" ? v : "");

/** The fields of an openFDA drug label this example reads; text sections are arrays of strings. */
export interface LabelJson {
  id?: string;
  set_id?: string;
  effective_time?: string;
  openfda?: { generic_name?: string[]; brand_name?: string[] };
  boxed_warning?: string[];
  indications_and_usage?: string[];
  warnings_and_cautions?: string[];
  warnings?: string[];
  adverse_reactions?: string[];
  contraindications?: string[];
}

export function labelToSource(label: LabelJson): Source {
  const generic = (label.openfda?.generic_name ?? []).join(", ");
  const brand = (label.openfda?.brand_name ?? []).join(", ");
  const sections: [string, string][] = [
    ["Boxed warning", first(label.boxed_warning)],
    ["Indications and usage", first(label.indications_and_usage)],
    ["Warnings and precautions", first(label.warnings_and_cautions) || first(label.warnings)],
    ["Adverse reactions", first(label.adverse_reactions)],
    ["Contraindications", first(label.contraindications)],
  ];
  const effective = String(label.effective_time ?? "");
  return {
    id: `FDA:${label.set_id ?? label.id}`,
    kind: "fda",
    title: `FDA label: ${brand || generic} (${generic})`,
    url: label.set_id ? `https://dailymed.nlm.nih.gov/dailymed/search.cfm?query=${encodeURIComponent(label.set_id)}` : "https://open.fda.gov/apis/drug/label/",
    text: sections.filter(([, t]) => t).map(([h, t]) => `${h}: ${clip(t, 8000)}`).join("\n\n"),
    meta: { generic, brand, effective: effective ? `${effective.slice(0, 4)}-${effective.slice(4, 6)}-${effective.slice(6, 8)}` : undefined, boxed_warning: !!label.boxed_warning },
  };
}

export function fdaToolset(): Toolset {
  const wait = limiter(3);
  const key = () => (process.env.OPENFDA_API_KEY ? `&api_key=${encodeURIComponent(process.env.OPENFDA_API_KEY)}` : "");
  return {
    kind: "fda",
    tools: [
      {
        name: "get_drug_label",
        description: "Get the current FDA label for a drug by generic name: boxed warning, indications, warnings and precautions, adverse reactions, contraindications.",
        parameters: { type: "object", properties: { generic_name: { type: "string", description: "Generic name, e.g. semaglutide." } }, required: ["generic_name"] },
      },
      {
        name: "count_adverse_events",
        description: "Count FAERS adverse-event reports by reaction for a drug. Counts are reports, not incidence.",
        parameters: {
          type: "object",
          properties: {
            generic_name: { type: "string" },
            top: { type: "integer", minimum: 5, maximum: 25, description: "How many reactions (default 15)." },
          },
          required: ["generic_name"],
        },
      },
    ],
    async call(name, args) {
      const drug = String(args.generic_name ?? "").toLowerCase().replace(/"/g, "");
      if (name === "get_drug_label") {
        await wait();
        const data = (await getJson(`${BASE}/label.json?search=openfda.generic_name:"${encodeURIComponent(drug)}"&limit=1${key()}`)) as { results?: LabelJson[] } | null;
        const label = data?.results?.[0];
        if (!label) return { forModel: { found: false, note: `No FDA label found for ${drug}.` }, sources: [] };
        const s = labelToSource(label);
        return { forModel: { found: true, id: s.id, title: s.title, effective: s.meta.effective, label: clip(s.text, 2500) }, sources: [s] };
      }
      if (name === "count_adverse_events") {
        const top = Math.min(25, Math.max(5, Number(args.top) || 15));
        await wait();
        const data = (await getJson(`${BASE}/event.json?search=patient.drug.openfda.generic_name:"${encodeURIComponent(drug)}"&count=patient.reaction.reactionmeddrapt.exact&limit=${top}${key()}`)) as {
          results?: { term: string; count: number }[];
        } | null;
        const rows = data?.results ?? [];
        if (!rows.length) return { forModel: { found: false, note: `No FAERS reports found for ${drug}.` }, sources: [] };
        const s: Source = {
          id: `FAERS:${drug.replace(/\s+/g, "-")}`,
          kind: "fda",
          title: `FAERS adverse-event report counts: ${drug}`,
          url: "https://open.fda.gov/apis/drug/event/",
          text: `Most-reported reactions for ${drug} in FAERS (report counts, not incidence; reports are voluntary and depend on use and reporting):\n${rows.map((r) => `${r.term}: ${r.count}`).join("\n")}`,
          meta: { reactions: rows.length },
        };
        return { forModel: { id: s.id, caveat: "Counts are reports, not incidence.", reactions: rows }, sources: [s] };
      }
      throw new Error(`Unknown tool ${name}`);
    },
  };
}
