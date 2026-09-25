# Incident Response Agent

An AI agent that investigates operational incidents the way an on-call engineer would: it
reads the alert, plans an investigation, queries the logs, forms evidence-backed hypotheses,
proposes a fix, asks a human before doing anything risky, and writes a root-cause report.

It runs locally against 14 public [Loghub](https://github.com/logpai/loghub) log datasets
(supercomputers, Hadoop, OpenSSH, ZooKeeper and more) and comes with a web dashboard, a
knowledge graph built from the logs, and a reproducible evaluation with an answer key.

> **Status: a working, evaluated prototype, not a finished product.** It uses a
> production-style architecture (queue, workers, persistence, auth, audit log,
> observability), but it only reads sample log files and never changes a real system.
> See [Extending the project](#extending-the-project) for the features that would take it further.

---

## What it does

You send an incident, for example *"Spike in SSH authentication failures on bastion hosts"*
with the label `dataset=OpenSSH`. The agent:

1. **Plans** a short, read-only investigation starting from what the alert names.
2. **Gathers evidence** by querying the logs (event types, counts, specific machines).
3. **Analyses** the evidence into ranked hypotheses. Each must cite the evidence it relies on.
4. **Proposes a fix** using tools from a registry. Guardrails check it, and anything that
   isn't read-only waits for a human to approve.
5. **Reports**: a Markdown root-cause report, plus a live activity feed you can watch while it
   works.

Example result for the SSH incident: *"auth-failure: a brute-force / password-spraying
attack. 383 failed passwords for valid users and 135 for invalid users, with one successful
login"*, found in about 60 seconds for about $0.05.

## How good is it?

We test it like an exam with a known answer key: logs from the Blue Gene/L supercomputer,
where experts labelled which machines failed and why. The agent gets a short alert per broken
machine and must name **what** failed and **where**. Marking is plain code (no LLM judge).

| Test | Right problem | Right machine |
|---|---|---|
| 28 incidents | **27 of 28** (96%) | **28 of 28** |
| 28 incidents never used while improving the agent | **28 of 28** | **28 of 28** |
| A lazy guess (always the most common answer) | 71% | – |

Pass mark: 70%. **Known weakness:** when it is wrong, it still reports about 90% confidence,
so treat its answers as strong suggestions. Results cover BGL only (the one dataset with
labels). Method, commands and every answer: [docs/evals.md](docs/evals.md) and the
dashboard's **Evals** tab.

## How the agent works

The agent is a [LangGraph](https://github.com/langchain-ai/langgraph) state machine. Each box
is a node; state is checkpointed after every node, so a crashed run resumes where it stopped.

```text
 alert ──► load context ──► plan ──► gather ──► analyze ──┬──► propose ──► guardrails ──► approval ──► execute ──► verify ──► report ──► save to memory
           (memory +        (LLM)    (tools     (LLM)     │     (LLM)       (policy +      (human,     (tools)
            knowledge                 + LLM                │                  2-model        LangGraph
            graph)                    summary)             │                  safety check)  interrupt)
                               ▲                           │
                               └── confidence < 60%: ──────┘   rejected by a human ──► plan again
                                   plan another round
                                   (max 3 rounds, $2 budget)
```

### A walk-through: one real incident

Alert: *"Spike in SSH authentication failures on bastion hosts"*, `severity=sev2`,
`dataset=OpenSSH`. The results are from a real run; the right-hand column shows what the
dashboard's live activity feed prints at each stage.

| Stage | What happened | Activity feed |
|---|---|---|
| Intake | Description PII-scrubbed, signature computed, no duplicate or cached answer, queued as sev2 | – |
| Load context | No similar past incident found | `Searching memory for similar past incidents` |
| Plan | Three read-only steps: (1) event distribution of all OpenSSH logs, (2) filter to failed passwords, (3) filter to accepted passwords, *"to determine if the attack was successful"* | `Planning the investigation with 2 read-only tools` → `Planned 3 steps` |
| Gather | Runs `log_explorer` three times. Each result is scrubbed, saved as an artifact and summarised | `i1.s2 · Isolate log events for failed password attempts` → `3 event types, 520 lines; most frequent: “Failed password for <*> from <*> port <*> ssh2” ×383` |
| Analyze | Hypothesis: **auth-failure** in `sshd`, confidence 0.95, citing all three steps: brute force with 383 + 135 failed passwords and 1 successful login | `Weighing 3 pieces of evidence…` → `Top hypothesis: auth-failure in sshd (95% confidence…)` |
| Propose | No action proposed; the registry has no firewall or IP-blocking tool that would fit | `No remediation proposed; the evidence does not justify an action` |
| Verify / report | Nothing executed, so "not verified". Report with summary, timeline and follow-ups (rate-limit SSH, key-only auth, MFA, investigate the source IPs) | `Writing the RCA report` |

About 66 seconds and $0.055 in total.

### Every stage in detail

**Intake** (API, before the agent starts)
1. PII is scrubbed from the title, description, label values and raw payload.
2. A *signature* is built from the source, service, environment, key labels and the title with
   variable parts (UUIDs, IPs, hex ids, long numbers) normalised, then hashed.
3. Duplicates are merged: the same `source` + `external_id` returns the existing incident, and
   an identical signature attaches to the incident that's still open.
4. Caches are checked: an exact signature match (Redis) or a similar past incident (pgvector,
   similarity ≥ 0.92) returns the stored answer, but **only if that resolution was verified**.
5. Otherwise the incident is queued on a Redis stream by severity (sev1 first) for a worker.

**1. Load context:** semantic search for similar past incidents (when Postgres is on) and a
knowledge-graph lookup of the alerted entities (see [What the agent sees](#what-the-agent-sees)).

**2. Plan** (planner LLM): gets the alert, the investigation scope, the context, the read-only
tools with their input schemas, and, on later rounds, the previous steps, evidence,
hypotheses and any action a human rejected. It returns 2–4 steps (`goal`, `tool`, arguments,
dependencies). Rules: start from the alerted entity; at most one cluster-wide comparison;
never repeat a step. A step that names a non-read tool is marked *skipped*, not run.

**3. Gather:** each step's tool runs with the timeout from its manifest. Output is cut at
12,000 characters, PII-scrubbed, saved to `data/artifacts/<incident>/<step>.txt`, and
summarised by the gatherer LLM (the output is marked as untrusted data, so instructions
inside logs are ignored). If a tool fails, the evidence is recorded as **failed** and can't be
cited.

**4. Analyze** (analyst LLM): gets the alert and alerted entities, the usable evidence, the
failed steps and the context, and returns ranked hypotheses. Code then drops hypotheses that
cite no real evidence, maps unknown fault types to `unknown`, clamps confidence and sorts.
If the best confidence is below 0.6, another round is planned (up to 3 rounds and $2).

**5. Propose** (remediation planner LLM): suggests the smallest safe fix from **all** tools
allowed in the incident's environment, or nothing. Its risk level is ignored until guardrails.

**6. Guardrails:** each proposed action is checked in order, and blocked with a reason
(visible in the UI and audit log) at the first failure:
1. the tool exists in the registry;
2. it's allowed in this environment (e.g. `k8s.rollout_undo` only in staging/prod);
3. all required arguments are present;
4. an executor is registered for it;
5. its **risk comes from the registry**, not the model;
6. for non-read actions, two different models must each answer SAFE.

Then the approval policy applies: read-only tools with `approval: none` are auto-approved;
everything else waits for a human, and destructive or `two_person` tools need two different
approvers.

**7. Approval:** the run pauses (LangGraph interrupt) until someone decides in the UI or API.
Decisions are audited. Unanswered approvals expire after 1 hour and count as rejected. A
rejection starts a new planning round that knows what was rejected and why.

**8. Execute:** only actions with an approval record run. Results are PII-scrubbed and stored.

**9. Verify:** no automatic check exists yet, so executed fixes are reported as *not verified*.

**10. Report** (reporter LLM): summary, full Markdown report, timeline and follow-ups. If it
fails, a deterministic report built from the recorded facts is used, clearly labelled.

**11. Save to memory:** the outcome is written to the knowledge graph, to Postgres
(resolution + embedding), and to the exact cache, the last only when verified.

### What the agent sees

| Input | Example (from a BGL alert) | Used by |
|---|---|---|
| Alert | title, description, severity, service, labels `dataset=BGL`, `node=R30-M0-N9-C:J16-U01` | planner, analyst |
| Investigation scope | alerted entities `{node: R30-M0-N9-C:J16-U01}`; filterable log columns `Node, Component, Level, …`; suggested filter `{"Node": "R30-M0-N9-C:J16-U01"}` | planner, analyst |
| Knowledge-graph context | location `Rack R30 > Midplane R30-M0 > NodeCard R30-M0-N9`; 60 log lines, 60 error lines, all from `KERNEL`; 1 other failing host on the same midplane (`R30-M0-N4-I:J18-U01`); dataset error hotspots | planner, analyst (background, not citable) |
| Similar past incidents | fault type and similarity score of the closest earlier incidents | planner, analyst |
| Previous rounds | earlier steps, evidence, hypotheses, rejected actions | planner |
| Evidence | one summary per step, with an id such as `i1.s2` to cite | analyst, reporter |

Error counts come from log levels (FATAL/ERROR), never from the datasets' answer-key labels.

### Tools

Tools are declared in [`registry/tools/`](registry/tools) and executed by
[`src/ira/tools/`](src/ira/tools). The manifest, not the model, decides risk, approval and
where a tool may run:

```yaml
name: log_explorer
kind: tool
description: Explore parsed Loghub logs for a dataset ...
input_schema: { type: object, properties: { dataset: …, operation: …, filters: …, event_id: …, limit: … } }
risk: read            # read | write | destructive
approval: none        # none | required | two_person
allowed_envs: [dev, staging, prod]
timeout_s: 30
```

| Tool | Risk | Approval | Status |
|---|---|---|---|
| `log_explorer` | read | none | Implemented |
| `sandbox.run` | read | none | Implemented (process-level restrictions, not isolation) |
| `k8s.rollout_undo` | write | required | Declared only: no executor, so guardrails always block it |

**`log_explorer`**: queries the parsed (template-mined) Loghub logs.

| Argument | Meaning |
|---|---|
| `dataset` | One of the 14 datasets; defaults to the incident's `dataset` label |
| `operation` | `distribution` (default): most frequent event types with counts. `drill_down`: one event type's parameter values |
| `filters` | Column → substring, e.g. `{"Node": "R30-M0-N9"}`, `{"Component": "KERNEL"}`, `{"Level": "FATAL"}` |
| `event_id` | Required for `drill_down`, e.g. `E55` |
| `limit` | Number of event types to return (default 15) |

```json
// {"operation": "distribution", "filters": {"Node": "R30-M0-N9-C:J16-U01"}}
[{"EventId": "E55", "EventTemplate": "data TLB error interrupt", "count": 60}]
```

Behaviour worth knowing: answer-key label columns are removed before anything is returned;
an unknown filter column fails with the list of valid ones; a filter that matches nothing
returns a note saying so, with the column's most common real values (so the next step can
correct itself), instead of an empty list the model might read as "machine is down".

**`sandbox.run`**: runs one read-only diagnostic command, e.g. `{"argv": ["grep", "-c",
"Failed password", "loghub/2k/OpenSSH/OpenSSH_2k.log_structured.csv"]}`. Only `echo`, `cat`,
`head`, `tail`, `grep`, `wc`, `ls`, `date`, `uname`, `uptime` and `df`, called by bare name. No
shell, so `sh -c` and `/bin/rm` are refused. Every path (including ones hidden in options such
as `--file=/etc/passwd`) must resolve inside the data directory. Minimal environment, CPU and
memory limits, a 10-second timeout, and PII-scrubbed output.

**`k8s.rollout_undo`**: declared (`namespace`, `deployment`; write; approval required;
staging/prod) to exercise the approval flow, but no executor exists, so it is always blocked
with *"No executor is registered for this tool"*.

**Adding a tool**
1. Add a manifest to `registry/tools/` (input schema, risk, approval, environments, timeout).
2. Write an async function `(args, incident) -> str` and register it in
   `ToolExecutor.impls` ([`src/ira/tools/executor.py`](src/ira/tools/executor.py)).
3. That's all: planning sees read tools automatically, and write tools are proposed, checked
   by guardrails and gated by approval without further code. Add a test.

### The agents (LLM roles)

| Role | Model (default) | Job | Output (schema-validated) |
|---|---|---|---|
| Planner | `gemini-2.5-pro` | Turn the alert + context into 2–4 read-only steps | `steps[]`: goal, tool, arguments |
| Gatherer | `gemini-2.5-flash` | Summarise one tool result (already PII-scrubbed) | evidence summary |
| Analyst | `gemini-2.5-pro` | Rank root-cause hypotheses from the evidence | fault type, component, confidence, cited evidence ids |
| Remediation planner | `gemini-2.5-pro` | Propose the smallest safe fix, or nothing | actions from the tool registry |
| Safety reviewers | `gemini-2.5-pro` + `gemini-2.5-flash` | Independently judge each non-read action SAFE/UNSAFE | both must say SAFE |
| Reporter | `gemini-2.5-flash` | Write the root-cause report | summary, Markdown, timeline, follow-ups |

Models are configurable per role and routed through [LiteLLM](https://github.com/BerriAI/litellm)
(fallback model on provider outages, never for pinned safety checks; cost tracking). Outputs
use the provider's JSON-schema mode and are validated with Pydantic, with one repair retry.
Prompts live in [`registry/prompts/`](registry/prompts).

Rules enforced **in code**, not just in prompts:
- Hypotheses must cite real evidence ids, or they are dropped.
- Fault types come from a fixed taxonomy (below).
- An action's risk level comes from the tool registry, never from the model.
- Unknown tools, missing arguments and tools without an executor are blocked.
- Failures are reported as failures: no placeholder answers.

**Fault types:** `cpu`, `memory`, `disk`, `storage`, `network-delay`, `network-loss`, `dns`,
`host-down`, `hardware`, `kernel`, `bad-deploy`, `config-change`, `dependency-down`,
`db-slow-query`, `db-connection-exhaustion`, `cert-expiry`, `quota/limit`, `auth-failure`,
`code-exception`, `app`, `unknown`.

### Limits and settings

All set in `.env` (see [`src/ira/config.py`](src/ira/config.py) for the full list).

| Setting | Default | Meaning |
|---|---|---|
| `MODEL_PLANNER`, `MODEL_ANALYST` | `gemini/gemini-2.5-pro` | Models for planning/remediation and analysis |
| `MODEL_GATHERER`, `MODEL_REPORTER` | `gemini/gemini-2.5-flash` | Models for summaries and reports |
| `GUARDRAIL_MODEL_A`, `GUARDRAIL_MODEL_B` | pro, flash | The two independent safety reviewers |
| `MAX_ITERATIONS` | 3 | Investigation rounds per incident |
| `MIN_CONFIDENCE` | 0.6 | Below this, the agent investigates another round |
| `MAX_BUDGET_USD` | 2.0 | LLM spend per incident before it stops replanning |
| `MAX_TOOL_OUTPUT_CHARS` | 12,000 | Tool output passed to the model |
| `APPROVAL_TIMEOUT_S` | 3600 | Unanswered approvals expire (treated as rejected) |
| `NEO4J_ENABLED` | true | Knowledge-graph context and incident recording |

### Memory and knowledge

| Store | What it holds | Used for |
|---|---|---|
| **Postgres + pgvector** | Incidents, run state, approvals, append-only audit log, resolution embeddings | Durable state; semantic "seen this before?" search |
| **Redis** | Work queue (Redis Streams) and exact-match cache | Priority queue for workers; instant answers for repeat incidents |
| **Neo4j knowledge graph** | ~5,100 entities and ~7,500 relationships extracted from the logs (e.g. rack → midplane → node card → node; attacker IP → username) plus every investigated incident | Tells the agent where the alerted machine sits and whether its neighbours also fail; browsable in the UI |
| **LangGraph checkpoints** (Postgres) | Graph state after every node | Crash recovery and pausing for human approval |

### Safety

- **PII scrubbing** ([Presidio](https://github.com/microsoft/presidio)) at intake and on every
  tool output, before anything reaches an LLM or disk. Tuned so log identifiers and IP
  addresses are kept.
- **Human-in-the-loop:** non-read actions pause the run (LangGraph interrupt) until approved;
  destructive actions need **two different** approvers; unanswered approvals expire.
- **Sign-in and roles:** OIDC with `viewer` < `responder` < `approver` < `admin`; approver
  identity comes from the token. Auth is off by default for local use and refused off in prod.
- **Audit log:** append-only (a database trigger rejects edits and deletes).
- Secrets are redacted from logs. A prod-mode startup check refuses insecure settings.

## Architecture

```text
                   ┌────────────── Dashboard (Next.js) ───────────────┐
                   │ Overview · Incidents · Logs · Knowledge graph ·  │
                   │ Evals · Approvals · Audit log                    │
                   └───────────────────────┬──────────────────────────┘
 alert webhook ───────────────────────┐    │ REST (OIDC bearer token)
 (Alertmanager, PagerDuty…)           ▼    ▼
                               ┌─────────────────┐   PII scrub, dedup, exact/semantic cache
                               │   API (FastAPI) │───────────────────────────────┐
                               └───────┬─────────┘                               │
                                       │ enqueue (priority by severity)          │
                               ┌───────▼─────────┐                               ▼
                               │  Redis Streams  │                       ┌──────────────┐
                               └───────┬─────────┘                       │  Postgres    │
                                       │                                 │  + pgvector  │
                               ┌───────▼──────────────────────┐          │ incidents,   │
                               │ Worker(s): LangGraph agent    │◄────────►│ runs, audit, │
                               │ retries · DLQ · crash resume  │          │ checkpoints  │
                               └──┬─────────┬──────────┬───────┘          └──────────────┘
                                  │         │          │
                     ┌────────────▼┐  ┌─────▼──────┐ ┌─▼──────────────┐
                     │ LiteLLM     │  │ Tools      │ │ Neo4j          │
                     │ → Gemini    │  │ log files  │ │ knowledge graph│
                     └─────────────┘  └────────────┘ └────────────────┘
```

Also included: Prometheus metrics, OpenTelemetry tracing, JSON logs, health checks, a Helm
chart and a CI pipeline (see [docs/deployment.md](docs/deployment.md)). The interface
contract between API, UI and deployment is in
[docs/production-contract.md](docs/production-contract.md).

**Original design.** The project started from [this system design](docs/system_design.pdf).
Built vs not yet built:

| In the original design | Status |
|---|---|
| Exact-match and semantic cache, message queue | Built |
| Planning, gathering, analysis and reporting agents on LiteLLM | Built |
| Tool and prompt registries | Built (MCP registry: not yet) |
| Short-term (Redis) and long-term (vector DB) memory, knowledge graph | Built; the graph holds log-derived structure (no runbooks yet) |
| Guardrails: PII filter, sandboxed execution | Built (sandbox is process-level) |
| Guardrails: DB operations | Not yet |
| Human-in-the-loop approve / reject → replan | Built |
| Tools: Log Explorer, Sandbox | Built |
| Tools: Browser Use, DB queries | Not yet |
| MCPs: OpenTelemetry, PostgreSQL, Kubernetes, Docker, Git, Jira | Not yet |

## The dashboard

| Page | What you can do |
|---|---|
| Overview | Open and critical incidents, 14-day trend by severity, services needing attention |
| Incidents | Search and filter; open one to watch the agent's live activity feed, the run timeline, root cause, evidence, actions and report |
| Logs | Browse the 14 datasets exactly as the agent sees them (PII-scrubbed), see event types, and raise suggested incidents in one click |
| Knowledge graph | Explore the graph (e.g. the SSH attack graph or BGL's hardware layout) and see how incidents connect |
| Evals | "How good is the agent?" in plain words, with every answer and the method for engineers |
| Approvals / Audit log | Approve or reject pending actions; review who did what |

## Run it

**Requirements:** Docker with about 15 GB free, Python 3.12+ (only for the data download),
a [Gemini API key](https://aistudio.google.com/apikey). Everything below runs from this
project's directory.

```bash
cp .env.example .env              # set GEMINI_API_KEY; change the passwords for anything shared
python3 scripts/fetch_loghub.py   # downloads the Loghub 2k sample logs (~20 MB) into data/loghub/2k
docker compose up -d --build      # first build takes a few minutes (several GB of images)
```

Open **http://localhost:3000**, then send sample incidents:

```bash
scripts/sample_incidents.sh 4          # SSH brute force; run without a number to send all six
DRY_RUN=1 scripts/sample_incidents.sh  # print the payloads without sending
```

Each incident takes about 1 minute and costs about $0.05 with the default Gemini models.
Stop with `docker compose down` (your data stays in Docker volumes; `down -v` deletes it).
Neo4j's own browser is at http://localhost:7474 (user `neo4j`, password from `.env`).

### Develop without Docker

```bash
uv sync --extra dev                   # Python deps (includes a ~600 MB spaCy model for PII detection)
uv run python -m src.ira.api          # API on :8000; in-memory store, agent runs in-process
cd frontend && npm ci && npm run dev  # UI on :3000
```

### Checks

```bash
uv run pytest                         # 100+ tests; Postgres/Neo4j tests use Docker and skip without it
uv run ruff check src tests && uv run mypy src
cd frontend && npm run lint && npm run build
```

### Evaluate

```bash
uv run python -m evals.loghub.evaluate --n 1                            # smoke test, ~$0.05
uv run python -m evals.loghub.evaluate --n 28 --seed 7                  # ~8 min, ~$1.50
uv run python -m evals.loghub.evaluate --n 28 --seed 21 --exclude-seed 7  # hold-out cases
uv run python -m evals.loghub.evaluate --n 28 --seed 7 --graph          # with knowledge-graph context
```

Results land in `evals/results/` and appear in the Evals tab. See [docs/evals.md](docs/evals.md).

## Project layout

| Path | Contents |
|---|---|
| `src/ira/orchestrator/` | LangGraph agent graph, runner, intake, queue dispatch, state store |
| `src/ira/agents/` | Planner, gatherer, analyst, reporter (structured outputs) |
| `src/ira/tools/`, `registry/tools/` | Tool executors and their manifests |
| `registry/prompts/`, `registry/datasets.yaml` | Prompts; dataset catalog with suggested incidents |
| `src/ira/guardrails/`, `src/ira/hitl/` | PII scrubbing, dual-model safety check, approval policy |
| `src/ira/knowledge/` | Knowledge-graph extraction from logs and Neo4j storage |
| `src/ira/api/`, `src/ira/worker/` | FastAPI app (auth, routes) and queue worker |
| `evals/` | Evaluation harness, BGL answer-key mapping, results |
| `frontend/` | Next.js dashboard |
| `deploy/`, `docker-compose.yml`, `Dockerfile` | Helm chart, LiteLLM/Prometheus/Grafana/OTel config |

## Extending the project

The architecture already has the extension points (tool registry, prompt registry, pluggable
stores, eval harness), so each of these is a self-contained feature.

**Investigate real systems**
- **Real log sources:** a `log_explorer` backend for Loki, Elasticsearch, Datadog or CloudWatch alongside the sample CSV files.
- **Metrics, traces and changes:** tools for Prometheus/OpenTelemetry and recent deploys (Git), so the agent can answer "what changed?".
- **MCP integrations** from the original design: Kubernetes, PostgreSQL, Docker, Git, Jira.
- **Service topology and runbooks in the knowledge graph**, from Kubernetes or a service catalog.

**Sharper answers**
- **Confidence calibration**, so a wrong answer no longer reports about 90% confidence.
- **More labelled evals:** Hadoop and HDFS failure labels from Loghub's full releases, next to BGL.
- **Operator feedback:** a "Was this right?" button that turns corrections into new eval cases.

**Take action**
- **Remediation executors** (e.g. Kubernetes rollback) behind the existing approval flow, after a threat-model review.
- **Verification probes** that confirm a fix worked and mark the incident resolved.
- **Isolated sandbox** (gVisor or Firecracker) for command execution.

**Run it at scale**
- Sign-in with a real identity provider (Keycloak, Okta, Auth0…).
- The Helm chart on a real cluster, with load, chaos and backup/restore testing.
- Slack and PagerDuty integrations for intake and notifications, and a production PII policy.

## Costs and limitations

- **API costs:** about $0.05 per incident and about $1.50 per 28-case eval with the default
  Gemini models (prices change; check your provider). Graph context adds about 30%.
- **Only sample logs:** it reads static Loghub CSV files; it cannot see your systems.
- **Measured on one dataset:** evaluation covers BGL; other datasets are plausible, not scored.
- **Overconfident when wrong**, as above.
- **Heavy local setup:** Docker, several services, and a large PII model.
- Model outputs vary between runs; eval scores can move by a case or two.

## Sources and attribution

- **Logs:** [Loghub](https://github.com/logpai/loghub) / [Loghub-2.0](https://github.com/logpai/loghub-2.0),
  free for research and academic use. Not included in this repository: download them with
  `scripts/fetch_loghub.py`, which keeps Loghub's license file. Please cite:
  Jieming Zhu, Shilin He, Pinjia He, Jinyang Liu, Michael R. Lyu. *Loghub: A Large Collection
  of System Log Datasets for AI-driven Log Analytics.* ISSRE 2023.
- **BGL labels:** Oliner & Stearley, *What Supercomputers Say: A Study of Five System Logs*, DSN 2007.
- Built with LangGraph, LiteLLM, FastAPI, Presidio, Neo4j, Postgres/pgvector, Redis and Next.js.
