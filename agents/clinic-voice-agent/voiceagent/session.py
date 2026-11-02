"""Builds the voice pipeline and records what happens on the call.

Two pipelines, chosen per call:
  realtime  Gemini Live hears audio and speaks audio in one model. Fewest hops, and it
            hears tone, but STT and TTS cannot be chosen separately.
  cascade   STT -> LLM -> TTS as three services, each replaceable and measured on its own.
            STT runs on LiveKit Inference (needs a LiveKit Cloud project), LLM and TTS on
            Gemini with the same key.
"""

from __future__ import annotations

import asyncio
from typing import Any

from livekit.agents import AgentSession, llm
from livekit.agents.voice.events import (
    CloseEvent,
    ConversationItemAddedEvent,
    SessionUsageUpdatedEvent,
    UserInputTranscribedEvent,
)

from .agent import run_guards
from .call import CallState
from .config import Settings


def models_for(pipeline: str, cfg: Settings) -> dict[str, str]:
    if pipeline == "realtime":
        return {"stt": "built-in", "llm": cfg.realtime_model, "tts": "built-in"}
    if pipeline == "cascade":
        return {"stt": cfg.cascade_stt, "llm": cfg.cascade_llm, "tts": cfg.cascade_tts}
    return {"stt": "text", "llm": "scripted", "tts": "text"}


def build_session(pipeline: str, cfg: Settings, vad: Any = None) -> AgentSession[CallState]:
    from livekit.plugins import google, silero

    if pipeline == "realtime":
        # Gemini decides when the caller's turn ends. The local VAD only marks when they
        # stopped speaking, which LiveKit needs to time the reply (e2e_latency). Without it
        # AgentSession falls back to LiveKit Inference's hosted VAD, which a local server
        # does not have, and realtime calls record no reply latency at all.
        return AgentSession(
            llm=google.realtime.RealtimeModel(
                model=cfg.realtime_model, voice=cfg.realtime_voice, api_key=cfg.gemini_api_key,
                temperature=0.6),
            vad=vad or silero.VAD.load(),
        )
    from livekit.agents import inference

    return AgentSession(
        stt=inference.STT(model=cfg.cascade_stt, language="en"),
        llm=google.LLM(model=cfg.cascade_llm, api_key=cfg.gemini_api_key, temperature=0.4),
        tts=google.beta.GeminiTTS(model=cfg.cascade_tts, voice_name=cfg.cascade_tts_voice,
                                  api_key=cfg.gemini_api_key),
        vad=vad or silero.VAD.load(),
        turn_detection=inference.TurnDetector(),
    )


# Per-turn latency LiveKit attaches to each message. For a caller turn: how long the
# end-of-turn decision and the final transcript took. For an agent turn: time to the
# LLM's first token, to the TTS's first audio, and from the caller going quiet to the
# agent starting to speak (e2e), which is what the caller actually feels.
TURN_FIELDS = {
    "user": ("end_of_turn_delay", "transcription_delay", "on_user_turn_completed_delay"),
    "assistant": ("llm_node_ttft", "tts_node_ttfb", "e2e_latency"),
}


def attach_recorder(session: AgentSession[Any], state: CallState) -> dict[str, Any]:
    """Subscribe to session events and write them to the call log.

    Returns a dict that receives the close reason and error, read by the post-call step.
    """
    closed: dict[str, Any] = {"reason": None, "error": None, "event": asyncio.Event()}

    @session.on("conversation_item_added")
    def _item(ev: ConversationItemAddedEvent) -> None:
        item = ev.item
        if not isinstance(item, llm.ChatMessage) or item.role not in ("user", "assistant"):
            return
        text = item.text_content or ""
        if text:
            state.event("transcript", role=item.role, text=text, interrupted=item.interrupted)
        metrics = {k: round(float(v) * 1000, 1) for k, v in item.metrics.items()
                   if k in TURN_FIELDS[item.role] and isinstance(v, (int, float))}
        if metrics:
            state.event("turn_metrics", role=item.role, **metrics)

    @session.on("session_usage_updated")
    def _usage(ev: SessionUsageUpdatedEvent) -> None:
        state.meter.from_session_usage(ev.usage, state.models)

    @session.on("user_input_transcribed")
    def _transcribed(ev: UserInputTranscribedEvent) -> None:
        # A realtime model starts answering on its own; this catches an emergency phrase
        # from its transcript and interrupts. The cascade path checks before the LLM runs.
        if ev.is_final and isinstance(session.llm, llm.RealtimeModel):
            asyncio.get_running_loop().create_task(run_guards(session, state, ev.transcript))

    @session.on("error")
    def _error(ev: Any) -> None:
        state.event("error", where=type(ev.source).__name__ if ev.source else "session",
                    error=str(getattr(ev.error, "error", ev.error))[:300],
                    recoverable=getattr(ev.error, "recoverable", None))

    @session.on("close")
    def _close(ev: CloseEvent) -> None:
        closed["reason"] = closed["reason"] or ev.reason.value
        closed["error"] = str(ev.error.error)[:300] if ev.error else None
        state.event("close", reason=closed["reason"], error=closed["error"])
        closed["event"].set()

    return closed
