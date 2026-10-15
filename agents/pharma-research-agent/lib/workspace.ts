import "server-only";
import { cookies } from "next/headers";
import { WORKSPACE_COOKIE } from "./workspace-cookie";

/** The current browser's workspace id (set by proxy.ts). */
export async function workspaceId(): Promise<string> {
  const id = (await cookies()).get(WORKSPACE_COOKIE)?.value;
  if (!id || !/^[a-f0-9]{32}$/.test(id)) throw new Error("No workspace cookie");
  return id;
}
