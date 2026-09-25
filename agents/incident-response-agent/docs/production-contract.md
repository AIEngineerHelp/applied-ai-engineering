# Production interface contract

Shared contract between the backend (`src/`), the operator UI (`frontend/`) and the
deployment assets (`deploy/`, Dockerfiles, compose, Helm, CI). Change it here first.

## Processes

| Process  | Command                                                         | Port | Notes |
|----------|-----------------------------------------------------------------|------|-------|
| api      | `python -m src.ira.api`                                         | 8000 | Uvicorn, `--proxy-headers`; serves `/metrics` on the same port |
| worker   | `python -m src.ira.worker`                                      | 9100 | Consumes Redis streams, runs the LangGraph orchestrator; `/metrics`, `/health/live`, `/health/ready` on 9100 |
| migrate  | `alembic upgrade head`                                          | -    | Run once per release before api/worker start (Helm pre-upgrade hook / compose one-shot) |
| frontend | `node server.js` (Next.js standalone output)                    | 3000 | Built from `frontend/Dockerfile` |

The api and worker share one Python image (`Dockerfile` at the repo root); only the command differs.
Both run as a non-root user and need a writable `ARTIFACTS_DIR` (default `/var/lib/ira/artifacts`).

Health endpoints (api on 8000, worker on 9100):
- `GET /health/live` → 200 while the process is up.
- `GET /health/ready` → 200 when Postgres and Redis (when enabled) are reachable, else 503 with `{"status": "unavailable", "checks": {...}}`.
- `GET /metrics` → Prometheus text format.

## Environment variables (in addition to `.env.example`)

| Variable | Default | Meaning |
|---|---|---|
| `ENVIRONMENT` | `dev` | `prod` enables strict startup validation (see below) |
| `LOG_FORMAT` | `text` | `json` for structured logs |
| `AUTH_MODE` | `disabled` | `oidc` or `disabled`. `disabled` is refused when `ENVIRONMENT=prod` |
| `OIDC_ISSUER` | - | e.g. `https://login.example.com/realms/ira` |
| `OIDC_AUDIENCE` | - | Expected `aud` claim of API access tokens |
| `OIDC_CLIENT_ID` | - | Public client id the UI uses (PKCE, no secret) |
| `OIDC_SCOPES` | `openid profile email` | Scopes the UI requests |
| `OIDC_ROLES_CLAIM` | `groups` | Claim holding the user's groups/roles |
| `OIDC_ROLE_MAPPING` | `{}` | JSON: IdP group → role, e.g. `{"sre":"responder","sre-leads":"approver","ira-admins":"admin"}`. A group equal to a role name maps to itself |
| `INTAKE_TOKENS` | `[]` | JSON list of static bearer tokens for alert webhooks (PagerDuty/Alertmanager). They grant only `POST /v1/incidents` |
| `REDIS_ENABLED` / `POSTGRES_ENABLED` / `QUEUE_ENABLED` | `false` | All three must be `true` in prod |
| `NEO4J_ENABLED` | `false` | Optional knowledge graph |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | - | When set, traces are exported via OTLP/HTTP |
| `ARTIFACTS_DIR` | `data/artifacts` | Writable directory for scrubbed tool outputs |
| `CORS_ORIGINS` | localhost:3000 | JSON list; in prod must be explicit (no `*`) |

`ENVIRONMENT=prod` refuses to start unless: `AUTH_MODE=oidc` with issuer/audience set; Redis, Postgres and the
queue are enabled; `POSTGRES_PASSWORD`, `NEO4J_PASSWORD` and `LITELLM_MASTER_KEY` are not the shipped defaults;
`CORS_ORIGINS` has no `*`.

Frontend build/runtime:
- `NEXT_PUBLIC_API_URL`: API base URL baked at build time. Empty string means same origin (ingress routes `/v1`, `/health`, `/metrics` is NOT exposed publicly). Default `http://localhost:8000`.

## Roles (RBAC)

`viewer` < `responder` < `approver` < `admin` (each includes the previous).

| Endpoint | Minimum role |
|---|---|
| `GET /v1/auth/config` | public |
| `GET /v1/me` | any authenticated user |
| `GET /v1/incidents`, `GET /v1/incidents/{id}`, `GET /v1/approvals/pending` | viewer |
| `POST /v1/incidents` | responder, or an intake token |
| `POST /v1/approvals/{action_id}/decision` | approver |
| `GET /v1/datasets`, `GET /v1/datasets/{name}`, `/logs`, `/templates` | viewer |
| `GET /v1/evals`, `GET /v1/evals/{run_id}` | viewer |
| `GET /v1/graph/overview`, `GET /v1/graph`, `/graph/node`, `/graph/search` | viewer |
| `GET /v1/audit` | admin |

401 = missing/invalid token (UI should (re)login). 403 = authenticated but lacking the role.

## New / changed API shapes

```ts
// GET /v1/auth/config  (public)
interface AuthConfig { mode: 'oidc' | 'disabled'; issuer: string | null; client_id: string | null; scopes: string; audience: string | null; }

// GET /v1/me
interface Me { sub: string; name: string | null; email: string | null; roles: ('viewer'|'responder'|'approver'|'admin')[]; }

// ProposedAction gains:
//   required_approvals: number        // 1, or 2 for two-person actions (destructive risk or manifest approval "two_person")
//   approvals: Approval[]             // individual approver decisions so far (distinct approvers)
// `approval` remains the final decision (null until decided).

// PendingApproval gains: required_approvals: number; approvals: Approval[]

// POST /v1/approvals/{action_id}/decision
//   body: { decision: 'approved' | 'rejected'; comment?: string }   // `by` is REMOVED: identity comes from the token
//   200 { status: 'accepted' | 'recorded', decision: {...} }  // 'recorded' = first of two approvals, still pending
//   403 if the caller lacks the approver role, or already approved this action (two-person rule needs a different person)
//   404 unknown action, 409 already decided

// POST /v1/incidents
//   Idempotent on (source, external_id): a repeat returns the existing incident with 200 instead of 201.
//   Dedup: an identical signature_hash with an active (non-terminal) incident returns that incident with 200.

// IncidentDetail.run gains:
//   activity: ActivityEntry[]   // live narration of what the agent is doing, oldest first, max 200
interface ActivityEntry { at: string; node: string; message: string; iteration: number; }
// Messages are factual and generated from real progress, e.g.
//   "Searching memory for similar past incidents"
//   "i1.s2 · Isolate log events for failed password attempts"
//   "3 event types, 520 lines; most frequent: “Failed password for <*> …” ×383"
//   "Weighing 3 pieces of evidence against the fault taxonomy"
//   "Top hypothesis: auth-failure in sshd (95% confidence, cites i1.s1, i1.s2)"
//   "Waiting for a human to approve k8s.rollout_undo"

// GET /v1/datasets → { citation: {text, url, repository}, datasets: DatasetSummary[] }
// GET /v1/datasets/{name} → DatasetSummary            (404 unknown)
interface DatasetSummary {
  name: string;                 // value for the incident label `dataset=<name>`
  title: string; category: string | null; description: string;
  source_url: string;           // Loghub page for this dataset
  lines: number; event_types: number; time_start: string | null; time_end: string | null;
  columns: string[]; levels: Record<string, number>;    // levels empty if the dataset has none
  top_templates: { event_id: string; template: string; count: number }[];
  suggested_incidents: { title: string; description: string; service: string; severity: Severity }[];
}
// GET /v1/datasets/{name}/logs?q=&event_id=&level=&component=&offset=0&limit=100 (limit ≤ 200)
//   → { dataset, total, offset, limit, pii_redacted: true,
//       lines: { line_id, time, level|null, component|null, event_id, template, content }[] }
//   Content is PII-scrubbed exactly like the agent sees it; ground-truth label columns are hidden.
// GET /v1/datasets/{name}/templates?q= → { event_id, template, count, share, levels: string[], first_line }[]

// GET /v1/evals → { methodology: string /* markdown, docs/evals.md */, runs: EvalRunSummary[] /* newest first */ }
// GET /v1/evals/{run_id} → EvalRunSummary & { per_label: Record<string, {n, lenient, strict}>, cases: EvalCase[] }   (404 unknown)
interface EvalRunSummary {
  run_id: string; dataset: string; started_at: string | null; seed: number | null;
  holdout: boolean; exclude_seed: number | null; git_commit: string | null;
  label: string | null; notes: string | null;            // from evals/results/runs.yaml
  models: Record<string, string>;
  metrics: { cases: number; fault_top1_strict: number; fault_top1_lenient: number;
    fault_top3_lenient: number; node_top1: number; precision_when_confident: number | null;
    confident_cases: number; mean_confidence_correct: number | null;
    mean_confidence_wrong: number | null; baseline_majority_class: string;
    baseline_strict: number; baseline_lenient: number; total_cost_usd: number;
    mean_seconds: number; mean_iterations: number; errors: number; no_hypothesis: number;
    target_fault_accuracy: number };                      // older runs may lack some keys (null)
}
interface EvalCase { case_id: string; node: string; label: string; expected: string; accepted: string[];
  predicted: string | null; component: string | null; confidence: number | null; top3: string[];
  fault_strict: boolean; fault_lenient: boolean; fault_top3_lenient: boolean; node_top1: boolean;
  iterations: number; cost_usd: number; seconds: number; error: string | null; description: string | null; }

// Knowledge graph (Neo4j, built from the log files + investigated incidents). 503 when NEO4J is off/down.
// GET /v1/graph/overview → { datasets: { dataset, kinds: Record<kind, number>, nodes, edges, incidents }[] }
// GET /v1/graph?dataset=BGL&limit=150 (10..400) → { dataset, nodes: GraphNode[], edges: GraphEdge[], truncated: boolean, total_nodes: number }
//   The most informative slice: entities ranked by error lines then connectivity, plus their containment
//   ancestors (Rack > Midplane > NodeCard > Host) and incidents attached to them.
// GET /v1/graph/node?key=<key>&limit=120 → { center: key, nodes, edges }   (the node + its direct neighbours; 404 unknown)
// GET /v1/graph/search?q=R30 (min 2 chars) → GraphNode[]
interface GraphNode {
  key: string;            // "<dataset>:<kind>:<name>", e.g. "BGL:Host:R30-M0-N9-C:J16-U01", "global:Incident:<uuid>"
  kind: 'Dataset'|'Rack'|'Midplane'|'NodeCard'|'Host'|'Component'|'EventType'|'IP'|'User'|'Service'
      |'Instance'|'RemoteHost'|'Incident'|'FaultType';
  name: string; dataset: string | null; degree: number | null;
  props: { lines?: number; errors?: number;              // log lines / error-level lines
           template?: string;                            // EventType
           card_type?: 'compute'|'io'|'other';           // NodeCard
           incident_id?: string; severity?: string; status?: string; verified?: boolean;  // Incident
           instance_id?: string; [k: string]: unknown };
}
interface GraphEdge {
  source: string; target: string;
  type: 'CONTAINS'|'HAS_COMPONENT'|'RUNS'|'EMITS'|'CONNECTS_TO'|'MANAGES'|'FAILED_LOGIN'|'ACCEPTED_LOGIN'
      |'SENDS_BLOCKS'|'ABOUT'|'ALERTED_ON'|'ROOT_CAUSE'|'HAS_FAULT';
  count: number | null;       // supporting log lines
  confidence: number | null;  // ROOT_CAUSE only
}

// GET /v1/audit?incident_id=&limit=  (admin)  → AuditEvent[]
interface AuditEvent { id: number; at: string; actor: string; action: string; incident_id: string | null; details: Record<string, unknown>; }
```
