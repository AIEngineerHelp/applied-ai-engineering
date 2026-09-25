import logging
import os
from typing import Any

from opentelemetry import trace

logger = logging.getLogger(__name__)
tracer = trace.get_tracer("ira")


def configure_tracing(service_name: str, app: Any = None) -> None:
    """Export traces via OTLP/HTTP when OTEL_EXPORTER_OTLP_ENDPOINT is set; otherwise the
    no-op tracer is used and spans cost nothing."""
    if not os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT"):
        return
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor

    provider = TracerProvider(resource=Resource.create({"service.name": service_name}))
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
    trace.set_tracer_provider(provider)
    if app is not None:
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

        FastAPIInstrumentor.instrument_app(app, excluded_urls="health/.*,metrics")
    logger.info("OpenTelemetry tracing enabled for %s", service_name)
