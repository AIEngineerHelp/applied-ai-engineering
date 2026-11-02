"""Cost per call from the usage the session reports.

Prices are list prices checked on 2026-10-28 (paid tier, standard processing):
  Gemini: https://ai.google.dev/gemini-api/docs/pricing
  LiveKit Inference: https://livekit.com/pricing/inference
They change; update the table rather than trusting old numbers. Telephony minutes,
LiveKit Cloud connection minutes and cache discounts are not included.
"""

from __future__ import annotations

from typing import Any

CHECKED = "2026-10-28"
PER_MILLION = 1_000_000

# USD per 1M tokens unless the key says otherwise.
PRICES: dict[str, dict[str, float]] = {
    "gemini-3.8-live": {
        "input_text": 0.75, "input_audio": 3.00, "output_text": 4.50, "output_audio": 12.00,
    },
    "gemini-3.8-flash": {"input": 0.75, "output": 3.75},
    "gemini-3.1-flash-tts-preview": {"input_text": 1.00, "output_audio": 20.00},
    "deepgram/nova-3": {"per_minute": 0.0048},
    "deepgram/flux-general": {"per_minute": 0.0065},
}
TTS_AUDIO_TOKENS_PER_SECOND = 25  # stated on the Gemini pricing page for its TTS models
CHARS_PER_TOKEN = 4  # estimate for TTS input text; Gemini TTS does not report input tokens


class UsageMeter:
    """Usage counters per model, taken from the session's cumulative usage snapshots.

    Counters are named after the price keys, so a model is charged only for the keys its
    price lists: a realtime model by modality, a text model by input and output.
    """

    def __init__(self) -> None:
        self.counters: dict[str, dict[str, float]] = {}

    def from_session_usage(self, usage: Any, models: dict[str, str]) -> None:
        for u in usage.model_usage:
            if u.type == "llm_usage":
                self.counters[models["llm"]] = {
                    "input": u.input_tokens, "output": u.output_tokens,
                    "input_text": u.input_text_tokens, "input_audio": u.input_audio_tokens,
                    "output_text": u.output_text_tokens, "output_audio": u.output_audio_tokens,
                }
            elif u.type == "tts_usage":
                self.counters[models["tts"]] = {
                    "input_text": u.input_tokens or u.characters_count / CHARS_PER_TOKEN,
                    "output_audio": u.output_tokens
                    or u.audio_duration * TTS_AUDIO_TOKENS_PER_SECOND,
                }
            elif u.type == "stt_usage":
                self.counters[models["stt"]] = {"audio_seconds": u.audio_duration}

    def as_dict(self) -> dict[str, dict[str, float]]:
        return {m: {k: round(v, 2) for k, v in c.items() if v}
                for m, c in self.counters.items()}


def cost_usd(usage: dict[str, dict[str, float]]) -> tuple[float, list[str]]:
    """Total cost and the models that had usage but no price (counted as zero)."""
    total = 0.0
    unpriced = []
    for model, counts in usage.items():
        price = PRICES.get(model)
        if price is None:
            if any(counts.values()):
                unpriced.append(model)
            continue
        for key, amount in counts.items():
            if key == "audio_seconds":
                total += amount / 60 * price.get("per_minute", 0.0)
            else:
                total += amount / PER_MILLION * price.get(key, 0.0)
    return round(total, 6), unpriced
