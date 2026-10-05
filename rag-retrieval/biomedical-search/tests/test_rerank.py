import json
from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient

from app import config, rerank


def candidates(n):
    return [{"id": f"p{i}", "text": f"passage {i}", "rank": i, "score": 1 / i} for i in range(1, n + 1)]


def fake_typesafe(monkeypatch, handler):
    original = httpx.Client
    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(rerank.httpx, "Client", lambda **kwargs: original(transport=transport, **kwargs))
    monkeypatch.setattr(rerank.time, "sleep", lambda seconds: None)
    monkeypatch.setattr(config, "TYPESAFE_API_KEY", "ts-key")


def jev_response(score, input_tokens=100):
    return httpx.Response(
        200,
        json={
            "model": "jev-1.13.0",
            "answers": {"relevance": {"type": "score", "score": score}},
            "usage": {"input_tokens": input_tokens, "output_tokens": 4},
        },
    )


def test_jev_sends_one_score_question_per_passage_and_sorts_by_grade(monkeypatch):
    grades = {"passage 1": 0.4, "passage 2": 2.9, "passage 3": 1.7}
    seen = []

    def handler(request):
        assert request.headers["authorization"] == "Bearer ts-key"
        body = json.loads(request.content)
        question = body["questions"]["relevance"]
        assert question["type"] == "score" and question["criteria"] == rerank.LEVELS
        assert body["state"]["question"] == "query"
        seen.append(body["state"]["passage"])
        return jev_response(grades[body["state"]["passage"]])

    fake_typesafe(monkeypatch, handler)
    monkeypatch.setattr(config, "TYPESAFE_INPUT_USD_PER_MILLION", 0.042)
    ranked, usage = rerank.rerank("query", candidates(3), "jev", top_k=2)
    assert sorted(seen) == ["passage 1", "passage 2", "passage 3"]
    assert [p["id"] for p in ranked] == ["p2", "p3"]
    assert [(p["rank"], p["retrieval_rank"]) for p in ranked] == [(1, 2), (2, 3)]
    assert ranked[0]["rerank_score"] == 2.9
    assert usage["calls"] == 3 and usage["input_tokens"] == 300 and usage["model"] == "jev-1.13.0"
    assert usage["cost_usd"] == pytest.approx(300 * 0.042 / 1_000_000)
    trace = ranked[0]["rerank_trace"]
    assert trace["request"]["body"]["state"] == {"question": "query", "passage": "passage 2"}
    assert trace["response"]["answers"]["relevance"]["score"] == 2.9
    assert "ts-key" not in json.dumps(trace)


def test_equal_grades_keep_retrieval_order(monkeypatch):
    fake_typesafe(monkeypatch, lambda request: jev_response(2.0))
    ranked, _ = rerank.rerank("query", candidates(4), "jev", top_k=4)
    assert [p["id"] for p in ranked] == ["p1", "p2", "p3", "p4"]


def test_jev_retries_rate_limits_within_bound(monkeypatch):
    attempts = []
    succeed_on = [3]

    def handler(request):
        attempts.append(1)
        return jev_response(1.0) if len(attempts) == succeed_on[0] else httpx.Response(429)

    fake_typesafe(monkeypatch, handler)
    monkeypatch.setattr(config, "RERANK_RETRIES", 2)
    rerank.rerank("query", candidates(1), "jev", top_k=1)
    assert len(attempts) == 3

    attempts.clear()
    succeed_on[0] = None  # every attempt is rate limited
    with pytest.raises(rerank.RerankError, match="HTTP 429"):
        rerank.rerank("query", candidates(1), "jev", top_k=1)
    assert len(attempts) == 3


def test_jev_errors_never_echo_upstream_body(monkeypatch):
    fake_typesafe(monkeypatch, lambda request: httpx.Response(400, text="secret passage text"))
    with pytest.raises(rerank.RerankError) as error:
        rerank.rerank("query", candidates(1), "jev", top_k=1)
    assert "secret" not in str(error.value)


@pytest.mark.parametrize("score", [None, -0.1, 3.5, "2"])
def test_jev_invalid_scores_fail_closed(monkeypatch, score):
    fake_typesafe(monkeypatch, lambda request: jev_response(score))
    with pytest.raises(rerank.RerankError, match="invalid relevance score"):
        rerank.rerank("query", candidates(1), "jev", top_k=1)


def test_jev_requires_key(monkeypatch):
    monkeypatch.setattr(config, "TYPESAFE_API_KEY", "")
    with pytest.raises(rerank.RerankError, match="TYPESAFE_API_KEY"):
        rerank.rerank("query", candidates(1), "jev", top_k=1)


def gemini_ready(monkeypatch, grades):
    monkeypatch.setattr(config, "PROVIDER", "gemini")
    monkeypatch.setattr(config, "API_KEY", "g-key")
    calls = []

    def fake_call_json(system, payload, model, schema):
        calls.append(payload)
        return {"grades": grades}, {"model": model, "input_tokens": 50, "output_tokens": 10, "latency_ms": 5}

    monkeypatch.setattr(rerank, "call_json", fake_call_json)
    return calls


def test_gemini_grades_the_shortlist_in_one_call(monkeypatch):
    calls = gemini_ready(
        monkeypatch, [{"id": "p1", "relevance": 1}, {"id": "p2", "relevance": 3}, {"id": "p3", "relevance": 1}]
    )
    ranked, usage = rerank.rerank("query", candidates(3), "gemini", top_k=3)
    assert len(calls) == 1 and [p["id"] for p in calls[0]["passages"]] == ["p1", "p2", "p3"]
    assert [p["id"] for p in ranked] == ["p2", "p1", "p3"]
    assert usage["calls"] == 1
    assert all("rerank_trace" not in p for p in ranked)


@pytest.mark.parametrize(
    "grades",
    [
        [{"id": "p1", "relevance": 1}],
        [{"id": "p1", "relevance": 1}, {"id": "p1", "relevance": 2}],
        [{"id": "p1", "relevance": 1}, {"id": "invented", "relevance": 3}],
        [{"id": "p1", "relevance": 1}, {"id": "p2", "relevance": 7}],
    ],
)
def test_gemini_must_grade_every_candidate_exactly_once(monkeypatch, grades):
    gemini_ready(monkeypatch, grades)
    with pytest.raises(rerank.RerankError):
        rerank.rerank("query", candidates(2), "gemini", top_k=2)


@pytest.fixture
def client(monkeypatch, tmp_path):
    from app import main

    monkeypatch.setattr(main.config, "EXPERIMENTS", tmp_path)
    captured = []

    def search(query, **settings):
        captured.append(settings)
        return {
            "query": query,
            "queries": [query],
            "evidence": candidates(settings["top_k"]),
            "configuration": dict(settings),
            "retrieval_ms": 1,
        }

    monkeypatch.setattr(main, "engine", SimpleNamespace(manifest={}, search=search))
    return TestClient(main.app), captured


def test_search_api_reranks_a_deeper_shortlist(client, monkeypatch):
    from app import main

    api, captured = client
    monkeypatch.setattr(main.config, "RERANK_DEPTH", 30)
    monkeypatch.setattr(
        main,
        "rerank",
        lambda query, evidence, reranker, top_k: (
            [{**p, "retrieval_rank": p["rank"]} for p in evidence[::-1][:top_k]],
            {"reranker": reranker},
        ),
    )
    body = api.post("/api/search", json={"query": "question", "expand": False, "rerank": "jev"}).json()
    assert captured[-1]["top_k"] == 30
    assert len(body["evidence"]) == 10 and body["evidence"][0]["id"] == "p30"
    assert body["configuration"]["top_k"] == 10 and body["rerank"] == {"reranker": "jev"}

    body = api.post("/api/search", json={"query": "question", "expand": False}).json()
    assert captured[-1]["top_k"] == 10 and body["rerank"] is None


def test_search_api_rejects_unknown_or_unconfigured_rerankers(client, monkeypatch):
    api, _ = client
    assert api.post("/api/search", json={"query": "question", "rerank": "cohere"}).status_code == 422
    monkeypatch.setattr(config, "TYPESAFE_API_KEY", "")
    response = api.post("/api/search", json={"query": "question", "expand": False, "rerank": "jev"})
    assert response.status_code == 503 and "TYPESAFE_API_KEY" in response.json()["detail"]


def test_signed_token_excludes_rerank_traces(client, monkeypatch):
    from itsdangerous import URLSafeTimedSerializer

    from app import main

    api, _ = client
    signer = URLSafeTimedSerializer("x" * 32, salt="test")
    monkeypatch.setattr(main, "search_signer", signer)
    monkeypatch.setattr(
        main,
        "rerank",
        lambda query, evidence, reranker, top_k: (
            [{**p, "rerank_trace": {"response": {}}} for p in evidence[:top_k]],
            {"reranker": reranker},
        ),
    )
    body = api.post("/api/search", json={"query": "question", "expand": False, "rerank": "jev"}).json()
    assert "rerank_trace" in body["evidence"][0]
    assert all("rerank_trace" not in p for p in signer.loads(body["search_token"])["evidence"])
