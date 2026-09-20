import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createBlobRunStore } from "../src/blob-run-store.js";
import { createApp } from "../src/server.js";
import { configuration } from "../src/providers.js";
import { authorized } from "../api/index.js";

function fakeBlob() {
  const files = new Map<string, string>();
  let failWrites = false;
  return {
    files,
    fail(value: boolean) { failWrites = value; },
    client: {
      async put(path, body, options) {
        assert.equal(options.access, "private");
        if (failWrites && path.includes("/events/")) throw new Error("Storage unavailable");
        if (files.has(path)) assert.equal(options.allowOverwrite, true);
        files.set(path, body);
      },
      async get(path, options) {
        assert.equal(options.access, "private");
        assert.equal(options.useCache, false);
        return files.has(path) ? { statusCode: 200, stream: new Response(files.get(path)).body } : null;
      },
      async list({ prefix, cursor }) {
        const paths = [...files.keys()].filter((key) => key.startsWith(prefix)).sort();
        const offset = Number(cursor || 0);
        return {
          blobs: paths.slice(offset, offset + 2).map((pathname) => ({ pathname })),
          hasMore: offset + 2 < paths.length, cursor: String(offset + 2),
        };
      },
    } as any,
  };
}

test("private Blob history survives a new instance, paginates, and isolates owners", async () => {
  const blob = fakeBlob();
  const store = createBlobRunStore(blob.client);
  const ownerId = randomUUID();
  const record = await store.create({ ownerId, task: { city: "Tokyo" } });
  const event = { type: "tool_start", value: 1 };
  store.append(record.id, event);
  event.value = 999;
  store.append(record.id, { type: "tool_end", value: 2 });
  store.append(record.id, { type: "result", result: { team: "baseline", status: "completed" } });
  await store.finish(record.id, "completed");
  const fresh = createBlobRunStore(blob.client);
  const saved = await fresh.get(record.id, ownerId);
  assert.equal(saved.status, "completed");
  assert.equal(saved.events.length, 3);
  assert.equal(saved.events[0].value, 1);
  assert.equal(saved.results.length, 1);
  assert.equal((await fresh.list(ownerId)).length, 1);
  assert.deepEqual(await fresh.list(randomUUID()), []);
  await assert.rejects(() => fresh.get(record.id, randomUUID()));
  await assert.rejects(() => fresh.get("../../.env", ownerId));
});

test("failed event persistence cannot be marked completed", async () => {
  const blob = fakeBlob();
  const store = createBlobRunStore(blob.client);
  const ownerId = randomUUID();
  const record = await store.create({ ownerId });
  blob.fail(true);
  store.append(record.id, { type: "tool_start" });
  await assert.rejects(() => store.finish(record.id, "completed"), /save run history/);
  const fresh = createBlobRunStore(blob.client);
  assert.equal((await fresh.get(record.id, ownerId)).status, "error");
});

test("new instances leave active runs alone and identify expired runs as interrupted", async () => {
  const blob = fakeBlob();
  const store = createBlobRunStore(blob.client);
  const ownerId = randomUUID();
  const record = await store.create({ ownerId });
  const fresh = createBlobRunStore(blob.client);
  assert.equal((await fresh.get(record.id, ownerId)).status, "running");
  const path = `runs/${ownerId}/${record.id}/record.json`;
  blob.files.set(path, JSON.stringify({ ...record, createdAt: new Date(Date.now() - 400000).toISOString() }));
  assert.equal((await fresh.get(record.id, ownerId)).status, "interrupted");
});

test("HTTP comparisons await durable storage and history remains session-private", async () => {
  const blob = fakeBlob();
  const app = createApp({
    config: configuration({}),
    store: createBlobRunStore(blob.client),
    runner: (async ({ emit }) => {
      const result = { team: "baseline", status: "completed" };
      emit({ type: "result", result });
      return [result];
    }) as any,
  });
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(app.address() as any).port}`;
  try {
    const response = await fetch(base + "/api/compare", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "demo", task: { city: "Tokyo" } }),
    });
    const cookie = response.headers.get("set-cookie").split(";")[0];
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(events.at(-1).type, "done");
    const runId = events[0].runId;
    const saved = await (await fetch(base + `/api/runs/${runId}`, { headers: { cookie } })).json();
    assert.equal(saved.status, "completed");
    assert.equal(saved.results.length, 1);
    assert.equal((await fetch(base + `/api/runs/${runId}`)).status, 404);
    assert.equal((await (await fetch(base + "/api/runs", { headers: { cookie } })).json()).length, 1);
  } finally {
    app.closeAllConnections();
    await new Promise<void>((resolve) => app.close(() => resolve()));
  }
});

test("deployment password rejects missing or incorrect credentials", () => {
  assert.equal(authorized(undefined, "private"), false);
  assert.equal(authorized("Bearer private", "private"), false);
  assert.equal(authorized("Basic " + Buffer.from("user:wrong").toString("base64"), "private"), false);
  assert.equal(authorized("Basic " + Buffer.from("user:private").toString("base64"), "private"), true);
});
