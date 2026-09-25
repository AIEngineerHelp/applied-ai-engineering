from typing import Any, Literal

from src.ira.api.auth import Principal
from src.ira.hitl.approvals import final_decision
from src.ira.orchestrator.dispatch import Dispatcher
from src.ira.orchestrator.run import DecisionRecord, utcnow
from src.ira.orchestrator.store import DuplicateDecisionError, RunStore


class UnknownActionError(KeyError):
    pass


class DecisionConflictError(RuntimeError):
    pass


class DecisionForbiddenError(PermissionError):
    pass


class ApprovalService:
    def __init__(self, store: RunStore, dispatcher: Dispatcher):
        self.store = store
        self.dispatcher = dispatcher

    async def pending(self) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for incident, run in await self.store.awaiting_approval():
            for a in run.snapshot.proposed_actions:
                if a.status != "pending_approval":
                    continue
                votes = await self.store.decisions(a.id)
                if final_decision(a, votes) is not None:
                    continue  # decided; the worker is resuming it
                out.append({
                    "action_id": a.id,
                    "incident_id": str(incident.id),
                    "incident_title": incident.title,
                    "severity": incident.severity,
                    "service": incident.service,
                    "kind": a.kind,
                    "args": a.args,
                    "risk": a.risk,
                    "rationale": a.rationale,
                    "created_at": run.pending_since.get(a.id, run.updated_at),
                    "required_approvals": a.required_approvals,
                    "approvals": [
                        {"decision": v.decision, "by": v.actor, "at": v.at, "comment": v.comment}
                        for v in votes
                    ],
                })
        return sorted(out, key=lambda p: p["created_at"])

    async def decide(
        self, action_id: str, decision: Literal["approved", "rejected"],
        principal: Principal, comment: str | None,
    ) -> tuple[Literal["accepted", "recorded"], dict[str, Any]]:
        found = await self.store.find_action(action_id)
        if found is None:
            raise UnknownActionError(action_id)
        incident, _, action = found
        if action.status != "pending_approval":
            raise DecisionConflictError(f"Action {action_id} is already {action.status}")
        votes = await self.store.decisions(action_id)
        if final_decision(action, votes) is not None:
            raise DecisionConflictError(f"Action {action_id} is already decided")
        if any(v.actor == principal.actor for v in votes):
            raise DecisionForbiddenError(
                "You already voted on this action; a different approver is required")

        record = DecisionRecord(
            incident_id=str(incident.id), action_id=action_id, decision=decision,
            actor=principal.actor, at=utcnow(), comment=comment,
        )
        try:
            await self.store.add_decision(record)
        except DuplicateDecisionError:
            raise DecisionForbiddenError(
                "You already voted on this action; a different approver is required") from None
        await self.store.audit(principal.actor, f"approval.{decision}", str(incident.id), {
            "action_id": action_id, "kind": action.kind, "risk": action.risk,
            "comment": comment,
        })

        final = final_decision(action, [*votes, record])
        if final is not None:
            await self.dispatcher.resume(str(incident.id))
            return "accepted", {"action_id": action_id, **final}
        return "recorded", {
            "action_id": action_id, "decision": decision, "by": principal.actor,
            "at": record.at.isoformat(), "comment": comment,
            "required_approvals": action.required_approvals,
        }
