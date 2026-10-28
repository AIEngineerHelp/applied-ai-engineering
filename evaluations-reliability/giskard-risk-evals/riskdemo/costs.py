"""A cost ledger for every Gemini call this project makes: the agent, Giskard's attacker and judge, embeddings.

All of them go through the `google-genai` SDK (Giskard's `gemini/` provider uses it too), so one wrapper
around `AsyncModels.generate_content` and `embed_content` sees every call. Each call is appended to the
Git-ignored runs/costs.jsonl with its token counts and an estimated price.
"""

import contextvars
import json
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from riskdemo import config

# USD per 1M tokens (input, output including thinking), paid tier, from
# https://ai.google.dev/gemini-api/docs/pricing as read on 2026-10-27.
PRICES: dict[str, tuple[float, float]] = {
    "gemini-3.8-flash": (0.75, 3.75),
    "gemini-4-argon": (2.00, 10.00),  # through 2026-11-30
    "gemini-3.1-pro-preview": (2.00, 12.00),
    "gemini-embedding-2": (0.20, 0.0),
}

phase: contextvars.ContextVar[str] = contextvars.ContextVar("phase", default="unlabelled")
_lock = threading.Lock()
_installed = False


def price(model: str, input_tokens: int, output_tokens: int) -> float:
    rate_in, rate_out = PRICES.get(model.removeprefix("models/"), (0.0, 0.0))
    return (input_tokens * rate_in + output_tokens * rate_out) / 1_000_000


def ledger_path() -> Path:
    return config.RUNS / "costs.jsonl"


def record(model: str, input_tokens: int, output_tokens: int, kind: str, estimated: bool = False) -> None:
    row = {
        "at": datetime.now(UTC).isoformat(timespec="seconds"),
        "phase": phase.get(),
        "kind": kind,
        "model": model.removeprefix("models/"),
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "usd": round(price(model, input_tokens, output_tokens), 6),
        "estimated": estimated,
    }
    path = ledger_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with _lock, path.open("a") as f:
        f.write(json.dumps(row) + "\n")


def _usage(response: Any) -> tuple[int, int]:
    u = getattr(response, "usage_metadata", None)
    if u is None:
        return 0, 0
    out = (u.candidates_token_count or 0) + (u.thoughts_token_count or 0)
    return u.prompt_token_count or 0, out


def install() -> None:
    """Wrap the SDK once per process. Safe to call repeatedly."""
    global _installed
    if _installed:
        return
    from google.genai import models

    original_generate = models.AsyncModels.generate_content
    original_embed = models.AsyncModels.embed_content

    async def generate_content(self, *args, **kwargs):
        response = await original_generate(self, *args, **kwargs)
        model = kwargs.get("model") or (args[0] if args else "?")
        record(str(model), *_usage(response), kind="generate")
        return response

    async def embed_content(self, *args, **kwargs):
        response = await original_embed(self, *args, **kwargs)
        model = str(kwargs.get("model") or (args[0] if args else "?"))
        contents = kwargs.get("contents") or []
        texts = [contents] if isinstance(contents, str) else contents
        # The embeddings response carries no token count; estimate 4 characters per token.
        record(model, sum(len(str(t)) for t in texts) // 4, 0, kind="embed", estimated=True)
        return response

    models.AsyncModels.generate_content = generate_content
    models.AsyncModels.embed_content = embed_content
    _installed = True


def summary(path: Path | None = None) -> dict[str, Any]:
    """Totals by phase and by model, from the ledger."""
    path = path or ledger_path()
    by_phase: dict[str, dict[str, float]] = {}
    by_model: dict[str, dict[str, float]] = {}
    total = {"calls": 0, "usd": 0.0}
    if path.exists():
        for line in path.read_text().splitlines():
            row = json.loads(line)
            for bucket, key in ((by_phase, row["phase"]), (by_model, row["model"])):
                b = bucket.setdefault(key, {"calls": 0, "input_tokens": 0, "output_tokens": 0, "usd": 0.0})
                b["calls"] += 1
                b["input_tokens"] += row["input_tokens"]
                b["output_tokens"] += row["output_tokens"]
                b["usd"] = round(b["usd"] + row["usd"], 6)
            total["calls"] += 1
            total["usd"] = round(total["usd"] + row["usd"], 6)
    return {"total": total, "by_phase": by_phase, "by_model": by_model}
