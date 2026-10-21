"""The demo app: `uv run python -m riskdemo serve`, then open http://127.0.0.1:4330.

Recorded runs are replayed from results/recorded/ with no API key. A live run starts only when you press
"Run live" in the page, and only when GEMINI_API_KEY is set; one live run can be active at a time.
"""

import asyncio
import json
from importlib import resources
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from riskdemo import config
from riskdemo.catalog import AGENTS, RISKS, VERSIONS

STATIC = Path(__file__).parent / "static"

settings = config.load_settings()
app = FastAPI(title="Giskard risk evals demo")
app.mount("/static", StaticFiles(directory=STATIC), name="static")

_live: dict[str, dict] = {}  # run id -> run state, for runs started in this process
_tasks: set[asyncio.Task] = set()


def recorded_path(risk_id: str, version: str) -> Path:
    return config.RECORDED / f"{risk_id}--{version}.json"


def recorded_summaries() -> dict:
    out: dict = {}
    for risk_id in RISKS:
        for version in VERSIONS:
            path = recorded_path(risk_id, version)
            if path.exists():
                run = json.loads(path.read_text())
                out.setdefault(risk_id, {})[version] = {
                    "summary": run["summary"],
                    "recorded_at": run["started_at"],
                    "models": run["models"],
                }
    return out


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC / "index.html")


@app.get("/api/catalog")
def catalog() -> dict:
    template = resources.files("giskard.scan").joinpath("prompts/scenarios/adversarial.j2").read_text()
    judge_template = resources.files("giskard.checks").joinpath("prompts/judges/conformity.j2").read_text()
    from riskdemo.live import models

    return {
        "agents": {
            a.id: {
                "id": a.id,
                "name": a.name,
                "industry": a.industry,
                "description": a.description,
                "context": a.context,
                "prompts": a.prompts,
            }
            for a in AGENTS.values()
        },
        "risks": {r.id: r.to_dict() for r in RISKS.values()},
        "versions": VERSIONS,
        "recorded": recorded_summaries(),
        "live": {
            "available": settings.live_available,
            "attacks": settings.attacks_per_run,
            "models": models(settings),
            "busy": any(r["status"] == "running" for r in _live.values()),
        },
        "attacker_template": template,
        "judge_template": judge_template,
        "review_notes": review_notes(),
    }


def review_notes() -> dict:
    path = config.RECORDED / "review-notes.json"
    if not path.exists():
        return {}
    return {k: v for k, v in json.loads(path.read_text()).items() if not k.startswith("_")}


@app.get("/api/recorded/{risk_id}/{version}")
def recorded(risk_id: str, version: str) -> dict:
    path = recorded_path(risk_id, version)
    if risk_id not in RISKS or version not in VERSIONS or not path.exists():
        raise HTTPException(404, "No recorded run for this risk and prompt version.")
    return json.loads(path.read_text())


class RunRequest(BaseModel):
    risk: str
    version: str


@app.post("/api/runs")
async def start_run(request: RunRequest) -> dict:
    from riskdemo.engine import new_run
    from riskdemo.live import live_run, models, save

    if request.risk not in RISKS or request.version not in VERSIONS:
        raise HTTPException(400, "Unknown risk or prompt version.")
    if not settings.live_available:
        raise HTTPException(400, "Live runs need GEMINI_API_KEY in .env. Recorded runs work without it.")
    if any(r["status"] == "running" for r in _live.values()):
        raise HTTPException(409, "A live run is already in progress. Wait for it to finish.")

    run = new_run(RISKS[request.risk], request.version, settings.attacks_per_run, "live", models(settings))
    _live[run["id"]] = run
    path = config.RUNS / f"{run['id']}.json"

    async def go() -> None:
        try:
            await live_run(settings, request.risk, request.version, len(run["attacks"]), run=run)
        except Exception as error:
            run["status"], run["error"] = "error", f"{type(error).__name__}: {error}"
        save(run, path)

    task = asyncio.create_task(go())
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    return {"id": run["id"]}


@app.get("/api/runs/{run_id}")
def get_run(run_id: str) -> dict:
    if run_id in _live:
        return _live[run_id]
    path = config.RUNS / f"{run_id}.json"
    if path.exists() and path.parent == config.RUNS:
        return json.loads(path.read_text())
    raise HTTPException(404, "Run not found.")
