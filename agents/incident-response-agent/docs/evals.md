# Evaluating the agent

How we measure whether the agent finds the right root cause, how to run the eval locally,
and how to read the results. This page is also shown in the UI's **Evals** tab.

## In short

The eval is **an exam where we already know the answers.**

1. **Questions:** real logs from a supercomputer (BGL), where experts labelled which machines
   broke and why. Those labels are the answer key.
2. **Exam:** for each broken machine, the agent gets a short alert ("Machine X reported
   errors"), reads the logs and answers what went wrong and where. It never sees the answer key.
3. **Marking:** plain code, no AI. The agent must answer with one word from a fixed list
   (e.g. `network-loss`, `storage`, `kernel`), so we check whether its word is one the answer
   key accepts, and whether it named the machine from the alert.
4. **Pass mark:** 70%. A lazy guess (always the most common answer) scores about 71%, so the
   agent must clearly beat that to be useful.
5. **No cheating:** we also test on machines that were never used while improving the agent.

## What we measure

**Question:** given an alert about one machine, does the agent identify *what failed*
(fault type) and *where* (the alerted node) from the logs alone?

We use **Loghub BGL**, the only 2k sample dataset that ships ground-truth anomaly labels.
BGL is the Blue Gene/L supercomputer; every anomalous log line carries an alert label such
as `KERNDTLB` (data TLB error), `KERNMNTF` (Lustre mount failed) or `APPSEV` (I/O daemon link
severed). 143 of the 2,000 lines are anomalous, spread over 84 nodes and 12 labels.

## How a case is built

1. **One case per node** with anomalous lines (84 cases). The ground truth is the label of that
   node's first anomalous line.
2. The agent receives a realistic, minimal alert: title `Node R02-M1-N0-C:J12-U11 reported
   errors`, labels `dataset=BGL`, `node=<id>`, `alertname=NodeError`. Nothing else.
3. The agent then runs exactly as in production: plan → read logs with `log_explorer` →
   analyse → propose → report. Runs that reach a human-approval step simply stop there; only
   the hypotheses are scored.
4. **No answer leakage:** the `Label` column is stripped before any tool output reaches the
   agent, and log text is PII-scrubbed exactly as in production.

Cases are **stratified by label** (round-robin), so rare failures such as `APPCHILD` are
tested and the score isn't dominated by the most common label.

## How it is scored

Each BGL label is mapped to our fault taxonomy in `evals/loghub/taxonomy.yaml`, with a
`primary` type and a list of `accepted` types, because several labels are genuinely
ambiguous (a data TLB interrupt is reasonably "kernel", "hardware" or "memory").

| Metric | Definition |
|---|---|
| **Fault type, top-1 (lenient)** | The top hypothesis' fault type is one of the label's `accepted` types. **Headline metric**; target ≥ 70%. |
| Fault type, top-1 (strict) | The top hypothesis equals the label's single `primary` type. |
| Fault type, top-3 (lenient) | Any of the top three hypotheses is accepted. |
| Node localisation, top-1 | The top hypothesis' component contains the alerted node id or its node-card location. The alert names the node, so this measures whether the agent *stays on* the right node, not whether it can find it. |
| Precision when confident | Lenient accuracy over hypotheses with confidence ≥ 0.6 (the replan threshold). |
| Mean confidence, correct / wrong | Calibration: wrong answers should carry clearly lower confidence than right ones. |
| Majority-class baseline | Always answer the most common fault type in the sample. The agent must beat it to be useful. |

A run that errors or produces no hypothesis counts as a miss.

## Running it locally

Requirements: the Python environment (`uv sync --extra dev`) and `GEMINI_API_KEY` in `.env`.
No Docker, database or Redis is needed; the eval runs the agent graph in-process.

```bash
# Standard run: 28 stratified cases (~8 min, ~$1.60 with the default Gemini models)
uv run python -m evals.loghub.evaluate --n 28 --seed 7

# Hold-out run: 28 different cases, excluding the seed-7 sample.
# Use this after changing prompts, to check the gain generalises beyond the cases you tuned on.
uv run python -m evals.loghub.evaluate --n 28 --seed 21 --exclude-seed 7

# Quick smoke test before spending on a full run (~$0.05)
uv run python -m evals.loghub.evaluate --n 1
```

| Flag | Meaning |
|---|---|
| `--n` | Number of cases (max 84). |
| `--seed` | Sampling seed. Same seed = same cases, so runs are comparable. |
| `--exclude-seed` | Drop the cases another seed's sample used (hold-out evaluation). |
| `--concurrency` | Parallel runs (default 4; lower it if you hit provider rate limits). |

Each run writes `evals/results/bgl-<timestamp>-seed<N>.json` (all metrics and every case)
and a matching `.md` report. The Evals tab lists every JSON file in that folder.

To label a run in the UI (e.g. "before scope fix"), add it to `evals/results/runs.yaml`:

```yaml
bgl-2026-09-24T15-04-35Z:
  label: Baseline
  notes: First run after fixing the eval harness.
```

## Workflow for changing the agent

1. Run the standard eval (`--seed 7`) to get the current numbers.
2. Change prompts or code. Look at the misses first: open the run in the Evals tab and read
   the hypothesis descriptions of the ✗ cases.
3. Re-run `--seed 7` to compare like for like.
4. Run the hold-out (`--seed 21 --exclude-seed 7`). Only trust a gain that shows up on both.
5. Annotate both runs in `runs.yaml` and commit the result files with the change.

## Limitations

- **One dataset.** Only BGL has labels in the 2k samples. Results describe HPC hardware and
  kernel failures, not web services or databases.
- **Small samples.** 28 cases gives roughly ±13 percentage points of uncertainty; don't
  chase differences of one or two cases.
- **Ground truth is one label per node** (its first anomalous line), and the label-to-fault
  mapping is our judgement. Both are documented in `evals/loghub/taxonomy.yaml`.
- **The model is not deterministic.** Re-running the same seed can move scores by a few
  points.
