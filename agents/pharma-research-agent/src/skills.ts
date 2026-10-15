// The skills layer. Each skill is a markdown playbook with a short front
// matter. The orchestrator only ever sees names and descriptions; a skill's
// full body is loaded into a sub-agent's prompt when the plan assigns it.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface Skill {
  name: string;
  description: string;
  /** The knowledge base this skill is written for, or "synthesis". */
  source: string;
  body: string;
}

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "skills");

/** Parses `---\nkey: value\n---\nbody`. */
export function parseSkill(text: string): Skill {
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error("Skill file needs front matter between --- lines");
  const meta = Object.fromEntries(
    m[1]
      .split("\n")
      .map((line) => line.match(/^(\w+):\s*(.*)$/))
      .filter((x): x is RegExpMatchArray => !!x)
      .map((x) => [x[1], x[2].trim()]),
  );
  if (!meta.name || !meta.description) throw new Error("Skill front matter needs name and description");
  return { name: meta.name, description: meta.description, source: meta.source ?? "", body: m[2].trim() };
}

export function loadSkills(dir = DIR): Skill[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => parseSkill(readFileSync(join(dir, f), "utf8")));
}

/** What the orchestrator sees: one line per skill. */
export function skillIndex(skills: Skill[]): string {
  return skills.map((s) => `- ${s.name} (${s.source}): ${s.description}`).join("\n");
}
