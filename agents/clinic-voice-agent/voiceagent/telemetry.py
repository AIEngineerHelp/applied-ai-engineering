"""OpenTelemetry export: each call as one trace, for Langfuse, Grafana, Datadog or Jaeger.

Off unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set (the standard OTLP variable, so any
backend that accepts OTLP over HTTP works). A call becomes one trace:

    call                                   our root span: who called, outcome, cost
    ├── crm GET /patients                  each CRM attempt, with retries and failures
    ├── pre_call                           the lookup's total time and outcome
    ├── agent_session                      LiveKit's own spans: turns, LLM, TTS, tools
    │   └── ... function_tool
    │       └── crm POST /appointments     each CRM attempt, inside the tool that made it
    ├── webhook                            post-call delivery attempts
    └── events: guard, transfer, post_call

The SQLite call log stays the dashboard's source; this sends the same story to a tracing
backend. The clinic's callers are patients, so conversation text, phone numbers, tool
arguments and summaries stay out of the export unless `TRACE_CONTENT=true`. LiveKit's
`allow_pii` applies the same choice to its spans.
"""

from __future__ import annotations

import time
from typing import TYPE_CHECKING, Any

from opentelemetry import context, trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import ReadableSpan, Span, SpanProcessor, TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor, SpanExporter
from opentelemetry.trace import Status, StatusCode

from .config import settings
from .export import CONTENT_FIELDS  # kept only with TRACE_CONTENT

if TYPE_CHECKING:
    from .call import CallState

SERVICE = "clinic-voice-agent"

_provider: TracerProvider | None = None
_tracer: trace.Tracer = trace.NoOpTracer()


class CallIdProcessor(SpanProcessor):
    """Stamps the call id on every span in a call's trace, LiveKit's included, so a backend
    can group and filter by call (Langfuse reads `session.id` and wants it on every span)."""

    def __init__(self) -> None:
        self.calls: dict[int, str] = {}

    def on_start(self, span: Span, parent_context: context.Context | None = None) -> None:
        call_id = self.calls.get(span.get_span_context().trace_id)
        if call_id:
            span.set_attribute("session.id", call_id)
            span.set_attribute("langfuse.session.id", call_id)

    def on_end(self, span: ReadableSpan) -> None:
        if span.name == "call" and span.context is not None:
            self.calls.pop(span.context.trace_id, None)


_call_ids = CallIdProcessor()


def setup(exporter: SpanExporter | None = None) -> TracerProvider | None:
    """Configure export once per process. Pass an exporter in tests; otherwise OTLP over
    HTTP reads OTEL_EXPORTER_OTLP_ENDPOINT and OTEL_EXPORTER_OTLP_HEADERS itself."""
    global _provider, _tracer
    if _provider is not None:
        return _provider
    if exporter is None:
        if not settings().otel_exporter_otlp_endpoint:
            return None
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

        exporter = OTLPSpanExporter()
    provider = TracerProvider(resource=Resource.create({"service.name": SERVICE}))
    provider.add_span_processor(_call_ids)
    provider.add_span_processor(BatchSpanProcessor(exporter))
    from livekit.agents.telemetry import set_tracer_provider

    set_tracer_provider(provider, allow_pii=settings().trace_content)
    _provider, _tracer = provider, provider.get_tracer("voiceagent")
    return provider


def enabled() -> bool:
    return _provider is not None


def flush() -> None:
    if _provider is not None:
        _provider.force_flush(timeout_millis=5000)


def _clean(data: dict[str, Any]) -> dict[str, Any]:
    """Flatten an event into span attributes: scalars only, content dropped unless allowed."""
    keep = settings().trace_content
    out: dict[str, Any] = {}
    for key, value in data.items():
        if value is None or (key in CONTENT_FIELDS and not keep):
            continue
        if isinstance(value, (str, bool, int, float)):
            out[key] = value
        elif isinstance(value, list) and all(isinstance(v, str) for v in value):
            out[key] = value
        else:
            out[key] = str(value)
    return out


def start_call(state: CallState) -> None:
    """Open the call's root span. `attach` makes it current, so LiveKit's session spans and
    anything else started in this task nest under it."""
    if not enabled():
        return
    attributes = {"call.id": state.call_id, "call.source": state.source,
                  "call.pipeline": state.pipeline, "clinic.name": state.workflow.clinic.name,
                  **{f"call.model.{k}": v for k, v in state.models.items()}}
    if state.scenario:
        attributes["call.scenario"] = state.scenario
    if state.caller_phone and settings().trace_content:
        attributes["call.caller_phone"] = state.caller_phone
    span = _tracer.start_span("call", attributes=attributes)
    _call_ids.calls[span.get_span_context().trace_id] = state.call_id
    _call_ids.on_start(span)  # type: ignore[arg-type]
    state.span = span
    state.event("trace", trace_id=format(span.get_span_context().trace_id, "032x"))


def attach(state: CallState) -> object | None:
    span = getattr(state, "span", None)
    return context.attach(trace.set_span_in_context(span)) if span is not None else None


def detach(token: object | None) -> None:
    if token is not None:
        context.detach(token)  # type: ignore[arg-type]


def _target(state: CallState) -> trace.Span:
    """The current span if it is open and belongs to this call (e.g. LiveKit's function_tool
    span, so a CRM attempt nests under the tool that made it); otherwise the root span.
    After the session closes, the current span can be LiveKit's ended session span."""
    root: trace.Span = state.span
    current = trace.get_current_span()
    same_call = current.get_span_context().trace_id == root.get_span_context().trace_id
    return current if same_call and current.is_recording() else root


def record(state: CallState, kind: str, data: dict[str, Any]) -> None:
    """Mirror one call-log event into the trace: a timed span where the event has a
    duration, a span event otherwise."""
    if getattr(state, "span", None) is None or kind in ("metric", "usage", "trace"):
        return
    attributes = _clean(data)
    if kind == "pre_call" and data.get("patient_id"):
        state.span.set_attribute("call.patient_id", data["patient_id"])
    if kind in ("crm_attempt", "pre_call", "webhook") and isinstance(data.get("ms"), (int, float)):
        end = time.time_ns()
        start = end - int(data["ms"] * 1_000_000)
        name = f"crm {data.get('method')} {data.get('path')}" if kind == "crm_attempt" else kind
        span = _tracer.start_span(name, context=trace.set_span_in_context(_target(state)),
                                  start_time=start,
                                  attributes={f"{kind}.{k}": v for k, v in attributes.items()})
        failed = (data.get("outcome") not in (None, "ok", "matched", "no_match")
                  or data.get("ok") is False)
        if failed:
            reason = str(data.get("outcome") or data.get("status"))
            span.set_status(Status(StatusCode.ERROR, reason))
        span.end(end_time=end)
        return
    if kind in ("transcript", "agent_say") and not settings().trace_content:
        return  # LiveKit's spans already time each turn; the words are content
    target = _target(state)
    target.add_event(kind, attributes=attributes)
    if kind == "tool" and str(data.get("outcome", "")).startswith("crm_"):
        # e.g. crm_bad_data: HTTP said 200, but the tool could not use what came back
        target.set_status(Status(StatusCode.ERROR, str(data["outcome"])))
    if kind == "guard":
        state.span.set_attribute("call.guard", str(data.get("name")))


def end_call(state: CallState, *, end_status: str, intent: str, cost_usd: float,
             duration_seconds: float) -> None:
    span = getattr(state, "span", None)
    if span is None:
        return
    span.set_attributes({"call.end_status": end_status, "call.intent": intent,
                         "call.cost_usd": cost_usd, "call.duration_seconds": duration_seconds,
                         "call.crm_degraded": state.crm_degraded})
    if state.transfer:
        span.set_attribute("call.transfer_to", state.transfer["destination"])
    if end_status == "error":
        span.set_status(Status(StatusCode.ERROR, "call ended in an error"))
    span.end()
    state.span = None
