# Offline fixture sweep

Generated on 2026-10-29 with Node.js 26.6.0 using `node --import=tsx scripts/evaluate.ts --json > results/offline.json` from this example's directory.

`offline.json` contains 70 cases: seven fixture questions, two methods (lexical ranking and prefix truncation), and removal targets of 0%, 25%, 50%, 75% and 90%. Sentence units, query awareness, the read's focus and an 80-token pass-through threshold use the defaults. RAG retrieves three passages using the frozen fixture corpus and query. Token counts use cl100k_base.

These are deterministic source-selection measurements. They are **not LLM answer scores**, live cost measurements, model comparisons or evidence that any compression level is safe generally.

Some instructive results:

- On the refund question, lexical selection retains both annotated facts at a 75% removal target, but only one at 90%.
- On the RAG recovery question, at a 50% target, lexical selection retains one of two facts. Prefix truncation retains both: the relevant evidence happens to be near the front. Lexical ranking does not always win.
- The launch correction has three annotated facts. At a 90% target, lexical selection retains two and truncation retains none.
- Actual removal can exceed the requested target. Zero-overlap units are excluded, units and headings must fit whole, and the budget is a ceiling rather than a promise to fill every token.

The UI's “Two sources required” preset also lets you reduce retrieval to top-k=1 to observe a retrieval miss. That setting is a separate interactive experiment; this saved sweep uses top-k=3 throughout.
