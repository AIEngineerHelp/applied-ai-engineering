import asyncio
import json
import logging
from collections.abc import Awaitable, Callable
from typing import Any

from redis.asyncio import Redis
from redis.exceptions import ResponseError

from src.ira.config import settings
from src.ira.observability.metrics import QUEUE_RETRIES
from src.ira.queue.dlq import DLQHandler
from src.ira.queue.producer import CONTROL_STREAM

logger = logging.getLogger(__name__)

# Highest priority first: approval resumes unblock humans, then by severity.
STREAMS = [CONTROL_STREAM, "incidents.sev1", "incidents.sev2", "incidents.sev3",
           "incidents.sev4"]
_RECLAIM_IDLE_MS = 5 * 60 * 1000

Handler = Callable[[dict[str, Any]], Awaitable[bool]]


def _field(fields: dict[Any, Any], name: str) -> str | None:
    """Works whether or not the client was created with decode_responses=True."""
    raw = fields.get(name, fields.get(name.encode()))
    if raw is None:
        return None
    return raw.decode("utf-8") if isinstance(raw, bytes) else str(raw)


def _str(value: Any) -> str:
    return value.decode("utf-8") if isinstance(value, bytes) else str(value)


class IncidentConsumer:
    """Redis Streams consumer with priority reads, bounded concurrency, retries and a
    dead-letter queue. Messages are acked only after their handler finished, so a
    crashed worker's messages are reclaimed by another worker."""

    def __init__(
        self,
        redis_client: Redis,
        group_name: str = "orchestrators",
        consumer_name: str = "worker-1",
        max_attempts: int | None = None,
        concurrency: int | None = None,
    ):
        self.redis = redis_client
        self.group_name = group_name
        self.consumer_name = consumer_name
        self.max_attempts = max_attempts or settings.queue_max_attempts
        self.dlq = DLQHandler(redis_client)
        self._slots = asyncio.Semaphore(concurrency or settings.worker_concurrency)
        self._inflight: set[asyncio.Task[None]] = set()

    async def setup(self) -> None:
        """Create the consumer group on every stream if it doesn't exist."""
        for stream in STREAMS:
            try:
                await self.redis.xgroup_create(stream, self.group_name, id="0", mkstream=True)
            except ResponseError as e:
                if "BUSYGROUP" not in str(e):
                    raise

    async def _process(
        self, stream: str, message_id: Any, fields: dict[Any, Any], handler: Handler
    ) -> None:
        raw = _field(fields, "data")
        try:
            message: dict[str, Any] = json.loads(raw) if raw else {}
            if "incident_id" not in message:
                raise ValueError("missing incident_id")
        except (ValueError, TypeError) as e:
            await self.dlq.push_to_dlq({"stream": stream, "raw": raw}, f"malformed: {e}")
            await self.redis.xack(stream, self.group_name, message_id)
            return

        try:
            ok = await handler(message)
            error = "" if ok else "handler returned False"
        except Exception as e:
            logger.exception("Handler failed for %s", message.get("incident_id"))
            ok, error = False, f"{type(e).__name__}: {e}"

        if not ok:
            attempt = int(message.get("attempt", 0)) + 1
            if attempt >= self.max_attempts:
                logger.error("Incident %s dead-lettered after %d attempts: %s",
                             message["incident_id"], attempt, error)
                await self.dlq.push_to_dlq(message, error)
            else:
                logger.warning("Incident %s failed (attempt %d), requeueing: %s",
                               message["incident_id"], attempt, error)
                QUEUE_RETRIES.inc()
                await self.redis.xadd(stream, {"data": json.dumps({**message, "attempt": attempt})})
        # Always ack: a failed message is either requeued as a new entry or dead-lettered.
        await self.redis.xack(stream, self.group_name, message_id)

    async def _spawn(
        self, stream: str, message_id: Any, fields: dict[Any, Any], handler: Handler
    ) -> None:
        await self._slots.acquire()

        async def work() -> None:
            try:
                await self._process(stream, message_id, fields, handler)
            finally:
                self._slots.release()

        task = asyncio.create_task(work())
        self._inflight.add(task)
        task.add_done_callback(self._inflight.discard)

    async def _reclaim(self, handler: Handler) -> None:
        """Take over messages a crashed consumer left pending."""
        for stream in STREAMS:
            result: Any = await self.redis.xautoclaim(
                stream, self.group_name, self.consumer_name,
                min_idle_time=_RECLAIM_IDLE_MS, start_id="0-0", count=50,
            )
            for message_id, fields in result[1]:
                if fields:
                    logger.info("Reclaimed stale message %s on %s", _str(message_id), stream)
                    await self._spawn(stream, message_id, fields, handler)

    async def _read_one(self) -> tuple[str, Any, dict[Any, Any]] | None:
        # Strict priority: drain higher-priority streams first.
        for stream in STREAMS:
            resp: Any = await self.redis.xreadgroup(
                self.group_name, self.consumer_name, {stream: ">"}, count=1
            )
            if resp:
                _, messages = resp[0]
                message_id, fields = messages[0]
                return stream, message_id, fields
        return None

    async def consume(self, handler: Handler, reclaim_every_s: float = 60.0) -> None:
        await self.setup()
        loop = asyncio.get_running_loop()
        next_reclaim = 0.0
        try:
            while True:
                try:
                    if loop.time() >= next_reclaim:
                        await self._reclaim(handler)
                        next_reclaim = loop.time() + reclaim_every_s
                    # Wait for a free slot before taking a message off the stream, so
                    # messages we can't start yet stay available to other workers.
                    await self._slots.acquire()
                    self._slots.release()
                    item = await self._read_one()
                    if item is not None:
                        await self._spawn(*item, handler)
                        continue
                    # Nothing queued: block on all streams. count is per stream, so this
                    # may deliver one message from several streams; all are now pending on
                    # this consumer and must be processed, highest priority first.
                    resp: Any = await self.redis.xreadgroup(
                        self.group_name, self.consumer_name,
                        dict.fromkeys(STREAMS, ">"), count=1, block=2000,
                    )
                    if not resp:
                        # Never spin: a server that returns early (failover, proxies,
                        # fakes) must not starve the event loop.
                        await asyncio.sleep(0.05)
                        continue
                    for stream_name, messages in sorted(
                        resp or [], key=lambda r: STREAMS.index(_str(r[0]))
                    ):
                        for message_id, fields in messages:
                            await self._spawn(_str(stream_name), message_id, fields, handler)
                except asyncio.CancelledError:
                    raise
                except Exception:
                    logger.exception("Error consuming messages")
                    await asyncio.sleep(1)
        finally:
            await self.drain(settings.worker_shutdown_grace_s)

    async def drain(self, timeout: float | None = None) -> None:
        """Graceful shutdown: let in-flight runs finish, up to `timeout`. Runs still going
        are cancelled; their messages stay unacked and another worker reclaims them and
        resumes from the last checkpoint."""
        if not self._inflight:
            return
        logger.info("Waiting up to %ss for %d in-flight run(s)", timeout, len(self._inflight))
        _, pending = await asyncio.wait(set(self._inflight), timeout=timeout)
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
