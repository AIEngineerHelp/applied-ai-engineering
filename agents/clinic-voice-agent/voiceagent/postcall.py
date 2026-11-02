"""After the call: build the record, write it to the log, and deliver it by webhook.

Facts come from what the tools actually did, not from reading the transcript back: if
`book_appointment` succeeded, the appointment id is known exactly. The model is used only
for what has no ground truth, the intent label and a two-sentence summary, and with no
key a rule fills those in instead.

Webhook delivery is at-least-once: the payload is stored in an outbox first, signed with
HMAC-SHA256, retried with backoff, and carries the call id as an idempotency key so the
receiver can drop duplicates. Undelivered payloads are retried by `retry-webhooks`.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import random
import time
from typing import Any, Literal

import httpx
from pydantic import BaseModel, Field

from .call import CallState
from .config import settings
from .pricing import CHECKED, cost_usd
from .store import CallStore
from .workflow import default_workflow

Intent = Literal["book", "reschedule", "cancel", "question", "urgent", "other"]


class Summary(BaseModel):
    intent: Intent = Field(description="The caller's main reason for calling.")
    summary: str = Field(description="Two sentences for the front desk: what the caller wanted"
                         " and what happened. No ids.")
    follow_up_needed: bool = Field(description="True if a person at the clinic must act.")


def end_status(state: CallState, close_reason: str | None, error: str | None) -> str:
    if state.transfer:
        return "transferred"
    if error:
        return "error"
    if state.ended_by_agent:
        return "resolved"
    if close_reason == "timed_out":
        return "timed_out"
    return "caller_hung_up"


def rule_summary(state: CallState, transcript: list[dict[str, str]]) -> Summary:
    actions = [f["action"] for f in state.facts]
    if state.guard_fired == "emergency":
        intent: Intent = "urgent"
    elif "booked" in actions:
        intent = "book"
    elif "rescheduled" in actions:
        intent = "reschedule"
    elif "cancelled" in actions:
        intent = "cancel"
    elif "answered" in actions:
        intent = "question"
    else:
        intent = "other"
    first = next((t["text"] for t in transcript if t["role"] == "user"), "")
    outcome = ", ".join(actions) or (f"transferred to {state.transfer['label']}"
                                     if state.transfer else "no action taken")
    said = f'Caller said "{first[:120].rstrip(".")}".' if first else "The caller did not speak."
    return Summary(intent=intent, summary=f"{said} Outcome: {outcome}.",
                   follow_up_needed=bool(state.transfer) or state.crm_degraded)


async def llm_summary(transcript: list[dict[str, str]], facts: list[dict[str, Any]]) -> Summary:
    from google import genai
    from google.genai import types

    client = genai.Client(api_key=settings().gemini_api_key)
    lines = "\n".join(f"{t['role']}: {t['text']}" for t in transcript)
    prompt = (
        "Summarise this clinic phone call for the front desk.\n"
        f"Actions the system recorded (ground truth): {json.dumps(facts)}\n\n"
        f"Transcript:\n{lines}"
    )
    response = await client.aio.models.generate_content(
        model=settings().extraction_model, contents=prompt,
        config=types.GenerateContentConfig(
            response_mime_type="application/json", response_schema=Summary, temperature=0),
    )
    return Summary.model_validate_json(response.text or "{}")


def transcript_of(state: CallState) -> list[dict[str, str]]:
    call = state.store.get_call(state.call_id) or {"events": []}
    return [{"role": e["data"]["role"], "text": e["data"]["text"]}
            for e in call["events"] if e["kind"] == "transcript"]


async def finish_call(
    state: CallState, *, close_reason: str | None = None, error: str | None = None,
    use_llm: bool = False, deliver: bool = True,
) -> dict[str, Any]:
    transcript = transcript_of(state)
    summary_source = "rules"
    summary = rule_summary(state, transcript)
    if use_llm and transcript:
        try:
            summary = await asyncio.wait_for(llm_summary(transcript, state.facts), timeout=40)
            summary_source = settings().extraction_model
        except Exception as exc:  # the record must still be written
            state.event("error", where="post_call_summary", error=type(exc).__name__)
    status = end_status(state, close_reason, error)
    usage = state.meter.as_dict()
    cost, unpriced = cost_usd(usage)
    duration = round(state.at(), 2)
    record = {
        "call_id": state.call_id,
        "clinic": state.workflow.clinic.name,
        "caller_phone": state.caller_phone,
        "patient_id": state.patient.id if state.patient else None,
        "end_status": status,
        "duration_seconds": duration,
        "transfer": state.transfer,
        "guard": state.guard_fired,
        "actions": state.facts,
        "intent": summary.intent,
        "summary": summary.summary,
        "follow_up_needed": summary.follow_up_needed,
        "summary_source": summary_source,
        "crm_degraded": state.crm_degraded,
    }
    state.event("post_call", end_status=status, intent=summary.intent,
                summary_source=summary_source)
    state.store.update_call(
        state.call_id, ended_at=time.time(), end_status=status,
        transfer_to=state.transfer["destination"] if state.transfer else None,
        cost_usd=cost, usage={"models": usage, "unpriced": unpriced, "prices_checked": CHECKED},
        summary=record)
    if deliver:
        state.store.outbox_put(state.call_id, record)
        await deliver_webhook(state.store, state.call_id, record,
                              on_attempt=lambda **kw: state.event("webhook", **kw))
    return record


def sign(secret: str, timestamp: str, body: bytes) -> str:
    mac = hmac.new(secret.encode(), timestamp.encode() + b"." + body, hashlib.sha256)
    return f"sha256={mac.hexdigest()}"


def verify(secret: str, timestamp: str, body: bytes, signature: str,
           tolerance_seconds: int = 300) -> bool:
    try:
        fresh = abs(time.time() - int(timestamp)) <= tolerance_seconds
    except ValueError:
        return False
    return fresh and hmac.compare_digest(sign(secret, timestamp, body), signature)


async def deliver_webhook(
    store: CallStore, call_id: str, payload: dict[str, Any], *, on_attempt: Any = None,
    transport: httpx.AsyncBaseTransport | None = None, sleep: Any = asyncio.sleep,
) -> bool:
    cfg = settings()
    webhook = default_workflow().post_call.webhook
    if not cfg.webhook_url:
        store.outbox_mark(call_id, status="failed", attempts=0, error="WEBHOOK_URL is not set")
        return False
    body = json.dumps(payload, sort_keys=True).encode()
    error = ""
    async with httpx.AsyncClient(transport=transport, timeout=webhook.timeout_seconds) as http:
        for attempt in range(1, webhook.max_attempts + 1):
            timestamp = str(int(time.time()))
            started = time.monotonic()
            try:
                response = await http.post(cfg.webhook_url, content=body, headers={
                    "Content-Type": "application/json",
                    "X-Webhook-Timestamp": timestamp,
                    "X-Webhook-Signature": sign(cfg.webhook_secret, timestamp, body),
                    "Idempotency-Key": call_id,
                })
                status: int | None = response.status_code
                ok = response.status_code < 300
                error = "" if ok else f"HTTP {response.status_code}"
            except httpx.HTTPError as exc:
                status, ok, error = None, False, type(exc).__name__
            if on_attempt:
                on_attempt(attempt=attempt, status=status, ok=ok,
                           ms=round((time.monotonic() - started) * 1000, 1))
            if ok:
                store.outbox_mark(call_id, status="delivered", attempts=attempt)
                return True
            # 4xx other than 408/429 will not succeed on retry: stop and leave it for a person.
            if status is not None and 400 <= status < 500 and status not in (408, 429):
                break
            if attempt < webhook.max_attempts:
                await sleep(random.uniform(0, min(4.0, 0.5 * 2 ** (attempt - 1))))
    store.outbox_mark(call_id, status="failed", attempts=attempt, error=error)
    return False
