import logging
from collections.abc import Mapping
from datetime import timedelta
from typing import Any

from langchain_core.runnables import RunnableConfig
from langgraph.graph.state import CompiledStateGraph
from langgraph.types import Command

from src.ira.config import settings
from src.ira.hitl.approvals import final_decision
from src.ira.models.incident import Incident, IncidentStatus, ProposedAction
from src.ira.observability.metrics import (
    GUARDRAIL_DENIES,
    HITL_WAIT,
    INCIDENTS,
    NODE_DURATION,
    RUNS_IN_PROGRESS,
    TIME_TO_REPORT,
)
from src.ira.orchestrator.run import (
    MAX_ACTIVITY,
    ActivityEntry,
    DecisionRecord,
    NodeRun,
    Run,
    RunSnapshot,
    utcnow,
)
from src.ira.orchestrator.state import initial_state
from src.ira.orchestrator.store import DuplicateDecisionError, RunStore

logger = logging.getLogger(__name__)

WORKER_ACTOR = "system:worker"
TIMEOUT_ACTOR = "system:timeout"
_INVESTIGATING = {"load_context", "plan", "gather", "analyze", "propose_actions", "guardrails"}


class RunTracker:
    """Graph RunObserver: mirrors node progress into the run document, persists it after
    every node, and writes audit events for action state changes."""

    def __init__(self, store: RunStore, incident: Incident, run: Run):
        self.store = store
        self.incident = incident
        self.run = run

    async def persist(self) -> None:
        await self.store.save(self.incident, self.run)

    async def node_started(self, node: str, iteration: int) -> None:
        self.run.current_node = node
        self.run.status = "running"
        self.run.history.append(NodeRun(node=node, status="running", started_at=utcnow(),
                                        iteration=iteration))
        if node in _INVESTIGATING:
            self.incident.status = "investigating"
        elif node == "execute":
            self.incident.status = "remediating"
        await self.persist()

    async def activity(self, node: str, message: str, iteration: int) -> None:
        self.run.activity.append(ActivityEntry(at=utcnow(), node=node, message=message,
                                               iteration=iteration))
        del self.run.activity[:-MAX_ACTIVITY]
        await self.persist()

    async def node_finished(
        self, node: str, update: dict[str, Any] | None, error: str | None, interrupted: bool
    ) -> None:
        entry = next((r for r in reversed(self.run.history)
                      if r.node == node and r.status == "running"), None)
        if entry is not None:
            entry.duration_ms = int((utcnow() - entry.started_at).total_seconds() * 1000)
            entry.status = "interrupted" if interrupted else "failed" if error else "completed"
            entry.error = error
            NODE_DURATION.labels(node=node, result=entry.status).observe(entry.duration_ms / 1000)
        if update:
            before = {a.id: a.status for a in self.run.snapshot.proposed_actions}
            self.run.snapshot.apply(update)
            await self._audit_action_changes(before, update.get("proposed_actions", []))
        await self.persist()

    async def _audit_action_changes(
        self, before: Mapping[str, str], actions: list[ProposedAction]
    ) -> None:
        for a in actions:
            if before.get(a.id) == a.status:
                continue
            if a.status == "pending_approval":
                self.run.pending_since.setdefault(a.id, utcnow())
            if a.status == "blocked":
                for note in a.guardrail_notes:
                    GUARDRAIL_DENIES.labels(rule=_rule(note)).inc()
            await self.store.audit(
                WORKER_ACTOR, f"action.{a.status}", str(self.incident.id),
                {"action_id": a.id, "kind": a.kind, "risk": a.risk, "args": a.args,
                 "notes": a.guardrail_notes, "result": a.result},
            )


def _rule(note: str) -> str:
    lowered = note.lower()
    for key, rule in (("unknown tool", "unknown_tool"), ("not allowed in", "environment"),
                      ("missing required", "missing_args"), ("no executor", "no_executor"),
                      ("dual-intent", "dual_intent")):
        if key in lowered:
            return rule
    return "other"


def snapshot_from_state(values: dict[str, Any]) -> RunSnapshot:
    snap = RunSnapshot()
    snap.apply(values)
    return snap


class IncidentRunner:
    """Drives incidents through the orchestrator graph. Safe to run in several worker
    processes: every run/resume holds the store's per-incident lock, and progress lives
    in the LangGraph checkpointer, so a crashed run resumes where it stopped."""

    def __init__(self, graph: CompiledStateGraph[Any, Any, Any, Any], store: RunStore,
                 approval_timeout_s: int | None = None):
        self.graph = graph
        self.store = store
        self.approval_timeout_s = approval_timeout_s or settings.approval_timeout_s

    @staticmethod
    def _config(tracker: RunTracker) -> RunnableConfig:
        return {"configurable": {"thread_id": str(tracker.incident.id), "observer": tracker}}

    async def _load(self, incident_id: str) -> RunTracker | None:
        incident = await self.store.get_incident(incident_id)
        run = await self.store.get_run(incident_id)
        if incident is None or run is None:
            logger.error("Unknown incident %s", incident_id)
            return None
        return RunTracker(self.store, incident, run)

    async def run(self, incident_id: str) -> bool:
        """Start (or recover) the run for an incident. Idempotent."""
        async with self.store.lock(incident_id):
            tracker = await self._load(incident_id)
            if tracker is None:
                return False
            if tracker.run.status in ("completed", "cached", "awaiting_approval"):
                return True
            config = self._config(tracker)
            checkpoint = await self.graph.aget_state(config)
            if checkpoint.next:
                if checkpoint.interrupts:
                    # Crashed right after pausing: restore the waiting state.
                    tracker.run.snapshot = snapshot_from_state(checkpoint.values)
                    return await self._pause(tracker, checkpoint.interrupts[0].value)
                logger.info("Recovering incident %s at %s", incident_id, checkpoint.next)
                graph_input: Any = None
            else:
                tracker.run = Run(cache=tracker.run.cache)
                graph_input = initial_state(tracker.incident)
            tracker.run.status = "running"
            tracker.run.error = None
            return await self._drive(tracker, graph_input)

    async def resume(self, incident_id: str) -> bool:
        """Continue a run paused for approval, if the awaited action is fully decided."""
        async with self.store.lock(incident_id):
            tracker = await self._load(incident_id)
            if tracker is None:
                return False
            if tracker.run.status != "awaiting_approval" or not tracker.run.awaiting_action_id:
                return True
            answer = await self._answer(tracker, tracker.run.awaiting_action_id)
            if answer is None:
                return True
            tracker.run.status = "running"
            return await self._drive(tracker, Command(resume=answer))

    async def _answer(self, tracker: RunTracker, action_id: str) -> dict[str, Any] | None:
        action = tracker.run.find_action(action_id)
        if action is None:
            return None
        answer = final_decision(action, await self.store.decisions(action_id))
        if answer is not None:
            since = tracker.run.pending_since.get(action_id)
            if since is not None:
                HITL_WAIT.observe((utcnow() - since).total_seconds())
        return answer

    async def _drive(self, tracker: RunTracker, graph_input: Any) -> bool:
        """Invoke/resume until the graph finishes or waits on an undecided action."""
        config = self._config(tracker)
        RUNS_IN_PROGRESS.inc()
        try:
            while True:
                try:
                    result = await self.graph.ainvoke(graph_input, config)
                except Exception as e:
                    logger.exception("Run failed for incident %s", tracker.incident.id)
                    return await self._fail(tracker, f"{type(e).__name__}: {e}")

                checkpoint = await self.graph.aget_state(config)
                tracker.run.snapshot = snapshot_from_state(checkpoint.values)
                interrupts = result.get("__interrupt__") if isinstance(result, dict) else None
                if not interrupts:
                    await self._finish(tracker)
                    return True
                action_id = interrupts[0].value["action_id"]
                answer = await self._answer(tracker, action_id)
                if answer is None:
                    return await self._pause(tracker, interrupts[0].value)
                graph_input = Command(resume=answer)
        finally:
            RUNS_IN_PROGRESS.dec()

    async def _pause(self, tracker: RunTracker, interrupt_value: dict[str, Any]) -> bool:
        action_id = interrupt_value["action_id"]
        tracker.run.status = "awaiting_approval"
        tracker.run.awaiting_action_id = action_id
        tracker.run.current_node = "approval"
        tracker.run.pending_since.setdefault(action_id, utcnow())
        tracker.incident.status = "awaiting_approval"
        message = f"Waiting for a human to approve {interrupt_value.get('kind', 'an action')}"
        if not tracker.run.activity or tracker.run.activity[-1].message != message:
            await tracker.activity("approval", message, tracker.run.snapshot.iterations)
        await tracker.persist()
        return True

    async def _fail(self, tracker: RunTracker, error: str) -> bool:
        tracker.run.status = "failed"
        tracker.run.error = error
        tracker.run.current_node = None
        tracker.incident.status = "failed"
        await tracker.persist()
        await self.store.audit(WORKER_ACTOR, "run.failed", str(tracker.incident.id),
                               {"error": error})
        INCIDENTS.labels(status="failed").inc()
        return False

    async def _finish(self, tracker: RunTracker) -> None:
        run = tracker.run
        run.status = "completed"
        run.current_node = None
        run.awaiting_action_id = None
        actions = run.snapshot.proposed_actions
        status: IncidentStatus = "reported"
        if run.snapshot.verification is not None and run.snapshot.verification.verified:
            status = "resolved"
        elif any(a.status == "rejected" for a in actions) and not any(
            a.status == "executed" for a in actions
        ):
            status = "rejected"
        tracker.incident.status = status
        await tracker.persist()
        await self.store.audit(WORKER_ACTOR, "run.completed", str(tracker.incident.id),
                               {"status": status, "iterations": run.snapshot.iterations,
                                "budget_used_usd": run.snapshot.budget_used_usd})
        INCIDENTS.labels(status=status).inc()
        TIME_TO_REPORT.observe((utcnow() - tracker.incident.received_at).total_seconds())

    async def expire_stale_approvals(self) -> list[str]:
        """Record an 'expired' decision for approvals older than the timeout. Returns
        incident ids that now need resuming."""
        deadline = utcnow() - timedelta(seconds=self.approval_timeout_s)
        to_resume: list[str] = []
        for incident, run in await self.store.awaiting_approval():
            action_id = run.awaiting_action_id
            since = run.pending_since.get(action_id) if action_id else None
            if action_id is None or since is None or since > deadline:
                continue
            try:
                await self.store.add_decision(DecisionRecord(
                    incident_id=str(incident.id), action_id=action_id, decision="expired",
                    actor=TIMEOUT_ACTOR, at=utcnow(),
                    comment=f"No decision within {self.approval_timeout_s}s",
                ))
            except DuplicateDecisionError:
                pass  # another worker's sweep got there first
            else:
                await self.store.audit(TIMEOUT_ACTOR, "approval.expired", str(incident.id),
                                       {"action_id": action_id})
            to_resume.append(str(incident.id))
        return to_resume
