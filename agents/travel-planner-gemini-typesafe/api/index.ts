import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequestHandler } from "../src/server.js";
import { createBlobRunStore } from "../src/blob-run-store.js";
import { timingSafeEqual } from "node:crypto";

export function authorized(header: string | undefined, password: string) {
  if (!header?.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 0) return false;
  const supplied = Buffer.from(decoded.slice(separator + 1));
  const expected = Buffer.from(password);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

let handler: ReturnType<typeof createRequestHandler>;
export default async function route(req: IncomingMessage, res: ServerResponse) {
  try {
    const password = process.env.LIVE_ACCESS_PASSWORD;
    if (password && !authorized(req.headers.authorization, password)) {
      res.writeHead(401, {
        "WWW-Authenticate": 'Basic realm="Travel Lab", charset="UTF-8"',
        "Cache-Control": "no-store",
      });
      res.end("Enter the shared access password to open Travel Lab.");
      return;
    }
    if (process.env.ENABLE_LIVE === "true" && !password && process.env.PUBLIC_LIVE !== "true") {
      res.writeHead(503, { "Cache-Control": "no-store" });
      res.end("Configure deployment access before enabling live comparisons.");
      return;
    }
    handler ??= createRequestHandler({ store: createBlobRunStore() });
    await handler(req, res);
  } catch {
    if (!res.headersSent) res.writeHead(503, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ error: "The service is temporarily unavailable. Please try again." }));
  }
}
