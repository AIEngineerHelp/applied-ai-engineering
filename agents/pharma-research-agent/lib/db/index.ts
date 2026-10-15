// One database client for the whole app.
// - Production: Neon Postgres over HTTP (DATABASE_URL), migrated at build time.
// - Local development and tests: PGlite, an embedded Postgres in .data/pglite,
//   migrated automatically on first use. No Docker or local server needed.

import { join } from "node:path";
import * as schema from "./schema";

type Db = import("drizzle-orm/pglite").PgliteDatabase<typeof schema> | import("drizzle-orm/neon-http").NeonHttpDatabase<typeof schema>;

const MIGRATIONS = join(/*turbopackIgnore: true*/ process.cwd(), "drizzle");
const g = globalThis as unknown as { __db?: Promise<Db> };

async function connect(): Promise<Db> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const { neon } = await import("@neondatabase/serverless");
    const { drizzle } = await import("drizzle-orm/neon-http");
    return drizzle(neon(url), { schema });
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const dir = process.env.PGLITE_DIR ?? join(/*turbopackIgnore: true*/ process.cwd(), ".data", "pglite");
  if (dir !== "memory") (await import("node:fs")).mkdirSync(dir, { recursive: true });
  const client = dir === "memory" ? new PGlite() : new PGlite(dir);
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  return db;
}

/** The shared client; one connection (or PGlite instance) per process. */
export function db(): Promise<Db> {
  g.__db ??= connect().catch((err) => {
    g.__db = undefined;
    throw err;
  });
  return g.__db;
}

export { schema };
