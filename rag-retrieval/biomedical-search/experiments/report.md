# Biomedical hybrid search evaluation

> Historical BGE/local-pipeline baseline. These results do not evaluate the current Gemini defaults. Answer and judge evaluation was not run for this comparison.

Run: 20260918T025423Z

Dataset: `rag-datasets/rag-mini-bioasq`. 28,001 indexed passages. The same 100 fixed query IDs were used for all five configurations.

## Comparison

| Configuration | Recall@5 | Recall@10 | MRR@10 | nDCG@10 | Mean ms | p95 ms | Judge n | Correctness | Groundedness | Context relevance |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| lexical | 0.639 | 0.723 | 0.667 | 0.648 | 3.4 | 4.4 | 0 | pending | pending | pending |
| dense | 0.605 | 0.653 | 0.645 | 0.596 | 10.7 | 14.2 | 0 | pending | pending | pending |
| hybrid | 0.642 | 0.714 | 0.722 | 0.667 | 14.4 | 19.4 | 0 | pending | pending | pending |
| hybrid_expanded | 0.656 | 0.717 | 0.734 | 0.682 | 19.9 | 26.3 | 0 | pending | pending | pending |
| hybrid_weighted | 0.658 | 0.734 | 0.725 | 0.687 | 20.1 | 27.3 | 0 | pending | pending | pending |

## Selected configuration

**hybrid_weighted** is the best hybrid by nDCG@10 (0.687); Recall@10 breaks ties. Selection uses retrieval relevance labels, not LLM-judge scores.

The result is consistent with stronger exact-term matching and more conservative expansion contributions (an interpretation, not an isolated causal finding). Separate ablations would be needed to attribute the gain to each weight or RRF setting.

Its mean retrieval latency is 20.1 ms, compared with 3.4 ms for lexical retrieval. All retrieval runs incur $0 in API charges because both indexes and embeddings run locally. Hardware and energy are excluded.

The overall retrieval winner is **hybrid_weighted**. Hybrid fusion is an empirical choice; it is not assumed to beat lexical retrieval.

## Method and limitations

- The 100-query set is seeded (42) and approximately balanced by rule-based question categories. Only questions whose entire gold passage set survives missing-text filtering are eligible.
- Configurations were specified before measurement. This is a comparison set used for selection, not an independent held-out estimate after selecting the winner.
- BM25 uses k1=1.5, b=0.75, English stop words, and retains gene symbols and hyphenated terms. Neural embeddings use BAAI/bge-small-en-v1.5 (384 dimensions, 512-token truncation).
- Hybrid uses weighted reciprocal rank fusion over the top 50 from each signal/query. The expanded baseline weights original queries at 1.0 and expansions at 0.6; the weighted candidate uses lexical weight 0.65, RRF k=20, and expansion weight 0.35.
- Latency includes expansion, query embedding, scoring, and fusion; it excludes initial model/index load. Queries are not embedding-cached between variants. Local CPU load may affect timings.
- Answer generation uses at most five selected passages, truncated to 1,800 characters each. The UI displays the exact selected context. Citation validation checks IDs and answer structure, not entailment; the judge separately assesses support.
- Answer model: `qwen2.5:3b`. Judge model: `qwen2.5:3b`. Both use temperature 0; local runs use seed 42. Judge prompt and settings are fixed across variants.
- LLM evaluation uses an equivalent fixed-rubric judge with correctness, groundedness, and context relevance scored in [0,1]. A small local judge is a useful diagnostic, not a validated medical authority. Shared answer/judge models can have correlated errors.
- Judge coverage: 0 of 100 queries per variant requested. Pending cells indicate unrun evaluation, never estimated scores. Errors are logged per query.
- A separately inspected preflight example is documented in `docs/manual-review.md`; it exposed an overgenerous judge explanation despite valid citation IDs.

## Successful searches and failure cases

### Successes

- Query 3541: How does LB-100 affect the DDR proteins (BRCA1, Chk2, and γH2AX)?
  nDCG@10=1.000; Recall@10=1.000; retrieved IDs: 25376608, 29426838, 22704343, 22979979, 18812180, 25483082, 23729402, 15254397, 20080130, 12354784.
- Query 2704: Which miRNA is associated with the circular RNA ciRS-7?
  nDCG@10=1.000; Recall@10=1.000; retrieved IDs: 28253710, 26649774, 24339831, 28265491, 33614648, 34269929, 34238421, 28634583, 26874353, 27929395.
- Query 4626: What pathological phenotype could potentially concomitant pomegranate juice and rosuvastatin use cause?
  nDCG@10=1.000; Recall@10=1.000; retrieved IDs: 16923466, 18158835, 24788803, 23409830, 17042673, 24392102, 21440024, 28751258, 19801853, 21267417.

### Failures

- Query 3751: Which TREX mRNA export complex subunits have been implicated in neurodevelopmental disorders?
  nDCG@10=0.000; Recall@10=0.000; retrieved IDs: 30194269, 23599000, 24705649, 15358174, 15870275, 20230609, 21301339, 10518583, 21057455, 11684705.
- Query 3173: Can prevnar 13 be used in children?
  nDCG@10=0.000; Recall@10=0.000; retrieved IDs: 26242768, 9381720, 17986032, 12215829, 12500519, 29254557, 32597210, 34682200, 24072084, 25248327.
- Query 4712: Which disease is caused by repeat expansion in VWA1?
  nDCG@10=0.000; Recall@10=0.000; retrieved IDs: 7998766, 25886163, 30358836, 32695777, 10766906, 24064469, 19710035, 25356969, 34502075, 26420841.

## Manual review queue

Examples with |nDCG@10 − judge correctness| > 0.35. These are candidates for manual inspection; automated annotations are not manual review.

No flagged examples in completed judge results. Inspect raw run files for broader review.
