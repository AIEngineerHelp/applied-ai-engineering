import json
from typing import Any

from redis.asyncio import Redis

from src.ira.config import settings


class ExactCache:
    def __init__(self, redis_client: Redis, ttl_seconds: int | None = None):
        self.redis = redis_client
        self.ttl_seconds = ttl_seconds or settings.exact_cache_ttl_s

    async def get(self, signature_hash: str) -> dict[str, Any] | None:
        key = f"cache:exact:{signature_hash}"
        data = await self.redis.get(key)
        if data:
            result: dict[str, Any] = json.loads(data)
            return result
        return None

    async def set(self, signature_hash: str, resolution_data: dict[str, Any]) -> None:
        key = f"cache:exact:{signature_hash}"
        await self.redis.set(key, json.dumps(resolution_data), ex=self.ttl_seconds)

    async def invalidate(self, signature_hash: str) -> None:
        key = f"cache:exact:{signature_hash}"
        await self.redis.delete(key)
