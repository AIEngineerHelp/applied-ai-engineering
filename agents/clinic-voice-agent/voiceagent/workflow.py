"""The per-customer workflow: loaded from YAML and validated, so a typo fails at start-up
rather than in the middle of a call."""

from __future__ import annotations

import re
from functools import lru_cache
from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, model_validator

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_WORKFLOW = ROOT / "workflow" / "clinic.yaml"

ToolName = Literal[
    "find_open_slots",
    "book_appointment",
    "reschedule_appointment",
    "cancel_appointment",
    "search_clinic_info",
    "transfer_call",
    "end_call",
]


class Clinic(BaseModel):
    name: str
    timezone: str
    agent_name: str


class Greeting(BaseModel):
    known_caller: str
    unknown_caller: str
    crm_unavailable: str


class PatientLookup(BaseModel):
    timeout_seconds: float
    on_failure: Literal["continue_without_record"]


class PreCall(BaseModel):
    patient_lookup: PatientLookup


class InCall(BaseModel):
    tools: list[ToolName]
    require_patient_for: list[ToolName]
    max_call_seconds: int


class Guard(BaseModel):
    name: str
    phrases: list[str]
    action: Literal["transfer"]
    destination: str
    say: str

    def matches(self, text: str) -> str | None:
        """The phrase that matched, compared on words so "stroke" does not match "strokes"
        in an unrelated sense less often than a plain substring test would."""
        normalized = " " + re.sub(r"[^a-z' ]+", " ", text.lower()).strip() + " "
        normalized = re.sub(r"\s+", " ", normalized)
        for phrase in self.phrases:
            if f" {phrase.lower()} " in normalized:
                return phrase
        return None


class Transfer(BaseModel):
    label: str
    phone: str


class Extract(BaseModel):
    intents: list[str]


class Webhook(BaseModel):
    url_env: str
    secret_env: str
    timeout_seconds: float
    max_attempts: int


class PostCall(BaseModel):
    extract: Extract
    webhook: Webhook


class Workflow(BaseModel):
    clinic: Clinic
    greeting: Greeting
    pre_call: PreCall
    in_call: InCall
    guards: list[Guard]
    transfers: dict[str, Transfer]
    post_call: PostCall

    @model_validator(mode="after")
    def _destinations_exist(self) -> Workflow:
        for guard in self.guards:
            if guard.destination not in self.transfers:
                raise ValueError(f"guard {guard.name!r} transfers to unknown {guard.destination!r}")
        return self

    def check_guards(self, text: str) -> tuple[Guard, str] | None:
        for guard in self.guards:
            phrase = guard.matches(text)
            if phrase:
                return guard, phrase
        return None


def load_workflow(path: Path = DEFAULT_WORKFLOW) -> Workflow:
    return Workflow.model_validate(yaml.safe_load(path.read_text()))


@lru_cache(maxsize=1)
def default_workflow() -> Workflow:
    return load_workflow()
