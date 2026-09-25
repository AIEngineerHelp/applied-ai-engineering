import json
from typing import Any

from pydantic import BaseModel, Field

from src.ira.agents.common import dump
from src.ira.llm.client import LLM
from src.ira.models.incident import FAULT_TYPES, Evidence, Hypothesis, Incident
from src.ira.prompts import load_prompt


class HypothesisDraft(BaseModel):
    root_cause_component: str
    fault_type: str
    description: str
    evidence_ids: list[str]
    confidence: float = Field(description="0.0 to 1.0")


class AnalysisDraft(BaseModel):
    hypotheses: list[HypothesisDraft]


def validate_hypotheses(
    drafts: list[HypothesisDraft], evidence: list[Evidence]
) -> list[Hypothesis]:
    """Enforce the analysis rules in code rather than trusting the prompt:
    - citations must point at successful evidence; uncited hypotheses are dropped
    - fault_type must be in the taxonomy (otherwise "unknown")
    - confidence is clamped to [0, 1]
    - result is sorted by confidence, highest first
    """
    valid_ids = {e.id for e in evidence if e.ok}
    out: list[Hypothesis] = []
    for d in drafts:
        cited = [eid for eid in d.evidence_ids if eid in valid_ids]
        if not cited:
            continue
        out.append(Hypothesis(
            root_cause_component=d.root_cause_component,
            fault_type=d.fault_type if d.fault_type in FAULT_TYPES else "unknown",
            description=d.description,
            evidence_ids=cited,
            confidence=min(max(d.confidence, 0.0), 1.0),
        ))
    out.sort(key=lambda h: h.confidence, reverse=True)
    return out


class AnalysisAgent:
    def __init__(self, llm_client: LLM):
        self.client = llm_client
        self.system_prompt = load_prompt("analysis").replace(
            "{{FAULT_TYPES}}", ", ".join(FAULT_TYPES)
        )

    async def analyze_evidence(
        self, evidences: list[Evidence], context: dict[str, Any] | None = None,
        incident: Incident | None = None, scope: dict[str, Any] | None = None,
    ) -> list[Hypothesis]:
        ok = [e for e in evidences if e.ok]
        failed = [e for e in evidences if not e.ok]
        if not ok:
            return []
        content = ""
        if incident is not None:
            content += ("Alert being investigated:\n"
                        f"{incident.model_dump_json(include={'title', 'description', 'service', 'labels', 'severity'})}"
                        f"\n\nAlerted entities:\n{json.dumps((scope or {}).get('alerted_entities', {}))}\n\n")
        content += f"Evidence (cite by id):\n{dump(ok)}"
        if failed:
            content += "\n\nSteps that failed (not citable):\n" + dump(
                [{"id": e.id, "tool": e.tool, "error": e.summary} for e in failed]
            )
        if context:
            content += f"\n\nContext:\n{json.dumps(context, default=str)}"
        messages = [
            {"role": "system", "content": self.system_prompt},
            {"role": "user", "content": content},
        ]
        draft = await self.client.structured("analyst", messages, AnalysisDraft)
        return validate_hypotheses(draft.hypotheses, evidences)
