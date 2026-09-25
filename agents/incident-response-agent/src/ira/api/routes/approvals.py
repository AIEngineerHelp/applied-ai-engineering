from typing import Annotated, Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from src.ira.api.auth import Principal, require
from src.ira.api.services import ServicesDep
from src.ira.hitl.service import (
    DecisionConflictError,
    DecisionForbiddenError,
    UnknownActionError,
)

router = APIRouter()


class ApprovalDecision(BaseModel):
    # Identity comes from the access token; a client-supplied "by" is rejected.
    model_config = ConfigDict(extra="forbid")

    decision: Literal["approved", "rejected"]
    comment: str | None = Field(default=None, max_length=2000)


@router.get("/approvals/pending")
async def get_pending_approvals(
    services: ServicesDep, _: Annotated[Principal, require("viewer")]
) -> list[dict[str, Any]]:
    return await services.approvals.pending()


@router.post("/approvals/{action_id}/decision")
async def make_decision(
    action_id: str, payload: ApprovalDecision, services: ServicesDep,
    principal: Annotated[Principal, require("approver")],
) -> dict[str, Any]:
    try:
        outcome, decision = await services.approvals.decide(
            action_id, payload.decision, principal, payload.comment
        )
    except UnknownActionError:
        raise HTTPException(status_code=404, detail="Pending approval not found") from None
    except DecisionConflictError as e:
        raise HTTPException(status_code=409, detail=str(e)) from None
    except DecisionForbiddenError as e:
        raise HTTPException(status_code=403, detail=str(e)) from None
    return {"status": outcome, "decision": decision}
