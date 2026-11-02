"""Exports from the call log: one call as a JSON file, or the call list as CSV.

The callers are patients, so by default an export leaves out what identifies them or what
they said: phone numbers, transcript text, tool arguments and results, and the summary.
`content=True` keeps everything, for a developer debugging their own test calls.
"""

from __future__ import annotations

import copy
import csv
import io
from collections import Counter, defaultdict
from datetime import datetime
from typing import Any

from .stats import percentile
from .store import CallStore

# Fields that carry who a caller is or what they said, wherever they appear.
CONTENT_FIELDS = {"text", "args", "result", "phone", "caller_phone", "phrase", "reason",
                  "error", "summary", "participant"}

EXPORT_VERSION = 1


def redact(value: Any) -> Any:
    """Drop content fields at any depth of an event's data or a post-call record."""
    if isinstance(value, dict):
        return {k: redact(v) for k, v in value.items() if k not in CONTENT_FIELDS}
    if isinstance(value, list):
        return [redact(v) for v in value]
    return value


def call_export(call: dict[str, Any], *, content: bool) -> dict[str, Any]:
    """One call as a self-contained document: the call row, its post-call record, every
    event in order, and the latency per turn."""
    call = copy.deepcopy(call)
    events = call.pop("events", [])
    record = call.pop("summary", None)
    turns = [e["data"] for e in events if e["kind"] == "turn_metrics"]
    if not content:
        call["caller_phone"] = None
        record = redact(record) if record else record
        events = [{**e, "data": redact(e["data"])} for e in events
                  if e["kind"] not in ("transcript", "agent_say")]
    return {
        "export_version": EXPORT_VERSION,
        "exported_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "content_included": content,
        "call": call,
        "post_call": record,
        "turn_latency_ms": turns,
        "events": events,
    }


CSV_COLUMNS = ["call_id", "started_at", "source", "scenario", "patient_id", "caller_phone",
               "pipeline", "llm", "end_status", "intent", "transfer_to", "guard",
               "duration_s", "turns", "reply_latency_p50_ms", "reply_latency_p95_ms",
               "tool_calls", "crm_attempts", "crm_failed_attempts", "cost_usd"]


def calls_csv(store: CallStore, *, source: str | None = None, content: bool = False) -> str:
    """The call log as CSV, one row per call, with per-call latency and CRM counts."""
    calls = [c for c in store.list_calls(limit=5000) if source is None or c["source"] == source]
    latency: dict[str, list[float]] = defaultdict(list)
    for e in store.events_of_kind("turn_metrics", limit=100_000):
        if isinstance(e.get("e2e_latency"), (int, float)):
            latency[e["call_id"]].append(e["e2e_latency"])
    tools = Counter(e["call_id"] for e in store.events_of_kind("tool", limit=100_000))
    crm = store.events_of_kind("crm_attempt", limit=100_000)
    attempts = Counter(e["call_id"] for e in crm)
    failed = Counter(e["call_id"] for e in crm if e.get("outcome") != "ok")
    turns = Counter(e["call_id"] for e in store.events_of_kind("transcript", limit=100_000)
                    if e.get("role") == "user")

    out = io.StringIO()
    writer = csv.DictWriter(out, fieldnames=CSV_COLUMNS)
    writer.writeheader()
    for c in calls:
        record = c.get("summary") or {}
        samples = latency.get(c["id"], [])
        writer.writerow({
            "call_id": c["id"],
            "started_at": datetime.fromtimestamp(c["started_at"]).astimezone()
            .isoformat(timespec="seconds"),
            "source": c["source"],
            "scenario": c["scenario"] or "",
            "patient_id": c["patient_id"] or "",
            "caller_phone": (c["caller_phone"] or "") if content else "",
            "pipeline": c["pipeline"],
            "llm": (c.get("models") or {}).get("llm", ""),
            "end_status": c["end_status"] or "in_progress",
            "intent": record.get("intent", ""),
            "transfer_to": c["transfer_to"] or "",
            "guard": record.get("guard") or "",
            "duration_s": round(c["ended_at"] - c["started_at"], 1) if c["ended_at"] else "",
            "turns": turns.get(c["id"], 0),
            "reply_latency_p50_ms": percentile(samples, 0.5) if samples else "",
            "reply_latency_p95_ms": percentile(samples, 0.95) if samples else "",
            "tool_calls": tools.get(c["id"], 0),
            "crm_attempts": attempts.get(c["id"], 0),
            "crm_failed_attempts": failed.get(c["id"], 0),
            "cost_usd": c["cost_usd"] if c["cost_usd"] is not None else "",
        })
    return out.getvalue()
