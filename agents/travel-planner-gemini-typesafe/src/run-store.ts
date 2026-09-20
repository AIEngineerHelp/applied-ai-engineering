import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// One server process owns the directory. Each event is flushed before streaming it.
export function createRunStore(
  directory = fileURLToPath(new URL("../.runs/", import.meta.url)),
  { recover = false } = {},
) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const valid = (id) => /^[a-f0-9-]{36}$/.test(id);
  const path = (id) => {
    if (!valid(id)) throw new Error("Invalid run ID");
    return join(directory, id);
  };
  function save(record) {
    const target = path(record.id) + ".json";
    writeFileSync(target + ".tmp", JSON.stringify(record), { mode: 0o600 });
    renameSync(target + ".tmp", target);
  }
  function metadata(id) {
    return JSON.parse(readFileSync(path(id) + ".json", "utf8"));
  }
  function list() {
    return readdirSync(directory)
      .filter((n) => n.endsWith(".json"))
      .map((n) => metadata(n.slice(0, -5)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  function append(id, event) {
    const fd = openSync(path(id) + ".ndjson", "a", 0o600);
    try {
      writeSync(fd, JSON.stringify(event) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  function get(id) {
    const record = metadata(id);
    let lines = "";
    try {
      lines = readFileSync(path(id) + ".ndjson", "utf8");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    const events = [];
    for (const line of lines.split("\n")) {
      if (!line) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        /* Retain readable events after a torn final write. */
      }
    }
    return {
      ...record,
      events,
      results: events.filter((e) => e.type === "result").map((e) => e.result),
    };
  }
  // Runs left active by a stopped server keep their partial traces.
  if (recover)
    for (const record of list())
      if (record.status === "running")
        save({
          ...record,
          status: "interrupted",
          finishedAt: new Date().toISOString(),
        });
  return {
    create(details) {
      const record = {
        ...details,
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        status: "running",
      };
      save(record);
      return record;
    },
    append,
    get,
    list,
    finish(id, status, error = null) {
      const record = metadata(id);
      save({ ...record, status, error, finishedAt: new Date().toISOString() });
    },
  };
}

export function redact(value, secrets = []) {
  let text = JSON.stringify(value);
  for (const secret of secrets)
    if (secret) text = text.split(secret).join("[REDACTED]");
  return JSON.parse(text);
}
