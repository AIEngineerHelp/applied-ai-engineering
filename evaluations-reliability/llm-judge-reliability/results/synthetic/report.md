# LLM judge results

80 answers: 40 correct, 40 with a known mistake.

## Agreement with the known verdicts (repeat 1)

| Judge | n | Accuracy (95% CI) | Kappa (95% CI) | False pass | False fail | Dev kappa | Hold-out kappa |
|---|---|---|---|---|---|---|---|
| gemini-basic | 80 | 99% (93–100%) | 0.98 (0.92 to 1.00) | 1/40 (2%) | 0/40 (0%) | 0.96 | 1.00 |
| gemini-rubric | 80 | 98% (91–99%) | 0.95 (0.87 to 1.00) | 1/40 (2%) | 1/40 (2%) | 0.93 | 1.00 |
| gemini-reasoning | 80 | 99% (93–100%) | 0.98 (0.92 to 1.00) | 0/40 (0%) | 1/40 (2%) | 0.96 | 1.00 |
| gemini-examples | 80 | 99% (93–100%) | 0.98 (0.92 to 1.00) | 0/40 (0%) | 1/40 (2%) | 0.96 | 1.00 |
| jev-basic | 80 | 91% (83–96%) | 0.82 (0.69 to 0.95) | 7/40 (18%) | 0/40 (0%) | 0.81 | 0.85 |
| jev-rubric | 80 | 94% (86–97%) | 0.88 (0.77 to 0.97) | 5/40 (12%) | 0/40 (0%) | 0.89 | 0.85 |

False pass: the judge passed an answer with a mistake. False fail: it failed a correct answer.

## Mistakes caught, by type

| Judge | contradiction | incomplete | made_up_answer | unsupported_claim | wrong_calculation | wrong_entity | wrong_fact |
|---|---|---|---|---|---|---|---|
| gemini-basic | 1/1 | 6/7 | 8/8 | 4/4 | 8/8 | 8/8 | 4/4 |
| gemini-rubric | 1/1 | 6/7 | 8/8 | 4/4 | 8/8 | 8/8 | 4/4 |
| gemini-reasoning | 1/1 | 7/7 | 8/8 | 4/4 | 8/8 | 8/8 | 4/4 |
| gemini-examples | 1/1 | 7/7 | 8/8 | 4/4 | 8/8 | 8/8 | 4/4 |
| jev-basic | 1/1 | 6/7 | 8/8 | 3/4 | 3/8 | 8/8 | 4/4 |
| jev-rubric | 1/1 | 7/7 | 8/8 | 4/4 | 3/8 | 8/8 | 4/4 |

## Run-to-run reliability

| Judge | Repeats | Answers | Changed verdict (95% CI) | Answers |
|---|---|---|---|---|
| gemini-rubric | 3 | 80 | 1% (0–7%) | c17-b |
| jev-rubric | 3 | 80 | 1% (0–7%) | c38-b |

## Length bias (same answer, padded)

| Judge | Answer is | n | Pass rate original | Pass rate padded | Flipped to pass | Flipped to fail |
|---|---|---|---|---|---|---|
| gemini-rubric | correct | 40 | 98% | 98% | – | – |
| gemini-rubric | wrong | 40 | 2% | 0% | – | c17-b |
| jev-rubric | correct | 40 | 100% | 100% | – | – |
| jev-rubric | wrong | 40 | 12% | 10% | – | c38-b |

## Jev pass probability

- jev-basic: mean p(pass) 1.00 on correct answers, 0.18 on wrong ones
- jev-rubric: mean p(pass) 0.99 on correct answers, 0.12 on wrong ones

## Usage (repeat 1)

| Judge | Models | Calls | Median ms | Input tokens | Output tokens | USD |
|---|---|---|---|---|---|---|
| gemini-basic | gemini-3.8-flash | 80 | 1759 | 10864 | 11392 | rates not set |
| gemini-rubric | gemini-3.8-flash | 80 | 1842 | 17024 | 12528 | rates not set |
| gemini-reasoning | gemini-3.8-flash | 80 | 1708 | 18144 | 17414 | rates not set |
| gemini-examples | gemini-3.8-flash | 80 | 1807 | 35664 | 16610 | rates not set |
| jev-basic | jev-1.13.0 | 80 | 301 | 34115 | 2560 | rates not set |
| jev-rubric | jev-1.13.0 | 80 | 301 | 39795 | 2560 | rates not set |
