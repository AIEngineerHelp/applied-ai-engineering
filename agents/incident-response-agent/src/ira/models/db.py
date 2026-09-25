import uuid
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from src.ira.config import settings


def _utcnow() -> datetime:
    return datetime.now(UTC)


class Base(DeclarativeBase):
    pass

class DBIncident(Base):
    __tablename__ = "incidents"
    __table_args__ = (
        # Webhook idempotency: one incident per (source, external_id).
        Index("uq_incidents_source_external_id", "source", "external_id", unique=True,
              postgresql_where=text("external_id IS NOT NULL")),
        Index("ix_incidents_received_at", "received_at"),
    )

    id: Mapped[UUID] = mapped_column(PGUUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    source: Mapped[str] = mapped_column(String(50))
    external_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    title: Mapped[str] = mapped_column(String(500))
    description: Mapped[str]
    service: Mapped[str | None] = mapped_column(String(255), nullable=True)
    environment: Mapped[str] = mapped_column(String(50))
    severity: Mapped[str] = mapped_column(String(20))
    labels: Mapped[dict[str, Any]] = mapped_column(JSON)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    raw_payload: Mapped[dict[str, Any]] = mapped_column(JSON)
    signature: Mapped[str]
    signature_hash: Mapped[str] = mapped_column(String(64), index=True)
    status: Mapped[str] = mapped_column(String(50), index=True)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    resolution_id: Mapped[UUID | None] = mapped_column(PGUUID(as_uuid=True), nullable=True)

class DBResolution(Base):
    __tablename__ = "resolutions"

    id: Mapped[UUID] = mapped_column(PGUUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    incident_id: Mapped[UUID] = mapped_column(PGUUID(as_uuid=True))
    hypothesis: Mapped[dict[str, Any]] = mapped_column(JSON)
    actions: Mapped[dict[str, Any]] = mapped_column(JSON)
    report_md: Mapped[str]
    verified: Mapped[bool] = mapped_column(Boolean, default=False)
    verified_by: Mapped[str | None] = mapped_column(String(255), nullable=True)

class DBIncidentEmbedding(Base):
    __tablename__ = "incident_embeddings"

    incident_id: Mapped[UUID] = mapped_column(PGUUID(as_uuid=True), primary_key=True)
    resolution_id: Mapped[UUID | None] = mapped_column(PGUUID(as_uuid=True), nullable=True)
    service: Mapped[str] = mapped_column(String(255), default="")
    environment: Mapped[str] = mapped_column(String(50))
    fault_type: Mapped[str | None] = mapped_column(String(100), nullable=True)
    # Must match the output size of settings.embedding_model.
    embedding: Mapped[Any] = mapped_column(Vector(settings.embedding_dim))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)


class DBIncidentRun(Base):
    """Run document (orchestrator progress + user-visible state) per incident."""

    __tablename__ = "incident_runs"

    incident_id: Mapped[UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("incidents.id", ondelete="CASCADE"), primary_key=True
    )
    status: Mapped[str] = mapped_column(String(30), index=True)
    doc: Mapped[dict[str, Any]] = mapped_column(JSONB)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)


class DBApprovalDecision(Base):
    __tablename__ = "approval_decisions"
    __table_args__ = (UniqueConstraint("action_id", "actor", name="uq_decision_action_actor"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    incident_id: Mapped[UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("incidents.id", ondelete="CASCADE"), index=True
    )
    action_id: Mapped[str] = mapped_column(String(64), index=True)
    decision: Mapped[str] = mapped_column(String(20))
    actor: Mapped[str] = mapped_column(String(320))
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    comment: Mapped[str | None] = mapped_column(Text, nullable=True)


class DBAuditLog(Base):
    """Append-only (UPDATE/DELETE are rejected by a trigger, see migrations)."""

    __tablename__ = "audit_log"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, index=True)
    actor: Mapped[str] = mapped_column(String(320))
    action: Mapped[str] = mapped_column(String(100), index=True)
    incident_id: Mapped[UUID | None] = mapped_column(PGUUID(as_uuid=True), nullable=True,
                                                     index=True)
    details: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
