// A reader's feedback on one of their answers: thumbs up or down, with an
// optional comment. Owner only; shared links are read-only. Comments are
// redacted like questions, so personal data is never stored.
import { cookies } from "next/headers";
import { z } from "zod";
import { redactPII } from "@/agent/guardrails/pii";
import { json } from "@/lib/access";
import { setFeedback } from "@/lib/reports";
import { WORKSPACE_COOKIE } from "@/lib/workspace-cookie";

const Body = z.object({ rating: z.enum(["up", "down"]).nullable(), comment: z.string().trim().max(1000).optional() });

export async function POST(request: Request, ctx: RouteContext<"/api/reports/[id]/feedback">) {
  const { id } = await ctx.params;
  const ws = (await cookies()).get(WORKSPACE_COOKIE)?.value;
  const body = Body.safeParse(await request.json().catch(() => ({})));
  if (!ws || !body.success) return json(400, { error: "Bad request" });
  const comment = body.data.comment ? redactPII(body.data.comment).text : undefined;
  const ok = await setFeedback(id, ws, body.data.rating, comment);
  return ok ? json(200, { ok: true }) : json(404, { error: "Report not found" });
}
