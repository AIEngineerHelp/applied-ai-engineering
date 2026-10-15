// Applies migrations to the Neon database in DATABASE_URL. Runs before `next build`
// on Vercel; PGlite (local) migrates itself on first use.
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { migrate } from "drizzle-orm/neon-http/migrator";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log("No DATABASE_URL: skipping (local PGlite migrates on first use).");
    return;
  }
  await migrate(drizzle(neon(url)), { migrationsFolder: "drizzle" });
  console.log("Migrations applied.");
}

// No top-level await: tsx compiles this package's .ts files as CommonJS.
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
