"""The CRM client the agent calls from its tools.

A caller is waiting on the line, so this client trades completeness for a bounded
wait: a short timeout per attempt, a small number of retries with jittered backoff,
a hard budget for the whole operation, and one idempotency key reused across the
retries of a write so a retried booking can never book twice. Every attempt is
recorded so a bad call can be debugged from its trace.
"""

from __future__ import annotations

import asyncio
import random
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import httpx
from pydantic import BaseModel, ValidationError


class Patient(BaseModel):
    id: str
    first_name: str
    last_name: str
    phone: str
    date_of_birth: str
    primary_provider: str


class Slot(BaseModel):
    id: str
    provider_id: str
    provider_name: str
    start: str
    duration_minutes: int


class Appointment(BaseModel):
    id: str
    patient_id: str
    slot_id: str
    provider_id: str
    provider_name: str
    start: str
    reason: str
    status: str


class CRMError(Exception):
    """A failure the agent should explain to the caller, with a stable kind for traces."""

    def __init__(self, kind: str, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.kind = kind
        self.status = status


RETRYABLE_STATUS = {429, 500, 502, 503, 504}


@dataclass
class Attempt:
    method: str
    path: str
    attempt: int
    status: int | None
    outcome: str
    ms: float
    idempotency_key: str | None = None


@dataclass
class RetryPolicy:
    attempt_timeout: float = 2.0
    max_attempts: int = 3
    budget_seconds: float = 6.0
    base_backoff: float = 0.25
    max_backoff: float = 1.5


@dataclass
class CRMClient:
    base_url: str
    api_key: str
    policy: RetryPolicy = field(default_factory=RetryPolicy)
    transport: httpx.AsyncBaseTransport | None = None
    on_attempt: Callable[[Attempt], None] | None = None
    sleep: Callable[[float], Any] = asyncio.sleep

    def __post_init__(self) -> None:
        self._http = httpx.AsyncClient(
            base_url=self.base_url,
            transport=self.transport,
            headers={"Authorization": f"Bearer {self.api_key}"},
        )
        self._rng = random.Random()

    async def aclose(self) -> None:
        await self._http.aclose()

    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json: dict[str, Any] | None = None,
        idempotent_write: bool = False,
        budget: float | None = None,
    ) -> dict[str, Any]:
        policy = self.policy
        deadline = time.monotonic() + (budget if budget is not None else policy.budget_seconds)
        key = str(uuid.uuid4()) if idempotent_write else None
        headers = {"Idempotency-Key": key} if key else {}
        last: CRMError | None = None
        for attempt in range(1, policy.max_attempts + 1):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            started = time.monotonic()
            status: int | None = None
            timeout = min(policy.attempt_timeout, remaining)
            try:
                # asyncio.timeout as well as httpx's: the in-process transport used in
                # simulation ignores httpx timeouts.
                async with asyncio.timeout(timeout):
                    response = await self._http.request(
                        method, path, params=params, json=json, headers=headers, timeout=timeout,
                    )
                status = response.status_code
                if status < 400:
                    self._record(method, path, attempt, status, "ok", started, key)
                    body = response.json()
                    if not isinstance(body, dict):
                        raise CRMError("bad_data", "CRM returned a non-object body", status)
                    return body
                if status in RETRYABLE_STATUS:
                    last = CRMError("unavailable", f"CRM returned {status}", status)
                    self._record(method, path, attempt, status, "retryable", started, key)
                    wait = self._backoff(attempt, response.headers.get("Retry-After"))
                else:
                    detail = _detail(response)
                    self._record(method, path, attempt, status, "rejected", started, key)
                    kind = {401: "auth", 404: "not_found", 409: "conflict"}.get(status, "rejected")
                    raise CRMError(kind, detail, status)
            except (httpx.TimeoutException, TimeoutError):
                last = CRMError("timeout", "CRM did not answer in time")
                self._record(method, path, attempt, None, "timeout", started, key)
                wait = self._backoff(attempt, None)
            except httpx.TransportError as exc:
                last = CRMError("unavailable", f"CRM unreachable: {type(exc).__name__}")
                self._record(method, path, attempt, None, "transport_error", started, key)
                wait = self._backoff(attempt, None)
            if attempt == policy.max_attempts or time.monotonic() + wait >= deadline:
                break
            await self.sleep(wait)
        raise last or CRMError("timeout", "CRM call budget exhausted")

    def _backoff(self, attempt: int, retry_after: str | None) -> float:
        if retry_after:
            try:
                return min(float(retry_after), self.policy.max_backoff)
            except ValueError:
                pass
        cap = min(self.policy.max_backoff, self.policy.base_backoff * 2 ** (attempt - 1))
        return self._rng.uniform(0, cap)  # full jitter

    def _record(self, method: str, path: str, attempt: int, status: int | None, outcome: str,
                started: float, key: str | None) -> None:
        if self.on_attempt:
            self.on_attempt(Attempt(method, path, attempt, status, outcome,
                                    round((time.monotonic() - started) * 1000, 1), key))

    # -- typed operations ------------------------------------------------------------

    async def find_patient(self, phone: str, *, budget: float | None = None) -> Patient | None:
        body = await self._request("GET", "/patients", params={"phone": phone}, budget=budget)
        rows = _validate_list(body, Patient)
        return rows[0] if rows else None

    async def upcoming_appointments(
        self, patient_id: str, *, budget: float | None = None
    ) -> list[Appointment]:
        body = await self._request("GET", f"/patients/{patient_id}/appointments", budget=budget)
        return _validate_list(body, Appointment)

    async def open_slots(
        self, *, on: str | None = None, provider_id: str | None = None, want: int = 4,
        max_pages: int = 3,
    ) -> list[Slot]:
        """Follow the cursor until `want` slots are found or `max_pages` are read: a voice
        caller needs a few good options, not the whole calendar."""
        slots: list[Slot] = []
        cursor: str | None = None
        for _ in range(max_pages):
            params: dict[str, Any] = {"limit": 8}
            if on:
                params["on"] = on
            if provider_id:
                params["provider_id"] = provider_id
            if cursor:
                params["cursor"] = cursor
            body = await self._request("GET", "/slots", params=params)
            slots.extend(_validate_list(body, Slot))
            cursor = body.get("next_cursor")
            if len(slots) >= want or not cursor:
                break
        return slots[:want]

    async def book(self, patient_id: str, slot_id: str, reason: str) -> Appointment:
        body = await self._request(
            "POST", "/appointments", idempotent_write=True,
            json={"patient_id": patient_id, "slot_id": slot_id, "reason": reason},
        )
        return _validate_one(body, Appointment)

    async def reschedule(self, appointment_id: str, slot_id: str) -> Appointment:
        body = await self._request(
            "PATCH", f"/appointments/{appointment_id}", idempotent_write=True,
            json={"slot_id": slot_id},
        )
        return _validate_one(body, Appointment)

    async def cancel(self, appointment_id: str) -> Appointment:
        body = await self._request("DELETE", f"/appointments/{appointment_id}",
                                   idempotent_write=True)
        return _validate_one(body, Appointment)


def _detail(response: httpx.Response) -> str:
    try:
        return str(response.json().get("detail", response.text))
    except ValueError:
        return response.text[:200]


def _validate_list[M: BaseModel](body: dict[str, Any], model: type[M]) -> list[M]:
    try:
        return [model.model_validate(row) for row in body.get("data", [])]
    except (ValidationError, TypeError) as exc:
        raise CRMError("bad_data", f"CRM returned a malformed {model.__name__}") from exc


def _validate_one[M: BaseModel](body: dict[str, Any], model: type[M]) -> M:
    try:
        return model.model_validate(body.get("data"))
    except ValidationError as exc:
        raise CRMError("bad_data", f"CRM returned a malformed {model.__name__}") from exc
