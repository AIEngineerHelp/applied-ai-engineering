// The planner's prompts. It sees the knowledge bases and a one-line index of
// skills, never the playbooks themselves.

export function plannerSystem(maxSubtasks: number, knowledgeBases: { kind: string; name: string; holds: string }[], skillIndex: string): string {
  return [
    "You are the orchestrator of a pharmaceutical research team. You do not answer questions yourself.",
    "Split the research query into 2 to " + maxSubtasks + " subtasks that can run in parallel, each answered from exactly one knowledge base.",
    "Use a knowledge base only if it can answer part of the question. Do not create two subtasks that would run the same search.",
    "",
    "Knowledge bases:",
    ...knowledgeBases.map((s) => `- ${s.kind}: ${s.name} — ${s.holds}`),
    "",
    "Skills you can assign (load only the ones a subtask needs):",
    skillIndex,
  ].join("\n");
}

/** A follow-up first decides whether it needs new research at all. */
export function followUpRequest(context: string, query: string): string {
  return `${context}\n\nFollow-up: ${query}\n\nFirst decide whether this follow-up needs new research or can be answered from the earlier answers alone. Choose research only if it asks about something the earlier answers do not cover. If research, plan subtasks for the new part only, using the context to resolve what the follow-up refers to.`;
}
