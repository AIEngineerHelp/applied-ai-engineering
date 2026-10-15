// The run's virtual file system: list files, or read one by path.
import { reportAccess, json } from "@/lib/access";
import { loadFiles } from "@/lib/reports";

export async function GET(request: Request, ctx: RouteContext<"/api/reports/[id]/files">) {
  const { id } = await ctx.params;
  const access = await reportAccess(id, request);
  if (!access) return json(404, { error: "Report not found" });
  const path = new URL(request.url).searchParams.get("path");
  const files = await loadFiles(id);
  if (path) {
    const f = files.find((x) => x.path === path);
    return f ? json(200, f) : json(404, { error: "File not found" });
  }
  return json(200, files.map((f) => ({ path: f.path, bytes: f.content.length, by: f.by })));
}
