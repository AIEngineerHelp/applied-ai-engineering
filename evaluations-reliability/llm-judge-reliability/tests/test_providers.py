import json

import httpx
import pytest

from judgelab import prompts
from judgelab.providers import Gemini, Jev, ProviderError


def client(handler):
    return httpx.Client(transport=httpx.MockTransport(handler))


def gemini_reply(payload, finish="STOP"):
    return httpx.Response(200, json={
        "candidates": [{"finishReason": finish, "content": {"parts": [
            {"text": "thinking...", "thought": True}, {"text": json.dumps(payload)}]}}],
        "usageMetadata": {"promptTokenCount": 100, "candidatesTokenCount": 10, "thoughtsTokenCount": 5},
        "modelVersion": "gemini-test-001",
    })


def test_gemini_parses_json_and_counts_thinking_tokens():
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        seen["key"] = request.headers["x-goog-api-key"]
        seen["body"] = json.loads(request.content)
        return gemini_reply({"verdict": "pass"})

    result, usage = Gemini("k", client(handler)).generate("m1", "sys", "user", prompts.VERDICT_SCHEMA)
    assert result == {"verdict": "pass"}
    assert usage["output_tokens"] == 15 and usage["model"] == "gemini-test-001"
    assert seen["url"].endswith("/models/m1:generateContent") and seen["key"] == "k"
    assert seen["body"]["generationConfig"]["responseJsonSchema"] == prompts.VERDICT_SCHEMA


def test_gemini_retries_rate_limit_then_succeeds():
    calls = []

    def handler(request):
        calls.append(1)
        return httpx.Response(429) if len(calls) == 1 else gemini_reply({"answer": "x"})

    result, _ = Gemini("k", client(handler), retries=2, sleep=lambda s: None).generate("m", "s", "u", {})
    assert result == {"answer": "x"} and len(calls) == 2


def test_gemini_error_does_not_echo_body():
    def handler(request):
        return httpx.Response(400, text="secret prompt text")

    with pytest.raises(ProviderError) as error:
        Gemini("k", client(handler), sleep=lambda s: None).generate("m", "s", "u", {})
    assert "secret" not in str(error.value)


def test_gemini_rejects_unfinished_and_malformed():
    with pytest.raises(ProviderError):
        Gemini("k", client(lambda r: gemini_reply({}, finish="MAX_TOKENS"))).generate("m", "s", "u", {})
    bad = httpx.Response(200, json={"candidates": [{"finishReason": "STOP", "content": {"parts": [{"text": "{"}]}}]})
    with pytest.raises(ProviderError):
        Gemini("k", client(lambda r: bad)).generate("m", "s", "u", {})


def test_missing_keys_fail_early():
    with pytest.raises(ProviderError):
        Gemini("", client(lambda r: None))
    with pytest.raises(ProviderError):
        Jev("", client(lambda r: None))


def test_jev_choice_request_and_parse():
    seen = {}

    def handler(request):
        seen["auth"] = request.headers["authorization"]
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={
            "model": "jev-1.13.0",
            "answers": {"verdict": {"type": "choice", "choice": "fail", "confidence": 0.8,
                                    "probabilities": {"pass": 0.1, "fail": 0.9}}},
            "usage": {"input_tokens": 300, "output_tokens": 20},
        })

    variant = prompts.VARIANTS["jev-rubric"]
    answer, usage = Jev("t", client(handler)).choose("jev-latest", {"a": 1}, variant["instructions"], variant["criteria"])
    assert answer["choice"] == "fail" and usage["model"] == "jev-1.13.0"
    assert seen["auth"] == "Bearer t"
    assert seen["body"]["questions"]["verdict"]["type"] == "choice"
    assert set(seen["body"]["questions"]["verdict"]["criteria"]) == {"pass", "fail"}


def test_jev_invalid_choice():
    reply = httpx.Response(200, json={"answers": {"verdict": {"choice": "maybe"}}})
    with pytest.raises(ProviderError):
        Jev("t", client(lambda r: reply)).choose("m", {}, "i", {"pass": "p", "fail": "f"})
