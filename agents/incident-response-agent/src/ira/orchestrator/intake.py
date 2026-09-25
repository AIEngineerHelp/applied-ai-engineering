import asyncio
import logging
import uuid
from datetime import UTC, datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

from src.ira.cache.exact import ExactCache
from src.ira.cache.signature import compute_signature, get_signature_hash
from src.ira.guardrails.intake import IntakeGuardrail
from src.ira.memory.service import MemoryService
from src.ira.models.incident import Hypothesis, Incident, Report
from src.ira.observability.metrics import CACHE_HITS, INCIDENTS
from src.ira.orchestrator.dispatch import Dispatcher
from src.ira.orchestrator.run import CacheHit, Run, RunSnapshot
from src.ira.orchestrator.store import DuplicateIncidentError, RunStore

logger = logging.getLogger(__name__)


class IncidentPayload(BaseModel):
    source: Literal["pagerduty", "alertmanager", "jira", "opsgenie", "manual", "eval"]
    external_id: str | None = Field(default=None, max_length=255)
    title: str = Field(min_length=1, max_length=500)
    description: str = Field(default="", max_length=20_000)
    service: str | None = Field(default=None, max_length=255)
    environment: Literal["prod", "staging", "dev"] = "prod"
    severity: Literal["sev1", "sev2", "sev3", "sev4"] = "sev3"
    labels: dict[str, str] = Field(default_factory=dict, max_length=50)
    started_at: datetime | None = None
    raw_payload: dict[str, Any] = Field(default_factory=dict)


class IntakeService:
    """Normalize -> PII scrub -> signature -> exact cache -> semantic cache -> queue/run."""

    def __init__(
        self,
        store: RunStore,
        dispatcher: Dispatcher,
        guardrail: IntakeGuardrail,
        exact_cache: ExactCache | None = None,
        memory: MemoryService | None = None,
        dedup_active: bool = True,
    ):
        self.store = store
        self.dispatcher = dispatcher
        self.guardrail = guardrail
        self.exact_cache = exact_cache
        self.memory = memory
        self.dedup_active = dedup_active

    async def _cached(self, incident: Incident) -> tuple[CacheHit, Report] | None:
        if self.exact_cache is not None:
            try:
                hit = await self.exact_cache.get(incident.signature_hash)
            except Exception as e:  # noqa: BLE001 - cache outage must not block intake
                logger.warning("Exact cache unavailable: %s", e)
                hit = None
            if hit:
                cached = Report.model_validate(hit["report"])
                return (
                    CacheHit(kind="exact", source_incident_id=hit.get("incident_id")),
                    cached.model_copy(update={
                        "incident_id": incident.id,
                        "summary": "Exact signature match with a verified resolution of "
                        f"incident {hit.get('incident_id')}. {cached.summary}",
                    }),
                )
        if self.memory is not None:
            try:
                resolution = await self.memory.verified_resolution(incident)
            except Exception as e:  # noqa: BLE001
                logger.warning("Semantic cache unavailable: %s", e)
                resolution = None
            if resolution:
                return (
                    CacheHit(kind="semantic", score=resolution["score"],
                             source_incident_id=resolution["incident_id"]),
                    Report(
                        incident_id=incident.id,
                        summary=f"Semantically matched (score {resolution['score']:.2f}) a "
                        f"verified resolution of incident {resolution['incident_id']}.",
                        markdown=resolution["report_md"],
                        root_cause=Hypothesis.model_validate(resolution["hypothesis"])
                        if resolution["hypothesis"] else None,
                    ),
                )
        return None

    async def submit(self, payload: IncidentPayload, actor: str) -> tuple[Incident, bool]:
        """Returns (incident, created). Idempotent on (source, external_id); an identical
        signature attaches to the still-active incident instead of opening a new one."""
        if payload.external_id:
            existing = await self.store.find_by_external_id(payload.source, payload.external_id)
            if existing is not None:
                return existing, False

        data = await asyncio.to_thread(
            self.guardrail.validate_and_scrub, payload.model_dump(mode="python")
        )
        signature = compute_signature(
            source=data["source"],
            service=data["service"] or "",
            environment=data["environment"],
            labels=data["labels"],
            title=data["title"],
            description=data["description"],
        )
        now = datetime.now(UTC)
        incident = Incident(
            id=uuid.uuid4(),
            source=data["source"],
            external_id=data["external_id"],
            title=data["title"],
            description=data["description"],
            service=data["service"],
            environment=data["environment"],
            severity=data["severity"],
            labels=data["labels"],
            started_at=data["started_at"] or now,
            received_at=now,
            raw_payload=data["raw_payload"],
            signature=signature,
            signature_hash=get_signature_hash(signature),
            status="new",
        )

        if self.dedup_active:
            active = await self.store.find_active_by_signature(incident.signature_hash)
            if active is not None:
                await self.store.audit(actor, "incident.deduplicated", str(active.id),
                                       {"external_id": incident.external_id})
                return active, False

        cached = await self._cached(incident)
        if cached is not None:
            hit, report = cached
            incident.status = "cached"
            run = Run(status="cached", cache=hit, snapshot=RunSnapshot(report=report))
            created = await self._create(incident, run, actor)
            if created is not None:
                return created, False
            CACHE_HITS.labels(tier=hit.kind).inc()
            INCIDENTS.labels(status="cached").inc()
            return incident, True

        incident.status = "queued"
        created = await self._create(incident, Run(status="queued"), actor)
        if created is not None:
            return created, False
        INCIDENTS.labels(status="queued").inc()
        await self.dispatcher.submit(str(incident.id), incident.severity)
        return incident, True

    async def _create(self, incident: Incident, run: Run, actor: str) -> Incident | None:
        """Persist; returns the existing incident if a concurrent duplicate won the race."""
        try:
            await self.store.create(incident, run)
        except DuplicateIncidentError as dup:
            return dup.existing
        await self.store.audit(actor, "incident.created", str(incident.id), {
            "source": incident.source, "external_id": incident.external_id,
            "severity": incident.severity, "status": incident.status,
        })
        return None
