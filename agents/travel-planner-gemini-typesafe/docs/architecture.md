# Travel Lab architecture

The TypeScript Node HTTP server serves a bundled TypeScript browser app. The agent backend uses `@langchain/langgraph`. `POST /api/compare` validates the brief, creates isolated state for two runs, and streams NDJSON events until both finish. Disconnecting cancels the server's upstream requests. API keys never enter the browser configuration.

## Execution flow

```text
Trip brief → isolated LangGraph state
           → choose_agent node (Gemini or Jev, when choices exist)
           → choose_tool node (same coordinator, when choices exist)
           → execute_tool node (Gemini generates structured content)
           → conditional edge to choose_agent, or end
           → finish, clarify, error, cancel, or reach step limit
```

LangGraph state holds the task, researched activities and meals, draft, review, action history, latest error, step count, selections, and status. The coordinator also sees its remaining step budget. The two dependent choices execute sequentially. Available options are derived from current prerequisites: planning requires both nonempty activity and meal evidence, review requires a draft, and finish requires passing deterministic and specialist reviews. A sole legal option is selected by code without a model call; when alternatives exist, Gemini or Jev chooses from the same options. Selections are validated against the current options; tool arguments and itinerary structure are validated before use. The graph is compiled per team run and invoked with a bounded recursion limit; the existing append-only journal persists events and results. No LangGraph checkpointer is configured, so graph state cannot be resumed from an interrupted node.

## Tools and completion

| Agent | Tools | Effect |
| --- | --- | --- |
| Researcher | `search_places`, `search_food` | In live mode, use Gemini Google Search grounding and extract sourced candidates; offline tests filter synthetic fixtures |
| Planner | `draft_itinerary`, `revise_itinerary` | Produce a structured itinerary from researched evidence |
| Reviewer | `review_itinerary` | Run deterministic checks and obtain a Gemini preference review |

New research or a revised plan invalidates the previous review. `finish` is offered only when deterministic validation and specialist satisfaction pass, and its prerequisites are checked again on execution. An unavailable agent or tool selection fails explicitly. `clarify` ends with `needs_input`; it does not prove a request is mathematically infeasible. Tool/worker failures are recorded in state so the coordinator can recover within the shared 12-step budget. A failed budget review is marked in action history. If even the cheapest distinct activities and acceptable meal in the current evidence exceed budget, and subsequent research or a revision leaves the relevant options unchanged (or budget validation fails twice), both teams are offered only `clarify`. This bounds a no-progress loop observed during frozen-evidence benchmarking; it can ask for input even when an unresearched cheaper real-world option exists.

## Provider boundary

Gemini uses `generateContent` with `responseJsonSchema` for structured decisions and extraction. Research uses `google_search` grounding first, then a separate structured extraction call. Jev uses the System One endpoint with a Choice question over the supplied criteria. Worker prompts, schemas, tools and evaluation rules are shared. There is no fallback to another model or to offline data on failure. Each team researches separately, so source variation can affect the result beyond coordination quality.

Offline mode replaces coordination and generation with a deterministic policy and uses the bundled catalogs. It exercises the same tool execution, evaluator and stream, but cannot measure either provider. Both offline teams intentionally produce equal results.

The routing benchmark sends identical frozen decision states and legal choices to each coordinator, alternates API order, and scores hand-authored expected actions. The whole-agent benchmark supplies the same synthetic activity and meal evidence to both runs while leaving coordination, worker generation and validation live. It alternates team order, independently grades final plans, and expects clarification on a budget proven impossible for the frozen catalog. Neither benchmark uses Google Search; this removes changing retrieval results and grounding charges from the measurement. The published reports omit raw model requests and responses.

## Measurements and limits

Each upstream call records provider, stage, returned model version when available, wall time, usage, estimated cost and error. Grounding can incur search-query charges outside token pricing, so total API cost is unknown for live web-research runs. Coordination latency is separate from end-to-end latency. Missing usage or rates propagate as unknown. Invalid or failed requests may still incur charges that cannot be calculated from the response. Traces summarize decisions, tool arguments, results and errors; they are not hidden chain-of-thought.

Provider requests time out after 45 seconds. Web comparisons time out after four minutes and support cancellation. At most two web comparisons run concurrently. CLI evaluations have the same step/request bounds but no extra four-minute wall-clock deadline. `run-store.ts` writes per-run metadata and an append-only NDJSON event journal in `.runs/`. Events are flushed before streaming. Completed, failed, cancelled and interrupted runs remain available through `GET /api/runs` and `GET /api/runs/:id`. The browser reopens saved snapshots without invoking providers. This store assumes one local server process.

## Comparison limitations

The same worker model is not guaranteed to return identical text on separate calls. The two teams can collect different web evidence and take different paths for reasons beyond their coordinators. Prerequisite rules constrain both teams equally and eliminate some model decisions; the comparison measures decisions only where multiple valid choices remain. Concurrent runs can contend for shared Gemini quota. Estimated pace and cost checks do not establish real travel feasibility. Source association and extracted venue facts need human verification. The shared Gemini preference review is useful feedback but cannot independently establish quality; a published evaluation needs human review and repeated cases.

Changing the brief starts two fresh runs. Stateful replanning, verified venue APIs, booking, shared databases and public hosting are outside this first implementation.
