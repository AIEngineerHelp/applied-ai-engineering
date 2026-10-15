import "server-only";
import { cookies } from "next/headers";
import { getReport, type Access } from "./reports";
import { WORKSPACE_COOKIE } from "./workspace-cookie";

/** Owner (workspace cookie) or share-link access to one report, for API routes. */
export async function reportAccess(id: string, request: Request) {
  const share = new URL(request.url).searchParams.get("share");
  const ws = (await cookies()).get(WORKSPACE_COOKIE)?.value;
  const tries: Access[] = [];
  if (ws) tries.push({ workspaceId: ws });
  if (share) tries.push({ shareId: share });
  for (const a of tries) {
    const row = await getReport(id, a);
    if (row) return { row, owner: "workspaceId" in a, workspaceId: ws };
  }
  return null;
}

export const json = (status: number, body: unknown) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
