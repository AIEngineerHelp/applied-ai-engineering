// Live progress for one report, as server-sent events read from the database.
// Works across instances and survives reconnects: the client resumes with
// ?after=<last seq>. The stream ends when the run is finished.
import { reportAccess, json } from "@/lib/access";
import { getReport, loadEvents, sourcesByIds } from "@/lib/reports";
import type { RunEvent } from "@/lib/research/types";

export const maxDuration = 300;
const POLL_MS = 700;
const MAX_MS = 280_000;

export async function GET(request: Request, ctx: RouteContext<"/api/reports/[id]/events">) {
  const { id } = await ctx.params;
  const access = await reportAccess(id, request);
  if (!access) return json(404, { error: "Report not found" });
  let after = Number(new URL(request.url).searchParams.get("after") || 0);
  const accessKey = access.owner ? { workspaceId: access.workspaceId! } : { shareId: access.row.shareId! };

  const encoder = new TextEncoder();
  const started = Date.now();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      try {
        while (!request.signal.aborted && Date.now() - started < MAX_MS) {
          const rows = await loadEvents(id, after);
          for (const r of rows) {
            let e = r.data as RunEvent | { type: "sources"; subtask: string; ids: string[] };
            // Source events carry ids in the database; send the full sources to the client.
            if (e.type === "sources" && "ids" in e) e = { type: "sources", subtask: e.subtask, sources: await sourcesByIds(id, e.ids) };
            send({ seq: r.seq, event: e });
            after = r.seq;
          }
          const row = await getReport(id, accessKey);
          if (!row) break;
          if (rows.length === 0 && (row.status === "completed" || row.status === "failed" || row.status === "cancelled")) {
            send({ status: row.status });
            break;
          }
          send({ heartbeat: Date.now(), status: row.status });
          await new Promise((r) => setTimeout(r, POLL_MS));
        }
      } catch (err) {
        send({ error: (err as Error).message });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" } });
}
