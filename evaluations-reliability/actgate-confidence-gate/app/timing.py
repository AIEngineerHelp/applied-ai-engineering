from __future__ import annotations

import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any, Iterator


@dataclass
class TimingSpan:
    name: str
    started_ms: float
    ended_ms: float | None = None
    ok: bool = True
    detail: str | None = None

    @property
    def duration_ms(self) -> float | None:
        if self.ended_ms is None:
            return None
        return round(self.ended_ms - self.started_ms, 2)


@dataclass
class TimingReport:
    spans: list[TimingSpan] = field(default_factory=list)
    goal: str = "decide_and_draft"
    goal_reached: bool = False
    goal_reason: str = ""

    def to_dict(self) -> dict[str, Any]:
        total = 0.0
        items = []
        for s in self.spans:
            d = s.duration_ms or 0.0
            total += d
            items.append(
                {
                    "step": s.name,
                    "duration_ms": s.duration_ms,
                    "ok": s.ok,
                    "detail": s.detail,
                }
            )
        return {
            "goal": self.goal,
            "goal_reached": self.goal_reached,
            "goal_reason": self.goal_reason,
            "total_ms": round(total, 2),
            "steps": items,
        }


class Timer:
    def __init__(self, goal: str = "decide_and_draft") -> None:
        self.report = TimingReport(goal=goal)

    @contextmanager
    def span(self, name: str) -> Iterator[TimingSpan]:
        span = TimingSpan(name=name, started_ms=time.perf_counter() * 1000)
        self.report.spans.append(span)
        try:
            yield span
        except Exception as exc:  # noqa: BLE001
            span.ok = False
            span.detail = str(exc)
            span.ended_ms = time.perf_counter() * 1000
            raise
        else:
            span.ended_ms = time.perf_counter() * 1000

    def mark_goal(self, reached: bool, reason: str) -> None:
        self.report.goal_reached = reached
        self.report.goal_reason = reason
