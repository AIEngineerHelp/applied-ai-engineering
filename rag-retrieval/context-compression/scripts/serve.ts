import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAppServer } from "../src/server.ts";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../site");
const port = Number(process.env.PORT ?? 4325);
createAppServer(root).listen(port, "127.0.0.1", () =>
  console.log(`Context Compression Lab: http://127.0.0.1:${port}`),
);
