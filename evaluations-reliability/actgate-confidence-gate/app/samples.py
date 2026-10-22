from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SAMPLE_PATH = ROOT / "data" / "sample_tickets.json"


@lru_cache
def load_samples() -> tuple[dict, ...]:
    rows = json.loads(SAMPLE_PATH.read_text(encoding="utf-8"))
    return tuple(rows)


def public_samples() -> list[dict]:
    return [
        {
            "id": row["id"],
            "subject": row["subject"],
            "body": row["body"],
            "expect_hint": row.get("expect_hint", ""),
            "force_jev": bool(row.get("force_jev")),
            "skip_draft": bool(row.get("skip_draft")),
        }
        for row in load_samples()
    ]


def get_sample(sample_id: str) -> dict | None:
    for row in load_samples():
        if row["id"] == sample_id:
            return row
    return None
