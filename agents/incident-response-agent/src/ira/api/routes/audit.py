from typing import Annotated

from fastapi import APIRouter, Query

from src.ira.api.auth import Principal, require
from src.ira.api.services import ServicesDep
from src.ira.orchestrator.run import AuditEvent

router = APIRouter()


@router.get("/audit", response_model=list[AuditEvent])
async def list_audit(
    services: ServicesDep,
    _: Annotated[Principal, require("admin")],
    incident_id: str | None = None,
    limit: Annotated[int, Query(ge=1, le=1000)] = 200,
) -> list[AuditEvent]:
    return await services.store.list_audit(incident_id, limit)
