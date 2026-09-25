# Deployment runbook

How to run the Incident Response Agent (IRA) as a production service. The interface the
deployment relies on (commands, ports, health endpoints, env vars, prod validation) is
defined in [`production-contract.md`](production-contract.md); change it there first.

| Piece | Where |
|---|---|
| api / worker / migrate image | `Dockerfile` (one image, different command) |
| UI image | `frontend/Dockerfile` |
| Single-host stack | `docker-compose.yml` |
| Kubernetes | Helm chart `deploy/helm/ira/` |
| LLM gateway | `deploy/litellm/config.yaml` |
| Metrics, alerts, dashboard | `deploy/prometheus/`, `deploy/grafana/`, `deploy/otel/` |
| CI | `.github/workflows/ci.yml` |

## 1. Prerequisites

- **PostgreSQL 16** with the `vector` (pgvector) extension available. Managed: Cloud SQL,
  RDS/Aurora, Azure Database for PostgreSQL (all ship pgvector). Self-hosted:
  `pgvector/pgvector:pg16` or bitnami/postgresql with a pgvector image. The extension must be
  created once by a privileged user: `CREATE EXTENSION IF NOT EXISTS vector;` (compose does
  this in `deploy/postgres/init/`; the migration fails with a clear message if it's missing and
  the migrate role can't create it). Use TLS: `POSTGRES_SSLMODE=verify-full` plus
  `POSTGRES_SSLROOTCERT=/path/to/ca.pem` (Helm: `postgres.sslmode`, default `require`).
- **Redis 7** with persistence (AOF). It holds the incident queue (Redis streams
  `incidents.sev1..sev4`, DLQ `incidents.dlq`); treat it as stateful, not as a cache.
  Managed: Memorystore / ElastiCache (non-cluster mode) or bitnami/redis.
- **LiteLLM proxy** holding the provider keys (Gemini, OpenAI for embeddings/fallback). In
  Kubernetes use the official LiteLLM chart with `deploy/litellm/config.yaml`.
- **OIDC identity provider** (Keycloak, Okta, Entra ID, Auth0, Google...).
- Optional: Neo4j 5 (knowledge graph), an OTLP endpoint for traces, Prometheus Operator, KEDA.
- Tooling: Docker 24+ with Compose v2.24+, or Kubernetes 1.27+ with Helm 3.14+ / 4.

## 2. Identity provider setup

1. **UI client**: create a *public* OIDC client (authorization code + PKCE, no secret), e.g.
   `ira-ui`.
   - Redirect URI: `https://<host>/auth/callback` (compose: `http://localhost:3000/auth/callback`).
   - Post-logout redirect / web origin: `https://<host>`.
   - Scopes: `openid profile email` (`OIDC_SCOPES`).
2. **API audience**: make access tokens issued to the UI carry an `aud` the API checks
   (`OIDC_AUDIENCE`, e.g. `ira-api`). Keycloak: audience mapper on the client; Okta/Auth0: an
   API / authorization server with that audience; Entra ID: expose an API and request its scope.
3. **Groups → roles**: add a claim with the user's groups (`OIDC_ROLES_CLAIM`, default
   `groups`) to the *access token*, then map groups to IRA roles:
   ```
   OIDC_ROLE_MAPPING={"sre":"responder","sre-leads":"approver","ira-admins":"admin"}
   ```
   Roles are cumulative: `viewer < responder < approver < admin`. A group literally named
   like a role maps to itself. Two-person approvals need two distinct `approver` users.
4. **Alert webhooks** (PagerDuty, Alertmanager) do not use OIDC: generate static intake tokens
   (`openssl rand -hex 32`, at least 32 chars) and put them in `INTAKE_TOKENS` (JSON list).
   They can only `POST /v1/incidents`.

The API only needs outbound HTTPS to the issuer (discovery + JWKS).

## 3. Secrets

| Name | Used by | Notes |
|---|---|---|
| `POSTGRES_PASSWORD` | api, worker, migrate | must not be the shipped default in prod |
| `LITELLM_MASTER_KEY` | api, worker, LiteLLM | bearer key for the proxy; not the default |
| `NEO4J_PASSWORD` | api, worker | required (non-default) only when `NEO4J_ENABLED=true` |
| `REDIS_URL` | api, worker | only when it carries credentials (`rediss://:pw@host:6380/0`) |
| `INTAKE_TOKENS` | api | JSON list of webhook tokens |
| `GEMINI_API_KEY`, `OPENAI_API_KEY` | LiteLLM only | never give provider keys to the app |
| `GRAFANA_ADMIN_PASSWORD` | compose grafana | compose only |

Kubernetes: create one Secret with the app keys (External Secrets Operator, Sealed Secrets or
Vault) and set `existingSecret`. Every key in it is exposed to api/worker/migrate as an env var.
`secrets.create=true` exists for throwaway clusters only.

## 4. First deploy: docker compose (single host)

```bash
cp .env.example .env
# edit .env: GEMINI_API_KEY, OPENAI_API_KEY, and change POSTGRES_PASSWORD,
# LITELLM_MASTER_KEY, NEO4J_PASSWORD, GRAFANA_ADMIN_PASSWORD
docker compose up -d --build          # postgres, redis, litellm, migrate, api, worker, frontend
docker compose ps                     # migrate should be "exited (0)"
curl -fsS localhost:8000/health/ready
open http://localhost:3000
```

Profiles: `--profile kg` adds Neo4j (also set `NEO4J_ENABLED=true`); `--profile observability`
adds otel-collector, Jaeger (:16686), Prometheus (:9090) and Grafana (:3001), and you should set
`OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318` in `.env`.

Compose defaults to `ENVIRONMENT=dev` and `AUTH_MODE=disabled`. **Prod-like run** (any
single-host deployment reachable by others):

```bash
# .env
ENVIRONMENT=prod
AUTH_MODE=oidc
OIDC_ISSUER=https://login.example.com/realms/ira
OIDC_AUDIENCE=ira-api
OIDC_CLIENT_ID=ira-ui
OIDC_ROLE_MAPPING={"sre":"responder","sre-leads":"approver","ira-admins":"admin"}
CORS_ORIGINS=["https://ira.example.com"]
POSTGRES_PASSWORD=<strong>   LITELLM_MASTER_KEY=sk-<strong>   NEO4J_PASSWORD=<strong>
```

then put a TLS reverse proxy in front of ports 3000/8000 (or rebuild the UI with
`NEXT_PUBLIC_API_URL=` and route `/v1`, `/health` to the api on the same host). The api and
worker refuse to start if the prod checks fail; `docker compose logs api` shows why.
Datastores are bound to 127.0.0.1; app containers run read-only, non-root, with all
capabilities dropped. The app containers always use the LiteLLM proxy (`GEMINI_API_KEY` is
blanked for them), so fallbacks and the budget apply.

## 5. First deploy: Helm

1. Provision Postgres (with `vector`), Redis, LiteLLM and the IdP client (sections 1-2).
2. Build and push images, or use the ones CI publishes on `v*` tags:
   `ghcr.io/<org>/<repo>` and `ghcr.io/<org>/<repo>-frontend`. The UI image published by CI is
   built with `NEXT_PUBLIC_API_URL=""` (same origin), which is what the ingress expects.
3. Create the Secret:
   ```bash
   kubectl create namespace ira
   kubectl -n ira create secret generic ira-secrets \
     --from-literal=POSTGRES_PASSWORD=... --from-literal=LITELLM_MASTER_KEY=sk-... \
     --from-literal=NEO4J_PASSWORD=... --from-literal=INTAKE_TOKENS='["<64 hex chars>"]'
   ```
4. Write `values-prod.yaml`:
   ```yaml
   existingSecret: ira-secrets
   image: {repository: ghcr.io/<org>/<repo>, tag: "1.2.0"}
   frontend:
     image: {repository: ghcr.io/<org>/<repo>-frontend, tag: "1.2.0"}
   auth:
     oidc:
       issuer: https://login.example.com/realms/ira
       audience: ira-api
       clientId: ira-ui
       roleMapping: {sre: responder, sre-leads: approver, ira-admins: admin}
   postgres: {host: ira.xxxx.eu-west-1.rds.amazonaws.com, database: ira_db, user: ira}
   redis: {url: redis://redis-master.redis.svc:6379/0}
   litellm: {url: http://litellm.litellm.svc:4000}
   ingress:
     host: ira.example.com
     annotations: {cert-manager.io/cluster-issuer: letsencrypt}
   artifacts:
     persistence: {enabled: true, storageClass: efs-sc}   # ReadWriteMany
   metrics:
     serviceMonitor: {enabled: true, labels: {release: kube-prometheus-stack}}
     prometheusRule: {enabled: true, labels: {release: kube-prometheus-stack}}
   ```
5. Install:
   ```bash
   helm upgrade --install ira deploy/helm/ira -n ira -f values-prod.yaml --wait --timeout 15m
   ```

What the chart creates: api Deployment/Service/HPA, worker Deployment/metrics Service/HPA (or
a KEDA ScaledObject), frontend Deployment/Service, a migration Job hook, ConfigMap, Ingress
(`/v1`, `/health` → api; `/` → frontend; `/metrics` is never routed), PDBs, NetworkPolicies,
optional ServiceMonitors/PrometheusRule. Pods run as uid 10001 with a read-only root
filesystem, no capabilities, seccomp `RuntimeDefault` and no service account token.

**NetworkPolicy**: the defaults assume the ingress controller runs in namespace
`ingress-nginx` and Prometheus in `monitoring`; adjust `networkPolicy.ingressController` /
`networkPolicy.prometheus`. Egress rules default to "any destination on the port"
(5432, 6379/6380, 4000, 443 for the IdP); tighten them with `to:` peers (CIDRs of your managed
databases). Tools that reach other systems (Loki, Prometheus, MCP servers) need
`networkPolicy.egress.workerExtra` rules.

## 6. Migrations

`alembic upgrade head` runs before new pods start: compose service `migrate`
(`service_completed_successfully` gates api/worker), Helm `pre-install,pre-upgrade` Job. If it
fails the release stops and the old pods keep serving; read `kubectl logs job/ira-migrate` (release `ira`;
failed Jobs are kept). Run manually with:

```bash
docker compose run --rm migrate                      # compose
kubectl -n ira run ira-migrate --rm -it --restart=Never --image=<image> \
  --overrides='{"spec":{"containers":[{"name":"m","image":"<image>","command":["alembic","upgrade","head"],"envFrom":[{"configMapRef":{"name":"ira-config"}},{"secretRef":{"name":"ira-secrets"}}]}]}}'
```

Write migrations to be backward compatible with the previous release (expand, deploy,
contract), because old pods run against the new schema during a rolling update and after a
rollback.

## 7. Scaling

- **api** is stateless: HPA on CPU (`api.autoscaling`), 2 replicas minimum.
- **worker**: HPA on CPU by default. With KEDA (`worker.keda.enabled=true`,
  `worker.keda.redis.address=host:port`) it scales on consumer-group lag of
  `incidents.sev1..sev4` (consumer group `orchestrators`). Workers are I/O bound on LLM calls,
  so lag-based scaling tracks load much better than CPU.
- Each api/worker pod needs about 1 GiB just for the Presidio spaCy model; size memory
  requests accordingly.
- Compose: `docker compose up -d --scale worker=3`.
- Postgres connections: `(api + worker replicas) x pool size` must stay under
  `max_connections`; put PgBouncer in front for large fleets.

## 8. Backups and data

- **Postgres** holds incidents, approvals, the audit log (1-year retention),
  LangGraph checkpoints and embeddings. Enable point-in-time recovery (managed: automated
  backups + PITR window ≥ 7 days; self-hosted: WAL archiving with pgBackRest/WAL-G) and test a
  restore quarterly. Export the audit table to object storage for long-term retention.
- **Redis** holds queued/in-flight incidents: enable AOF (`appendonly yes`, as in compose) and
  snapshots. Losing it loses queued work, not history.
- **Artifacts** (`ARTIFACTS_DIR`): scrubbed tool outputs; back up the PVC if reports must keep
  their evidence links.
- Compose volumes: `postgres_data`, `redis_data`, `artifacts`
  (`docker compose exec postgres pg_dump -U ira ira_db > backup.sql` for ad-hoc dumps).

## 9. Upgrading and rolling back

1. Read the release notes for migrations that are not backward compatible.
2. Take a Postgres snapshot (or note the PITR timestamp).
3. Compose: set `IRA_TAG`, `docker compose pull && docker compose up -d`.
   Helm: `helm upgrade ira deploy/helm/ira -n ira -f values-prod.yaml --set image.tag=X --set frontend.image.tag=X`.
4. Watch `kubectl rollout status deploy/ira-api deploy/ira-worker` and the Grafana dashboard.

Rollback: `helm rollback ira <revision>` restores the previous pods; it does **not** undo
migrations. If the old code cannot run on the new schema, run `alembic downgrade <rev>` with
the new image first, or restore the snapshot. Config/secret changes roll pods automatically
(`checksum/config` annotations); rotate an `existingSecret` with `kubectl rollout restart`.

## 10. Observability

- Metrics: api `:8000/metrics`, worker `:9100/metrics` (in-cluster only).
- Alerts (`deploy/prometheus/alerts.yml`, also shipped as a PrometheusRule): DLQ non-empty,
  incident failure rate > 5%, LLM cost spike, LLM provider failover, target down.
  `deploy/helm/ira/files/prometheus-alerts.yml` must stay identical (CI checks it).
- Dashboard: `deploy/grafana/dashboards/ira-overview.json` (incidents by status, time to
  report p50/p95, tool calls, guardrail denies, HITL wait, LLM cost, cache hits, fallbacks).
  Import it into your Grafana or let compose provision it.
- Traces: set `OTEL_EXPORTER_OTLP_ENDPOINT` (OTLP/HTTP, port 4318). The compose collector
  strips auth headers and SQL statements before exporting to Jaeger.
- Logs: `LOG_FORMAT=json` (default in compose and Helm) for your log pipeline.
- DLQ triage: `redis-cli XRANGE incidents.dlq - +`.

## 11. Security notes

- Prod validation (`ENVIRONMENT=prod`) refuses to start without OIDC, with default secrets,
  with any infra toggle off, or with `*` in `CORS_ORIGINS`.
- Only `/v1` and `/health` are public; `/metrics` stays inside the cluster.
- Provider API keys live only in LiteLLM. LiteLLM message logging is off
  (`turn_off_message_logging`) because prompts can contain production data; decide on data
  residency and use provider zero-retention options where available.
- Budgets: per incident `MAX_BUDGET_USD` (app), proxy-wide `max_budget` / `budget_duration`
  in `deploy/litellm/config.yaml` (persisted when LiteLLM has `DATABASE_URL`).
- **Sandbox**: the diagnostic sandbox is process-level only today (allow-listed read-only
  commands, timeouts, memory limits inside the worker container). Running untrusted scripts
  in a gVisor node pool (`runtimeClassName: gvisor`, a separate `sandbox-runner`) is future
  work; the chart exposes `worker.runtimeClassName` for when that pool exists.
- Images: non-root (uid 10001), slim base without build tools, scanned by Trivy in CI
  (fails on fixable CRITICAL findings).
