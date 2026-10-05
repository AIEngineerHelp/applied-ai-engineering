import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
RUNS = ROOT / "runs"
RESULTS = ROOT / "results"

MESSAGES = DATA / "messages.jsonl"
SCENARIOS = DATA / "scenarios.jsonl"
STORE = DATA / "store.json"


def _rate(env, key):
    value = (env.get(key) or "").strip()
    try:
        return float(value) if value and float(value) >= 0 else None
    except ValueError:
        return None


def _int(env, key, default, low, high):
    try:
        value = int(env.get(key, default))
    except ValueError:
        return default
    return min(max(value, low), high)


@dataclass(frozen=True)
class Settings:
    gemini_key: str = ""
    typesafe_key: str = ""
    gemini_model: str = "gemini-3.8-flash"
    jev_model: str = "jev-latest"
    timeout_s: int = 60
    max_retries: int = 2
    max_workers: int = 4
    # (input, output) USD per million tokens, or None when unknown. Jev charges input tokens only.
    rates: dict = field(default_factory=lambda: {"gemini": (None, None), "jev": (None, 0.0)})


def load_settings(env=None):
    if env is None:
        load_dotenv(ROOT / ".env")
        env = os.environ
    return Settings(
        gemini_key=env.get("GEMINI_API_KEY", ""),
        typesafe_key=env.get("TYPESAFE_API_KEY", ""),
        gemini_model=env.get("GEMINI_MODEL") or "gemini-3.8-flash",
        jev_model=env.get("JEV_MODEL") or "jev-latest",
        timeout_s=_int(env, "REQUEST_TIMEOUT_S", 60, 5, 300),
        max_retries=_int(env, "MAX_RETRIES", 2, 0, 5),
        max_workers=_int(env, "MAX_WORKERS", 4, 1, 16),
        rates={
            "gemini": (_rate(env, "GEMINI_INPUT_USD_PER_MILLION"), _rate(env, "GEMINI_OUTPUT_USD_PER_MILLION")),
            "jev": (_rate(env, "JEV_INPUT_USD_PER_MILLION"), 0.0),
        },
    )


def cost(rates, input_tokens, output_tokens):
    rate_in, rate_out = rates
    if rate_in is None or rate_out is None:
        return None
    return ((input_tokens or 0) * rate_in + (output_tokens or 0) * rate_out) / 1_000_000
