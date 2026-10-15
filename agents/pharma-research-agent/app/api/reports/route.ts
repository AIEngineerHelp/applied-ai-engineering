// This workspace's reports, newest first (for the sidebar).
import { cookies } from "next/headers";
import { json } from "@/lib/access";
import { listReports } from "@/lib/reports";
import { WORKSPACE_COOKIE } from "@/lib/workspace-cookie";

export async function GET() {
  const ws = (await cookies()).get(WORKSPACE_COOKIE)?.value;
  if (!ws) return json(200, []);
  return json(200, await listReports(ws));
}
