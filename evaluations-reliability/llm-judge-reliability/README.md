# LLM-as-a-Judge: Measuring agreement, bias, and reliability

An LLM judge grades another model's answers. Teams use one when answers are free text and can't be checked with exact match. This example tests the judge itself, on two datasets:

- **Synthetic mistakes:** 80 short answers about fictional passages. Half are correct; the other half each contain one clear, written mistake.
- **RAGTruth:** 120 real answers from six LLMs to real search questions, with the unsupported parts marked by people ([RAGTruth](https://github.com/particlemedia/RAGTruth)).

The same judges run on both: Gemini `gemini-3.8-flash` with four prompts, and TypeSafe Jev `jev-1.13.0` with two, plus a third prompt for each on RAGTruth. A local dashboard lets you read every answer next to every verdict.

## What we found

Measured on 2026-09-29 and 2026-09-30. Full tables are in [`results/synthetic/report.md`](results/synthetic/report.md) and [`results/ragtruth/report.md`](results/ragtruth/report.md).

1. **Clear mistakes are a solved problem.** On the synthetic set, every Gemini prompt scored 98–99%, including the vague "Is this a good answer?". A rubric, reasoning first and worked examples made no difference. Gemini is a thinking model: even the vague prompt used about 140 output tokens per verdict, which suggests it reasons before answering anyway.
2. **Real answers are much harder.** On RAGTruth the same judges scored 53–68% against the human labels, with kappa between 0.07 and 0.37. Subtle contradictions slipped through most often. Gemini with the rubric caught 8 of 15, versus 11–14 of 15 for the other mistake types.
3. **The prompt matters only when the task is hard.** On RAGTruth, the vague prompt passed 65% of the answers people had marked as wrong; the rubric cut that to 25%. It also let "true in the real world but not in the passage" details through: Gemini caught 3 of 14 with the vague prompt and 12 of 14 with the rubric.
4. **Disagreeing with the labels isn't the same as being wrong.** We read every answer where Gemini and the RAGTruth label disagreed. In roughly two out of three settled cases, Gemini was right:
   - The label missed a real problem. For example, an answer claims "passage 3 notes nausea, dizziness and dry mouth" when passage 3 mentions no side effects.
   - Or the label flagged harmless rewording, such as "late 18th to early 20th centuries" for "late 1700s to early 1900s".

   The review is in [`data/ragtruth-review.json`](data/ragtruth-review.json). It is an AI's reading, not a second human annotation.
5. **A fast judge can be confidently wrong.** Jev is about 6× faster than Gemini (about 0.3 s versus 1.8–2 s per verdict).
   - On the synthetic set it missed 5 of 8 wrong calculations, giving two of them a pass probability of 0.99 or 1.0.
   - On RAGTruth, its wrong passes had pass probabilities up to 0.99, so no confidence threshold would catch them.
   - When its rubric matched RAGTruth's own definition of a mistake, it had the best agreement with the labels (kappa 0.37).
6. **No length bias, and small run-to-run variation.**
   - Padding answers with confident filler never turned a fail into a pass on the synthetic set. On RAGTruth it did so for 1 correct answer per judge and no wrong ones; any changes mostly went toward fail.
   - Across three identical runs, verdicts changed for 1% of synthetic answers and 6–8% of RAGTruth answers.

**Limitations:** 80 and 120 answers are small samples, so see the 95% intervals in the reports. Hold-out kappa on RAGTruth (35 answers) is too noisy to read much into. The results cover one task: short answers grounded in passages.

## Datasets

### Synthetic mistakes

[`data/cases.jsonl`](data/cases.jsonl) has 40 short passages about fictional places, products and people, each with a question and two answers, 80 in total.
- **Passages and questions:** written by Claude (Anthropic).
- **Correct answers:** written by Gemini `gemini-3.5-flash-lite` and checked against the passage by Claude. For question c12, Gemini's answer contradicted itself, so it is used as a real wrong answer and Claude wrote a correct one instead.
- **Wrong answers:** written by Claude, each with one deliberate mistake.
- **No human reviewed this set.** Treat it as a controlled test of known mistake types, not a benchmark of real errors.

The mistake types are:
  - wrong calculation (8)
  - wrong entity (8)
  - made-up answer (8)
  - incomplete (7)
  - wrong fact (4)
  - unsupported claim (4)
  - contradiction (1)

### RAGTruth

[RAGTruth](https://github.com/particlemedia/RAGTruth) (Niu et al., 2024, MIT license) holds about 18,000 answers from GPT-3.5, GPT-4, Llama-2 (7B, 13B, 70B) and Mistral-7B, with hallucinated spans marked by people.

`fetch-ragtruth` downloads the question-answering part at a pinned commit, checks the SHA-256 of each file, and builds a sample of 120 answers from 120 different questions:
- 60 clean answers, 10 per model.
- 15 answers for each of four mistake types: evident or subtle contradiction, and evident or subtle unsupported information. Each of these answers has only that one type.
- 14 of the "subtle unsupported" answers add details that are true in the real world but not in the passage.

Only the sampled IDs are committed, in [`data/ragtruth-sample.json`](data/ragtruth-sample.json). The passages come from Microsoft's [MS MARCO](https://microsoft.github.io/msmarco/), whose [terms](https://microsoft.github.io/msmarco/Notice.html) limit use to non-commercial research. The passages and answers are therefore downloaded to `data/ragtruth/`, which Git ignores, and are not redistributed here. Check those terms before any commercial use.

RAGTruth labels only unsupported or contradicting content, not completeness. On RAGTruth, the `*-faithfulness` judge variants use a rubric that matches that definition.

## Judges

The prompts are in [`judgelab/prompts.py`](judgelab/prompts.py):

| Variant | What it adds |
|---|---|
| `gemini-basic` | Nothing: a vague "Is this a good answer?" |
| `gemini-rubric` | A written rubric: correct, complete and supported by the passage |
| `gemini-reasoning` | Checks each fact and explains its reasoning before the verdict |
| `gemini-examples` | Three worked examples, written for this project |
| `gemini-faithfulness` | RAGTruth only: fail only for unsupported or contradicting content |
| `jev-basic`, `jev-rubric`, `jev-faithfulness` | The same ideas as TypeSafe Jev choice questions, which return pass/fail probabilities instead of written reasoning |

**Length bias test:** every answer gets the same confident prefix and suffix. They add no facts, so any change in verdict comes from length and tone alone.

## Setup

Requirements: Python 3.12 or later, [uv](https://docs.astral.sh/uv/), and a Gemini API key and a TypeSafe API key for live runs.

From the repository root:

```sh
cd evaluations-reliability/llm-judge-reliability
uv sync --locked
cp .env.example .env                       # add GEMINI_API_KEY and TYPESAFE_API_KEY
uv run pytest                              # offline; no API calls
uv run python -m judgelab fetch-ragtruth   # downloads about 36 MB and builds the sample
```

## Running it

Judge commands only make paid calls with `--live`. Without it, they print the calls they would make. Add `--dataset ragtruth` to use RAGTruth; the default is `synthetic`.

```sh
uv run python -m judgelab plan --dataset ragtruth            # every call (1,680 on RAGTruth, 960 on synthetic)
uv run python -m judgelab run-all --dataset ragtruth --live  # run all judges
uv run python -m judgelab analyze --dataset ragtruth         # write results/ragtruth/report.md and report.json
uv run python -m judgelab serve                              # dashboard at http://127.0.0.1:8765
```

For a quick cost check before a full run: `uv run python -m judgelab judge --dataset ragtruth --variant gemini-rubric --limit 10 --live`.

Runs resume where they stopped: finished calls are skipped, and failed calls are retried next time. Requests use a timeout, bounded retries on HTTP 429, 5xx and gateway errors, and at most `MAX_WORKERS` parallel calls.

`serve` opens two pages at http://127.0.0.1:8765:

- **Report:** the write-up of the experiment. It has key takeaways, what LLM-as-a-judge is and why to test it, the method (datasets, mistake types, judges with their exact prompts, measures), results with numbered figures and tables, five worked examples, discussion, limitations, practical advice and reproduction steps. Every number is computed from the recorded runs.
- **Dataset explorer:** every answer in both datasets. Each one shows the full source text, the question, the answer with the human-marked mistake highlighted, the correct verdict and why, the correct answer for synthetic mistakes, the review note where one exists, and every judge's verdict with its reasoning or probability. You can filter by verdict, mistake type, judge disagreement or review status, or search, and link to any answer with `#explorer/<dataset>/<id>`.

## Configuration and cost

See [`.env.example`](.env.example). The defaults are `gemini-3.8-flash` (from the Gemini models page, checked 2026-09-29) and `jev-latest`, which resolved to `jev-1.13.0` in our runs. Gemini runs at temperature 0.

**Measured token use per call:**

| Judge | Synthetic set | RAGTruth |
|---|---|---|
| Gemini | about 210 input and 150 output | about 570 input and 240 output |
| Jev | about 500 input and 32 output | about 860 input and 32 output |

Output tokens include Gemini's thinking. Our full RAGTruth run (1,680 calls) used 1.21 million input and 0.39 million output tokens; the synthetic run (960 calls) used 0.33 million and 0.11 million. Set the `*_USD_PER_MILLION` rates in `.env` to current prices, and the report will show the cost.

## Outputs

| Path | Contents | In Git |
|---|---|---|
| `runs/<dataset>/judgments/<variant>/<input>-r<n>.jsonl` | Every judge call, including failed ones that were retried | No |
| `results/<dataset>/verdicts.jsonl` | The latest successful verdict for every judge call: verdict, probability, reasoning, tokens and time. `analyze` writes it from `runs/`, and the app uses it when `runs/` is absent, so the report and explorer work without re-running the judges. | Yes |
| `results/<dataset>/report.md`, `report.json` | Aggregate results | Yes |
| `data/ragtruth/` | Downloaded RAGTruth files and the built sample (MS MARCO text) | No |
| `data/ragtruth-sample.json`, `data/ragtruth-review.json` | Sample IDs and the review of disagreements | Yes |

The RAGTruth verdicts include Gemini's reasoning, which sometimes quotes short phrases from the MS MARCO passages it was judging.

## Sources

- Niu et al., [RAGTruth: A Hallucination Corpus for Developing Trustworthy Retrieval-Augmented Language Models](https://arxiv.org/abs/2401.00396) (ACL 2024). Code and data are MIT-licensed.
- Nguyen et al., MS MARCO (2016). See the [MS MARCO terms](https://microsoft.github.io/msmarco/Notice.html).
- Zheng et al., [Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena](https://arxiv.org/abs/2306.05685) (2023).
- Cohen, J. (1960). A coefficient of agreement for nominal scales. *Educational and Psychological Measurement*, 20(1).
- [Gemini API models](https://ai.google.dev/gemini-api/docs/models) and the [TypeSafe choice primitive](https://docs.typesafe.ai/primitives/choice).

The synthetic passages, questions and written answers were created for this repository.

Community discussion: not yet posted.
