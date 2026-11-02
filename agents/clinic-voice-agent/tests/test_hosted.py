"""Hosted mode: each call gets its own mock CRM, the caller is registered from the dispatch
metadata, and the browser's fault switch reaches that CRM with limits a visitor cannot
abuse."""

from __future__ import annotations

import json
from datetime import date

import pytest

from voiceagent.config import settings
from voiceagent.crm.server import CRMState
from voiceagent.worker import apply_fault, crm_for_call


@pytest.fixture
def embedded(monkeypatch):  # type: ignore[no-untyped-def]
    monkeypatch.setattr(settings(), "crm_mode", "embedded")


async def test_embedded_crm_knows_the_caller(embedded) -> None:  # type: ignore[no-untyped-def]
    meta = {"caller_name": "  Anjali   Desai ", "caller_phone": "+919876543210"}
    crm, state = crm_for_call(meta, "+919876543210")
    assert state is not None
    try:
        patient = await crm.find_patient("+919876543210")
        assert patient is not None
        assert (patient.first_name, patient.last_name) == ("Anjali", "Desai")
        assert len(await crm.upcoming_appointments(patient.id)) == 1
    finally:
        await crm.aclose()


async def test_each_call_gets_a_fresh_crm(embedded) -> None:  # type: ignore[no-untyped-def]
    one, first = crm_for_call({"caller_name": "A B"}, "+911111111111")
    two, second = crm_for_call({}, None)
    assert first is not None and second is not None and first is not second
    assert not [p for p in second.patients if p["phone"] == "+911111111111"]
    await one.aclose()
    await two.aclose()


def test_fault_from_the_browser_is_bounded() -> None:
    state = CRMState(today=date(2026, 10, 26))
    fault = apply_fault(state, json.dumps({"mode": "slow", "latency_ms": 600_000}))
    assert fault is not None and state.fault.mode == "slow"
    assert state.fault.latency_ms == 5000, "a visitor cannot make the CRM hang the call"
    assert apply_fault(state, "not json") is None
    assert apply_fault(state, {"mode": "explode"}) is None
    assert state.fault.mode == "slow", "bad input leaves the current fault alone"


async def test_service_mode_uses_the_shared_crm() -> None:
    crm, state = crm_for_call({"caller_name": "A B"}, "+911111111111")
    assert state is None
    await crm.aclose()
