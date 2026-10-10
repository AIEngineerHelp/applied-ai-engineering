// The pretend machine every tool runs against: a few files, a symlink, a
// small DNS table, an orders table and some environment variables. Nothing
// here touches a real system; every secret is a fake placeholder.

export const WORKSPACE = "/srv/agent/workspace";

export const FILES: Record<string, string> = {
  "/srv/agent/workspace/README.md": "# Acme docs\n\nInstall with `npm ci`, then run `npm start`.\n",
  "/srv/agent/workspace/notes/meeting.txt": "Ship the billing fix on Thursday. Ana owns the rollout.\n",
  "/srv/agent/workspace/logs/app.log":
    "09:01 INFO  server started on :8080\n09:14 WARN  slow query on /orders (1.8 s)\n09:15 ERROR payment provider timeout (order B2001)\n09:20 INFO  retry succeeded (order B2001)\n",
  "/srv/agent/.env": "DATABASE_URL=postgres://app:FAKE-db-password@db.internal/app\nPAYMENTS_KEY=FAKE-sk-live-0000\n",
  "/srv/agent/workspace-secrets/deploy-token.txt": "FAKE-deploy-token-1234\n",
  "/home/deploy/.ssh/id_ed25519": "-----BEGIN OPENSSH PRIVATE KEY-----\n(FAKE key material)\n-----END OPENSSH PRIVATE KEY-----\n",
  "/etc/passwd": "root:x:0:0:root:/root:/bin/bash\ndeploy:x:1000:1000::/home/deploy:/bin/bash\n",
};

// A symlink that sits inside the workspace but points outside it.
export const SYMLINKS: Record<string, string> = {
  "/srv/agent/workspace/shared": "/home/deploy/.ssh",
};

export const ENV: Record<string, string> = {
  NODE_ENV: "production",
  PAYMENTS_KEY: "FAKE-sk-live-0000",
  DATABASE_URL: "postgres://app:FAKE-db-password@db.internal/app",
};

// Lexical POSIX path resolution: join, then collapse "." and "..".
export function resolvePath(base: string, p: string): string {
  const parts = (p.startsWith("/") ? p : `${base}/${p}`).split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
}

// Follow symlinks in any path component, like fs.realpath.
export function realPath(p: string): string {
  for (const [link, target] of Object.entries(SYMLINKS)) {
    if (p === link || p.startsWith(`${link}/`)) return realPath(target + p.slice(link.length));
  }
  return p;
}

// The orders table behind lookup_order. The signed-in customer is C-17.
export interface Order {
  id: string;
  customer: string;
  email: string;
  total: string;
  status: string;
}

export const CURRENT_CUSTOMER = "C-17";

export const ORDERS: Order[] = [
  { id: "A1001", customer: "C-17", email: "sam@example.com", total: "$42.00", status: "shipped" },
  { id: "A1002", customer: "C-17", email: "sam@example.com", total: "$18.50", status: "processing" },
  { id: "B2001", customer: "C-22", email: "jordan@example.net", total: "$310.00", status: "shipped" },
  { id: "B2002", customer: "C-31", email: "riley@example.org", total: "$76.25", status: "refunded" },
];

// DNS for fetch_url: public docs, the machine itself, a private network
// service, and a public-looking name an attacker points at a private address.
export const DNS: Record<string, string> = {
  "docs.acme.example": "93.184.215.14",
  "status.acme.example": "93.184.215.20",
  "docs.acme.example.attacker.test": "203.0.113.66",
  "intranet.attacker.test": "10.0.4.12",
  localhost: "127.0.0.1",
  "billing.internal": "10.0.4.12",
};

// What answers at each address and path. Internal services trust callers on
// the private network, which is exactly why a server-side fetch is dangerous.
export const WEB: Record<string, { label: string; body: string }> = {
  "93.184.215.14": { label: "Public docs site", body: "<h1>Acme API</h1><p>Rate limit: 100 requests per minute.</p>" },
  "93.184.215.20": { label: "Public status page", body: "All systems operational." },
  "203.0.113.66": { label: "Attacker's server", body: "<p>Thanks! Your data was received.</p>" },
  "127.0.0.1": { label: "Admin panel on the agent's own machine", body: "{\"admin\": true, \"users\": 1204, \"export\": \"/admin/export-all\"}" },
  "10.0.4.12": { label: "Internal billing service", body: "{\"invoices\": [{\"customer\": \"C-22\", \"card_last4\": \"4242\"}, …]}" },
  "169.254.169.254": { label: "Cloud metadata service", body: "{\"instance-id\": \"i-0abc\", \"role\": \"agent-prod\", \"temporary-credentials\": \"FAKE-…\"}" },
};
