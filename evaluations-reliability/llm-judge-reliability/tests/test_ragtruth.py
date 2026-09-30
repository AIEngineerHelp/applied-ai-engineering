import hashlib
import json

import httpx
import pytest

from judgelab import ragtruth, store


def response(rid, source, model, labels=(), quality="good"):
    return {"id": rid, "source_id": source, "model": model, "temperature": 0.7, "split": "test",
            "quality": quality, "response": f" Answer {rid}. ",
            "labels": [{"start": 0, "end": 6, "text": "Answer", "meta": "NOTE", "label_type": t, "implicit_true": it,
                        "due_to_null": False} for t, it in labels]}


def source(sid, task="QA"):
    return {"source_id": sid, "task_type": task, "source": "MARCO", "prompt": "p",
            "source_info": {"question": f"question {sid}", "passages": f"passage {sid}\n\n"}}


def fake_data():
    models = ["m1", "m2", "m3"]
    responses, sources = [], {}
    n = 0
    for kind in [None, *ragtruth.MISTAKES]:
        for _ in range(ragtruth.PER_MISTAKE * 2 if kind else ragtruth.CLEAN * 2):
            n += 1
            sid = str(n)
            sources[sid] = source(sid)
            labels = [(kind, kind == "Subtle Baseless Info")] if kind else []
            responses.append(response(str(n), sid, models[n % 3], labels))
    # Noise that must never be sampled.
    sources["x1"], sources["x2"] = source("x1", "Summary"), source("x2")
    responses += [response("x1", "x1", "m1"), response("x2", "x2", "m1", quality="truncated"),
                  response("x3", "x2", "m1", [("Evident Conflict", False), ("Subtle Conflict", False)])]
    return responses, sources


def test_choose_is_balanced_deterministic_and_one_per_question():
    responses, sources = fake_data()
    ids = ragtruth.choose(responses, sources)
    assert ids == ragtruth.choose(responses, sources)
    by_id = {r["id"]: r for r in responses}
    picked = [by_id[i] for i in ids]
    assert len(picked) == ragtruth.CLEAN + ragtruth.PER_MISTAKE * len(ragtruth.MISTAKES)
    assert len({r["source_id"] for r in picked}) == len(picked)
    assert not {"x1", "x2", "x3"} & set(ids)
    kinds = [ragtruth._mistake(r) or "clean" for r in picked]
    assert kinds.count("clean") == ragtruth.CLEAN
    assert all(kinds.count(m) == ragtruth.PER_MISTAKE for m in ragtruth.MISTAKES.values())


def test_to_case_maps_labels_and_world_truth():
    r = response("7", "7", "gpt-4", [("Subtle Baseless Info", True)])
    case = ragtruth.to_case(r, source("7"))
    answer = case["answers"][0]
    assert case["question"] == "question 7" and case["passage"] == "passage 7"
    assert answer["expected"] == "fail" and answer["error"] == "subtle_baseless" and answer["world_true"]
    assert answer["answer"] == "Answer 7." and answer["source"] == "gpt-4"
    assert answer["spans"][0]["text"] == "Answer"
    clean = ragtruth.to_case(response("8", "8", "gpt-4"), source("8"))["answers"][0]
    assert clean["expected"] == "pass" and clean["error"] is None and not clean["world_true"]


def test_build_downloads_verifies_and_writes_sample(tmp_path, monkeypatch):
    responses, sources = fake_data()
    files = {
        "response.jsonl": "".join(json.dumps(r) + "\n" for r in responses).encode(),
        "source_info.jsonl": "".join(json.dumps(s) + "\n" for s in sources.values()).encode(),
    }
    monkeypatch.setattr(ragtruth, "FILES", {k: hashlib.sha256(v).hexdigest() for k, v in files.items()})
    client = httpx.Client(transport=httpx.MockTransport(lambda req: httpx.Response(200, content=files[req.url.path.rsplit("/", 1)[1]])))
    ids_path = tmp_path / "sample.json"
    path, counts = ragtruth.build(client, directory=tmp_path / "rt", ids_path=ids_path)
    assert counts["clean"] == ragtruth.CLEAN and sum(counts.values()) == len(json.loads(ids_path.read_text())["ids"])
    items = store.load_items(path)
    assert {i["expected"] for i in items} == {"pass", "fail"} and all(i["kind"] == "ragtruth-qa" for i in items)


def test_checksum_mismatch_is_rejected(tmp_path):
    client = httpx.Client(transport=httpx.MockTransport(lambda req: httpx.Response(200, content=b"tampered")))
    with pytest.raises(RuntimeError, match="checksum"):
        ragtruth.download(client, tmp_path)
    assert not (tmp_path / "raw" / "response.jsonl").exists()
