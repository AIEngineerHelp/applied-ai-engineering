import json
from typing import Any

from redis.asyncio import Redis

from src.ira.observability.metrics import DLQ_MESSAGES


class DLQHandler:
    def __init__(self, redis_client: Redis, dlq_stream_name: str = "incidents.dlq"):
        self.redis = redis_client
        self.dlq_stream_name = dlq_stream_name
        
    async def push_to_dlq(self, message: dict[str, Any], error_reason: str) -> str:
        """
        Push a failed message to the Dead Letter Queue stream.
        """
        dlq_message = {
            "original_message": json.dumps(message),
            "error_reason": error_reason
        }
        
        DLQ_MESSAGES.inc()
        message_id = await self.redis.xadd(
            name=self.dlq_stream_name,
            fields={"data": json.dumps(dlq_message)}
        )
        return message_id.decode() if isinstance(message_id, bytes) else str(message_id)
