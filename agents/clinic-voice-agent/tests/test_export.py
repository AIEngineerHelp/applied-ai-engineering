"""Exports: one call as JSON and the call log as CSV, redacted unless content is asked for."""

from __future__ import annotations

import csv
import io

from fastapi.testclient import TestClient

from voiceagent.api import create_api
from voiceagent.kb import KnowledgeBase
from voiceagent.simulation import load_scenarios, run_scenario


async def _call(store, name: str) -> str:  # type: ignore[no-untyped-def]
    sc = next(s for s in load_scenarios() if s.name == name)
    result = await run_scenario(sc, live=False, store=store, kb=KnowledgeBase())
    return str(result["call_id"])


async def test_call_download_is_redacted_by_default(store) -> None:  # type: ignore[no-untyped-def]
    call_id = await _call(store, "crm-500-then-ok")
    client = TestClient(create_api(store))

    r = client.get(f"/api/calls/{call_id}/export")
    assert r.status_code == 200
    assert f'filename="{call_id}-redacted.json"' in r.headers["content-disposition"]
    doc = r.json()
    assert doc["content_included"] is False
    assert doc["call"]["caller_phone"] is None
    assert doc["post_call"]["end_status"] == "resolved" and "summary" not in doc["post_call"]
    kinds = {e["kind"] for e in doc["events"]}
    assert "transcript" not in kinds and "crm_attempt" in kinds
    assert "+15550142201" not in r.text and "sprained wrist" not in r.text.lower()
    # The CRM story survives redaction: the 500, then the retry that worked.
    outcomes = [e["data"]["outcome"] for e in doc["events"] if e["kind"] == "crm_attempt"]
    assert "retryable" in outcomes

    full = client.get(f"/api/calls/{call_id}/export", params={"content": "true"}).json()
    assert full["content_included"] is True
    assert full["call"]["caller_phone"] == "+15550142201"
    assert any(e["kind"] == "transcript" for e in full["events"])
    assert client.get("/api/calls/nope/export").status_code == 404


async def test_calls_csv_has_one_row_per_call(store) -> None:  # type: ignore[no-untyped-def]
    ok = await _call(store, "crm-500-then-ok")
    down = await _call(store, "crm-down")
    client = TestClient(create_api(store))

    r = client.get("/api/calls.csv", params={"source": "simulation"})
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/csv")
    rows = {row["call_id"]: row for row in csv.DictReader(io.StringIO(r.text))}
    assert set(rows) == {ok, down}
    assert rows[ok]["end_status"] == "resolved" and rows[ok]["intent"] == "book"
    assert int(rows[ok]["crm_failed_attempts"]) == 1
    assert rows[down]["end_status"] == "transferred" and rows[down]["transfer_to"] == "front_desk"
    assert all(row["caller_phone"] == "" for row in rows.values())

    with_phone = client.get("/api/calls.csv", params={"content": "true"}).text
    assert "+15550142201" in with_phone
