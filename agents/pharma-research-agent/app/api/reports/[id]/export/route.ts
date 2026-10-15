// Download a finished report as PDF or Word (owner or share link).
import { reportAccess, json } from "@/lib/access";
import { reportDocx } from "@/lib/export-docx";
import { reportPdf } from "@/lib/export-pdf";
import { loadSources, serializeRow } from "@/lib/reports";

export const maxDuration = 60;

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "report";

export async function GET(request: Request, ctx: RouteContext<"/api/reports/[id]/export">) {
  const { id } = await ctx.params;
  const access = await reportAccess(id, request);
  if (!access) return json(404, { error: "Report not found" });
  const r = serializeRow(access.row);
  if (!r.report) return json(409, { error: "This report is not finished yet." });
  const format = new URL(request.url).searchParams.get("format");
  const sources = await loadSources(id);
  const name = slug(r.report.title);
  if (format === "docx") {
    const buf = await reportDocx(r, sources);
    return new Response(new Uint8Array(buf), {
      headers: { "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "content-disposition": `attachment; filename="${name}.docx"`, "cache-control": "no-store" },
    });
  }
  if (format === "pdf") {
    const buf = await reportPdf(r, sources);
    return new Response(new Uint8Array(buf), { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="${name}.pdf"`, "cache-control": "no-store" } });
  }
  return json(400, { error: "Use ?format=pdf or ?format=docx" });
}
