// A small static server for local use: the app from site/.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT) || 4323;
const HOST = process.env.HOST || "127.0.0.1";
const SITE = join(ROOT, "site");
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

async function resolve(urlPath: string): Promise<string | null> {
  const rel = normalize(urlPath.slice(1)).replace(/^(\.\.[/\\])+/, "");
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
  const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
  const file = await resolve(path);
  if (!file) {
    res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
    return;
  }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
  res.end(await readFile(file));
}).listen(PORT, HOST, () => console.log(`Tool-calling safety app: http://${HOST}:${PORT}`));
