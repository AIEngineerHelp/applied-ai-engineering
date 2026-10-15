// Starts a research run: validates the question, creates the report, and
// hands it to the durable workflow. Returns immediately with the report id.
import { cookies } from "next/headers";
import { start } from "workflow/api";
import { z } from "zod";
import { json } from "@/lib/access";
import { createReport, markFailed, QUERY_MAX, QUERY_MIN, runsToday, setWorkflowRun } from "@/lib/reports";
import { modelName } from "@/agent/config";
import { WORKSPACE_COOKIE } from "@/lib/workspace-cookie";
import { researchWorkflow } from "@/workflows/research";

const Body = z.object({ query: z.string().trim().min(QUERY_MIN).max(QUERY_MAX), threadId: z.string().regex(/^[a-z0-9]{12}$/).optional() });

export async function POST(request: Request) {
  const workspaceId = (await cookies()).get(WORKSPACE_COOKIE)?.value;
  if (!workspaceId) return json(400, { error: "Your browser blocked the workspace cookie. Enable cookies for this site and try again." });

  // Operator controls: a kill switch and an optional global daily cap (both off by default).
  if (process.env.RESEARCH_ENABLED === "false") return json(503, { error: "New research is paused right now. Existing reports are still available." });
  const cap = Number(process.env.DAILY_RUN_CAP || 0);
  if (cap > 0 && (await runsToday()) >= cap) return json(429, { error: "Today's research capacity is used up. Please try again tomorrow." });

  const parsed = Body.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return json(400, { error: `Write a research question between ${QUERY_MIN} and ${QUERY_MAX} characters.` });

  let report;
  try {
    report = await createReport(workspaceId, parsed.data.query, modelName(), parsed.data.threadId);
  } catch {
    return json(404, { error: "That conversation no longer exists." });
  }
  try {
    const run = await start(researchWorkflow, [report.id]);
    await setWorkflowRun(report.id, run.runId);
  } catch (err) {
    console.error(JSON.stringify({ msg: "workflow start failed", reportId: report.id, error: (err as Error).message }));
    await markFailed(report.id, "The research job could not be started.");
    return json(502, { error: "The research job could not be started. Please try again." });
  }
  return json(201, { id: report.id, threadId: report.threadId });
}
