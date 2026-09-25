from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Query, Response, status

from src.ira.api.auth import Principal, require
from src.ira.api.services import ServicesDep
from src.ira.models.incident import Incident
from src.ira.orchestrator.graph import NODES
from src.ira.orchestrator.intake import IncidentPayload

router = APIRouter()

Viewer = Annotated[Principal, require("viewer")]
Creator = Annotated[Principal, require("responder", allow_intake=True)]


@router.get("/incidents", response_model=list[Incident])
async def list_incidents(
    services: ServicesDep, _: Viewer, limit: Annotated[int, Query(ge=1, le=500)] = 200,
) -> list[Incident]:
    return await services.store.list_incidents(limit)


@router.get("/incidents/{incident_id}")
async def get_incident_details(
    incident_id: str, services: ServicesDep, _: Viewer
) -> dict[str, Any]:
    incident = await services.store.get_incident(incident_id)
    run = await services.store.get_run(incident_id)
    if incident is None or run is None:
        raise HTTPException(status_code=404, detail="Incident not found")
    snap = run.snapshot
    actions = []
    for a in snap.proposed_actions:
        if a.status == "pending_approval":
            # Votes cast so far live in the decisions table until the run resumes.
            votes = await services.store.decisions(a.id)
            a = a.model_copy(update={"approvals": [
                {"decision": v.decision, "by": v.actor, "at": v.at, "comment": v.comment}
                for v in votes
            ]})
        actions.append(a)
    return {
        "incident": incident,
        "run": {
            "status": run.status,
            "current_node": run.current_node,
            "nodes": NODES,
            "history": run.history,
            "activity": run.activity,
            "iterations": snap.iterations,
            "error": run.error,
            "cache": run.cache,
            "budget_used_usd": snap.budget_used_usd,
        },
        "plan": snap.plan,
        "evidence": snap.evidence,
        "hypotheses": snap.hypotheses,
        "actions": actions,
        "verification": snap.verification,
        "report": snap.report,
    }


@router.post("/incidents", response_model=Incident, status_code=status.HTTP_201_CREATED)
async def create_incident(
    payload: IncidentPayload, services: ServicesDep, principal: Creator, response: Response,
) -> Incident:
    incident, created = await services.intake.submit(payload, actor=principal.actor)
    if not created:
        response.status_code = status.HTTP_200_OK
    return incident
