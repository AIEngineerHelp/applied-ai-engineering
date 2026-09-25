"""Read-only access to eval results written by evals/loghub/evaluate.py (for the Evals tab)."""
import json
import re
from pathlib import Path
from typing import Any

import yaml

from src.ira.config import settings

_RUN_ID = re.compile(r"^[A-Za-z0-9_.:-]+$")
_FILENAME = re.compile(
    r"^(?P<dataset>[a-z0-9]+)-(?P<started>[0-9T:-]+Z)(?:-seed(?P<seed>\d+))?(?P<graph>-graph)?$")
_METRICS = (
    "cases", "fault_top1_strict", "fault_top1_lenient", "fault_top3_lenient", "node_top1",
    "precision_when_confident", "confident_cases", "mean_confidence_correct",
    "mean_confidence_wrong", "baseline_majority_class", "baseline_strict", "baseline_lenient",
    "total_cost_usd", "mean_seconds", "mean_iterations", "errors", "no_hypothesis",
    "target_fault_accuracy",
)


class EvalRunNotFoundError(KeyError):
    pass


class EvalStore:
    def __init__(self, results_dir: Path | None = None, doc: Path | None = None):
        self.results_dir = results_dir or settings.evals_results_dir
        self.doc = doc or settings.evals_doc

    def methodology(self) -> str:
        return self.doc.read_text(encoding="utf-8") if self.doc.exists() else ""

    def _annotations(self) -> dict[str, dict[str, Any]]:
        path = self.results_dir / "runs.yaml"
        if not path.exists():
            return {}
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        return {str(k): v or {} for k, v in data.items()}

    def _load(self, path: Path, annotations: dict[str, dict[str, Any]]) -> dict[str, Any]:
        raw = json.loads(path.read_text(encoding="utf-8"))
        summary: dict[str, Any] = raw.get("summary", {})
        run_id = path.stem
        meta = dict(summary.get("meta") or {})
        match = _FILENAME.match(run_id)
        if match:  # runs written before metadata was recorded
            meta.setdefault("dataset", match["dataset"].upper())
            meta.setdefault("started_at", match["started"])
            meta.setdefault("seed", int(match["seed"]) if match["seed"] else None)
            meta.setdefault("knowledge_graph", bool(match["graph"]))
        note = annotations.get(run_id, {})
        return {
            "run_id": run_id,
            "dataset": meta.get("dataset", "BGL"),
            "started_at": meta.get("started_at"),
            "seed": meta.get("seed"),
            "holdout": bool(note.get("holdout", meta.get("holdout", False))),
            "exclude_seed": meta.get("exclude_seed"),
            "git_commit": meta.get("git_commit"),
            "knowledge_graph": bool(meta.get("knowledge_graph", False)),
            "label": note.get("label"),
            "notes": note.get("notes"),
            "models": summary.get("models", {}),
            "metrics": {k: summary.get(k) for k in _METRICS},
            "per_label": summary.get("per_label", {}),
            "cases": raw.get("cases", []),
        }

    def runs(self) -> list[dict[str, Any]]:
        if not self.results_dir.exists():
            return []
        notes = self._annotations()
        runs = [self._load(p, notes) for p in self.results_dir.glob("*.json")]
        for r in runs:
            r.pop("cases")
            r.pop("per_label")
        return sorted(runs, key=lambda r: r["started_at"] or "", reverse=True)

    def run(self, run_id: str) -> dict[str, Any]:
        path = self.results_dir / f"{run_id}.json"
        if not _RUN_ID.match(run_id) or not path.is_file():
            raise EvalRunNotFoundError(run_id)
        return self._load(path, self._annotations())
