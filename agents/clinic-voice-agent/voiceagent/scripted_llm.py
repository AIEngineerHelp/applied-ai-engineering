"""A rule-based stand-in for the LLM, so simulations run with no key and no cost.

It is not a model and is not meant to be clever: it reads the caller's words with
keyword rules and picks a tool the way a well-behaved model would. That is enough to
drive the real workflow end to end, through the real tools, CRM client, guards,
transfers and post-call steps, which is what the offline simulation is testing.
Results from it say nothing about how a real model would behave; `simulate --live`
answers that with Gemini.
"""

from __future__ import annotations

import json
import re
import uuid
from typing import Any

from livekit.agents import APIConnectOptions, llm
from livekit.agents.llm import ChatChunk, ChoiceDelta, CompletionUsage, FunctionToolCall
from livekit.agents.types import DEFAULT_API_CONNECT_OPTIONS, NOT_GIVEN, NotGivenOr

QUESTION_WORDS = (
    "hours", "open", "close", "parking", "park", "address", "where", "insurance", "accept",
    "fee", "cost", "price", "refill", "prescription", "result", "telehealth", "video", "bring",
    "policy", "pay",
)
YES = re.compile(r"\b(yes|yeah|yep|sure|that works|sounds good|perfect|first one|ok|okay)\b")
GOODBYE = re.compile(r"\b(bye|goodbye|that's all|that is all|that's it|nothing else|no thanks)\b")


class ScriptedLLM(llm.LLM):
    @property
    def model(self) -> str:
        return "scripted"

    @property
    def provider(self) -> str:
        return "offline"

    def chat(
        self,
        *,
        chat_ctx: llm.ChatContext,
        tools: list[llm.Tool] | None = None,
        conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS,
        parallel_tool_calls: NotGivenOr[bool] = NOT_GIVEN,
        tool_choice: NotGivenOr[llm.ToolChoice] = NOT_GIVEN,
        extra_kwargs: NotGivenOr[dict[str, Any]] = NOT_GIVEN,
    ) -> llm.LLMStream:
        return _ScriptedStream(self, chat_ctx=chat_ctx, tools=tools or [],
                               conn_options=conn_options)


class _ScriptedStream(llm.LLMStream):
    async def _run(self) -> None:
        text, call = decide(self._chat_ctx)
        delta = ChoiceDelta(role="assistant", content=text or None,
                            tool_calls=[call] if call else [])
        self._event_ch.send_nowait(ChatChunk(id=uuid.uuid4().hex, delta=delta))
        self._event_ch.send_nowait(ChatChunk(
            id=uuid.uuid4().hex,
            usage=CompletionUsage(completion_tokens=0, prompt_tokens=0, total_tokens=0)))


def _call(name: str, **args: Any) -> FunctionToolCall:
    return FunctionToolCall(name=name, arguments=json.dumps(args), call_id=uuid.uuid4().hex[:8])


def decide(ctx: llm.ChatContext) -> tuple[str, FunctionToolCall | None]:
    items = ctx.items
    instructions = next((i.text_content or "" for i in items
                         if i.type == "message" and i.role in ("system", "developer")), "")
    users = [i.text_content or "" for i in items if i.type == "message" and i.role == "user"]
    last = items[-1] if items else None

    if last is not None and last.type == "function_call_output":
        return _after_tool(last.name, last.output, users), None

    said = (users[-1] if users else "").lower()
    history = " ".join(users).lower()
    appointments = re.findall(r"- (ap_\d+):", instructions)
    offered = _last_offered(items)

    if GOODBYE.search(said):
        return "Thanks for calling. Goodbye!", _call("end_call", reason="caller done")
    if "bill" in said and not any(w in said for w in ("insurance", "accept")):
        return "", _call("transfer_call", destination="billing", reason="billing question")
    if "cancel" in said and "policy" not in said and "fee" not in said:
        if appointments:
            return "", _call("cancel_appointment", appointment_id=appointments[0])
        return "", _call("cancel_appointment", appointment_id="ap_unknown")
    if YES.search(said) and offered:
        if "reschedule" in history or "move" in history:
            target = appointments[0] if appointments else "ap_unknown"
            return "", _call("reschedule_appointment", appointment_id=target,
                             new_slot_id=offered[0])
        return "", _call("book_appointment", slot_id=offered[0], reason=_reason(history))
    if any(w in said for w in ("book", "appointment", "reschedule", "move", "see the doctor",
                               "see a doctor", "schedule", "available")):
        day = re.search(r"\d{4}-\d{2}-\d{2}", said)
        return "", _call("find_open_slots", day=day.group(0) if day else None)
    if any(w in said for w in QUESTION_WORDS) or said.strip().endswith("?"):
        return "", _call("search_clinic_info", question=users[-1])
    return "Sorry, could you tell me a little more about what you need?", None


def _last_offered(items: list[Any]) -> list[str]:
    for item in reversed(items):
        if item.type == "function_call_output" and item.name == "find_open_slots":
            try:
                return [s["slot_id"] for s in json.loads(item.output)["slots"]]
            except (ValueError, KeyError, TypeError):
                return []
    return []


def _reason(history: str) -> str:
    match = re.search(r"\bfor (?:a |an |my )?([a-z ]{3,30}?)(?:[.,?!]|$)", history)
    return match.group(1).strip() if match else "general visit"


def _after_tool(name: str, output: str, users: list[str]) -> str:
    try:
        data = json.loads(output)
    except ValueError:
        data = None
    if not isinstance(data, dict):
        if "records system" in output:
            return ("I'm sorry, our records system isn't responding right now. I can transfer"
                    " you to the front desk, or you can call back a little later.")
        return output.split(". ")[0] + "."
    if name == "find_open_slots":
        slots = data.get("slots", [])
        options = " or ".join(f"{s['time']} with {s['provider']}" for s in slots[:2])
        return f"I have {options}. Would the first one work?"
    if name == "book_appointment":
        return f"You're booked for {data['time']} with {data['provider']}. Anything else?"
    if name == "reschedule_appointment":
        return f"Done, your appointment is now {data['time']}. Anything else?"
    if name == "cancel_appointment":
        return "Your appointment is cancelled. Anything else I can help with?"
    if name == "search_clinic_info":
        passages = data.get("passages", [])
        return (passages[0]["text"].split(". ")[0] + ".") if passages else "I'm not sure."
    return "Okay."
