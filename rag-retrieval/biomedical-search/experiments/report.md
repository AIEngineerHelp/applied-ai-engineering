# Biomedical hybrid search evaluation

Run: 20260921T005506Z

Dataset: `rag-datasets/rag-mini-bioasq`. 28,001 indexed passages. The same 100 fixed query IDs were used for all five configurations.

## Comparison

| Configuration | Recall@5 | Recall@10 | MRR@10 | nDCG@10 | Mean ms | p95 ms | Judge n | Correctness | Groundedness | Context relevance |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| lexical | 0.639 | 0.723 | 0.667 | 0.648 | 2.8 | 3.6 | 0 | pending | pending | pending |
| dense | 0.719 | 0.810 | 0.761 | 0.746 | 670.4 | 807.6 | 0 | pending | pending | pending |
| hybrid | 0.724 | 0.794 | 0.774 | 0.743 | 688.6 | 823.5 | 0 | pending | pending | pending |
| hybrid_expanded | 0.720 | 0.796 | 0.754 | 0.733 | 2224.7 | 2455.2 | 0 | pending | pending | pending |
| hybrid_weighted | 0.713 | 0.795 | 0.754 | 0.733 | 2426.2 | 2646.6 | 0 | pending | pending | pending |

## Selected configuration

**hybrid** is the best hybrid by nDCG@10 (0.743); Recall@10 breaks ties. Selection uses retrieval relevance labels, not LLM-judge scores.

Expansion did not improve the selection criterion in this comparison. The original-query hybrid also avoids retrieving and embedding alternate queries.

Its mean retrieval latency is 688.6 ms, compared with 2.8 ms for lexical retrieval. Gemini query embeddings and LLM expansion may incur API charges; retrieval cost is unknown unless all applicable rates are configured. Index preparation and hardware costs are excluded.

The overall retrieval winner is **dense**. Hybrid fusion is an empirical choice; it is not assumed to beat lexical retrieval.

## Method and limitations

- The 100-query set is seeded (42) and approximately balanced by rule-based question categories. Only questions whose entire gold passage set survives missing-text filtering are eligible.
- Configurations were specified before measurement. This is a comparison set used for selection, not an independent held-out estimate after selecting the winner.
- BM25 uses k1=1.5, b=0.75, English stop words, and retains gene symbols and hyphenated terms. Neural embeddings use the model and dimensions recorded in the run manifest.
- Expansion uses `gemini-2.5-flash` with a fixed prompt at temperature 0 and retains the original query. Generated alternatives and usage are logged per search.
- Hybrid uses weighted reciprocal rank fusion over the top 50 from each signal/query. The expanded baseline weights original queries at 1.0 and expansions at 0.6; the weighted candidate uses lexical weight 0.65, RRF k=20, and expansion weight 0.35.
- Latency includes expansion, query embedding, scoring, and fusion; it excludes initial model/index load. Queries are not embedding-cached between variants. Gemini network latency and quota may affect timings.
- Answer generation uses at most five selected passages, truncated to 1,800 characters each. The UI displays the exact selected context. Citation validation checks IDs and answer structure, not entailment; the judge separately assesses support.
- Answer model: `gemini-2.5-flash`. Judge model: `gemini-2.5-flash`. Both use temperature 0. Judge prompt and settings are fixed across variants.
- LLM evaluation uses an equivalent fixed-rubric judge with correctness, groundedness, and context relevance scored in [0,1]. The LLM judge is a diagnostic, not a validated medical authority. Shared answer/judge models can have correlated errors.
- Judge coverage: 0 of 100 queries per variant requested. Pending cells indicate unrun evaluation, never estimated scores. Errors are logged per query.
- A separately inspected preflight example is documented in `docs/manual-review.md`; it exposed an overgenerous judge explanation despite valid citation IDs.

## Successful searches and failure cases

### Successes

- Query 3541: How does LB-100 affect the DDR proteins (BRCA1, Chk2, and γH2AX)?
  nDCG@10=1.000; Recall@10=1.000; retrieved IDs: 25376608, 22704343, 16596250, 23729402, 22979979, 20080130, 16462773, 12592385, 22170030, 15254397.
- Query 2704: Which miRNA is associated with the circular RNA ciRS-7?
  nDCG@10=1.000; Recall@10=1.000; retrieved IDs: 28253710, 27929395, 26649774, 25580223, 28634583, 29887379, 24339831, 34269929, 33614648, 34238421.
- Query 4626: What pathological phenotype could potentially concomitant pomegranate juice and rosuvastatin use cause?
  nDCG@10=1.000; Recall@10=1.000; retrieved IDs: 16923466, 18158835, 24788803, 34881402, 24392102, 23409830, 21267417, 21114416, 17042673, 19801853.

### Failures

- Query 3751: Which TREX mRNA export complex subunits have been implicated in neurodevelopmental disorders?
  nDCG@10=0.000; Recall@10=0.000; retrieved IDs: 15358174, 23599000, 24705649, 15870275, 30194269, 20230609, 25232744, 24552703, 25845599, 21301339.
- Query 4712: Which disease is caused by repeat expansion in VWA1?
  nDCG@10=0.000; Recall@10=0.000; retrieved IDs: 7998766, 30358836, 34502075, 15651335, 25356969, 10766906, 22723857, 9735324, 24064469, 11494364.
- Query 1873: Describe the applicability of Semantic MediaWiki in the case of FANTOM5
  nDCG@10=0.000; Recall@10=0.000; retrieved IDs: 22058131, 33211864, 24518066, 19948017, 22080549, 22693219, 22438567, 22719993, 22990765, 21789182.

## Manual review queue

Examples with |nDCG@10 − judge correctness| > 0.35. These are candidates for manual inspection; automated annotations are not manual review.

No flagged examples in completed judge results. Inspect raw run files for broader review.
