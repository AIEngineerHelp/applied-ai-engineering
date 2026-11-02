"""Settings from the environment (and `.env`). Defaults run everything on one machine."""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from .workflow import ROOT


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ROOT / ".env", extra="ignore")

    gemini_api_key: str = Field(default="", validation_alias=AliasChoices(
        "GEMINI_API_KEY", "GOOGLE_API_KEY"))

    livekit_url: str = "ws://127.0.0.1:7880"
    livekit_api_key: str = "devkey"
    livekit_api_secret: str = "secret"
    agent_name: str = "clinic-agent"

    voice_pipeline: Literal["realtime", "cascade"] = "realtime"
    realtime_model: str = "gemini-3.8-live"
    realtime_voice: str = "Puck"
    cascade_stt: str = "deepgram/nova-3"
    cascade_llm: str = "gemini-3.8-flash"
    cascade_tts: str = "gemini-3.1-flash-tts-preview"
    cascade_tts_voice: str = "Kore"
    extraction_model: str = "gemini-3.8-flash"
    caller_model: str = "gemini-3.8-flash"  # plays the caller in live simulations

    # "service": the worker calls the mock CRM served by `serve` (local runs, the fault
    # switch on the dashboard). "embedded": each call gets its own in-process mock CRM, so a
    # hosted worker needs nothing else; the caller's browser sends the fault switch.
    crm_mode: Literal["service", "embedded"] = "service"
    deliver_webhooks: bool = True
    max_call_seconds: int | None = None  # overrides workflow/clinic.yaml, e.g. 180 when hosted

    crm_url: str = "http://127.0.0.1:4331/crm"
    crm_api_key: str = "dev-crm-key"
    webhook_url: str = "http://127.0.0.1:4331/api/webhooks/receiver"
    webhook_secret: str = "dev-webhook-secret"

    # OpenTelemetry export (voiceagent/telemetry.py). Off while the endpoint is empty; the
    # OTLP exporter also reads OTEL_EXPORTER_OTLP_HEADERS for a backend's auth.
    otel_exporter_otlp_endpoint: str = ""
    trace_content: bool = False  # send transcripts, phone numbers and tool payloads too
    trace_ui_url: str = ""  # e.g. http://127.0.0.1:16686/trace/{trace_id} for Jaeger

    host: str = "127.0.0.1"
    port: int = 4331


@lru_cache(maxsize=1)
def settings() -> Settings:
    return Settings()
