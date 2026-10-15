# Architecture

![Architecture of the pharma research agent: the browser and API routes on the left, the LangGraph graph (planner, parallel researchers, writer, checker) inside a durable workflow step in the middle, Gemini, skills and knowledge bases on the right, and Postgres underneath](architecture.svg)

One research turn, from question to cited answer. Paths are relative to `agents/pharma-research-agent/`.

## Request path

1. **Ask.** The chat UI posts the question, and the thread it belongs to, to `POST /api/research` (`app/api/research/route.ts`). The route checks the operator controls (`RESEARCH_ENABLED`, `DAILY_RUN_CAP`), creates a `reports` row and starts the workflow with `start()`. It returns at once; the research runs in the background.
2. **Follow.** The browser opens `GET /api/reports/:id/events`, a server-sent event stream. The route polls `report_events` every 400 ms and sends anything newer than the last sequence number the browser has seen, so a dropped connection resumes where it stopped.
3. **Read.** When the run finishes, the browser reloads the final snapshot. Exports (`/export?format=pdf|docx`), share links (`/share`) and the virtual file system (`/files`) read from the same tables.

## The agent and its storage

The agent (`agent/`) never touches the database directly. Everything it saves or loads goes through `RunStore` (`agent/store.ts`): the run, its event stream, usage totals, the plan, report and evals, its files and sources, and the earlier turns of a conversation. The app passes in `postgresRunStore` (`lib/storage/run-store.ts`) and a LangGraph checkpointer (`lib/storage/checkpointer.ts`). A lint rule stops `agent/` from importing the app, its database, Next.js or React.

## The graph

A run is a LangGraph `StateGraph` (`agent/graph.ts`):

```
START → input guard ─┬─ refused ─→ END
                     └─ planner ─┬─ Send × 2–4 ─→ researcher (parallel) ─→ writer → output guard → checker → END
                                 └─ follow-up answered from earlier turns ──→ writer
```

The state holds the report id, the plan, the findings (a reducer collects one per researcher), the report and the evals. The planner's conditional edge returns one `Send("researcher", { task })` per subtask, so the researchers run at once and the writer starts when all of them have finished. Each node keeps the app's own event stream: it writes spans, thoughts, files and sources to Postgres as it works, which is what the browser follows.

| Node | Agent | What it does |
|---|---|---|
| input guard | Screen (`agent/nodes/input-guard.ts`, `agent/guardrails/input.ts`) | Records personal data the API route removed, refuses prompt injection by pattern, then classifies the question against the risk catalogue: research continues, personal advice continues as its general question, anything else ends the run. |
| planner | Orchestrator (`agent/nodes/planner.ts`) | Splits the question into 2–4 subtasks, one knowledge base each, and assigns skills from a one-line index. For a follow-up it first decides between **research** (new evidence needed) and **answer** (simplify, shorten or explain from the earlier turns). |
| researcher | Sub-agent (`agent/nodes/researcher.ts` running `agent/subgraphs/researcher-loop.ts`), one per subtask, in parallel | A graph of its own: a model node and a tools node in a loop until the model calls `finish`. The turn count is in its state; at most 6 turns, and on the last only `finish` is offered, with the model forced to call it. A failed knowledge base becomes an honest empty finding rather than failing the run. |
| writer | Synthesis (`agent/nodes/writer.ts`) | Reads the files (`/findings/*`, `/sources/CATALOGUE.md`), not the sub-agents' conversations, and writes one markdown report in which every claim cites a retrieved source id. In answer mode it reads `/context/earlier.md`, the earlier answers with their citations, instead. |
| output guard | Policy check (`agent/nodes/output-guard.ts`, `agent/guardrails/output.ts`) | Removes citations to sources nobody retrieved, redacts personal data, and removes sentences that break the risk catalogue, noting it in the report's limitations. |
| checker | Checks and judge (`agent/nodes/checker.ts`, `agent/evals/`) | Citation validity and coverage, subtasks answered and source diversity, plus a model judge that checks cited sentences against the passages of their sources most relevant to each claim. |

Inside each researcher, retrieved text that looks like instructions to an AI is removed before the model, the files or the report see it. The guardrails, their risk catalogue and the OWASP mapping are described in [security.md](security.md).

The input guard, planner, writer, output guard and checker have a LangGraph retry policy (two attempts). A follow-up in answer mode has no subtasks, so it goes straight from planner to writer (the dashed line in the diagram). It reuses the earlier turns' sources, so its citations still resolve.

## Durability

Two layers keep a run alive:

1. **LangGraph checkpoints.** `DrizzleSaver` (`lib/storage/checkpointer.ts`) is a LangGraph checkpointer on the app's own database. After every step, LangGraph saves the graph's state, plus the writes of each task that finished within a step, under the report's id as the thread id.
2. **A Vercel Workflow step.** `workflows/research.ts` runs the graph as one retried step (`graphStep`), then a `finalizeStep` records how the run ended. If the function running the graph dies or the graph throws, the step is retried, and `runResearchGraph` resumes from the last checkpoint with `graph.invoke(null, config)`. The planner and the researchers that had finished are not run again.

Nodes write only keyed rows, so work that is redone overwrites its own output instead of duplicating it.

## Model, skills and knowledge bases

- **Gemini** is called through LangChain's `ChatGoogle` (`@langchain/google`), created in `agent/model.ts`. `callModel` streams one call and returns the message (kept in the conversation as is, so thought signatures survive across turns of a tool loop), its text, Gemini's thought summaries, parsed JSON when a schema is given, grounding, and usage with cost. Every call is a span in the trace. The knowledge-base tools are LangChain tools (`tool()`, in `agent/tools/toolset.ts`) that return the short result the model reads, with the full documents as an artifact. Without an API key, `ScriptedChatModel` (`agent/offline/model.ts`) stands in for Gemini, so the whole graph runs offline.
- **Skills** (`agent/skills/*.md`) are markdown playbooks. The planner sees one line per skill; a sub-agent's prompt gets a playbook's full text only when that skill is assigned to it (progressive disclosure).
- **Knowledge bases** (`agent/tools/`): PubMed through NCBI E-utilities, ClinicalTrials.gov API v2, openFDA drug labels and FAERS counts, and the web through Gemini's Google Search grounding. Each client has a timeout, client-side rate limiting and bounded retries.

## Storage

Postgres through Drizzle ORM (`lib/db/`): Neon over HTTP when `DATABASE_URL` is set, otherwise embedded PGlite in `.data/pglite` (and in memory for tests).

| Table | Holds |
|---|---|
| `reports` | One row per turn, grouped into threads: query, status, plan, report, evals, and token, call and cost totals. |
| `report_events` | Every agent event, keyed (`span:<id>`, `thought:<key>`, `finding:<subtask>`, …) and ordered by a sequence, so the browser can resume and a retried step replaces its own events. |
| `report_sources` | Every document retrieved: the targets citations must point to. |
| `report_files` | The virtual file system: `/plan.md`, `/findings/*`, `/sources/CATALOGUE.md`, `/report.md`, `/evals/*`. |
| `graph_checkpoints`, `graph_writes` | LangGraph's checkpoints and pending writes, by report, so a run can resume. |

Agents never wait on the database: `EventSink` (`lib/storage/events.ts`) queues writes in order and is flushed at the end of each node, and a failed write fails the node so it is retried.
