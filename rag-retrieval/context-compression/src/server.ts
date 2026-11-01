import { createServer, type IncomingMessage } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
import { capabilities, configFromEnv, parseRequest, runBackend, type BackendConfig, type BackendRequest } from "./backends.ts";
import { generationFromEnv, generationReady } from "./generation.ts";
import { parseExperiment, runExperiment } from "./experiments.ts";
import type { Result } from "./compress.ts";

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    chunks.push(buffer); bytes += buffer.length;
    if (bytes > 120000) throw new Error("Request body is too large.");
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" };

export function createAppServer(root: string, config: BackendConfig = configFromEnv(), runner: (request: BackendRequest, config: BackendConfig) => Promise<Result> = runBackend) {
  let busy = false;
  const generation = generationFromEnv();
  return createServer(async (req, res) => {
    const json = (status: number, value: object) => res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" }).end(JSON.stringify(value));
    // Reject DNS rebinding as well as cross-origin browser requests.
    const host = req.headers.host ?? "";
    if (!/^127\.0\.0\.1:\d+$/.test(host) && !/^localhost:\d+$/.test(host)) { json(403, { error: "Loopback host required." }); return; }
    try {
      const path = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
      if (path === "/api/capabilities" && req.method === "GET") { json(200, { ...capabilities(config), experiments: { liveReady: generationReady(generation), answerModel: generation.answerModel ?? null, judgeModel: generation.judgeModel ?? null } }); return; }
      if (["/api/compress", "/api/experiment"].includes(path) && req.method === "POST") {
        if (req.headers.origin !== `http://${host}` || req.headers["x-compression-lab"] !== "1" || !req.headers["content-type"]?.startsWith("application/json")) { json(403, { error: "Same-origin JSON request required." }); return; }
        if (busy) { json(429, { error: "A compression call is already running. Wait for it to finish." }); return; }
        const body = await readJson(req);
        if (busy) { json(429, { error: "Another request started while this body was being read." }); return; }
        const request = path === "/api/compress" ? parseRequest(body) : parseExperiment(body);
        busy = true;
        try { json(200, path === "/api/compress" ? await runner(request as ReturnType<typeof parseRequest>, config) : await runExperiment(request as ReturnType<typeof parseExperiment>, config, generation)); }
        finally { busy = false; }
        return;
      }
      if (path.startsWith("/api/")) { json(404, { error: "Unknown API route." }); return; }
      if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405).end(); return; }
      const file = resolve(root, `.${path === "/" ? "/index.html" : path}`);
      if (!file.startsWith(root + sep)) { res.writeHead(403).end("Forbidden"); return; }
      try {
        const data = await readFile(file);
        res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream", "cache-control": "no-store", "x-content-type-options": "nosniff" }).end(req.method === "HEAD" ? undefined : data);
      } catch { res.writeHead(404).end("Not found"); }
    } catch (error) { json(400, { error: error instanceof Error ? error.message : "Compression request failed." }); }
  });
}
