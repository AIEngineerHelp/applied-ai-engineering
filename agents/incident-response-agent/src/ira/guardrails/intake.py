from typing import Any

from src.ira.guardrails.pii import PIIScrubber, get_scrubber

# Structural fields used for routing/signatures; never free text, never scrubbed.
_PASSTHROUGH = {"source", "service", "environment", "severity", "external_id", "started_at"}


class IntakeGuardrail:
    def __init__(self, scrubber: PIIScrubber | None = None):
        self.scrubber = scrubber or get_scrubber()

    def validate_and_scrub(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Scrub PII from every free-text field of an incoming payload, including
        label values and the nested raw payload."""
        return {
            k: v if k in _PASSTHROUGH else self.scrubber.scrub_obj(v)
            for k, v in payload.items()
        }
