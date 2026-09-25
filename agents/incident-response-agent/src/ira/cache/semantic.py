from typing import Any
from uuid import UUID

# isort: off
import src.ira.config  # noqa: F401 - must precede litellm: disables its .env auto-loading
from litellm import aembedding
# isort: on
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.ira.config import settings
from src.ira.llm.client import provider_kwargs
from src.ira.models.db import DBIncidentEmbedding

from .signature import normalize_text


class SemanticCache:
    def __init__(self, threshold: float | None = None, embedding_model: str | None = None):
        self.threshold = settings.semantic_threshold if threshold is None else threshold
        self.embedding_model = embedding_model or settings.embedding_model

    def _prepare_text_for_embedding(
        self, title: str, description: str, service: str | None, labels: dict[str, str],
        log_lines: list[str],
    ) -> str:
        # "title + description + service + key labels + first 20 normalized error log lines"
        parts = [title, description, service or ""]
        key_labels = [f"{k}:{v}" for k, v in labels.items() if k in ["alertname", "error_class"]]
        parts.extend(key_labels)

        # Add first 20 log lines, normalized
        lines = [normalize_text(line) for line in log_lines[:20]]
        parts.extend(lines)

        return " | ".join([p for p in parts if p])

    async def _get_embedding(self, text: str) -> list[float]:
        response = await aembedding(
            model=self.embedding_model,
            input=text,
            dimensions=settings.embedding_dim,
            timeout=settings.embedding_timeout_s,
            num_retries=0,
            **provider_kwargs(self.embedding_model)
        )
        embedding: list[float] = response.data[0]["embedding"]
        if len(embedding) != settings.embedding_dim:
            raise ValueError(
                f"{self.embedding_model} returned {len(embedding)} dims but the "
                f"incident_embeddings column is Vector({settings.embedding_dim}); "
                "set EMBEDDING_DIM to match and migrate"
            )
        return embedding

    async def search(
        self, session: AsyncSession, service: str | None, environment: str, title: str,
        description: str, labels: dict[str, str], log_lines: list[str], top_k: int = 5,
    ) -> list[dict[str, Any]]:
        text_to_embed = self._prepare_text_for_embedding(title, description, service, labels, log_lines)
        query_embedding = await self._get_embedding(text_to_embed)

        # hnsw vector_cosine_ops
        stmt = (
            select(DBIncidentEmbedding, DBIncidentEmbedding.embedding.cosine_distance(query_embedding).label("distance"))
            # NULL and "" are the same "no service" bucket
            .filter(DBIncidentEmbedding.service == (service or ""))
            .filter(DBIncidentEmbedding.environment == environment)
            .order_by("distance")
            .limit(top_k)
        )

        result = await session.execute(stmt)
        rows = result.all()

        matches = []
        for row in rows:
            embedding_record = row[0]
            distance = row[1]
            cosine_similarity = 1.0 - distance

            matches.append({
                "incident_id": embedding_record.incident_id,
                "resolution_id": embedding_record.resolution_id,
                "fault_type": embedding_record.fault_type,
                "score": cosine_similarity,
                "is_hit": cosine_similarity >= self.threshold
            })

        return matches

    async def store(
        self, session: AsyncSession, incident_id: UUID, resolution_id: UUID | None,
        service: str | None, environment: str, fault_type: str | None, title: str,
        description: str, labels: dict[str, str], log_lines: list[str],
    ) -> None:
        text_to_embed = self._prepare_text_for_embedding(title, description, service, labels, log_lines)
        embedding = await self._get_embedding(text_to_embed)

        record = DBIncidentEmbedding(
            incident_id=incident_id,
            resolution_id=resolution_id,
            service=service or "",
            environment=environment,
            fault_type=fault_type,
            embedding=embedding
        )
        await session.merge(record)
        await session.commit()
