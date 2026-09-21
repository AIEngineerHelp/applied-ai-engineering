import math

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.llm import generate_answer, selected_context, validate_answer
from app.retrieval import expand_query, reciprocal_rank_fusion, top_indices
from scripts.evaluate import retrieval_metrics
from scripts.prepare import parse_ids


def test_metrics_hand_computed():
    result = retrieval_metrics(["irrelevant", "a", "irrelevant-2", "b"], ["a", "b", "c"])
    assert result["recall_at_5"] == pytest.approx(2 / 3)
    assert result["recall_at_10"] == pytest.approx(2 / 3)
    assert result["mrr_at_10"] == 0.5
    ideal = 1 + 1 / math.log2(3) + 1 / math.log2(4)
    assert result["ndcg_at_10"] == pytest.approx((1 / math.log2(3) + 1 / math.log2(5)) / ideal)


def test_metrics_duplicate_ids_cannot_inflate_scores():
    assert retrieval_metrics([1, 1, 1], [1, 2])["recall_at_10"] == 0.5
    assert retrieval_metrics([1], [1])["ndcg_at_10"] == 1
    assert retrieval_metrics([], [1])["mrr_at_10"] == 0
    with pytest.raises(ValueError):
        retrieval_metrics([], [])


def test_rrf_combines_agreement_and_weights():
    fused = reciprocal_rank_fusion([[0, 1], [1, 2]], weights=[0.6, 0.4], k=60)
    assert fused[0][0] == 1
    assert fused[0][1] == pytest.approx(0.6 / 62 + 0.4 / 61)


def test_zero_hit_lexical_documents_are_excluded_and_ties_are_stable():
    assert top_indices(np.array([0, 2, 2, 1]), 3) == [1, 2, 3]
    assert top_indices(np.zeros(5), 10) == []


def test_expansion_retains_original_and_has_boundaries(monkeypatch):
    from app import llm

    question = "How does EGFR affect lung cancer?"
    monkeypatch.setattr(
        llm,
        "call_json",
        lambda *args: (
            {
                "alternatives": [
                    "How does epidermal growth factor receptor affect lung cancer?",
                    "EGFR effects in lung cancer",
                ]
            },
            {"model": "test-model"},
        ),
    )
    expanded = expand_query(question)
    assert expanded[0] == question
    assert len(expanded) == 3
    assert "epidermal growth factor receptor" in expanded[1]


def test_parse_ids_is_safe_and_canonical():
    assert parse_ids("[123, 456, 123]") == ["123", "456"]
    with pytest.raises((ValueError, SyntaxError)):
        parse_ids("__import__('os').system('whoami')")


def test_context_is_bounded_and_exact():
    evidence = [{"id": str(i), "text": "a" * 2000} for i in range(10)]
    context = selected_context(evidence)
    assert len(context) == 5
    assert all(len(p["text"]) == 1800 for p in context)


def test_citation_validation_rejects_unselected_and_uncontrolled_citations():
    context = [{"id": "123", "text": "Some evidence."}]
    answer = {"status": "answered", "claims": [{"text": "A supported claim.", "passage_ids": ["123"]}]}
    assert validate_answer(answer, context)["claims"][0]["passage_ids"] == ["123"]
    answer["claims"][0]["passage_ids"] = ["999"]
    with pytest.raises(ValueError, match="outside"):
        validate_answer(answer, context)
    answer["claims"][0] = {"text": "A claim [999].", "passage_ids": ["123"]}
    with pytest.raises(ValueError, match="uncontrolled"):
        validate_answer(answer, context)


def test_answer_and_abstention_structure():
    with pytest.raises(ValueError):
        validate_answer({"status": "answered", "claims": []}, [])
    with pytest.raises(ValueError):
        validate_answer(
            {"status": "insufficient_evidence", "claims": [{"text": "Unsupported.", "passage_ids": ["1"]}]},
            [{"id": "1", "text": "x"}],
        )
    assert (
        validate_answer({"status": "insufficient_evidence", "claims": []}, [])["status"]
        == "insufficient_evidence"
    )


def test_generator_fails_closed_on_invalid_model_citation(monkeypatch):
    from app import llm

    monkeypatch.setattr(
        llm,
        "call_json",
        lambda *args: (
            {"status": "answered", "claims": [{"text": "An unsafe claim.", "passage_ids": ["999"]}]},
            {"model": "test", "cost_usd": 0},
        ),
    )
    result = generate_answer("question", [{"id": "123", "text": "retrieved evidence"}])
    assert result["status"] == "insufficient_evidence"
    assert not result["citation_valid"]
    assert result["claims"] == []
    assert result["context"] == [{"id": "123", "text": "retrieved evidence"}]


def test_no_evidence_never_calls_the_model(monkeypatch):
    from app import llm

    def should_not_call(*args):
        raise AssertionError("An empty retrieval must not call the LLM")

    monkeypatch.setattr(llm, "call_json", should_not_call)
    result = generate_answer("question", [])
    assert result["status"] == "insufficient_evidence"
    assert result["usage"] is None


@pytest.fixture
def client(monkeypatch, tmp_path):
    from app import main

    monkeypatch.setattr(main.config, "EXPERIMENTS", tmp_path)
    monkeypatch.setattr(main, "engine", None)
    main.searches.clear()
    return TestClient(main.app)


def test_api_validates_input_and_loading_state(client):
    assert client.post("/api/search", json={"query": "   "}).status_code == 422
    assert client.post("/api/search", json={"query": "test", "mode": "unknown"}).status_code == 422
    assert client.post("/api/search", json={"query": "test", "top_k": 200}).status_code == 422
    assert client.post("/api/search", json={"query": "test"}).status_code == 503


def test_answer_api_cannot_inject_context(client, monkeypatch):
    from app import main

    main.searches["test-id"] = {"query": "question", "evidence": [{"id": "123", "text": "evidence"}]}
    assert client.post("/api/answer", json={"search_id": "missing"}).status_code == 404
    assert (
        client.post("/api/answer", json={"search_id": "test-id", "passage_ids": ["999"]}).status_code == 422
    )
    assert (
        client.post("/api/answer", json={"search_id": "test-id", "passage_ids": ["123", "123"]}).status_code
        == 422
    )
    called = []

    def fake_answer(query, evidence):
        called.append(evidence)
        return {"status": "insufficient_evidence", "claims": [], "context": evidence}

    monkeypatch.setattr(main, "generate_answer", fake_answer)
    assert (
        client.post("/api/answer", json={"search_id": "test-id", "passage_ids": ["123"]}).status_code == 200
    )
    assert called == [[{"id": "123", "text": "evidence"}]]


def test_static_ui_and_experiment_empty_state(client):
    assert client.get("/").status_code == 200
    assert "Helix" in client.get("/").text
    assert client.get("/api/experiments").json()["status"] == "not_run"


def test_best_mode_requires_results_and_matching_index(client, monkeypatch):
    import json
    from types import SimpleNamespace

    from app import main

    monkeypatch.setattr(main, "engine", SimpleNamespace(manifest={"corpus_sha256": "current"}))
    assert client.post("/api/search", json={"query": "question", "mode": "best"}).status_code == 409
    (main.config.EXPERIMENTS / "best-config.json").write_text(
        json.dumps(
            {
                "variant": "hybrid",
                "configuration": {"mode": "hybrid", "expand": False},
                "index_signature": {"corpus_sha256": "previous"},
            }
        )
    )
    assert client.post("/api/search", json={"query": "question", "mode": "best"}).status_code == 409


def test_best_mode_uses_measured_settings_not_current_defaults(client, monkeypatch):
    import json
    from types import SimpleNamespace

    from app import main

    captured = []

    def search(query, **settings):
        captured.append(settings)
        return {
            "query": query,
            "queries": [query],
            "evidence": [],
            "configuration": settings,
            "retrieval_ms": 1,
        }

    monkeypatch.setattr(main, "engine", SimpleNamespace(manifest={"corpus_sha256": "current"}, search=search))
    measured = {"mode": "hybrid", "expand": False, "lexical_weight": 0.72, "rrf_k": 35}
    (main.config.EXPERIMENTS / "best-config.json").write_text(
        json.dumps(
            {
                "variant": "hybrid",
                "configuration": measured,
                "index_signature": {"corpus_sha256": "current"},
            }
        )
    )
    response = client.post("/api/search", json={"query": "question", "mode": "best", "top_k": 5})
    assert response.status_code == 200
    assert captured == [{**measured, "top_k": 5}]


def test_indexed_neural_pipeline_across_request_threads():
    from concurrent.futures import ThreadPoolExecutor

    from app import config
    from app.retrieval import SearchEngine

    if config.EMBEDDING_BACKEND == "gemini":
        pytest.skip("Cloud neural integration requires an explicit live API run")
    if not (config.INDEX / "manifest.json").exists():
        pytest.skip("Prepare the real corpus to run the neural integration check")
    # Regression: loading MLX on one thread then querying on another broke live API searches.
    with ThreadPoolExecutor(max_workers=1) as loader:
        engine = loader.submit(SearchEngine).result()
    with ThreadPoolExecutor(max_workers=2) as requests:
        first = requests.submit(engine.search, "BRCA1 DNA repair", mode="hybrid", expand=True).result()
        second = requests.submit(engine.search, "BRCA1 DNA repair", mode="hybrid", expand=True).result()
    assert len(first["evidence"]) == 10
    assert [p["id"] for p in first["evidence"]] == [p["id"] for p in second["evidence"]]
    assert all(np.isfinite(p["score"]) for p in first["evidence"])
