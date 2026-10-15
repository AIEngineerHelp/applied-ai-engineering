# Pharma research agent

A working research agent for pharmaceutical questions, built so you can watch every part of it work. A research query goes to an **orchestrator**, which reads a **skills layer** and splits the query into subtasks. **Research sub-agents** run in parallel, each on one knowledge base — PubMed, ClinicalTrials.gov, openFDA, or the web — and write what they find to a **virtual file system**. A **synthesis agent** reads those files and writes one cited report. **Evals and traces** check the report and record where the time and tokens went.

```
research query
   │
   ▼
orchestrator ◄── skills layer (5 markdown playbooks; only one-line descriptions are shown to the orchestrator)
   │
   ▼
parallel research sub-agents (2–4, at most 4 at once, at most 6 turns each)
   │        │          │         │
 PubMed  ClinicalTrials  openFDA   web search
   │        │          │         │
   ▼        ▼          ▼         ▼
virtual file system   /plan.md  /sources/<kb>/*.md  /findings/agent-n.md  /report.md
   │
   ▼
synthesis agent (reads the files, not the sub-agents' conversations)
   │
   ▼
evals & traces (4 deterministic checks + 1 LLM-judge check; every agent, model call and tool call as a span)
```

The app draws one run in that order, live as it streams or replayed from a saved run. This is a teaching example, not a medical tool: model output can be wrong even when it is cited, so open the sources.

## What each part does

- **Skills layer** — `skills/*.md`. Five playbooks (literature review, clinical trials, drug safety, regulatory landscape, evidence synthesis), each with a one-line description in its front matter. The orchestrator only ever sees those descriptions; a playbook's full text is loaded into a sub-agent's prompt when the plan assigns it (progressive disclosure).
- **Orchestrator** — `src/agents/orchestrator.ts`. One structured-output call that returns 2–4 subtasks, each tied to one knowledge base and the skills it needs. Unknown sources and skills are dropped, and the number of subtasks is capped.
- **Research sub-agents** — `src/agents/researcher.ts`. A bounded tool loop per subtask. Tool results go back to the model as short excerpts, while the full documents are written to the file system (context offloading). Every tool result carries the number of turns left, and on the last turn the model is forced to call `finish` with claims tied to source ids.
- **Knowledge bases** — `src/sources/`. All free, all called live, no keys needed:
  - **PubMed** through NCBI E-utilities: esearch (JSON) for PMIDs, efetch (XML) for titles and abstracts. Requests are spaced to stay under 3 a second.
  - **ClinicalTrials.gov** API v2: phase, status, enrollment, primary outcome, and whether results are posted.
  - **openFDA**: drug labels (boxed warning, warnings and precautions, adverse reactions) and FAERS report counts, which are explicitly marked as reports, not incidence.
  - **Web search**: Gemini with Google Search grounding. Each grounded sentence becomes a claim citing exactly the pages it came from.
- **Virtual file system** — `src/vfs.ts`. In memory, path-checked, and saved with the run.
- **Synthesis agent** — `src/agents/synthesis.ts`. It reads `/findings/*.md` and a catalogue of every retrieved source, then writes a report with a direct answer, sections, limitations and a confidence grade. Every sentence cites ids in square brackets.
- **Evals** — `src/evals.ts`:
  - **Citation validity**: every cited id is a source the agents actually retrieved.
  - **Citation coverage**: the share of sentences that cite something.
  - **Subtasks answered**: the share of sub-agents that returned at least one sourced claim.
  - **Source diversity**: how many of the planned knowledge bases the report cites.
  - **Groundedness**: a judge model checks up to 12 cited sentences against the passages of the cited sources that are most relevant to each sentence.
- **Traces** — `src/trace.ts`. Spans with timings, tokens and cost for the run, each agent, each model call and each tool call, streamed to the UI's waterfall.

## Measured on four sample runs

Live runs on 2026-10-12 with `gemini-3.8-flash`, saved in `results/runs/` and replayable in the app. Costs use $0.75 per million input tokens and $3.75 per million output and thinking tokens. Grounded web searches are billed per query after the first 5,000 a month (free tier); these sample runs predate recording the search count, so search cost is not included. New runs record it on the web sub-agent's span.

| Query | Sub-agents | Time | Model / tool calls | Tokens in / out | Cost | Sources | Validity | Coverage | Answered | Diversity | Grounded |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| GLP-1 receptor agonists and acute pancreatitis | PubMed, openFDA, web | 227 s | 16 / 16 | 75.2k / 20.7k | $0.134 | 43 | 100% | 100% | 3/3 | 100% | 83% |
| Semaglutide in HFpEF | PubMed, trials, openFDA, web | 81 s | 16 / 11 | 57.6k / 17.6k | $0.109 | 46 | 100% | 100% | 4/4 | 100% | 100% |
| SGLT2 inhibitors and diabetic ketoacidosis | openFDA, trials, PubMed | 123 s | 19 / 17 | 74.0k / 22.2k | $0.139 | 31 | 100% | 100% | 3/3 | 100% | 67% |
| Tirzepatide for obstructive sleep apnea | PubMed, trials, web | 103 s | 14 / 9 | 36.7k / 16.1k | $0.088 | 23 | 100% | 94% | 3/3 | 100% | 79% |

What the evals caught:

- **A sub-agent that never finished.** In the first live run (not kept as a sample), the PubMed sub-agent searched six times and ran out of turns without writing a finding. *Subtasks answered* dropped to 2/3, and the report said trial data was missing. Offering only `finish` on the last turn was not enough, because the model still called `search_pubmed`. The fix forces the call: function calling mode `ANY` with `finish` as the only allowed function. Every tool result also now shows how many turns are left. The next run on the same query answered 3/3.
- **Claims that go beyond the sources.** In the SGLT2 run, the judge rated 8 of 12 sentences "partial". Some of those verdicts were fair: the synthesis agent added a plausible clause ("because of a significantly increased risk of DKA") that the retrieved text does not say. Others were an artifact of the judge seeing only the first 1,500 characters of each FDA label, while the cited warning sits in section 5.1. The judge now receives the passages most relevant to each claim, and labels keep more of each section. **The four sample runs were judged before that change**, so their groundedness scores are on the stricter, narrower view.

## Run it

Requires Node.js 22.12 or later. From `agents/pharma-research-agent/`:

```bash
npm ci
cp .env.example .env    # add GEMINI_API_KEY to research live; without it the app replays saved runs
npm start               # http://127.0.0.1:4325
npm test                # offline: pipeline, bounds, evals, parsers, the Gemini request shape
npm run check           # TypeScript type check
npm run research -- "your question"          # offline dry run: scripted model + recorded sources, no network
npm run research -- --live "your question"   # live: Gemini (paid) + the four knowledge bases
npm run export          # static, replay-only copy in dist/ with the sample runs
```

- **Live runs** make about 14–19 Gemini calls and cost roughly $0.09–$0.14 with `gemini-3.8-flash` at the prices above. Set the prices in `.env` to see a cost estimate; without them, cost is shown as unknown.
- **Limits:** the server runs one live run at a time and only binds to 127.0.0.1.
- **Where runs are saved:** in `runs/`, which Git ignores.
- **Offline mode** (`src/offline.ts`) replaces the model with a scripted stand-in and the APIs with responses recorded in `tests/fixtures/sources.json`. The structure is real: plan, parallel loops, files, synthesis and evals all run. The text is a placeholder.
- **Re-recording fixtures:** `npx tsx scripts/record-fixtures.ts` calls the three public APIs.

Gemini is called over its REST `generateContent` endpoint without an SDK. The request shapes (structured output with `responseJsonSchema`, `parametersJsonSchema` function declarations, `functionResponse` parts in a user turn, echoing the model's content so thought signatures survive, and `googleSearch` grounding) were checked against [the API reference](https://ai.google.dev/api/generate-content) on 2026-10-12. Google's guides now focus on the newer Interactions API; `generateContent` remains a supported core API.

## Limits

- **Not medical advice.** Reports can misstate or over-generalise even when every citation is valid. That is why groundedness is measured and the sources are one click away.
- **Abstracts, not full texts.** PubMed sub-agents read abstracts. Effect sizes that appear only in full texts are missed, and the reports say so in their limitations.
- **FAERS counts are reports, not rates.** The drug-safety skill and the synthesis skill both tell the models never to convert them into rates.
- **Web sources are Google's grounding redirect links.** They can stop resolving over time; their titles and the cited text are kept in the run.
- **One judge, one model family.** The groundedness judge is the same model that wrote the report. See [llm-judge-reliability](../../evaluations-reliability/llm-judge-reliability/README.md) for why that matters.
- **Small sample.** Four sample runs show how the system behaves. They are not a benchmark.

## Sources

- NCBI, [Entrez Programming Utilities](https://www.ncbi.nlm.nih.gov/books/NBK25501/) (usage guidelines: 3 requests a second without an API key).
- ClinicalTrials.gov, [API v2](https://clinicaltrials.gov/data-api/api).
- openFDA, [drug label](https://open.fda.gov/apis/drug/label/) and [adverse event](https://open.fda.gov/apis/drug/event/) endpoints, and [authentication and limits](https://open.fda.gov/apis/authentication/).
- Google, [Gemini API: generateContent](https://ai.google.dev/api/generate-content), [models](https://ai.google.dev/gemini-api/docs/models) and [pricing](https://ai.google.dev/gemini-api/docs/pricing).
- Anthropic, [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system), for the orchestrator–sub-agent pattern.

Related: [Anatomy of a harness](../harness-anatomy/README.md) explains skills, offloading, subagents and the file system that this agent uses. Community category: [Agents & Workflows](https://aiengineer.help/c/agents-workflows/7).
