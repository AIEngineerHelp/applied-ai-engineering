"""Thin HTTP clients for Gemini (generateContent) and TypeSafe Jev (choice primitive).

Both take an injectable httpx.Client so tests run against a mock transport.
"""

import json
import time

import httpx

GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
JEV_URL = "https://api.typesafe.ai/v1/systemone"
# 520-524 are transient gateway errors in front of some providers.
RETRYABLE = {429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 529}


class ProviderError(RuntimeError):
    pass


def _post(client, url, headers, body, retries, sleep=time.sleep):
    """POST with bounded retries on rate limits and server errors."""
    for attempt in range(retries + 1):
        try:
            response = client.post(url, headers=headers, json=body)
        except httpx.TimeoutException as error:
            if attempt == retries:
                raise ProviderError("Request timed out.") from error
            sleep(2 ** (attempt + 1))
            continue
        if response.status_code in RETRYABLE and attempt < retries:
            sleep(2 ** (attempt + 1))
            continue
        # Never echo upstream error bodies: they can contain the prompt.
        if response.status_code >= 400:
            raise ProviderError(
                f"HTTP {response.status_code}. Check the API key, model name, and quota."
            )
        return response.json()
    raise ProviderError("Request failed after retries.")


class Gemini:
    def __init__(self, key, client, retries=2, sleep=time.sleep):
        if not key:
            raise ProviderError("Set GEMINI_API_KEY in .env for live Gemini calls.")
        self.key, self.client, self.retries, self.sleep = key, client, retries, sleep

    def generate(self, model, system, user, schema, temperature=0.0, max_tokens=4096):
        started = time.perf_counter()
        data = _post(
            self.client,
            GEMINI_URL.format(model=model),
            {"x-goog-api-key": self.key},
            {
                "systemInstruction": {"parts": [{"text": system}]},
                "contents": [{"role": "user", "parts": [{"text": user}]}],
                "generationConfig": {
                    "temperature": temperature,
                    "maxOutputTokens": max_tokens,
                    "responseMimeType": "application/json",
                    "responseJsonSchema": schema,
                },
            },
            self.retries,
            self.sleep,
        )
        candidates = data.get("candidates") or []
        if not candidates or candidates[0].get("finishReason") not in (None, "STOP"):
            # Thinking tokens count toward maxOutputTokens, so a long reasoning step can hit the limit.
            raise ProviderError(f"Gemini did not finish its response ({candidates[0].get('finishReason') if candidates else 'no candidates'}).")
        text = "".join(
            part.get("text", "")
            for part in candidates[0].get("content", {}).get("parts", [])
            if not part.get("thought")
        )
        try:
            result = json.loads(text)
        except json.JSONDecodeError as error:
            raise ProviderError("Gemini returned malformed JSON.") from error
        meta = data.get("usageMetadata", {})
        return result, {
            "model": data.get("modelVersion", model),
            "input_tokens": meta.get("promptTokenCount"),
            # Thinking tokens are billed as output.
            "output_tokens": (meta.get("candidatesTokenCount") or 0) + (meta.get("thoughtsTokenCount") or 0),
            "ms": round((time.perf_counter() - started) * 1000),
        }


class Jev:
    def __init__(self, key, client, retries=2, sleep=time.sleep):
        if not key:
            raise ProviderError("Set TYPESAFE_API_KEY in .env for live Jev calls.")
        self.key, self.client, self.retries, self.sleep = key, client, retries, sleep

    def choose(self, model, state, instructions, criteria):
        started = time.perf_counter()
        data = _post(
            self.client,
            JEV_URL,
            {"Authorization": f"Bearer {self.key}"},
            {
                "model": model,
                "state": state,
                "questions": {
                    "verdict": {"type": "choice", "instructions": instructions, "criteria": criteria}
                },
            },
            self.retries,
            self.sleep,
        )
        answer = (data.get("answers") or {}).get("verdict") or {}
        if answer.get("choice") not in criteria:
            raise ProviderError("Jev returned an invalid choice.")
        usage = data.get("usage") or {}
        return answer, {
            "model": data.get("model", model),
            "input_tokens": usage.get("input_tokens"),
            "output_tokens": usage.get("output_tokens"),
            "ms": round((time.perf_counter() - started) * 1000),
        }
