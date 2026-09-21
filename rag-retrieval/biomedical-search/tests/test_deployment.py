from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from itsdangerous import URLSafeTimedSerializer

from app import main


@pytest.fixture
def hosted(monkeypatch):
    monkeypatch.setattr(main, "search_signer", URLSafeTimedSerializer("test-secret", salt="helix-search-v1"))
    monkeypatch.setattr(main, "write_event", lambda event: None)
    monkeypatch.setattr(main, "searches", {})
    monkeypatch.setattr(main, "generate_answer", lambda query, evidence: {"query": query, "evidence": evidence})
    monkeypatch.setattr(main, "engine", SimpleNamespace(search=lambda query, **settings: {
        "query": query, "queries": [query], "configuration": settings, "retrieval_ms": 1,
        "evidence": [{"id": "123", "text": "Retrieved evidence", "score": 1}],
    }))
    return TestClient(main.app)


def test_answer_survives_instance_change(hosted):
    result = hosted.post("/api/search", json={"query": "BRCA1 DNA repair"}).json()
    main.searches.clear()
    response = hosted.post("/api/answer", json={
        "search_id": result["search_id"], "search_token": result["search_token"], "passage_ids": ["123"],
    })
    assert response.status_code == 200
    assert response.json()["evidence"][0]["text"] == "Retrieved evidence"
    assert hosted.post("/api/answer", json={
        "search_id": result["search_id"], "search_token": result["search_token"], "passage_ids": ["999"],
    }).status_code == 422


def test_signed_evidence_rejects_tampering_mismatched_ids_and_expiry(hosted, monkeypatch):
    result = hosted.post("/api/search", json={"query": "BRCA1 DNA repair"}).json()
    main.searches.clear()
    payload = {"search_id": result["search_id"], "search_token": result["search_token"]}
    assert hosted.post("/api/answer", json={**payload, "search_token": payload["search_token"] + "x"}).status_code == 404
    assert hosted.post("/api/answer", json={**payload, "search_id": "different"}).status_code == 404
    from itsdangerous.timed import TimestampSigner
    original = TimestampSigner.get_timestamp
    monkeypatch.setattr(TimestampSigner, "get_timestamp", lambda self: original(self) + 3601)
    assert hosted.post("/api/answer", json=payload).status_code == 404
