import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const out = fileURLToPath(new URL("../dist/", import.meta.url));
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp(new URL("../site/", import.meta.url), out, { recursive: true });
console.log(`Static export: ${out}`);
