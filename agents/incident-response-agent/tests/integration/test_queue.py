import asyncio
import json
from typing import Any

import fakeredis
import pytest

from src.ira.queue.consumer import IncidentConsumer
from src.ira.queue.producer import CONTROL_STREAM, IncidentProducer


@pytest.fixture
def redis() -> Any:
    return fakeredis.FakeAsyncRedis()


async def run_consumer(consumer: IncidentConsumer, handler: Any, until: Any) -> None:
    task = asyncio.create_task(consumer.consume(handler, reclaim_every_s=3600))
    try:
        for _ in range(300):
            if until():
                break
            await asyncio.sleep(0.01)
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


async def test_priority_and_message_types(redis: Any) -> None:
    producer = IncidentProducer(redis)
    consumer = IncidentConsumer(redis, concurrency=1)
    await consumer.setup()
    await producer.publish_incident("low", "sev4")
    await producer.publish_incident("high", "sev1")
    await producer.publish_resume("resumed")
    seen: list[tuple[str, str]] = []

    async def handler(msg: dict[str, Any]) -> bool:
        seen.append((msg["type"], msg["incident_id"]))
        return True

    await run_consumer(consumer, handler, lambda: len(seen) == 3)
    assert seen == [("resume", "resumed"), ("run", "high"), ("run", "low")]
    pending = await redis.xpending("incidents.sev1", "orchestrators")
    assert pending["pending"] == 0


async def test_retry_then_dead_letter(redis: Any) -> None:
    consumer = IncidentConsumer(redis, concurrency=2, max_attempts=3)
    await consumer.setup()
    await IncidentProducer(redis).publish_incident("bad", "sev2")
    attempts: list[int] = []

    async def handler(msg: dict[str, Any]) -> bool:
        attempts.append(msg["attempt"])
        raise RuntimeError("boom")

    await run_consumer(consumer, handler, lambda: len(attempts) == 3)
    await asyncio.sleep(0.05)
    assert attempts == [0, 1, 2]
    [(_, fields)] = await redis.xrange("incidents.dlq")
    dead = json.loads(fields[b"data"])
    assert json.loads(dead["original_message"])["incident_id"] == "bad"
    assert "boom" in dead["error_reason"]


async def test_malformed_message_dead_lettered(redis: Any) -> None:
    consumer = IncidentConsumer(redis, concurrency=1)
    await consumer.setup()
    await redis.xadd(CONTROL_STREAM, {"data": "not json"})
    calls: list[Any] = []

    async def handler(msg: dict[str, Any]) -> bool:
        calls.append(msg)
        return True

    await run_consumer(consumer, handler, lambda: False)
    assert calls == []
    assert len(await redis.xrange("incidents.dlq")) == 1


async def test_concurrency_limit(redis: Any) -> None:
    consumer = IncidentConsumer(redis, concurrency=2)
    await consumer.setup()
    producer = IncidentProducer(redis)
    for i in range(5):
        await producer.publish_incident(f"i{i}", "sev3")
    running = peak = done = 0

    async def handler(msg: dict[str, Any]) -> bool:
        nonlocal running, peak, done
        running += 1
        peak = max(peak, running)
        await asyncio.sleep(0.05)
        running -= 1
        done += 1
        return True

    await run_consumer(consumer, handler, lambda: done == 5)
    assert done == 5 and peak == 2
