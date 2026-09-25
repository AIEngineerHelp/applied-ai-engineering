import json
from uuid import UUID

from redis.asyncio import Redis

CONTROL_STREAM = "incidents.control"


def _id(message_id: bytes | str) -> str:
    return message_id.decode() if isinstance(message_id, bytes) else str(message_id)


class IncidentProducer:
    def __init__(self, redis_client: Redis):
        self.redis = redis_client

    async def publish_incident(self, incident_id: UUID | str, severity: str) -> str:
        """Start a run. Stream per severity (incidents.<sev>) gives priority ordering."""
        message = {"type": "run", "incident_id": str(incident_id), "attempt": 0}
        return _id(await self.redis.xadd(f"incidents.{severity}",
                                          {"data": json.dumps(message)}))

    async def publish_resume(self, incident_id: UUID | str) -> str:
        """Resume a run whose pending approval was decided."""
        message = {"type": "resume", "incident_id": str(incident_id), "attempt": 0}
        return _id(await self.redis.xadd(CONTROL_STREAM, {"data": json.dumps(message)}))
