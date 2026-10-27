// A small static server for local use. The app is fully static: the sample
// data is bundled into site/build/app.js by `npm run build:client`.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SITE = join(dirname(fileURLToPath(import.meta.url)), "..", "site");
const PORT = Number(process.env.PORT) || 4332;
const HOST = process.env.HOST || "127.0.0.1";
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

async function resolve(urlPath: string): Promise<string | null> {
  const rel = normalize(urlPath).replace(/^(\.\.[/\\])+/, "");
  const base = join(SITE, rel);
  if (!base.startsWith(SITE)) return null;
  for (const candidate of [base, `${base}.html`, join(base, "index.html")]) {
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

createServer(async (req, res) => {
  const file = await resolve(decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname));
  if (!file) {
    res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
    return;
  }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
  res.end(await readFile(file));
}).listen(PORT, HOST, () => console.log(`Knowledge graph app: http://${HOST}:${PORT}`));
