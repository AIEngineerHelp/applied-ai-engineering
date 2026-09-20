# Building a Multi-Agent Travel Planner with Gemini and TypeSafe AI

**Travel Lab** is a runnable comparison website: give two agent teams the same trip brief, watch their decisions, and inspect their plans and measurements. The question is whether using Jev for coordination helps without reducing task quality.

## Run locally

Requires **Node.js 22.12+** and npm. `npm ci` installs LangGraph, TypeScript, the TS runtime, and the browser bundler. No model downloads or special hardware are required.

From the repository root:

```sh
cd agents/travel-planner-gemini-typesafe
npm ci
npm start
```

Open **http://127.0.0.1:4317** and run a comparison. The website uses live APIs only and requires both keys configured as described below. Offline fixtures remain available through tests and the evaluation CLI. Live responses and costs vary. A completed trip must pass evidence-based checks and specialist review; this does not verify real-world availability or exact prices.

Try rain on day two, enter a place to avoid, or set a tight budget. A very low budget may cause the planners to request changes instead of claiming success. Changes start a fresh comparison; they do not resume a previous run. Stop cancels an in-progress comparison. Every submitted comparison is saved automatically. **The plans** keeps both itineraries, coordination and total time, model-call counts, and budget, diet, source-link and deterministic-check status in view. **Timing & decisions** shows each action path, the live run measurements, and the separately labeled frozen routing benchmark. Expand **Inspect every step and model call** for inputs, outputs, errors and timings. Model request/response pairs appear as one call. Download run exports the full record as JSON. The two plans stack on narrow screens.

`npm run dev` rebuilds the browser scripts once and restarts the server when backend source changes. Run `npm run build:client` and reload the browser after editing `client/`. Stop the server with Ctrl-C. No database service or infrastructure setup is required. Local history remains in `.runs/` across restarts.

## Enable live models

```sh
cp .env.example .env
```

Edit `.env` with your own Google Gemini and TypeSafe API keys and set `ENABLE_LIVE=true`. Restart the server, then click **Start planning**. Keys stay on the server and are excluded from Git. Live runs incur provider charges; stopping cannot undo charges for requests already sent.

| Setting | Purpose |
| --- | --- |
| `GEMINI_API_KEY` | Google Gemini API credential |
| `TYPESAFE_API_KEY` | TypeSafe API credential |
| `ENABLE_LIVE` | Must be `true` to enable paid calls |
| `GEMINI_MODEL` | Defaults to `gemini-3.8-flash`; choose a model available to your account that supports structured output and Google Search grounding |
| `TYPESAFE_MODEL` | Defaults to `jev-latest`; pin a version when conducting a benchmark |
| `PORT` | Local server port, default `4317` |
| `HOST` | Bind address; use `0.0.0.0` in a container or public deployment |
| `ALLOWED_HOSTS` | Comma-separated hostnames accepted by the server, without ports |
| `GEMINI_INPUT_USD_PER_MILLION`, `GEMINI_OUTPUT_USD_PER_MILLION` | Optional current token rates for Gemini cost estimates |
| `TYPESAFE_INPUT_USD_PER_MILLION`, `TYPESAFE_OUTPUT_USD_PER_MILLION` | Optional current token rates for Jev cost estimates |

Leave prices blank if unknown. Missing prices or usage produce an unknown estimate, never a fabricated zero. Gemini output accounting includes reported reasoning tokens. Google Search grounding can incur per-query charges that token rates do not cover, so live runs with web search show **unknown total API cost** even when token rates are configured. Check actual provider billing before publishing costs.

**Live integration status:** An earlier catalog-search comparison passed on 2026-09-18. Two local Goa comparisons using the newer web-grounded research path completed for both teams on 2026-09-19. These are connectivity and execution smoke runs, not a representative quality or speed benchmark. Provider errors remain visible and are never replaced with demo output.

**Before public deployment:** Google's [Search grounding terms](https://ai.google.dev/gemini-api/terms#grounding-with-google-search) restrict storage and display of grounded results, Search Suggestions, and links. This prototype currently saves detailed provider responses and source links in run history and does not render Google's associated Search Suggestions. Resolve those requirements or use a search provider whose terms permit the desired persistent trace before making the live site public.

Enter any destination. Live venue candidates come from Gemini Google Search grounding; their INR prices and visit durations are model estimates. The four bundled catalogs are used only by offline tests and evaluations. Changing the destination keeps the previous result visible until a new comparison starts.

`USD_TO_INR` is an optional user-supplied rate for converting token-cost estimates to INR. Because search grounding charges are not included in token rates, total cost remains unknown for web-research runs. Exported reports retain provider accounting and the selected display rate.

## What changes between the teams?

| Responsibility | Gemini only | Gemini + Jev |
| --- | --- | --- |
| Select next agent | Gemini structured output | Jev Choice |
| Select that agent's tool | Gemini structured output | Jev Choice |
| Generate search arguments, research places, itinerary, review | Gemini, including Google Search grounding | The same Gemini model and prompts |
| Execute tools and validate constraints | Code | The same code |

Three specialists—researcher, planner, reviewer—share a bounded LangGraph `StateGraph`. Its nodes select the next agent, select a tool, and execute that tool; conditional edges either repeat the loop or end with a result. Agent selection happens before tool selection because the available tools depend on the selected agent. The executor offers only actions whose prerequisites are met: it researches both activities and meals before drafting, reviews only an existing plan, and finishes only after both reviews pass. It executes single-option transitions directly without spending a model call. Where several options remain, Jev or Gemini chooses from the same choices; Gemini generates arguments and text. Both coordinators receive equivalent state and selection instructions.

Both teams run concurrently against isolated copies of the same brief, with the same 12-step limit. Each team performs its own web research, so source results may differ; a single run cannot isolate coordination quality from search variation. Completion requires programmatic checks **and** the specialist review to pass. The plans remain the first result; the analysis tab leads with coordination time, then shows decision paths, the previously measured frozen routing benchmark, and detailed measurements. Coordination time sums the elapsed provider calls that choose agents and tools; transitions with only one legal choice are excluded. The interface also shows decisions, errors, tool executions, and usage. Jev confidence is exposed as model output, not proof that the decision is correct.

## Scope and data

The `data/` directory contains four city catalogs with hand-authored synthetic records for offline tests and example constraints. Live research calls Gemini with the `google_search` tool, stores its queries and source URLs in the run trace, then extracts structured candidates in a second Gemini call. Extraction assigns a research source to each candidate, but source association, dietary suitability, price, duration, and current opening status are **not independently verified**. If grounding returns no web sources, the run reports an error instead of silently using a catalog. No scraped travel dataset or third-party images are included. The repository has not selected a license yet.

Trips cover 1–5 days and 1–6 travelers. Each day has two activities and one meal. The live budget check uses estimated stop costs for those activities and one meal; transport, flights, hotels, other meals, opening hours and real travel times are excluded. Offline fixtures retain a fixed transit allowance for regression tests. This is a coordination experiment, not a booking service.

Programmatic checks cover researched IDs and stop types, user-specified closures, diet, rain, activity repetition, a daily time allowance, and party-wide budget. For live research, several inputs to those checks are estimates extracted from web content, so passing checks does not establish real travel feasibility. Free-text preferences and interest fit require subjective review; Gemini's review is not independent ground truth. Offline mode does not interpret free-text notes and uses interests only as a cost tie-breaker.

## Saved runs and execution timelines

Each web comparison and CLI evaluation case gets a unique run ID. The interface labels it Search ID, displays it with the results and history, and uses `?search=<id>` to reopen a saved search in the same browser session. Each research tool call also records its own `searchId`; tool start/end events share a `toolCallId`. `.runs/<id>.json` stores its brief, configuration metadata and status; `.runs/<id>.ndjson` records events incrementally. The directory is ignored by Git and files are created with owner-only permissions. This is a local, single-server-process store, with no automatic expiry. Browser sessions isolate run history so one public visitor cannot list or open another visitor's runs.

Records include the brief and (for offline runs) a destination fixture snapshot, model request bodies and returned responses, agent/tool selections, tool input state, search arguments and sources, full tool outputs, validation failures, timestamps, call durations and token usage. Authentication headers and configured API key values are excluded/redacted. Provider thought parts and opaque thought signatures are omitted; hidden model reasoning is not available. Raw upstream HTTP error bodies are not retained because they may echo credentials; sanitized errors are saved instead.

Cancellation retains the partial timeline. Runs left active when the server stops are marked interrupted on the next server startup. An in-flight request at interruption may have a start event with no response. Recorded times include local persistence overhead. Events are flushed before being streamed; metadata uses atomic replacement. This is not a replicated or multi-process database. Only new runs are recorded; earlier unsaved runs cannot be reconstructed.

Run history lists all saved runs. Select one to inspect both teams without making new API calls. Live run events retain researched places and source URLs; offline runs retain catalog snapshots. Downloaded records include the complete timeline and trip preferences; inspect them before sharing. Back up `.runs/` to retain history when moving the project.

## Verification and evaluation

Run inside this project:

```sh
npm test
npm run check
npm run eval
npm run benchmark
```

Tests cover constraints, team isolation, impossible budgets, premature completion, step limits, cancellation, provider payloads and failures, grounded-search handling, usage accounting, and the HTTP stream. `check` type-checks TypeScript; `build:client` bundles the browser code. Offline evaluation runs standard, rain, closure, and infeasible-budget cases against both teams.

For machine-readable output:

```sh
npm run eval > evaluation.json
```

`npm run benchmark` validates the fixed dataset and prints its hash and planned call count without calling either API. The separate scenario evaluation is a smoke test of the whole agent, not a controlled model comparison. Only after configuring live access, a paid coordinator benchmark can be run with:

```sh
npm run benchmark -- --live --repetitions 3
```

A separate **challenge set** adds seven states involving repair, budget recovery, conflicting requirements, and a case where either research order is valid. It does not alter the published 12-case dataset or its result. Validate it without API calls using `npm run benchmark -- --challenge`; to repeat the paid comparison use `npm run benchmark -- --challenge --live --repetitions 3`. The runner accepts either action in the explicitly multi-answer case and records whether the preferred action was chosen separately. Do not combine its result with the existing 36/36 figure without naming the different dataset.

The first challenge run on **2026-09-20** used seven cases × three repetitions, dataset hash `ddcdad916d4dc62bef18f90a332a3a74224490d13f7d2ade4bf8b0bdc963ec33`. Gemini matched the hand-authored policy on **15/21** calls (2,360 ms median); Jev matched on **18/21** (411 ms median), with no API errors. Both providers chose `planner` for an affordable revision and `clarify` for an explicit conflict. On the all-known-places-closed case, Gemini chose `clarify` and Jev chose `researcher`; on the first budget failure, Gemini chose `clarify` and Jev chose `planner`. We labeled research as preferred in both because cheaper or replacement web options may exist, but clarification is defensible when the current evidence cannot meet the brief. These policy scores therefore **do not establish an accuracy winner**. Keep the [per-call challenge result](benchmarks/results/2026-09-20-challenge.json) alongside the case definitions in `src/benchmark.ts`; future evaluation should use independently adjudicated labels or task outcomes. Token-rate pricing was not configured, so this run does not establish a cost winner.

This makes **72 sequential paid coordination calls**: 12 frozen decision states × 3 repetitions × 2 providers. `--repetitions` accepts 1–5. Every call has a 45-second timeout and there are no automatic retries. The runner alternates provider order within each case, saves a JSON result under ignored `.runs/benchmarks/`, and prints a summary. The result includes the dataset hash, expected action and rationale per case, every selected action or error, wall time, reported tokens, returned model version, and estimated token cost when rates are configured. It omits raw prompts and responses from the saved artifact. Keep the dataset fixed across comparison runs; changing any state or label changes the hash. Do not tune labels after seeing model outputs and present the result as an untouched test set.

The benchmark isolates **agent/tool routing**, the only responsibility that differs between the teams. Both providers receive the same frozen synthetic state, legal choices, and selection instruction through their respective APIs. All 12 cases have at least two legal options, so every sample is a model decision rather than a prerequisite rule. Hand-authored expected actions score decision accuracy; errors count as incorrect. The summary reports median and 90th-percentile decision latency separately. It does not measure full itinerary quality, real-world trip feasibility, end-to-end speed, or all provider charges. These small, synthetic cases are an initial routing test, not a statistically representative claim about every travel-planning task. `jev-latest` is a moving alias: set a supported pinned `TYPESAFE_MODEL` for future published comparisons and inspect the actual returned versions in the result. Unknown rates stay unknown; check provider billing before publishing cost comparisons. Provider token counts may use different tokenizers, so compare billing rather than raw token totals for cost.

For a **whole-agent comparison with frozen evidence**, run:

```sh
npm run benchmark:agent
npm run benchmark:agent -- --live --repetitions 2
```

The first command validates five synthetic Tokyo scenarios without API calls. The live command makes 20 sequential agent runs: standard, rainy day, closure, combined rain and closure, and an infeasible budget × two repetitions × both teams. Each run starts from the same brief and catalog evidence; the benchmark replaces only the research API response with that frozen evidence. Agent selection, search-argument generation, itinerary writing and specialist review still use their normal live providers. Team order alternates; model calls can vary with the agent path. The report saves plans, status, call counts, coordination time, total time, and an independent deterministic validation of each resulting plan. A correct request for clarification scores as success on the budget case: even the cheapest possible combination of distinct activities and vegetarian meals exceeds the budget. It counts other non-completed runs and invalid plans, rather than silently discarding them. This controls changing search results but remains a small synthetic task set; the same Gemini worker makes independent generations for each team, so it cannot attribute every plan difference to the coordinator. It makes no claim about live venue accuracy or search costs.

The first frozen routing run on **2026-09-20** used 12 cases × 3 repetitions (36 decisions per provider), dataset hash `574475eb1981d973ef852091657bb8f5e6c16375aafa3e131781783fb11fbd40`. Both chose the expected action **36/36** times. Gemini (`gemini-3.8-flash`) had 2,162 ms median and 2,460 ms p90 decision latency; Jev (`jev-1.13.0`, via `jev-latest`) had 396 ms median and 1,104 ms p90. Jev was faster in all 36 matched pairs. This shows a latency difference on these straightforward routing decisions, with **no measured quality difference**. Token-rate pricing was not configured, so the result does not establish a cost winner. The [per-call result](benchmarks/results/2026-09-20-routing.json) omits raw API requests and responses; case states and expected labels are in `src/benchmark.ts`.

The final frozen-evidence agent run on **2026-09-20** used five scenarios × two repetitions, dataset hash `cf1d157e6b54e97cefc21b38aa4f1ca36f20f0cc6b082cf9f0124b8158839736`. Both teams met the expected outcome in **10/10** runs: eight independently valid itineraries and two correct clarification requests. Median whole-run time was **20.75 s** for Gemini and **15.10 s** for Gemini + Jev; the latter was faster in 9 of 10 matched pairs. Gemini made 72 model calls; Gemini + Jev made 74, including an extra planning attempt on each infeasible-budget run. The same model versions as above were returned throughout. These are local wall times under one account and a very small synthetic test set. The data supports a speed finding for this setup, **not** a general trip-quality or cost advantage. See the [full agent result](benchmarks/results/2026-09-20-agent.json) for each plan, action path, validation outcome, call and timing record.

The first diagnostic pass of the expanded set exposed a failure: the Jev team exhausted its 12-step limit on both impossible-budget runs, while Gemini asked for clarification. The [pre-fix result](benchmarks/results/2026-09-20-agent-before-guard.json) is preserved. The agent now stops when even the cheapest combination in its current evidence exceeds budget and a failed budget review is followed by an unchanged search or plan, or by another failed budget review. The final result above was collected after that shared rule was added; it must not be presented as Jev solving the budget case unaided. This guard can also ask for clarification before exploring every possible cheaper real-world option, so future evaluation should include more varied budget-recovery cases.

The older paid scenario smoke test remains available with:

```sh
npm run eval -- --live > evaluation-live.json
```

That runs eight team executions: two teams for each of four cases. Each model request has a 45-second timeout; each web comparison also has a four-minute deadline. There are no automatic HTTP retries. Worker errors can trigger another action within the remaining step budget; coordination failures end that team's run.

One sample per scenario is a smoke evaluation, not a statistical benchmark. Its live closure case asks to avoid Tokyo National Museum; the offline version uses a catalog ID. For a larger **whole-agent** benchmark, expand beyond the five frozen cases to varied destinations, failure recovery, and independent human review of subjective trip quality. Report coordination latency separately from end-to-end latency and include all grounding charges in cost. Concurrent runs share account quotas and may affect each other's latency. No improvement or winner is assumed from the website comparison.

The server binds to loopback by default and allows at most two concurrent comparisons. For deployment, set `HOST=0.0.0.0` and add the public hostname to `ALLOWED_HOSTS`. Live prompts send the brief and web research to the configured providers. Exported reports include trip notes; inspect them before sharing. The session cookie isolates history but is not user authentication. A public deployment spends the owner's provider quota, so add platform-level rate limits or access control before posting the URL broadly. Use persistent storage for `.runs/`; ephemeral hosting will lose history during restarts or redeploys.

## Deploy to Vercel

Use `agents/travel-planner-gemini-typesafe` as the Vercel project root, with framework preset **Other**. `vercel.json` builds the browser assets and routes requests through a Node function with a 300-second limit. The agent comparison retains its 240-second deadline, leaving time to finish saving the trace.

Connect a **private Vercel Blob store** to the project. Local runs continue using `.runs/`; deployed runs use the connected Blob store. Each event is queued for an immutable private write, and completion waits for those writes. History is scoped to the browser session cookie. Clearing cookies loses access to that session's history. Old local runs are not uploaded automatically. If a function is terminated abruptly, queued events may be lost; runs still marked active after six minutes are displayed as interrupted.

Set these server-side environment variables in Vercel:

- `GEMINI_API_KEY`, `TYPESAFE_API_KEY`, and `ENABLE_LIVE=true`.
- `GEMINI_MODEL` and `TYPESAFE_MODEL` as needed; use the same settings as the evaluated project for comparable runs.
- The storage connection's `BLOB_STORE_ID` or `BLOB_READ_WRITE_TOKEN`.
- `LIVE_ACCESS_PASSWORD` for a shared-password deployment. The browser asks for credentials; any username is accepted with the correct password. Alternatively, set `PUBLIC_LIVE=true` to deliberately allow public use of the configured provider keys. Without either setting, the Vercel handler refuses live access.
- `ALLOWED_HOSTS` for custom domains. Vercel deployment, production, and branch hostnames are allowed automatically from Vercel's environment variables.

The shared password is access control, not individual user authentication. The two-run concurrency limit applies per function instance, not globally. Public access needs platform-level limits appropriate to the owner's quota. Function execution and private Blob operations can incur hosting charges in addition to model charges. Cloud request and storage overhead differs from the local benchmark environment.

From the example directory, deploy with `vercel` for a preview or `vercel --prod` for production after connecting the project and setting its environment variables. Verify the planner, `/api/config`, benchmark results, and session-private history. Check a complete streamed comparison before broadly sharing the deployment. The `.vercelignore` file excludes credentials, local history, and development files from uploads.

## Code map

- `src/domain.ts`: input validation, offline fixture search and planner, evidence checks.
- `src/providers.ts`: Gemini grounded search and generation, TypeSafe Choice, timeouts, usage accounting.
- `src/engine.ts`: LangGraph agent state and routing, tool execution, event stream, comparison.
- `src/server.ts`: local HTTP server and NDJSON streaming API.
- `client/`: TypeScript browser interface; `public/` holds HTML/CSS and generated browser bundles.
- `tests/`: offline regression and integration tests.
- `src/benchmark.ts`, `scripts/benchmark.ts`: frozen routing cases, live repeated comparison, and report.
- `src/agent-benchmark.ts`, `scripts/agent-benchmark.ts`: frozen-evidence whole-agent comparison.
- `scripts/evaluate.ts`: whole-agent scenario smoke evaluation.
- [docs/architecture.md](docs/architecture.md): state flow and comparison contract.

## Sources

- [Gemini generateContent API](https://ai.google.dev/api/generate-content)
- [Gemini structured output](https://ai.google.dev/gemini-api/docs/structured-output)
- [Gemini Google Search grounding](https://ai.google.dev/gemini-api/docs/generate-content/google-search)
- [TypeSafe API reference](https://docs.typesafe.ai/api.md)
- [TypeSafe introduction](https://docs.typesafe.ai/introduction)
- [Building a Harness with Jev](https://www.langchain.com/blog/building-a-harness-with-jev)

No project-specific community discussion is linked yet.
