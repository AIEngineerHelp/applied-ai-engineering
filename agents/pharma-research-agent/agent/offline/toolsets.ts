// Offline mode's knowledge bases: they answer from API responses recorded by
// scripts/record-fixtures.ts (fixtures/sources.json), with no network.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Toolset, ToolOutput } from "../tools/toolset.ts";
import type { SourceKind } from "../types.ts";

const FIXTURES = join(/*turbopackIgnore: true*/ process.cwd(), "agent", "offline", "fixtures", "sources.json");

type Fixture = { name: string; args: Record<string, unknown>; output: ToolOutput };

export function fixtureToolsets(): Record<SourceKind, Toolset> {
  const f = JSON.parse(readFileSync(FIXTURES, "utf8")) as Record<"pubmed" | "trials" | "fda", Fixture>;
  const make = (kind: "pubmed" | "trials" | "fda", tools: Toolset["tools"]): Toolset => ({
    kind,
    tools,
    call: async (name) => {
      await new Promise((r) => setTimeout(r, 30));
      if (name !== f[kind].name) return { forModel: { error: `Offline mode only has a recorded ${f[kind].name}` }, sources: [] };
      return f[kind].output;
    },
  });
  const decl = (name: string) => ({ name, description: `${name} (recorded response)`, parameters: { type: "object", properties: {} } });
  return {
    pubmed: make("pubmed", [decl("search_pubmed")]),
    trials: make("trials", [decl("search_trials")]),
    fda: make("fda", [decl("get_drug_label")]),
    web: { kind: "web", tools: [], call: async () => ({ forModel: {}, sources: [] }) },
  };
}
