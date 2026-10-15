// A research run as a durable workflow: if the function running it dies, the
// run resumes from the last completed step instead of starting over.
//   plan → research sub-agents in parallel → synthesis → evals → finalize
// A follow-up the planner can answer from earlier turns has no subtasks, so it
// goes straight from plan to synthesis.

import { evalStep, finalizeStep, planStep, researchStep, synthesisStep } from "./steps";

export async function researchWorkflow(reportId: string) {
  "use workflow";
  try {
    const { plan, t0 } = await planStep(reportId);
    const findings = await Promise.all(plan.subtasks.map((task) => researchStep(reportId, task, t0)));
    const report = await synthesisStep(reportId, plan, t0);
    await evalStep(reportId, plan, findings, report, t0);
    await finalizeStep(reportId, "completed");
  } catch (err) {
    await finalizeStep(reportId, "failed", err instanceof Error ? err.message : String(err));
  }
}
