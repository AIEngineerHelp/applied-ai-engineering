// Vercel Node function: every request is routed here (see vercel.json) and
// handled by the same server code used locally.
import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { createRequestHandler } from "../src/server.js";

/** Basic auth with any username; compares the password in constant time. */
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
  const password = process.env.LIVE_ACCESS_PASSWORD;
  if (password && !authorized(req.headers.authorization, password)) {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Dino Runner", charset="UTF-8"', "Cache-Control": "no-store" });
    res.end("Enter the shared access password to open Dino Runner.");
    return;
  }
  // A public deployment spends the owner's key; require an explicit opt-in.
  if (process.env.ENABLE_LIVE === "true" && !password && process.env.PUBLIC_LIVE !== "true") {
    res.writeHead(503, { "Cache-Control": "no-store" });
    res.end("Set LIVE_ACCESS_PASSWORD, or PUBLIC_LIVE=true, before enabling live Jev calls.");
    return;
  }
  handler ??= createRequestHandler();
  await handler(req, res);
}
