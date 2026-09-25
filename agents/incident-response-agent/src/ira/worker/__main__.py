"""Orchestrator worker: consumes incident/resume messages from Redis Streams, runs the
LangGraph orchestrator, sweeps expired approvals, and serves /metrics + health."""
import asyncio
import logging
import os
import signal
import socket
from typing import Any

import uvicorn
from fastapi import FastAPI, Response
from fastapi.responses import JSONResponse
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest

from src.ira.api.services import Infra, build_infra, build_runner
from src.ira.config import Settings, settings
from src.ira.observability.logging import configure_logging
from src.ira.observability.tracing import configure_tracing
from src.ira.orchestrator.runner import IncidentRunner
from src.ira.queue.consumer import IncidentConsumer
from src.ira.queue.producer import IncidentProducer

logger = logging.getLogger("ira.worker")


def health_app(infra: Infra) -> FastAPI:
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    @app.get("/health/live")
    async def live() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/health/ready")
    async def ready() -> JSONResponse:
        checks = await infra.readiness()
        ok = all(v == "ok" for v in checks.values())
        return JSONResponse({"status": "ok" if ok else "unavailable", "checks": checks},
                            status_code=200 if ok else 503)

    @app.get("/metrics")
    async def metrics() -> Response:
        return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)

    return app


def make_handler(runner: IncidentRunner) -> Any:
    async def handle(message: dict[str, Any]) -> bool:
        kind = message.get("type", "run")
        incident_id = str(message["incident_id"])
        if kind == "resume":
            return await runner.resume(incident_id)
        return await runner.run(incident_id)

    return handle


async def sweep_approvals(runner: IncidentRunner, producer: IncidentProducer,
                          interval_s: float) -> None:
    while True:
        await asyncio.sleep(interval_s)
        try:
            for incident_id in await runner.expire_stale_approvals():
                await producer.publish_resume(incident_id)
        except Exception:
            logger.exception("Approval sweep failed")


async def main(config: Settings = settings) -> None:
    configure_logging(config)
    config.validate_for_startup()
    configure_tracing("ira-worker")
    if not (config.redis_enabled and config.queue_enabled):
        raise SystemExit("The worker needs REDIS_ENABLED=true and QUEUE_ENABLED=true")

    infra = await build_infra(config)
    assert infra.redis is not None
    runner = await build_runner(infra)
    consumer = IncidentConsumer(
        infra.redis,
        consumer_name=os.getenv("HOSTNAME") or socket.gethostname(),
        concurrency=config.worker_concurrency,
    )
    server = uvicorn.Server(uvicorn.Config(
        health_app(infra), host="0.0.0.0", port=config.worker_metrics_port,
        log_config=None, access_log=False,
    ))

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)

    tasks = [
        asyncio.create_task(consumer.consume(make_handler(runner)), name="consumer"),
        asyncio.create_task(sweep_approvals(runner, IncidentProducer(infra.redis),
                                            config.approval_sweep_interval_s), name="sweeper"),
        asyncio.create_task(server.serve(), name="health"),
    ]
    logger.info("Worker started (concurrency=%d)", config.worker_concurrency)
    stop_task = asyncio.create_task(stop.wait())
    done, _ = await asyncio.wait([*tasks, stop_task], return_when=asyncio.FIRST_COMPLETED)
    for task in done:
        if task is not stop_task and task.exception():
            logger.error("Task %s crashed: %s", task.get_name(), task.exception())

    logger.info("Shutting down")
    server.should_exit = True
    for task in tasks:
        if task.get_name() != "health":
            task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    await infra.aclose()


if __name__ == "__main__":
    asyncio.run(main())
