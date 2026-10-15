# Pharma research agent

A research assistant for drug and clinical-evidence questions, in a chat interface. Ask a question; an agent team plans the research, searches **PubMed, ClinicalTrials.gov, FDA labels and the web** in parallel, and streams back an answer in which every claim is cited to the study, trial or label it came from. Ask follow-ups in the same conversation. Each answer is checked automatically, can be exported to PDF or Word, and conversations can be shared by link.

It is a production-shaped Next.js application rather than a notebook. Runs are durable jobs that survive a closed tab or a crashed function, everything is stored in Postgres, and progress streams live to the browser. It is also a worked example of an agent architecture you can read and adapt:

```
research query
   │
   ▼
orchestrator ◄── skills layer (markdown playbooks; the planner sees one line per skill)
   │
   ▼
parallel research sub-agents (2–4, one per knowledge base, at most 6 turns each)
   │          │                 │                 │
 PubMed   ClinicalTrials.gov   openFDA        web search (Gemini grounding)
   │          │                 │                 │
   ▼          ▼                 ▼                 ▼
virtual file system  (/plan.md, /sources/…, /findings/agent-n.md, /report.md — stored in Postgres)
   │
   ▼
synthesis agent  (reads the files, not the sub-agents' conversations)
   │
   ▼
evals & traces  (4 deterministic checks + an LLM-judge groundedness check; every call traced)
```

> Not medical advice. Reports are generated from public sources and can be wrong even when cited. The app says so on every report.

## What users get

- **A conversation.** Each question is a turn. Follow-ups ("what about in type 1 diabetes?") are planned and answered with the earlier answers as context, and each turn runs its own cited research.
- **You can see it working.** A single activity line shows what is happening right now. Expanded, it becomes a chronological list: the planner's thinking as it streams (Gemini thought summaries), the planned searches, each search with its query and result count, what each source yielded, writing and checking. The answer then streams in token by token.
- **A report inside every answer.** A direct answer, then sections such as efficacy, safety, trial landscape and regulatory status, then limitations. Citations appear as numbered chips; hovering one shows the source, and clicking one opens its excerpt in the sources panel.
- **Sources you can check.** Sources are listed in citation order and can be filtered by database. Each has its journal and year, trial phase, status and enrollment, or label date; an excerpt of what the agent read; and a link to the original.
- **Trust signals in plain words.** A confidence grade, *citations verified* (every citation points to a retrieved source) and *claims supported* (a judge model checked cited sentences against their sources).
- **Live progress.** Plan → Research → Write → Verify, with one line per sub-agent showing what it is searching and what it has found so far.
- **Reports that last.** A searchable sidebar of past reports, grouped by date. Export to PDF and Word with a numbered reference list. Public read-only share links that you can turn off. Run again, and delete.
- **Run details** for reviewers: the plan and skills used; each sub-agent's searches and findings; a trace waterfall of every model and tool call; every eval with the judge's per-sentence verdicts; the full virtual file system; and tokens, calls and cost.

There are no accounts yet. Each browser gets a private, anonymous workspace through an HTTP-only cookie. Every report row has an owner column, so sign-in can be added later without changing the data model.

## How it is built

| Concern | Choice |
|---|---|
| App | Next.js 16 (App Router, Cache Components, partial prerendering), React 19, TypeScript |
| UI | Tailwind CSS v4, shadcn/ui (Radix), IBM Plex Sans + Newsreader + IBM Plex Mono, light and dark themes |
| Durable runs | [Vercel Workflow](https://workflow-sdk.dev): plan, sub-agents (in parallel), synthesis, evals and finalize are separate steps, each retried on failure. A run resumes from the last completed step. |
| Data | Postgres via Drizzle ORM with versioned migrations (`drizzle/`). Neon in production; embedded [PGlite](https://pglite.dev) locally and in tests (no Docker). |
| Live updates | Gemini responses stream (`streamGenerateContent`, SSE), including thought summaries. Agents write thoughts and the report draft to `report_events` a few times a second, and the browser follows them over server-sent events, resuming from the last sequence number after a disconnect. |
| Model | Gemini (`gemini-3.8-flash`) over the REST `generateContent` endpoint, with no SDK. Structured output, function calling with forced `finish` on the last turn, Google Search grounding, and thought signatures preserved across turns. |
| Knowledge bases | NCBI E-utilities, ClinicalTrials.gov API v2 and openFDA. All are free, rate-limited client side, with timeouts and bounded retries. |
| Exports | `@react-pdf/renderer` (PDF), `docx` (Word) |

The parts most worth reading:

- `workflows/research.ts` and `workflows/steps.ts`: the durable run. Every step writes only keyed rows, so a retried step overwrites its own output instead of duplicating it.
- `lib/research/`: the agent core.
  - `agents/orchestrator.ts`: plans the subtasks.
  - `agents/researcher.ts`: the bounded tool loop each sub-agent runs.
  - `agents/synthesis.ts`: writes the report from the files.
  - `evals.ts`: the deterministic checks and the judge.
  - `sources/`: one client per knowledge base.
  - `gemini.ts`: the model client.
- `lib/research/persist.ts`: an event sink that writes every agent event to Postgres, in order, without blocking the agent.
- `skills/*.md`: the five playbooks. The orchestrator sees only their one-line descriptions; a full playbook is loaded into a sub-agent's prompt only when assigned (progressive disclosure).
- `lib/reports.ts`: the data access layer. Access rules live there: a report is visible to its workspace, or to anyone holding its share link.

## Run it locally

Requires Node.js 22.12 or later. From `agents/pharma-research-agent/`:

```bash
npm ci
cp .env.example .env.local     # add GEMINI_API_KEY for real research
npm run dev                    # http://localhost:4325
```

- **Without `GEMINI_API_KEY`**, development uses an offline stand-in: a scripted model plus API responses recorded in `tests/fixtures/`. The whole pipeline runs (plan, parallel steps, database, streaming, report, evals, exports), but the report text is a placeholder. Set `RESEARCH_OFFLINE_DELAY_MS=2500` to slow it down and watch the live progress.
- **With a key**, each report makes about 14–19 Gemini calls and costs roughly $0.09–0.14 with `gemini-3.8-flash`. The figure comes from live runs on 2026-10-12; the cost of each run is shown under Run details.
- **Local data** goes to `.data/pglite` (embedded Postgres, migrated automatically) and `.workflow-data/`. Delete both folders to start fresh.

Checks:

```bash
npm run lint
npm run check     # TypeScript
npm test          # 16 tests: agent core, streaming client, citations, report parsing, and the durable pipeline against in-memory Postgres
npm run build
```

`npm run research -- "question"` runs one research job from the command line (offline by default; `--live` uses Gemini). `npx tsx scripts/record-fixtures.ts` re-records the offline fixtures from the public APIs.

## Deploy to Vercel

1. Create a Vercel project from this folder (root directory `agents/pharma-research-agent`).
2. Add Postgres from the Marketplace (`vercel integration add neon`). This sets `DATABASE_URL`. `vercel.json` runs `npm run db:migrate` before `next build`.
3. Set `GEMINI_API_KEY`, plus the `GEMINI_*_USD_PER_MILLION` prices to report cost.
4. Deploy. Vercel Workflow needs no extra setup on Vercel, and `/api/health` checks the database.

Operator controls, with no redeploy of code:

- `RESEARCH_ENABLED=false` pauses new research while keeping existing reports readable.
- `DAILY_RUN_CAP=<n>` caps runs per UTC day across all users.

Both are off by default. Every report is paid for by the deployment's Gemini key, so watch usage on a public deployment.

CI: `.github/workflows/ci.yml` runs lint, type check, tests and build. It is kept in this folder for reference, because GitHub only runs workflows from the repository root.

## Limits

- **Not medical advice.** Valid citations don't guarantee a correct summary. That is why claims are judged against their sources and every source is one click away.
- **Abstracts, not full texts.** Effect sizes reported only in full texts can be missed, and the reports say so in their limitations.
- **FAERS counts are reports, not rates.** The skills tell the models never to convert them.
- **Web sources are Google grounding redirect links.** They can stop resolving over time; the title and the cited text are kept.
- **No accounts yet.** Reports belong to the browser that created them. Clearing cookies loses access, although shared links keep working.
- **One model family.** The groundedness judge is the same model that wrote the report. See [llm-judge-reliability](../../evaluations-reliability/llm-judge-reliability/README.md) for why that matters.

## Earlier evaluation

Four live runs on 2026-10-12, from the prototype of this agent, are kept in `results/runs/`. All four had 100% valid citations and groundedness of 67–100%, at $0.09–0.14 each. Two failures they exposed were fixed in the code here:

- **A sub-agent that kept searching.** It called a search tool on its last turn and never finished. The last turn now forces `finish`.
- **A judge that saw too little.** It read only the first 1,500 characters of long labels. It now gets the passages most relevant to each claim.

## Sources

- NCBI, [Entrez Programming Utilities](https://www.ncbi.nlm.nih.gov/books/NBK25501/). ClinicalTrials.gov, [API v2](https://clinicaltrials.gov/data-api/api). openFDA, [drug label](https://open.fda.gov/apis/drug/label/) and [adverse events](https://open.fda.gov/apis/drug/event/).
- Google, [Gemini API: generateContent](https://ai.google.dev/api/generate-content) and [pricing](https://ai.google.dev/gemini-api/docs/pricing).
- Vercel, [Workflow SDK](https://workflow-sdk.dev). Next.js, [Cache Components](https://nextjs.org/docs/app/getting-started/caching).
- Anthropic, [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system), for the orchestrator–sub-agent pattern.

Related: [Anatomy of a harness](../harness-anatomy/README.md) explains the skills, offloading, subagents and file system this agent uses. Community category: [Agents & Workflows](https://aiengineer.help/c/agents-workflows/7).
