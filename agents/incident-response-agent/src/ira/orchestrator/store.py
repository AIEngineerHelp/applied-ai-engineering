import asyncio
from collections import defaultdict
from collections.abc import AsyncIterator
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from typing import Any, Protocol

from src.ira.models.incident import TERMINAL_STATUSES, Incident, ProposedAction
from src.ira.orchestrator.run import AuditEvent, DecisionRecord, Run, utcnow


class DuplicateIncidentError(Exception):
    def __init__(self, existing: Incident):
        super().__init__(f"Incident already exists: {existing.id}")
        self.existing = existing


class DuplicateDecisionError(Exception):
    """The same actor already decided on this action."""


class RunStore(Protocol):
    """Persistence for incidents, run documents, approval decisions and the audit log.
    Implementations: MemoryRunStore (dev/tests), PostgresRunStore (production)."""

    async def create(self, incident: Incident, run: Run) -> None:
        """Raises DuplicateIncidentError on a (source, external_id) conflict."""

    async def save(self, incident: Incident, run: Run) -> None: ...
    async def get_incident(self, incident_id: str) -> Incident | None: ...
    async def get_run(self, incident_id: str) -> Run | None: ...
    async def list_incidents(self, limit: int = 200) -> list[Incident]: ...
    async def find_by_external_id(self, source: str, external_id: str) -> Incident | None: ...
    async def find_active_by_signature(self, signature_hash: str) -> Incident | None: ...
    async def find_action(
        self, action_id: str
    ) -> tuple[Incident, Run, ProposedAction] | None: ...
    async def awaiting_approval(self) -> list[tuple[Incident, Run]]: ...

    async def add_decision(self, record: DecisionRecord) -> None:
        """Raises DuplicateDecisionError if record.actor already decided this action."""

    async def decisions(self, action_id: str) -> list[DecisionRecord]: ...

    async def audit(
        self, actor: str, action: str, incident_id: str | None = None,
        details: dict[str, Any] | None = None,
    ) -> None: ...

    async def list_audit(
        self, incident_id: str | None = None, limit: int = 200
    ) -> list[AuditEvent]: ...

    def lock(self, incident_id: str) -> AbstractAsyncContextManager[None]:
        """Exclusive per-incident lock across every worker process."""

    async def ping(self) -> None: ...
    async def close(self) -> None: ...


class MemoryRunStore:
    """Single-process store for development and tests."""

    def __init__(self) -> None:
        self.incidents: dict[str, Incident] = {}
        self.runs: dict[str, Run] = {}
        self._decisions: list[DecisionRecord] = []
        self._audit: list[AuditEvent] = []
        self._locks: defaultdict[str, asyncio.Lock] = defaultdict(asyncio.Lock)

    async def create(self, incident: Incident, run: Run) -> None:
        if incident.external_id:
            existing = await self.find_by_external_id(incident.source, incident.external_id)
            if existing is not None:
                raise DuplicateIncidentError(existing)
        await self.save(incident, run)

    async def save(self, incident: Incident, run: Run) -> None:
        run.updated_at = utcnow()
        key = str(incident.id)
        # Store copies so callers can't mutate persisted state behind the store's back.
        self.incidents[key] = incident.model_copy(deep=True)
        self.runs[key] = run.model_copy(deep=True)

    async def get_incident(self, incident_id: str) -> Incident | None:
        inc = self.incidents.get(incident_id)
        return inc.model_copy(deep=True) if inc else None

    async def get_run(self, incident_id: str) -> Run | None:
        run = self.runs.get(incident_id)
        return run.model_copy(deep=True) if run else None

    async def list_incidents(self, limit: int = 200) -> list[Incident]:
        items = sorted(self.incidents.values(), key=lambda i: i.received_at, reverse=True)
        return [i.model_copy(deep=True) for i in items[:limit]]

    async def find_by_external_id(self, source: str, external_id: str) -> Incident | None:
        return next((i.model_copy(deep=True) for i in self.incidents.values()
                     if i.source == source and i.external_id == external_id), None)

    async def find_active_by_signature(self, signature_hash: str) -> Incident | None:
        active = [i for i in self.incidents.values()
                  if i.signature_hash == signature_hash and i.status not in TERMINAL_STATUSES]
        active.sort(key=lambda i: i.received_at, reverse=True)
        return active[0].model_copy(deep=True) if active else None

    async def find_action(self, action_id: str) -> tuple[Incident, Run, ProposedAction] | None:
        for key, run in self.runs.items():
            action = run.find_action(action_id)
            if action is not None:
                return (self.incidents[key].model_copy(deep=True), run.model_copy(deep=True),
                        action.model_copy(deep=True))
        return None

    async def awaiting_approval(self) -> list[tuple[Incident, Run]]:
        return [(self.incidents[k].model_copy(deep=True), r.model_copy(deep=True))
                for k, r in self.runs.items() if r.status == "awaiting_approval"]

    async def add_decision(self, record: DecisionRecord) -> None:
        if any(d.action_id == record.action_id and d.actor == record.actor
               for d in self._decisions):
            raise DuplicateDecisionError(record.actor)
        self._decisions.append(record)

    async def decisions(self, action_id: str) -> list[DecisionRecord]:
        return [d for d in self._decisions if d.action_id == action_id]

    async def audit(
        self, actor: str, action: str, incident_id: str | None = None,
        details: dict[str, Any] | None = None,
    ) -> None:
        self._audit.append(AuditEvent(id=len(self._audit) + 1, at=utcnow(), actor=actor,
                                      action=action, incident_id=incident_id,
                                      details=details or {}))

    async def list_audit(self, incident_id: str | None = None, limit: int = 200) -> list[AuditEvent]:
        events = [e for e in self._audit if incident_id is None or e.incident_id == incident_id]
        return list(reversed(events))[:limit]

    @asynccontextmanager
    async def _lock(self, incident_id: str) -> AsyncIterator[None]:
        async with self._locks[incident_id]:
            yield

    def lock(self, incident_id: str) -> AbstractAsyncContextManager[None]:
        return self._lock(incident_id)

    async def ping(self) -> None:
        return None

    async def close(self) -> None:
        return None
