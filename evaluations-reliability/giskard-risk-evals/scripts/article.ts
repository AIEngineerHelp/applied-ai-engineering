// Renders README.md (the article) to riskdemo/static/article.html, so the article is readable at /article
// next to the app without depending on GitHub. Mermaid diagrams stay as source code blocks. Relative links
// to files in this folder point to the repository on GitHub.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Marked } from "marked";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO = "https://github.com/AIEngineerHelp/applied-ai-engineering/tree/main/evaluations-reliability/giskard-risk-evals";

/** GitHub-style heading slug: lower case, punctuation removed, spaces to hyphens. */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s/g, "-");
}

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

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
        const label = lang === "mermaid" ? '<div class="code-label">Diagram (Mermaid source)</div>' : "";
        return `<figure class="code">${label}<pre><code>${escape(text)}</code></pre></figure>\n`;
      },
      link({ href, title, tokens }) {
        const text = this.parser.parseInline(tokens);
        // Files in this folder point to the repository; in-page anchors, the app and absolute URLs stay.
        const local = /^(https?:|#|mailto:|\/)/.test(href);
        const url = local ? href : `${REPO}/${href.replace(/^\.\//, "")}`;
        return `<a href="${url}"${title ? ` title="${escape(title)}"` : ""}>${text}</a>`;
      },
    },
  });
  const body = marked.parse(markdown, { async: false }) as string;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Policy Red Team: the article</title>
<meta name="description" content="Turning policy into tests: Giskard for agent evals in finance and healthcare.">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%231d1c19'/%3E%3Cpath d='M16 7l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9v-5z M13 16l2 2 4-4' fill='none' stroke='%23f6f4ee' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&family=Newsreader:opsz,wght@6..72,400;6..72,500&display=swap" rel="stylesheet">
<style>
  :root { --paper: #f6f4ee; --card: #fdfcf9; --ink: #1d1c19; --ink-2: #55514a; --ink-3: #8a857a; --line: #e2ded3; --accent: #2f4f75; }
  * { box-sizing: border-box; }
  html { background: var(--paper); }
  body { margin: 0; background: var(--paper); color: var(--ink); font: 17px/1.7 Newsreader, Georgia, serif; -webkit-font-smoothing: antialiased; overflow-wrap: break-word; }
  .bar { position: sticky; top: 0; z-index: 1; display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px 16px; padding: 12px clamp(16px, 4vw, 40px); background: var(--paper); border-bottom: 1px solid var(--line); font: 13.5px "IBM Plex Sans", system-ui, sans-serif; }
  .bar a { color: var(--ink-2); text-decoration: none; margin-left: 16px; }
  .bar a:hover { color: var(--ink); }
  .bar > span:first-child a { margin-left: 0; color: var(--ink); font-weight: 600; }
  main { max-width: 760px; margin: 0 auto; padding: 40px 16px 120px; }
  h1, h2, h3 { font-weight: 400; line-height: 1.2; scroll-margin-top: 70px; }
  h1 { font-size: clamp(30px, 6vw, 40px); } h2 { font-size: 28px; margin-top: 56px; padding-top: 20px; border-top: 1px solid var(--line); } h3 { font-size: 21px; margin-top: 36px; }
  a { color: var(--accent); text-decoration-thickness: 1px; text-underline-offset: 3px; }
  li + li { margin-top: 4px; }
  blockquote { margin: 20px 0; padding: 4px 18px; border-left: 2px solid var(--line); color: var(--ink-2); }
  code { font: 0.8em "IBM Plex Mono", monospace; }
  .code { margin: 20px 0; } .code pre { margin: 0; padding: 14px 16px; overflow-x: auto; background: var(--card); border: 1px solid var(--line); border-radius: 6px; font-size: 14px; line-height: 1.55; }
  .code-label { font: 500 11px "IBM Plex Sans", sans-serif; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-3); margin-bottom: 6px; }
  table { display: block; max-width: 100%; overflow-x: auto; border-collapse: collapse; margin: 20px 0; font: 14px/1.55 "IBM Plex Sans", system-ui, sans-serif; }
  th, td { text-align: left; vertical-align: top; padding: 8px 12px 8px 0; border-bottom: 1px solid var(--line); min-width: 90px; }
  th { font-weight: 600; border-bottom-color: var(--ink-2); }
  .note { font: 13px "IBM Plex Sans", sans-serif; color: var(--ink-3); }
</style>
</head>
<body>
<header class="bar"><span><a href="/">Policy Red Team</a></span><span><a href="/">The app</a><a href="/#/measured">What we measured</a><a href="${REPO}#readme">On GitHub</a></span></header>
<main>
<p class="note">This page is the example's README, rendered for reading here. Mermaid diagrams are shown as their source.</p>
${body}
</main>
</body>
</html>
`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  writeFileSync(join(ROOT, "riskdemo", "static", "article.html"), renderArticle(readFileSync(join(ROOT, "README.md"), "utf8")));
  console.log("Wrote riskdemo/static/article.html");
}
