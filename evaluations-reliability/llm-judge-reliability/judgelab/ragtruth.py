"""Download RAGTruth and build the evaluation sample.

RAGTruth (MIT) holds real LLM answers with human-marked hallucination spans. Its QA passages come
from MS MARCO, whose terms limit use to non-commercial research, so the passages and answers are
downloaded to data/ragtruth/ (Git-ignored) and only the sampled answer IDs are committed.
"""

import hashlib
import json
import random
import zlib
from collections import Counter

import httpx

from judgelab import config, store

COMMIT = "c103204b9ce28d6bbad859304bf30de72b8ed8fe"
BASE = f"https://raw.githubusercontent.com/particlemedia/RAGTruth/{COMMIT}/dataset"
FILES = {
    "response.jsonl": "e4c2e4ac24fff676d8984cc61c35d791612fadc58015335d97dd632375e18073",
    "source_info.jsonl": "0dffc26ea9f3c1c3d7c7e8336b56ef1646e3cec876edffcca3c9c624d12d578b",
}
DIR = config.DATA / "ragtruth"
SAMPLE_IDS = config.DATA / "ragtruth-sample.json"

# RAGTruth label type -> our mistake name.
MISTAKES = {
    "Evident Conflict": "evident_conflict",
    "Subtle Conflict": "subtle_conflict",
    "Evident Baseless Info": "evident_baseless",
    "Subtle Baseless Info": "subtle_baseless",
}
PER_MISTAKE = 15
CLEAN = 60
SEED = 7


def download(client=None, directory=DIR):
    """Fetch the pinned files once and check their SHA-256."""
    raw = directory / "raw"
    raw.mkdir(parents=True, exist_ok=True)
    client = client or httpx.Client(timeout=120, follow_redirects=True)
    for name, digest in FILES.items():
        path = raw / name
        if not path.exists():
            response = client.get(f"{BASE}/{name}")
            response.raise_for_status()
            path.write_bytes(response.content)
        if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            path.unlink()
            raise RuntimeError(f"{name} does not match the pinned checksum. Run the command again.")
    return raw


def _load(raw):
    responses = store.read_jsonl(raw / "response.jsonl")
    sources = {s["source_id"]: s for s in store.read_jsonl(raw / "source_info.jsonl")}
    return responses, sources


def _mistake(response):
    kinds = {label["label_type"] for label in response["labels"]}
    return MISTAKES[kinds.pop()] if len(kinds) == 1 else None


def choose(responses, sources, seed=SEED):
    """Balanced sample of good-quality QA answers: clean ones and single-mistake ones, one per question."""
    pool = [r for r in responses if sources[r["source_id"]]["task_type"] == "QA" and r["quality"] == "good"]
    rng = random.Random(seed)
    rng.shuffle(pool)
    used, chosen = set(), []

    def take(candidates, n):
        # Round-robin over the six models so no model dominates a group.
        by_model = {}
        for r in candidates:
            by_model.setdefault(r["model"], []).append(r)
        picked = []
        while len(picked) < n and any(by_model.values()):
            for model in sorted(by_model):
                while by_model[model] and by_model[model][0]["source_id"] in used:
                    by_model[model].pop(0)
                if by_model[model] and len(picked) < n:
                    r = by_model[model].pop(0)
                    used.add(r["source_id"])
                    picked.append(r)
        return picked

    # Rarest type first, so it gets first pick of questions.
    for label in sorted(MISTAKES.values(), key=lambda m: sum(_mistake(r) == m for r in pool)):
        chosen += take([r for r in pool if _mistake(r) == label], PER_MISTAKE)
    chosen += take([r for r in pool if not r["labels"]], CLEAN)
    return sorted(r["id"] for r in chosen)


def to_case(response, source):
    info = source["source_info"]
    mistake = _mistake(response)
    return {
        "id": f"rt{response['id']}",
        # A stable third of questions are hold-out, as in the synthetic set.
        "split": "holdout" if zlib.crc32(response["source_id"].encode()) % 3 == 0 else "dev",
        "kind": "ragtruth-qa",
        "passage": info["passages"].strip(),
        "question": info["question"],
        "answers": [{
            "id": f"rt{response['id']}",
            "answer": response["response"].strip(),
            "expected": "fail" if response["labels"] else "pass",
            "error": mistake,
            "source": response["model"],
            # True when every marked span is true in the real world but absent from the passage.
            "world_true": bool(response["labels"]) and all(label["implicit_true"] for label in response["labels"]),
            "spans": [
                {"text": label["text"], "start": label["start"], "end": label["end"],
                 "type": MISTAKES[label["label_type"]], "note": label.get("meta") or ""}
                for label in response["labels"]
            ],
        }],
    }


def build(client=None, resample=False, directory=DIR, ids_path=SAMPLE_IDS):
    """Download if needed, then write data/ragtruth/cases.jsonl from the committed sample IDs."""
    responses, sources = _load(download(client, directory))
    if resample or not ids_path.exists():
        store.write_json(ids_path, {
            "source": f"https://github.com/particlemedia/RAGTruth/tree/{COMMIT}",
            "seed": SEED, "per_mistake": PER_MISTAKE, "clean": CLEAN,
            "ids": choose(responses, sources),
        })
    ids = set(json.loads(ids_path.read_text())["ids"])
    cases = [to_case(r, sources[r["source_id"]]) for r in responses if r["id"] in ids]
    if len(cases) != len(ids):
        raise RuntimeError("Some sampled IDs are missing from the download.")
    path = directory / "cases.jsonl"
    path.write_text("".join(json.dumps(c, ensure_ascii=False) + "\n" for c in cases))
    counts = Counter(c["answers"][0]["error"] or "clean" for c in cases)
    return path, counts
