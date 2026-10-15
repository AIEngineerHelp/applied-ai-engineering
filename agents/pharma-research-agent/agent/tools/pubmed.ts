// Knowledge base 1: PubMed, through NCBI E-utilities.
// esearch (JSON) finds PMIDs; efetch (XML) returns titles and abstracts.
// No key needed; NCBI allows 3 requests a second without one (10 with NCBI_API_KEY).

import type { Source } from "../types.ts";
import { clip, getJson, limiter, type Toolset } from "./toolset.ts";

const BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";

/** Pulls articles out of efetch XML. A small reader for the few tags we need. */
export function parsePubmedXml(xml: string): Source[] {
  const decode = (s: string) =>
    s
      .replace(/<[^>]+>/g, "")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#x?([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, /^[0-9]+$/.test(n) ? 10 : 16)))
      .replace(/&amp;/g, "&")
      .trim();
  const tag = (block: string, name: string) => block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`))?.[1];
  return [...xml.matchAll(/<PubmedArticle>([\s\S]*?)<\/PubmedArticle>/g)].map(([, a]) => {
    const pmid = decode(tag(a, "PMID") ?? "");
    const abstract = [...a.matchAll(/<AbstractText\b([^>]*)>([\s\S]*?)<\/AbstractText>/g)]
      .map(([, attrs, body]) => {
        const label = attrs.match(/Label="([^"]+)"/)?.[1];
        return label ? `${label}: ${decode(body)}` : decode(body);
      })
      .join("\n");
    const journal = decode(tag(tag(a, "Journal") ?? "", "Title") ?? "");
    const year = decode(tag(tag(a, "PubDate") ?? "", "Year") ?? tag(tag(a, "PubDate") ?? "", "MedlineDate") ?? "").slice(0, 4);
    const types = [...a.matchAll(/<PublicationType\b[^>]*>([\s\S]*?)<\/PublicationType>/g)].map((m) => decode(m[1]));
    return {
      id: `PMID:${pmid}`,
      kind: "pubmed" as const,
      title: decode(tag(a, "ArticleTitle") ?? ""),
      url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
      text: abstract || "(No abstract.)",
      meta: { journal, year: Number(year) || undefined, type: types.filter((t) => t !== "Journal Article").join(", ") || "Journal Article" },
    };
  });
}

export function pubmedToolset(): Toolset {
  const wait = limiter(process.env.NCBI_API_KEY ? 8 : 2.5);
  const common = () => {
    const q = new URLSearchParams({ tool: "pharma-research-agent" });
    if (process.env.NCBI_EMAIL) q.set("email", process.env.NCBI_EMAIL);
    if (process.env.NCBI_API_KEY) q.set("api_key", process.env.NCBI_API_KEY);
    return q;
  };
  return {
    kind: "pubmed",
    tools: [
      {
        name: "search_pubmed",
        description: "Search PubMed and return the top articles with title, journal, year, publication type and the start of the abstract. Full abstracts are saved for you.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "PubMed query, e.g. (semaglutide OR GLP-1 receptor agonist) AND pancreatitis AND meta-analysis[pt]" },
            max: { type: "integer", minimum: 1, maximum: 10, description: "How many articles, 1-10 (default 6)." },
          },
          required: ["query"],
        },
      },
    ],
    async call(name, args) {
      if (name !== "search_pubmed") throw new Error(`Unknown tool ${name}`);
      const max = Math.min(10, Math.max(1, Number(args.max) || 6));
      const q = common();
      q.set("db", "pubmed");
      q.set("term", String(args.query ?? ""));
      q.set("retmax", String(max));
      q.set("retmode", "json");
      q.set("sort", "relevance");
      await wait();
      const found = (await getJson(`${BASE}/esearch.fcgi?${q}`)) as { esearchresult?: { count?: string; idlist?: string[] } };
      const ids = found?.esearchresult?.idlist ?? [];
      if (!ids.length) return { forModel: { total: Number(found?.esearchresult?.count ?? 0), articles: [], note: "No results. Broaden the query." }, sources: [] };
      const f = common();
      f.set("db", "pubmed");
      f.set("id", ids.join(","));
      f.set("rettype", "abstract");
      f.set("retmode", "xml");
      await wait();
      const sources = parsePubmedXml((await getJson(`${BASE}/efetch.fcgi?${f}`, { text: true })) as string);
      return {
        forModel: {
          total: Number(found.esearchresult?.count ?? 0),
          articles: sources.map((s) => ({ id: s.id, title: s.title, journal: s.meta.journal, year: s.meta.year, type: s.meta.type, abstract: clip(s.text, 700) })),
        },
        sources,
      };
    },
  };
}
