# LLM judge results

120 answers: 60 correct, 60 with a known mistake.

## Agreement with the known verdicts (repeat 1)

| Judge | n | Accuracy (95% CI) | Kappa (95% CI) | False pass | False fail | Dev kappa | Hold-out kappa |
|---|---|---|---|---|---|---|---|
| gemini-basic | 120 | 54% (45–63%) | 0.08 (-0.07 to 0.24) | 39/60 (65%) | 16/60 (27%) | 0.20 | -0.20 |
| gemini-rubric | 120 | 63% (54–71%) | 0.27 (0.10 to 0.43) | 15/60 (25%) | 29/60 (48%) | 0.35 | -0.10 |
| gemini-reasoning | 120 | 60% (51–68%) | 0.20 (0.03 to 0.37) | 17/60 (28%) | 31/60 (52%) | 0.26 | -0.10 |
| gemini-examples | 120 | 62% (53–70%) | 0.23 (0.07 to 0.39) | 15/60 (25%) | 31/60 (52%) | 0.28 | -0.06 |
| gemini-faithfulness | 120 | 61% (52–69%) | 0.22 (0.04 to 0.38) | 21/60 (35%) | 26/60 (43%) | 0.20 | 0.16 |
| jev-basic | 120 | 53% (44–62%) | 0.07 (-0.10 to 0.23) | 39/60 (65%) | 17/60 (28%) | 0.18 | -0.20 |
| jev-rubric | 120 | 61% (52–69%) | 0.22 (0.04 to 0.37) | 21/60 (35%) | 26/60 (43%) | 0.30 | -0.06 |
| jev-faithfulness | 120 | 68% (60–76%) | 0.37 (0.22 to 0.52) | 28/60 (47%) | 10/60 (17%) | 0.46 | 0.12 |

False pass: the judge passed an answer with a mistake. False fail: it failed a correct answer.

## Mistakes caught, by type

| Judge | evident_baseless | evident_conflict | subtle_baseless | subtle_conflict |
|---|---|---|---|---|
| gemini-basic | 6/15 | 7/15 | 3/15 | 5/15 |
| gemini-rubric | 14/15 | 11/15 | 12/15 | 8/15 |
| gemini-reasoning | 13/15 | 10/15 | 13/15 | 7/15 |
| gemini-examples | 13/15 | 12/15 | 13/15 | 7/15 |
| gemini-faithfulness | 14/15 | 10/15 | 10/15 | 5/15 |
| jev-basic | 5/15 | 9/15 | 1/15 | 6/15 |
| jev-rubric | 12/15 | 11/15 | 9/15 | 7/15 |
| jev-faithfulness | 12/15 | 7/15 | 8/15 | 5/15 |

## When the judge and the label disagree

Disagreements reviewed by reading each answer against its passages (see data/ragtruth-review.json).

| Judge | Disagreements | Reviewed | Judge right | Label right | Debatable |
|---|---|---|---|---|---|
| gemini-basic | 55 | 26 | 13 | 11 | 2 |
| gemini-rubric | 44 | 36 | 23 | 9 | 4 |
| gemini-reasoning | 48 | 40 | 25 | 11 | 4 |
| gemini-examples | 46 | 38 | 24 | 10 | 4 |
| gemini-faithfulness | 47 | 40 | 25 | 11 | 4 |
| jev-basic | 56 | 26 | 15 | 10 | 1 |
| jev-rubric | 47 | 32 | 19 | 10 | 3 |
| jev-faithfulness | 38 | 25 | 13 | 11 | 1 |

## Unsupported but true in the real world

Answers whose only mistake is a detail that is true in the real world but not in the passage.

| Judge | Caught | Missed |
|---|---|---|
| gemini-basic | 3/14 (21%) | rt12152, rt12994, rt13654, rt13656, rt13949, rt15109, rt15351, rt15663, rt16225, rt16253, rt16680 |
| gemini-rubric | 12/14 (86%) | rt13949, rt16225 |
| gemini-reasoning | 13/14 (93%) | rt13949 |
| gemini-examples | 13/14 (93%) | rt13949 |
| gemini-faithfulness | 10/14 (71%) | rt13656, rt13949, rt15109, rt16225 |
| jev-basic | 1/14 (7%) | rt12152, rt12994, rt13621, rt13654, rt13656, rt13949, rt15109, rt15351, rt15663, rt16225, rt16253, rt16680, rt16898 |
| jev-rubric | 9/14 (64%) | rt13621, rt13656, rt13949, rt16225, rt16680 |
| jev-faithfulness | 8/14 (57%) | rt13621, rt13656, rt13949, rt15109, rt16225, rt16680 |

## Run-to-run reliability

| Judge | Repeats | Answers | Changed verdict (95% CI) | Answers |
|---|---|---|---|---|
| gemini-rubric | 3 | 120 | 8% (5–15%) | rt12805, rt12942, rt13004, rt13066, rt13407, rt13414, rt14101, rt16225, rt16620, rt16884 |
| jev-rubric | 3 | 120 | 6% (3–12%) | rt12122, rt13004, rt13223, rt13656, rt16414, rt16436, rt16918 |

## Length bias (same answer, padded)

| Judge | Answer is | n | Pass rate original | Pass rate padded | Flipped to pass | Flipped to fail |
|---|---|---|---|---|---|---|
| gemini-rubric | correct | 60 | 52% | 47% | rt14772 | rt12474, rt12871, rt13004, rt13407 |
| gemini-rubric | wrong | 60 | 25% | 20% | – | rt12942, rt16225, rt16884 |
| jev-rubric | correct | 60 | 57% | 57% | rt13004 | rt12199 |
| jev-rubric | wrong | 60 | 35% | 30% | – | rt13621, rt16414, rt16620 |

## Jev pass probability

- jev-basic: mean p(pass) 0.69 on correct answers, 0.58 on wrong ones
- jev-rubric: mean p(pass) 0.60 on correct answers, 0.33 on wrong ones
- jev-faithfulness: mean p(pass) 0.75 on correct answers, 0.47 on wrong ones

## Usage (repeat 1)

| Judge | Models | Calls | Median ms | Input tokens | Output tokens | USD |
|---|---|---|---|---|---|---|
| gemini-basic | gemini-3.8-flash | 120 | 1914 | 60901 | 27144 | rates not set |
| gemini-rubric | gemini-3.8-flash | 120 | 2184 | 70141 | 45655 | rates not set |
| gemini-reasoning | gemini-3.8-flash | 120 | 2551 | 71821 | 54420 | rates not set |
| gemini-examples | gemini-3.8-flash | 120 | 2681 | 98101 | 53739 | rates not set |
| gemini-faithfulness | gemini-3.8-flash | 120 | 2127 | 69061 | 49316 | rates not set |
| jev-basic | jev-1.13.0 | 120 | 301 | 96160 | 3840 | rates not set |
| jev-rubric | jev-1.13.0 | 120 | 306 | 104680 | 3840 | rates not set |
| jev-faithfulness | jev-1.13.0 | 120 | 304 | 101920 | 3840 | rates not set |
