"""The LiveKit agent worker: one job per call.

    uv run python -m voiceagent.worker dev     # connects to LIVEKIT_URL and waits for calls

A call arrives as a LiveKit room with this agent dispatched to it, from the dashboard
(a browser caller) or from a SIP trunk (a phone caller). For each call the job runs the
workflow in order: pre-call lookup, the conversation with in-call tools and guards, then
post-call extraction and the webhook.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from datetime import datetime
from typing import Any

import httpx
from livekit import rtc
from livekit.agents import AgentServer, JobContext, JobProcess, cli

from . import telemetry
from .agent import ClinicAgent, speak
from .call import CallState, run_pre_call
from .config import settings
from .crm.client import CRMClient
from .crm.server import TZ, CRMState, FaultConfig, create_app
from .kb import KnowledgeBase
from .postcall import finish_call
from .session import attach_recorder, build_session, models_for
from .store import CallStore
from .workflow import default_workflow

log = logging.getLogger("clinic-agent")

# LiveKit's worker and LiveKit Inference read these from the environment; fill them from
# settings so the .env defaults apply (job processes re-import this module).
for _key, _value in {
    "LIVEKIT_URL": settings().livekit_url,
    "LIVEKIT_API_KEY": settings().livekit_api_key,
    "LIVEKIT_API_SECRET": settings().livekit_api_secret,
}.items():
    os.environ.setdefault(_key, _value)

server = AgentServer()


def prewarm(proc: JobProcess) -> None:
    from livekit.plugins import silero

    proc.userdata["vad"] = silero.VAD.load()
    proc.userdata["kb"] = KnowledgeBase()


server.setup_fnc = prewarm


def caller_details(ctx: JobContext, participant: rtc.RemoteParticipant
                   ) -> tuple[str, str | None, dict[str, Any]]:
    """(source, caller phone, dispatch metadata) from a SIP caller or the dashboard."""
    if participant.kind == rtc.ParticipantKind.PARTICIPANT_KIND_SIP:
        return "sip", participant.attributes.get("sip.phoneNumber"), {}
    try:
        meta: dict[str, Any] = json.loads(ctx.job.metadata or "{}")
    except ValueError:
        meta = {}
    return "browser", meta.get("caller_phone") or None, meta


FAULT_ATTRIBUTE = "crm.fault"  # set by the caller's browser to break the embedded CRM


def apply_fault(crm_state: CRMState, raw: Any) -> FaultConfig | None:
    """Set the embedded CRM's fault from the browser's JSON. Bad input leaves it alone."""
    try:
        fault = FaultConfig.model_validate(json.loads(raw) if isinstance(raw, str) else raw)
    except (ValueError, TypeError):
        return None
    fault.latency_ms = min(fault.latency_ms, 5000)  # a visitor cannot hang the call
    crm_state.fault = fault
    crm_state.fault_remaining = fault.count
    return fault


def crm_for_call(meta: dict[str, Any], phone: str | None) -> tuple[CRMClient, CRMState | None]:
    """The CRM this call talks to: the shared mock CRM served by `serve`, or, when hosted, a
    fresh in-process one with the caller registered from the dispatch metadata."""
    cfg = settings()
    if cfg.crm_mode != "embedded":
        return CRMClient(cfg.crm_url, cfg.crm_api_key), None
    crm_state = CRMState(today=datetime.now(TZ).date())
    name = " ".join(str(meta.get("caller_name") or "").split())[:60]
    if name and phone:
        first, _, last = name.partition(" ")
        crm_state.register(first, last, phone)
    if meta.get("crm_fault"):
        apply_fault(crm_state, meta["crm_fault"])
    app = create_app(crm_state, cfg.crm_api_key)
    return CRMClient("http://crm.local", cfg.crm_api_key,
                     transport=httpx.ASGITransport(app=app)), crm_state


def stream_events(ctx: JobContext, state: CallState) -> None:
    """Send each call-log event to the room, so the caller's browser draws the trace live."""
    def send(kind: str, at: float, data: dict[str, Any]) -> None:
        if kind in ("metric", "usage"):
            return
        payload = json.dumps({"kind": kind, "at": round(at, 3), "data": data}, default=str)

        async def publish() -> None:
            try:
                await ctx.room.local_participant.publish_data(
                    payload, reliable=True, topic="clinic.events")
            except Exception:  # the caller may have left; the call log still has it
                pass

        try:
            asyncio.get_running_loop().create_task(publish())
        except RuntimeError:
            pass

    state.on_event = send


@server.rtc_session(agent_name=settings().agent_name)
async def entrypoint(ctx: JobContext) -> None:
    cfg = settings()
    telemetry.setup()
    workflow = default_workflow()
    await ctx.connect()
    participant = await ctx.wait_for_participant()
    source, phone, meta = caller_details(ctx, participant)
    requested = meta.get("pipeline")
    pipeline = requested if requested in ("realtime", "cascade") else cfg.voice_pipeline

    store = CallStore()
    crm, crm_state = crm_for_call(meta, phone)
    state = CallState(
        call_id=ctx.room.name,  # the dashboard knows the room, so it can open the trace
        workflow=workflow, crm=crm, kb=ctx.proc.userdata.get("kb") or KnowledgeBase(),
        store=store, source=source, pipeline=pipeline, models=models_for(pipeline, cfg),
        caller_phone=phone)
    stream_events(ctx, state)
    state.event("call_started", room=ctx.room.name, participant=participant.identity)
    if crm_state is not None:
        @ctx.room.on("participant_attributes_changed")
        def _fault(changed: dict[str, str], who: rtc.Participant) -> None:
            if who.identity == participant.identity and FAULT_ATTRIBUTE in changed:
                fault = apply_fault(crm_state, changed[FAULT_ATTRIBUTE])
                if fault is not None:
                    state.event("crm_fault", mode=fault.mode, count=fault.count,
                                path_prefix=fault.path_prefix)
    # The call's root span is current from here, so LiveKit's session spans nest under it.
    telemetry.attach(state)

    greeting = await run_pre_call(state)
    try:
        session = build_session(pipeline, cfg, vad=ctx.proc.userdata.get("vad"))
    except Exception as exc:  # e.g. no API key: record the failed call, then leave
        log.exception("could not build the %s pipeline", pipeline)
        await finish_call(state, error=f"{type(exc).__name__}: {exc}", deliver=False)
        await crm.aclose()
        telemetry.flush()
        ctx.shutdown(reason="pipeline unavailable")
        return
    session.userdata = state
    closed = attach_recorder(session, state)

    async def time_limit() -> None:
        await asyncio.sleep(cfg.max_call_seconds or workflow.in_call.max_call_seconds)
        closed["reason"] = "timed_out"
        handle = speak(session, "We've reached the time limit for this call. Please call back"
                       " if you need anything else. Goodbye.")
        await handle.wait_for_playout()
        session.shutdown(drain=True)

    limiter = asyncio.create_task(time_limit())

    async def on_shutdown() -> None:
        limiter.cancel()
        try:
            await finish_call(state, close_reason=closed["reason"], error=closed["error"],
                              use_llm=bool(cfg.gemini_api_key), deliver=cfg.deliver_webhooks)
        finally:
            await crm.aclose()
            telemetry.flush()

    ctx.add_shutdown_callback(on_shutdown)
    await session.start(agent=ClinicAgent(state, greeting), room=ctx.room)
    await closed["event"].wait()
    ctx.shutdown(reason=closed["reason"] or "session closed")


if __name__ == "__main__":
    cli.run_app(server)
