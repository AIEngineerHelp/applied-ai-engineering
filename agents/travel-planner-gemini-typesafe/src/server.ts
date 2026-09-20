import http from "node:http";
import { createRunStore, redact } from "./run-store.js";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { compare } from "./engine.js";
import { catalogs, parseTask } from "./domain.js";
import { configuration } from "./providers.js";
const assets = {
  "/": ["index.html", "text/html"],
  "/history": ["history.html", "text/html"],
  "/history/": ["history.html", "text/html"],
  "/app.js": ["app.js", "text/javascript"],
  "/history.js": ["history.js", "text/javascript"],
  "/styles.css": ["styles.css", "text/css"],
  "/planner.css": ["planner.css", "text/css"],
  "/favicon.svg": ["favicon.svg", "image/svg+xml"],
};
export function createApp({
  config = configuration(),
  runner = compare,
  store = createRunStore(undefined, { recover: true }),
} = {}) {
  let active = 0;
  return http.createServer(async (req, res) => {
    const cookies = Object.fromEntries(
      (req.headers.cookie || "")
        .split(";")
        .map((part) => part.trim().split("="))
        .filter(([key, value]) => key && value),
    );
    const ownerId = /^[a-f0-9-]{36}$/.test(cookies.travel_lab_session || "")
      ? cookies.travel_lab_session
      : randomUUID();
    const secure = req.headers["x-forwarded-proto"] === "https";
    res.setHeader(
      "Set-Cookie",
      `travel_lab_session=${ownerId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${secure ? "; Secure" : ""}`,
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    const reply = (code, data) => {
      res.writeHead(code, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(data));
    };
    const hostname = (req.headers.host || "").split(":")[0].toLowerCase();
    const allowedHosts = config.allowedHosts ?? new Set(["127.0.0.1", "localhost"]);
    const isLoopback = hostname === "127.0.0.1" || hostname === "localhost";
    if (!allowedHosts.has(hostname))
      return reply(403, { error: "This host is not configured." });
    const path = new URL(req.url, "http://localhost").pathname;
    if (req.method === "GET" && path === "/api/runs")
      return reply(
        200,
        store
          .list()
          .filter(
            (record) =>
              record.ownerId === ownerId || (isLoopback && !record.ownerId),
          )
          .map(({ id, createdAt, finishedAt, task, mode, status }) => ({
            id,
            createdAt,
            finishedAt,
            task,
            mode,
            status,
          })),
      );
    if (req.method === "GET" && path.startsWith("/api/runs/")) {
      try {
        const record = store.get(path.slice(10));
        if (
          record.ownerId !== ownerId &&
          !(isLoopback && !record.ownerId)
        )
          throw new Error("Not found");
        return reply(200, record);
      } catch {
        return reply(404, { error: "Run not found." });
      }
    }
    if (req.method === "GET" && path === "/api/config")
      return reply(200, {
        live: config.live,
        models: { gemini: config.geminiModel, jev: config.jevModel },
        usdToInr: config.usdToInr,
      });
    if (req.method === "GET" && ["/api/benchmark/routing", "/api/benchmark/challenge"].includes(path)) {
      try {
        const file = path.endsWith("/challenge") ? "2026-09-20-challenge.json" : "2026-09-20-routing.json";
        const artifact = JSON.parse(await readFile(
          new URL(`../benchmarks/results/${file}`, import.meta.url), "utf8",
        ));
        return reply(200, {
          createdAt: artifact.createdAt,
          datasetHash: artifact.datasetHash,
          caseCount: artifact.cases.length,
          repetitions: artifact.repetitions,
          summary: artifact.summary,
          cases: artifact.cases,
          caseChoices: Object.fromEntries(artifact.cases.map((item) => [item.id,
            Object.fromEntries(["gemini", "jev"].map((provider) => [provider,
              [...new Set(artifact.samples.filter((sample) => sample.caseId === item.id && sample.provider === provider)
                .map((sample) => sample.choice ?? sample.error ?? "error"))],
            ])),
          ])),
          note: path.endsWith("/challenge")
            ? "Hand-authored challenge labels include debatable recovery choices; scores are policy matches, not independent trip-quality judgments."
            : "Small synthetic routing test; not a plan-quality, cost, or live-trip benchmark.",
        });
      } catch {
        return reply(503, { error: "Published benchmark is unavailable." });
      }
    }
    if (req.method === "POST" && path === "/api/compare") {
      // Local-only app: reject cross-origin POSTs that could spend the owner's API quota.
      if (req.headers.origin) {
        try {
          if (new URL(req.headers.origin).host !== req.headers.host)
            return reply(403, { error: "Cross-origin requests are not allowed." });
        } catch {
          return reply(403, { error: "Cross-origin requests are not allowed." });
        }
      }
      if (!req.headers["content-type"]?.startsWith("application/json"))
        return reply(415, { error: "Use application/json." });
      if (active >= 2)
        return reply(429, {
          error: "Two comparisons are already running. Stop one or try again.",
        });
      let raw = "";
      try {
        for await (const chunk of req) {
          raw += chunk;
          if (Buffer.byteLength(raw) > 12000)
            return reply(413, { error: "Request too large." });
        }
        const body = JSON.parse(raw);
        const task = parseTask(body.task, body.mode === "live");
        if (!["demo", "live"].includes(body.mode))
          return reply(400, { error: "Choose demo or live mode." });
        if (body.mode === "live" && !config.live)
          return reply(409, {
            error:
              "Live mode is not configured. Add both API keys and ENABLE_LIVE=true on the server.",
          });
        if (active >= 2)
          return reply(429, {
            error:
              "Two comparisons are already running. Stop one or try again.",
          });
        const clean = (value) =>
          redact(value, [config.geminiKey, config.jevKey]);
        const record = store.create(
          clean({
            ownerId,
            task,
            mode: body.mode,
            orchestration: "langgraph",
            catalog: body.mode === "demo" ? catalogs[task.city] : null,
            models: { gemini: config.geminiModel, jev: config.jevModel },
            usdToInr: config.usdToInr,
            rates: config.rates,
          }),
        );
        const controller = new AbortController();
        const timeout = setTimeout(
          () => controller.abort(new Error("Comparison time limit reached.")),
          240000,
        );
        res.on("close", () => controller.abort());
        active++;
        res.writeHead(200, {
          "Content-Type": "application/x-ndjson",
          "Cache-Control": "no-store",
          "X-Accel-Buffering": "no",
        });
        res.flushHeaders();
        res.write(JSON.stringify({ type: "saved", runId: record.id }) + "\n");
        try {
          const results = await runner({
            task,
            mode: body.mode,
            config,
            signal: controller.signal,
            emit: (event) => {
              const saved = clean(event);
              store.append(record.id, saved);
              if (!res.destroyed) res.write(JSON.stringify(saved) + "\n");
            },
          });
          store.finish(
            record.id,
            controller.signal.aborted
              ? "cancelled"
              : results?.every((r) => r.status === "completed")
                ? "completed"
                : "unresolved",
          );
          if (!res.destroyed)
            res.end(JSON.stringify({ type: "done", runId: record.id }) + "\n");
        } catch {
          store.finish(
            record.id,
            controller.signal.aborted ? "cancelled" : "error",
            "Comparison did not finish.",
          );
          if (!res.destroyed)
            res.end(
              JSON.stringify({ type: "error", message: "Comparison failed." }) +
                "\n",
            );
        } finally {
          clearTimeout(timeout);
          active--;
        }
      } catch (e) {
        if (!res.headersSent)
          reply(400, {
            error: e instanceof SyntaxError ? "Invalid JSON." : e.message,
          });
        else res.end();
      }
      return;
    }
    if (req.method === "GET" && Object.hasOwn(assets, path)) {
      const [file, type] = assets[path];
      try {
        const data = await readFile(
          new URL(`../public/${file}`, import.meta.url),
        );
        res.writeHead(200, { "Content-Type": `${type}; charset=utf-8` });
        res.end(data);
      } catch {
        reply(500, { error: "Missing application asset." });
      }
      return;
    }
    reply(404, { error: "Not found." });
  });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const config = configuration();
  const port = Number(process.env.PORT || 4317);
  createApp({ config }).listen(port, config.host, () =>
    console.log(`Travel Lab is running at http://${config.host}:${port}`),
  );
}
