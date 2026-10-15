# Architecture

![Architecture of the pharma research agent: the browser and API routes on the left, the LangGraph graph (planner, parallel researchers, writer, checker) inside a durable workflow step in the middle, Gemini, skills and knowledge bases on the right, and Postgres underneath](architecture.svg)

One research turn, from question to cited answer. Paths are relative to `agents/pharma-research-agent/`.

## Request path

1. **Ask.** The chat UI posts the question, and the thread it belongs to, to `POST /api/research` (`app/api/research/route.ts`). The route checks the operator controls (`RESEARCH_ENABLED`, `DAILY_RUN_CAP`), creates a `reports` row and starts the workflow with `start()`. It returns at once; the research runs in the background.
2. **Follow.** The browser opens `GET /api/reports/:id/events`, a server-sent event stream. The route polls `report_events` every 400 ms and sends anything newer than the last sequence number the browser has seen, so a dropped connection resumes where it stopped.
3. **Read.** When the run finishes, the browser reloads the final snapshot. Exports (`/export?format=pdf|docx`), share links (`/share`) and the virtual file system (`/files`) read from the same tables.

## The graph

A run is a LangGraph `StateGraph` (`lib/research/graph.ts`):

```
START → planner ─┬─ Send × 2–4 ─→ researcher (in parallel) ─→ writer → checker → END
                 └─ follow-up answered from earlier turns ──→ writer
```

The state holds the report id, the plan, the findings (a reducer collects one per researcher), the report and the evals. The planner's conditional edge returns one `Send("researcher", { task })` per subtask, so the researchers run at once and the writer starts when all of them have finished. Each node keeps the app's own event stream: it writes spans, thoughts, files and sources to Postgres as it works, which is what the browser follows.

| Node | Agent | What it does |
|---|---|---|
| planner | Orchestrator (`lib/research/agents/orchestrator.ts`) | Splits the question into 2–4 subtasks, one knowledge base each, and assigns skills from a one-line index. For a follow-up it first decides between **research** (new evidence needed) and **answer** (simplify, shorten or explain from the earlier turns). |
| researcher | Sub-agent (`agents/researcher.ts`), one per subtask, in parallel | A graph of its own: a model node and a tools node in a loop until the model calls `finish`. The turn count is in its state; at most 6 turns, and on the last only `finish` is offered, with the model forced to call it. A failed knowledge base becomes an honest empty finding rather than failing the run. |
| writer | Synthesis (`agents/synthesis.ts`) | Reads the files (`/findings/*`, `/sources/CATALOGUE.md`), not the sub-agents' conversations, and writes one markdown report in which every claim cites a retrieved source id. In answer mode it reads `/context/earlier.md`, the earlier answers with their citations, instead. |
| checker | Checks and judge (`lib/research/evals.ts`) | Citation validity and coverage, subtasks answered and source diversity, plus a model judge that checks cited sentences against the passages of their sources most relevant to each claim. |

The planner, writer and checker have a LangGraph retry policy (two attempts). A follow-up in answer mode has no subtasks, so it goes straight from planner to writer (the dashed line in the diagram). It reuses the earlier turns' sources, so its citations still resolve.

## Durability

Two layers keep a run alive:

1. **LangGraph checkpoints.** `DrizzleSaver` (`lib/research/checkpointer.ts`) is a LangGraph checkpointer on the app's own database. After every step, LangGraph saves the graph's state, plus the writes of each task that finished within a step, under the report's id as the thread id.
2. **A Vercel Workflow step.** `workflows/research.ts` runs the graph as one retried step (`graphStep`), then a `finalizeStep` records how the run ended. If the function running the graph dies or the graph throws, the step is retried, and `runResearchGraph` resumes from the last checkpoint with `graph.invoke(null, config)`. The planner and the researchers that had finished are not run again.

Nodes write only keyed rows, so work that is redone overwrites its own output instead of duplicating it.

## Model, skills and knowledge bases

- **Gemini** is called through LangChain's `ChatGoogle` (`@langchain/google`), created in `lib/research/model.ts`. `callModel` streams one call and returns the message (kept in the conversation as is, so thought signatures survive across turns of a tool loop), its text, Gemini's thought summaries, parsed JSON when a schema is given, grounding, and usage with cost. Every call is a span in the trace. The knowledge-base tools are LangChain tools (`tool()`, in `lib/research/sources/toolset.ts`) that return the short result the model reads, with the full documents as an artifact. Without an API key, `ScriptedChatModel` (`lib/research/offline.ts`) stands in for Gemini, so the whole graph runs offline.
- **Skills** (`skills/*.md`) are markdown playbooks. The planner sees one line per skill; a sub-agent's prompt gets a playbook's full text only when that skill is assigned to it (progressive disclosure).
- **Knowledge bases** (`lib/research/sources/`): PubMed through NCBI E-utilities, ClinicalTrials.gov API v2, openFDA drug labels and FAERS counts, and the web through Gemini's Google Search grounding. Each client has a timeout, client-side rate limiting and bounded retries.

## Storage

Postgres through Drizzle ORM (`lib/db/`): Neon over HTTP when `DATABASE_URL` is set, otherwise embedded PGlite in `.data/pglite` (and in memory for tests).

| Table | Holds |
|---|---|
| `reports` | One row per turn, grouped into threads: query, status, plan, report, evals, and token, call and cost totals. |
| `report_events` | Every agent event, keyed (`span:<id>`, `thought:<key>`, `finding:<subtask>`, …) and ordered by a sequence, so the browser can resume and a retried step replaces its own events. |
| `report_sources` | Every document retrieved: the targets citations must point to. |
| `report_files` | The virtual file system: `/plan.md`, `/findings/*`, `/sources/CATALOGUE.md`, `/report.md`, `/evals/*`. |
| `graph_checkpoints`, `graph_writes` | LangGraph's checkpoints and pending writes, by report, so a run can resume. |

Agents never wait on the database: `EventSink` (`lib/research/persist.ts`) queues writes in order and is flushed at the end of each node, and a failed write fails the node so it is retried.
