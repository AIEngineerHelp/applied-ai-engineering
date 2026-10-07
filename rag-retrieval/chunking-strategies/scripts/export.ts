// Build a static copy of the app in dist/ for deployment: site/ (with the
// bundled script and stylesheet in site/build/) and the sample documents.
import { cpSync, rmSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "dist");
// Clear the previous export but keep dist/.vercel, the local Vercel project link.
mkdirSync(OUT, { recursive: true });
for (const name of readdirSync(OUT)) {
  if (name !== ".vercel") rmSync(join(OUT, name), { recursive: true, force: true });
}
cpSync(join(ROOT, "site"), OUT, { recursive: true });
cpSync(join(ROOT, "corpus"), join(OUT, "corpus"), { recursive: true });
writeFileSync(join(OUT, "vercel.json"), `${JSON.stringify({ cleanUrls: true }, null, 2)}\n`);
console.log(`Exported to ${OUT}`);
