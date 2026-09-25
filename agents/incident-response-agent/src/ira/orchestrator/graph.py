import asyncio
import contextvars
import json
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal, Protocol

from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.errors import GraphInterrupt
from langgraph.graph import END, StateGraph
from langgraph.graph.state import CompiledStateGraph
from langgraph.types import interrupt

from src.ira.agents.analysis import AnalysisAgent
from src.ira.agents.gathering import GatheringAgent
from src.ira.agents.planning import PlanningAgent
from src.ira.agents.reporting import ReportingAgent, fallback_report
from src.ira.agents.scope import alerted_entities, investigation_scope
from src.ira.config import Settings, settings
from src.ira.guardrails.dual_intent import DualIntentGuardrail
from src.ira.guardrails.pii import PIIScrubber, get_scrubber
from src.ira.hitl.approvals import required_approvals, requires_approval
from src.ira.knowledge.store import GraphStore, investigation_context
from src.ira.llm.client import LLM, LLMClient, track_cost
from src.ira.memory.service import MemoryService
from src.ira.models.incident import (
    Approval,
    Evidence,
    Incident,
    PlanStep,
    ProposedAction,
    Verification,
)
from src.ira.observability.tracing import tracer
from src.ira.orchestrator.state import IncidentState
from src.ira.registry.tools import ToolRegistry
from src.ira.tools.executor import ToolExecutor

logger = logging.getLogger(__name__)

NODES = [
    "load_context", "plan", "gather", "analyze", "propose_actions", "guardrails",
    "approval", "execute", "verify", "report", "memory_update",
]


class RunObserver(Protocol):
    async def node_started(self, node: str, iteration: int) -> None: ...
    async def activity(self, node: str, message: str, iteration: int) -> None: ...
    async def node_finished(
        self, node: str, update: dict[str, Any] | None, error: str | None, interrupted: bool
    ) -> None: ...


@dataclass
class OrchestratorDeps:
    llm: LLM
    registry: ToolRegistry
    tools: ToolExecutor
    scrubber: PIIScrubber
    guardrail: DualIntentGuardrail
    memory: MemoryService | None = None
    # Knowledge graph (Neo4j) read for investigation context; None = not used.
    graph: GraphStore | None = None
    # Include past incidents from the graph (off in evals so answers can't leak).
    graph_history: bool = True
    config: Settings = field(default_factory=lambda: settings)

    @classmethod
    def default(
        cls, memory: MemoryService | None = None, graph: GraphStore | None = None,
        graph_history: bool = True,
    ) -> "OrchestratorDeps":
        llm = LLMClient()
        registry = ToolRegistry().load_registry()
        return cls(
            llm=llm,
            registry=registry,
            tools=ToolExecutor(registry),
            scrubber=get_scrubber(),
            guardrail=DualIntentGuardrail(llm),
            memory=memory,
            graph=graph,
            graph_history=graph_history,
        )


def _now() -> datetime:
    return datetime.now(UTC)


def _current(actions: list[ProposedAction], iteration: int) -> list[ProposedAction]:
    return [a for a in actions if a.iteration == iteration]


NodeFn = Callable[[IncidentState], Awaitable[dict[str, Any]]]

# (observer, node, iteration) for the node currently executing in this task.
_narrator: contextvars.ContextVar[tuple[RunObserver, str, int] | None] = contextvars.ContextVar(
    "ira_narrator", default=None
)


async def narrate(message: str) -> None:
    """Add a line to the run's live activity feed (what the agent is doing right now)."""
    current = _narrator.get()
    if current is None:
        return
    observer, node, iteration = current
    try:
        await observer.activity(node, message[:300], iteration)
    except Exception:
        logger.debug("Could not record activity", exc_info=True)


def _pct(confidence: float) -> str:
    return f"{round(confidence * 100)}%"


def describe_tool_output(tool: str, output: str) -> str:
    """One factual line about what a tool returned, for the activity feed."""
    try:
        data = json.loads(output)
    except ValueError:
        return f"{tool} returned {len(output):,} characters"
    if isinstance(data, list) and data and isinstance(data[0], dict):
        first = data[0]
        if first.get("no_matches"):
            return f"No log lines matched {json.dumps(first.get('filter'))}"
        if "EventTemplate" in first:
            total = sum(int(d.get("count", 0)) for d in data)
            return (f"{len(data)} event types, {total:,} lines; most frequent: "
                    f"\u201c{str(first['EventTemplate'])[:90]}\u201d \u00d7{first.get('count')}")
    if isinstance(data, dict) and "template" in data:
        return f"Event {data.get('event_id')} seen {data.get('count', 0):,} times: " \
               f"\u201c{str(data['template'])[:90]}\u201d"
    if isinstance(data, dict) and "exit_code" in data:
        return f"Command exited with code {data['exit_code']}"
    if isinstance(data, list):
        return f"{tool} returned {len(data)} rows"
    return f"{tool} returned a result"


def _instrument(name: str, fn: NodeFn) -> Callable[..., Awaitable[dict[str, Any]]]:
    """Report node lifecycle to the run observer and charge LLM cost to the state budget."""

    async def wrapped(state: IncidentState, config: RunnableConfig) -> dict[str, Any]:
        observer: RunObserver | None = (config.get("configurable") or {}).get("observer")
        incident_id = str(state["incident"].id)
        if observer:
            await observer.node_started(name, state.get("iterations", 0))
            _narrator.set((observer, name, state.get("iterations", 0)))
        with tracer.start_as_current_span(
            f"node.{name}", attributes={"incident_id": incident_id, "node": name}
        ) as span:
            try:
                with track_cost() as meter:
                    update = await fn(state)
            except GraphInterrupt:
                if observer:
                    await observer.node_finished(name, None, None, interrupted=True)
                raise
            except Exception as e:
                span.record_exception(e)
                if observer:
                    await observer.node_finished(
                        name, None, f"{type(e).__name__}: {e}", interrupted=False)
                raise
            span.set_attribute("llm_cost_usd", meter.usd)
        if meter.usd:
            update["budget_used_usd"] = state.get("budget_used_usd", 0.0) + meter.usd
        if observer:
            await observer.node_finished(name, update, None, interrupted=False)
        return update

    wrapped.__name__ = name
    return wrapped


def build_graph(
    deps: OrchestratorDeps, checkpointer: BaseCheckpointSaver[Any] | None = None
) -> CompiledStateGraph[Any, Any, Any, Any]:
    cfg = deps.config
    planner = PlanningAgent(deps.llm)
    gatherer = GatheringAgent(deps.llm)
    analyst = AnalysisAgent(deps.llm)
    reporter = ReportingAgent(deps.llm)

    async def load_context(state: IncidentState) -> dict[str, Any]:
        context: dict[str, Any] = {}
        if deps.memory is None:
            await narrate("No long-term memory configured; starting from scratch")
        else:
            await narrate("Searching memory for similar past incidents")
            try:
                context = await deps.memory.get_context(state["incident"])
                similar = context.get("similar_incidents") or []
                await narrate(f"Found {len(similar)} similar past incident"
                              f"{'' if len(similar) == 1 else 's'}" if similar
                              else "No similar past incidents")
            except Exception as e:  # noqa: BLE001 - context is enrichment, not a safety gate
                logger.warning("Memory context unavailable: %s", e)
                context = {"memory_error": str(e)}
        if deps.graph is not None:
            incident = state["incident"]
            names = list(alerted_entities(incident).values())
            await narrate("Looking up the alerted entities in the knowledge graph")
            try:
                graph_ctx = await investigation_context(
                    deps.graph, incident.labels.get("dataset"), names,
                    include_history=deps.graph_history)
            except Exception as e:  # noqa: BLE001 - the graph is optional enrichment
                logger.warning("Knowledge graph unavailable: %s", e)
                graph_ctx = None
            if graph_ctx:
                context["knowledge_graph"] = graph_ctx
                for ent in graph_ctx.get("alerted_entities", []):
                    near = len(ent.get("other_failing_hosts_same_parent", [])) + len(
                        ent.get("other_failing_hosts_same_grandparent", []))
                    where = " > ".join(ent.get("location", [])) or ent["kind"]
                    await narrate(f"Graph: {ent['name']} ({where}); {ent['error_lines']} error "
                                  f"lines; {near} other failing host{'' if near == 1 else 's'} "
                                  "nearby")
        return {"context": context, "status": "context_loaded"}

    async def plan(state: IncidentState) -> dict[str, Any]:
        incident = state["incident"]
        iteration = state.get("iterations", 0) + 1
        read_tools = deps.registry.list_tools(risk_level="read", environment=incident.environment)
        allowed = {t.name for t in read_tools}
        if iteration == 1:
            await narrate(f"Planning the investigation with {len(read_tools)} read-only tools")
        else:
            best = state["hypotheses"][0].confidence if state["hypotheses"] else 0.0
            await narrate(f"Confidence {_pct(best)} is below {_pct(cfg.min_confidence)}; "
                          f"planning investigation round {iteration}")
        dataset = incident.labels.get("dataset")
        columns = (await asyncio.to_thread(deps.tools.log_explorer.columns, dataset)
                   if dataset else [])
        steps = await planner.generate_plan(
            scope=investigation_scope(incident, columns),
            incident=incident,
            context=state["context"],
            tools=read_tools,
            iteration=iteration,
            prior_steps=state["plan"],
            prior_evidence=state["evidence"],
            prior_hypotheses=state["hypotheses"],
            rejected_actions=[a for a in state["proposed_actions"] if a.status == "rejected"],
        )
        # The planner may only schedule read tools; anything else is skipped, not run.
        steps = [s if s.tool in allowed else s.model_copy(update={"status": "skipped"})
                 for s in steps]
        await narrate(f"Planned {len(steps)} step{'' if len(steps) == 1 else 's'}")
        return {"plan": [*state["plan"], *steps], "iterations": iteration,
                "status": "planning_done"}

    async def _gather_step(incident: Incident, step: PlanStep) -> tuple[PlanStep, Evidence]:
        collected_at = _now()
        if step.status == "skipped":
            await narrate(f"Skipping {step.id}: {step.tool} is not an allowed read-only tool")
        await narrate(f"{step.id} \u00b7 {step.goal}")
        try:
            raw = await deps.tools.run(step.tool, step.args, incident)
        except Exception as e:  # noqa: BLE001 - recorded as failed evidence
            msg = await asyncio.to_thread(deps.scrubber.scrub, f"{type(e).__name__}: {e}")
            await narrate(f"{step.tool} failed: {msg}")
            return step.model_copy(update={"status": "failed"}), Evidence(
                id=step.id, step_id=step.id, tool=step.tool, summary=f"Tool failed: {msg}",
                pii_redacted=True, collected_at=collected_at, ok=False,
            )

        if len(raw) > cfg.max_tool_output_chars:
            raw = raw[: cfg.max_tool_output_chars] + "\n...[truncated]"
        # PII is removed before the output reaches any LLM or disk.
        scrubbed = await asyncio.to_thread(deps.scrubber.scrub, raw)
        await narrate(describe_tool_output(step.tool, scrubbed))
        artifact = cfg.artifacts_dir / str(incident.id) / f"{step.id}.txt"
        artifact_uri: str | None = None
        try:
            artifact.parent.mkdir(parents=True, exist_ok=True)
            artifact.write_text(scrubbed, encoding="utf-8")
            artifact_uri = artifact.as_uri()
        except (OSError, ValueError) as e:  # an artifact is optional; never fail the run
            logger.warning("Could not persist artifact for %s: %s", step.id, e)

        await narrate(f"Summarising what {step.id} shows")
        try:
            summary = await gatherer.summarize(step, scrubbed)
        except Exception as e:  # noqa: BLE001 - the tool succeeded; keep its output
            logger.warning("Gathering summary failed for %s: %s", step.id, e)
            summary = (f"LLM summary unavailable ({type(e).__name__}); scrubbed tool output "
                       f"excerpt:\n{scrubbed[:2000]}")
        return step.model_copy(update={"status": "done"}), Evidence(
            id=step.id, step_id=step.id, tool=step.tool, summary=summary,
            artifact_uri=artifact_uri, pii_redacted=True, collected_at=collected_at,
        )

    async def gather(state: IncidentState) -> dict[str, Any]:
        incident = state["incident"]
        updated: list[PlanStep] = []
        evidence = list(state["evidence"])
        for step in state["plan"]:
            if step.status == "pending" and step.iteration == state["iterations"]:
                step, ev = await _gather_step(incident, step)
                evidence.append(ev)
            updated.append(step)
        return {"plan": updated, "evidence": evidence, "status": "gathering_done"}

    async def analyze(state: IncidentState) -> dict[str, Any]:
        usable = [e for e in state["evidence"] if e.ok]
        await narrate(f"Weighing {len(usable)} piece{'' if len(usable) == 1 else 's'} of "
                      "evidence against the fault taxonomy")
        hypotheses = await analyst.analyze_evidence(
            state["evidence"], state["context"], incident=state["incident"],
            scope=investigation_scope(state["incident"]),
        )
        if hypotheses:
            top = hypotheses[0]
            await narrate(f"Top hypothesis: {top.fault_type} in {top.root_cause_component} "
                          f"({_pct(top.confidence)} confidence, cites "
                          f"{', '.join(top.evidence_ids)})")
        else:
            await narrate("No evidence-backed root cause yet")
        return {"hypotheses": hypotheses, "status": "analysis_done"}

    async def propose_actions(state: IncidentState) -> dict[str, Any]:
        if not state["hypotheses"]:
            await narrate("No root cause, so no remediation to propose")
            return {"status": "no_root_cause"}
        incident = state["incident"]
        await narrate("Looking for a safe remediation")
        new = await planner.propose_remediation(
            incident=incident,
            hypotheses=state["hypotheses"],
            evidence=state["evidence"],
            tools=deps.registry.list_tools(environment=incident.environment),
            iteration=state["iterations"],
            rejected_actions=[a for a in state["proposed_actions"] if a.status == "rejected"],
        )
        await narrate(f"Proposed: {', '.join(a.kind for a in new)}" if new
                      else "No remediation proposed; the evidence does not justify an action")
        return {"proposed_actions": [*state["proposed_actions"], *new],
                "status": "proposals_done"}

    async def _check(incident: Incident, action: ProposedAction) -> ProposedAction:
        manifest = deps.registry.get_tool(action.kind)
        if manifest is None:
            return action.model_copy(update={
                "status": "blocked", "guardrail_notes": ["Unknown tool: not in registry"]})
        notes: list[str] = []
        if incident.environment not in manifest.allowed_envs:
            notes.append(f"Tool not allowed in {incident.environment}")
        missing = manifest.missing_args(action.args)
        if missing:
            notes.append(f"Missing required args: {missing}")
        if not deps.tools.is_implemented(action.kind):
            notes.append("No executor is registered for this tool")
        # Risk is taken from the registry, never from the model's proposal.
        action = action.model_copy(update={
            "risk": manifest.risk,
            "requires_approval": requires_approval(manifest, manifest.risk),
            "required_approvals": required_approvals(manifest, manifest.risk),
        })
        if notes:
            return action.model_copy(update={"status": "blocked", "guardrail_notes": notes})
        if action.risk != "read":
            safe, verdicts = await deps.guardrail.check_action(action)
            notes.extend(verdicts)
            if not safe:
                return action.model_copy(update={"status": "blocked", "guardrail_notes": notes})
        notes.append("Registry, environment and argument checks passed")
        if action.requires_approval:
            return action.model_copy(update={"status": "pending_approval",
                                              "guardrail_notes": notes})
        return action.model_copy(update={
            "status": "approved",
            "guardrail_notes": notes,
            "approval": Approval(decision="approved", by="policy:auto", at=_now(),
                                 comment="Read-only tool with approval policy 'none'"),
        })

    async def guardrails(state: IncidentState) -> dict[str, Any]:
        incident = state["incident"]
        checked: list[ProposedAction] = []
        for a in state["proposed_actions"]:
            if a.status != "proposed":
                checked.append(a)
                continue
            await narrate(f"Checking {a.kind} against guardrails")
            result = await _check(incident, a)
            outcome = {"blocked": f"Blocked {a.kind}: {'; '.join(result.guardrail_notes[:2])}",
                       "pending_approval": f"{a.kind} passed guardrails; needs "
                       f"{result.required_approvals} human approval"
                       f"{'' if result.required_approvals == 1 else 's'}",
                       "approved": f"{a.kind} auto-approved (read-only)"}
            await narrate(outcome.get(result.status, f"{a.kind}: {result.status}"))
            checked.append(result)
        return {"proposed_actions": checked, "status": "guardrails_done"}

    async def approval(state: IncidentState) -> dict[str, Any]:
        # One interrupt per pending action. On resume LangGraph replays this node and
        # feeds earlier decisions back in order, so the loop is deterministic.
        decided: list[ProposedAction] = []
        for a in state["proposed_actions"]:
            if a.status != "pending_approval":
                decided.append(a)
                continue
            answer: dict[str, Any] = interrupt({
                "action_id": a.id, "kind": a.kind, "args": a.args, "risk": a.risk,
                "rationale": a.rationale,
            })
            record = Approval(
                decision=answer["decision"], by=answer["by"],
                at=answer.get("at") or _now(), comment=answer.get("comment"),
            )
            decided.append(a.model_copy(update={
                "approval": record,
                "approvals": [Approval(**v) for v in answer.get("approvals", [])],
                "status": "approved" if record.decision == "approved" else "rejected",
            }))
        return {"proposed_actions": decided, "status": "approvals_done"}

    async def execute(state: IncidentState) -> dict[str, Any]:
        incident = state["incident"]
        out: list[ProposedAction] = []
        for a in state["proposed_actions"]:
            if a.status != "approved":
                out.append(a)
                continue
            # Defence in depth: never execute without an approval record.
            if a.approval is None or a.approval.decision != "approved":
                out.append(a.model_copy(update={
                    "status": "failed", "result": "Refused: no approval record"}))
                continue
            await narrate(f"Executing {a.kind}")
            try:
                result = await deps.tools.run(a.kind, a.args, incident)
                result = await asyncio.to_thread(deps.scrubber.scrub, result[:4000])
                out.append(a.model_copy(update={"status": "executed", "result": result}))
            except Exception as e:  # noqa: BLE001 - recorded on the action
                out.append(a.model_copy(update={
                    "status": "failed", "result": f"{type(e).__name__}: {e}"}))
        return {"proposed_actions": out, "status": "executed"}

    async def verify(state: IncidentState) -> dict[str, Any]:
        executed = [a for a in state["proposed_actions"] if a.status == "executed"]
        if not executed:
            verification = Verification(verified=False, reason="No remediation was executed.")
        else:
            kinds = ", ".join(sorted({a.kind for a in executed}))
            verification = Verification(
                verified=False,
                reason=f"Executed {len(executed)} action(s) ({kinds}), but no automated "
                "verification probe is configured. Confirm recovery manually.",
            )
        await narrate(verification.reason)
        return {"verification": verification, "status": "verified"}

    async def report(state: IncidentState) -> dict[str, Any]:
        args = (state["incident"], state["evidence"], state["hypotheses"],
                state["proposed_actions"], state["verification"])
        await narrate("Writing the RCA report")
        try:
            rep = await reporter.generate_report(*args)
        except Exception as e:  # noqa: BLE001 - replaced by an explicit, labelled fallback
            logger.error("Reporting agent failed: %s", e)
            rep = fallback_report(*args, error=f"{type(e).__name__}: {e}")
        return {"report": rep, "status": "reported"}

    async def memory_update(state: IncidentState) -> dict[str, Any]:
        if deps.memory is not None and state["report"] is not None:
            await narrate("Saving the outcome to memory for future incidents")
            try:
                await deps.memory.update(
                    state["incident"], state["report"], state["hypotheses"],
                    state["verification"],
                )
            except Exception as e:  # noqa: BLE001 - the RCA is already delivered
                logger.error("Memory update failed: %s", e)
                return {"status": "completed_memory_failed"}
        return {"status": "completed"}

    def route_after_analyze(state: IncidentState) -> Literal["plan", "propose_actions"]:
        best = state["hypotheses"][0].confidence if state["hypotheses"] else 0.0
        if (best < cfg.min_confidence
                and state["iterations"] < cfg.max_iterations
                and state.get("budget_used_usd", 0.0) < cfg.max_budget_usd):
            return "plan"
        return "propose_actions"

    def route_after_propose(state: IncidentState) -> Literal["guardrails", "verify"]:
        return "guardrails" if _current(state["proposed_actions"], state["iterations"]) \
            else "verify"

    def route_after_approval(state: IncidentState) -> Literal["plan", "execute"]:
        current = _current(state["proposed_actions"], state["iterations"])
        rejected = any(a.status == "rejected" for a in current)
        approved = any(a.status == "approved" for a in current)
        if rejected and not approved and state["iterations"] < cfg.max_iterations:
            return "plan"
        return "execute"

    nodes: dict[str, NodeFn] = {
        "load_context": load_context, "plan": plan, "gather": gather, "analyze": analyze,
        "propose_actions": propose_actions, "guardrails": guardrails, "approval": approval,
        "execute": execute, "verify": verify, "report": report, "memory_update": memory_update,
    }
    builder = StateGraph(IncidentState)
    for name in NODES:
        builder.add_node(name, _instrument(name, nodes[name]))

    builder.set_entry_point("load_context")
    builder.add_edge("load_context", "plan")
    builder.add_edge("plan", "gather")
    builder.add_edge("gather", "analyze")
    builder.add_conditional_edges("analyze", route_after_analyze,
                                  {"plan": "plan", "propose_actions": "propose_actions"})
    builder.add_conditional_edges("propose_actions", route_after_propose,
                                  {"guardrails": "guardrails", "verify": "verify"})
    builder.add_edge("guardrails", "approval")
    builder.add_conditional_edges("approval", route_after_approval,
                                  {"plan": "plan", "execute": "execute"})
    builder.add_edge("execute", "verify")
    builder.add_edge("verify", "report")
    builder.add_edge("report", "memory_update")
    builder.add_edge("memory_update", END)

    return builder.compile(checkpointer=checkpointer)
