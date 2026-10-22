from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class PipelineRequest(BaseModel):
    subject: str | None = None
    body: str = ""
    source: str = "inbox"
    force_jev: bool = False
    skip_draft: bool = False
    sample_id: str | None = None


class StepTiming(BaseModel):
    step: str
    duration_ms: float | None
    ok: bool
    detail: str | None = None


class TimingOut(BaseModel):
    goal: str
    goal_reached: bool
    goal_reason: str
    total_ms: float
    steps: list[StepTiming]


class PipelineResponse(BaseModel):
    case_id: int | None = None
    intent: str | None = None
    urgency: float | None = None
    frustration: float | None = None
    risk: str | None = None
    next_step: str | None = None
    confidence: float | None = None
    gate_decision: Literal[
        "auto_draft",
        "jev_second_opinion",
        "ask_human",
        "blocked",
        "error",
    ]
    used_laya: bool
    used_jev: bool
    used_gemini: bool
    draft: str | None = None
    answers: dict[str, Any] = Field(default_factory=dict)
    timing: TimingOut
    message: str


class HealthResponse(BaseModel):
    status: str
    database: str
    laya: str
    jev: str
    gemini: str
    demo_mode: bool = False


class CaseOut(BaseModel):
    id: int
    created_at: str | None
    subject: str | None
    intent: str | None
    gate_decision: str | None
    goal_reached: bool
    timing_json: dict[str, Any] | None
    draft: str | None

    model_config = {"from_attributes": True}
