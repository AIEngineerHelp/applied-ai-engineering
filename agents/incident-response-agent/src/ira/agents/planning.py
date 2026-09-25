import json
import uuid
from typing import Any

from pydantic import BaseModel, Field

from src.ira.agents.common import dump, parse_args_json
from src.ira.llm.client import LLM, LLMError
from src.ira.models.incident import (
    Evidence,
    Hypothesis,
    Incident,
    PlanStep,
    ProposedAction,
)
from src.ira.prompts import load_prompt
from src.ira.registry.tools import ToolManifest


class StepDraft(BaseModel):
    id: str = Field(description="Local id such as s1, s2")
    goal: str
    tool: str
    args_json: str = Field(description="Tool arguments as a JSON object string")
    depends_on: list[str] = Field(default_factory=list)


class PlanDraft(BaseModel):
    steps: list[StepDraft]


class ActionDraft(BaseModel):
    kind: str = Field(description="Tool name from the registry")
    args_json: str = Field(description="Tool arguments as a JSON object string")
    rationale: str


class ActionPlanDraft(BaseModel):
    actions: list[ActionDraft]


class PlanningAgent:
    def __init__(self, llm_client: LLM):
        self.client = llm_client
        self.system_prompt = load_prompt("planning")
        self.remediation_prompt = load_prompt("remediation")

    async def generate_plan(
        self,
        incident: Incident,
        context: dict[str, Any],
        tools: list[ToolManifest],
        iteration: int,
        prior_steps: list[PlanStep],
        prior_evidence: list[Evidence],
        prior_hypotheses: list[Hypothesis],
        rejected_actions: list[ProposedAction],
        scope: dict[str, Any] | None = None,
    ) -> list[PlanStep]:
        sections = [
            f"Incident:\n{incident.model_dump_json(exclude={'raw_payload'})}",
            f"Investigation scope (start here):\n{json.dumps(scope or {}, default=str)}",
            f"Context:\n{json.dumps(context, default=str)}",
            f"Available tools (read-only):\n{json.dumps([t.brief() for t in tools])}",
            f"Iteration: {iteration}",
        ]
        if prior_steps:
            sections.append(
                "Previous iterations did not reach a confident root cause. Do NOT repeat "
                "these steps; plan new ones that close the gaps.\n"
                f"Previous steps:\n{dump(prior_steps)}\n"
                f"Evidence so far:\n{dump(prior_evidence)}\n"
                f"Hypotheses so far:\n{dump(prior_hypotheses)}"
            )
        if rejected_actions:
            sections.append(
                "A human rejected these remediation actions; investigate further:\n"
                f"{dump(rejected_actions)}"
            )
        messages = [
            {"role": "system", "content": self.system_prompt},
            {"role": "user", "content": "\n\n".join(sections)},
        ]
        draft = await self.client.structured("planner", messages, PlanDraft)
        if not draft.steps:
            raise LLMError("Planner returned an empty plan")

        prefix = f"i{iteration}."
        local_ids = {s.id for s in draft.steps}
        steps: list[PlanStep] = []
        for s in draft.steps:
            try:
                args = parse_args_json(s.args_json)
            except (ValueError, TypeError) as e:
                raise LLMError(f"Planner step {s.id} has invalid args_json: {e}") from e
            steps.append(PlanStep(
                id=prefix + s.id,
                goal=s.goal,
                tool=s.tool,
                args=args,
                depends_on=[prefix + d for d in s.depends_on if d in local_ids],
                iteration=iteration,
            ))
        return steps

    async def propose_remediation(
        self,
        incident: Incident,
        hypotheses: list[Hypothesis],
        evidence: list[Evidence],
        tools: list[ToolManifest],
        iteration: int,
        rejected_actions: list[ProposedAction],
    ) -> list[ProposedAction]:
        """Propose remediation. Risk and approval policy come from the tool registry
        later (guardrails), never from the model."""
        sections = [
            f"Incident:\n{incident.model_dump_json(exclude={'raw_payload'})}",
            f"Ranked hypotheses:\n{dump(hypotheses)}",
            f"Evidence:\n{dump([e for e in evidence if e.ok])}",
            f"Available tools:\n{json.dumps([t.brief() for t in tools])}",
        ]
        if rejected_actions:
            sections.append(f"Previously rejected by a human (do not re-propose):\n"
                            f"{dump(rejected_actions)}")
        messages = [
            {"role": "system", "content": self.remediation_prompt},
            {"role": "user", "content": "\n\n".join(sections)},
        ]
        draft = await self.client.structured("planner", messages, ActionPlanDraft)
        actions: list[ProposedAction] = []
        for a in draft.actions:
            try:
                args = parse_args_json(a.args_json)
            except (ValueError, TypeError) as e:
                raise LLMError(f"Proposed action {a.kind} has invalid args_json: {e}") from e
            actions.append(ProposedAction(
                id=f"act_{uuid.uuid4().hex[:12]}",
                kind=a.kind,
                args=args,
                # Placeholder until guardrails look up the manifest; fail-closed default.
                risk="destructive",
                rationale=a.rationale,
                requires_approval=True,
                iteration=iteration,
            ))
        return actions
