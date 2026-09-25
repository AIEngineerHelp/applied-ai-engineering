import re
import tempfile
import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from pydantic import BaseModel

from src.ira.agents.analysis import AnalysisDraft, HypothesisDraft
from src.ira.agents.gathering import EvidenceDraft
from src.ira.agents.planning import ActionDraft, ActionPlanDraft, PlanDraft, StepDraft
from src.ira.agents.reporting import ReportDraft
from src.ira.config import Settings
from src.ira.guardrails.dual_intent import DualIntentGuardrail
from src.ira.llm.client import LLMError
from src.ira.models.incident import Incident
from src.ira.orchestrator.graph import OrchestratorDeps
from src.ira.registry.tools import ToolRegistry
from src.ira.tools.executor import ToolExecutor

Handler = BaseModel | Exception | Callable[[list[dict[str, str]]], BaseModel]


class FakeScrubber:
    """Regex stand-in for Presidio so tests don't load spaCy."""

    def scrub(self, text: str) -> str:
        return re.sub(r"[\w.+-]+@[\w-]+\.[\w.]+", "<EMAIL_ADDRESS>", text or "")

    def scrub_obj(self, obj: Any) -> Any:
        if isinstance(obj, str):
            return self.scrub(obj)
        if isinstance(obj, dict):
            return {k: self.scrub_obj(v) for k, v in obj.items()}
        if isinstance(obj, list):
            return [self.scrub_obj(v) for v in obj]
        return obj


class FakeLLM:
    """Scripted LLM. `responses[schema_name]` is a list consumed in order (the last entry
    repeats). Each entry is a model, an exception to raise, or a callable(messages)."""

    def __init__(self, responses: dict[str, list[Handler]], verdict: str = "SAFE"):
        self.responses = responses
        self.verdict = verdict
        self.calls: list[tuple[str, list[dict[str, str]]]] = []

    async def structured(self, role: str, messages: list[dict[str, str]], schema: type) -> Any:
        self.calls.append((schema.__name__, messages))
        queue = self.responses.get(schema.__name__)
        if not queue:
            raise LLMError(f"No scripted response for {schema.__name__}")
        item = queue.pop(0) if len(queue) > 1 else queue[0]
        if isinstance(item, Exception):
            raise item
        if callable(item) and not isinstance(item, BaseModel):
            return item(messages)
        return item

    async def text(self, role: str, messages: list[dict[str, str]], *, model: str | None = None,
                   allow_fallback: bool = True) -> str:
        self.calls.append(("text", messages))
        return self.verdict

    def prompts_for(self, schema_name: str) -> list[str]:
        return [m[-1]["content"] for name, m in self.calls if name == schema_name]


def plan(*steps: tuple[str, str, str]) -> PlanDraft:
    return PlanDraft(steps=[StepDraft(id=i, goal=g, tool="log_explorer", args_json=a)
                            for i, g, a in steps])


DIST = '{"operation": "distribution", "limit": 5}'
BASIC_PLAN = plan(("s1", "Event distribution", DIST))


def hypotheses(conf: float, ids: list[str] | None = None) -> AnalysisDraft:
    return AnalysisDraft(hypotheses=[HypothesisDraft(
        root_cause_component="R02-M1-N0-C", fault_type="hardware",
        description="Parity errors on node", evidence_ids=ids or ["i1.s1"], confidence=conf,
    )])


def actions(*kinds: str, args: str = '{"namespace": "prod", "deployment": "bgl"}') -> ActionPlanDraft:
    return ActionPlanDraft(actions=[ActionDraft(kind=k, args_json=args, rationale="evidence i1.s1")
                                    for k in kinds])


REPORT = ReportDraft(summary="Summary.", markdown="# RCA", timeline=[], follow_ups=["x"])


def base_responses(**overrides: list[Handler]) -> dict[str, list[Handler]]:
    responses: dict[str, list[Handler]] = {
        "PlanDraft": [BASIC_PLAN],
        "EvidenceDraft": [EvidenceDraft(summary="E77 parity errors x45 on R02-M1-N0-C")],
        "AnalysisDraft": [hypotheses(0.85)],
        "ActionPlanDraft": [actions("k8s.rollout_undo")],
        "ReportDraft": [REPORT],
    }
    responses.update(overrides)
    return responses


ARTIFACTS = Path(tempfile.mkdtemp(prefix="ira-test-artifacts-"))


def make_deps(llm: FakeLLM, executed: list[dict[str, Any]] | None = None) -> OrchestratorDeps:
    registry = ToolRegistry().load_registry()
    tools = ToolExecutor(registry)
    sink = executed if executed is not None else []

    async def rollout_undo(args: dict[str, Any], incident: Incident) -> str:
        sink.append(args)
        return "rolled back"

    tools.register("k8s.rollout_undo", rollout_undo)
    return OrchestratorDeps(
        llm=llm, registry=registry, tools=tools, scrubber=FakeScrubber(),  # type: ignore[arg-type]
        guardrail=DualIntentGuardrail(llm, model_a="model-a", model_b="model-b"),
        config=make_settings(),
    )


def make_settings(**overrides: Any) -> Settings:
    return Settings(_env_file=None, artifacts_dir=ARTIFACTS, **overrides)  # type: ignore[call-arg]


def make_incident(**overrides: Any) -> Incident:
    data: dict[str, Any] = {
        "id": uuid.uuid4(), "source": "eval", "title": "Node R02-M1-N0-C reported errors",
        "description": "Automated alert", "environment": "prod", "severity": "sev2",
        "labels": {"dataset": "BGL"}, "started_at": datetime.now(UTC),
        "received_at": datetime.now(UTC), "raw_payload": {}, "signature": "sig",
        "signature_hash": "hash", "status": "new",
    }
    data.update(overrides)
    return Incident(**data)
