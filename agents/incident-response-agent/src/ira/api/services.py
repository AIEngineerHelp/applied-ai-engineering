import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Annotated, Any

from fastapi import Depends, Request
from redis.asyncio import Redis

from src.ira.cache.exact import ExactCache
from src.ira.config import Settings, settings
from src.ira.guardrails.intake import IntakeGuardrail
from src.ira.hitl.service import ApprovalService
from src.ira.knowledge.store import GraphStore
from src.ira.memory.service import MemoryService
from src.ira.orchestrator.checkpoint import build_checkpointer
from src.ira.orchestrator.dispatch import Dispatcher, LocalDispatcher, QueueDispatcher
from src.ira.orchestrator.graph import OrchestratorDeps, build_graph
from src.ira.orchestrator.intake import IntakeService
from src.ira.orchestrator.runner import IncidentRunner
from src.ira.orchestrator.store import MemoryRunStore, RunStore
from src.ira.queue.producer import IncidentProducer

logger = logging.getLogger(__name__)

Closer = Callable[[], Awaitable[Any]]


@dataclass
class Infra:
    """Connections shared by the API and the worker. Each backend is optional in dev."""

    config: Settings
    store: RunStore
    redis: Redis | None = None
    memory: MemoryService | None = None
    graph: "GraphStore | None" = None
    closers: list[Closer] = field(default_factory=list)

    async def readiness(self) -> dict[str, str]:
        checks: dict[str, str] = {}

        async def check(name: str, probe: Callable[[], Awaitable[Any]]) -> None:
            try:
                await asyncio.wait_for(probe(), timeout=3)
                checks[name] = "ok"
            except Exception as e:  # noqa: BLE001 - reported, not raised
                checks[name] = f"error: {type(e).__name__}"

        await check("store", self.store.ping)
        if self.redis is not None:
            await check("redis", self.redis.ping)
        return checks

    async def aclose(self) -> None:
        for close in reversed(self.closers):
            try:
                await close()
            except Exception:
                logger.exception("Error during shutdown")


async def build_infra(config: Settings = settings, store: RunStore | None = None) -> Infra:
    closers: list[Closer] = []
    redis = session_factory = neo4j = None
    if config.redis_enabled:
        redis = Redis.from_url(config.redis_url, health_check_interval=30)
        closers.append(redis.aclose)
    if config.postgres_enabled:
        from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

        from src.ira.orchestrator.pg_store import PostgresRunStore

        engine = create_async_engine(config.postgres_dsn, pool_pre_ping=True,
                                     pool_size=10, max_overflow=10,
                                     connect_args=config.asyncpg_connect_args())
        session_factory = async_sessionmaker(engine, expire_on_commit=False)
        closers.append(engine.dispose)
        store = store or PostgresRunStore(engine)
    if config.neo4j_enabled:
        from neo4j import AsyncGraphDatabase

        neo4j = AsyncGraphDatabase.driver(
            config.neo4j_uri, auth=(config.neo4j_user, config.neo4j_password),
            notifications_min_severity="OFF",  # "label does not exist yet" notices
        )
        closers.append(neo4j.close)

    memory = None
    if redis or session_factory or neo4j:
        memory = MemoryService(session_factory=session_factory, neo4j_driver=neo4j,
                               redis_client=redis)
    logger.info("Infra: redis=%s postgres=%s neo4j=%s", bool(redis), bool(session_factory),
                bool(neo4j))
    return Infra(config=config, store=store or MemoryRunStore(), redis=redis, memory=memory,
                 graph=GraphStore(neo4j) if neo4j is not None else None, closers=closers)


async def build_runner(
    infra: Infra, deps: OrchestratorDeps | None = None
) -> IncidentRunner:
    checkpointer, close = await build_checkpointer(infra.config)
    if close is not None:
        infra.closers.append(close)
    deps = deps or OrchestratorDeps.default(memory=infra.memory, graph=infra.graph)
    return IncidentRunner(build_graph(deps, checkpointer=checkpointer), infra.store)


async def bootstrap_graph(infra: Infra) -> None:
    """Load the log knowledge graph on first start and attach incidents already in the
    store, so the dashboard's graph works without a manual build step."""
    if infra.graph is None:
        return
    from src.ira.knowledge.build import build_and_load

    try:
        if await infra.graph.count() == 0:
            stats = await build_and_load(config=infra.config, driver=infra.graph.driver)
            logger.info("Knowledge graph built: %s nodes, %s edges",
                        stats["nodes"], stats["edges"])
        for incident in await infra.store.list_incidents(500):
            run = await infra.store.get_run(str(incident.id))
            if run is None or run.status != "completed":
                continue
            top = run.snapshot.hypotheses[0] if run.snapshot.hypotheses else None
            verified = bool(run.snapshot.verification and run.snapshot.verification.verified)
            await infra.graph.record_incident(
                incident_id=str(incident.id), title=incident.title,
                dataset=incident.labels.get("dataset"), severity=incident.severity,
                status=incident.status,
                alerted_node=incident.labels.get("node") or incident.labels.get("host"),
                root_cause=top.root_cause_component if top else None,
                fault_type=top.fault_type if top else None,
                confidence=top.confidence if top else None, verified=verified,
            )
    except Exception:
        logger.exception("Knowledge graph bootstrap failed")


@dataclass
class Services:
    infra: Infra
    dispatcher: Dispatcher
    intake: IntakeService
    approvals: ApprovalService
    tasks: list[asyncio.Task[None]] = field(default_factory=list)

    @property
    def store(self) -> RunStore:
        return self.infra.store

    async def aclose(self) -> None:
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        await self.dispatcher.close()
        await self.infra.aclose()


async def build_services(
    config: Settings = settings,
    deps: OrchestratorDeps | None = None,
    intake_guardrail: IntakeGuardrail | None = None,
    store: RunStore | None = None,
) -> Services:
    """API-side services. With the queue enabled the API only enqueues and workers run
    the graph; otherwise the graph runs in-process (development)."""
    infra = await build_infra(config, store)
    dispatcher: Dispatcher
    if config.queue_enabled:
        if infra.redis is None:
            raise RuntimeError("QUEUE_ENABLED requires REDIS_ENABLED")
        dispatcher = QueueDispatcher(IncidentProducer(infra.redis))
    else:
        local = LocalDispatcher(await build_runner(infra, deps),
                                sweep_interval_s=config.approval_sweep_interval_s)
        local.start_sweeper()
        dispatcher = local
        logger.warning("QUEUE_ENABLED=false: running the orchestrator inside the API process")

    intake = IntakeService(
        store=infra.store,
        dispatcher=dispatcher,
        guardrail=intake_guardrail or IntakeGuardrail(),
        exact_cache=ExactCache(infra.redis) if infra.redis is not None else None,
        memory=infra.memory if config.postgres_enabled else None,
        dedup_active=config.dedup_active_incidents,
    )
    services = Services(infra=infra, dispatcher=dispatcher, intake=intake,
                        approvals=ApprovalService(infra.store, dispatcher))
    if infra.graph is not None:
        services.tasks.append(asyncio.create_task(bootstrap_graph(infra)))
    return services


def get_services(request: Request) -> Services:
    services: Services = request.app.state.services
    return services


ServicesDep = Annotated[Services, Depends(get_services)]
