from __future__ import annotations

import threading
from typing import Any

from app.config import get_settings

_agent = None
_lock = threading.Lock()
_load_error: str | None = None


def laya_status() -> str:
    if not get_settings().laya_enabled:
        return "disabled"
    if _load_error:
        return f"error: {_load_error}"
    if _agent is not None:
        return "ready"
    return "not_loaded"


def get_laya_agent():
    global _agent, _load_error
    settings = get_settings()
    if not settings.laya_enabled:
        raise RuntimeError("Laya is disabled via LAYA_ENABLED=false")
    if _agent is not None:
        return _agent
    with _lock:
        if _agent is not None:
            return _agent
        try:
            import laya

            _agent = laya.load(settings.laya_model, device=settings.laya_device)
            _load_error = None
            return _agent
        except Exception as exc:  # noqa: BLE001
            _load_error = str(exc)
            raise


def decide_with_laya(state: Any, questions: dict[str, Any]) -> dict[str, Any]:
    import laya

    agent = get_laya_agent()
    answers = laya.decide(agent, state, questions=questions)
    # Normalize to plain dicts
    out: dict[str, Any] = {}
    for k, v in (answers or {}).items():
        if hasattr(v, "model_dump"):
            out[k] = v.model_dump()
        elif isinstance(v, dict):
            out[k] = v
        else:
            out[k] = dict(v) if hasattr(v, "items") else {"value": v}
    return out
