from collections.abc import Awaitable, Callable
from typing import Any

from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.checkpoint.serde.jsonplus import JsonPlusSerializer

from src.ira.config import Settings

_STATE_TYPES = (
    "Incident", "PlanStep", "Evidence", "Hypothesis", "Approval", "ProposedAction",
    "TimelineEvent", "Verification", "Report",
)


def checkpoint_serde() -> JsonPlusSerializer:
    """Serializer that only revives our own state models from checkpoints (no arbitrary
    class deserialization from the database)."""
    return JsonPlusSerializer(
        allowed_msgpack_modules=[("src.ira.models.incident", name) for name in _STATE_TYPES],
    )


async def build_checkpointer(
    config: Settings,
) -> tuple[BaseCheckpointSaver[Any], Callable[[], Awaitable[None]] | None]:
    """Postgres checkpointer when Postgres is enabled (required for multiple workers and
    crash recovery), otherwise in-memory."""
    if not config.postgres_enabled:
        return InMemorySaver(serde=checkpoint_serde()), None

    from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
    from psycopg.rows import dict_row
    from psycopg_pool import AsyncConnectionPool

    pool: AsyncConnectionPool[Any] = AsyncConnectionPool(
        conninfo=config.postgres_dsn_sync,
        max_size=max(4, config.worker_concurrency * 2),
        kwargs={"autocommit": True, "prepare_threshold": 0, "row_factory": dict_row},
        open=False,
    )
    await pool.open(wait=True, timeout=30)
    saver = AsyncPostgresSaver(pool, serde=checkpoint_serde())
    await saver.setup()  # idempotent: creates/migrates LangGraph's checkpoint tables
    return saver, pool.close
