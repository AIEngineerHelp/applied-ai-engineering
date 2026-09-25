from datetime import UTC, datetime

from src.ira.agents.analysis import HypothesisDraft, validate_hypotheses
from src.ira.models.incident import Evidence


def ev(eid: str, ok: bool = True) -> Evidence:
    return Evidence(id=eid, step_id=eid, tool="log_explorer", summary="s",
                    pii_redacted=True, collected_at=datetime.now(UTC), ok=ok)


def draft(ids: list[str], conf: float, fault: str = "kernel") -> HypothesisDraft:
    return HypothesisDraft(root_cause_component="c", fault_type=fault, description="d",
                           evidence_ids=ids, confidence=conf)


def test_drops_uncited_and_invalid_citations() -> None:
    evidence = [ev("i1.s1"), ev("i1.s2", ok=False)]
    out = validate_hypotheses([
        draft(["i1.s1", "made-up"], 0.7),
        draft(["made-up"], 0.9),
        draft(["i1.s2"], 0.8),  # failed evidence is not citable
    ], evidence)
    assert len(out) == 1
    assert out[0].evidence_ids == ["i1.s1"]


def test_sorted_by_confidence_and_clamped() -> None:
    out = validate_hypotheses([draft(["a"], 0.3), draft(["a"], 1.7), draft(["a"], -1)],
                              [ev("a")])
    assert [h.confidence for h in out] == [1.0, 0.3, 0.0]


def test_unknown_fault_type_normalised() -> None:
    out = validate_hypotheses([draft(["a"], 0.5, fault="gremlins")], [ev("a")])
    assert out[0].fault_type == "unknown"
