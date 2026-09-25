from fastapi import APIRouter, Response
from fastapi.responses import JSONResponse
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest

from src.ira.api.services import ServicesDep

router = APIRouter(include_in_schema=False)


@router.get("/health/live")
async def live() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/health/ready")
async def ready(services: ServicesDep) -> JSONResponse:
    checks = await services.infra.readiness()
    ok = all(v == "ok" for v in checks.values())
    return JSONResponse({"status": "ok" if ok else "unavailable", "checks": checks},
                        status_code=200 if ok else 503)


@router.get("/health")
async def health_compat() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/metrics")
async def metrics() -> Response:
    # Not routed publicly by the ingress; scraped in-cluster.
    return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)
