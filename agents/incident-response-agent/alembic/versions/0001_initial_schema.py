"""Initial schema: incidents, runs, approvals, audit log, resolutions, embeddings.

Revision ID: 0001
Revises:
Create Date: 2026-09-23
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from pgvector.sqlalchemy import Vector
from sqlalchemy.dialects import postgresql

from src.ira.config import settings

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

UUID = postgresql.UUID(as_uuid=True)
TS = sa.DateTime(timezone=True)


def upgrade() -> None:
    # Managed Postgres often reserves CREATE EXTENSION for admins: pre-create it there
    # (docs/deployment.md). Only fail if it's genuinely missing.
    op.execute("""
        DO $$
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
                CREATE EXTENSION vector;
            END IF;
        EXCEPTION WHEN insufficient_privilege THEN
            RAISE EXCEPTION 'pgvector is not installed and this role cannot create it; '
                            'run CREATE EXTENSION vector as an admin first';
        END
        $$
    """)

    op.create_table(
        "incidents",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("source", sa.String(50), nullable=False),
        sa.Column("external_id", sa.String(255)),
        sa.Column("title", sa.String(500), nullable=False),
        sa.Column("description", sa.Text, nullable=False),
        sa.Column("service", sa.String(255)),
        sa.Column("environment", sa.String(50), nullable=False),
        sa.Column("severity", sa.String(20), nullable=False),
        sa.Column("labels", sa.JSON, nullable=False),
        sa.Column("started_at", TS, nullable=False),
        sa.Column("received_at", TS, nullable=False),
        sa.Column("raw_payload", sa.JSON, nullable=False),
        sa.Column("signature", sa.Text, nullable=False),
        sa.Column("signature_hash", sa.String(64), nullable=False),
        sa.Column("status", sa.String(50), nullable=False),
        sa.Column("resolved_at", TS),
        sa.Column("resolution_id", UUID),
    )
    op.create_index("ix_incidents_signature_hash", "incidents", ["signature_hash"])
    op.create_index("ix_incidents_status", "incidents", ["status"])
    op.create_index("ix_incidents_received_at", "incidents", ["received_at"])
    op.create_index("uq_incidents_source_external_id", "incidents", ["source", "external_id"],
                    unique=True, postgresql_where=sa.text("external_id IS NOT NULL"))

    op.create_table(
        "incident_runs",
        sa.Column("incident_id", UUID, sa.ForeignKey("incidents.id", ondelete="CASCADE"),
                  primary_key=True),
        sa.Column("status", sa.String(30), nullable=False),
        sa.Column("doc", postgresql.JSONB, nullable=False),
        sa.Column("updated_at", TS, nullable=False),
    )
    op.create_index("ix_incident_runs_status", "incident_runs", ["status"])
    # find_action() looks actions up by id inside the run document.
    op.create_index("ix_incident_runs_doc", "incident_runs", ["doc"],
                    postgresql_using="gin", postgresql_ops={"doc": "jsonb_path_ops"})

    op.create_table(
        "approval_decisions",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("incident_id", UUID, sa.ForeignKey("incidents.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("action_id", sa.String(64), nullable=False),
        sa.Column("decision", sa.String(20), nullable=False),
        sa.Column("actor", sa.String(320), nullable=False),
        sa.Column("at", TS, nullable=False),
        sa.Column("comment", sa.Text),
        sa.UniqueConstraint("action_id", "actor", name="uq_decision_action_actor"),
    )
    op.create_index("ix_approval_decisions_incident_id", "approval_decisions", ["incident_id"])
    op.create_index("ix_approval_decisions_action_id", "approval_decisions", ["action_id"])

    op.create_table(
        "audit_log",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("at", TS, nullable=False),
        sa.Column("actor", sa.String(320), nullable=False),
        sa.Column("action", sa.String(100), nullable=False),
        sa.Column("incident_id", UUID),
        sa.Column("details", postgresql.JSONB, nullable=False,
                  server_default=sa.text("'{}'::jsonb")),
    )
    op.create_index("ix_audit_log_at", "audit_log", ["at"])
    op.create_index("ix_audit_log_action", "audit_log", ["action"])
    op.create_index("ix_audit_log_incident_id", "audit_log", ["incident_id"])
    # Append-only: the audit trail can't be rewritten, even by the application role.
    op.execute("""
        CREATE FUNCTION audit_log_immutable() RETURNS trigger AS $$
        BEGIN
            RAISE EXCEPTION 'audit_log is append-only';
        END;
        $$ LANGUAGE plpgsql
    """)
    op.execute("""
        CREATE TRIGGER audit_log_no_update_delete
        BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_log
        FOR EACH STATEMENT EXECUTE FUNCTION audit_log_immutable()
    """)

    op.create_table(
        "resolutions",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("incident_id", UUID, nullable=False),
        sa.Column("hypothesis", sa.JSON, nullable=False),
        sa.Column("actions", sa.JSON, nullable=False),
        sa.Column("report_md", sa.Text, nullable=False),
        sa.Column("verified", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("verified_by", sa.String(255)),
    )

    op.create_table(
        "incident_embeddings",
        sa.Column("incident_id", UUID, primary_key=True),
        sa.Column("resolution_id", UUID),
        sa.Column("service", sa.String(255), nullable=False, server_default=""),
        sa.Column("environment", sa.String(50), nullable=False),
        sa.Column("fault_type", sa.String(100)),
        sa.Column("embedding", Vector(settings.embedding_dim), nullable=False),
        sa.Column("created_at", TS, nullable=False),
    )
    op.create_index("ix_incident_embeddings_scope", "incident_embeddings",
                    ["service", "environment"])
    op.create_index("ix_incident_embeddings_hnsw", "incident_embeddings", ["embedding"],
                    postgresql_using="hnsw",
                    postgresql_ops={"embedding": "vector_cosine_ops"})


def downgrade() -> None:
    op.drop_table("incident_embeddings")
    op.drop_table("resolutions")
    op.execute("DROP TRIGGER IF EXISTS audit_log_no_update_delete ON audit_log")
    op.execute("DROP FUNCTION IF EXISTS audit_log_immutable()")
    op.drop_table("audit_log")
    op.drop_table("approval_decisions")
    op.drop_table("incident_runs")
    op.drop_table("incidents")
