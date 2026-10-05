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
        # Never echo upstream error bodies: they can repeat the prompt, including attack text.
        if response.status_code >= 400:
            raise ProviderError(f"HTTP {response.status_code}. Check the API key, model name, and quota.")
        return response.json()
    raise ProviderError("Request failed after retries.")


class Gemini:
    def __init__(self, key, client, retries=2, sleep=time.sleep):
        if not key:
            raise ProviderError("Set GEMINI_API_KEY in .env for live Gemini calls.")
        self.key, self.client, self.retries, self.sleep = key, client, retries, sleep

    def _call(self, model, body):
        started = time.perf_counter()
        data = _post(self.client, GEMINI_URL.format(model=model), {"x-goog-api-key": self.key}, body,
                     self.retries, self.sleep)
        candidates = data.get("candidates") or []
        if not candidates or candidates[0].get("finishReason") not in (None, "STOP"):
            reason = candidates[0].get("finishReason") if candidates else "no candidates"
            raise ProviderError(f"Gemini did not finish its response ({reason}).")
        meta = data.get("usageMetadata", {})
        usage = {
            "model": data.get("modelVersion", model),
            "input_tokens": meta.get("promptTokenCount"),
            # Thinking tokens are billed as output.
            "output_tokens": (meta.get("candidatesTokenCount") or 0) + (meta.get("thoughtsTokenCount") or 0),
            "ms": round((time.perf_counter() - started) * 1000),
        }
        return candidates[0].get("content") or {"role": "model", "parts": []}, usage

    def generate(self, model, system, user, schema, max_tokens=2048):
        """One structured-output call: returns parsed JSON and usage."""
        content, usage = self._call(model, {
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": [{"text": user}]}],
            "generationConfig": {
                "temperature": 0,
                "maxOutputTokens": max_tokens,
                "responseMimeType": "application/json",
                "responseJsonSchema": schema,
            },
        })
        text = "".join(p.get("text", "") for p in content.get("parts", []) if not p.get("thought"))
        try:
            return json.loads(text), usage
        except json.JSONDecodeError as error:
            raise ProviderError("Gemini returned malformed JSON.") from error

    def chat(self, model, system, contents, tools, max_tokens=8192):
        """One agent turn with function calling. Returns the model's content unchanged.

        The caller appends that content to the history as-is: Gemini 3 models attach thought
        signatures to their parts, and later turns must send them back exactly as received.
        """
        return self._call(model, {
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": contents,
            "tools": [{"functionDeclarations": tools}],
            "generationConfig": {"temperature": 0, "maxOutputTokens": max_tokens},
        })


class Jev:
    def __init__(self, key, client, retries=2, sleep=time.sleep):
        if not key:
            raise ProviderError("Set TYPESAFE_API_KEY in .env for live Jev calls.")
        self.key, self.client, self.retries, self.sleep = key, client, retries, sleep

    def choose(self, model, state, questions):
        """Ask several choice questions about one state in a single request; Jev answers them in parallel.

        questions: {question_id: {"instructions": str, "criteria": {option: description}}}
        """
        started = time.perf_counter()
        data = _post(
            self.client,
            JEV_URL,
            {"Authorization": f"Bearer {self.key}"},
            {
                "model": model,
                "state": state,
                "questions": {qid: {"type": "choice", **q} for qid, q in questions.items()},
            },
            self.retries,
            self.sleep,
        )
        answers = data.get("answers") or {}
        for qid, question in questions.items():
            if (answers.get(qid) or {}).get("choice") not in question["criteria"]:
                raise ProviderError(f"Jev returned an invalid choice for {qid}.")
        usage = data.get("usage") or {}
        return {qid: answers[qid] for qid in questions}, {
            "model": data.get("model", model),
            "input_tokens": usage.get("input_tokens"),
            "output_tokens": usage.get("output_tokens"),
            "ms": round((time.perf_counter() - started) * 1000),
        }
