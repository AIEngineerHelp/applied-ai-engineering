import json


def read_jsonl(path):
    if not path.exists():
        return []
    with path.open() as handle:
        return [json.loads(line) for line in handle if line.strip()]


def append_jsonl(path, record):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as handle:
        handle.write(json.dumps(record, ensure_ascii=False) + "\n")


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")
    tmp.replace(path)


def load_items(cases_path, review_path=None):
    """One item per answer to grade, carrying its case, the known verdict and any review note."""
    reviews = json.loads(review_path.read_text())["reviews"] if review_path and review_path.exists() else {}
    return [
        {
            "id": answer["id"],
            "case_id": case["id"],
            "split": case["split"],
            "kind": case["kind"],
            "passage": case["passage"],
            "question": case["question"],
            "answer": answer["answer"],
            "expected": answer["expected"],
            "error": answer.get("error"),
            "source": answer.get("source"),
            "world_true": answer.get("world_true", False),
            "spans": answer.get("spans", []),
            "review": reviews.get(answer["id"]),
        }
        for case in read_jsonl(cases_path)
        for answer in case["answers"]
    ]


def judgments_path(variant, input_kind, repeat, runs):
    return runs / "judgments" / variant / f"{input_kind}-r{repeat}.jsonl"


# Fields kept in the committed verdicts file: enough to rebuild every table without re-running the judges.
VERDICT_FIELDS = ("item_id", "variant", "input", "repeat", "verdict", "p_pass", "reasoning", "model",
                  "input_tokens", "output_tokens", "ms", "usd")


def published_path(runs):
    """runs/<dataset> is local; results/<dataset>/verdicts.jsonl is the committed copy of the same verdicts."""
    return runs.parent.parent / "results" / runs.name / "verdicts.jsonl"


def load_judgments(variant, input_kind, repeat, runs):
    """Latest successful verdict per item, from local runs if present, else from the committed verdicts."""
    records = read_jsonl(judgments_path(variant, input_kind, repeat, runs))
    if not records:
        records = [r for r in _published(runs) if r["variant"] == variant and r["input"] == input_kind
                   and str(r["repeat"]) == str(repeat)]
    return {r["item_id"]: r for r in records if not r.get("error")}


_published_cache = {}


def _published(runs):
    path = published_path(runs)
    key = (path, path.stat().st_mtime_ns if path.exists() else None)
    if key not in _published_cache:
        _published_cache.clear()
        _published_cache[key] = read_jsonl(path)
    return _published_cache[key]


def export_verdicts(runs):
    """Write the latest successful verdict for every (variant, input, repeat, item) to the committed file."""
    rows = []
    for path in sorted(runs.glob("judgments/*/*.jsonl")):
        latest = {}
        for r in read_jsonl(path):
            if not r.get("error"):
                latest[r["item_id"]] = {k: r.get(k) for k in VERDICT_FIELDS}
        rows += [latest[k] for k in sorted(latest)]
    if not rows:
        return None
    out = published_path(runs)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows))
    return out, len(rows)
