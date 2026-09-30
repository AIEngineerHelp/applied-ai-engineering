import json

import pytest
from fastapi.testclient import TestClient

from judgelab import analyze, store
from judgelab.web import create_app

IDS = ["c1-a", "c1-b", "c2-a", "c2-b", "c3-a", "c3-b"]
P, F = "pass", "fail"


def write(workspace, variant, verdicts, input_kind="original", repeat=1):
    for item_id, verdict in zip(IDS, verdicts):
        store.append_jsonl(store.judgments_path(variant, input_kind, repeat, workspace["runs"]),
                           {"item_id": item_id, "verdict": verdict, "model": "g", "ms": 3,
                            "input_tokens": 1, "output_tokens": 1, "usd": 0.001})


def test_report_against_known_verdicts(workspace):
    # Truth: P F P F P F. The judge misses c2-b (incomplete) and wrongly fails c3-a.
    write(workspace, "gemini-rubric", [P, F, P, P, F, F])
    write(workspace, "gemini-rubric", [P, F, P, P, P, F], repeat=2)
    write(workspace, "gemini-rubric", [P, P, P, P, P, F], input_kind="padded")
    items = store.load_items(workspace["cases"])
    report = analyze.analyze(items, workspace["runs"])
    v = report["variants"]["gemini-rubric"]
    assert report["expected_pass"] == 3 and report["expected_fail"] == 3
    assert v["all"]["accuracy"] == pytest.approx(4 / 6)
    assert v["all"]["false_pass"] == 1 and v["all"]["false_fail"] == 1
    assert v["all"]["wrong"] == ["c2-b", "c3-a"]
    assert v["by_error"]["incomplete"] == {"n": 1, "caught": 0, "rate": 0.0, "missed": ["c2-b"]}
    assert v["by_error"]["wrong_fact"]["caught"] == 2
    assert v["dev"]["n"] == 4 and v["holdout"]["n"] == 2
    assert v["reliability"]["unstable"] == ["c3-a"]
    assert v["length_bias"]["expected_fail"]["flipped_to_pass"] == ["c1-b"]
    assert v["length_bias"]["expected_pass"]["flipped_to_pass"] == ["c3-a"]
    assert v["usage"]["usd"] == pytest.approx(0.006)
    text = analyze.markdown(report)
    assert "Mistakes caught, by type" in text and "Length bias" in text
    json.dumps(report)


def test_no_runs_yet(workspace):
    report = analyze.analyze(store.load_items(workspace["cases"]), workspace["runs"])
    assert report["variants"] == {} and "No judge runs yet" in analyze.markdown(report)


def test_dashboard_api(workspace, settings):
    write(workspace, "jev-rubric", [P, P, P, F, P, F])
    runs_root = workspace["root"] / "all-runs"
    runs_root.mkdir()
    workspace["runs"].rename(runs_root / "synthetic")
    datasets = {"synthetic": workspace["cases"], "ragtruth": workspace["root"] / "missing.jsonl"}
    app = TestClient(create_app(datasets, runs_root, settings))
    assert app.get("/").status_code == 200
    listed = app.get("/api/datasets").json()["datasets"]
    assert [(d["id"], d["ready"]) for d in listed] == [("synthetic", True), ("ragtruth", False)]
    assert app.get("/api/overview", params={"dataset": "ragtruth"}).status_code == 409
    assert app.get("/api/overview", params={"dataset": "nope"}).status_code == 404
    overview = app.get("/api/overview").json()
    assert overview["items"] == 6 and overview["expected"] == {"pass": 3, "fail": 3}
    assert overview["errors"] == {"wrong_fact": 2, "incomplete": 1}
    assert overview["variants"]["jev-rubric"]["graded"] == 6 and overview["calls_done"] == 6
    items = app.get("/api/items").json()
    assert items["variants"] == ["jev-rubric"]
    assert items["items"][1]["verdicts"]["jev-rubric"]["verdict"] == "pass"
    report = app.get("/api/report").json()
    assert report["report"]["variants"]["jev-rubric"]["all"]["false_pass"] == 1


def test_review_settles_disagreements(workspace, tmp_path):
    review = tmp_path / "review.json"
    review.write_text(json.dumps({"reviews": {
        "c2-b": {"read": "no_problem", "note": "label too strict"},   # judge passed it: judge right
        "c3-a": {"read": "no_problem", "note": "fine"},               # judge failed it: label right
    }}))
    write(workspace, "gemini-rubric", [P, F, P, P, F, F])
    items = store.load_items(workspace["cases"], review)
    assert items[3]["review"]["note"] == "label too strict" and items[0]["review"] is None
    d = analyze.analyze(items, workspace["runs"])["variants"]["gemini-rubric"]["disputes"]
    assert d == {"n": 2, "reviewed": 2, "judge_right": ["c2-b"], "debatable": [], "label_right": ["c3-a"]}


def test_judges_endpoint_exposes_exact_prompts(settings):
    app = TestClient(create_app({}, None, settings, {}))
    body = app.get("/api/judges").json()
    assert body["judges"]["gemini-reasoning"]["explains"] is True
    assert body["judges"]["gemini-basic"]["prompt"].endswith("Reply pass or fail.")
    assert body["judges"]["jev-rubric"]["provider"] == "jev" and "Options" in body["judges"]["jev-rubric"]["prompt"]
    assert body["pad"]["prefix"].startswith("Based on")


def test_report_cache_refreshes_when_runs_change(workspace, settings):
    runs_root = workspace["root"] / "all-runs"
    runs_root.mkdir()
    workspace["runs"].mkdir(parents=True, exist_ok=True)
    workspace["runs"].rename(runs_root / "synthetic")
    workspace["runs"] = runs_root / "synthetic"
    app = TestClient(create_app({"synthetic": workspace["cases"]}, runs_root, settings, {}))
    assert app.get("/api/report").json()["report"]["variants"] == {}
    write(workspace, "jev-rubric", [P, F, P, F, P, F])
    assert app.get("/api/report").json()["report"]["variants"]["jev-rubric"]["all"]["accuracy"] == 1.0
