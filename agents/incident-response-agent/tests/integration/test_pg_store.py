"""Runs the real Alembic migration and PostgresRunStore against Postgres+pgvector.
Needs Docker (always available in CI); skipped locally when Docker is not running."""
import asyncio
import subprocess
import sys
from collections.abc import AsyncIterator, Iterator
from typing import Any

import pytest

from src.ira.orchestrator.run import DecisionRecord, Run, utcnow
from src.ira.orchestrator.store import DuplicateDecisionError, DuplicateIncidentError
from tests.fakes import make_incident


def _docker_available() -> bool:
    try:
        import docker

        docker.from_env().ping()
        return True
    except Exception:  # noqa: BLE001
        return False


pytestmark = pytest.mark.skipif(not _docker_available(), reason="Docker not available")


@pytest.fixture(scope="module")
def pg_env() -> Iterator[dict[str, str]]:
    from testcontainers.postgres import PostgresContainer

    with PostgresContainer("pgvector/pgvector:pg16", username="ira", password="p@ss:w/rd",
                           dbname="ira") as pg:
        env = {"POSTGRES_HOST": pg.get_container_host_ip(),
               "POSTGRES_PORT": str(pg.get_exposed_port(5432)),
               "POSTGRES_USER": "ira", "POSTGRES_PASSWORD": "p@ss:w/rd", "POSTGRES_DB": "ira"}
        subprocess.run([sys.executable, "-m", "alembic", "upgrade", "head"], check=True,
                       env={**__import__("os").environ, **env})
        yield env


@pytest.fixture
async def store(pg_env: dict[str, str]) -> AsyncIterator[Any]:
    from sqlalchemy.ext.asyncio import create_async_engine

    from src.ira.config import Settings
    from src.ira.orchestrator.pg_store import PostgresRunStore

    cfg = Settings(_env_file=None, postgres_host=pg_env["POSTGRES_HOST"],  # type: ignore[call-arg]
                   postgres_port=int(pg_env["POSTGRES_PORT"]), postgres_user="ira",
                   postgres_password="p@ss:w/rd", postgres_db="ira")
    s = PostgresRunStore(create_async_engine(cfg.postgres_dsn))
    yield s
    await s.close()


async def test_roundtrip_idempotency_and_find_action(store: Any) -> None:
    from src.ira.models.incident import ProposedAction

    inc = make_incident(source="pagerduty", external_id=f"PD-{utcnow().timestamp()}")
    run = Run(status="awaiting_approval", awaiting_action_id="act_1")
    run.snapshot.proposed_actions = [ProposedAction(
        id="act_1", kind="k8s.rollout_undo", risk="write", rationale="r",
        requires_approval=True, status="pending_approval")]
    await store.create(inc, run)
    with pytest.raises(DuplicateIncidentError):
        await store.create(make_incident(source="pagerduty", external_id=inc.external_id), Run())

    assert (await store.get_run(str(inc.id))).awaiting_action_id == "act_1"
    found = await store.find_action("act_1")
    assert found is not None and str(found[0].id) == str(inc.id)
    assert any(str(i.id) == str(inc.id) for i, _ in await store.awaiting_approval())
    assert (await store.find_active_by_signature(inc.signature_hash)) is not None

    rec = DecisionRecord(incident_id=str(inc.id), action_id="act_1", decision="approved",
                         actor="alice", at=utcnow())
    await store.add_decision(rec)
    with pytest.raises(DuplicateDecisionError):
        await store.add_decision(rec)
    assert [d.actor for d in await store.decisions("act_1")] == ["alice"]


async def test_audit_log_is_append_only(store: Any) -> None:
    from sqlalchemy import text

    inc = make_incident()
    await store.create(inc, Run())
    await store.audit("alice", "incident.created", str(inc.id), {"k": "v"})
    [event] = await store.list_audit(str(inc.id))
    assert event.actor == "alice" and event.details == {"k": "v"}
    async with store.engine.begin() as conn:
        with pytest.raises(Exception, match="append-only"):
            await conn.execute(text("DELETE FROM audit_log"))


async def test_advisory_lock_serialises(store: Any) -> None:
    order: list[str] = []

    async def hold(name: str) -> None:
        async with store.lock("incident-x"):
            order.append(f"{name}-in")
            await asyncio.sleep(0.2)
            order.append(f"{name}-out")

    await asyncio.gather(hold("a"), hold("b"))
    assert order in (["a-in", "a-out", "b-in", "b-out"], ["b-in", "b-out", "a-in", "a-out"])


async def test_hitl_resume_on_postgres(pg_env: dict[str, str], store: Any) -> None:
    """Full approve -> resume -> execute on the production stack: PostgresRunStore +
    Postgres checkpointer. Restored checkpoints must round-trip the incident exactly."""
    import uuid as _uuid

    from src.ira.api.auth import Principal
    from src.ira.config import Settings
    from src.ira.hitl.service import ApprovalService
    from src.ira.orchestrator.checkpoint import build_checkpointer
    from src.ira.orchestrator.dispatch import LocalDispatcher
    from src.ira.orchestrator.graph import build_graph
    from src.ira.orchestrator.runner import IncidentRunner
    from tests.fakes import ARTIFACTS, FakeLLM, base_responses, make_deps

    cfg = Settings(_env_file=None, postgres_enabled=True,  # type: ignore[call-arg]
                   postgres_host=pg_env["POSTGRES_HOST"],
                   postgres_port=int(pg_env["POSTGRES_PORT"]), postgres_user="ira",
                   postgres_password="p@ss:w/rd", postgres_db="ira", artifacts_dir=ARTIFACTS)
    checkpointer, close = await build_checkpointer(cfg)
    executed: list[dict[str, Any]] = []
    runner = IncidentRunner(build_graph(make_deps(FakeLLM(base_responses()), executed),
                                        checkpointer=checkpointer), store)
    dispatcher = LocalDispatcher(runner)
    approvals = ApprovalService(store, dispatcher)
    try:
        inc = make_incident()
        await store.create(inc, Run())
        await runner.run(str(inc.id))
        assert (await store.get_run(str(inc.id))).status == "awaiting_approval"
        [pending] = await approvals.pending()
        await approvals.decide(pending["action_id"], "approved",
                               Principal(sub="amy", roles=frozenset({"approver"})), None)
        await dispatcher.idle()

        run = await store.get_run(str(inc.id))
        assert run.status == "completed", run.error
        assert executed and run.snapshot.proposed_actions[0].status == "executed"
        restored = (await runner.graph.aget_state(
            {"configurable": {"thread_id": str(inc.id)}})).values["incident"]
        assert type(restored.id) is _uuid.UUID and restored.id == inc.id
    finally:
        await dispatcher.close()
        if close:
            await close()
