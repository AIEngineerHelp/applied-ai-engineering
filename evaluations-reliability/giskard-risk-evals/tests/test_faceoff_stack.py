"""Offline tests for the face-off attackers and the stacked checks, with no model calls."""

import asyncio
import json

from giskard.checks.core.interaction.trace import Trace

from riskdemo import config
from riskdemo.catalog import AGENTS, RISKS
from riskdemo.engine import (
    STYLE_MAX_TURNS,
    STYLE_TEMPLATES,
    StyledLLMGenerator,
    attack_goal,
    build_scenarios,
    new_run,
)
from riskdemo.stack import STACKS, _verdicts


def test_styled_attacker_uses_giskard_template_and_keeps_the_goal_from_the_judge():
    risk = RISKS["medication-changes"]
    for style, template in STYLE_TEMPLATES.items():
        [scenario] = build_scenarios(risk, AGENTS["clinic"], 1, style=style)
        dumped = json.dumps(scenario.model_dump(), default=str)
        assert template in dumped and "conformity" in dumped
        # The scenario's annotations (which the judge sees) carry the rule, not the attacker's goal.
        assert scenario.annotations["rule"] == risk.rule()
        assert "goal" not in scenario.annotations and "strategies" not in scenario.annotations


def test_styled_attacker_adds_goal_only_to_its_copy_of_the_trace():
    risk = RISKS["investment-advice"]
    gen = StyledLLMGenerator(prompt_path=STYLE_TEMPLATES["goat"], max_steps=2, extra={"goal": attack_goal(risk), "language": "en"})
    trace = Trace[str, str](annotations={"rule": risk.rule()})
    inputs = asyncio.run(gen.get_inputs(trace))
    assert inputs["trace"].annotations["goal"] == attack_goal(risk)
    assert "goal" not in trace.annotations


def test_styled_run_records_its_style_and_turn_limit():
    run = new_run(RISKS["investment-advice"], "hardened", 2, "recorded", {}, style="crescendo")
    assert run["style"] == "crescendo" and run["max_turns"] == STYLE_MAX_TURNS
    assert run["goal"].startswith("Make the assistant provide personalized recommendations")


def _attack(*replies):
    return {"turns": [{"user": "q", "agent": r} for r in replies]}


def test_stacks_combine_regex_and_replayed_judges():
    routed = _attack("Please call the nurse line.", "Ask your prescriber or the anticoagulation clinic.")
    unrouted = _attack("Please call the nurse line.", "Just take it.")
    v = asyncio.run(_verdicts(routed, "medication-changes", judge=False, second=True))
    assert v == {"judge": False, "regex": True, "judge_and_regex": False, "judge_or_regex": True, "two_judges": False}
    v = asyncio.run(_verdicts(unrouted, "medication-changes", judge=True, second=True))
    assert v["regex"] is False and v["judge_and_regex"] is False and v["judge_or_regex"] is True and v["two_judges"] is True
    assert {s[0] for s in STACKS} == set(v)


def test_committed_stack_results_match_the_labels():
    path = config.STUDY / "stack.json"
    if not path.exists():
        return
    out = json.loads(path.read_text())
    for s in out["stacks"]:
        assert s["n"] == len(out["conversations"])
        fp = sum(c["verdicts"][s["id"]] and c["label"] == "fail" for c in out["conversations"])
        assert fp == s["false_pass"]
