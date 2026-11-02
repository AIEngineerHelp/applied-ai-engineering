"""OpenTelemetry export: one offline call becomes one trace, with LiveKit's spans and ours
under the call span, and no patient content unless TRACE_CONTENT is on."""

from __future__ import annotations

from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import StatusCode

from voiceagent import telemetry
from voiceagent.kb import KnowledgeBase
from voiceagent.simulation import load_scenarios, run_scenario

EXPORTER = InMemorySpanExporter()


async def test_a_call_exports_as_one_trace(store) -> None:  # type: ignore[no-untyped-def]
    telemetry.setup(EXPORTER)
    EXPORTER.clear()
    sc = next(s for s in load_scenarios() if s.name == "lost-response-no-double-booking")
    result = await run_scenario(sc, live=False, store=store, kb=KnowledgeBase())
    telemetry.flush()
    spans = EXPORTER.get_finished_spans()

    root = next(s for s in spans if s.name == "call")
    attrs = dict(root.attributes or {})
    assert attrs["call.id"] == result["call_id"]
    assert attrs["call.end_status"] == "resolved"
    assert attrs["call.patient_id"] == "pt_1003"
    assert "post_call" in [e.name for e in root.events]
    trace_id = root.context.trace_id
    in_call = [s for s in spans if s.context.trace_id == trace_id]
    assert len(in_call) == len(spans), "every span belongs to the call's trace"

    # LiveKit's own spans nest in the same trace, stamped with the call id.
    session = next(s for s in in_call if s.name == "agent_session")
    assert dict(session.attributes or {})["session.id"] == result["call_id"]

    # The lost response: one timed-out POST, marked as an error, then the replayed retry.
    posts = [s for s in in_call if s.name == "crm POST /appointments"]
    assert [s.status.status_code for s in posts] == [StatusCode.ERROR, StatusCode.UNSET]
    keys = {dict(s.attributes or {})["crm_attempt.idempotency_key"] for s in posts}
    assert len(keys) == 1, "the retry reuses the idempotency key"

    # The trace id is in the call log, so the dashboard can link to the trace.
    call = store.get_call(result["call_id"])
    logged = next(e for e in call["events"] if e["kind"] == "trace")
    assert logged["data"]["trace_id"] == format(trace_id, "032x")

    # Content stays out by default: no transcript words or phone numbers in any attribute.
    said = [t["text"] for t in result["transcript"]]
    for span in in_call:
        values = [str(v) for v in (span.attributes or {}).values()]
        values += [str(v) for e in span.events for v in (e.attributes or {}).values()]
        assert sc.phone not in " ".join(values)
        assert not any(line in v for line in said for v in values if len(line) > 20)
