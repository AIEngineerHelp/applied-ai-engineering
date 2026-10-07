// A small static server for local use: the site from site/, the analysis engine
// from src/ at /engine, and the measured results from results/ at /data.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT) || 4321;
const HOST = process.env.HOST || "127.0.0.1";
const MOUNTS = [
  ["/engine/", join(ROOT, "src")],
  ["/data/", join(ROOT, "results")],
  ["/", join(ROOT, "site")],
];
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jsonl": "application/x-ndjson; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".md": "text/markdown; charset=utf-8",
};

async function resolve(urlPath) {
  for (const [prefix, dir] of MOUNTS) {
    if (!urlPath.startsWith(prefix)) continue;
    const rel = normalize(urlPath.slice(prefix.length)).replace(/^(\.\.[/\\])+/, "");
    const base = join(dir, rel);
    if (!base.startsWith(dir)) return null;
    // Clean URLs, as on Vercel: /playground serves playground.html.
    for (const candidate of [base, `${base}.html`, join(base, "index.html")]) {
      try {
        if ((await stat(candidate)).isFile()) return candidate;
      } catch {
        // Try the next candidate.
      }
    }
  }
  return null;
}

createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const file = await resolve(path);
  if (!file) {
    res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
    return;
  }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
  res.end(await readFile(file));
}).listen(PORT, HOST, () => console.log(`Prompt caching site: http://${HOST}:${PORT} (playground at /playground)`));
