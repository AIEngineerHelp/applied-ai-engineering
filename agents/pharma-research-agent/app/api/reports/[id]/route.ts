// Read (owner or share link) or delete (owner) one report.
import { cookies } from "next/headers";
import { reportAccess, json } from "@/lib/access";
import { deleteThread, reportSnapshot } from "@/lib/reports";
import { WORKSPACE_COOKIE } from "@/lib/workspace-cookie";

export async function GET(request: Request, ctx: RouteContext<"/api/reports/[id]">) {
  const { id } = await ctx.params;
  const access = await reportAccess(id, request);
  if (!access) return json(404, { error: "Report not found" });
  return json(200, await reportSnapshot(access.row));
}

export async function DELETE(_request: Request, ctx: RouteContext<"/api/reports/[id]">) {
  const { id } = await ctx.params;
  const ws = (await cookies()).get(WORKSPACE_COOKIE)?.value;
  if (!ws) return json(404, { error: "Report not found" });
  // Deleting a conversation removes every turn in it; `id` is the thread id.
  return (await deleteThread(id, ws)) ? json(200, { deleted: true }) : json(404, { error: "Report not found" });
}
