import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, resolve, sep, extname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../site");
const port = Number(process.env.PORT ?? 4325);
const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" };
createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
    const file = resolve(root, `.${path === "/" ? "/index.html" : path}`);
    if (!file.startsWith(root + sep)) { res.writeHead(403).end("Forbidden"); return; }
    const data = await readFile(file);
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream", "cache-control": "no-store", "x-content-type-options": "nosniff" }).end(data);
  } catch { res.writeHead(404, { "content-type": "text/plain" }).end("Not found"); }
}).listen(port, "127.0.0.1", () => console.log(`Context Compression Lab: http://127.0.0.1:${port}`));
