# Context Compression Lab

A local, interactive app for learning what context compression keeps, what it removes, and which evidence survives. Built for [AI Engineer Help](https://aiengineer.help/) in [RAG & Retrieval](https://aiengineer.help/c/rag-retrieval/6), with an agent tool-output example.

The default app runs four transparent browser methods: **lexical ranking, MMR, word deletion and prefix truncation**. Optional adapters add BGE semantic unit scoring, published LLMLingua-2 checkpoint inference and the hosted Compresr API. It does not call an answering LLM or pretend that preserving a fact guarantees a correct answer.

**Local model execution is disabled until the laptop owner explicitly authorizes it.** No local inference, weight downloads or paid calls have been run for this extension. Model adapters are covered by mocks; the default browser methods need no accounts, keys, downloads, GPU or configuration.

## Run locally

Requires **Node.js 22.12+** and npm. Verified with Node.js 26.6.0. From the repository root:

```bash
cd rag-retrieval/context-compression
npm ci
npm start
```

Open **http://127.0.0.1:4325**. `PORT=4500 npm start` selects another local port. The server binds to loopback only. It rebuilds the client at startup; after editing TypeScript, restart it or run `npm run build:client` and reload the page. Styles and HTML are served directly.

The initial example compresses a 462-token synthetic customer handbook to 184 tokens at the default 60% removal target, retaining both annotated refund facts. Counts use the bundled **cl100k_base** BPE encoding. They are exact for that encoding, not estimates for Gemini or every other model. Only source context and its rendered separators are counted; system instructions, chat framing and questions are outside the displayed budget.

## What to try

1. **Read a document.** Compare the full customer handbook with the selected spans. Expand any “words dropped” marker. Switch from sentence to paragraph units and compare how much surrounding context survives.
2. **Find the breaking point.** Try 90% removal, then compare five budgets. The refund example loses the general eligibility rule. Switch to prefix truncation to see a different failure mode.
3. **Separate retrieval from compression.** In “Compress retrieval,” select “Two sources required” and set retrieved passages to one. The runbook condition is marked **Not retrieved**; increasing the compression budget cannot bring it back. Restore three passages and inspect the difference.
4. **Give a tool read its intent.** In “Trim a tool result,” switch between pricing and launch focus. The top-level question and captured timeline stay the same. Turn off “Include the read’s focus” and inspect the changed ranking. This is a captured synthetic tool output, not a running agent loop.
5. **Reduce repetition.** Select “MMR · reduce redundancy” and lower its relevance weight to penalize overlap with already-kept units. Inspector scores remain base relevance; the marginal score changes as selection proceeds. This is an implementation of the MMR principle with lexical relevance and Jaccard similarity, not semantic MMR.
6. **Delete inside a sentence.** Select “Word deletion · lexical” and inspect the cuts within prose. Query-matching words may survive while grammar, negation and entire annotated facts vanish. Turn off “Show dropped spans” to read the actual kept context without inspection markers. This illustrates fine-grained selection without pretending to use a trained classifier.
7. **Inspect the algorithm.** Expand “Under the hood” for every score, matching term and decision. Try dynamic budgeting; its largest-score-gap rule is deliberately simple and visible.
8. **Use your own text.** Paste up to 12,000 characters and edit the question. Custom text stays on this device for browser/local methods and has no evidence annotations. A hosted call sends it to Compresr only after explicit consent. Copy the kept text or export a JSON trace containing source, options, scores, spans and evidence decisions. Exported files contain your pasted text. Nothing is automatically uploaded or saved between reloads. Trace export is disabled while a selected model method has not run.

On smaller screens, expand “Adjust compression settings” to edit the experiment. The two context lanes stack vertically.

## How our implementation works

- **Units:** `src/compress.ts` splits Markdown-like text into paragraphs or sentences with original UTF-16 offsets. It preserves fenced code blocks as atomic units. A selected unit requires its ancestor headings. This is a small parser, not a full Markdown AST; tables, lists and other structures are not specially protected.
- **Relevance:** tokenize into unique lowercase letter/number terms, remove common stop words, and strip a trailing `s` from longer words. For every query term present in the unit or its headings, add `ln(1 + N / df(term))`. Divide by the square root of the unit's unique-term count (including headings). `N` is the number of units and `df` is the number of units containing the term. This is lexical overlap, not BM25 or a semantic model. A query term contributes at most once per unit.
- **Query awareness off:** use generic term rarity with the same normalization. Both question and focus are ignored.
- **Fixed budget:** `floor(sourceTokens × (1 − removalPercent / 100))`. Try units in descending score order, break ties in source order, skip zero-overlap units when query-aware, and accept a unit only if rendering it with all selected headings and `\n\n` separators fits. Output order follows the source. It is greedy packing, not optimal selection. The budget is a ceiling; zero-overlap units and indivisible units can leave space unused.
- **MMR:** normalize relevance by the highest base score. At each selection, maximize `λ × relevance − (1 − λ) × max Jaccard(candidate, selected)` over remaining units, breaking ties in source order. The weight defaults to 0.65. Accepted units alone affect redundancy; units that do not fit are skipped. It still uses a strict whole-unit budget.
- **Word deletion:** use whitespace words with original offsets, including preceding whitespace, as units. Apply the same lexical scoring; selected spans concatenate without inserted separators. This is intentionally simple, not token classification or entropy pruning. Query-aware mode can discard every non-matching word even when budget remains. Headings, code fences, grammar and negation are not protected in this method.
- **Dynamic budget:** find the largest adjacent score drop in the ranking, estimate the rendered size of units above that drop, and clamp that size between the token budgets implied by the min/max multipliers (with integer rounding). Then use the same greedy selection. The multiplier bounds constrain the budget, not the achieved ratio. This is **our heuristic**, not a claim about Latte's algorithm.
- **Truncation:** select an original-text prefix under the fixed token ceiling, allowing partial sentences but preserving Unicode characters. Binary search finds a fitting prefix; BPE token counts are not strictly monotonic, so it need not be the longest possible fitting prefix. Query and unit size do not affect this baseline.
- **Small inputs:** strictly below the configurable threshold (80 tokens by default), return the exact input. Zero fixed removal also returns the original unchanged. The threshold intentionally takes priority over aggressive removal.
- **Dropped view:** partition the original source into retained and removed spans. Expandable dropped markers are a UI aid; they are not included in copied context. The exported result records both views. Separate retained spans are joined with blank lines, whose tokens count toward the ceiling.
- **Evidence:** each preset has independently annotated exact quotes. A fact is retained only when its complete original span is covered. “Not retrieved” means the input never contained the quote; “Dropped” means compression removed at least part of it. Editing the question/focus or applying custom text disables annotations. Evidence labels are never used by the scorer.
- **RAG:** `src/fixtures.ts` retrieves top-k passages by unique query-term overlap with their title and body, ties broken by corpus order. Both lanes receive this identical retrieved input. Compression cannot recover unreturned passages.

`src/tokens.ts` bundles tokenizer ranks locally. Browser methods make no external requests for compression, tokenization, fonts or telemetry. A same-origin capabilities request checks which optional backends are configured, without exposing keys. The local server is loopback-only and rejects cross-origin model requests. It runs one backend request at a time; there is no automatic model sweep.

## Optional model/API adapters

Selecting a model displays **Not run** until the user explicitly requests a run. It does not reuse a lexical result as if it came from a model. Changing inputs requires another run; up to eight results are cached in browser memory for inspection. See [`models/README.md`](models/README.md) for the disabled local adapters, their separate dependency lockfile, resource requirements and unverified inference status.

| Method | Implementation and status |
| --- | --- |
| BGE semantic units | Independent question/unit embeddings and cosine scoring, followed by our heading-aware budget packer. Local inference disabled; mocked tests only. |
| LLMLingua-2 checkpoint | Class-1 token keep probabilities pooled per whitespace word, followed by our strict packer. Task-agnostic; local inference disabled; mocked tests only. This is our checkpoint inference adapter, not the full reference library. |
| Hosted Compresr | `latte_v2.1` REST adapter, question plus optional read focus, coarse paragraphs or fine token-level mode, fixed or API-dynamic compression. Mocked tests only; no paid calls run. |

For future authorized hosted use, export `COMPRESR_API_KEY` in the server environment, start the app, select Compresr, check the per-call paid/data-sharing consent and click **Run compression**. `.env.example` documents placeholders; `.env` files are **not automatically loaded**. Keys remain server-side. Calls have a 30-second timeout, no automatic retries and no automatic sweep. Compresr receives the source and question/focus; the API's text has no exact offsets, so the app displays its returned text without inventing a dropped-span map. Evidence checks look for complete annotated quotes in that output; paraphrases count as not retained. Its requested removal is approximate, unlike our local strict packer.

The explicit **On inference failure, return raw text** option implements fail-open behavior for runtime failures, including timeouts and malformed responses. It reports a raw fallback and zero savings. Missing configuration, disabled local models, missing paid consent and invalid options remain errors; they are not disguised as successful compression. A caller must still check whether raw input fits its downstream context window. Measured backend round trip includes local cold loading or hosted network/API time, but no answering LLM cost/latency is measured.

## Verification

From this project directory:

```bash
npm test
npm run check
npm run eval
npm run export
python3 -m unittest discover -s models -p 'test_*.py'
```

- Tests cover offsets, whitespace, Unicode, heading dependencies, code fences, strict budgets, pass-through boundaries, query/focus behavior, dynamic bounds, literal special-token input, evidence accounting and retrieval misses.
- `check` type-checks browser, core, tests and scripts.
- `eval` runs **140 deterministic fixture cases**: seven questions × four methods × five removal targets. It measures token counts and annotated evidence retention, not answer accuracy, model speed or provider cost. No remote calls occur.
- `export` type-checks, builds and copies the static app to Git-ignored `dist/`. It does not deploy anything. The static export supports browser methods only; model adapters require the local Node server. `site/build/` is also ignored. The approximately 1.1 MB JS bundle includes the offline tokenizer vocabulary.

A reproducible sweep is committed at [`results/offline.json`](results/offline.json), with interpretation in [`results/README.md`](results/README.md). To regenerate it:

```bash
node --import=tsx scripts/evaluate.ts --json > results/offline.json
```

Browser QA covers desktop and narrow/mobile layouts, MMR and word-deletion switching, disabled model gates, dropped-text expansion, retrieval misses, focus switching, dynamic budgeting, baseline control states, budget sweeps, small custom inputs and literal HTML rendering. This is manual QA; the project does not install an automated browser test runner.

Stop the server with Ctrl-C. Remove `node_modules/`, `site/build/` and `dist/` to clean generated files. No background jobs, cloud resources or paid services are provisioned.

## Important limits

This is lossy selection. Rarer matching words are not necessarily better evidence. A short lexical query can miss synonyms, and a generic task can match irrelevant passages. Headings are preserved, but other dependencies, corrections, negations and cross-document reasoning are not guaranteed. Sentence splitting is provided by the runtime's English `Intl.Segmenter`; segmentation may vary across runtime versions. Custom text is capped for an interactive lesson, not a large-document benchmark.

The evidence set is small, synthetic and manually chosen. It is not a representative benchmark or an LLM judge. We do not generate two answers, compare answer quality, run live performance/cost benchmarks, reproduce Latte/Laya internals, implement LLMLingua/LongLLMLingua entropy pruning, train a compression model, or run a multi-step autonomous agent. Backend timing is reported only when an explicit run actually occurs; none occurred in verification. A live evaluation would need the same answering model/settings in both lanes, frozen retrieved/tool evidence, expected facts, repeated runs and total cost/latency accounting. It would require explicit authorization before paid calls.

## Sources and attribution

The handbook, incidents and timeline are original synthetic fixtures written for this example. No customer documents, social posts or third-party datasets are included. No repository-wide license has been selected; dependency licenses remain their own.

- [Compresr introduction](https://compresr.ai/docs/introduction): context compression between source and answering model; inspiration for this learning experiment.
- [Compresr model parameters](https://compresr.ai/docs/api-reference/models): coarse/token-level modes, dynamic multipliers and fixed-ratio semantics. Their `0.4` means approximately 40% removed; our UI uses an explicit removal percentage. Sentence mode here is not their token-level mode.
- [Compresr SDK](https://github.com/Compresr-ai/Compresr-SDK) and [Context Gateway](https://github.com/Compresr-ai/Context-Gateway): public Apache-2.0 projects. Those client/proxy licenses do not establish an open-source release of Latte's engine or weights.
- [Compresr on-prem documentation](https://compresr.ai/docs/deployment/on-prem): separately licensed engine, delivered with weights in its container. No engine or SDK code was copied into this app.
- [LLMLingua-2 paper](https://arxiv.org/abs/2403.12968) and [code](https://github.com/microsoft/LLMLingua): task-agnostic token-classification approach behind the optional published-checkpoint adapter; training and the full library pipeline are not reproduced.
- [BGE model card](https://huggingface.co/BAAI/bge-small-en-v1.5): optional embedding adapter's pooling, normalization and query instruction.
- [MMR paper (Carbonell and Goldstein, 1998)](https://www.cs.cmu.edu/~jgc/publication/The_Use_MMR_Diversity_Based_LTMIR_1998.pdf): relevance/novelty trade-off implemented here with lexical scores and Jaccard redundancy.
- [js-tiktoken](https://github.com/dqbd/tiktoken/tree/main/js): tokenization dependency and bundled cl100k_base ranks (MIT).

Documentation reviewed on 2026-10-29. No community topic has been published yet. Add its link here after publication.
