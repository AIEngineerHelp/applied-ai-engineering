"""Everything one call knows about itself, and the pre-call step that fills it in.

`CallState` is the session's userdata: the tools read the caller's record from it and
write facts into it, and every event is appended to the call log as it happens, so a
dropped call still leaves a trace.
"""

from __future__ import annotations

import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from . import telemetry
from .crm.client import Appointment, Attempt, CRMClient, CRMError, Patient, Slot
from .kb import KnowledgeBase
from .pricing import UsageMeter
from .store import CallStore
from .workflow import Workflow


@dataclass
class CallState:
    workflow: Workflow
    crm: CRMClient
    kb: KnowledgeBase
    store: CallStore
    source: str
    pipeline: str
    models: dict[str, str]
    caller_phone: str | None
    scenario: str | None = None
    call_id: str = field(default_factory=lambda: f"call_{uuid.uuid4().hex[:12]}")
    started: float = field(default_factory=time.monotonic)
    started_wall: float = field(default_factory=time.time)
    patient: Patient | None = None
    appointments: list[Appointment] = field(default_factory=list)
    crm_degraded: bool = False
    # Slots offered during this call: a booking must use one of them, so a slot id the
    # model invents or misremembers is rejected before it reaches the CRM.
    offered_slots: dict[str, Slot] = field(default_factory=dict)
    facts: list[dict[str, Any]] = field(default_factory=list)
    transfer: dict[str, Any] | None = None
    guard_fired: str | None = None
    ended_by_agent: bool = False
    meter: UsageMeter = field(default_factory=UsageMeter)
    span: Any = None  # the call's OpenTelemetry root span, when tracing is on
    # Called with every event as it is logged; the worker uses it to stream the trace to
    # the caller's browser, so a hosted call shows its trace without a shared database.
    on_event: Callable[[str, float, dict[str, Any]], None] | None = None

    def __post_init__(self) -> None:
        self.store.start_call(
            self.call_id, source=self.source, pipeline=self.pipeline, models=self.models,
            caller_phone=self.caller_phone, scenario=self.scenario, started_at=self.started_wall)
        self.crm.on_attempt = self._crm_attempt
        telemetry.start_call(self)

    def at(self) -> float:
        return time.monotonic() - self.started

    def event(self, kind: str, **data: Any) -> None:
        at = self.at()
        self.store.add_event(self.call_id, at, kind, data)
        telemetry.record(self, kind, data)
        if self.on_event is not None:
            self.on_event(kind, at, data)

    def _crm_attempt(self, attempt: Attempt) -> None:
        self.event("crm_attempt", method=attempt.method, path=attempt.path,
                   attempt=attempt.attempt, status=attempt.status, outcome=attempt.outcome,
                   ms=attempt.ms, idempotency_key=attempt.idempotency_key)


async def run_pre_call(state: CallState) -> str:
    """Look the caller up before the first word and return the greeting to speak.

    The lookup has its own short budget: a slow CRM costs the caller a generic greeting,
    never dead air.
    """
    wf = state.workflow
    started = time.monotonic()
    outcome = "no_caller_id"
    budget = wf.pre_call.patient_lookup.timeout_seconds
    if state.caller_phone:
        try:
            state.patient = await state.crm.find_patient(state.caller_phone, budget=budget)
            if state.patient:
                remaining = max(budget - (time.monotonic() - started), 0.2)
                state.appointments = await state.crm.upcoming_appointments(
                    state.patient.id, budget=remaining)
                outcome = "matched"
            else:
                outcome = "no_match"
        except CRMError as exc:
            state.crm_degraded = True
            outcome = f"crm_{exc.kind}"
    state.event("pre_call", outcome=outcome, ms=round((time.monotonic() - started) * 1000, 1),
                patient_id=state.patient.id if state.patient else None,
                appointments=[a.id for a in state.appointments])
    if state.patient:
        state.store.update_call(state.call_id, patient_id=state.patient.id)
        return wf.greeting.known_caller.format(first_name=state.patient.first_name)
    if state.crm_degraded:
        return wf.greeting.crm_unavailable
    return wf.greeting.unknown_caller
