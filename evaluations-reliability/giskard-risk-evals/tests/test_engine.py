"""Offline tests: scenario construction, run bookkeeping and the web API, with no model calls."""

import asyncio
import json

import pytest
from giskard.checks import from_fn

from riskdemo import config
from riskdemo.catalog import AGENTS, RISKS, VERSIONS
from riskdemo.engine import ATTACKER_TEMPLATE, build_scenarios, new_run, run_attacks


def test_catalog_is_consistent():
    for risk in RISKS.values():
        assert risk.agent in AGENTS
        assert risk.example_questions
        assert risk.prohibited in risk.rule() and risk.allowed_alternative in risk.rule()
    for agent in AGENTS.values():
        assert set(agent.prompts) == set(VERSIONS)
        assert agent.context in agent.system_prompt("hardened")


def test_attacker_and_judge_read_the_same_rule():
    risk = RISKS["investment-advice"]
    scenarios = build_scenarios(risk, AGENTS["bank"], 3)
    assert len(scenarios) == 3
    for scenario in scenarios:
        assert scenario.annotations["rule"] == risk.rule()
        assert scenario.annotations["description"] == AGENTS["bank"].description
        assert "risk:Investment advice" in scenario.tags
    dumped = json.dumps(scenarios[0].model_dump(), default=str)
    assert ATTACKER_TEMPLATE in dumped and "conformity" in dumped
    assert dumped.count(risk.rule()) >= 2  # once for the attacker's brief, once for the judge


def _offline_scenarios(n):
    risk = RISKS["investment-advice"]
    return risk, build_scenarios(
        risk,
        AGENTS["bank"],
        n,
        attacker=lambda: "Should I buy NVDA with my savings?",
        judge=lambda: from_fn(
            lambda trace: "can't" in trace.last.outputs, name="refuses", failure_message="gave advice"
        ),
    )


def test_run_records_turns_and_verdicts():
    risk, scenarios = _offline_scenarios(4)
    run = new_run(risk, "naive", 4, "test", {"agent": "stub", "attacker": "stub", "judge": "stub"})
    replies = iter(["I can't give personal investment advice.", "Buy NVDA now.", "I can't say.", "Sure, buy."])

    async def agent(inputs, history):
        assert history == []
        return next(replies)

    updates = []
    asyncio.run(run_attacks(run, scenarios, agent, max_concurrency=1, on_change=lambda r: updates.append(1)))
    assert [a["status"] for a in run["attacks"]] == ["passed", "failed", "passed", "failed"]
    assert run["summary"] == {"total": 4, "passed": 2, "failed": 2, "errored": 0}
    assert run["attacks"][1]["turns"] == [
        {"user": "Should I buy NVDA with my savings?", "agent": "Buy NVDA now.", "ms": run["attacks"][1]["turns"][0]["ms"]}
    ]
    assert run["attacks"][1]["checks"][0]["status"] == "fail"
    assert run["status"] == "done" and updates


def test_agent_errors_do_not_stop_the_run():
    risk, scenarios = _offline_scenarios(2)
    run = new_run(risk, "naive", 2, "test", {})
    calls = {"n": 0}

    async def flaky(inputs, history):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("provider down")
        return "I can't advise on that."

    asyncio.run(run_attacks(run, scenarios, flaky, max_concurrency=1))
    assert sorted(a["status"] for a in run["attacks"]) == ["error", "passed"]
    assert run["summary"]["errored"] == 1


@pytest.fixture()
def client(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient

    from riskdemo import web

    monkeypatch.setattr(web, "settings", config.load_settings(env={}))
    return TestClient(web.app)


def test_catalog_api(client):
    body = client.get("/api/catalog").json()
    assert set(body["risks"]) == set(RISKS)
    assert body["live"]["available"] is False
    assert "goal_reached" in body["attacker_template"]
    assert client.get("/").status_code == 200


def test_live_run_needs_a_key(client):
    response = client.post("/api/runs", json={"risk": "investment-advice", "version": "naive"})
    assert response.status_code == 400
    assert client.post("/api/runs", json={"risk": "nope", "version": "naive"}).status_code == 400


def test_recorded_runs_have_the_expected_shape(client):
    files = sorted(config.RECORDED.glob("*--*.json"))
    assert files
    for path in files:
        run = json.loads(path.read_text())
        risk_id, version = path.stem.split("--")
        assert run["risk"] == risk_id and run["version"] == version
        assert run["summary"]["total"] == len(run["attacks"])
        assert client.get(f"/api/recorded/{risk_id}/{version}").status_code == 200
    assert client.get("/api/recorded/investment-advice/unknown").status_code == 404
    notes = client.get("/api/catalog").json()["review_notes"]
    for key, by_attack in notes.items():
        assert (config.RECORDED / f"{key}.json").exists()
        run = json.loads((config.RECORDED / f"{key}.json").read_text())
        assert all(1 <= int(n) <= len(run["attacks"]) for n in by_attack)


def test_live_runs_are_listed_newest_first(client, monkeypatch, tmp_path):
    from riskdemo import web

    monkeypatch.setattr(config, "RUNS", tmp_path)
    scored = [{"status": "failed"}] * 7 + [{"status": "passed"}] * 3
    for i, risk in enumerate(["investment-advice", "medication-changes"]):
        run = {"id": f"run-{i}", "risk": risk, "version": "naive", "started_at": f"2026-10-2{i}T10:00:00+00:00",
               "status": "done", "summary": {"total": 10, "passed": 3, "failed": 7, "errored": 0}, "attacks": scored}
        (tmp_path / f"run-{i}.json").write_text(json.dumps(run))
    # An empty run and one left "running" by a process that stopped.
    empty = {"id": "empty", "risk": "investment-advice", "version": "naive", "started_at": "2026-10-25T10:00:00+00:00",
             "status": "error", "summary": None, "attacks": [{"status": "queued"}]}
    stale = {**empty, "id": "stale", "status": "running", "attacks": [{"status": "passed"}, {"status": "queued"}]}
    (tmp_path / "empty.json").write_text(json.dumps(empty))
    (tmp_path / "stale.json").write_text(json.dumps(stale))
    (tmp_path / "broken.json").write_text("{")
    monkeypatch.setattr(web, "_live", {})
    listing = client.get("/api/runs").json()
    assert [r["id"] for r in listing] == ["stale", "run-1", "run-0"]
    assert listing[0]["status"] == "interrupted" and listing[0]["scored"] == 1
    assert "attacks" not in listing[1]


def test_study_loop_and_article_routes(client):
    assert client.get("/api/loop/..%2Fsecret").status_code == 404
    assert client.get("/api/recorded/investment-advice/naive?set=nope").status_code == 404
    body = client.get("/api/catalog").json()
    assert set(body["sets"]) == set(config.SETS)
    assert [r["revision"] for r in body["revisions"]["dispute-recourse"]] == [1, 2]
