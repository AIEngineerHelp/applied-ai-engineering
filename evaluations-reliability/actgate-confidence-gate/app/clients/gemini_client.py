from __future__ import annotations

from typing import Any

from app.config import get_settings


def gemini_status() -> str:
    return "configured" if get_settings().gemini_api_key else "missing_key"


def draft_reply(
    *,
    subject: str | None,
    body: str,
    intent: str,
    urgency: float,
    risk: str,
    answers: dict[str, Any],
) -> str:
    from google import genai

    settings = get_settings()
    if not settings.gemini_api_key:
        raise RuntimeError("GEMINI_API_KEY is not set")

    client = genai.Client(api_key=settings.gemini_api_key)
    prompt = f"""You are a careful customer-support writer.
A decision system already classified this ticket. Do NOT invent a new category.
Write a short, professional reply the human can send after review.

Subject: {subject or "(none)"}
Customer message:
{body}

Locked decisions:
- intent: {intent}
- urgency score (0-1): {urgency:.2f}
- risk: {risk}
- raw answers: {answers}

Rules:
- Be empathetic and specific to the message
- Do not promise refunds or legal outcomes unless intent is clearly refund and risk is low — then say you will investigate and follow up
- Max 140 words
- No markdown headings
"""
    result = client.models.generate_content(
        model=settings.gemini_model,
        contents=prompt,
    )
    text = getattr(result, "text", None)
    if text:
        return text.strip()
    # Fallback parse
    try:
        return result.candidates[0].content.parts[0].text.strip()
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"Gemini returned empty draft: {exc}") from exc
