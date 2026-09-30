import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
RUNS = ROOT / "runs"
RESULTS = ROOT / "results"

# Each dataset keeps its own cases file, raw judge runs and aggregate results.
DATASETS = {
    "synthetic": DATA / "cases.jsonl",
    "ragtruth": DATA / "ragtruth" / "cases.jsonl",
}

# Optional reviews of answers where a judge and the dataset's label disagree.
REVIEWS = {"ragtruth": DATA / "ragtruth-review.json"}


def paths(dataset):
    if dataset not in DATASETS:
        raise ValueError(f"Unknown dataset {dataset}. Choose from: {', '.join(DATASETS)}")
    return DATASETS[dataset], RUNS / dataset, RESULTS / dataset


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
    gemini_judge_model: str = "gemini-3.8-flash"
    jev_model: str = "jev-latest"
    judge_temperature: float = 0.0
    timeout_s: int = 60
    max_retries: int = 2
    max_workers: int = 4
    # (input, output) USD per million tokens, or None when unknown.
    rates: dict = field(default_factory=lambda: {"gemini": (None, None), "jev": (None, None)})


def load_settings(env=None):
    if env is None:
        load_dotenv(ROOT / ".env")
        env = os.environ
    try:
        temperature = float(env.get("JUDGE_TEMPERATURE", "0"))
    except ValueError:
        temperature = 0.0
    return Settings(
        gemini_key=env.get("GEMINI_API_KEY", ""),
        typesafe_key=env.get("TYPESAFE_API_KEY", ""),
        gemini_judge_model=env.get("GEMINI_JUDGE_MODEL") or "gemini-3.8-flash",
        jev_model=env.get("JEV_MODEL") or "jev-latest",
        judge_temperature=min(max(temperature, 0.0), 2.0),
        timeout_s=_int(env, "REQUEST_TIMEOUT_S", 60, 5, 300),
        max_retries=_int(env, "MAX_RETRIES", 2, 0, 5),
        max_workers=_int(env, "MAX_WORKERS", 4, 1, 16),
        rates={
            "gemini": (_rate(env, "GEMINI_JUDGE_INPUT_USD_PER_MILLION"),
                       _rate(env, "GEMINI_JUDGE_OUTPUT_USD_PER_MILLION")),
            "jev": (_rate(env, "JEV_INPUT_USD_PER_MILLION"), _rate(env, "JEV_OUTPUT_USD_PER_MILLION")),
        },
    )
