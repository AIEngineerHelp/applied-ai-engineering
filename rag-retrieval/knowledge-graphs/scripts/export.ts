// Build the deployable copy in dist/: the static page, plus the "Ask your own
// question" function bundled into dist/api/ask.js with everything it imports
// (the SDKs and results/graph.json), so Vercel serves dist/ as it is, with no
// install or build step. Deploy from dist/ (see README, "Deploy").
import { cpSync, rmSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "dist");
// Clear the previous export but keep dist/.vercel, the local Vercel project link.
mkdirSync(OUT, { recursive: true });
for (const name of readdirSync(OUT)) {
  if (name !== ".vercel") rmSync(join(OUT, name), { recursive: true, force: true });
}
cpSync(join(ROOT, "site"), OUT, { recursive: true });

await build({
  entryPoints: [join(ROOT, "api", "ask.ts")],
  outfile: join(OUT, "api", "ask.js"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  // Some dependencies still call require() for Node built-ins.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  legalComments: "none",
  logLevel: "warning",
});
writeFileSync(join(OUT, "package.json"), `${JSON.stringify({ private: true, type: "module", engines: { node: ">=22" } }, null, 2)}\n`);
writeFileSync(
  join(OUT, "vercel.json"),
  `${JSON.stringify({ cleanUrls: true, functions: { "api/ask.js": { maxDuration: 30, memory: 1024 } } }, null, 2)}\n`,
);
console.log(`Exported to ${OUT} (static page and api/ask.js)`);
