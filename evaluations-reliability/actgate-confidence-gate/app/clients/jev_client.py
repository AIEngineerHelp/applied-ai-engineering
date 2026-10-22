from __future__ import annotations

from typing import Any

from app.config import get_settings


def jev_status() -> str:
    return "configured" if get_settings().typesafe_api_key else "missing_key"


def _to_sdk_questions(questions: dict[str, Any]):
    from typesafe_sdk import Choice, Noul, Score

    mapped = {}
    for key, q in questions.items():
        qtype = q.get("type")
        instructions = q.get("instructions", "")
        criteria = q.get("criteria")
        if qtype == "noul":
            mapped[key] = Noul(instructions=instructions, criteria=criteria)
        elif qtype == "choice":
            mapped[key] = Choice(instructions=instructions, criteria=criteria or {})
        elif qtype == "score":
            mapped[key] = Score(instructions=instructions, criteria=criteria or [])
        else:
            raise ValueError(f"Unsupported question type: {qtype}")
    return mapped


def _answers_from_response(response) -> dict[str, Any]:
    out: dict[str, Any] = {}
    # SDK exposes typed maps; also support raw-like access
    for name, attr in (("nouls", "noul"), ("choices", "choice"), ("scores", "score")):
        bucket = getattr(response, name, None) or {}
        for key, ans in bucket.items():
            if hasattr(ans, "model_dump"):
                out[key] = ans.model_dump()
            else:
                data: dict[str, Any] = {"type": attr if attr != "choice" else "choice"}
                if hasattr(ans, "noul"):
                    data = {"type": "noul", "noul": float(ans.noul)}
                if hasattr(ans, "choice"):
                    data = {
                        "type": "choice",
                        "choice": ans.choice,
                        "probabilities": getattr(ans, "probabilities", {}) or {},
                        "confidence": getattr(ans, "confidence", None),
                    }
                if hasattr(ans, "score"):
                    data = {
                        "type": "score",
                        "score": float(ans.score),
                        "legend": getattr(ans, "legend", {}) or {},
                        "probabilities": getattr(ans, "probabilities", {}) or {},
                        "confidence": getattr(ans, "confidence", None),
                    }
                out[key] = data
    if not out and hasattr(response, "answers"):
        raw = response.answers
        if isinstance(raw, dict):
            return raw
    return out


def decide_with_jev(state: Any, questions: dict[str, Any]) -> dict[str, Any]:
    from typesafe_sdk import TypeSafeClient

    settings = get_settings()
    if not settings.typesafe_api_key:
        raise RuntimeError("TYPESAFE_API_KEY is not set")

    with TypeSafeClient(api_key=settings.typesafe_api_key) as client:
        response = client.system_one(
            state=state,
            questions=_to_sdk_questions(questions),
            model="jev-latest",
        )
    return _answers_from_response(response)
