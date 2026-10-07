# Prompt caching: what breaks it, what it saves, and what we measured

Most production prompts repeat thousands of tokens on every call: instructions, tool definitions, policies and examples. Prompt caching lets the provider reuse its work on that repeated part, at up to a tenth of the input price. It only works when the repeated part comes first and stays byte-for-byte identical, and a misplaced timestamp turns it off without any error.

This example has three parts:

- **An article** that explains how prompt caching works on Claude, Gemini and OpenAI, lists eight ways to break it, and reports a live experiment.
- **A playground** where you paste a prompt as blocks (tools, system prompt, documents, history, user message). It shows how much can be cached and highlights the values that break the cache (dates, IDs, names, counters, template slots). It explains each problem, estimates the cost per 1,000 requests for seven models, and reorders the prompt in one click. It runs entirely in the browser.
- **An experiment** that sent the same 5,400-token support-agent prompt to Gemini 3.8 Flash in eight layouts, 12 requests each, and recorded cached tokens, latency and cost.

**Live:** [the article](https://prompt-caching-steel.vercel.app) and [the playground](https://prompt-caching-steel.vercel.app/playground). To run them locally, run `npm start` from this directory and open [http://127.0.0.1:4321](http://127.0.0.1:4321) (the playground is at `/playground`). No API key is needed.

## Key takeaways

Measured on 2026-10-07 with `gemini-3.8-flash`. The full tables are in [`results/report.md`](results/report.md).

1. **A prompt cache is a prefix match.** Only the leading part that is identical to an earlier request can be reused. The first difference ends it.
2. **Position decides everything.** A timestamp on the first line of the system instruction cut the reusable prefix from 5,382 tokens (99.7%) to 783 (14.4%). The same timestamp at the end of the user message left 5,403 (99.5%) reusable. Customer details showed the same pattern: 774 tokens at the top, 5,389 at the bottom.
3. **Invisible differences count.** The same seven tools in a different order left 11 reusable tokens. The question placed before the handbook left 1,086. Both are below Gemini's 4,096-token minimum, so nothing could be cached.
4. **Gemini's implicit caching never hit.** We sent 97 eligible requests with byte-identical prefixes seconds apart, using streaming and non-streaming, with and without tools, at 4,500 to 13,100 tokens, through both `generateContent` and the Interactions API. All 97 had zero cached tokens. Google describes implicit caching as having "no cost saving guarantee".
5. **Explicit caching hit every time.** With a `cachedContents` cache, 12 of 12 requests read 5,384 tokens (99.7%) from cache, and the cost per request fell 84%, from $0.00439 to $0.00072, including output and storage.
6. **No latency gain at this size.** Median time to first token was 2.30 s with the explicit cache and 2.10 s without a hit. At 5,400 tokens, network, queueing and generation dominate.

## How prompt caching works

A model reads the prompt (prefill) before it generates (decode). Each token's internal state depends only on the tokens before it, so two requests that start the same way produce the same state for that shared start. Providers keep that state for a few minutes and reuse it. The model still sees the whole prompt, so answers don't change; only the price and the prefill time do.

Providers join a request's fields into one sequence. Claude documents the order as tools, then system, then messages. Put content in that sequence from most stable to least stable:

```text
tools (sorted)  →  instructions  →  shared documents and examples  →  per-user context  →  history  →  new message (+ date, IDs)
```

| | Anthropic Claude | Google Gemini | OpenAI |
|---|---|---|---|
| How to turn it on | `cache_control` breakpoints (up to 4), or set once at the top level for automatic placement | Implicit: on by default, best effort. Explicit: `cachedContents` | Automatic; GPT-5.6+ also has explicit breakpoints |
| Cache read | 0.1× input (0.05× on Opus 5.5) | 0.1× input | 0.1× input (0.05× on GPT-6.1 Sol) |
| Cache write | 1.25× (5 min) or 2× (1 hour) | Explicit: storage, $0.50 per million tokens per hour (3.8 Flash) | 1.25× on GPT-5.6+; none before |
| Minimum | 512 tokens (Opus 5.5, Sonnet 5.5), 4,096 (Haiku 4.5) | 4,096 (3.x), 2,048 (2.5) | 1,024 (GPT-5.6+) |
| Lifetime | 5 minutes, reset on each hit; 1 hour optional | Implicit: undocumented. Explicit: you set it (default 1 hour) | 30 minutes (GPT-5.6+) |
| Check hits | `usage.cache_read_input_tokens` | `usageMetadata.cachedContentTokenCount` | `usage.input_tokens_details.cached_tokens` |

Checked against the official docs on 2026-10-07: [Claude](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) ([pricing](https://platform.claude.com/docs/en/about-claude/pricing)), [Gemini](https://ai.google.dev/gemini-api/docs/caching) ([explicit caching](https://ai.google.dev/gemini-api/docs/generate-content/caching), [pricing](https://ai.google.dev/gemini-api/docs/pricing)), [OpenAI](https://developers.openai.com/api/docs/guides/prompt-caching) ([pricing](https://developers.openai.com/api/docs/pricing)). Gemini 3.8 Flash prices are promotional until 2026-12-31.

## Requirements

- Node.js 20 or later. No npm dependencies. `npm ci` is not needed, because there is no lockfile to install from.
- For the live experiment only: a Gemini API key with billing enabled. The main run cost $0.38.

## Commands

Run from `production-deployment/prompt-caching/`:

```bash
npm test                        # 17 tests: detectors, analyzer, optimizer, cost model
npm start                       # article + playground on http://127.0.0.1:4321 (PORT and HOST to change)
npm run experiment              # dry run: prints the plan and worst-case cost, sends nothing
cp .env.example .env            # then set GEMINI_API_KEY
npm run experiment -- --live    # 96 paid requests to gemini-3.8-flash (about $0.40)
npm run experiment -- --live --only stable,explicit
npm run analyze                 # newest run → results/summary.json, requests.jsonl, report.md
node experiment/diagnose.js     # dry run of the implicit-caching follow-up (--live: 12 paid requests, about $0.08)
npm run export                  # static copy for deployment in dist/ (keeps dist/.vercel)
```

Raw runs, which include full request metadata, go to the Git-ignored `runs/`. `npm run analyze` writes the committed `results/`.

## Layout

```text
src/            analysis engine, shared by the playground, tests and experiment
  detectors.js    finds values that change between requests (timestamps, dates, IDs, names, counters, template slots)
  analyzer.js     shared and per-session prefix, findings, score, and the suggested reorder
  cost.js         input cost per 1,000 requests with and without caching
  providers.js    caching rules and prices for 7 models, with sources
  fixture.js      the Northwind Outfitters support prompt (instructions, handbook, tools, examples, questions)
  presets.js      the playground's six examples
experiment/
  layouts.js      the eight prompt layouts
  run.js          sends them to Gemini (dry run unless --live)
  analyze.js      raw run → results/
  diagnose.js     the implicit-caching follow-up
results/        committed measurements (summary.json, requests.jsonl with every answer, report.md, diagnostics.json)
site/           article (index.html) and playground (playground.html)
scripts/        local server and static export
test/           node --test suite
```

## The experiment

**Prompt.** A support assistant for Northwind Outfitters, a fictional outdoor-gear store. The prompt has 1,211 characters of instructions, a 15,940-character policy handbook, seven tools and four example exchanges, about 5,400 Gemini tokens in total. Each request adds one of 12 customer questions.

**Layouts.** Same content, different placement:

| Layout | What changes, and where | Reusable prefix | Implicit hits | Cost / request |
|---|---|---:|---:|---:|
| Stable prefix | Only the question, at the end | 5,382 (99.7%) | 0/12 | $0.00439 |
| Timestamp at the top | Millisecond timestamp, first line of the system instruction | 783 (14.4%) | 0/12 | $0.00436 |
| Timestamp at the bottom | The same timestamp after the question | 5,403 (99.5%) | 0/12 | $0.00435 |
| Customer details at the top | A different customer's name and email per request, first line | 774 (14.3%) | 0/12 | $0.00438 |
| Customer details at the bottom | The same details in the user message | 5,389 (99.4%) | 0/12 | $0.00448 |
| Tools in a different order | Same seven tools, shuffled per request | 11 (0.2%) | 0/12 | $0.00443 |
| Question before the handbook | Retrieval-style: question first, handbook after | 1,086 (20.1%) | 0/12 | $0.00436 |
| Explicit cache | Stable part stored with `cachedContents`; requests send only the question | 5,384 stored | 12/12 (99.7% cached) | $0.00072 |

**Procedure.** 12 sequential requests per layout, 1.5 s apart; streaming, temperature 0, thinking level `LOW`, up to 300 output tokens. Each layout's system instruction starts with a fixed tag, so layouts can't read each other's cache. The *reusable prefix* is the median number of leading characters each request shares with the previous one, with the request rendered as tools, then system, then user, and converted to tokens with Gemini's counts. It depends only on the prompt, and is the most any prefix cache could reuse. Costs use Gemini's reported token counts and list prices.

**Follow-up.** After zero implicit hits, 12 more requests tested non-streaming, no tools and no thinking setting, a 13,100-token prompt, and the Interactions API. All had zero cached tokens ([`results/diagnostics.json`](results/diagnostics.json)).

Every request, with the model's answer, is in [`results/requests.jsonl`](results/requests.jsonl).

## The playground

The playground answers one question: *which part of my prompt gets cached, and what stops it?* It works in three steps:

1. **Pick an example** (six common mistakes and one good layout) or paste your own prompt as parts: tool definitions, system prompt, examples, documents, conversation history, user message. Each part says whether it is the same for everyone, different per user, or different every request.
2. **Read the colors.** The prompt text itself is tinted green where it is reused for everyone, blue where it is reused within one user's conversation, and red where it is paid in full on every request. A red line marks where the cache stops, and the values that change anyway (dates, times, IDs, names, emails, counters, template slots) are highlighted. A plain-language verdict gives the reused share and explains what ended it, for example: "The cache stops at `2026-10-07T14:32:09Z` on line 1 of the System prompt. This time changes on every request, so the 4,681 tokens after it are paid in full on every request."
3. **Apply the fixes.** Each problem comes with what to do and a "Show me" link. "It never changes" dismisses a false positive, such as a fixed policy date. **Apply all fixes** moves the changing lines to the end, sorts the tools and reorders the parts, then shows the change (for example "20% → 99%") with an undo.

Below that, two requests are shown side by side to make the prefix rule visible. The input cost per 1,000 requests is estimated for Claude Opus 5.5, Sonnet 5.5 and Haiku 4.5, Gemini 3.8 Flash and 3.1 Pro, and GPT-6.1 Sol and GPT-6 Luna. Traffic assumptions are adjustable.

Token counts are estimates, at about four characters per token. The cost model assumes steady traffic: the shared part is written once and read by every later request if requests arrive within the cache lifetime, and the per-user part is written on each conversation's first message. Use it to compare layouts, not to forecast a bill.

## Deployment

The article and playground are a static site on Vercel at [prompt-caching-steel.vercel.app](https://prompt-caching-steel.vercel.app), in the project `exclusive1s-projects/prompt-caching`. They make no API calls, so serving them costs nothing beyond hosting. To redeploy, run `npm run export`, then `vercel deploy --prod` from `dist/`. The export keeps `dist/.vercel`, the local project link.

## Limitations

- **One provider, one model, one day.** Claude and OpenAI behavior comes from their documentation. We didn't measure it.
- **Low traffic.** Requests were sequential, about 4 s apart. Implicit caching might hit at production volumes.
- **Small samples.** 12 requests per layout clearly separates 0 from 12 hits, but can't resolve latency differences of a few hundred milliseconds.
- **The reusable prefix assumes a rendering order** of tools, then system, then user. Gemini doesn't document its order. The contrasts hold either way, because each changed value sat at the start or end of a block.
- **Heuristic detection.** The playground uses patterns, so it can miss values (a random few-shot sample) or flag fixed ones (a policy date). Dismiss false positives in the UI.
- **Synthetic data.** The store, policies, customers and questions were written for this example.

## Sources

- Anthropic: [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), [Pricing](https://platform.claude.com/docs/en/about-claude/pricing).
- Google: [Context caching](https://ai.google.dev/gemini-api/docs/caching), [Explicit caching with generateContent](https://ai.google.dev/gemini-api/docs/generate-content/caching), [Caching API reference](https://ai.google.dev/api/caching), [Pricing](https://ai.google.dev/gemini-api/docs/pricing), [Interactions API](https://ai.google.dev/gemini-api/docs/interactions).
- OpenAI: [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching), [Pricing](https://developers.openai.com/api/docs/pricing).

Discuss it in the [Production & Deployment](https://aiengineer.help/c/production-deployment/9) community category.
