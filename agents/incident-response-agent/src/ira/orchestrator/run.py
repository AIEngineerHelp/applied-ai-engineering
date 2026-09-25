from datetime import UTC, datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

from src.ira.models.incident import (
    Evidence,
    Hypothesis,
    PlanStep,
    ProposedAction,
    Report,
    Verification,
)

RunStatus = Literal["queued", "running", "awaiting_approval", "completed", "failed", "cached"]


def utcnow() -> datetime:
    return datetime.now(UTC)


class NodeRun(BaseModel):
    node: str
    status: Literal["running", "completed", "failed", "interrupted"]
    started_at: datetime
    duration_ms: int | None = None
    error: str | None = None
    iteration: int = 0


class ActivityEntry(BaseModel):
    """One line of the live 'what is the agent doing' feed."""

    at: datetime
    node: str
    message: str
    iteration: int = 0


MAX_ACTIVITY = 200


class CacheHit(BaseModel):
    kind: Literal["exact", "semantic"]
    score: float | None = None
    source_incident_id: str | None = None


class RunSnapshot(BaseModel):
    """The user-visible part of the graph state, persisted after every node."""

    context: dict[str, Any] = Field(default_factory=dict)
    plan: list[PlanStep] = Field(default_factory=list)
    evidence: list[Evidence] = Field(default_factory=list)
    hypotheses: list[Hypothesis] = Field(default_factory=list)
    proposed_actions: list[ProposedAction] = Field(default_factory=list)
    iterations: int = 0
    budget_used_usd: float = 0.0
    verification: Verification | None = None
    report: Report | None = None

    def apply(self, update: dict[str, Any]) -> None:
        for key, value in update.items():
            if key in type(self).model_fields:
                setattr(self, key, value)


class Run(BaseModel):
    """Persisted run document for one incident."""

    status: RunStatus = "queued"
    current_node: str | None = None
    history: list[NodeRun] = Field(default_factory=list)
    activity: list[ActivityEntry] = Field(default_factory=list)
    snapshot: RunSnapshot = Field(default_factory=RunSnapshot)
    error: str | None = None
    cache: CacheHit | None = None
    awaiting_action_id: str | None = None
    pending_since: dict[str, datetime] = Field(default_factory=dict)
    updated_at: datetime = Field(default_factory=utcnow)

    def find_action(self, action_id: str) -> ProposedAction | None:
        return next((a for a in self.snapshot.proposed_actions if a.id == action_id), None)


class DecisionRecord(BaseModel):
    incident_id: str
    action_id: str
    decision: Literal["approved", "rejected", "expired"]
    actor: str
    at: datetime
    comment: str | None = None


class AuditEvent(BaseModel):
    id: int
    at: datetime
    actor: str
    action: str
    incident_id: str | None = None
    details: dict[str, Any] = Field(default_factory=dict)
