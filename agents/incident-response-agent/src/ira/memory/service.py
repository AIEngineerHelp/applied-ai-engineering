import logging
import uuid
from typing import Any

from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from src.ira.cache.exact import ExactCache
from src.ira.cache.semantic import SemanticCache
from src.ira.models.db import DBResolution
from src.ira.models.incident import Hypothesis, Incident, Report, Verification

logger = logging.getLogger(__name__)





class MemoryService:
    """Long-term memory: semantic (pgvector), exact cache (Redis), knowledge graph (Neo4j).
    Each backend is optional; missing ones are skipped."""

    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession] | None = None,
        neo4j_driver: Any = None,
        redis_client: Redis | None = None,
        semantic_cache: SemanticCache | None = None,
    ):
        self.session_factory = session_factory
        self.neo4j = neo4j_driver
        self.exact_cache = ExactCache(redis_client) if redis_client is not None else None
        self.semantic_cache = semantic_cache or SemanticCache()

    @staticmethod
    def _log_lines(incident: Incident) -> list[str]:
        lines = incident.raw_payload.get("log_lines", [])
        return [str(line) for line in lines] if isinstance(lines, list) else []

    async def find_similar(self, incident: Incident, top_k: int = 5) -> list[dict[str, Any]]:
        if self.session_factory is None:
            return []
        async with self.session_factory() as session:
            return await self.semantic_cache.search(
                session=session,
                service=incident.service,
                environment=incident.environment,
                title=incident.title,
                description=incident.description,
                labels=incident.labels,
                log_lines=self._log_lines(incident),
                top_k=top_k,
            )

    async def verified_resolution(self, incident: Incident) -> dict[str, Any] | None:
        """Best semantic match above threshold whose resolution was verified, if any.
        Unverified fixes are never replayed as cached answers."""
        if self.session_factory is None:
            return None
        for match in await self.find_similar(incident):
            if not match["is_hit"] or match["resolution_id"] is None:
                continue
            async with self.session_factory() as session:
                resolution = await session.get(DBResolution, match["resolution_id"])
            if resolution is not None and resolution.verified:
                return {
                    "incident_id": str(match["incident_id"]),
                    "score": match["score"],
                    "report_md": resolution.report_md,
                    "hypothesis": resolution.hypothesis,
                }
        return None

    async def get_context(self, incident: Incident) -> dict[str, Any]:
        context: dict[str, Any] = {
            "similar_incidents": [],
            "runbooks": [],
            "upstream_services": [],
            "downstream_services": [],
            "owners": {},
        }
        try:
            similar = await self.find_similar(incident)
            context["similar_incidents"] = [
                {**m, "incident_id": str(m["incident_id"]),
                 "resolution_id": str(m["resolution_id"]) if m["resolution_id"] else None}
                for m in similar
            ]
        except Exception as e:  # noqa: BLE001 - enrichment only
            logger.warning("Semantic search failed: %s", e)

        return context

    async def update(
        self,
        incident: Incident,
        report: Report,
        hypotheses: list[Hypothesis],
        verification: Verification | None,
    ) -> None:
        """Write the outcome back. The exact cache only ever holds verified resolutions."""
        top = hypotheses[0] if hypotheses else None
        verified = bool(verification and verification.verified)

        if verified and top is not None and self.exact_cache is not None:
            await self.exact_cache.set(incident.signature_hash, {
                "incident_id": str(incident.id),
                "report": report.model_dump(mode="json"),
            })

        if top is not None and self.session_factory is not None:
            resolution_id = uuid.uuid4()
            async with self.session_factory() as session:
                session.add(DBResolution(
                    id=resolution_id,
                    incident_id=incident.id,
                    hypothesis=top.model_dump(mode="json"),
                    actions={"items": [a.model_dump(mode="json") for a in report.actions_taken]},
                    report_md=report.markdown,
                    verified=verified,
                ))
                await session.flush()
                await self.semantic_cache.store(
                    session=session,
                    incident_id=incident.id,
                    resolution_id=resolution_id,
                    service=incident.service,
                    environment=incident.environment,
                    fault_type=top.fault_type,
                    title=incident.title,
                    description=incident.description,
                    labels=incident.labels,
                    log_lines=self._log_lines(incident),
                )

        if self.neo4j is not None:
            from src.ira.knowledge.store import GraphStore

            await GraphStore(self.neo4j).record_incident(
                incident_id=str(incident.id),
                title=incident.title,
                dataset=incident.labels.get("dataset"),
                severity=incident.severity,
                status="resolved" if verified else "reported",
                alerted_node=incident.labels.get("node") or incident.labels.get("host"),
                root_cause=top.root_cause_component if top else None,
                fault_type=top.fault_type if top else None,
                confidence=top.confidence if top else None,
                verified=verified,
            )
