"""Simulated calls: scripted callers against the real workflow, in text, with no audio.

    uv run python -m voiceagent simulate            # scripted model, offline, free
    uv run python -m voiceagent simulate --live     # Gemini as the model (paid)

Each scenario gets a fresh in-process mock CRM with its fault switch set, runs the
caller's turns through LiveKit's AgentSession in text mode, and checks the outcome.
Simulated calls are written to the call log, so they appear in the dashboard next to
real calls.
"""

from __future__ import annotations

import asyncio
import json
import time
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx
import yaml
from livekit.agents import AgentSession
from pydantic import BaseModel, Field

from .agent import ClinicAgent
from .call import CallState, run_pre_call
from .config import settings
from .crm.client import CRMClient, RetryPolicy
from .crm.server import TZ, CRMState, FaultConfig, create_app
from .kb import KnowledgeBase
from .postcall import finish_call
from .scripted_llm import ScriptedLLM
from .session import attach_recorder
from .store import CallStore
from .workflow import ROOT, default_workflow

SCENARIOS = ROOT / "simulation" / "scenarios.yaml"
RESULTS = ROOT / "results"
RUNS = ROOT / "runs" / "simulations"


class Expect(BaseModel):
    pre_call: str | None = None
    tools_ok: list[str] = Field(default_factory=list)
    tools_not_called: list[str] = Field(default_factory=list)
    tool_outcomes: dict[str, str] = Field(default_factory=dict)
    guard: str | None = None
    transfer: str | None = None
    end_status: str | None = None
    crm_new_appointments: int | None = None
    crm_retries: int | None = None


class Scenario(BaseModel):
    name: str
    title: str
    phone: str | None
    turns: list[str]
    fault: FaultConfig | None = None
    expect: Expect


def load_scenarios(path: Path = SCENARIOS) -> list[Scenario]:
    return [Scenario.model_validate(s) for s in yaml.safe_load(path.read_text())]


def check(expect: Expect, call: dict[str, Any], new_appointments: int) -> list[dict[str, Any]]:
    events = call["events"]
    tools = [e["data"] for e in events if e["kind"] == "tool"]
    pre = next((e["data"]["outcome"] for e in events if e["kind"] == "pre_call"), None)
    guard = next((e["data"]["name"] for e in events if e["kind"] == "guard"), None)
    retries = sum(1 for e in events if e["kind"] == "crm_attempt" and e["data"]["attempt"] > 1)
    transfer = call["transfer_to"]
    checks: list[dict[str, Any]] = []

    def add(name: str, passed: bool, detail: str) -> None:
        checks.append({"check": name, "passed": passed, "detail": detail})

    if expect.pre_call:
        add("pre-call lookup", pre == expect.pre_call, f"expected {expect.pre_call}, got {pre}")
    for name in expect.tools_ok:
        ok = any(t["name"] == name and t["outcome"] == "ok" for t in tools)
        add(f"{name} succeeded", ok, "called and succeeded" if ok else
            f"outcomes: {[t['outcome'] for t in tools if t['name'] == name] or 'not called'}")
    for name in expect.tools_not_called:
        called = [t for t in tools if t["name"] == name]
        add(f"{name} not called", not called, f"called {len(called)} times")
    for name, outcome in expect.tool_outcomes.items():
        got = [t["outcome"] for t in tools if t["name"] == name]
        add(f"{name} -> {outcome}", outcome in got, f"got {got or 'not called'}")
    if expect.guard:
        add("guard fired", guard == expect.guard, f"expected {expect.guard}, got {guard}")
    if expect.transfer:
        add("transferred", transfer == expect.transfer,
            f"expected {expect.transfer}, got {transfer}")
    if expect.end_status:
        add("end status", call["end_status"] == expect.end_status,
            f"expected {expect.end_status}, got {call['end_status']}")
    if expect.crm_new_appointments is not None:
        add("CRM bookings", new_appointments == expect.crm_new_appointments,
            f"expected {expect.crm_new_appointments} new, got {new_appointments}")
    if expect.crm_retries is not None:
        add("CRM retries", retries >= expect.crm_retries,
            f"expected at least {expect.crm_retries}, got {retries}")
    return checks


async def run_scenario(sc: Scenario, *, live: bool, store: CallStore,
                       kb: KnowledgeBase) -> dict[str, Any]:
    cfg = settings()
    crm_state = CRMState(today=datetime.now(TZ).date())
    before = len(crm_state.appointments)
    if sc.fault:
        crm_state.fault = sc.fault
        crm_state.fault_remaining = sc.fault.count
    crm = CRMClient("http://crm.local", cfg.crm_api_key,
                    transport=httpx.ASGITransport(app=create_app(crm_state, cfg.crm_api_key)),
                    policy=RetryPolicy())
    pipeline = f"text:{cfg.cascade_llm}" if live else "scripted"
    models = {"stt": "text", "llm": cfg.cascade_llm if live else "scripted", "tts": "text"}
    state = CallState(workflow=default_workflow(), crm=crm, kb=kb, store=store,
                      source="simulation", pipeline=pipeline, models=models,
                      caller_phone=sc.phone, scenario=sc.name)
    started = time.monotonic()
    greeting = await run_pre_call(state)
    if live:
        from livekit.plugins import google
        model: Any = google.LLM(model=cfg.cascade_llm, api_key=cfg.gemini_api_key,
                                temperature=0.2)
    else:
        model = ScriptedLLM()
    error = None
    try:
        async with AgentSession(llm=model, userdata=state) as session:
            closed = attach_recorder(session, state)
            agent = ClinicAgent(state, greeting)
            await session.start(agent)
            await agent.greeted.wait()  # on_enter runs as a task
            await agent.greeting_handle
            for turn in sc.turns:
                if closed["event"].is_set() or state.transfer:
                    break
                result: Any = await session.run(user_input=turn)
                await result
            if state.transfer or state.ended_by_agent:
                await asyncio.wait_for(closed["event"].wait(), timeout=10)
    except Exception as exc:  # a crash is a failed scenario, not a failed run
        error = f"{type(exc).__name__}: {exc}"
        state.event("error", where="simulation", error=error)
    finally:
        await crm.aclose()
    await finish_call(state, close_reason=None, error=error, use_llm=live, deliver=False)
    call = store.get_call(state.call_id) or {}
    created = len(crm_state.appointments) - before
    checks = check(sc.expect, call, created)
    if error:
        checks.append({"check": "ran without error", "passed": False, "detail": error})
    return {
        "scenario": sc.name, "title": sc.title, "call_id": state.call_id,
        "passed": all(c["passed"] for c in checks), "checks": checks,
        "seconds": round(time.monotonic() - started, 2),
        "transcript": [{"role": e["data"]["role"], "text": e["data"]["text"]}
                       for e in call.get("events", []) if e["kind"] == "transcript"],
    }


async def run_all(*, live: bool, only: list[str] | None = None,
                  store: CallStore | None = None) -> dict[str, Any]:
    store = store or CallStore()
    kb = KnowledgeBase()
    scenarios = [s for s in load_scenarios() if not only or s.name in only]
    pipeline = f"text:{settings().cascade_llm}" if live else "scripted"
    store.delete_source("simulation", pipeline)
    results = []
    for sc in scenarios:  # one at a time: the call log keeps calls in order
        results.append(await run_scenario(sc, live=live, store=store, kb=kb))
    report = {
        "ran_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "mode": "live" if live else "scripted",
        "model": settings().cascade_llm if live else "scripted (rules, no model)",
        "passed": sum(r["passed"] for r in results),
        "total": len(results),
        "results": results,
    }
    RUNS.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    (RUNS / f"{stamp}-{report['mode']}.json").write_text(json.dumps(report, indent=2))
    if not only:
        RESULTS.mkdir(exist_ok=True)
        (RESULTS / f"simulation-{report['mode']}.json").write_text(json.dumps(report, indent=2))
    return report
