from pydantic import BaseModel

from src.ira.agents.common import dump
from src.ira.llm.client import LLM
from src.ira.models.incident import (
    Evidence,
    Hypothesis,
    Incident,
    ProposedAction,
    Report,
    TimelineEvent,
    Verification,
)
from src.ira.prompts import load_prompt


class ReportDraft(BaseModel):
    summary: str
    markdown: str
    timeline: list[TimelineEvent]
    follow_ups: list[str]


def executed_actions(actions: list[ProposedAction]) -> list[ProposedAction]:
    return [a for a in actions if a.status == "executed"]


class ReportingAgent:
    def __init__(self, llm_client: LLM):
        self.client = llm_client
        self.system_prompt = load_prompt("reporting")

    async def generate_report(
        self,
        incident: Incident,
        evidences: list[Evidence],
        hypotheses: list[Hypothesis],
        actions: list[ProposedAction],
        verification: Verification | None,
    ) -> Report:
        history = (
            f"Incident:\n{incident.model_dump_json(exclude={'raw_payload'})}\n\n"
            f"Evidence:\n{dump(evidences)}\n\n"
            f"Ranked hypotheses (may be empty):\n{dump(hypotheses)}\n\n"
            f"All proposed actions with status and approval audit:\n{dump(actions)}\n\n"
            f"Verification:\n{verification.model_dump_json() if verification else 'null'}"
        )
        messages = [
            {"role": "system", "content": self.system_prompt},
            {"role": "user", "content": history},
        ]
        draft = await self.client.structured("reporter", messages, ReportDraft)
        # Facts come from state, not from the model.
        return Report(
            incident_id=incident.id,
            summary=draft.summary,
            markdown=draft.markdown,
            timeline=draft.timeline,
            root_cause=hypotheses[0] if hypotheses else None,
            actions_taken=executed_actions(actions),
            follow_ups=draft.follow_ups,
        )


def fallback_report(
    incident: Incident,
    evidences: list[Evidence],
    hypotheses: list[Hypothesis],
    actions: list[ProposedAction],
    verification: Verification | None,
    error: str,
) -> Report:
    """Deterministic report used when the reporting LLM fails. States the failure
    plainly and only restates facts already in state."""
    top = hypotheses[0] if hypotheses else None
    lines = [
        f"# RCA: {incident.title}",
        "",
        f"> Automated report generation failed ({error}). This is a deterministic summary.",
        "",
        "## Root cause",
        (f"**{top.root_cause_component}** ({top.fault_type}, confidence {top.confidence:.2f}): "
         f"{top.description}") if top else "No evidence-backed root cause was identified.",
        "",
        "## Evidence",
        *[f"- `{e.id}` ({e.tool}{'' if e.ok else ', failed'}): {e.summary}" for e in evidences],
        "",
        "## Actions",
        *([f"- `{a.kind}`: {a.status}" + (f" ({a.result})" if a.result else "")
           for a in actions] or ["- None"]),
    ]
    if verification:
        lines += ["", "## Verification", verification.reason]
    return Report(
        incident_id=incident.id,
        summary=f"Automated report generation failed: {error}",
        markdown="\n".join(lines),
        root_cause=top,
        actions_taken=executed_actions(actions),
        follow_ups=["Review this incident manually; the reporting agent failed."],
    )
