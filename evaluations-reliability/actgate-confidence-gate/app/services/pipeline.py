from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from app.clients import gemini_client, jev_client, laya_client
from app.config import get_settings
from app.gate import DECISION_QUESTIONS, evaluate_gate
from app.models import CaseRun
from app.timing import Timer


def _state(subject: str | None, body: str) -> dict[str, str]:
    return {
        "subject": subject or "",
        "body": body,
        "document": f"Subject: {subject or ''}\n\n{body}",
    }


def run_pipeline(
    db: Session,
    *,
    subject: str | None,
    body: str,
    source: str = "inbox",
    force_jev: bool = False,
    skip_draft: bool = False,
) -> dict[str, Any]:
    settings = get_settings()
    timer = Timer(goal="decide_and_draft")
    used_laya = False
    used_jev = False
    used_gemini = False
    answers: dict[str, Any] = {}
    draft: str | None = None
    error: str | None = None
    gate_decision = "error"
    message = ""

    state = _state(subject, body)

    try:
        # 1) Prefer Laya local first pass
        if settings.laya_enabled and not force_jev:
            with timer.span("laya_decide") as span:
                try:
                    answers = laya_client.decide_with_laya(state, DECISION_QUESTIONS)
                    used_laya = True
                    span.detail = "local System One"
                except Exception as exc:  # noqa: BLE001
                    span.ok = False
                    span.detail = f"Laya failed, will use Jev: {exc}"
                    answers = {}

        # 2) Gate after Laya (or skip straight to Jev)
        if answers:
            with timer.span("gate_after_laya") as span:
                gate = evaluate_gate(
                    answers,
                    confidence_auto=settings.confidence_auto,
                    confidence_jev=settings.confidence_jev,
                    urgency_high=settings.urgency_high,
                    risk_block=settings.risk_block,
                    already_used_jev=False,
                )
                span.detail = gate.decision
                gate_decision = gate.decision
        else:
            gate = None
            gate_decision = "jev_second_opinion"

        # 3) Jev when forced, Laya missing, or gate asks for second opinion
        need_jev = (
            force_jev
            or not answers
            or (gate is not None and gate.decision == "jev_second_opinion")
        )
        if need_jev:
            with timer.span("jev_decide") as span:
                answers = jev_client.decide_with_jev(state, DECISION_QUESTIONS)
                used_jev = True
                span.detail = "TypeSafe Jev"
            with timer.span("gate_after_jev") as span:
                gate = evaluate_gate(
                    answers,
                    confidence_auto=settings.confidence_auto,
                    confidence_jev=settings.confidence_jev,
                    urgency_high=settings.urgency_high,
                    risk_block=settings.risk_block,
                    already_used_jev=True,
                )
                span.detail = gate.decision
                gate_decision = gate.decision

        assert gate is not None

        # 4) Gemini draft only when allowed
        if gate.decision == "auto_draft" and not skip_draft:
            with timer.span("gemini_draft") as span:
                try:
                    draft = gemini_client.draft_reply(
                        subject=subject,
                        body=body,
                        intent=gate.intent,
                        urgency=gate.urgency,
                        risk=gate.risk,
                        answers=answers,
                    )
                    used_gemini = True
                    span.detail = f"model={settings.gemini_model}"
                    timer.mark_goal(True, "Decision cleared gate and Gemini draft produced.")
                    message = "Goal reached: decide + draft."
                except Exception as draft_exc:  # noqa: BLE001
                    span.ok = False
                    span.detail = str(draft_exc)
                    timer.mark_goal(
                        False,
                        f"Decision OK but Gemini draft failed: {draft_exc}",
                    )
                    message = f"Decision cleared gate; draft failed: {draft_exc}"
        elif gate.decision == "auto_draft" and skip_draft:
            timer.mark_goal(True, "Decision cleared gate; draft skipped by request.")
            message = "Goal reached (decision only)."
        elif gate.decision == "ask_human":
            timer.mark_goal(False, gate.reason)
            message = "Escalated to human — goal not fully reached."
        elif gate.decision == "blocked":
            timer.mark_goal(False, gate.reason)
            message = "Blocked by risk policy — goal not reached."
        else:
            timer.mark_goal(False, gate.reason)
            message = gate.reason

        timing = timer.report.to_dict()
        row = CaseRun(
            source=source,
            subject=subject,
            body=body,
            intent=gate.intent,
            urgency=gate.urgency,
            risk=gate.risk,
            next_step=gate.next_step,
            confidence=gate.confidence,
            gate_decision=gate.decision,
            used_laya=used_laya,
            used_jev=used_jev,
            used_gemini=used_gemini,
            goal_reached=timing["goal_reached"],
            draft=draft,
            timing_json=timing,
            answers_json=answers,
            error=None,
        )
        db.add(row)
        db.commit()
        db.refresh(row)

        frustration = None
        fr = answers.get("frustration") or {}
        if isinstance(fr.get("score"), (int, float)):
            frustration = float(fr["score"])

        return {
            "case_id": row.id,
            "intent": gate.intent,
            "urgency": gate.urgency,
            "frustration": frustration,
            "risk": gate.risk,
            "next_step": gate.next_step,
            "confidence": gate.confidence,
            "gate_decision": gate.decision,
            "used_laya": used_laya,
            "used_jev": used_jev,
            "used_gemini": used_gemini,
            "draft": draft,
            "answers": answers,
            "timing": timing,
            "message": message,
        }
    except Exception as exc:  # noqa: BLE001
        error = str(exc)
        timer.mark_goal(False, error)
        timing = timer.report.to_dict()
        row = CaseRun(
            source=source,
            subject=subject,
            body=body,
            gate_decision="error",
            used_laya=used_laya,
            used_jev=used_jev,
            used_gemini=used_gemini,
            goal_reached=False,
            timing_json=timing,
            answers_json=answers or None,
            error=error,
        )
        db.add(row)
        db.commit()
        db.refresh(row)
        return {
            "case_id": row.id,
            "intent": None,
            "urgency": None,
            "frustration": None,
            "risk": None,
            "next_step": None,
            "confidence": None,
            "gate_decision": "error",
            "used_laya": used_laya,
            "used_jev": used_jev,
            "used_gemini": used_gemini,
            "draft": None,
            "answers": answers,
            "timing": timing,
            "message": f"Pipeline error: {error}",
        }
