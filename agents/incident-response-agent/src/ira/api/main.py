import logging
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from src.ira.api.auth import Authenticator
from src.ira.api.routes import (
    approvals,
    audit,
    datasets,
    evals,
    graph,
    health,
    incidents,
    meta,
    ui,
)
from src.ira.api.services import Services, build_services
from src.ira.config import Settings, settings
from src.ira.observability.logging import configure_logging
from src.ira.observability.tracing import configure_tracing

logger = logging.getLogger(__name__)

_SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
}


def create_app(
    services_factory: Callable[[], Awaitable[Services]] | None = None,
    config: Settings = settings,
) -> FastAPI:
    config.validate_for_startup()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        factory = services_factory or (lambda: build_services(config))
        app.state.services = await factory()
        try:
            yield
        finally:
            await app.state.services.aclose()

    app = FastAPI(
        title="Incident Response Agent API",
        description="API for the Incident Response Agent",
        version="0.1.0",
        lifespan=lifespan,
        # Interactive docs are a development convenience only.
        docs_url=None if config.is_prod else "/docs",
        redoc_url=None,
        openapi_url=None if config.is_prod else "/openapi.json",
    )
    app.state.authenticator = Authenticator(config)

    @app.middleware("http")
    async def guard(request: Request, call_next: Callable[[Request], Awaitable[Response]]
                    ) -> Response:
        request_id = request.headers.get("x-request-id") or uuid.uuid4().hex
        length = request.headers.get("content-length")
        if length and length.isdigit() and int(length) > config.max_request_bytes:
            return JSONResponse({"detail": "Request body too large"}, status_code=413)
        try:
            response = await call_next(request)
        except Exception:
            logger.exception("Unhandled error on %s %s (request_id=%s)",
                             request.method, request.url.path, request_id)
            response = JSONResponse({"detail": "Internal server error",
                                     "request_id": request_id}, status_code=500)
        response.headers["X-Request-ID"] = request_id
        for header, value in _SECURITY_HEADERS.items():
            # Swagger UI (dev only) needs scripts, so its pages skip the strict CSP.
            if header == "Content-Security-Policy" and request.url.path.startswith("/docs"):
                continue
            response.headers.setdefault(header, value)
        return response

    app.add_middleware(
        CORSMiddleware,
        allow_origins=config.cors_origins,
        allow_credentials=False,  # bearer tokens, no cookies
        allow_methods=["GET", "POST"],
        allow_headers=["Authorization", "Content-Type", "X-Request-ID"],
        expose_headers=["X-Request-ID"],
    )
    app.include_router(incidents.router, prefix="/v1")
    app.include_router(approvals.router, prefix="/v1")
    app.include_router(audit.router, prefix="/v1")
    app.include_router(datasets.router, prefix="/v1")
    app.include_router(evals.router, prefix="/v1")
    app.include_router(graph.router, prefix="/v1")
    app.include_router(meta.router, prefix="/v1")
    app.include_router(health.router)
    app.include_router(ui.router)
    configure_tracing("ira-api", app)
    return app


def _default_app() -> FastAPI:
    configure_logging(settings)
    return create_app()


app = _default_app()
