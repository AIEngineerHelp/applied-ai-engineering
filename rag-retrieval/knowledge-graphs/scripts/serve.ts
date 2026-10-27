// A small local server. The page is static (the recorded results are bundled
// into site/build/app.js by `npm run build:client`). One route is not:
// POST /api/ask, "Ask your own question", which runs Gemini → Cypher → Neo4j
// when .env holds a Gemini key and the Neo4j settings. The static export has no
// such route, so the published page only replays the recorded runs.
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { handleAsk } from "../src/ask-endpoint.ts";
import { liveAskDeps } from "../src/pipeline/ask-deps.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = join(ROOT, "site");
if (existsSync(join(ROOT, ".env"))) process.loadEnvFile(join(ROOT, ".env"));
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

async function ask(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 4096) {
      res.writeHead(413, { "content-type": "application/json" }).end(JSON.stringify({ error: "Request too large." }));
      return;
    }
    chunks.push(c as Buffer);
  }
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  headers.set("x-real-ip", req.socket.remoteAddress ?? "local");
  headers.delete("x-forwarded-for");
  const response = await handleAsk(new Request("http://local/api/ask", { method: req.method, headers, body: req.method === "POST" ? Buffer.concat(chunks) : undefined }), liveAskDeps());
  res.writeHead(response.status, Object.fromEntries(response.headers)).end(await response.text());
}

createServer(async (req, res) => {
  if (new URL(req.url ?? "/", "http://x").pathname === "/api/ask") {
    await ask(req, res).catch(() => res.writeHead(500).end());
    return;
  }
  const file = await resolve(decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname));
  if (!file) {
    res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
    return;
  }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
  res.end(await readFile(file));
}).listen(PORT, HOST, () => console.log(`Knowledge graph app: http://${HOST}:${PORT}`));
