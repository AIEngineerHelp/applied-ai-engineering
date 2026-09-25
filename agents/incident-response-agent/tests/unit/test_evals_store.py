import json
from pathlib import Path

import pytest

from src.ira.evals_store import EvalRunNotFoundError, EvalStore


def write_run(d: Path, name: str, meta: dict | None = None) -> None:  # type: ignore[type-arg]
    summary = {"cases": 2, "fault_top1_lenient": 0.5, "models": {"planner": "m"},
               "per_label": {"KERNSTOR": {"n": 2, "lenient": 1, "strict": 0}}}
    if meta:
        summary["meta"] = meta
    (d / f"{name}.json").write_text(json.dumps({"summary": summary, "cases": [{"case_id": "c1"}]}))


def test_lists_runs_with_annotations_and_legacy_names(tmp_path: Path) -> None:
    write_run(tmp_path, "bgl-2026-09-24T15-04-35Z")
    write_run(tmp_path, "bgl-2026-09-25T10-00-00Z-seed21",
              {"dataset": "BGL", "started_at": "2026-09-25T10-00-00Z", "seed": 21,
               "holdout": True, "exclude_seed": 7, "git_commit": "abc123"})
    (tmp_path / "runs.yaml").write_text("bgl-2026-09-24T15-04-35Z:\n  label: Baseline\n")
    doc = tmp_path / "evals.md"
    doc.write_text("# Evaluating the agent")
    store = EvalStore(tmp_path, doc)

    runs = store.runs()
    assert [r["run_id"] for r in runs] == ["bgl-2026-09-25T10-00-00Z-seed21",
                                           "bgl-2026-09-24T15-04-35Z"]
    assert runs[0]["holdout"] and runs[0]["seed"] == 21 and runs[0]["git_commit"] == "abc123"
    assert runs[1]["label"] == "Baseline" and runs[1]["dataset"] == "BGL"
    assert runs[1]["metrics"]["fault_top1_lenient"] == 0.5
    assert "cases" not in runs[0]
    detail = store.run("bgl-2026-09-24T15-04-35Z")
    assert detail["cases"] == [{"case_id": "c1"}] and "KERNSTOR" in detail["per_label"]
    assert store.methodology().startswith("# Evaluating")


@pytest.mark.parametrize("bad", ["../../etc/passwd", "nope", "a/b"])
def test_rejects_unknown_or_traversal(tmp_path: Path, bad: str) -> None:
    with pytest.raises(EvalRunNotFoundError):
        EvalStore(tmp_path, tmp_path / "x.md").run(bad)
