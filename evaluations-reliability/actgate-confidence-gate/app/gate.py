from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal


GateDecision = Literal[
    "auto_draft",
    "jev_second_opinion",
    "ask_human",
    "blocked",
]


@dataclass
class GateResult:
    decision: GateDecision
    reason: str
    confidence: float
    risk: str
    urgency: float
    intent: str
    next_step: str


def _pick_confidence(answers: dict[str, Any]) -> float:
    vals: list[float] = []
    for key in ("intent", "risk", "next_step"):
        a = answers.get(key) or {}
        if isinstance(a.get("confidence"), (int, float)):
            vals.append(float(a["confidence"]))
    urgent = answers.get("urgency") or {}
    if isinstance(urgent.get("noul"), (int, float)):
        n = float(urgent["noul"])
        vals.append(max(n, 1.0 - n))
    return round(sum(vals) / len(vals), 4) if vals else 0.0


def evaluate_gate(
    answers: dict[str, Any],
    *,
    confidence_auto: float,
    confidence_jev: float,
    urgency_high: float,
    risk_block: str,
    already_used_jev: bool = False,
) -> GateResult:
    intent = (answers.get("intent") or {}).get("choice") or "other"
    risk = (answers.get("risk") or {}).get("choice") or "medium"
    next_step = (answers.get("next_step") or {}).get("choice") or "ask_human"
    urgency = float((answers.get("urgency") or {}).get("noul") or 0.0)
    confidence = _pick_confidence(answers)

    if risk == risk_block or next_step == "block":
        return GateResult(
            decision="blocked",
            reason=f"Risk={risk} or next_step=block — do not auto-act.",
            confidence=confidence,
            risk=risk,
            urgency=urgency,
            intent=intent,
            next_step="ask_human",
        )

    if next_step == "ask_human":
        return GateResult(
            decision="ask_human",
            reason="Decision model selected ask_human.",
            confidence=confidence,
            risk=risk,
            urgency=urgency,
            intent=intent,
            next_step=next_step,
        )

    if confidence >= confidence_auto and next_step == "draft_reply":
        return GateResult(
            decision="auto_draft",
            reason=f"Confidence {confidence:.2f} ≥ {confidence_auto} and next_step=draft_reply.",
            confidence=confidence,
            risk=risk,
            urgency=urgency,
            intent=intent,
            next_step=next_step,
        )

    if not already_used_jev and confidence >= confidence_jev:
        return GateResult(
            decision="jev_second_opinion",
            reason=f"Confidence {confidence:.2f} in [{confidence_jev}, {confidence_auto}) — ask Jev.",
            confidence=confidence,
            risk=risk,
            urgency=urgency,
            intent=intent,
            next_step=next_step,
        )

    if already_used_jev and confidence >= confidence_auto * 0.92 and next_step == "draft_reply":
        return GateResult(
            decision="auto_draft",
            reason="Jev second opinion cleared the bar for drafting.",
            confidence=confidence,
            risk=risk,
            urgency=urgency,
            intent=intent,
            next_step=next_step,
        )

    if urgency >= urgency_high and confidence < confidence_auto:
        return GateResult(
            decision="ask_human",
            reason=f"High urgency ({urgency:.2f}) with insufficient confidence.",
            confidence=confidence,
            risk=risk,
            urgency=urgency,
            intent=intent,
            next_step="ask_human",
        )

    return GateResult(
        decision="ask_human",
        reason=f"Confidence {confidence:.2f} below auto threshold; escalate.",
        confidence=confidence,
        risk=risk,
        urgency=urgency,
        intent=intent,
        next_step="ask_human",
    )


DECISION_QUESTIONS: dict[str, Any] = {
    "intent": {
        "type": "choice",
        "instructions": "What is the primary customer intent in this message?",
        "criteria": {
            "refund": "Duplicate charge, money back, billing reverse",
            "shipping": "Delivery, tracking, package delay",
            "bug": "Product defect, outage, technical failure",
            "cancel": "Cancel subscription or order",
            "other": "Does not clearly match the above",
        },
    },
    "urgency": {
        "type": "noul",
        "instructions": "Does the customer convey time pressure or urgency?",
        "criteria": {
            "true": "ASAP, today, immediately, deadline language",
            "false": "No time pressure expressed",
        },
    },
    "frustration": {
        "type": "score",
        "instructions": "How frustrated is the customer?",
        "criteria": ["calm", "concerned", "annoyed", "very angry"],
    },
    "risk": {
        "type": "choice",
        "instructions": "What is the operational risk of auto-handling this without a human?",
        "criteria": {
            "low": "Routine, reversible, clear request",
            "medium": "Needs care but not dangerous",
            "high": "Legal, fraud, harassment, irreversible money movement, or unsafe",
        },
    },
    "next_step": {
        "type": "choice",
        "instructions": "What should the system do next?",
        "criteria": {
            "draft_reply": "Safe to draft a customer reply for review/send",
            "ask_human": "Needs human judgment before drafting",
            "block": "Do not automate; stop the pipeline",
        },
    },
}
