# Clinic voice agent

A phone receptionist for a fictional clinic, built the way a voice-AI platform ships one to a business: a fixed workflow around a model, wired into the clinic's CRM, tested with simulated callers before launch, and measured on every call.

Meera, the agent, answers the phone for Birchwood Family Clinic. Before saying a word it looks the caller up by phone number. During the call it finds open times, books, moves and cancels appointments, answers policy questions from a small knowledge base, and transfers to a person when it should. After the call it writes a record and posts it to the clinic's system by webhook. You can talk to it in the browser, break its CRM in the middle of a call, and read the trace afterwards: where each second of latency went, every tool call and retry, and what the minute cost.

It runs on [LiveKit Agents](https://docs.livekit.io/agents/) 1.8 (Python) with Gemini, and includes a TypeScript dashboard.

**Try it live:** https://clinic-voice-agent-one.vercel.app. Call Meera from your browser (a few calls per visitor per hour, 3 minutes each), break the CRM mid-call, and read the call's trace. The rest of the site is a snapshot of the recorded simulation runs. See [Deploy a public demo](#deploy-a-public-demo).

## What it teaches

**The model talks; the workflow decides.** A voice agent for a business is mostly not the model. Here the model chooses words and tools, and code owns everything that has to go the same way every time:

| Step | Where | What it does | Why it is not left to the model |
| --- | --- | --- | --- |
| Pre-call lookup | `call.py` | Finds the patient by caller ID within a 1.5 s budget, loads their appointments into the instructions | A slow CRM must cost a generic greeting, never dead air |
| Guards | `agent.py` `llm_node` | Checks each caller turn for emergency phrases or "speak to a person" *before* the model runs, and transfers | A wrong guess on "chest pain" is too costly to leave to a model |
| Tool policy | `agent.py` | Booking needs a matched patient; a slot must be one offered on this call; an appointment must belong to the caller | Stops invented ids and one caller changing another's appointment |
| CRM client | `crm/client.py` | Per-attempt timeout, bounded retries with full jitter, `Retry-After`, a budget per operation, one idempotency key across a write's retries, schema validation | Third-party APIs time out, rate-limit, and return bad data |
| Post-call | `postcall.py` | Facts come from tool calls that succeeded; the model writes only the intent and summary | The record a clinic acts on must not be a model's reading of a transcript |
| Webhook | `postcall.py` | Outbox, HMAC-SHA256 signature with timestamp, retries on 5xx/429 only, call id as idempotency key | Delivery is at-least-once, so the receiver must be able to drop duplicates |

All of it is configured per customer in [`workflow/clinic.yaml`](workflow/clinic.yaml).

**Two pipelines, measured.** The same agent runs as:

- **Realtime**: Gemini Live (`gemini-3.8-live`) hears audio and speaks audio in one model. Fewest hops, and it hears tone. You cannot pick STT or TTS separately, and it starts replying by itself, so guards interrupt it from its transcript rather than running first.
- **Cascade**: STT → LLM → TTS (`deepgram/nova-3` on LiveKit Inference, `gemini-3.8-flash`, `gemini-3.1-flash-tts-preview`), with Silero VAD and LiveKit's turn detector. Every stage can be swapped and is timed on its own, and guards run before the LLM.

Each call records LiveKit's per-turn timings (end-of-turn decision, transcript, LLM first token, TTS first audio, and the end-to-end time from the caller going quiet to the agent speaking) and its token and audio usage, priced from a table with sources. The dashboard compares the pipelines on latency percentiles, end status and cost per minute. On the realtime pipeline Gemini decides when the caller's turn ends, so only the end-to-end reply time is measured; a local Silero VAD marks when the caller stopped speaking, which LiveKit needs to compute it.

**Traces in your own tools.** With `OTEL_EXPORTER_OTLP_ENDPOINT` set, each call is also exported as one OpenTelemetry trace ([`telemetry.py`](voiceagent/telemetry.py)), so it can go to Langfuse, Grafana Tempo, Datadog or Jaeger. A root `call` span carries who called, the end status, intent and cost; LiveKit's own spans (session, turns, LLM, TTS, tools) nest under it, and each CRM attempt is a span inside the tool that made it, marked as an error when it failed. Every span carries the call id as `session.id`, so a backend groups them by call. Transcripts, phone numbers, tool arguments and summaries stay out of the export unless `TRACE_CONTENT=true`, and LiveKit's `allow_pii` follows the same setting.

**Simulation before launch.** Twelve simulated callers in [`simulation/scenarios.yaml`](simulation/scenarios.yaml) run as text through the same agent, tools, guards and CRM client, using LiveKit's `AgentSession` in text mode. Each sets the CRM's fault switch and checks what must hold whatever the model says: which tools succeeded, whether a guard fired, how many bookings the CRM received, how the call ended.

A caller is one of two kinds ([`callers.py`](voiceagent/callers.py)). A **fixed caller** reads lines written in advance: deterministic and free, so it is the regression test for the workflow, but it does not listen. A **model caller** is a second Gemini call playing a person with a goal, such as *book a separate visit for a sore throat, take the first time offered*. It opens with the scenario's first line and then answers whatever the agent actually asks, so a live run measures whether the agent gets callers to their goal. A few checks, such as "booking was refused in code", only make sense when the caller is forced down that path; those live under `fixed_expect` and are asserted only with fixed callers.

## Limitations

- **Fictional clinic, synthetic patients, mock CRM.** Not for real medical use, and not a HIPAA-ready system: there is no PHI handling, consent, audit log or data retention policy.
- **The offline simulation uses a scripted model** ([`scripted_llm.py`](voiceagent/scripted_llm.py)): keyword rules, not an LLM. Its 12/12 tests the workflow around the model (retries, idempotency, guards, refusals, transfers). It says nothing about how a real model behaves; `simulate --live` runs the same scenarios with Gemini; see [What the live runs showed](#what-the-live-runs-showed).
- **A model caller is still a model.** It is more cooperative and more articulate than real callers: it does not mumble, change its mind, talk over the agent or misremember its date of birth. Passing with model callers is a floor, not a launch sign-off; real call review is still needed.
- **Guards are phrase lists.** They catch the listed phrases, not every way of describing an emergency. In the realtime pipeline they act on Gemini's transcript after it has started replying, and interrupt it.
- **Transfers.** A phone call transfers over SIP (`transfer_sip_participant`). A browser call has no phone line, so the transfer is recorded and the call ends.
- **Cost** covers model usage at list prices checked on 2026-10-28 ([`pricing.py`](voiceagent/pricing.py)). It leaves out telephony minutes, LiveKit Cloud minutes and cache discounts. Gemini TTS input tokens are estimated from characters.
- **SQLite** stands in for the Kafka + ClickHouse pipeline a platform would use; the event shape is the same. The OpenTelemetry export sends the same calls to a real tracing backend, but there are no alerts, dashboards or retention rules set up there.

## Requirements

- Python 3.12+ and [uv](https://docs.astral.sh/uv/)
- Node.js 22+ (dashboard)
- Docker (a local LiveKit server), or a [LiveKit Cloud](https://cloud.livekit.io) project
- For voice calls: a [Gemini API key](https://aistudio.google.com/apikey). For the cascade pipeline or phone calls: a LiveKit Cloud project, because its STT runs on LiveKit Inference.

Verified with `livekit-agents` 1.8.9, `livekit-plugins-google` 1.8.9, `livekit-client` 2.23.0 and `livekit/livekit-server` v1.13.9 on macOS.

## Run it

From `agents/clinic-voice-agent/`:

```bash
uv sync --locked
(cd web && npm ci && npm run build)
uv run python -m voiceagent simulate        # 12 simulated callers, offline, free
uv run python -m voiceagent serve           # dashboard on http://127.0.0.1:4331
```

The dashboard opens on **Talk to the agent**. Without a key you can browse the **Workflow**, run and read the **Simulation**, and open each simulated call's trace under **Calls**.

### Talk to it (paid)

```bash
cp .env.example .env                        # add GEMINI_API_KEY
docker compose up -d                        # LiveKit server on ws://127.0.0.1:7880
uv run python -m voiceagent serve           # terminal 1
uv run python -m voiceagent.worker dev      # terminal 2: the agent
```

Open http://127.0.0.1:4331, enter a name and a phone number under **Call as yourself** (or choose a **Sample patient**), and press **Call Meera**. Your name and number are added to the mock CRM as a patient with one upcoming check-up, so the agent greets you by name and can book, move or cancel. That record lives in memory and is gone when the server restarts; nothing is dialled. Every call makes paid Gemini requests (see [Costs](#costs)). The live transcript shows beside the agent, and the trace appears under **Calls** while you talk.

Calls use the realtime pipeline by default. For the cascade pipeline, set `VOICE_PIPELINE=cascade` in `.env`, point `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` at a LiveKit Cloud project instead of the local server, and download the VAD model once: `uv run python -m voiceagent.worker download-files`.

### Break the CRM

The **Break the CRM** switch under the call switches the mock CRM's failure mode while a call is running: slow responses (past the pre-call budget), one 500, 429 with `Retry-After`, a booking that commits but whose response is lost, malformed slot data, or a 503 on everything. Each scenario in the simulation does the same thing on purpose. In the lost-response case, the trace shows the first `POST /appointments` time out, the retry go out with the same idempotency key, and the CRM replay the original booking, so exactly one appointment is created.

### See calls as traces

```bash
docker compose --profile tracing up -d      # Jaeger: OTLP in on :4318, UI on http://127.0.0.1:16686
```

In `.env`, set `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318` and `TRACE_UI_URL=http://127.0.0.1:16686/trace/{trace_id}`, then restart `serve` and the worker. Every call, including each simulated one, appears in Jaeger under the service `clinic-voice-agent`, and a call's page in the dashboard gets an **Open trace** link. For Langfuse, point the endpoint at `https://cloud.langfuse.com/api/public/otel` with the auth header shown in [`.env.example`](.env.example); any other backend that accepts OTLP over HTTP works the same way.

A call to the lost-response scenario looks like this in the trace:

```
call                                   resolved · book · pt_1003
├── crm GET /patients                  6 ms
├── pre_call                           7 ms
└── agent_session
    ├── agent_turn
    │   └── function_tool              find_open_slots
    │       └── crm GET /slots         1 ms
    └── agent_turn
        └── function_tool              book_appointment
            ├── crm POST /appointments 2002 ms   ERROR timeout (committed, response lost)
            └── crm POST /appointments 3 ms      same idempotency key, booking replayed
```

### Export calls

On a call's page, **Download call** saves it as one JSON file: the call, its post-call record, every event in order and the latency of each turn. On **Calls**, **Export CSV** saves one row per call for the selected source: outcome, intent, transfer, duration, reply latency p50 and p95, tool calls, CRM attempts and failures, and cost. Both default to leaving out patient details (phone numbers, what was said, tool arguments and results, the summary); the second option in each menu includes them. The same files come from `GET /api/calls/{id}/export` and `GET /api/calls.csv`, with `?content=true` for the full version.

### Deploy a public demo

The public demo has two parts:

- **Vercel** serves a static snapshot of the dashboard (the workflow, the three simulation runs with every transcript, the recorded call traces and exports) and one function, `POST /api/session`, that starts a live call ([`web/server/session.ts`](web/server/session.ts)).
- **LiveKit Cloud** runs the agent from the [`Dockerfile`](Dockerfile) in hosted mode (`CRM_MODE=embedded`): each call gets its own in-memory mock CRM with the caller registered from the call's metadata, the fault switch arrives from the browser (at the start of the call, and mid-call as a participant attribute), every call ends after 3 minutes, and no webhooks go out. The agent streams each event of its call log to the caller's browser, so the page shows the call's trace without a shared database.

Every visitor's call spends your Gemini key, so the function checks limits before it hands out a token: at most `MAX_CONCURRENT_CALLS` calls at once (default 2, counted from LiveKit's live rooms), and, when an Upstash Redis store is connected, `CALLS_PER_IP_PER_HOUR` per visitor (default 3) and `CALLS_PER_DAY` in total (default 40). If a limit cannot be checked, it refuses the call. Without Redis only the concurrency limit applies, so connect it before sharing the link, and set a spending cap on the Gemini key as well. At 40 calls of at most 3 minutes and Gemini Live's list prices, a full day costs a few dollars.

1. Create a LiveKit Cloud project and log the CLI in: `lk cloud auth`.
2. Deploy the agent from this directory, with the Gemini key in a secrets file that stays out of Git:
   ```bash
   printf 'GEMINI_API_KEY=%s\n' "<your key>" > .env.agent
   lk agent create --secrets-file=.env.agent      # builds the Dockerfile; later: lk agent deploy
   ```
3. Build and export the site, then deploy it:
   ```bash
   (cd web && npm run build && npm run build:api)
   uv run python -m voiceagent export-site        # writes site/; only simulated calls are included
   cd site && vercel deploy --prod
   ```
4. In the Vercel project, set `LIVEKIT_URL` (`wss://<project>.livekit.cloud`), `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` from the LiveKit project, add an Upstash Redis store from the Vercel Marketplace (it sets `KV_REST_API_URL` and `KV_REST_API_TOKEN`), optionally `RATE_LIMIT_SALT` and the three limits above, and redeploy.

Without the LiveKit variables the function answers 503 and the Talk page says live calls are not configured; the rest of the snapshot works. On LiveKit Cloud's free plan the agent scales to zero when idle, so the first call after a quiet spell takes 10 to 20 seconds to be answered.

### Phone calls

[`docs/telephony.md`](docs/telephony.md) shows how to point a Twilio or Telnyx number at the agent over LiveKit SIP. Nothing is provisioned by this example.

## Expected output

```
$ uv run python -m voiceagent simulate
PASS  book-known-patient                     0.04s
PASS  reschedule                             0.01s
...
PASS  lost-response-no-double-booking        2.08s
PASS  crm-bad-data                           0.01s

12/12 scenarios passed (scripted)
```

`simulate` writes the report to `results/simulation-scripted.json` (committed) and a timestamped copy to `runs/simulations/` (Git-ignored). Simulated calls go into the call log at `runs/calls.db`. `simulate --live` (Gemini as the agent, a model playing each caller) writes `results/simulation-live.json`; `simulate --live --fixed-callers` (Gemini as the agent, the offline lines as callers) writes `results/simulation-live-fixed-callers.json`. Live pass counts can vary between runs, because model replies vary.

## What the live runs showed

### Fixed callers

The first live run, on 2026-10-29, had `gemini-3.8-flash` play the agent in text mode against the 12 fixed caller scripts (now `simulate --live --fixed-callers`): **5 of 12 passed**, for $0.04 in model usage. The full report, with every transcript, is in [`results/simulation-live-fixed-callers.json`](results/simulation-live-fixed-callers.json). It was recorded before the fictional people were renamed, so its transcripts use the earlier names (Robin, Maya, Dr. Lin and others).

The 7 failures are mostly a problem with the test, not the agent. The caller lines were written for the scripted model, which books on the first "yes". Gemini asked one more question first, then the caller's next fixed line ("That's all, bye") ended the call before anything was booked:

- It asked the caller to confirm the time again before booking, as its instructions say (`book-known-patient`, `crm-rate-limited`).
- It asked which of three times the caller wanted (`reschedule`).
- It noticed the caller already had a check-up the next day and asked whether to use that visit instead (`crm-500-then-ok`, `lost-response-no-double-booking`). In the second case it suggested covering the blood pressure question at the existing visit, which was a reasonable choice.
- It told an unregistered caller up front that it could not book and offered a transfer, so the code-level refusal the scenario checks for was never reached (`unknown-caller-cannot-book`).
- It asked for the reason for the visit before searching, so the malformed slot data was never fetched (`crm-bad-data`).

What held in every run: the model never booked, moved or cancelled without an explicit yes; the emergency guard transferred chest pain to the nurse line without the model; billing went to the billing office; and with the CRM down it apologised and transferred instead of promising a booking. The CRM fault scenarios that depend on a booking (lost response, one 500) were not exercised, so the live run does not test them; the offline run and `tests/test_crm_client.py` do. One post-call summary timed out after 20 s and fell back to the rule-based summary.

The lesson for a voice deployment: fixed caller scripts are a good regression test for the workflow, but to evaluate the model you need simulated callers that respond to what the agent says. That is why the model callers exist.

### Model callers

The second live run, on 2026-11-01, had `gemini-3.8-flash` play the agent and a second `gemini-3.8-flash` play each caller from a persona and a goal (`simulate --live`): **12 of 12 passed**, for $0.059 of agent usage and $0.007 of caller usage. Each call took 7 to 36 seconds and 1 to 4 caller turns. The report, with every transcript, is in [`results/simulation-live.json`](results/simulation-live.json).

With callers that answer what was asked, the CRM fault scenarios the fixed run never reached were exercised end to end:

- **Lost response** (`lost-response-no-double-booking`): the caller picked 9:00, confirmed, and was booked. The first `POST /appointments` committed but its response was lost; the client retried with the same idempotency key and the CRM replayed the booking, so exactly 1 appointment was created.
- **One 500** (`crm-500-then-ok`): the client retried once and the booking went through; the caller never heard about the error.
- **Bad data** (`crm-bad-data`): the slot listing failed validation, so instead of offering times the agent apologised and transferred to the front desk.
- **CRM down** (`crm-down`): the pre-call lookup failed, the greeting said the records system was slow, and the agent transferred instead of promising a booking.

The agent kept the habits the fixed run showed: it confirmed every write before making it, and in `book-known-patient` it pointed out the caller's existing check-up the next day before booking a separate visit, which the caller declined. The emergency guard again transferred chest pain to the nurse line with no tool calls.

Two limits on what this shows. The model caller's goals are cooperative ("take the first time offered"), so the run does not test hostile, confused or silent callers. And for `unknown-caller-cannot-book` the model refused up front and offered a transfer, so the scenario checks only that nothing was booked; the code-level refusal is covered by the offline run. Live pass counts can change between runs.

## Check it

```bash
uv run pytest                               # 46 tests: CRM client, guards, KB, pricing, webhooks, API (including calling as yourself), callers, the OpenTelemetry trace, exports, hosted mode, all 12 scenarios
uv run ruff check voiceagent tests
uv run mypy voiceagent
(cd web && npm run check && npm test)        # includes the token function's limits
```

The tests make no network calls and need no key.

## Costs

Model list prices used for the cost column (per 1M tokens unless noted, checked 2026-10-28):

| Model | Used for | Price |
| --- | --- | --- |
| `gemini-3.8-live` | Realtime pipeline | audio in $3.00, audio out $12.00, text in $0.75, text out $4.50 |
| `gemini-3.8-flash` | Cascade LLM, post-call summary, `simulate --live` agent and callers | in $0.75, out $3.75 |
| `gemini-3.1-flash-tts-preview` | Cascade TTS | text in $1.00, audio out $20.00 (25 tokens per second) |
| `deepgram/nova-3` via LiveKit Inference | Cascade STT | $0.0048 per minute |

Sources: [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing), [LiveKit Inference pricing](https://livekit.com/pricing/inference). At the realtime audio rates, a minute of the caller speaking and a minute of the agent speaking cost about $0.005 + $0.018; the dashboard shows the measured figure per call. `simulate --live` makes roughly 100 short `gemini-3.8-flash` requests (agent turns, caller turns and summaries), a few cents; the run prints the agent and caller cost separately.

Clean up with `docker compose down`, and delete `runs/` to clear the call log.

## How it is organised

```
workflow/clinic.yaml      the customer's workflow: greeting, budgets, tools, guards, transfers, post-call
knowledge/*.md            the clinic's policies, searched with BM25
voiceagent/
  worker.py               LiveKit entrypoint: one job per call
  session.py              builds the realtime or cascade pipeline; records turns, usage, errors
  call.py                 per-call state and the pre-call lookup
  agent.py                instructions, tools, tool policy, guards, transfer, hang-up
  crm/server.py           mock CRM with a fault switch
  crm/client.py           the resilient CRM client
  kb.py                   BM25 over knowledge/
  postcall.py             record, summary, signed webhook with outbox
  telemetry.py            OpenTelemetry export: one trace per call, content off by default
  export.py               a call as JSON and the call log as CSV, redacted by default
  site.py                 export-site: the static snapshot for the public demo
  pricing.py, stats.py    cost and the dashboard aggregates
  store.py                SQLite call log (calls, events, webhook outbox and receipts)
  simulation.py           scripted callers through AgentSession in text mode
  callers.py              fixed callers and model callers with a goal
  scripted_llm.py         the offline stand-in for the model
  api.py                  dashboard API, mounted CRM, demo webhook receiver
web/                      Vite + React + TypeScript + Tailwind dashboard
web/server/session.ts     the demo's token function: limits, then a LiveKit token that dispatches the agent
Dockerfile                the agent image for LiveKit Cloud (hosted mode)
```

## Ways to extend it

- Run `simulate --live` and compare it with the offline run and the fixed-caller run: which checks does a real model fail, and why?
- Make the model callers harder: give a persona a wrong date of birth, a change of mind, or one-word answers, and see which checks break.
- Add a scenario for a caller who changes their mind halfway through a booking.
- Replace a guard's phrase list with a small classifier and measure its misses on the scenarios.
- Swap the cascade's STT or TTS for another LiveKit Inference model and compare the latency bars.
- Add a second customer: a new workflow file, knowledge folder and CRM, with no code changes.
- Send the traces to Langfuse or Grafana and build the alert a platform would page on: reply latency p95, or CRM errors per call.

## Sources

- LiveKit Agents: [Gemini Live plugin](https://docs.livekit.io/agents/models/realtime/plugins/gemini/), [Gemini TTS](https://docs.livekit.io/agents/models/tts/plugins/gemini/), [LiveKit Inference](https://docs.livekit.io/agents/models/inference/), [testing in text mode](https://docs.livekit.io/testing/unit-tests.md), [OpenTelemetry traces](https://docs.livekit.io/testing/observability/tracing.md)
- [Langfuse OpenTelemetry endpoint](https://langfuse.com/integrations/native/opentelemetry) and [Jaeger](https://www.jaegertracing.io/), checked 2026-11-01
- [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing) and [LiveKit Inference pricing](https://livekit.com/pricing/inference), checked 2026-10-28
- Related in this repository: [Tools, tool calling and unsafe execution](../tool-calling-safety/README.md) (why tools check ownership in code) and [Guardrails for AI agents](../../evaluations-reliability/agent-guardrails/README.md)

The clinic, its staff and its patients are fictional. Community discussion: none yet.
