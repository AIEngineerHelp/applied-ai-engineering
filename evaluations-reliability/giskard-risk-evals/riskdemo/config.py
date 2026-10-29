"""Settings from the environment (and an optional .env in this directory)."""

import os
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RUNS = ROOT / "runs"  # live runs from the app (Git-ignored)
RESULTS = ROOT / "results"
RECORDED = RESULTS / "recorded"  # first recording set (2026-10-14): one shared brief for all ten attacks
SEEDED = RESULTS / "seeded"  # second set: each attack seeded with a question, a persona and a tactic
LOOP = RESULTS / "loop"  # reruns with a revised risk definition
FACEOFF = RESULTS / "faceoff"  # Giskard's Crescendo and GOAT attackers on two policies
STUDY = RESULTS / "study"  # labels, second judge, keyword check, diversity and the summary the app reads
SETS = {"recorded": RECORDED, "seeded": SEEDED}
MAX_ATTACKS = 10


@dataclass(frozen=True)
class Settings:
    api_key: str | None
    agent_model: str
    attacker_model: str
    judge_model: str
    attacks_per_run: int
    max_concurrency: int
    attack_timeout_s: float

    @property
    def live_available(self) -> bool:
        return bool(self.api_key)


def load_settings(env: dict[str, str] | None = None) -> Settings:
    if env is None:
        from dotenv import load_dotenv

        load_dotenv(ROOT / ".env")
        env = dict(os.environ)
    model = env.get("GEMINI_MODEL") or "gemini-3.8-flash"
    return Settings(
        api_key=env.get("GEMINI_API_KEY") or env.get("GOOGLE_API_KEY") or None,
        agent_model=model,
        attacker_model=env.get("ATTACKER_MODEL") or model,
        judge_model=env.get("JUDGE_MODEL") or model,
        attacks_per_run=max(1, min(MAX_ATTACKS, int(env.get("ATTACKS_PER_RUN") or MAX_ATTACKS))),
        max_concurrency=max(1, int(env.get("MAX_CONCURRENCY") or 5)),
        attack_timeout_s=float(env.get("ATTACK_TIMEOUT_S") or 180),
    )
