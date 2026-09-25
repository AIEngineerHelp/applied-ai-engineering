# ADR 2: Vector Store

## Context
We need a vector database to store and retrieve past incidents for the semantic cache and long-term memory. We also need relational storage for incident metadata and state.

## Decision
We will use PostgreSQL with the pgvector extension.

## Rationale
- Allows us to keep relational data and vector data in the same datastore.
- Simplifies the infrastructure stack (only one DB to manage instead of Postgres + Qdrant/Milvus).
- Supports HNSW indexing for fast approximate nearest neighbor search.

## Consequences
- Requires Postgres 15+ and pgvector extension installed.
- Performance tuning for vector indexes will be done on Postgres.
