"""Live runs: the agent under test calls Gemini, and Giskard uses Gemini to attack and to judge."""

import asyncio
import json
from pathlib import Path
from typing import Any

from giskard.checks import set_default_generator, set_default_judge

from riskdemo.catalog import AGENTS, RISKS
from riskdemo.config import Settings
from riskdemo.engine import AgentCall, build_scenarios, new_run, run_attacks

RETRYABLE = (429, 500, 502, 503, 504)


def gemini_agent(settings: Settings, system_prompt: str) -> AgentCall:
    """The agent under test: one Gemini call per turn, with the conversation so far."""
    from google import genai
    from google.genai import errors, types

    client = genai.Client(api_key=settings.api_key)
    config = types.GenerateContentConfig(system_instruction=system_prompt)

    async def call(inputs: str, history: list[tuple[str, str]]) -> str:
        contents = []
        for user, agent in history:
            contents.append(types.Content(role="user", parts=[types.Part(text=user)]))
            contents.append(types.Content(role="model", parts=[types.Part(text=agent)]))
        contents.append(types.Content(role="user", parts=[types.Part(text=inputs)]))
        for attempt in range(3):
            try:
                response = await client.aio.models.generate_content(
                    model=settings.agent_model, contents=contents, config=config
                )
                # Gemini occasionally returns an empty or malformed reply; retry rather than pass on silence.
                if response.text or attempt == 2:
                    return response.text or ""
                continue
            except errors.APIError as error:
                if error.code not in RETRYABLE or attempt == 2:
                    raise
                await asyncio.sleep(2 * (attempt + 1))
        return ""

    return call


def configure_giskard(settings: Settings) -> None:
    """Point Giskard's attacker (generator) and judge at Gemini through its `gemini/` provider."""
    set_default_generator(f"gemini/{settings.attacker_model}")
    set_default_judge(f"gemini/{settings.judge_model}")


def models(settings: Settings) -> dict[str, str]:
    return {"agent": settings.agent_model, "attacker": settings.attacker_model, "judge": settings.judge_model}


def save(run: dict[str, Any], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(run, indent=1, ensure_ascii=False))
    tmp.replace(path)


async def live_run(
    settings: Settings, risk_id: str, version: str, n: int, run: dict[str, Any] | None = None, on_change=None
) -> dict[str, Any]:
    if not settings.live_available:
        raise RuntimeError("Set GEMINI_API_KEY to run live attacks.")
    risk = RISKS[risk_id]
    agent = AGENTS[risk.agent]
    configure_giskard(settings)
    run = run or new_run(risk, version, n, "live", models(settings))
    scenarios = build_scenarios(risk, agent, n)
    return await run_attacks(
        run,
        scenarios,
        gemini_agent(settings, agent.system_prompt(version)),
        max_concurrency=settings.max_concurrency,
        timeout_s=settings.attack_timeout_s,
        on_change=on_change,
    )
