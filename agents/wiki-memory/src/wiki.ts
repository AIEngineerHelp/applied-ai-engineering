// The wiki model: parse pages, apply an agent's edits, and derive the index, the log and the link graph.
// Everything here is plain code over markdown text, so the same functions run in tests, scripts and the browser.

export type PageType = "overview" | "source" | "entity" | "concept";

export type ClaimStatus = "current" | "superseded" | "disputed";

export interface Claim {
  key: string;
  value: string;
  asOf: string;
  source: string;
  status: ClaimStatus;
  /** Text after the struck-through claim, for example "superseded by [[src-x]]". */
  note: string;
  page: string;
  line: string;
}

export interface Page {
  slug: string;
  type: PageType;
  title: string;
  summary: string;
  sources: string[];
  updated: string;
  /** Path inside the wiki folder, for example "entities/billing-api.md". */
  path: string;
  /** The full markdown text, front matter included. */
  text: string;
  /** Distinct [[slug]] targets, in order of first appearance. */
  links: string[];
  claims: Claim[];
}

/** Pages by slug. Insertion order is creation order. */
export type Wiki = Map<string, Page>;

const FOLDERS: Record<PageType, string> = {
  overview: "",
  source: "sources/",
  entity: "entities/",
  concept: "concepts/",
};

export const TYPE_LABELS: Record<PageType, string> = {
  overview: "Overview",
  source: "Sources",
  entity: "Entities",
  concept: "Concepts",
};

const LINK = /\[\[([a-z0-9-]+)\]\]/g;
// - `key`: value (as of YYYY-MM-DD, [[source]])          a current claim
// - ~~`key`: value (as of YYYY-MM-DD, [[source]])~~ note  a superseded or disputed claim
const CLAIM = /^- (~~)?`([a-z0-9.-]+)`: (.+?) \(as of (\d{4}-\d{2}-\d{2}), \[\[([a-z0-9-]+)\]\]\)(?:~~ ?(.*))?$/;

export function parsePage(slug: string, text: string): Page {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) throw new Error(`${slug}: missing front matter`);
  const meta = new Map<string, string>();
  for (const line of match[1].split("\n")) {
    const at = line.indexOf(":");
    if (at > 0) meta.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  const type = meta.get("type") as PageType;
  if (!(type in FOLDERS)) throw new Error(`${slug}: unknown page type "${meta.get("type")}"`);
  const body = text.slice(match[0].length);
  const title = /^# (.+)$/m.exec(body)?.[1] ?? slug;
  const sources = (meta.get("sources") ?? "[]")
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const links: string[] = [];
  for (const [, target] of body.matchAll(LINK)) {
    if (target !== slug && !links.includes(target)) links.push(target);
  }

  const claims: Claim[] = [];
  let inClaims = false;
  for (const line of body.split("\n")) {
    if (line.startsWith("## ")) inClaims = line === "## Claims";
    if (!inClaims || !line.startsWith("- ")) continue;
    const c = CLAIM.exec(line);
    if (!c) throw new Error(`${slug}: malformed claim line: ${line}`);
    const struck = Boolean(c[1]);
    const note = (c[6] ?? "").trim();
    claims.push({
      key: c[2],
      value: c[3],
      asOf: c[4],
      source: c[5],
      status: !struck ? "current" : note.startsWith("disputed") ? "disputed" : "superseded",
      note,
      page: slug,
      line,
    });
  }

  return {
    slug,
    type,
    title,
    summary: meta.get("summary") ?? "",
    sources,
    updated: meta.get("updated") ?? "",
    path: `${FOLDERS[type]}${slug}.md`,
    text,
    links,
    claims,
  };
}

/** Returns a new wiki with the given pages written (created or replaced). The input is not changed. */
export function applyEdits(wiki: Wiki, files: { slug: string; text: string }[]): Wiki {
  const next: Wiki = new Map(wiki);
  for (const f of files) next.set(f.slug, parsePage(f.slug, f.text));
  return next;
}

/** index.md: every page with a link and its one-line summary, grouped by type. */
export function buildIndex(wiki: Wiki): string {
  const out = ["# Index", ""];
  for (const type of Object.keys(FOLDERS) as PageType[]) {
    const pages = [...wiki.values()].filter((p) => p.type === type).sort((a, b) => a.slug.localeCompare(b.slug));
    if (pages.length === 0) continue;
    out.push(`## ${TYPE_LABELS[type]}`, "");
    for (const p of pages) {
      const count = p.type === "source" ? "" : ` (${p.sources.length} source${p.sources.length === 1 ? "" : "s"})`;
      out.push(`- [[${p.slug}]] ${p.summary}${count}`);
    }
    out.push("");
  }
  return out.join("\n").trimEnd() + "\n";
}

export interface LogEntry {
  date: string;
  kind: "ingest" | "lint" | "query";
  title: string;
  lines: string[];
}

export function formatLog(entries: LogEntry[]): string {
  const out = ["# Log", ""];
  for (const e of entries) {
    out.push(`## [${e.date}] ${e.kind} | ${e.title}`, ...e.lines, "");
  }
  return out.join("\n").trimEnd() + "\n";
}

export interface GraphEdge {
  from: string;
  to: string;
}

export interface Graph {
  nodes: { id: string; type: PageType | "missing" }[];
  /** One edge per linked pair of pages, whichever direction the link goes. */
  edges: GraphEdge[];
}

export function buildGraph(wiki: Wiki): Graph {
  const nodes: Graph["nodes"] = [...wiki.values()].map((p) => ({ id: p.slug, type: p.type }));
  const seen = new Set<string>();
  const edges: GraphEdge[] = [];
  for (const p of wiki.values()) {
    for (const target of p.links) {
      if (!wiki.has(target) && !nodes.some((n) => n.id === target)) nodes.push({ id: target, type: "missing" });
      const key = [p.slug, target].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from: p.slug, to: target });
    }
  }
  return { nodes, edges };
}

/** Lines of a page that state something as current: struck-through claims and front matter are left out. */
export function currentLines(page: Page): string[] {
  const body = page.text.replace(/^---\n[\s\S]*?\n---\n/, "");
  return body.split("\n").filter((l) => l.trim() !== "" && !/^- ~~/.test(l));
}
