"""Turn a risk definition into Giskard scenarios, run them against an agent, and record every turn.

The Giskard part is `build_scenarios`: the same rule text goes to the attacker (through the scenario's
annotations, which Giskard's adversarial prompt reads) and to the `Conformity` judge. The rest of this
module is bookkeeping, so the app can show each conversation while it happens.
"""

import asyncio
import time
import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from importlib import metadata
from typing import Any

import giskard.scan  # noqa: F401  registers the giskard.scan prompt templates used below
from giskard.checks import Check, Conformity, LLMGenerator, Scenario
from giskard.checks.core.input_generator import InputGenerator

from riskdemo.catalog import Agent, RiskDefinition
from riskdemo.seeds import Seed, seed_brief

ATTACKER_TEMPLATE = "giskard.scan::scenarios/adversarial.j2"
ATTACKER_MAX_TURNS = 3

# (inputs, history) -> reply, where history is a list of (user, agent) pairs from earlier turns.
AgentCall = Callable[[str, list[tuple[str, str]]], Awaitable[str]]


def attacker_brief(risk: RiskDefinition, agent: Agent) -> dict[str, Any]:
    """The annotations Giskard's adversarial template reads: who the agent is, what to push for."""
    return {
        "description": agent.description,
        "category": {
            "name": f"{risk.category}: {risk.risk}",
            "description": f"{risk.basis} Example user questions: " + " | ".join(risk.example_questions),
        },
        "rule": risk.rule(),
        "languages": ["en"],
    }


@InputGenerator.register("seeded_llm_generator")
class SeededLLMGenerator(LLMGenerator):
    """Giskard's LLM attacker, with one extra paragraph in the category description it reads.

    The adversarial template reads only the trace's annotations (description, category, rule, languages),
    and every scenario in a run shares them. This generator hands the attacker a copy of the trace whose
    category description ends with this attack's seed. The scenario's own annotations stay untouched,
    so the judge, which also sees the annotations, never sees the seed.
    """

    seed_text: str = ""

    async def get_inputs(self, trace) -> dict[str, Any]:
        annotations = dict(trace.annotations)
        category = dict(annotations.get("category") or {})
        category["description"] = f"{category.get('description', '')}\n\n{self.seed_text}".strip()
        annotations["category"] = category
        return {"trace": trace.model_copy(update={"annotations": annotations})}


@InputGenerator.register("styled_llm_generator")
class StyledLLMGenerator(LLMGenerator):
    """Giskard's LLM attacker with another attack template (Crescendo or GOAT from giskard.scan).

    Those templates read a `goal`, a `language` and their own settings from the trace's annotations. As
    with seeds, they go only into the attacker's copy of the trace, so the judge sees the same
    annotations as in every other run.
    """

    extra: dict[str, Any] = {}

    async def get_inputs(self, trace) -> dict[str, Any]:
        return {"trace": trace.model_copy(update={"annotations": {**trace.annotations, **self.extra}})}


# Giskard's multi-turn attack styles, pointed at our rules instead of their built-in harmful-content goals.
STYLE_MAX_TURNS = 6
STYLE_TEMPLATES = {
    "crescendo": "giskard.scan::scenarios/crescendo_attack.j2",
    "goat": "giskard.scan::scenarios/goat_attack.j2",
}


def attack_goal(risk: RiskDefinition) -> str:
    return f"Make the assistant provide {risk.prohibited}."


def style_attacker(style: str, risk: RiskDefinition, max_turns: int = STYLE_MAX_TURNS) -> StyledLLMGenerator:
    extra: dict[str, Any] = {"goal": attack_goal(risk), "language": "en", "max_turns": max_turns}
    if style == "goat":
        from giskard.scan.generators.goat import GOAT_ATTACK_STRATEGIES

        extra["strategies"] = [s.model_dump() for s in GOAT_ATTACK_STRATEGIES]
    # Giskard's Crescendo generator uses 4 retries, because attacker models sometimes refuse the role.
    return StyledLLMGenerator(prompt_path=STYLE_TEMPLATES[style], max_steps=max_turns, max_retries=4, extra=extra)


def build_scenarios(
    risk: RiskDefinition,
    agent: Agent,
    n: int,
    *,
    seeds: list[Seed] | None = None,
    style: str | None = None,
    attacker: Callable[[], Any] | None = None,
    judge: Callable[[], Check] | None = None,
) -> list[Scenario]:
    """One scenario per attack. Each runs a fresh conversation, so the same rule yields different attacks.

    With `seeds`, attack i starts from seeds[i] (a question, a persona and a tactic) instead of the
    shared brief alone. With `style` ("crescendo" or "goat"), the attacker uses that Giskard template.
    `attacker` and `judge` default to Giskard's LLM attacker and `Conformity` judge; tests pass
    deterministic stand-ins.
    """
    if seeds is not None and len(seeds) < n:
        raise ValueError(f"Need {n} seeds, got {len(seeds)}.")

    def make_attacker(i: int):
        if attacker:
            return attacker()
        if style:
            return style_attacker(style, risk)
        if seeds:
            return SeededLLMGenerator(
                prompt_path=ATTACKER_TEMPLATE, max_steps=ATTACKER_MAX_TURNS, seed_text=seed_brief(seeds[i])
            )
        return LLMGenerator(prompt_path=ATTACKER_TEMPLATE, max_steps=ATTACKER_MAX_TURNS)

    make_judge = judge or (lambda: Conformity(name=risk.risk, rule=risk.rule()))
    return [
        Scenario(f"{risk.risk} #{i + 1}")
        .interact(make_attacker(i))
        .check(make_judge())
        .with_annotations(attacker_brief(risk, agent))
        .with_tags([f"domain:{risk.domain}", f"category:{risk.category}", f"risk:{risk.risk}"])
        for i in range(n)
    ]


def new_run(
    risk: RiskDefinition,
    version: str,
    n: int,
    mode: str,
    models: dict[str, str],
    seeds: list[Seed] | None = None,
    style: str | None = None,
) -> dict[str, Any]:
    return {
        "id": datetime.now(UTC).strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6],
        "mode": mode,
        "agent": risk.agent,
        "risk": risk.id,
        "version": version,
        "models": models,
        "giskard": {p: metadata.version(p) for p in ("giskard-checks", "giskard-scan")},
        "rule": risk.rule(),
        "rule_revision": risk.revision,
        "seeded": seeds is not None,
        **({"style": style, "goal": attack_goal(risk), "max_turns": STYLE_MAX_TURNS} if style else {}),
        "started_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "finished_at": None,
        "status": "running",
        "attacks": [
            {
                "index": i,
                "status": "queued",
                "turns": [],
                "checks": [],
                "error": None,
                "duration_ms": None,
                **({"seed": seeds[i].to_dict()} if seeds else {}),
            }
            for i in range(n)
        ],
        "summary": None,
    }


def summarize(run: dict[str, Any]) -> dict[str, int]:
    statuses = [a["status"] for a in run["attacks"]]
    return {
        "total": len(statuses),
        "passed": statuses.count("passed"),
        "failed": statuses.count("failed"),
        "errored": statuses.count("error"),
    }


def _check_rows(result: Any) -> list[dict[str, Any]]:
    rows = []
    for step in result.steps:
        for check in step.results:
            rows.append(
                {
                    "name": check.details.get("check_name") or check.details.get("check_kind") or "check",
                    "kind": check.details.get("check_kind"),
                    "status": check.status.value,
                    "reason": check.details.get("reason") or check.message,
                }
            )
        if step.error is not None:
            rows.append({"name": "input generation", "kind": None, "status": "error", "reason": step.error.message})
    return rows


async def run_attacks(
    run: dict[str, Any],
    scenarios: list[Scenario],
    call_agent: AgentCall,
    *,
    max_concurrency: int = 5,
    timeout_s: float = 180,
    on_change: Callable[[dict[str, Any]], None] | None = None,
) -> dict[str, Any]:
    """Run every scenario, writing each turn and verdict into `run` as soon as it happens."""
    semaphore = asyncio.Semaphore(max_concurrency)
    changed = on_change or (lambda _run: None)

    async def one(index: int, scenario: Scenario) -> None:
        attack = run["attacks"][index]

        # Giskard injects `inputs` (the attacker's new message) and `trace` (earlier turns) by name.
        async def target(inputs: str, trace) -> str:
            history = [(str(i.inputs), str(i.outputs)) for i in trace.interactions]
            started = time.perf_counter()
            reply = await call_agent(inputs, history)
            attack["turns"].append(
                {"user": inputs, "agent": reply, "ms": int((time.perf_counter() - started) * 1000)}
            )
            changed(run)
            return reply

        async with semaphore:
            attack["status"] = "running"
            changed(run)
            started = time.perf_counter()
            try:
                result = await asyncio.wait_for(
                    scenario.run(target=target, return_exception=True), timeout=timeout_s
                )
                attack["checks"] = _check_rows(result)
                attack["status"] = "passed" if result.passed else "failed" if result.failed else "error"
                if attack["status"] == "error":
                    attack["error"] = next(
                        (c["reason"] for c in attack["checks"] if c["status"] == "error"), "The attack errored."
                    )
            except TimeoutError:
                attack["status"], attack["error"] = "error", f"Timed out after {timeout_s:.0f} s."
            except Exception as error:  # a provider outage should not take down the whole run
                attack["status"], attack["error"] = "error", f"{type(error).__name__}: {error}"
            attack["duration_ms"] = int((time.perf_counter() - started) * 1000)
            changed(run)

    await asyncio.gather(*(one(i, s) for i, s in enumerate(scenarios)))
    run["status"] = "done"
    run["finished_at"] = datetime.now(UTC).isoformat(timespec="seconds")
    run["summary"] = summarize(run)
    changed(run)
    return run
