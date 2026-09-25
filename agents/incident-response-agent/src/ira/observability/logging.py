import json
import logging
import re
import sys
from datetime import UTC, datetime
from typing import Any

from src.ira.config import Settings

# Secrets must never reach logs.
_REDACTIONS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"(?i)(bearer\s+)[A-Za-z0-9\-._~+/]+=*"), r"\1[REDACTED]"),
    (re.compile(r"(?i)((?:api[_-]?key|token|secret|password|passwd)[\"']?\s*[:=]\s*[\"']?)"
                r"[^\s\"',;&]+"), r"\1[REDACTED]"),
    (re.compile(r"(\w+://[^:/\s]+:)[^@\s]+(@)"), r"\1[REDACTED]\2"),  # DSN passwords
    (re.compile(r"\bsk-[A-Za-z0-9\-_]{8,}"), "sk-[REDACTED]"),
    (re.compile(r"\bAIza[0-9A-Za-z\-_]{20,}"), "AIza[REDACTED]"),
    (re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+"), "[JWT REDACTED]"),
]


def redact(text: str) -> str:
    for pattern, repl in _REDACTIONS:
        text = pattern.sub(repl, text)
    return text


class RedactingFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        redacted = redact(message)
        if redacted != message:
            record.msg, record.args = redacted, None
        if record.exc_info and not record.exc_text:
            record.exc_text = redact(logging.Formatter().formatException(record.exc_info))
        return True


class JsonFormatter(logging.Formatter):
    _EXTRA_KEYS = ("incident_id", "node", "tool", "action_id", "request_id")

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": datetime.fromtimestamp(record.created, UTC).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        for key in self._EXTRA_KEYS:
            if hasattr(record, key):
                payload[key] = getattr(record, key)
        if record.exc_text or record.exc_info:
            payload["exc"] = record.exc_text or self.formatException(record.exc_info)  # type: ignore[arg-type]
        return json.dumps(payload, default=str)


def configure_logging(config: Settings) -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.addFilter(RedactingFilter())
    handler.setFormatter(
        JsonFormatter() if config.log_format == "json"
        else logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
    )
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(config.log_level)
    # LiteLLM logs full request payloads at INFO.
    for noisy in ("LiteLLM", "litellm", "httpx", "openai"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    # Presidio warns once per non-English recognizer at startup.
    logging.getLogger("presidio-analyzer").setLevel(logging.ERROR)
