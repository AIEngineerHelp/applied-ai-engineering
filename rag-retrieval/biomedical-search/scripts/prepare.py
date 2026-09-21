"""Download the specified dataset, preserve passage IDs, build both indexes and freeze 100 queries."""

import argparse
import ast
import hashlib
import json
import random
import re
from collections import Counter, defaultdict
from datetime import UTC, datetime

import httpx
import numpy as np
import pyarrow.parquet as pq
from scipy import sparse
from sklearn.feature_extraction.text import CountVectorizer

from app import config
from app.retrieval import embedding_model

PARQUET_ROOT = "https://huggingface.co/datasets/rag-datasets/rag-mini-bioasq/resolve/refs%2Fconvert%2Fparquet"


def download(url, path):
    if path.exists():
        return
    partial = path.with_suffix(".partial")
    with httpx.stream("GET", url, follow_redirects=True, timeout=120) as response:
        response.raise_for_status()
        with partial.open("wb") as output:
            for chunk in response.iter_bytes():
                output.write(chunk)
    partial.replace(path)


def write_jsonl(path, rows):
    path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows))


def question_type(question, answer):
    q = question.lower()
    if re.match(r"^(is|are|does|do|can|has|have|was|were)\b", q) or str(answer).lower() in {"yes", "no"}:
        return "yes/no"
    if any(word in q for word in ("treat", "therapy", "therapeutic", "drug")):
        return "treatment"
    if any(word in q for word in ("mechanism", "pathway", "how does", "how do")):
        return "mechanism"
    if any(word in q for word in ("effect", "affect", "impact", "cause", "role")):
        return "effect"
    if re.match(r"^(what is|what are|define)\b", q):
        return "definition"
    return "list"


def parse_ids(value):
    if isinstance(value, str):
        value = ast.literal_eval(value)
    return list(dict.fromkeys(str(i) for i in value))


def freeze_queries(questions, valid_ids, path):
    if path.exists():
        print(f"Preserving existing fixed query set: {path}", flush=True)
        return
    rng = random.Random(42)
    groups = defaultdict(list)
    for row in questions:
        relevant = parse_ids(row["relevant_passage_ids"])
        # Only keep questions whose entire gold set is present in the indexed, nonempty corpus.
        if relevant and set(relevant) <= valid_ids and row["question"]:
            category = question_type(row["question"], row["answer"])
            groups[category].append(
                {
                    "id": str(row["id"]),
                    "question": row["question"],
                    "answer": row["answer"],
                    "relevant_passage_ids": relevant,
                    "category": category,
                }
            )
    for group in groups.values():
        rng.shuffle(group)
    chosen = []
    while len(chosen) < 100 and any(groups.values()):
        for category in sorted(groups):
            if groups[category] and len(chosen) < 100:
                chosen.append(groups[category].pop())
    if len(chosen) != 100:
        raise RuntimeError("Could not select 100 fully answerable queries.")
    write_jsonl(path, chosen)
    print(f"Fixed query categories: {dict(Counter(q['category'] for q in chosen))}", flush=True)


def prepare(rebuild=False):
    if config.EMBEDDING_BACKEND == "gemini" and not config.API_KEY:
        raise RuntimeError("Set GEMINI_API_KEY in .env before preparing Gemini embeddings.")
    raw = config.DATA / "raw"
    raw.mkdir(parents=True, exist_ok=True)
    config.INDEX.mkdir(parents=True, exist_ok=True)
    config.EXPERIMENTS.mkdir(parents=True, exist_ok=True)
    download(f"{PARQUET_ROOT}/text-corpus/passages/0000.parquet", raw / "passages.parquet")
    download(f"{PARQUET_ROOT}/question-answer-passages/test/0000.parquet", raw / "questions.parquet")
    rows = pq.read_table(raw / "passages.parquet").to_pylist()
    questions = pq.read_table(raw / "questions.parquet").to_pylist()
    print(f"Dataset schema: passages {list(rows[0])}, questions {list(questions[0])}", flush=True)
    passages, removed = [], []
    for row in rows:
        text = row.get("passage", row.get("text"))
        if not isinstance(text, str) or text.strip().lower() in {"", "nan", "none"}:
            removed.append(str(row["id"]))
            continue
        passages.append({"id": str(row["id"]), "text": text.strip(), "source_url": row.get("url")})
    if len({p["id"] for p in passages}) != len(passages):
        raise RuntimeError("Duplicate passage IDs require explicit dataset repair.")
    # Keep duplicate text with distinct IDs: changing IDs would invalidate source relevance labels.
    freeze_queries(questions, {p["id"] for p in passages}, config.EXPERIMENTS / "queries-100.jsonl")
    manifest_path = config.INDEX / "manifest.json"
    if manifest_path.exists() and not rebuild:
        print("Indexes already prepared; use --rebuild to regenerate.", flush=True)
        return
    write_jsonl(config.DATA / "passages.jsonl", passages)
    write_jsonl(config.DATA / "questions.jsonl", questions)
    texts = [p["text"] for p in passages]
    print(f"Indexing {len(passages):,} passages; removed {len(removed)} invalid texts.", flush=True)
    vectorizer = CountVectorizer(stop_words="english", token_pattern=r"(?u)\b\w[\w-]*\b", lowercase=True)
    counts = vectorizer.fit_transform(texts).astype(np.float32).tocsr()
    lengths = np.asarray(counts.sum(axis=1)).ravel()
    df = np.asarray((counts > 0).sum(axis=0)).ravel()
    idf = np.log1p((len(texts) - df + 0.5) / (df + 0.5))
    k1, b = 1.5, 0.75
    row_indices = np.repeat(np.arange(len(texts)), np.diff(counts.indptr))
    counts.data = (
        idf[counts.indices]
        * counts.data
        * (k1 + 1)
        / (counts.data + k1 * (1 - b + b * lengths[row_indices] / lengths.mean()))
    )
    sparse.save_npz(config.INDEX / "bm25.npz", counts)
    (config.INDEX / "vocabulary.json").write_text(
        json.dumps({k: int(v) for k, v in vectorizer.vocabulary_.items()})
    )
    print("BM25 ready. Building neural embeddings…", flush=True)
    model = embedding_model()
    # Checkpoint each batch so interrupted builds can resume without discarding hours of work.
    checkpoint_path = config.INDEX / "embedding-progress.json"
    partial_path = config.INDEX / "vectors.partial.npy"
    corpus_hash = hashlib.sha256((config.DATA / "passages.jsonl").read_bytes()).hexdigest()
    signature = f"{corpus_hash}:{config.EMBEDDING_MODEL}:{config.EMBEDDING_BACKEND}"
    progress = json.loads(checkpoint_path.read_text()) if checkpoint_path.exists() else {}
    completed = progress.get("completed", 0) if progress.get("signature") == signature else 0
    first = next(model.passage_embed([texts[0]]))
    if completed and partial_path.exists():
        vectors = np.lib.format.open_memmap(partial_path, mode="r+")
    else:
        completed = 0
        vectors = np.lib.format.open_memmap(
            partial_path, mode="w+", dtype=np.float32, shape=(len(texts), len(first))
        )
    batch_size = 512 if config.EMBEDDING_BACKEND == "gemini" else 128
    for start in range(completed, len(texts), batch_size):
        end = min(start + batch_size, len(texts))
        vectors[start:end] = np.array(list(model.passage_embed(texts[start:end], batch_size=32)))
        vectors.flush()
        checkpoint_path.write_text(
            json.dumps({"signature": signature, "completed": end, "total": len(texts)})
        )
        if config.EMBEDDING_BACKEND == "gemini" or end % 1024 == 0 or end == len(texts):
            print(f"Embedded {end:,}/{len(texts):,}", flush=True)
    del vectors
    partial_path.replace(config.INDEX / "vectors.npy")
    checkpoint_path.unlink(missing_ok=True)
    manifest = {
        "dataset": config.DATASET,
        "prepared_at": datetime.now(UTC).isoformat(),
        "passages": len(passages),
        "questions": len(questions),
        "removed_ids": removed,
        "embedding_model": config.EMBEDDING_MODEL,
        "embedding_backend": config.EMBEDDING_BACKEND,
        "dimensions": len(first),
        "bm25": {"k1": k1, "b": b, "stop_words": "english"},
        "corpus_sha256": corpus_hash,
        "raw_sha256": {
            path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(raw.glob("*.parquet"))
        },
    }
    manifest_path.write_text(json.dumps(manifest, indent=2))
    print("Both indexes are ready.", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--rebuild", action="store_true")
    prepare(parser.parse_args().rebuild)
