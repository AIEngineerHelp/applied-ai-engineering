from __future__ import annotations

import pytest

from voiceagent.crm.client import Attempt, CRMError
from voiceagent.crm.server import FaultConfig


def set_fault(state, **kwargs):  # type: ignore[no-untyped-def]
    state.fault = FaultConfig(**kwargs)
    state.fault_remaining = state.fault.count


async def test_finds_patient_by_phone(make_client) -> None:  # type: ignore[no-untyped-def]
    client = make_client()
    patient = await client.find_patient("+15550142201")
    assert patient is not None and patient.first_name == "Priya"
    assert await client.find_patient("+15550000000") is None


async def test_retries_a_500_then_succeeds(crm_state, make_client) -> None:  # type: ignore[no-untyped-def]
    set_fault(crm_state, mode="error_500", count=1, path_prefix="/slots")
    attempts: list[Attempt] = []
    client = make_client()
    client.on_attempt = attempts.append
    slots = await client.open_slots(want=3)
    assert len(slots) == 3
    assert [a.outcome for a in attempts] == ["retryable", "ok"]


async def test_honours_retry_after(crm_state, make_client) -> None:  # type: ignore[no-untyped-def]
    set_fault(crm_state, mode="rate_limit", count=1)
    client = make_client()
    await client.find_patient("+15550142201")
    assert client.sleeps == [1.0]


async def test_gives_up_after_max_attempts(crm_state, make_client) -> None:  # type: ignore[no-untyped-def]
    set_fault(crm_state, mode="down")
    client = make_client(max_attempts=3)
    with pytest.raises(CRMError) as err:
        await client.find_patient("+15550142201")
    assert err.value.kind == "unavailable"
    assert len(client.sleeps) == 2


async def test_rejects_malformed_records(crm_state, make_client) -> None:  # type: ignore[no-untyped-def]
    set_fault(crm_state, mode="bad_data", path_prefix="/slots")
    with pytest.raises(CRMError) as err:
        await make_client().open_slots()
    assert err.value.kind == "bad_data"


async def test_does_not_retry_a_conflict(crm_state, make_client) -> None:  # type: ignore[no-untyped-def]
    client = make_client()
    slot = (await client.open_slots(want=1))[0]
    await client.book("pt_1001", slot.id, "check-up")
    attempts: list[Attempt] = []
    client.on_attempt = attempts.append
    with pytest.raises(CRMError) as err:
        await client.book("pt_1002", slot.id, "check-up")
    assert err.value.kind == "conflict" and len(attempts) == 1


async def test_lost_response_does_not_book_twice(crm_state, make_client) -> None:  # type: ignore[no-untyped-def]
    set_fault(crm_state, mode="lost_response", count=1, path_prefix="/appointments")
    before = len(crm_state.appointments)
    attempts: list[Attempt] = []
    client = make_client(attempt_timeout=0.3)
    client.on_attempt = attempts.append
    slot = (await client.open_slots(want=1))[0]
    appt = await client.book("pt_1001", slot.id, "check-up")
    assert len(crm_state.appointments) == before + 1
    writes = [a for a in attempts if a.method == "POST"]
    assert [a.outcome for a in writes] == ["timeout", "ok"]
    assert writes[0].idempotency_key == writes[1].idempotency_key
    assert crm_state.appointments[appt.id]["slot_id"] == slot.id


async def test_budget_caps_total_wait(crm_state, make_client) -> None:  # type: ignore[no-untyped-def]
    set_fault(crm_state, mode="timeout")
    client = make_client(attempt_timeout=0.2, max_attempts=5)
    with pytest.raises(CRMError) as err:
        await client.find_patient("+15550142201", budget=0.3)
    assert err.value.kind == "timeout"


async def test_pagination_follows_cursor(make_client) -> None:  # type: ignore[no-untyped-def]
    slots = await make_client().open_slots(want=12, max_pages=3)
    assert len(slots) == 12 and len({s.id for s in slots}) == 12
