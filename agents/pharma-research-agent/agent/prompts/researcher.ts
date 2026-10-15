// A research sub-agent's prompts: its role, its turn budget, and the
// playbooks of the skills it was assigned.

import type { Skill } from "../skills/index.ts";
import type { Subtask } from "../types.ts";

export function researcherSystem(knowledgeBase: string, maxTurns: number, playbooks: Skill[]): string {
  return [
    `You are a research sub-agent on a pharmaceutical research team. Your knowledge base is ${knowledgeBase}.`,
    "Answer only your subtask, only from what the tools return. Cite source ids exactly as the tools give them.",
    `You have at most ${maxTurns} turns. Search, read what matters, then call finish.`,
    ...playbooks.map((p) => `\n## Skill: ${p.name}\n${p.body}`),
  ].join("\n");
}

export const subtaskMessage = (task: Subtask) => `Subtask: ${task.question}\nWhy it matters: ${task.why}`;

/** Added for the web sub-agent, whose sources come from grounding metadata instead of citations. */
export const WEB_INSTRUCTIONS = "Search the web, then answer in plain prose. Do not write citations; the sources you used are recorded automatically.";

/** When the model answers without calling a tool. */
export const NUDGE = "Use a tool, or call finish with what you have.";

/** Attached to the tool results before the last turn. */
export const LAST_TURN = "Last turn: call finish now, citing the source ids you have.";
