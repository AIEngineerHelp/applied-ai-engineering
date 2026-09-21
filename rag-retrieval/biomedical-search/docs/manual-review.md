# Manual evidence review

These are historical local-model review notes, not evaluations of the current Gemini defaults. The partial smoke-run artifacts referenced in these notes remain in the original development workspace and are not included in this repository; the checked-in completed baseline has no answer/judge scores.

## Preflight: short QT syndrome inheritance

Configuration: lexical retrieval without expansion. Question: “What is the mode of inheritance of
short QT syndrome?” The dataset reference answer states an autosomal dominant mode of inheritance.

The local model's preflight answer stated an autosomal dominant mode and cited PMIDs **19482666**
and **16265378**. Both citation IDs were valid members of the selected context.

Inspection of the actual supplied excerpts showed:

- **19482666** directly supports the inheritance pattern but qualifies it as having been suggested.
- **16265378** describes an inheritable primary electrical disease, genetic mutations, and clinical
  characteristics. The supplied excerpt does not directly specify autosomal dominant inheritance.

The judge gave correctness 1.0 and groundedness 1.0, with an explanation incorrectly suggesting that
both cited passages mention an autosomal dominant mode. This demonstrates why valid citation IDs
and an agreeable judge score do not guarantee precise support from every citation.

The answer prompt was clarified before the benchmark to cite only passages directly supporting
each claim and to preserve uncertainty. This change does not replace manual inspection or a
stronger, independently validated judge. Inspect additional disagreements in the report's review
queue using the exact context preserved in the per-query run files.

This preflight is separate from the five-configuration benchmark and is not included in its
aggregate metrics. Its judge is a small local model and its scores should be treated as diagnostics.

## Benchmark disagreement: Dishevelled activation (query 526)

Configuration: lexical without expansion, six-query judge smoke subset. Retrieval achieved
**nDCG@10 = 1.0** and **Recall@10 = 1.0**, but the answer incorrectly named Gβ2 signaling as the
activating pathway. The reference answer names canonical Wnt signaling.

The selected excerpt from **PMID 19561403** explicitly states that Dishevelled is activated by Wnt
and describes Gβ2 as inhibiting Wnt reporter activity and reducing Dishevelled levels. The model
reversed the relationship even though the needed statement was in its supplied context.

The judge correctly assigned correctness **0.0** and explained that the answer was unsupported,
but simultaneously assigned groundedness **1.0**. That score contradicts its explanation. This is
a generation and judge-consistency failure, not a retrieval miss or an invalid citation ID.

## Benchmark disagreement: molecular radiotherapy (query 3636)

Configuration: lexical without expansion, the same smoke subset. Retrieval achieved
**nDCG@10 = 0.605** and **Recall@10 = 1.0**. The reference defines molecular radiotherapy through
tumor-targeted radionuclides. The generated claim merely says it can be used for pediatric malignancies,
which does not provide the requested definition.

The supplied excerpt from **PMID 28747518** contains both the tumor-targeted radionuclide description
and research into pediatric applications. The judge assigned correctness **1.0** while its explanation
incorrectly attributed pediatric applications to the reference answer and denied that the supplied
context discusses them. Treat that correctness score as overgenerous; the answer is incomplete.

These manually inspected examples explain why retrieval quality, citation structure, answer
correctness, and judge reliability must be assessed separately. The raw judge values in the original development workspace have not been replaced by manual judgments. A stronger answer model
and an independent stronger judge are appropriate next experiments before clinical use.
