// Renders README.md (the article) to site/article.html, so the article is readable at /article
// locally and in the static export without depending on GitHub. Mermaid diagrams stay as source
// code blocks. Relative links to files in this folder point to the repository on GitHub.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Marked } from "marked";
import { ROOT } from "../src/load-corpus.ts";

export const REPO = "https://github.com/AIEngineerHelp/applied-ai-engineering/tree/main/rag-retrieval/knowledge-graphs";

/** GitHub-style heading slug: lower case, punctuation removed, spaces to hyphens. */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s/g, "-");
}

export function renderArticle(markdown: string): string {
  const seen = new Map<string, number>();
  const marked = new Marked({
    renderer: {
      heading({ tokens, depth }) {
        const text = this.parser.parseInline(tokens);
        let id = slug(text);
        const n = seen.get(id) ?? 0;
        seen.set(id, n + 1);
        if (n) id = `${id}-${n}`;
        return `<h${depth} id="${id}">${text}</h${depth}>\n`;
      },
      code({ text, lang }) {
        const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        const label = lang === "mermaid" ? '<div class="code-label">Diagram (Mermaid source)</div>' : "";
        return `<figure class="code">${label}<pre><code>${esc}</code></pre></figure>\n`;
      },
      link({ href, title, tokens }) {
        const text = this.parser.parseInline(tokens);
        // Files in this folder: point to the repository. In-page anchors and absolute URLs stay.
        const url = /^(https?:|#|mailto:)/.test(href) ? href : `${REPO}/${href.replace(/^\.\//, "")}`;
        return `<a href="${url}"${title ? ` title="${title}"` : ""}>${text}</a>`;
      },
    },
  });
  const body = marked.parse(markdown, { async: false }) as string;
  return `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Knowledge graphs: the article</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,600;1,8..60,400&display=swap" rel="stylesheet">
<link rel="icon" type="image/svg+xml" href="favicon.svg">
<script>
  (() => { let t = null; try { t = localStorage.getItem("kg-theme"); } catch {} document.documentElement.dataset.theme = t === "dark" ? "dark" : "light"; })();
</script>
<style>
  :root { --paper: #faf9f7; --sheet: #fff; --ink: #1a1a18; --ink-2: #4a4944; --muted: #85837c; --rule: #e7e4de; --accent: #2b4c7e; }
  :root[data-theme="dark"] { color-scheme: dark; --paper: #1a1a19; --sheet: #222220; --ink: #ebe9e4; --ink-2: #bdbab2; --muted: #8b8880; --rule: #31302d; --accent: #93abd3; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--paper); color: var(--ink); font: 17px/1.7 "Source Serif 4", Georgia, serif; -webkit-font-smoothing: antialiased; }
  .bar { position: sticky; top: 0; display: flex; justify-content: space-between; gap: 16px; padding: 14px clamp(16px, 4vw, 40px); background: color-mix(in srgb, var(--paper) 94%, transparent); border-bottom: 1px solid var(--rule); font: 13.5px Inter, system-ui, sans-serif; }
  .bar a { color: var(--ink-2); text-decoration: none; margin-left: 18px; }
  .bar > span:first-child a { margin-left: 0; color: var(--ink); font: 500 17px "Source Serif 4", serif; }
  main { max-width: 760px; margin: 0 auto; padding: 48px 20px 120px; }
  h1, h2, h3 { font-weight: 400; line-height: 1.2; scroll-margin-top: 70px; }
  h1 { font-size: 38px; } h2 { font-size: 28px; margin-top: 56px; padding-top: 20px; border-top: 1px solid var(--rule); } h3 { font-size: 21px; margin-top: 36px; }
  a { color: var(--accent); text-decoration-thickness: 1px; text-underline-offset: 3px; }
  p, li { color: var(--ink); } li + li { margin-top: 4px; }
  blockquote { margin: 20px 0; padding: 4px 18px; border-left: 2px solid var(--rule); color: var(--ink-2); }
  code { font: 0.82em "JetBrains Mono", monospace; }
  .code { margin: 20px 0; } .code pre { margin: 0; padding: 14px 16px; overflow-x: auto; background: var(--sheet); border: 1px solid var(--rule); border-radius: 3px; font-size: 14px; line-height: 1.55; }
  .code-label { font: 500 11px Inter, sans-serif; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); margin-bottom: 6px; }
  table { display: block; overflow-x: auto; border-collapse: collapse; margin: 20px 0; font: 14px/1.55 Inter, system-ui, sans-serif; }
  th, td { text-align: left; vertical-align: top; padding: 8px 12px 8px 0; border-bottom: 1px solid var(--rule); }
  th { font-weight: 600; border-bottom-color: var(--ink-2); }
  .note { font: 13px Inter, sans-serif; color: var(--muted); }
</style>
</head>
<body>
<header class="bar"><span><a href="./">Knowledge graphs</a></span><span><a href="./">Back to the demo</a><a href="${REPO}#readme">Full article on GitHub</a></span></header>
<main>
<p class="note">This page is the example's README, rendered for reading here. Mermaid diagrams are shown as their source.</p>
${body}
</main>
</body>
</html>
`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  writeFileSync(join(ROOT, "site", "article.html"), renderArticle(readFileSync(join(ROOT, "README.md"), "utf8")));
  console.log("Wrote site/article.html");
}
