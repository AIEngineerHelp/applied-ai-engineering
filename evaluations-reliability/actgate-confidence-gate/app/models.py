from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, Float, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import JSON

from app.db import Base


class CaseRun(Base):
    __tablename__ = "case_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    source: Mapped[str] = mapped_column(String(64), default="inbox")
    subject: Mapped[str | None] = mapped_column(String(512), nullable=True)
    body: Mapped[str] = mapped_column(Text)

    intent: Mapped[str | None] = mapped_column(String(64), nullable=True)
    urgency: Mapped[float | None] = mapped_column(Float, nullable=True)
    risk: Mapped[str | None] = mapped_column(String(32), nullable=True)
    next_step: Mapped[str | None] = mapped_column(String(64), nullable=True)
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)

    gate_decision: Mapped[str | None] = mapped_column(String(64), nullable=True)
    used_laya: Mapped[bool] = mapped_column(Boolean, default=False)
    used_jev: Mapped[bool] = mapped_column(Boolean, default=False)
    used_gemini: Mapped[bool] = mapped_column(Boolean, default=False)
    goal_reached: Mapped[bool] = mapped_column(Boolean, default=False)

    draft: Mapped[str | None] = mapped_column(Text, nullable=True)
    timing_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    answers_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
