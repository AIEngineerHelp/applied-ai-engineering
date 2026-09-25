"""Read-only catalog of the log datasets the agent can investigate, for the UI's Logs page.

Shows people exactly what the agent sees: ground-truth label columns are hidden and log
lines are PII-scrubbed with the same scrubber the agent's tools use.
"""
import threading
from functools import lru_cache
from pathlib import Path
from typing import Any

import pandas as pd
import yaml

from src.ira.config import settings
from src.ira.guardrails.pii import PIIScrubber, get_scrubber
from src.ira.tools.log_explorer.service import LogExplorerService

# Columns that make up a readable timestamp, per dataset (the raw formats differ).
_TIME_COLUMNS: dict[str, list[str]] = {
    "BGL": ["Time"], "HPC": ["Time"], "HealthApp": ["Time"], "Apache": ["Time"],
    "Proxifier": ["Time"], "Linux": ["Month", "Date", "Time"], "Mac": ["Month", "Date", "Time"],
    "OpenSSH": ["Date", "Day", "Time"], "Thunderbird": ["Date", "Time"],
}
_DEFAULT_TIME = ["Date", "Time"]
_COMPONENT_COLUMNS = ("Component", "Program", "Process")
_INTERNAL_COLUMNS = {"ParameterList", "LineId", "EventId", "EventTemplate", "Content"}


class DatasetNotFoundError(KeyError):
    pass


class DatasetCatalog:
    def __init__(
        self,
        explorer: LogExplorerService | None = None,
        registry_file: Path | None = None,
        scrubber: PIIScrubber | None = None,
    ):
        self.explorer = explorer or LogExplorerService()
        registry = registry_file or settings.registry_dir / "datasets.yaml"
        data = yaml.safe_load(registry.read_text(encoding="utf-8"))
        self.citation: dict[str, str] = data.get("citation", {})
        self.meta: dict[str, dict[str, Any]] = data.get("datasets", {})
        self._scrubber = scrubber
        self._scrub_cache: dict[tuple[str, int], str] = {}
        self._lock = threading.Lock()

    @property
    def scrubber(self) -> PIIScrubber:
        if self._scrubber is None:
            self._scrubber = get_scrubber()
        return self._scrubber

    def names(self) -> list[str]:
        return [n for n in self.meta if self.explorer._get_csv_path(n).exists()]

    def _require(self, name: str) -> dict[str, Any]:
        if name not in self.meta or not self.explorer._get_csv_path(name).exists():
            raise DatasetNotFoundError(name)
        return self.meta[name]

    @lru_cache(maxsize=32)  # noqa: B019 - catalog is a long-lived singleton; files are static
    def _frame(self, name: str) -> pd.DataFrame:
        df = self.explorer.load_logs(name)
        cols = [c for c in _TIME_COLUMNS.get(name, _DEFAULT_TIME) if c in df.columns]
        df["_time"] = df[cols].astype(str).agg(" ".join, axis=1) if cols else ""
        comp = next((c for c in _COMPONENT_COLUMNS if c in df.columns), None)
        df["_component"] = df[comp].astype(str) if comp else ""
        df["_level"] = df["Level"].astype(str) if "Level" in df.columns else ""
        return df

    def _scrub(self, name: str, line_id: int, text: str) -> str:
        key = (name, line_id)
        with self._lock:
            cached = self._scrub_cache.get(key)
        if cached is None:
            cached = self.scrubber.scrub(text)
            with self._lock:
                self._scrub_cache[key] = cached
        return cached

    def summary(self, name: str) -> dict[str, Any]:
        meta = self._require(name)
        df = self._frame(name)
        templates = df.groupby(["EventId", "EventTemplate"]).size().sort_values(ascending=False)
        levels = df["_level"].value_counts().to_dict() if (df["_level"] != "").any() else {}
        return {
            "name": name,
            "title": meta.get("title", name),
            "category": meta.get("category"),
            "description": " ".join(str(meta.get("description", "")).split()),
            "source_url": f"{self.citation.get('repository', 'https://github.com/logpai/loghub')}"
                          f"/tree/master/{name}",
            "lines": len(df),
            "event_types": int(templates.shape[0]),
            "time_start": str(df["_time"].iloc[0]) if len(df) else None,
            "time_end": str(df["_time"].iloc[-1]) if len(df) else None,
            "columns": [c for c in df.columns
                        if not c.startswith("_") and c not in _INTERNAL_COLUMNS],
            "levels": {str(k): int(v) for k, v in levels.items()},
            "top_templates": [
                {"event_id": eid, "template": tpl, "count": int(n)}
                for (eid, tpl), n in templates.head(5).items()
            ],
            "suggested_incidents": meta.get("suggested", []),
        }

    def all(self) -> list[dict[str, Any]]:
        return [self.summary(n) for n in self.names()]

    def logs(
        self, name: str, q: str | None = None, event_id: str | None = None,
        level: str | None = None, component: str | None = None,
        offset: int = 0, limit: int = 100,
    ) -> dict[str, Any]:
        self._require(name)
        df = self._frame(name)
        if q:
            df = df[df["Content"].astype(str).str.contains(q, case=False, regex=False, na=False)]
        if event_id:
            df = df[df["EventId"] == event_id]
        if level:
            df = df[df["_level"].str.lower() == level.lower()]
        if component:
            df = df[df["_component"] == component]
        page = df.iloc[offset: offset + limit]
        return {
            "dataset": name,
            "total": len(df),
            "offset": offset,
            "limit": limit,
            "pii_redacted": True,
            "lines": [
                {
                    "line_id": int(r["LineId"]),
                    "time": str(r["_time"]),
                    "level": str(r["_level"]) or None,
                    "component": str(r["_component"]) or None,
                    "event_id": str(r["EventId"]),
                    "template": str(r["EventTemplate"]),
                    "content": self._scrub(name, int(r["LineId"]), str(r["Content"])),
                }
                # dict records: itertuples() renames "_"-prefixed columns
                for r in page.to_dict("records")
            ],
        }

    def templates(self, name: str, q: str | None = None) -> list[dict[str, Any]]:
        self._require(name)
        df = self._frame(name)
        grouped = (df.groupby(["EventId", "EventTemplate"])
                   .agg(count=("LineId", "size"), first_line=("LineId", "min"),
                        levels=("_level", lambda s: sorted({x for x in s if x})))
                   .reset_index().sort_values("count", ascending=False))
        if q:
            grouped = grouped[grouped["EventTemplate"].str.contains(q, case=False, regex=False)]
        return [
            {"event_id": r["EventId"], "template": r["EventTemplate"], "count": int(r["count"]),
             "share": round(int(r["count"]) / len(df), 4), "levels": list(r["levels"]),
             "first_line": int(r["first_line"])}
            for r in grouped.to_dict("records")
        ]
