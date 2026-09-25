from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, Field

# Single source of truth for fault types (prompts, analysis validation, evals).
FAULT_TYPES: tuple[str, ...] = (
    "cpu", "memory", "disk", "storage", "network-delay", "network-loss", "dns", "host-down",
    "hardware", "kernel", "bad-deploy", "config-change", "dependency-down", "db-slow-query",
    "db-connection-exhaustion", "cert-expiry", "quota/limit", "auth-failure", "code-exception",
    "app", "unknown",
)

IncidentStatus = Literal[
    "new", "cached", "queued", "investigating", "awaiting_approval", "remediating",
    "reported", "resolved", "failed", "rejected",
]
Risk = Literal["read", "write", "destructive"]
ActionStatus = Literal[
    "proposed", "blocked", "pending_approval", "approved", "rejected", "executed", "failed",
    "skipped",
]


class Incident(BaseModel):
    id: UUID
    source: Literal["pagerduty", "alertmanager", "jira", "opsgenie", "manual", "eval"]
    external_id: str | None = None
    title: str
    description: str
    service: str | None = None
    environment: Literal["prod", "staging", "dev"]
    severity: Literal["sev1", "sev2", "sev3", "sev4"]
    labels: dict[str, str]
    started_at: datetime
    received_at: datetime
    raw_payload: dict[str, Any]
    signature: str
    signature_hash: str
    status: IncidentStatus


class PlanStep(BaseModel):
    id: str
    goal: str
    tool: str
    args: dict[str, Any] = Field(default_factory=dict)
    depends_on: list[str] = Field(default_factory=list)
    status: Literal["pending", "running", "done", "failed", "skipped"] = "pending"
    iteration: int = 1


class Evidence(BaseModel):
    # Evidence ids equal the id of the plan step that produced them.
    id: str
    step_id: str
    tool: str
    summary: str
    artifact_uri: str | None = None
    pii_redacted: bool
    collected_at: datetime
    # False when the tool or summarisation failed; the summary then describes the failure.
    ok: bool = True


class Hypothesis(BaseModel):
    root_cause_component: str
    fault_type: str
    description: str
    evidence_ids: list[str]
    confidence: float = Field(ge=0.0, le=1.0)
    alternatives: list["Hypothesis"] = Field(default_factory=list)


class Approval(BaseModel):
    decision: Literal["approved", "rejected", "expired"]
    by: str
    at: datetime
    comment: str | None = None


class ProposedAction(BaseModel):
    id: str
    kind: str
    args: dict[str, Any] = Field(default_factory=dict)
    risk: Risk
    rationale: str
    requires_approval: bool
    # Final decision (None until decided). `approvals` holds each distinct approver's vote;
    # two-person actions need `required_approvals` = 2 distinct approvers.
    approval: Approval | None = None
    required_approvals: int = 1
    approvals: list[Approval] = Field(default_factory=list)
    status: ActionStatus = "proposed"
    result: str | None = None
    iteration: int = 1
    guardrail_notes: list[str] = Field(default_factory=list)


TERMINAL_STATUSES: frozenset[str] = frozenset(
    {"cached", "reported", "resolved", "failed", "rejected"}
)


class TimelineEvent(BaseModel):
    at: str
    event: str


class Verification(BaseModel):
    verified: bool
    reason: str


class Report(BaseModel):
    incident_id: UUID
    summary: str
    markdown: str
    timeline: list[TimelineEvent] = Field(default_factory=list)
    root_cause: Hypothesis | None = None
    actions_taken: list[ProposedAction] = Field(default_factory=list)
    follow_ups: list[str] = Field(default_factory=list)
    links: dict[str, str] = Field(default_factory=dict)
