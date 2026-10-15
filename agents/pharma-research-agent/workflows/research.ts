// A research run as a durable workflow. The research itself is a LangGraph
// graph (agent/graph.ts); the workflow keeps it alive. If the function
// running the graph dies, the step is retried, and the graph resumes from its
// last checkpoint instead of starting over.
//   graph (plan → researchers in parallel → writer → checker) → finalize

import { finalizeStep, graphStep } from "./steps";

export async function researchWorkflow(reportId: string) {
  "use workflow";
  try {
    await graphStep(reportId);
    await finalizeStep(reportId, "completed");
  } catch (err) {
    await finalizeStep(reportId, "failed", err instanceof Error ? err.message : String(err));
  }
}
