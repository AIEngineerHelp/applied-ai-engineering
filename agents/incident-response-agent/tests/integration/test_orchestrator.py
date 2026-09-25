from dataclasses import dataclass
from typing import Any

from src.ira.api.auth import Principal
from src.ira.hitl.service import ApprovalService, DecisionForbiddenError
from src.ira.llm.client import LLMError
from src.ira.orchestrator.checkpoint import build_checkpointer
from src.ira.orchestrator.dispatch import LocalDispatcher
from src.ira.orchestrator.graph import build_graph
from src.ira.orchestrator.run import Run
from src.ira.orchestrator.runner import IncidentRunner
from src.ira.orchestrator.store import MemoryRunStore
from tests.fakes import (
    BASIC_PLAN,
    DIST,
    FakeLLM,
    actions,
    base_responses,
    hypotheses,
    make_deps,
    make_incident,
    make_settings,
    plan,
)

ALICE = Principal(sub="alice", email="alice@corp", roles=frozenset({"approver"}))
BOB = Principal(sub="bob", email="bob@corp", roles=frozenset({"approver"}))


@dataclass
class Harness:
    store: MemoryRunStore
    runner: IncidentRunner
    dispatcher: LocalDispatcher
    approvals: ApprovalService
    incident_id: str

    async def run(self) -> Run:
        await self.runner.run(self.incident_id)
        return await self.current()

    async def current(self) -> Run:
        run = await self.store.get_run(self.incident_id)
        assert run is not None
        return run

    async def status(self) -> str:
        inc = await self.store.get_incident(self.incident_id)
        assert inc is not None
        return inc.status

    async def decide(self, action_id: str, decision: str, who: Principal = ALICE) -> str:
        outcome, _ = await self.approvals.decide(action_id, decision, who, "because")  # type: ignore[arg-type]
        await self.dispatcher.idle()
        return outcome


async def harness(llm: FakeLLM, executed: list[dict[str, Any]] | None = None,
                  timeout_s: int = 3600, two_person: bool = False, **incident: Any) -> Harness:
    store = MemoryRunStore()
    deps = make_deps(llm, executed)
    if two_person:
        m = deps.registry.tools["k8s.rollout_undo"]
        deps.registry.tools["k8s.rollout_undo"] = m.model_copy(update={"approval": "two_person"})
    checkpointer, _ = await build_checkpointer(make_settings())
    runner = IncidentRunner(build_graph(deps, checkpointer=checkpointer), store,
                            approval_timeout_s=timeout_s)
    dispatcher = LocalDispatcher(runner)
    inc = make_incident(**incident)
    await store.create(inc, Run())
    return Harness(store, runner, dispatcher, ApprovalService(store, dispatcher), str(inc.id))


async def test_hitl_approve_then_execute() -> None:
    executed: list[dict[str, Any]] = []
    llm = FakeLLM(base_responses())
    h = await harness(llm, executed)

    run = await h.run()
    assert run.status == "awaiting_approval"
    assert await h.status() == "awaiting_approval"
    assert executed == [], "nothing may execute before a human decides"

    [pending] = await h.approvals.pending()
    assert pending["kind"] == "k8s.rollout_undo"
    assert pending["risk"] == "write"  # from the registry, not the model
    assert pending["required_approvals"] == 1

    assert await h.decide(pending["action_id"], "approved") == "accepted"
    run = await h.current()
    assert run.status == "completed", run.error
    assert executed == [{"namespace": "prod", "deployment": "bgl"}]
    [action] = run.snapshot.proposed_actions
    assert action.status == "executed"
    assert action.approval is not None and action.approval.by == "alice@corp"
    assert [a.by for a in action.approvals] == ["alice@corp"]
    assert await h.status() == "reported"
    report = run.snapshot.report
    assert report is not None and report.root_cause is not None
    assert [a.kind for a in report.actions_taken] == ["k8s.rollout_undo"]
    [evidence] = run.snapshot.evidence
    assert evidence.id == "i1.s1" and evidence.ok
    assert '"EventId"' in llm.prompts_for("EvidenceDraft")[0]
    assert "Label" not in llm.prompts_for("EvidenceDraft")[0]

    audit = [e.action for e in await h.store.list_audit(h.incident_id)]
    assert {"action.pending_approval", "approval.approved", "action.executed",
            "run.completed"} <= set(audit)


async def test_two_person_rule() -> None:
    executed: list[dict[str, Any]] = []
    h = await harness(FakeLLM(base_responses()), executed, two_person=True)
    await h.run()
    [pending] = await h.approvals.pending()
    assert pending["required_approvals"] == 2

    assert await h.decide(pending["action_id"], "approved", ALICE) == "recorded"
    assert (await h.current()).status == "awaiting_approval"
    assert executed == []
    try:
        await h.decide(pending["action_id"], "approved", ALICE)
        raise AssertionError("same approver twice must be refused")
    except DecisionForbiddenError:
        pass
    [still] = await h.approvals.pending()
    assert [a["by"] for a in still["approvals"]] == ["alice@corp"]

    assert await h.decide(pending["action_id"], "approved", BOB) == "accepted"
    assert executed and (await h.current()).status == "completed"


async def test_reject_triggers_replan_with_feedback() -> None:
    llm = FakeLLM(base_responses(
        PlanDraft=[BASIC_PLAN, plan(("s1", "Kernel only", '{"filters": {"Component": "KERNEL"}}'))],
        AnalysisDraft=[hypotheses(0.85), hypotheses(0.9, ["i2.s1"])],
        ActionPlanDraft=[actions("k8s.rollout_undo"), actions()],
    ))
    h = await harness(llm)
    await h.run()
    [pending] = await h.approvals.pending()
    await h.decide(pending["action_id"], "rejected")

    run = await h.current()
    assert run.status == "completed", run.error
    assert run.snapshot.iterations == 2
    assert "because" in llm.prompts_for("PlanDraft")[1]
    assert await h.status() == "rejected"
    assert [s.id for s in run.snapshot.plan] == ["i1.s1", "i2.s1"]


async def test_approval_expiry() -> None:
    executed: list[dict[str, Any]] = []
    h = await harness(FakeLLM(base_responses(ActionPlanDraft=[actions("k8s.rollout_undo"),
                                                              actions()])),
                      executed, timeout_s=1)
    await h.run()
    [pending] = await h.approvals.pending()
    run = await h.current()
    run.pending_since[pending["action_id"]] = run.pending_since[pending["action_id"]].replace(
        year=2000)
    inc = await h.store.get_incident(h.incident_id)
    assert inc is not None
    await h.store.save(inc, run)

    assert await h.runner.expire_stale_approvals() == [h.incident_id]
    await h.runner.resume(h.incident_id)
    run = await h.current()
    assert executed == []
    first = run.snapshot.proposed_actions[0]
    assert first.status == "rejected" and first.approval is not None
    assert first.approval.decision == "expired"


async def test_low_confidence_replans_until_limit() -> None:
    llm = FakeLLM(base_responses(
        PlanDraft=[plan(("s1", "dist", DIST))],
        AnalysisDraft=[hypotheses(0.2)],
        ActionPlanDraft=[actions()],
    ))
    h = await harness(llm)
    run = await h.run()
    assert run.status == "completed"
    assert run.snapshot.iterations == 3
    assert "Evidence so far" in llm.prompts_for("PlanDraft")[1]
    assert "i1.s1" in llm.prompts_for("PlanDraft")[1]


async def test_failure_then_retry_resumes_from_checkpoint() -> None:
    llm = FakeLLM(base_responses(AnalysisDraft=[LLMError("provider down"), hypotheses(0.85)],
                                 ActionPlanDraft=[actions()]))
    h = await harness(llm)
    run = await h.run()
    assert run.status == "failed"
    assert await h.status() == "failed"
    assert "provider down" in (run.error or "")
    assert run.snapshot.report is None
    assert run.history[-1].node == "analyze" and run.history[-1].status == "failed"

    run = await h.run()  # e.g. the queue retrying the message
    assert run.status == "completed", run.error
    assert len(llm.prompts_for("PlanDraft")) == 1, "retry must not redo completed nodes"
    assert len(llm.prompts_for("EvidenceDraft")) == 1


async def test_run_is_idempotent_once_completed() -> None:
    llm = FakeLLM(base_responses(ActionPlanDraft=[actions()]))
    h = await harness(llm)
    await h.run()
    await h.run()
    assert len(llm.prompts_for("PlanDraft")) == 1


async def test_reporting_failure_uses_labelled_fallback() -> None:
    h = await harness(FakeLLM(base_responses(ActionPlanDraft=[actions()],
                                             ReportDraft=[LLMError("boom")])))
    report = (await h.run()).snapshot.report
    assert report is not None
    assert report.summary.startswith("Automated report generation failed")


async def test_guardrails_block_unknown_unsafe_and_unimplemented() -> None:
    llm = FakeLLM(base_responses(ActionPlanDraft=[actions("rm.everything", "k8s.rollout_undo")]),
                  verdict="UNSAFE")
    h = await harness(llm)
    run = await h.run()
    assert run.status == "completed"
    assert {a.kind: a.status for a in run.snapshot.proposed_actions} == {
        "rm.everything": "blocked", "k8s.rollout_undo": "blocked"}
    assert await h.approvals.pending() == []
    assert "action.blocked" in [e.action for e in await h.store.list_audit(h.incident_id)]


async def test_environment_not_allowed_is_blocked() -> None:
    h = await harness(FakeLLM(base_responses()), environment="dev")
    [action] = (await h.run()).snapshot.proposed_actions
    assert action.status == "blocked"
    assert any("not allowed in dev" in n for n in action.guardrail_notes)


async def test_no_hypothesis_means_no_actions() -> None:
    h = await harness(FakeLLM(base_responses(AnalysisDraft=[hypotheses(0.9, ["hallucinated"])])))
    run = await h.run()
    assert run.snapshot.hypotheses == []
    assert run.snapshot.proposed_actions == []
    assert run.snapshot.report is not None and run.snapshot.report.root_cause is None


async def test_tool_failure_is_recorded_not_faked() -> None:
    h = await harness(FakeLLM(base_responses(ActionPlanDraft=[actions()])), labels={})
    run = await h.run()
    evidence = run.snapshot.evidence
    assert len(evidence) == 3 and run.snapshot.iterations == 3
    assert all(not e.ok and "No dataset" in e.summary for e in evidence)


async def test_activity_feed_narrates_real_progress() -> None:
    h = await harness(FakeLLM(base_responses()))
    run = await h.run()
    feed = [(a.node, a.message) for a in run.activity]
    messages = " | ".join(m for _, m in feed)
    assert feed[0][0] == "load_context"
    assert "Planned 1 step" in messages
    assert "i1.s1 · Event distribution" in messages
    assert "most frequent" in messages and "×" in messages  # real tool output
    assert "Top hypothesis: hardware in R02-M1-N0-C (85% confidence" in messages
    assert "k8s.rollout_undo passed guardrails; needs 1 human approval" in messages
    assert feed[-1] == ("approval", "Waiting for a human to approve k8s.rollout_undo")


async def test_planner_and_analyst_see_the_alerted_entity() -> None:
    llm = FakeLLM(base_responses(ActionPlanDraft=[actions()]))
    h = await harness(llm, labels={"dataset": "BGL", "node": "R02-M1-N0-C"})
    await h.run()
    plan_prompt = llm.prompts_for("PlanDraft")[0]
    assert '"suggested_filters": {"Node": "R02-M1-N0-C"}' in plan_prompt
    analysis_prompt = llm.prompts_for("AnalysisDraft")[0]
    assert "Alert being investigated" in analysis_prompt
    assert '"node": "R02-M1-N0-C"' in analysis_prompt


async def test_graph_context_reaches_planner_and_analyst(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    import src.ira.orchestrator.graph as graph_module

    async def fake_context(store, dataset, names, include_history=True):  # type: ignore[no-untyped-def]
        assert names == ["R02-M1-N0-C"] and not include_history
        return {"alerted_entities": [{"name": "R02-M1-N0-C", "kind": "Host", "error_lines": 3,
                                      "location": ["Rack R02", "Midplane R02-M1"]}]}

    monkeypatch.setattr(graph_module, "investigation_context", fake_context)
    llm = FakeLLM(base_responses(ActionPlanDraft=[actions()]))
    store = MemoryRunStore()
    deps = make_deps(llm)
    deps.graph, deps.graph_history = object(), False  # type: ignore[assignment]
    checkpointer, _ = await build_checkpointer(make_settings())
    runner = IncidentRunner(build_graph(deps, checkpointer=checkpointer), store)
    inc = make_incident(labels={"dataset": "BGL", "node": "R02-M1-N0-C"}, service=None)
    await store.create(inc, Run())
    await runner.run(str(inc.id))
    assert '"knowledge_graph"' in llm.prompts_for("PlanDraft")[0]
    assert "Rack R02" in llm.prompts_for("AnalysisDraft")[0]
    run = await store.get_run(str(inc.id))
    assert run is not None
    assert any("Graph: R02-M1-N0-C (Rack R02 > Midplane R02-M1)" in a.message for a in run.activity)
