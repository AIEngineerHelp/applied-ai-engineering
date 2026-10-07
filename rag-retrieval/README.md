# RAG & Retrieval

Build better retrieval and knowledge systems. Discuss embeddings, chunking, vector databases, reranking, knowledge graphs, and RAG pipelines.

[Community category](https://aiengineer.help/c/rag-retrieval/6) · [Repository home](../README.md)

## What belongs here

Use this category for document processing, search, embeddings, chunking, reranking, and retrieval pipelines. Keep evaluation suites whose main purpose is measuring quality in Evaluations & Reliability.

## Projects and resources

| Project | What it teaches | Status |
| --- | --- | --- |
| [Biomedical hybrid search](biomedical-search/README.md) | BM25, dense retrieval, reciprocal rank fusion, optional Gemini or TypeSafe Jev reranking, cited answers, and retrieval evaluation | Runnable Python example; historical baseline included |
| [Chunking by document type](chunking-strategies/README.md) | A web app that highlights how ten document types (docs, FAQ, report, code, CSV, contract, transcript, a report with charts, a slide deck, a manual with diagrams) are chunked, including how images stay linked to the text that cites them,: where each is cut, what stays together, and the context attached to every chunk, next to a fixed-size split | Runnable TypeScript app |
| [Knowledge graph from logs](../agents/incident-response-agent/README.md#memory-and-knowledge) | Extracting entities and relationships from system logs into Neo4j and feeding graph context to an agent | Part of the [incident response agent](../agents/incident-response-agent/README.md) (primary category: Agents) |

## Adding a contribution

Create a descriptive kebab-case project directory with its own README. Document its purpose, dependencies, setup, verification, and relevant sources. Add it to this index and link its community discussion when one exists. Keep dependencies local to the project. See the [repository guide](../AGENTS.md) for the full conventions.
