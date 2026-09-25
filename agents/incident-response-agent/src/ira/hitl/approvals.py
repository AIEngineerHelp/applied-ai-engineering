from typing import Any

from src.ira.models.incident import ProposedAction, Risk
from src.ira.orchestrator.run import DecisionRecord
from src.ira.registry.tools import ToolManifest


def requires_approval(manifest: ToolManifest | None, risk: Risk) -> bool:
    """Approval policy. Fails closed: unknown tools and anything non-read need a human,
    whatever the manifest says. Only registered read tools with approval "none" run
    unattended."""
    if manifest is None:
        return True
    if risk != "read":
        return True
    return manifest.approval != "none"


def required_approvals(manifest: ToolManifest | None, risk: Risk) -> int:
    """Two distinct approvers for destructive actions or manifests that ask for it."""
    if manifest is None or risk == "destructive" or manifest.approval == "two_person":
        return 2
    return 1


def final_decision(
    action: ProposedAction, decisions: list[DecisionRecord]
) -> dict[str, Any] | None:
    """The resume payload for the approval node once the decision is final, else None.
    Any rejection or expiry is final; approval needs `required_approvals` distinct people."""
    votes = [
        {"decision": d.decision, "by": d.actor, "at": d.at.isoformat(), "comment": d.comment}
        for d in decisions
    ]
    veto = next((d for d in decisions if d.decision in ("rejected", "expired")), None)
    if veto is not None:
        return {"decision": veto.decision, "by": veto.actor, "at": veto.at.isoformat(),
                "comment": veto.comment, "approvals": votes}
    approvers = [d for d in decisions if d.decision == "approved"]
    if len({d.actor for d in approvers}) >= action.required_approvals:
        last = approvers[-1]
        return {"decision": "approved", "by": ", ".join(d.actor for d in approvers),
                "at": last.at.isoformat(), "comment": last.comment, "approvals": votes}
    return None
