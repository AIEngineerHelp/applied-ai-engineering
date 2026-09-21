import json

import httpx
import numpy as np
import pytest

from app import config, llm, retrieval


def fake_client(monkeypatch, handler, module):
    original = httpx.Client
    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(module.httpx, "Client", lambda **kwargs: original(transport=transport, **kwargs))
    monkeypatch.setattr(config, "PROVIDER", "gemini")
    monkeypatch.setattr(config, "API_KEY", "test-key")
    monkeypatch.setattr(config, "BASE_URL", "https://generativelanguage.googleapis.com/v1beta")


def test_gemini_structured_answer_and_usage(monkeypatch):
    def handler(request):
        assert request.headers["x-goog-api-key"] == "test-key"
        assert "test-key" not in str(request.url)
        body = json.loads(request.content)
        assert body["generationConfig"]["responseJsonSchema"] == {"type": "object"}
        assert body["systemInstruction"]["parts"][0]["text"] == "instructions"
        return httpx.Response(
            200,
            json={
                "candidates": [
                    {
                        "finishReason": "STOP",
                        "content": {
                            "parts": [
                                {"thought": True, "text": "private reasoning"},
                                {"text": '{"ok": true}'},
                            ]
                        },
                    }
                ],
                "usageMetadata": {"promptTokenCount": 12, "candidatesTokenCount": 5, "thoughtsTokenCount": 3},
            },
        )

    fake_client(monkeypatch, handler, llm)
    value, usage = llm.call_json("instructions", {"question": "test"}, "gemini-2.5-flash", {"type": "object"})
    assert value == {"ok": True}
    assert usage["input_tokens"] == 12
    assert usage["output_tokens"] == 8


def test_gemini_blocked_or_truncated_response_fails_closed(monkeypatch):
    fake_client(
        monkeypatch,
        lambda request: httpx.Response(200, json={"candidates": [{"finishReason": "MAX_TOKENS"}]}),
        llm,
    )
    with pytest.raises(RuntimeError, match="did not complete"):
        llm.call_json("test", {}, "gemini-2.5-flash", {})


def test_gemini_embedding_task_types_and_normalization(monkeypatch):
    tasks = []

    def handler(request):
        body = json.loads(request.content)
        tasks.extend(row["taskType"] for row in body["requests"])
        assert all(row["outputDimensionality"] == 768 for row in body["requests"])
        return httpx.Response(200, json={"embeddings": [{"values": [2.0] * 768} for _ in body["requests"]]})

    fake_client(monkeypatch, handler, retrieval)
    monkeypatch.setattr(config, "EMBEDDING_MODEL", "gemini-embedding-001")
    model = retrieval.GeminiEmbedding()
    doc = list(model.passage_embed(["a passage"]))[0]
    query = list(model.query_embed(["a question"]))[0]
    assert tasks == ["RETRIEVAL_DOCUMENT", "RETRIEVAL_QUERY"]
    assert np.linalg.norm(doc) == pytest.approx(1)
    assert np.linalg.norm(query) == pytest.approx(1)


def test_lexical_index_load_never_initializes_neural_model(monkeypatch):
    if not (config.INDEX / "manifest.json").exists():
        pytest.skip("Local lexical fixture is not prepared")
    monkeypatch.setattr(retrieval, "embedding_model", lambda: pytest.fail("Local neural model started"))
    engine = retrieval.SearchEngine()
    assert engine.search("BRCA1 DNA repair", mode="lexical", expand=False)["evidence"]


def test_gemini_embedding_retries_transient_failure(monkeypatch):
    requests = []

    def handler(request):
        requests.append(request)
        if len(requests) == 1:
            return httpx.Response(429)
        return httpx.Response(200, json={"embeddings": [{"values": [1.0] * 768}]})

    fake_client(monkeypatch, handler, retrieval)
    monkeypatch.setattr(retrieval.time, "sleep", lambda seconds: None)
    assert len(list(retrieval.GeminiEmbedding().query_embed(["test"]))) == 1
    assert len(requests) == 2


def test_expansion_deduplicates_and_never_receives_reference(monkeypatch):
    captured = []

    def call(system, payload, model, schema):
        captured.append(payload)
        return {"alternatives": [" question ", "alternate question"]}, {"input_tokens": 10}

    monkeypatch.setattr(llm, "call_json", call)
    queries, usage = llm.generate_expansions("Question")
    assert queries == ["Question", "alternate question"]
    assert captured == [{"question": "Question"}]
    assert usage["input_tokens"] == 10


@pytest.mark.parametrize(
    "alternatives", [["", "valid query"], ["x" * 501, "valid query"], ["question", "QUESTION"]]
)
def test_expansion_rejects_invalid_alternatives(monkeypatch, alternatives):
    monkeypatch.setattr(llm, "call_json", lambda *args: ({"alternatives": alternatives}, {}))
    with pytest.raises(ValueError):
        llm.generate_expansions("question")
