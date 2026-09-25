import hashlib
import uuid
from collections.abc import AsyncIterator
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from typing import Any

from sqlalchemy import func, select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from src.ira.models.db import DBApprovalDecision, DBAuditLog, DBIncident, DBIncidentRun
from src.ira.models.incident import TERMINAL_STATUSES, Incident, ProposedAction
from src.ira.orchestrator.run import AuditEvent, DecisionRecord, Run, utcnow
from src.ira.orchestrator.store import DuplicateDecisionError, DuplicateIncidentError

_INCIDENT_FIELDS = (
    "source", "external_id", "title", "description", "service", "environment", "severity",
    "labels", "started_at", "received_at", "raw_payload", "signature", "signature_hash",
    "status",
)


def _to_incident(row: DBIncident) -> Incident:
    # asyncpg returns its own UUID subclass; normalise it so checkpoints only ever hold
    # stdlib types (LangGraph refuses to deserialise unknown classes).
    return Incident(id=uuid.UUID(str(row.id)), **{f: getattr(row, f) for f in _INCIDENT_FIELDS})


def _incident_values(incident: Incident) -> dict[str, Any]:
    data = incident.model_dump(mode="python")
    values = {f: data[f] for f in _INCIDENT_FIELDS}
    values["id"] = incident.id
    return values


def _lock_key(incident_id: str) -> int:
    digest = hashlib.blake2b(incident_id.encode(), digest_size=8).digest()
    return int.from_bytes(digest, "big", signed=True)


class PostgresRunStore:
    def __init__(self, engine: AsyncEngine):
        self.engine = engine
        self.sessions = async_sessionmaker(engine, expire_on_commit=False)

    async def create(self, incident: Incident, run: Run) -> None:
        try:
            async with self.sessions.begin() as s:
                s.add(DBIncident(**_incident_values(incident)))
                await s.flush()
                s.add(self._run_row(incident, run))
        except IntegrityError:
            if incident.external_id:
                existing = await self.find_by_external_id(incident.source, incident.external_id)
                if existing is not None:
                    raise DuplicateIncidentError(existing) from None
            raise

    @staticmethod
    def _run_row(incident: Incident, run: Run) -> DBIncidentRun:
        run.updated_at = utcnow()
        return DBIncidentRun(incident_id=incident.id, status=run.status,
                             doc=run.model_dump(mode="json"), updated_at=run.updated_at)

    async def save(self, incident: Incident, run: Run) -> None:
        run.updated_at = utcnow()
        async with self.sessions.begin() as s:
            await s.execute(
                insert(DBIncident).values(**_incident_values(incident))
                .on_conflict_do_update(index_elements=["id"],
                                       set_={"status": incident.status})
            )
            await s.execute(
                insert(DBIncidentRun).values(
                    incident_id=incident.id, status=run.status,
                    doc=run.model_dump(mode="json"), updated_at=run.updated_at,
                ).on_conflict_do_update(
                    index_elements=["incident_id"],
                    set_={"status": run.status, "doc": run.model_dump(mode="json"),
                          "updated_at": run.updated_at},
                )
            )

    async def get_incident(self, incident_id: str) -> Incident | None:
        try:
            key = uuid.UUID(incident_id)
        except ValueError:
            return None
        async with self.sessions() as s:
            row = await s.get(DBIncident, key)
            return _to_incident(row) if row else None

    async def get_run(self, incident_id: str) -> Run | None:
        try:
            key = uuid.UUID(incident_id)
        except ValueError:
            return None
        async with self.sessions() as s:
            row = await s.get(DBIncidentRun, key)
            return Run.model_validate(row.doc) if row else None

    async def list_incidents(self, limit: int = 200) -> list[Incident]:
        async with self.sessions() as s:
            rows = await s.scalars(
                select(DBIncident).order_by(DBIncident.received_at.desc()).limit(limit)
            )
            return [_to_incident(r) for r in rows]

    async def find_by_external_id(self, source: str, external_id: str) -> Incident | None:
        async with self.sessions() as s:
            row = await s.scalar(select(DBIncident).where(
                DBIncident.source == source, DBIncident.external_id == external_id))
            return _to_incident(row) if row else None

    async def find_active_by_signature(self, signature_hash: str) -> Incident | None:
        async with self.sessions() as s:
            row = await s.scalar(
                select(DBIncident)
                .where(DBIncident.signature_hash == signature_hash,
                       DBIncident.status.not_in(TERMINAL_STATUSES))
                .order_by(DBIncident.received_at.desc()).limit(1)
            )
            return _to_incident(row) if row else None

    async def find_action(self, action_id: str) -> tuple[Incident, Run, ProposedAction] | None:
        needle = {"snapshot": {"proposed_actions": [{"id": action_id}]}}
        async with self.sessions() as s:
            result = await s.execute(
                select(DBIncident, DBIncidentRun)
                .join(DBIncidentRun, DBIncidentRun.incident_id == DBIncident.id)
                .where(DBIncidentRun.doc.contains(needle)).limit(1)
            )
            found = result.first()
        if found is None:
            return None
        run = Run.model_validate(found[1].doc)
        action = run.find_action(action_id)
        return (_to_incident(found[0]), run, action) if action else None

    async def awaiting_approval(self) -> list[tuple[Incident, Run]]:
        async with self.sessions() as s:
            result = await s.execute(
                select(DBIncident, DBIncidentRun)
                .join(DBIncidentRun, DBIncidentRun.incident_id == DBIncident.id)
                .where(DBIncidentRun.status == "awaiting_approval")
            )
            return [(_to_incident(i), Run.model_validate(r.doc)) for i, r in result]

    async def add_decision(self, record: DecisionRecord) -> None:
        try:
            async with self.sessions.begin() as s:
                s.add(DBApprovalDecision(
                    incident_id=uuid.UUID(record.incident_id), action_id=record.action_id,
                    decision=record.decision, actor=record.actor, at=record.at,
                    comment=record.comment,
                ))
        except IntegrityError:
            raise DuplicateDecisionError(record.actor) from None

    async def decisions(self, action_id: str) -> list[DecisionRecord]:
        async with self.sessions() as s:
            rows = await s.scalars(select(DBApprovalDecision)
                                   .where(DBApprovalDecision.action_id == action_id)
                                   .order_by(DBApprovalDecision.id))
            return [DecisionRecord(incident_id=str(r.incident_id), action_id=r.action_id,
                                   decision=r.decision, actor=r.actor, at=r.at,  # type: ignore[arg-type]
                                   comment=r.comment) for r in rows]

    async def audit(
        self, actor: str, action: str, incident_id: str | None = None,
        details: dict[str, Any] | None = None,
    ) -> None:
        async with self.sessions.begin() as s:
            s.add(DBAuditLog(actor=actor, action=action, at=utcnow(),
                             incident_id=uuid.UUID(incident_id) if incident_id else None,
                             details=details or {}))

    async def list_audit(self, incident_id: str | None = None, limit: int = 200) -> list[AuditEvent]:
        query = select(DBAuditLog).order_by(DBAuditLog.id.desc()).limit(limit)
        if incident_id:
            try:
                query = query.where(DBAuditLog.incident_id == uuid.UUID(incident_id))
            except ValueError:
                return []
        async with self.sessions() as s:
            rows = await s.scalars(query)
            return [AuditEvent(id=r.id, at=r.at, actor=r.actor, action=r.action,
                               incident_id=str(r.incident_id) if r.incident_id else None,
                               details=r.details) for r in rows]

    @asynccontextmanager
    async def _lock(self, incident_id: str) -> AsyncIterator[None]:
        # Session-level advisory lock held on a dedicated connection for the whole run,
        # so two workers never drive the same incident concurrently.
        key = _lock_key(incident_id)
        async with self.engine.connect() as conn:
            await conn.execute(select(func.pg_advisory_lock(key)))
            await conn.commit()
            try:
                yield
            finally:
                await conn.execute(select(func.pg_advisory_unlock(key)))
                await conn.commit()

    def lock(self, incident_id: str) -> AbstractAsyncContextManager[None]:
        return self._lock(incident_id)

    async def ping(self) -> None:
        async with self.engine.connect() as conn:
            await conn.execute(text("SELECT 1"))

    async def close(self) -> None:
        await self.engine.dispose()


