"""The same retrieval implementation is used by the UI and offline evaluator."""

import json
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache

import httpx
import numpy as np
from scipy import sparse
from sklearn.feature_extraction.text import CountVectorizer

from app import config
from app.llm import generate_expansions


def expand_query(query: str, with_usage=False):
    """Use the configured LLM for bounded alternatives, retaining the original."""
    queries, usage = generate_expansions(query)
    return (queries, usage) if with_usage else queries


def top_indices(scores: np.ndarray, k: int, minimum: float = 0) -> list[int]:
    """Exclude zero-hit lexical documents and deterministically break tied scores by row."""
    valid = np.flatnonzero(scores > minimum)
    if not len(valid):
        return []
    return valid[np.lexsort((valid, -scores[valid]))[:k]].tolist()


def reciprocal_rank_fusion(rankings, weights=None, k=60):
    weights = weights if weights is not None else [1.0] * len(rankings)
    scores = defaultdict(float)
    for ranking, weight in zip(rankings, weights, strict=True):
        for rank, doc in enumerate(ranking, start=1):
            scores[doc] += weight / (k + rank)
    return sorted(scores.items(), key=lambda item: (-item[1], item[0]))


@lru_cache(maxsize=1)
def embedding_model():
    if config.EMBEDDING_BACKEND == "gemini":
        return GeminiEmbedding()
    if config.EMBEDDING_BACKEND == "mlx":
        return AppleEmbedding()
    if config.EMBEDDING_BACKEND != "fastembed":
        raise RuntimeError("EMBEDDING_BACKEND must be gemini, auto, mlx, or fastembed.")
    from fastembed import TextEmbedding

    return TextEmbedding(
        model_name=config.EMBEDDING_MODEL,
        threads=config.EMBEDDING_THREADS,
        cache_dir=str(config.DATA / "index" / "models"),
    )


class GeminiEmbedding:
    """Remote document/query embeddings; no local neural model is loaded."""

    def __init__(self):
        if not config.API_KEY:
            raise RuntimeError("Set GEMINI_API_KEY in .env before building Gemini embeddings.")

    def encode(self, texts, task, batch_size=32):
        texts = list(texts)
        with httpx.Client(timeout=180, trust_env=False) as client:
            for start in range(0, len(texts), min(batch_size, 100)):
                batch = texts[start : start + min(batch_size, 100)]
                for attempt in range(7):
                    response = client.post(
                        f"{config.BASE_URL}/models/{config.EMBEDDING_MODEL}:batchEmbedContents",
                        headers={"x-goog-api-key": config.API_KEY},
                        json={
                            "requests": [
                                {
                                    "model": f"models/{config.EMBEDDING_MODEL}",
                                    "content": {"parts": [{"text": text}]},
                                    "taskType": task,
                                    "outputDimensionality": 768,
                                }
                                for text in batch
                            ]
                        },
                    )
                    if response.status_code not in {429, 500, 502, 503, 504} or attempt == 6:
                        break
                    time.sleep(min(2 ** (attempt + 1), 60))
                response.raise_for_status()
                rows = response.json().get("embeddings", [])
                if len(rows) != len(batch):
                    raise RuntimeError("Gemini returned an incomplete embedding batch.")
                vectors = np.asarray([row["values"] for row in rows], dtype=np.float32)
                norms = np.linalg.norm(vectors, axis=1, keepdims=True)
                if vectors.shape != (len(batch), 768) or not np.isfinite(vectors).all() or (norms == 0).any():
                    raise RuntimeError("Gemini returned invalid embedding vectors.")
                yield from vectors / norms

    def passage_embed(self, texts, batch_size=32):
        texts = list(texts)
        batches = [texts[start : start + 100] for start in range(0, len(texts), 100)]

        def embed_batch(batch):
            return list(self.encode(batch, "RETRIEVAL_DOCUMENT", 100))

        # Preserve corpus row order while using a bounded number of remote requests.
        with ThreadPoolExecutor(max_workers=4) as workers:
            for vectors in workers.map(embed_batch, batches):
                yield from vectors

    def query_embed(self, queries):
        yield from self.encode(queries, "RETRIEVAL_QUERY")


class AppleEmbedding:
    """BGE-small with CLS pooling and normalization, accelerated on Apple Silicon."""

    def __init__(self):
        if config.EMBEDDING_MODEL != "BAAI/bge-small-en-v1.5":
            raise RuntimeError("The MLX backend currently supports BAAI/bge-small-en-v1.5 only.")
        from mlx_embedding_models.embedding import EmbeddingModel

        # MLX arrays retain thread-specific streams. Initialization and every inference
        # must run on the same worker, including when FastAPI changes request threads.
        self.worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="helix-embeddings")
        self.model = self.worker.submit(EmbeddingModel.from_registry, "bge-small").result()

    def passage_embed(self, texts, batch_size=32):
        vectors = self.worker.submit(
            self.model.encode,
            list(texts),
            batch_size=batch_size,
            show_progress=False,
        ).result()
        yield from vectors.astype(np.float32)

    def query_embed(self, queries):
        yield from self.passage_embed(queries)


def read_jsonl(path):
    with open(path) as stream:
        return [json.loads(line) for line in stream if line.strip()]


class SearchEngine:
    def __init__(self):
        self.manifest = json.loads((config.INDEX / "manifest.json").read_text())
        self.dense_ready = (
            self.manifest["embedding_model"] == config.EMBEDDING_MODEL
            and self.manifest.get("embedding_backend", "fastembed") == config.EMBEDDING_BACKEND
        )
        self.passages = read_jsonl(config.DATA / "passages.jsonl")
        vocabulary = json.loads((config.INDEX / "vocabulary.json").read_text())
        self.vectorizer = CountVectorizer(
            vocabulary=vocabulary, stop_words="english", token_pattern=r"(?u)\b\w[\w-]*\b", lowercase=True
        )
        self.bm25 = sparse.load_npz(config.INDEX / "bm25.npz")
        self.vectors = np.load(config.INDEX / "vectors.npy", mmap_mode="r")
        if self.vectors.shape[0] != len(self.passages) or self.bm25.shape[0] != len(self.passages):
            raise RuntimeError("Index and passage rows differ. Rebuild the index.")

    def search(
        self,
        query,
        mode="hybrid",
        expand=True,
        top_k=10,
        lexical_weight=0.5,
        rrf_k=60,
        expansion_weight=0.6,
        candidate_k=50,
    ):
        started = time.perf_counter()
        queries, expansion_usage = expand_query(query, with_usage=True) if expand else ([query], None)
        rankings, weights = [], []
        lexical_scores, dense_scores = {}, {}
        # Each expansion contributes a lower-weight ranked list, retaining original-query priority.
        if mode in {"lexical", "hybrid"}:
            for qi, q in enumerate(queries):
                terms = self.vectorizer.transform([q])
                terms.data[:] = 1  # repeated query terms must not dominate the ranking
                scores = (self.bm25 @ terms.T).toarray().ravel()
                ranked = top_indices(scores, candidate_k)
                rankings.append(ranked)
                weights.append(
                    (1 if qi == 0 else expansion_weight) * (lexical_weight if mode == "hybrid" else 1)
                )
                if qi == 0:
                    lexical_scores = {i: float(scores[i]) for i in ranked}
        if mode in {"dense", "hybrid"}:
            if not self.dense_ready:
                raise RuntimeError(
                    "Rebuild embeddings for Gemini with scripts.prepare --rebuild. Lexical search is available."
                )
            embeddings = list(embedding_model().query_embed(queries))
            for qi, vector in enumerate(embeddings):
                scores = np.asarray(self.vectors @ vector).ravel()
                ranked = top_indices(scores, candidate_k, minimum=-1)
                rankings.append(ranked)
                weights.append(
                    (1 if qi == 0 else expansion_weight) * (1 - lexical_weight if mode == "hybrid" else 1)
                )
                if qi == 0:
                    dense_scores = {i: float(scores[i]) for i in ranked}
        if len(rankings) == 1:
            source_scores = lexical_scores if mode == "lexical" else dense_scores
            ranking = [(i, source_scores[i]) for i in rankings[0]]
            score_type = "BM25" if mode == "lexical" else "cosine similarity"
        else:
            ranking = reciprocal_rank_fusion(rankings, weights, rrf_k)
            score_type = "weighted reciprocal rank fusion"
        evidence = []
        for rank, (i, score) in enumerate(ranking[:top_k], start=1):
            passage = self.passages[i]
            source_url = passage.get("source_url") or f"https://pubmed.ncbi.nlm.nih.gov/{passage['id']}/"
            evidence.append(
                {
                    **passage,
                    "source_url": source_url,
                    "rank": rank,
                    "score": float(score),
                    "lexical_score": lexical_scores.get(i),
                    "dense_score": dense_scores.get(i),
                }
            )
        return {
            "query": query,
            "queries": queries,
            "expansion_usage": expansion_usage,
            "mode": mode,
            "score_type": score_type,
            "evidence": evidence,
            "retrieval_ms": round((time.perf_counter() - started) * 1000, 2),
            "configuration": {
                "mode": mode,
                "expand": expand,
                "top_k": top_k,
                "candidate_k": candidate_k,
                "lexical_weight": lexical_weight,
                "rrf_k": rrf_k,
                "expansion_weight": expansion_weight,
            },
        }
