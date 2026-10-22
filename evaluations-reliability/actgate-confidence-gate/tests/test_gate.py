from app.gate import evaluate_gate


def _answers(confidence=0.9, risk="low", next_step="draft_reply", urgency=0.8):
    return {
        "intent": {"type": "choice", "choice": "refund", "confidence": confidence, "probabilities": {"refund": 0.9}},
        "urgency": {"type": "noul", "noul": urgency},
        "frustration": {"type": "score", "score": 2.0, "confidence": confidence},
        "risk": {"type": "choice", "choice": risk, "confidence": confidence},
        "next_step": {"type": "choice", "choice": next_step, "confidence": confidence},
    }


def test_auto_draft_when_confident():
    g = evaluate_gate(
        _answers(0.91),
        confidence_auto=0.82,
        confidence_jev=0.55,
        urgency_high=0.75,
        risk_block="high",
    )
    assert g.decision == "auto_draft"


def test_jev_path_when_medium_confidence():
    g = evaluate_gate(
        _answers(0.7),
        confidence_auto=0.82,
        confidence_jev=0.55,
        urgency_high=0.75,
        risk_block="high",
    )
    assert g.decision == "jev_second_opinion"


def test_block_on_high_risk():
    g = evaluate_gate(
        _answers(0.95, risk="high"),
        confidence_auto=0.82,
        confidence_jev=0.55,
        urgency_high=0.75,
        risk_block="high",
    )
    assert g.decision == "blocked"


def test_ask_human_low_confidence():
    g = evaluate_gate(
        _answers(0.4),
        confidence_auto=0.82,
        confidence_jev=0.55,
        urgency_high=0.75,
        risk_block="high",
        already_used_jev=True,
    )
    assert g.decision == "ask_human"
