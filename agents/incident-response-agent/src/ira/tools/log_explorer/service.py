import ast
import re
from pathlib import Path
from typing import Any

import pandas as pd

from src.ira.config import settings

# Ground-truth anomaly labels in Loghub (e.g. BGL "Label") must never reach the agent,
# otherwise evals measure label leakage instead of diagnosis.
_HIDDEN_COLUMNS = {"Label"}
_DATASET_RE = re.compile(r"^[A-Za-z0-9_]+$")


class LogExplorerService:
    def __init__(self, base_dir: Path | None = None):
        self.base_dir = base_dir or settings.loghub_dir

    def _get_csv_path(self, dataset: str) -> Path:
        if not _DATASET_RE.match(dataset):
            raise ValueError(f"Invalid dataset name: {dataset!r}")
        # Hadoop -> Hadoop/Hadoop_2k.log_structured.csv
        return self.base_dir / dataset / f"{dataset}_2k.log_structured.csv"

    def columns(self, dataset: str) -> list[str]:
        """Filterable columns of a dataset (label and internal columns excluded)."""
        path = self._get_csv_path(dataset)
        if not path.exists():
            return []
        header = pd.read_csv(path, nrows=0).columns
        return [c for c in header
                if c not in _HIDDEN_COLUMNS and c not in ("LineId", "ParameterList")]

    def load_logs(self, dataset: str, limit: int = 2000) -> pd.DataFrame:
        path = self._get_csv_path(dataset)
        if not path.exists():
            raise FileNotFoundError(f"Logs for dataset {dataset} not found at {path}")
        df = pd.read_csv(path, nrows=limit)
        return df.drop(columns=[c for c in _HIDDEN_COLUMNS if c in df.columns])

    def get_event_distribution(
        self, dataset: str, filters: dict[str, Any] | None = None, limit: int | None = None
    ) -> list[dict[str, Any]]:
        """Group identical templates (EventId) into a frequency histogram."""
        df = self.load_logs(dataset)
        for col, val in (filters or {}).items():
            if col not in df.columns:
                raise ValueError(
                    f"Unknown filter column {col!r}; available: {sorted(df.columns)}"
                )
            matched = df[df[col].astype(str).str.contains(str(val), case=False, na=False,
                                                          regex=False)]
            if matched.empty:
                # An empty result usually means a wrong filter value, not a silent host.
                # Say so, and show real values so the next step can correct the filter.
                examples = df[col].astype(str).value_counts().head(10).index.tolist()
                return [{"no_matches": True, "filter": {col: str(val)},
                         "note": f"No log lines have {col} containing {str(val)!r}. This "
                                 "usually means the filter value is wrong or absent from "
                                 "this dataset; it is not evidence the component is down.",
                         f"most_common_{col}_values": examples}]
            df = matched

        grouped = df.groupby(["EventId", "EventTemplate"]).size().reset_index(name="count")
        grouped = grouped.sort_values(by="count", ascending=False)
        records: list[dict[str, Any]] = grouped.to_dict(orient="records")
        return records[:limit] if limit else records

    def drill_down_event(self, dataset: str, event_id: str) -> dict[str, Any]:
        """Expand one event template and show the variance of its parameters."""
        df = self.load_logs(dataset)
        event_df = df[df["EventId"] == event_id]

        if event_df.empty:
            return {"event_id": event_id, "template": "", "count": 0, "parameter_variances": {}}

        template = event_df.iloc[0]["EventTemplate"]

        # Loghub-2.0 ParameterList holds a list literal: "['val1', 'val2']"
        param_variances: dict[int, list[str]] = {}
        for param_str in event_df.get("ParameterList", pd.Series(dtype=str)):
            try:
                params = ast.literal_eval(param_str)
            except (ValueError, SyntaxError):
                continue
            if isinstance(params, list):
                for idx, p in enumerate(params):
                    param_variances.setdefault(idx, []).append(str(p))

        variance_analysis = {}
        for idx, values in param_variances.items():
            value_counts = pd.Series(values).value_counts()
            variance_analysis[f"param_{idx}"] = {
                "unique_values_count": len(value_counts),
                "distribution": value_counts.head(20).to_dict(),
            }

        return {
            "event_id": event_id,
            "template": template,
            "count": len(event_df),
            "parameter_variances": variance_analysis,
        }
