import http from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { KINDS } from "./game.js";
import { configuration, createJevPlayer, type Config, type DecideFn } from "./jev.js";

const assets = {
  "/": ["index.html", "text/html"],
  "/app.js": ["app.js", "text/javascript"],
  "/styles.css": ["styles.css", "text/css"],
  "/favicon.svg": ["favicon.svg", "image/svg+xml"],
};
// Bounds on spending the owner's Jev quota. Jev allows 1,200 requests/minute per
// account (docs: models); one game makes at most one call per obstacle.
export const MAX_IN_FLIGHT = 4;
export const MAX_PER_MINUTE = 300;
const MAX_BODY_BYTES = 1024;

export function createRequestHandler({
  config = configuration(),
  decide = createJevPlayer({ config }),
  now = Date.now,
}: { config?: Config; decide?: DecideFn; now?: () => number } = {}) {
  let inFlight = 0;
  const recent: number[] = [];
  return async (req: http.IncomingMessage, res: http.ServerResponse) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    const reply = (code: number, data: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(data));
    };
    const hostname = (req.headers.host || "").split(":")[0].toLowerCase();
    if (!config.allowedHosts.has(hostname)) return reply(403, { error: "This host is not configured." });
    const path = new URL(req.url, "http://localhost").pathname;

    if (req.method === "GET" && path === "/api/config")
      return reply(200, { live: config.live, model: config.model });

    if (path === "/api/decide") {
      if (req.method !== "POST") return reply(405, { error: "Use POST." });
      if (!config.live)
        return reply(503, { error: "Live Jev calls are disabled. Set TYPESAFE_API_KEY and ENABLE_LIVE=true." });
      let body;
      try {
        let raw = "";
        for await (const chunk of req) {
          raw += chunk;
          if (raw.length > MAX_BODY_BYTES) throw new Error("too large");
        }
        body = JSON.parse(raw);
      } catch {
        return reply(400, { error: "Send a small JSON body: {\"kind\": \"<obstacle kind>\"}." });
      }
      // The browser names one of six obstacle kinds; the server builds the Jev
      // request, so visitors cannot send arbitrary prompts with the owner's key.
      if (!KINDS.includes(body?.kind)) return reply(400, { error: "Unknown obstacle kind." });
      while (recent.length && recent[0] <= now() - 60000) recent.shift();
      if (inFlight >= MAX_IN_FLIGHT || recent.length >= MAX_PER_MINUTE)
        return reply(429, { error: "Too many Jev requests. Wait a moment and try again." });
      inFlight++;
      recent.push(now());
      const abort = new AbortController();
      res.on("close", () => abort.abort());
      try {
        return reply(200, await decide(body.kind, abort.signal));
      } catch (error) {
        return reply(502, { error: error.message });
      } finally {
        inFlight--;
      }
    }

    const asset = req.method === "GET" && assets[path];
    if (!asset) return reply(404, { error: "Not found." });
    try {
      const file = await readFile(new URL(`../public/${asset[0]}`, import.meta.url));
      res.writeHead(200, { "Content-Type": `${asset[1]}; charset=utf-8`, "Cache-Control": "no-cache" });
      res.end(file);
    } catch {
      reply(500, { error: "Asset missing. Run npm run build:client." });
    }
  };
}

export function createApp(options: Parameters<typeof createRequestHandler>[0] = {}) {
  return http.createServer(createRequestHandler(options));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = configuration();
  const port = Number(process.env.PORT) || 4318;
  createApp({ config }).listen(port, config.host, () => {
    console.log(`Dino Runner on http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${port}`);
    console.log(config.live ? `Jev live calls enabled (${config.model}).` : "Jev live calls disabled; the rule bot and human modes still work.");
  });
}
