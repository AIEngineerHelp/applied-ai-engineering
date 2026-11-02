"""The dashboard's backend, the mock CRM and a demo webhook receiver, on one port.

    uv run python -m voiceagent serve      # http://127.0.0.1:4331

The CRM is mounted at /crm so the dashboard's fault switch changes what live calls see.
The webhook receiver at /api/webhooks/receiver stands in for the customer's system: it
checks the signature and drops duplicates by idempotency key, as a real receiver should.
"""

from __future__ import annotations

import json
import re
import uuid
from datetime import timedelta
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import pricing
from .config import settings
from .crm.server import PATIENTS, PROVIDERS, FaultConfig, create_app
from .postcall import verify
from .simulation import RESULTS, load_scenarios, run_all
from .stats import summarize
from .store import CallStore
from .workflow import ROOT, default_workflow

WEB_DIST = ROOT / "web" / "dist"


class SessionRequest(BaseModel):
    pipeline: str = "realtime"
    caller_phone: str | None = None
    # When set, the caller is added to the mock CRM first, so a visitor can call as
    # themselves and be greeted by name. Nothing is dialled: the call stays in the browser.
    caller_name: str | None = Field(default=None, max_length=60)


def normalize_phone(raw: str) -> str:
    digits = re.sub(r"\D", "", raw)
    if not 7 <= len(digits) <= 15:
        raise HTTPException(400, "Enter a phone number with 7 to 15 digits,"
                                 " including the country code.")
    return f"+{digits}"


class SimulationRequest(BaseModel):
    only: list[str] | None = None


def create_api(store: CallStore | None = None) -> FastAPI:
    cfg = settings()
    store = store or CallStore()
    crm_app = create_app(api_key=cfg.crm_api_key)
    app = FastAPI(title="Clinic voice agent", docs_url="/api/docs")
    app.mount("/crm", crm_app)

    @app.get("/api/config")
    async def config() -> dict[str, Any]:
        wf = default_workflow()
        return {
            "clinic": wf.clinic.model_dump(),
            "gemini_key": bool(cfg.gemini_api_key),
            "livekit_url": cfg.livekit_url,
            "livekit_cloud": ".livekit.cloud" in cfg.livekit_url,
            "default_pipeline": cfg.voice_pipeline,
            "models": {
                "realtime": {"llm": cfg.realtime_model, "voice": cfg.realtime_voice},
                "cascade": {"stt": cfg.cascade_stt, "llm": cfg.cascade_llm,
                            "tts": cfg.cascade_tts},
            },
            "callers": [{"phone": p["phone"], "name": f"{p['first_name']} {p['last_name']}",
                         "patient_id": p["id"]} for p in PATIENTS]
            + [{"phone": "+15550199999", "name": "Unknown caller", "patient_id": None}],
            "providers": PROVIDERS,
            "prices": {"checked": pricing.CHECKED, "table": pricing.PRICES},
        }

    @app.get("/api/workflow")
    async def workflow() -> dict[str, Any]:
        wf = default_workflow()
        kb = sorted(p.name for p in (ROOT / "knowledge").glob("*.md"))
        return {"workflow": wf.model_dump(), "knowledge": kb,
                "yaml": (ROOT / "workflow" / "clinic.yaml").read_text()}

    @app.post("/api/session")
    async def session(body: SessionRequest) -> dict[str, str]:
        """A join token for a browser caller, with the agent dispatched into the room."""
        from livekit import api

        if body.pipeline not in ("realtime", "cascade"):
            raise HTTPException(400, "pipeline must be realtime or cascade")
        if not cfg.gemini_api_key:
            raise HTTPException(400, "Set GEMINI_API_KEY to talk to the agent.")
        if body.caller_name is not None:
            name = " ".join(body.caller_name.split())
            if not name or not body.caller_phone:
                raise HTTPException(400, "Enter a name and a phone number.")
            body.caller_phone = normalize_phone(body.caller_phone)
            first, _, last = name.partition(" ")
            crm_app.state.crm.register(first, last, body.caller_phone)
        room = f"call-{uuid.uuid4().hex[:10]}"
        meta = json.dumps({"pipeline": body.pipeline, "caller_phone": body.caller_phone})
        token = (
            api.AccessToken(cfg.livekit_api_key, cfg.livekit_api_secret)
            .with_identity(f"caller-{uuid.uuid4().hex[:6]}")
            .with_name("Browser caller")
            .with_ttl(timedelta(minutes=15))
            .with_grants(api.VideoGrants(room_join=True, room=room))
            .with_room_config(api.RoomConfiguration(agents=[
                api.RoomAgentDispatch(agent_name=cfg.agent_name, metadata=meta)]))
            .to_jwt()
        )
        return {"url": cfg.livekit_url, "token": token, "room": room}

    @app.get("/api/calls")
    async def calls(source: str | None = None) -> dict[str, Any]:
        rows = store.list_calls()
        if source:
            rows = [c for c in rows if c["source"] == source]
        return {"data": rows}

    @app.get("/api/calls/{call_id}")
    async def call(call_id: str) -> dict[str, Any]:
        found = store.get_call(call_id)
        if found is None:
            raise HTTPException(404, "unknown call")
        return found

    @app.get("/api/stats")
    async def stats(source: str | None = None) -> dict[str, Any]:
        return summarize(store, source)

    @app.get("/api/simulations")
    async def simulations() -> dict[str, Any]:
        reports = {}
        for mode in ("scripted", "live", "live-fixed-callers"):
            path = RESULTS / f"simulation-{mode}.json"
            if path.exists():
                reports[mode] = json.loads(path.read_text())
        return {"scenarios": [s.model_dump() for s in load_scenarios()], "reports": reports}

    @app.post("/api/simulations/run")
    async def run_simulations(body: SimulationRequest) -> dict[str, Any]:
        # Only the free scripted run is offered from the browser; --live is a CLI choice.
        return await run_all(live=False, only=body.only, store=store)

    @app.get("/api/faults")
    async def get_faults() -> dict[str, Any]:
        st = crm_app.state.crm
        return {"fault": st.fault.model_dump(), "remaining": st.fault_remaining,
                "recent": st.requests[-20:]}

    @app.put("/api/faults")
    async def set_faults(fault: FaultConfig) -> dict[str, Any]:
        st = crm_app.state.crm
        st.fault, st.fault_remaining = fault, fault.count
        return {"fault": fault.model_dump(), "remaining": fault.count}

    @app.post("/api/webhooks/receiver")
    async def receiver(request: Request) -> dict[str, Any]:
        body = await request.body()
        ok = verify(cfg.webhook_secret, request.headers.get("X-Webhook-Timestamp", ""), body,
                    request.headers.get("X-Webhook-Signature", ""))
        duplicate = store.record_received(request.headers.get("Idempotency-Key"), ok,
                                          body.decode(errors="replace"))
        if not ok:
            raise HTTPException(401, "bad signature")
        return {"accepted": True, "duplicate": duplicate}

    @app.get("/api/webhooks")
    async def webhooks() -> dict[str, Any]:
        return {"received": store.received(), "outbox": store.outbox()}

    if WEB_DIST.exists():
        app.mount("/assets", StaticFiles(directory=WEB_DIST / "assets"), name="assets")

        @app.get("/{path:path}", include_in_schema=False)
        async def spa(path: str) -> FileResponse:
            candidate = (WEB_DIST / path).resolve()
            if path and candidate.is_file() and WEB_DIST.resolve() in candidate.parents:
                return FileResponse(candidate)
            return FileResponse(WEB_DIST / "index.html")

    return app
