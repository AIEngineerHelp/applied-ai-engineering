# Incident Response Agent: dashboard

Next.js operator UI for the incident response agent: Overview, Incidents (with the agent's
live activity feed), Logs, Knowledge graph, Evals, Approvals and Audit log.
See the [project README](../README.md) for what the product does and how to run it.

```bash
npm ci
npm run dev        # http://localhost:3000, expects the API at NEXT_PUBLIC_API_URL (default http://localhost:8000)
npm run lint && npm run build
```

- Design rules: [design-system/MASTER.md](design-system/MASTER.md) (tokens, typography, components).
- API contract: [../docs/production-contract.md](../docs/production-contract.md).
- Sign-in: OIDC (Authorization Code + PKCE) when the API reports `mode: "oidc"`; no login when auth is disabled.
- Production image: `Dockerfile` (standalone output). `NEXT_PUBLIC_API_URL` is baked in at build time; empty means same origin.
