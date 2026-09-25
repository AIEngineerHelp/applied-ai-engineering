from typing import Any, TypedDict

from src.ira.models.incident import (
    Evidence,
    Hypothesis,
    Incident,
    PlanStep,
    ProposedAction,
    Report,
    Verification,
)


class IncidentState(TypedDict):
    incident: Incident
    context: dict[str, Any]
    # Accumulates across iterations; PlanStep.iteration tells rounds apart.
    plan: list[PlanStep]
    evidence: list[Evidence]
    # Latest analysis only, sorted by confidence (highest first).
    hypotheses: list[Hypothesis]
    # Accumulates across iterations; ProposedAction.iteration tells rounds apart.
    proposed_actions: list[ProposedAction]
    iterations: int
    budget_used_usd: float
    verification: Verification | None
    report: Report | None
    status: str


def initial_state(incident: Incident) -> IncidentState:
    return IncidentState(
        incident=incident,
        context={},
        plan=[],
        evidence=[],
        hypotheses=[],
        proposed_actions=[],
        iterations=0,
        budget_used_usd=0.0,
        verification=None,
        report=None,
        status="started",
    )
