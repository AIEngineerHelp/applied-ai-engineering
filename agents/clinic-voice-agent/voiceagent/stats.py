"""Aggregates for the dashboard: latency by component, end status, tools, CRM, cost.

These are the questions asked of a voice deployment every day: where the seconds go
between the caller going quiet and the agent answering, how calls end, which tools
fail, and what a minute costs.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from typing import Any

from .store import CallStore

# (event field, label) in the order a turn happens.
LATENCY_PARTS = [
    ("end_of_turn_delay", "End of turn"),
    ("transcription_delay", "Transcript"),
    ("llm_node_ttft", "LLM first token"),
    ("tts_node_ttfb", "TTS first audio"),
    ("e2e_latency", "Caller hears reply"),
]


def percentile(values: list[float], q: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    k = (len(ordered) - 1) * q
    lo, hi = int(k), min(int(k) + 1, len(ordered) - 1)
    return round(ordered[lo] + (ordered[hi] - ordered[lo]) * (k - lo), 1)


def summarize(store: CallStore, source: str | None = None) -> dict[str, Any]:
    calls = [c for c in store.list_calls(limit=1000) if source is None or c["source"] == source]
    ids = {c["id"] for c in calls}
    by_pipeline: dict[str, dict[str, Any]] = {}
    for pipeline in sorted({c["pipeline"] for c in calls}):
        group = [c for c in calls if c["pipeline"] == pipeline]
        ended = [c for c in group if c["ended_at"]]
        minutes = sum(c["ended_at"] - c["started_at"] for c in ended) / 60
        cost = sum(c["cost_usd"] or 0 for c in ended)
        by_pipeline[pipeline] = {
            "calls": len(group),
            "end_status": dict(Counter(c["end_status"] or "in_progress" for c in group)),
            "minutes": round(minutes, 2),
            "cost_usd": round(cost, 4),
            "cost_per_minute": round(cost / minutes, 4) if minutes else None,
            "latency": {},
        }

    samples: dict[tuple[str, str], list[float]] = defaultdict(list)
    for e in store.events_of_kind("turn_metrics"):
        if e["call_id"] not in ids:
            continue
        for key, _ in LATENCY_PARTS:
            if isinstance(e.get(key), (int, float)):
                samples[(e["pipeline"], key)].append(e[key])
    for (pipeline, key), values in samples.items():
        if pipeline in by_pipeline:
            by_pipeline[pipeline]["latency"][key] = {
                "p50": percentile(values, 0.5), "p95": percentile(values, 0.95), "n": len(values)}

    tools: dict[str, Counter[str]] = defaultdict(Counter)
    tool_ms: dict[str, list[float]] = defaultdict(list)
    for e in store.events_of_kind("tool"):
        if e["call_id"] in ids:
            tools[e["name"]][e["outcome"]] += 1
            if e.get("ms"):
                tool_ms[e["name"]].append(e["ms"])
    crm = Counter(e["outcome"] for e in store.events_of_kind("crm_attempt") if e["call_id"] in ids)
    guards = Counter(e["name"] for e in store.events_of_kind("guard") if e["call_id"] in ids)

    return {
        "calls": len(calls),
        "pipelines": by_pipeline,
        "latency_parts": [{"key": k, "label": label} for k, label in LATENCY_PARTS],
        "tools": {name: {"outcomes": dict(c), "total": sum(c.values()),
                         "p50_ms": percentile(tool_ms[name], 0.5)}
                  for name, c in sorted(tools.items())},
        "crm_attempts": dict(crm),
        "guards": dict(guards),
    }
