import { get, list, put } from "@vercel/blob";
import { randomUUID } from "node:crypto";
import type { RunStore } from "./server.js";

// Immutable event batches survive function restarts. Only the small run record
// is overwritten; reads bypass the Blob cache to observe its terminal status.
export function createBlobRunStore(client = { get, list, put }): RunStore {
  const pending = new Map<string, {
    record: any; sequence: number; writes: Promise<void>; error?: Error;
  }>();
  function prefix(ownerId: string, id = "") {
    if (!/^[a-f0-9-]{36}$/.test(ownerId || "") ||
        (id && !/^[a-f0-9-]{36}$/.test(id))) throw new Error("Run not found.");
    return `runs/${ownerId}/${id ? id + "/" : ""}`;
  }
  async function read(path: string) {
    const result = await client.get(path, { access: "private", useCache: false });
    if (!result || result.statusCode !== 200 || !result.stream) throw new Error("Run not found.");
    return JSON.parse(await new Response(result.stream).text());
  }
  async function paths(pathPrefix: string) {
    const found: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.list({ prefix: pathPrefix, cursor, limit: 1000 });
      found.push(...page.blobs.map((blob) => blob.pathname));
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return found;
  }
  async function write(path: string, value: any, overwrite = false) {
    await client.put(path, JSON.stringify(value), {
      access: "private", addRandomSuffix: false, allowOverwrite: overwrite,
      contentType: "application/json", cacheControlMaxAge: 60,
    });
  }
  function interrupted(record: any) {
    // No startup-wide recovery: other serverless instances may still be running.
    return record.status === "running" && Date.now() - Date.parse(record.createdAt) > 360000
      ? { ...record, status: "interrupted" } : record;
  }
  return {
    async create(details) {
      const record = { ...details, id: randomUUID(), createdAt: new Date().toISOString(), status: "running" };
      await write(prefix(record.ownerId, record.id) + "record.json", record);
      pending.set(record.id, { record, sequence: 0, writes: Promise.resolve() });
      return record;
    },
    append(id, event) {
      const run = pending.get(id);
      if (!run) throw new Error("Run is not active.");
      if (run.error) throw new Error("Could not save run history.");
      const snapshot = structuredClone(event);
      const path = prefix(run.record.ownerId, id) + `events/${String(run.sequence++).padStart(6, "0")}.json`;
      run.writes = run.writes.then(async () => {
        if (!run.error) await write(path, snapshot);
      }).catch(() => { run.error = new Error("Could not save run history."); });
    },
    async list(ownerId) {
      const records = (await paths(prefix(ownerId))).filter((path) => path.endsWith("/record.json"));
      const results = [];
      for (const path of records) results.push(interrupted(await read(path)));
      return results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async get(id, ownerId) {
      const base = prefix(ownerId, id);
      const record = interrupted(await read(base + "record.json"));
      if (record.ownerId !== ownerId) throw new Error("Run not found.");
      const events = [];
      const eventPaths = (await paths(base + "events/")).sort();
      // Bound read concurrency for large traces.
      for (let i = 0; i < eventPaths.length; i += 10)
        events.push(...await Promise.all(eventPaths.slice(i, i + 10).map(read)));
      return { ...record, events, results: events.filter((event) => event.type === "result").map((event) => event.result) };
    },
    async finish(id, status, error = null) {
      const run = pending.get(id);
      if (!run) throw new Error("Run is not active.");
      await run.writes;
      await write(prefix(run.record.ownerId, id) + "record.json", {
        ...run.record, status: run.error ? "error" : status,
        error: run.error ? "Could not save the complete run history." : error,
        finishedAt: new Date().toISOString(),
      }, true);
      pending.delete(id);
      if (run.error) throw run.error;
    },
  };
}
