import asyncio
import logging
from typing import Any, Protocol

from src.ira.orchestrator.runner import IncidentRunner
from src.ira.queue.producer import IncidentProducer

logger = logging.getLogger(__name__)


class Dispatcher(Protocol):
    """How the API hands work to the orchestrator."""

    async def submit(self, incident_id: str, severity: str) -> None: ...
    async def resume(self, incident_id: str) -> None: ...
    async def close(self) -> None: ...


class QueueDispatcher:
    """Production: enqueue on Redis Streams; worker processes run the graph."""

    def __init__(self, producer: IncidentProducer):
        self.producer = producer

    async def submit(self, incident_id: str, severity: str) -> None:
        await self.producer.publish_incident(incident_id, severity)

    async def resume(self, incident_id: str) -> None:
        await self.producer.publish_resume(incident_id)

    async def close(self) -> None:
        return None


class LocalDispatcher:
    """Development: run the graph in the API process (no Redis needed). Also sweeps
    expired approvals, which the worker does in production."""

    def __init__(self, runner: IncidentRunner, sweep_interval_s: float = 30.0):
        self.runner = runner
        self.sweep_interval_s = sweep_interval_s
        self._tasks: set[asyncio.Task[Any]] = set()
        self._sweeper: asyncio.Task[None] | None = None

    def _spawn(self, coro: Any) -> None:
        task = asyncio.create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    def start_sweeper(self) -> None:
        async def sweep() -> None:
            while True:
                await asyncio.sleep(self.sweep_interval_s)
                try:
                    for incident_id in await self.runner.expire_stale_approvals():
                        self._spawn(self.runner.resume(incident_id))
                except Exception:
                    logger.exception("Approval sweep failed")

        self._sweeper = asyncio.create_task(sweep())

    async def submit(self, incident_id: str, severity: str) -> None:
        self._spawn(self.runner.run(incident_id))

    async def resume(self, incident_id: str) -> None:
        self._spawn(self.runner.resume(incident_id))

    async def idle(self) -> None:
        """Wait for all dispatched work (tests)."""
        while self._tasks:
            await asyncio.gather(*list(self._tasks), return_exceptions=True)

    async def close(self) -> None:
        if self._sweeper is not None:
            self._sweeper.cancel()
        for task in list(self._tasks):
            task.cancel()
        await asyncio.gather(*self._tasks, *([self._sweeper] if self._sweeper else []),
                             return_exceptions=True)
