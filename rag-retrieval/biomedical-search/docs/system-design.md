# System design

```mermaid
flowchart TB
    subgraph Offline[Offline preparation]
        HF[rag-mini-bioasq Parquet files] --> Clean[Validate IDs and exclude missing passage text]
        Clean --> Corpus[JSONL passage corpus with original PMIDs]
        Corpus --> BM25[BM25 sparse matrix and vocabulary]
        Corpus --> BGE[Gemini remote passage embeddings]
        BGE --> Vectors[Memory-mapped normalized vector matrix]
        HF --> Fixed[Seeded and category-balanced 100-query set]
    end
    subgraph Online[Shared online retrieval pipeline]
        Question[Biomedical question] --> Expand[Original query plus bounded Gemini expansions]
        Expand --> Lexical[BM25 scoring: top 50 per query]
        Expand --> Dense[Query embedding and cosine search: top 50 per query]
        BM25 --> Lexical
        Vectors --> Dense
        Lexical --> Fuse[Weighted reciprocal rank fusion]
        Dense --> Fuse
        Fuse --> Evidence[Ranked passage IDs, scores, and text]
    end
    subgraph Product[User-facing evidence and answers]
        UI[Search UI and configuration controls] --> Question
        Evidence --> Display[Evidence display and PubMed links]
        Display --> Select[Select up to 5 passages]
        Select --> Context[Exact context: 1800 characters per passage]
        Context --> LLM[Final-answer LLM: selected passages only]
        LLM --> Validate[Validate structured claims and every cited ID]
        Validate --> Answer[Grounded answer or explicit insufficient evidence]
        Answer --> UI
        Answer --> Citation[Citation links back to evidence cards]
    end
    subgraph Experiments[Reproducible offline experiment path]
        Fixed --> Variants[Five fixed retrieval configurations]
        Variants --> Question
        Evidence --> Metrics[Recall 5/10, MRR 10, nDCG 10, latency]
        Fixed --> References[Gold answers and relevant passage IDs]
        References --> Metrics
        References --> Judge[Fixed LLM judge prompt, model, settings]
        Answer --> Judge
        Context --> Judge
        Judge --> Review[Disagreement queue and human review]
        Metrics --> Logs[Per-query JSONL logs and comparison table]
        Judge --> Logs
        Logs --> Best[Best hybrid by nDCG 10, then Recall 10]
        Best --> UI
    end
```

The final-answer call has no access to gold answers, gold relevance labels, or the rest of the corpus.
Its payload contains only the user's question and the exact selected passage excerpts.
Gold data enters the independent evaluation path only.

Citation validation is enforced in `app/llm.py`, before displaying any model claims. Every claim
must include IDs from the selected context. An invalid ID, empty answered response, or uncontrolled
inline citation causes a fail-closed abstention with a logged validation error. This is structural
validation; semantic support is assessed separately by the judge and human inspection.

The local UI and evaluator both call `SearchEngine.search` in `app/retrieval.py`. All configurations,
ranked passage IDs, scores, original and expanded queries, latency, answer usage, and judge outputs
are recorded. The query set and corpus hashes are saved with each summary for reproducibility.
