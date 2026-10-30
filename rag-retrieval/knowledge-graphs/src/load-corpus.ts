// Node-only: read corpus/*.md, sorted by date then id.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDoc, type Doc } from "./corpus.ts";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function loadCorpus(): Doc[] {
  const dir = join(ROOT, "corpus");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => parseDoc(readFileSync(join(dir, f), "utf8")))
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}

export const readJson = <T>(path: string): T => JSON.parse(readFileSync(join(ROOT, path), "utf8")) as T;
