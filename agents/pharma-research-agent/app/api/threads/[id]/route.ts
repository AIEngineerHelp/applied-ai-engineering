// A whole conversation: every turn's snapshot, in order (owner or share link).
import { cookies } from "next/headers";
import { json } from "@/lib/access";
import { getThread, reportSnapshot, type Access } from "@/lib/reports";
import { WORKSPACE_COOKIE } from "@/lib/workspace-cookie";

export async function GET(request: Request, ctx: RouteContext<"/api/threads/[id]">) {
  const { id } = await ctx.params;
  const share = new URL(request.url).searchParams.get("share");
  const ws = (await cookies()).get(WORKSPACE_COOKIE)?.value;
  const access: Access | null = share ? { shareId: share } : ws ? { workspaceId: ws } : null;
  if (!access) return json(404, { error: "Conversation not found" });
  const turns = await getThread(id, access);
  if (!turns.length) return json(404, { error: "Conversation not found" });
  return json(200, { turns: await Promise.all(turns.map((t) => reportSnapshot(t, "workspaceId" in access ? access.workspaceId : undefined))) });
}
