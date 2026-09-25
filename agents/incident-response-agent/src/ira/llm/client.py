import contextvars
import logging
import os
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Protocol, TypeVar

# isort: off
import src.ira.config  # noqa: F401 - must precede litellm: disables its .env auto-loading
import litellm
from litellm import acompletion
# isort: on
from litellm.exceptions import (
    APIConnectionError,
    BadGatewayError,
    InternalServerError,
    RateLimitError,
    ServiceUnavailableError,
    Timeout,
)
from pydantic import BaseModel, ValidationError

from src.ira.config import Settings, settings
from src.ira.observability.metrics import LLM_COST, LLM_ERRORS, LLM_FALLBACKS

logger = logging.getLogger(__name__)

# Enable tracing if Langfuse is configured
if os.getenv("LANGFUSE_PUBLIC_KEY") and os.getenv("LANGFUSE_SECRET_KEY"):
    litellm.success_callback = ["langfuse"]
    litellm.failure_callback = ["langfuse"]

T = TypeVar("T", bound=BaseModel)

# Provider errors worth retrying on a different model. Anything else (bad request, auth,
# content policy, schema problems) is a real failure and must surface to the caller.
_TRANSIENT_ERRORS: tuple[type[Exception], ...] = (
    APIConnectionError,
    Timeout,
    RateLimitError,
    ServiceUnavailableError,
    InternalServerError,
    BadGatewayError,
)


class LLMError(RuntimeError):
    """An LLM call failed or returned output that could not be validated."""


@dataclass
class CostMeter:
    usd: float = 0.0


_cost_meter: contextvars.ContextVar[CostMeter | None] = contextvars.ContextVar(
    "ira_cost_meter", default=None
)


@contextmanager
def track_cost() -> Iterator[CostMeter]:
    """Accumulate the USD cost of every LLM call made inside the block."""
    meter = CostMeter()
    token = _cost_meter.set(meter)
    try:
        yield meter
    finally:
        _cost_meter.reset(token)


class LLM(Protocol):
    """What agents depend on; lets tests substitute a scripted fake."""

    async def text(
        self, role: str, messages: list[dict[str, str]], *, model: str | None = None,
        allow_fallback: bool = True,
    ) -> str: ...

    async def structured(
        self, role: str, messages: list[dict[str, str]], schema: type[T]
    ) -> T: ...


def provider_kwargs(model: str, config: Settings = settings) -> dict[str, Any]:
    """Per-call routing/credentials (no litellm/os globals). Gemini models go direct when
    GEMINI_API_KEY is set; everything else goes through the LiteLLM proxy, where the model
    name is a proxy alias."""
    if model.startswith("gemini/") and config.gemini_api_key:
        return {"api_key": config.gemini_api_key}
    return {
        "custom_llm_provider": "litellm_proxy",
        "api_base": config.litellm_api_base,
        "api_key": config.litellm_master_key,
    }


class LLMClient:
    def __init__(self, config: Settings = settings):
        self.config = config
        self.model_mapping = config.role_models

    def _provider_kwargs(self, model: str) -> dict[str, Any]:
        return provider_kwargs(model, self.config)

    async def _complete(
        self, model: str, messages: list[dict[str, str]], role: str = "utility", **kwargs: Any
    ) -> Any:
        response = await acompletion(
            model=model,
            messages=messages,
            timeout=self.config.llm_timeout_s,
            **self._provider_kwargs(model),
            **kwargs,
        )
        try:
            cost = float(litellm.completion_cost(completion_response=response))
        except Exception:  # noqa: BLE001 - unknown pricing must not fail the call
            logger.debug("No cost data for model %s", model)
            cost = 0.0
        LLM_COST.labels(agent=role, model=model).inc(cost)
        meter = _cost_meter.get()
        if meter is not None:
            meter.usd += cost
        return response

    async def generate(
        self, role: str, messages: list[dict[str, str]], *, model: str | None = None,
        allow_fallback: bool = True, **kwargs: Any,
    ) -> Any:
        """Completion routed by role. Falls back to `model_fallback` only on transient
        provider errors, and never when the caller pinned a specific model."""
        pinned = model is not None
        chosen = model or self.model_mapping.get(role, self.model_mapping["utility"])
        try:
            return await self._complete(chosen, messages, role, **kwargs)
        except _TRANSIENT_ERRORS as e:
            fallback = self.config.model_fallback
            if pinned or not allow_fallback or fallback == chosen:
                LLM_ERRORS.labels(agent=role).inc()
                raise LLMError(f"{chosen} failed for role {role}: {e}") from e
            logger.warning("%s failed for role %s (%s); retrying on %s", chosen, role, e, fallback)
            LLM_FALLBACKS.labels(from_model=chosen, to_model=fallback).inc()
            try:
                return await self._complete(fallback, messages, role, **kwargs)
            except Exception as e2:
                LLM_ERRORS.labels(agent=role).inc()
                raise LLMError(f"Fallback {fallback} failed for role {role}: {e2}") from e2
        except Exception as e:
            LLM_ERRORS.labels(agent=role).inc()
            raise LLMError(f"{chosen} failed for role {role}: {e}") from e

    async def text(
        self, role: str, messages: list[dict[str, str]], *, model: str | None = None,
        allow_fallback: bool = True,
    ) -> str:
        response = await self.generate(role, messages, model=model, allow_fallback=allow_fallback)
        content = response.choices[0].message.content
        if not content:
            raise LLMError(f"Empty response for role {role}")
        return str(content)

    async def structured(
        self, role: str, messages: list[dict[str, str]], schema: type[T]
    ) -> T:
        """Schema-enforced JSON output, validated with Pydantic. One repair attempt is made
        with the validation error; after that the failure is raised, never papered over."""
        msgs = list(messages)
        last_error: Exception | None = None
        for _ in range(2):
            response = await self.generate(role, msgs, response_format=schema)
            content = response.choices[0].message.content or ""
            try:
                return schema.model_validate_json(content)
            except ValidationError as e:
                last_error = e
                msgs = [
                    *messages,
                    {"role": "assistant", "content": content},
                    {
                        "role": "user",
                        "content": "Your output did not match the required JSON schema:\n"
                        f"{e}\nReturn only corrected JSON matching the schema.",
                    },
                ]
        raise LLMError(f"Invalid {schema.__name__} from role {role}: {last_error}")
