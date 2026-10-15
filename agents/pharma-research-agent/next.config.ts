import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
];

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // Embedded Postgres and the PDF renderer stay as runtime dependencies, not bundled.
  serverExternalPackages: ["@electric-sql/pglite", "@react-pdf/renderer"],
  // Files read at runtime: skill playbooks, offline fixtures, migrations.
  outputFileTracingIncludes: {
    "/**": ["./agent/skills/**/*.md", "./agent/offline/fixtures/**/*.json", "./drizzle/**/*"],
  },
  turbopack: {
    rules: {
      "*.css": { loaders: ["@tailwindcss/turbopack"], as: "*.css" },
    },
  },
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default withWorkflow(nextConfig);
