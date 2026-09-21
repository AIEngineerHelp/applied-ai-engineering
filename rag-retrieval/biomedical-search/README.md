# Helix — Biomedical hybrid search

A biomedical RAG example for comparing lexical search, dense retrieval, and hybrid fusion, then inspecting the evidence behind generated answers.
The local UI supports BM25, neural dense retrieval, hybrid fusion, bounded query expansion,
evidence selection, grounded answers, inline passage citations, and an explicit insufficient-evidence state.
The same pipeline powers a reproducible five-configuration benchmark on 100 fixed questions.

## Run locally

Requirements: Python 3.12 or 3.13, [uv](https://docs.astral.sh/uv/), and a Google Gemini API key.

Copy `.env.example` to `.env` and set `GEMINI_API_KEY` there. The key stays on the server and `.env` is ignored by Git.

From the repository root:

```sh
cd rag-retrieval/biomedical-search
cp .env.example .env
uv sync --locked --extra prepare
uv run python -m scripts.prepare --rebuild
uv run uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Open [localhost:8000](http://localhost:8000). Gemini generates cited answers and evaluates them using
`gemini-2.5-flash`; `gemini-embedding-001` provides normalized 768-dimensional document/query embeddings.
No local neural model starts under the default configuration. API calls may incur charges and are subject to the key's quota.
The app retains lexical search while an older local embedding index awaits the Gemini rebuild.
Dense, hybrid, and best-run searches become available after a matching index is prepared and the app restarts.
The evaluation artifacts record the model and index used by each run; historical BGE/Ollama results do not measure the Gemini pipeline.

Choose up to five retrieved passages, then regenerate the answer to control its evidence.
Click a citation to inspect its passage, or expand “Inspect exact context” to see the full LLM input.
Preparation downloads the dataset (~25 MB), batches remote embedding calls, and checkpoints progress.
Rerunning an interrupted build resumes with the same model/backend. Model and index files stay out of source control.
Set optional token prices in `.env` to estimate generation costs; unknown API costs are reported as unknown.

## Dataset and identity

Source: [rag-datasets/rag-mini-bioasq](https://huggingface.co/datasets/rag-datasets/rag-mini-bioasq),
derived from BioASQ biomedical questions and PubMed passages; license **CC BY 2.5**.
Use and attribute the source dataset accordingly. Dataset files are downloaded from Hugging Face's
Parquet conversion URLs. Raw-file and cleaned-corpus SHA-256 hashes are recorded in the index manifest.

The supplied version has 40,221 passage rows and 4,719 question rows. Missing/`nan` texts are excluded,
and their IDs are recorded in the manifest. Original passage IDs (PMIDs) remain unchanged. Duplicate
text under different PMIDs is retained to preserve relevance labels. PubMed record links use the original
PMID; the linked record can change independently of the downloaded abstract.

The frozen [100-query evaluation set](experiments/queries-100.jsonl) uses seed 42 and roughly equal
numbers of heuristic yes/no, definition, list, treatment, mechanism, and effect questions.
Only questions whose full gold passage set exists in the usable corpus are eligible. This avoids
measuring retrieval against nonexistent text but biases coverage toward fully available questions.
Preparation never replaces an existing fixed evaluation set.

## Main design choices

| Concern | Choice and reason |
|---|---|
| Storage | Local JSONL and memory-mapped NumPy vectors: reproducible, inspectable, no database service needed at this corpus size. |
| Lexical index | SciPy sparse BM25 matrix, k1=1.5 and b=0.75. English stop words, case folding, and a tokenizer retaining gene symbols and hyphenated terms. |
| Embeddings | `gemini-embedding-001`, remote normalized 768-dimensional vectors with distinct retrieval document/query task types. |
| Dense similarity | Exact cosine scoring over the memory-mapped normalized vectors. No approximate index or separate vector database is necessary for ~28,000 usable passages. |
| Fusion | Weighted reciprocal rank fusion, top 50 candidates per signal/query; comparable across BM25 and cosine score scales. |
| Expansion | Gemini generates up to two distinct biomedical rephrasings using a fixed prompt. Retains and prioritizes the original question; the LLM receives no gold answers or relevance labels. Adds API latency and cost; generated queries and usage are logged. |
| Final answer | Default `gemini-2.5-flash` through the Google Gemini API at temperature 0. A stronger model can be configured. Structured claims use only five selected 1,800-character excerpts. |
| Citations | `validate_answer` in `app/llm.py` enforces that every claim cites actual selected IDs. The server, rather than the LLM, controls rendered citation links. |
| Judge | Fixed equivalent evaluation rubric for correctness, groundedness, and context relevance. Same prompt/model/settings for every variant; judge explanations and errors are logged. |

The [system-design diagram](docs/system-design.md) covers offline preparation, online retrieval,
the evidence and answer UI, citation enforcement, and the experiment path. The diagram remains in the repository for review.

## Evaluation

**Included results:** the latest completed retrieval evaluation uses `gemini-embedding-001` and covers 100 fixed queries across five configurations. Dense search achieved Recall@10 of 0.810 and nDCG@10 of 0.746; plain hybrid achieved 0.794 and 0.743. Query expansion increased latency without improving nDCG@10 over plain hybrid in this run. Answer generation and judge evaluation were not run, so these scores measure retrieval only. The earlier BGE/local-model baseline is preserved in its own run directory; its measurements should not be mixed with the Gemini results. Incomplete runs and live search logs remain excluded.

Run the complete retrieval benchmark first:

```sh
uv run python -m scripts.evaluate
```

Generate answers and run the LLM judge for **all 100 queries in every configuration**:

```sh
uv run python -m scripts.evaluate --answers
```

For an explicitly labeled smoke subset (retrieval still runs on all 100 queries):

```sh
uv run python -m scripts.evaluate --answers --judge-limit 3
```

Full remote LLM evaluation makes up to 1,000 answer/judge model calls, plus expansion and query-embedding calls, and can take significant time and incur API charges.
Content-addressed answer/judge caches permit resumption and share truly identical inputs across
variants. Unrun scores stay pending; coverage and errors are recorded in the run files and report.

The five configurations are lexical, dense, hybrid, hybrid + expansion, and a weighted hybrid candidate.
The weighted candidate emphasizes exact biomedical terms (lexical weight 0.65), sharper rank positions
(RRF k=20), and conservative expansion contribution (0.35). These settings are specified before the run.
The best *measured* hybrid is selected by nDCG@10, with Recall@10 as the tie-breaker; the UI's “Best run”
mode loads it. The strongest candidate is not presumed to win.

Metrics: macro Recall@5, Recall@10, MRR@10, binary-relevance nDCG@10, mean and p95 retrieval latency,
answer latency, token usage, API cost, citation validity, and judge correctness/groundedness/context relevance.
The report identifies the overall winner as well as the best hybrid and includes successful searches,
failure cases, and a disagreement queue. Judge/retrieval disagreements still require manual review.
A separately inspected historical [preflight example](docs/manual-review.md) documents a local-judge
explanation that overstated citation support.

Outputs:

- `experiments/queries-100.jsonl`: the exact fixed query IDs, categories, reference answers, and gold IDs.
- `experiments/runs/<run-id>/*.jsonl`: per-query retrieval scores/IDs, configurations, answers, and judge results.
- `experiments/summary.json`: measured comparison data displayed in the Evaluation UI.
- `experiments/best-config.json`: the selected hybrid configuration and selection criterion.
- `experiments/report.md`: concise report and comparison table.
- `experiments/searches.jsonl`: live UI search and answer events.

Gemini embeddings and query expansion may incur API charges. Exact retrieval costs remain unavailable unless all relevant rates are configured; hardware and energy are excluded.
Generation costs remain unavailable until input/output prices are explicitly configured.
Cached model usage records represent original inference cost/latency, not fresh charges from reading caches.
Comparison results are used to select the winner; they are not an independent held-out estimate.

## Alternative answer/judge provider

Copy `.env.example` to `.env`. To use an OpenAI-compatible provider, set `LLM_PROVIDER=openai-compatible`,
`LLM_BASE_URL`, `LLM_API_KEY`, `ANSWER_MODEL`, and `JUDGE_MODEL`. The service must support JSON output
via `/chat/completions`. Set `INPUT_USD_PER_MILLION` and `OUTPUT_USD_PER_MILLION` for cost estimates.
Keep secrets in `.env`; they are never sent to the browser. Restart the app after configuration changes.
Changing `EMBEDDING_MODEL` requires rebuilding the corpus index.

## Checks and API

```sh
uv run pytest
uv run ruff check app scripts tests
```

Tests cover hand-calculated retrieval metrics, tied and zero-hit ranking, weighted fusion,
safe relevance-ID parsing, bounded expansions/context, citation rejection, abstention structure,
and API rejection of context injection. Interactive API documentation is available at `/docs`.

- `GET /api/status`: readiness, corpus manifest, configured model availability.
- `GET /api/questions`: sample questions, with no gold data.
- `POST /api/search`: query, mode, expansion switch, top-k; returns evidence and a search ID.
- `POST /api/answer`: search ID and up to five distinct retrieved passage IDs.
- `GET /api/experiments`: measured benchmark summary.
- `GET /api/experiments/report`: downloadable evaluation report.

Live searches are retained in memory for the latest 100 searches; older answer requests need a new search.
On Vercel, signed search tokens allow answer requests across instances and expire after one hour.
This is an educational research demo, not a production medical service. It is not medical advice.
Citation ID validity alone does not guarantee that a claim follows from its source; inspect evidence
and judge explanations. The model may abstain, miss nuance, or produce unsupported statements
despite valid IDs. The final answer never reads dataset reference answers or gold passage labels.

## Local files and cleanup

Downloaded passages, indexes, embedding checkpoints, caches, and live search logs stay local and are Git-ignored. To reclaim disk space, remove `data/raw/`, `data/index/`, generated `data/*.jsonl`, and `.venv/`; rebuilding the index can incur embedding charges again. Keep `.env` private. Never submit patient records or other confidential information through this educational example.

The included evaluation questions and reference answers are a sampled, categorized subset of the source dataset. Attribution: [RAG Datasets — rag-mini-bioasq](https://huggingface.co/datasets/rag-datasets/rag-mini-bioasq), derived from BioASQ/PubMed, under [CC BY 2.5](https://creativecommons.org/licenses/by/2.5/). This dataset license does not assign a license to the application code; the repository has not selected a code license.

## Deploy to Vercel

Prepare the Gemini index locally once using the setup above. Deploy from this example's directory
with `vercel deploy --prod`. The `.vercelignore` includes the prepared `data/passages.jsonl` and
`data/index/` in the deployment while excluding credentials, raw downloads, and local logs. These
artifacts remain Git-ignored; a Git-only deployment needs a separate index preparation step.
Set `GEMINI_API_KEY` and a random `SEARCH_SIGNING_SECRET` of at least 32 bytes in Vercel's environment
settings. The defaults use Gemini for embeddings and generation. No embedding rebuild runs at deploy time.

Search tokens preserve the retrieved evidence for one hour without requiring instance-local memory.
Production events go to Vercel runtime logs rather than a filesystem history; log retention follows
the hosting plan. This deployment has no persistent user history. The public demo uses the configured
provider account and its quota. Cold starts include loading the prepared index.

Dataset preparation dependencies are installed with `uv sync --extra prepare`. For optional local
neural backends, also add `--extra local`. These packages are excluded from the default hosted runtime.
