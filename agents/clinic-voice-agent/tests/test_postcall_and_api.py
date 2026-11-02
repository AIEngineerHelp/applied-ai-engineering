from __future__ import annotations

import json
import time

import httpx
from fastapi.testclient import TestClient

from voiceagent.api import create_api
from voiceagent.postcall import deliver_webhook, sign, verify


def test_signature_round_trip_and_staleness() -> None:
    body = b'{"call_id": "c1"}'
    now = str(int(time.time()))
    assert verify("s3cret", now, body, sign("s3cret", now, body))
    assert not verify("other", now, body, sign("s3cret", now, body))
    old = str(int(time.time()) - 3600)
    assert not verify("s3cret", old, body, sign("s3cret", old, body))


async def test_webhook_retries_5xx_and_records_delivery(store) -> None:  # type: ignore[no-untyped-def]
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(503 if len(calls) < 3 else 200)

    async def no_sleep(_: float) -> None:
        return None

    store.outbox_put("c1", {"call_id": "c1"})
    ok = await deliver_webhook(store, "c1", {"call_id": "c1"},
                               transport=httpx.MockTransport(handler), sleep=no_sleep)
    assert ok and len(calls) == 3
    assert {r.headers["Idempotency-Key"] for r in calls} == {"c1"}
    assert store.outbox()[0]["status"] == "delivered"


async def test_webhook_stops_on_permanent_4xx(store) -> None:  # type: ignore[no-untyped-def]
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(400)

    store.outbox_put("c2", {"call_id": "c2"})
    ok = await deliver_webhook(store, "c2", {"call_id": "c2"},
                               transport=httpx.MockTransport(handler))
    assert not ok and len(calls) == 1
    assert store.outbox_pending()[0]["status"] == "failed"


def test_receiver_checks_signature_and_drops_duplicates(store) -> None:  # type: ignore[no-untyped-def]
    client = TestClient(create_api(store))
    body = json.dumps({"call_id": "c3"}).encode()
    ts = str(int(time.time()))
    headers = {"X-Webhook-Timestamp": ts, "Idempotency-Key": "c3",
               "X-Webhook-Signature": sign("dev-webhook-secret", ts, body)}
    first = client.post("/api/webhooks/receiver", content=body, headers=headers)
    second = client.post("/api/webhooks/receiver", content=body, headers=headers)
    assert first.json() == {"accepted": True, "duplicate": False}
    assert second.json()["duplicate"] is True
    bad = client.post("/api/webhooks/receiver", content=body,
                      headers={**headers, "X-Webhook-Signature": "sha256=nope"})
    assert bad.status_code == 401


def test_fault_switch_reaches_mounted_crm(store) -> None:  # type: ignore[no-untyped-def]
    client = TestClient(create_api(store))
    assert client.put("/api/faults", json={"mode": "down"}).status_code == 200
    r = client.get("/crm/patients", params={"phone": "+15550142201"},
                   headers={"Authorization": "Bearer dev-crm-key"})
    assert r.status_code == 503
    client.put("/api/faults", json={"mode": "none"})
    r = client.get("/crm/patients", params={"phone": "+15550142201"},
                   headers={"Authorization": "Bearer dev-crm-key"})
    assert r.json()["data"][0]["id"] == "pt_1001"


def test_crm_requires_auth(store) -> None:  # type: ignore[no-untyped-def]
    client = TestClient(create_api(store))
    assert client.get("/crm/patients", params={"phone": "x"}).status_code == 401


def test_a_visitor_can_call_as_themselves(store, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    from voiceagent import api as api_module

    monkeypatch.setattr(api_module.settings(), "gemini_api_key", "test-key")
    client = TestClient(create_api(store))
    r = client.post("/api/session", json={"caller_name": "  Anjali   Desai ",
                                          "caller_phone": "+91 98765-43210"})
    assert r.status_code == 200
    headers = {"Authorization": "Bearer dev-crm-key"}
    found = client.get("/crm/patients", params={"phone": "+919876543210"}, headers=headers)
    patient = found.json()["data"][0]
    assert (patient["first_name"], patient["last_name"]) == ("Anjali", "Desai")
    visits = client.get(f"/crm/patients/{patient['id']}/appointments", headers=headers)
    assert len(visits.json()["data"]) == 1
    # Calling again with the same number reuses the record instead of adding another.
    client.post("/api/session",
                json={"caller_name": "Anjali Desai", "caller_phone": "919876543210"})
    found = client.get("/crm/patients", params={"phone": "+919876543210"}, headers=headers)
    assert len(found.json()["data"]) == 1
    bad = client.post("/api/session", json={"caller_name": "A", "caller_phone": "12"})
    assert bad.status_code == 400
