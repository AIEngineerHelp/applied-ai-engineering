// Turn a report's public, read-only share link on or off (owner only).
import { cookies } from "next/headers";
import { z } from "zod";
import { json } from "@/lib/access";
import { setSharing } from "@/lib/reports";
import { WORKSPACE_COOKIE } from "@/lib/workspace-cookie";

export async function POST(request: Request, ctx: RouteContext<"/api/reports/[id]/share">) {
  const { id } = await ctx.params;
  const ws = (await cookies()).get(WORKSPACE_COOKIE)?.value;
  const body = z.object({ on: z.boolean() }).safeParse(await request.json().catch(() => ({})));
  if (!ws || !body.success) return json(400, { error: "Bad request" });
  try {
    const shareId = await setSharing(id, ws, body.data.on);
    return json(200, { shareId });
  } catch {
    return json(404, { error: "Report not found" });
  }
}
