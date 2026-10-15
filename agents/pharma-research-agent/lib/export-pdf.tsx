import "server-only";
import { Document, Link, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import { blocks, numbered, numbering, referenceLine } from "./citations";
import type { SerializedReport } from "./reports";
import type { Source } from "../agent/types";

// Built-in PDF fonts: Times for reading, Helvetica for headings and metadata.
const s = StyleSheet.create({
  page: { paddingTop: 56, paddingBottom: 64, paddingHorizontal: 64, fontFamily: "Times-Roman", fontSize: 11, lineHeight: 1.5, color: "#0f172a" },
  kicker: { fontFamily: "Helvetica-Bold", fontSize: 8, letterSpacing: 1, color: "#1f4e8c", marginBottom: 6 },
  title: { fontFamily: "Helvetica-Bold", fontSize: 19, lineHeight: 1.25, marginBottom: 8 },
  question: { fontFamily: "Times-Italic", fontSize: 11, color: "#475569", marginBottom: 6 },
  meta: { fontFamily: "Helvetica", fontSize: 8.5, color: "#64748b", marginBottom: 18, paddingBottom: 12, borderBottomWidth: 0.5, borderBottomColor: "#cbd5e1" },
  answer: { fontSize: 12, lineHeight: 1.55, marginBottom: 6, paddingLeft: 10, borderLeftWidth: 2, borderLeftColor: "#1f4e8c" },
  h2: { fontFamily: "Helvetica-Bold", fontSize: 11.5, marginTop: 16, marginBottom: 6 },
  p: { marginBottom: 7 },
  li: { flexDirection: "row", marginBottom: 4 },
  bullet: { width: 12 },
  ref: { flexDirection: "row", fontFamily: "Helvetica", fontSize: 8.5, lineHeight: 1.4, marginBottom: 4, color: "#334155" },
  refNum: { width: 18, fontFamily: "Helvetica-Bold" },
  link: { color: "#1f4e8c", textDecoration: "none" },
  footer: { position: "absolute", bottom: 28, left: 64, right: 64, flexDirection: "row", justifyContent: "space-between", fontFamily: "Helvetica", fontSize: 7.5, color: "#94a3b8" },
});

export async function reportPdf(r: SerializedReport, sources: Source[]): Promise<Buffer> {
  const report = r.report!;
  const nums = numbering(report);
  const byId = new Map(sources.map((x) => [x.id, x]));
  const prose = (text: string, key: string) =>
    blocks(text).map((b, i) =>
      b.kind === "p" ? (
        <Text key={`${key}-${i}`} style={s.p}>{numbered(b.items[0], nums)}</Text>
      ) : (
        <View key={`${key}-${i}`}>
          {b.items.map((item, j) => (
            <View key={j} style={s.li}>
              <Text style={s.bullet}>•</Text>
              <Text style={{ flex: 1 }}>{numbered(item, nums)}</Text>
            </View>
          ))}
        </View>
      ),
    );
  const date = new Date(r.createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

  const doc = (
    <Document title={report.title} author="Pharma research agent" subject={r.query}>
      <Page size="A4" style={s.page}>
        <Text style={s.kicker}>RESEARCH REPORT</Text>
        <Text style={s.title}>{report.title}</Text>
        <Text style={s.question}>{r.query}</Text>
        <Text style={s.meta}>
          {date} · Confidence: {report.confidence} · {nums.size} cited sources · {r.model}
        </Text>
        <View style={s.answer}>{prose(report.answer, "answer")}</View>
        {report.sections.map((sec, i) => (
          <View key={i}>
            <Text style={s.h2}>{sec.heading}</Text>
            {prose(sec.body, `sec-${i}`)}
          </View>
        ))}
        {report.limitations.length > 0 && (
          <View>
            <Text style={s.h2}>Limitations</Text>
            {report.limitations.map((l, i) => (
              <View key={i} style={s.li}>
                <Text style={s.bullet}>•</Text>
                <Text style={{ flex: 1 }}>{numbered(l, nums)}</Text>
              </View>
            ))}
          </View>
        )}
        <View break={nums.size > 12}>
          <Text style={s.h2}>References</Text>
          {[...nums.entries()].map(([id, n]) => {
            const src = byId.get(id);
            return (
              <View key={id} style={s.ref} wrap={false}>
                <Text style={s.refNum}>{n}.</Text>
                <Text style={{ flex: 1 }}>
                  {src ? referenceLine(src) : id}.{" "}
                  {src?.url ? (
                    <Link src={src.url} style={s.link}>
                      {src.url.length > 80 ? `${src.url.slice(0, 79)}…` : src.url}
                    </Link>
                  ) : null}
                </Text>
              </View>
            );
          })}
        </View>
        <View style={s.footer} fixed>
          <Text>AI-generated from public sources. Not medical advice; verify against the cited sources.</Text>
          <Text render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
  return renderToBuffer(doc);
}
