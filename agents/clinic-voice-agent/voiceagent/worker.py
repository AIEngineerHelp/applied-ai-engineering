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
from typing import Any

from livekit import rtc
from livekit.agents import AgentServer, JobContext, JobProcess, cli

from .agent import ClinicAgent, speak
from .call import CallState, run_pre_call
from .config import settings
from .crm.client import CRMClient
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


def caller_details(ctx: JobContext, participant: rtc.RemoteParticipant) -> tuple[str, str | None,
                                                                               str | None]:
    """(source, caller phone, requested pipeline) from a SIP caller or the dashboard."""
    if participant.kind == rtc.ParticipantKind.PARTICIPANT_KIND_SIP:
        return "sip", participant.attributes.get("sip.phoneNumber"), None
    try:
        meta: dict[str, Any] = json.loads(ctx.job.metadata or "{}")
    except ValueError:
        meta = {}
    return "browser", meta.get("caller_phone") or None, meta.get("pipeline")


@server.rtc_session(agent_name=settings().agent_name)
async def entrypoint(ctx: JobContext) -> None:
    cfg = settings()
    workflow = default_workflow()
    await ctx.connect()
    participant = await ctx.wait_for_participant()
    source, phone, requested = caller_details(ctx, participant)
    pipeline = requested if requested in ("realtime", "cascade") else cfg.voice_pipeline

    store = CallStore()
    crm = CRMClient(cfg.crm_url, cfg.crm_api_key)
    state = CallState(
        call_id=ctx.room.name,  # the dashboard knows the room, so it can open the trace
        workflow=workflow, crm=crm, kb=ctx.proc.userdata.get("kb") or KnowledgeBase(),
        store=store, source=source, pipeline=pipeline, models=models_for(pipeline, cfg),
        caller_phone=phone)
    state.event("call_started", room=ctx.room.name, participant=participant.identity)

    greeting = await run_pre_call(state)
    try:
        session = build_session(pipeline, cfg, vad=ctx.proc.userdata.get("vad"))
    except Exception as exc:  # e.g. no API key: record the failed call, then leave
        log.exception("could not build the %s pipeline", pipeline)
        await finish_call(state, error=f"{type(exc).__name__}: {exc}", deliver=False)
        await crm.aclose()
        ctx.shutdown(reason="pipeline unavailable")
        return
    session.userdata = state
    closed = attach_recorder(session, state)

    async def time_limit() -> None:
        await asyncio.sleep(workflow.in_call.max_call_seconds)
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
                              use_llm=bool(cfg.gemini_api_key))
        finally:
            await crm.aclose()

    ctx.add_shutdown_callback(on_shutdown)
    await session.start(agent=ClinicAgent(state, greeting), room=ctx.room)
    await closed["event"].wait()
    ctx.shutdown(reason=closed["reason"] or "session closed")


if __name__ == "__main__":
    cli.run_app(server)
