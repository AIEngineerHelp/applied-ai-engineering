"""The offline simulation is the end-to-end test: the real agent, tools, guards, CRM
client and post-call step, driven through LiveKit's AgentSession in text mode."""

from __future__ import annotations

import pytest

from voiceagent.kb import KnowledgeBase
from voiceagent.simulation import load_scenarios, run_scenario


@pytest.mark.parametrize("scenario", load_scenarios(), ids=lambda s: s.name)
async def test_scenario_passes(scenario, store) -> None:  # type: ignore[no-untyped-def]
    result = await run_scenario(scenario, live=False, store=store, kb=KnowledgeBase())
    failed = [c for c in result["checks"] if not c["passed"]]
    assert not failed, failed


async def test_emergency_never_reaches_a_tool(store) -> None:  # type: ignore[no-untyped-def]
    sc = next(s for s in load_scenarios() if s.name == "emergency-guard")
    result = await run_scenario(sc, live=False, store=store, kb=KnowledgeBase())
    call = store.get_call(result["call_id"])
    assert not [e for e in call["events"] if e["kind"] == "tool"]
    assert call["summary"]["intent"] == "urgent"

