// Applies migrations to the Neon database in DATABASE_URL. Runs before `next build`
// on Vercel; PGlite (local) migrates itself on first use.
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { migrate } from "drizzle-orm/neon-http/migrator";

const url = process.env.DATABASE_URL;
if (!url) {
  console.log("No DATABASE_URL: skipping (local PGlite migrates on first use).");
  process.exit(0);
}
await migrate(drizzle(neon(url)), { migrationsFolder: "drizzle" });
console.log("Migrations applied.");
