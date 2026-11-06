// Build a static copy of the app in dist/ for deployment. Clear the previous
// export but keep dist/.vercel, the local Vercel project link.
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const out = fileURLToPath(new URL("../dist/", import.meta.url));
await mkdir(out, { recursive: true });
for (const name of await readdir(out))
  if (name !== ".vercel") await rm(join(out, name), { recursive: true, force: true });
await cp(new URL("../site/", import.meta.url), out, { recursive: true });
console.log(`Static export: ${out}`);
