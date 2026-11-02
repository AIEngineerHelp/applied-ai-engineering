"""The clinic front-desk agent: instructions, in-call tools, guards, transfer and hang-up.

The model chooses what to say and which tool to call. Everything that must not depend on
the model's judgement is enforced here in code: booking needs a matched patient, a slot
must be one this call offered, an appointment must belong to the caller, and emergency
phrases transfer the call before the model is asked anything.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncIterable
from datetime import datetime
from typing import Any, Literal
from zoneinfo import ZoneInfo

from livekit.agents import (
    Agent,
    AgentSession,
    ModelSettings,
    RunContext,
    StopResponse,
    function_tool,
    llm,
)

from .call import CallState
from .crm.client import CRMError, Slot

Destination = Literal["nurse_line", "front_desk", "billing"]


def spoken_time(iso: str, tz: str) -> str:
    start = datetime.fromisoformat(iso).astimezone(ZoneInfo(tz))
    hour = start.strftime("%I").lstrip("0")
    minute = "" if start.minute == 0 else f":{start.minute:02d}"
    return f"{start:%A, %B} {start.day} at {hour}{minute} {start:%p}".replace("AM", "am").replace(
        "PM", "pm")


def build_instructions(state: CallState) -> str:
    wf = state.workflow
    tz = ZoneInfo(wf.clinic.timezone)
    today = datetime.now(tz)
    lines = [
        f"You are {wf.clinic.agent_name}, the phone receptionist for {wf.clinic.name}.",
        f"Today is {today:%A, %B} {today.day}, {today.year}."
        f" Clinic time zone: {wf.clinic.timezone}.",
        "",
        "How you speak:",
        "- This is a phone call. Use one or two short sentences per turn. No lists, no markdown.",
        "- Say dates and times the way a person would. Never read out ids like ap_5001 or sl_...",
        "- Offer at most three appointment times at once.",
        "",
        "What you do:",
        "- Book, reschedule or cancel appointments, and answer questions about the clinic.",
        "- Before booking, rescheduling or cancelling, repeat the time back and get a clear yes.",
        "- For questions about hours, location, fees, insurance, refills or results, call"
        " search_clinic_info and answer only from what it returns. If it has no answer, say so"
        " and offer the front desk.",
        "- Never give medical advice, interpret symptoms or results, or change prescriptions.",
        "- If a tool reports that the records system is unavailable, apologise once, and offer to"
        " transfer to the front desk. Do not promise a booking you could not make.",
        "- Billing questions you cannot answer from search_clinic_info go to the billing office.",
        "- When the caller is done, say goodbye and call end_call.",
        "",
    ]
    if state.patient:
        p = state.patient
        lines.append(f"The caller is a known patient: {p.first_name} {p.last_name}"
                     f" (patient id {p.id}). You may use their first name.")
        if state.appointments:
            lines.append("Their upcoming appointments:")
            for a in state.appointments:
                lines.append(f"- {a.id}: {spoken_time(a.start, wf.clinic.timezone)}"
                             f" with {a.provider_name} ({a.reason})")
        else:
            lines.append("They have no upcoming appointments.")
    elif state.crm_degraded:
        lines.append("The records system did not answer before the call. You do not know who"
                     " the caller is, and booking may fail. Offer the front desk for bookings.")
    else:
        lines.append("The caller's number does not match a patient record. You can answer"
                     " questions, but booking, rescheduling and cancelling need a registered"
                     " patient: offer to transfer them to the front desk to register.")
    return "\n".join(lines)


def speak(session: AgentSession[Any], text: str) -> Any:
    """Say fixed text. A realtime model has no separate TTS to read a script, so it is asked
    to repeat the words instead (it may paraphrase slightly)."""
    if session.tts is None and isinstance(session.llm, llm.RealtimeModel):
        return session.generate_reply(
            instructions=f"Say exactly this to the caller and nothing else: {text}",
            allow_interruptions=False)
    return session.say(text, allow_interruptions=False)


class ClinicAgent(Agent):
    def __init__(self, state: CallState, greeting: str) -> None:
        self.state = state
        self.greeting = greeting
        self.greeting_handle: Any = None
        self.greeted = asyncio.Event()
        super().__init__(instructions=build_instructions(state))
        # Agent registers every @function_tool method; keep only the ones this
        # customer's workflow enables.
        enabled = set(state.workflow.in_call.tools)
        self._tools = [t for t in self._tools
                       if getattr(getattr(t, "info", None), "name", None) in enabled
                       or not hasattr(t, "info")]

    async def on_enter(self) -> None:
        self.state.event("agent_say", text=self.greeting, purpose="greeting")
        self.greeting_handle = speak(self.session, self.greeting)
        self.greeted.set()

    async def llm_node(
        self, chat_ctx: llm.ChatContext, tools: list[llm.Tool], model_settings: ModelSettings
    ) -> AsyncIterable[Any]:
        """Check the guards before the LLM sees a new caller turn. Running here rather than
        in on_user_turn_completed means the same check covers voice calls and text
        simulations. A matched guard speaks its own line, and the model produces nothing."""
        last = chat_ctx.items[-1] if chat_ctx.items else None
        if isinstance(last, llm.ChatMessage) and last.role == "user":
            if await run_guards(self.session, self.state, last.text_content or "",
                                interrupt=False):
                return
        async for chunk in Agent.default.llm_node(self, chat_ctx, tools, model_settings):
            yield chunk

    # -- tool plumbing ----------------------------------------------------------------

    async def _tool(self, name: str, args: dict[str, Any], body: Any) -> str:
        started = time.monotonic()
        try:
            result = await body()
            outcome = "ok"
        except CRMError as exc:
            outcome = f"crm_{exc.kind}"
            result = {
                "timeout": "The records system did not respond in time.",
                "unavailable": "The records system is unavailable right now.",
                "bad_data": "The records system returned data I could not read.",
                "conflict": "That time was just taken by someone else. Offer other times.",
                "not_found": "The records system could not find that record.",
            }.get(exc.kind, "The records system rejected the request.")
        except PolicyError as exc:
            outcome = "refused"
            result = str(exc)
        text = result if isinstance(result, str) else json.dumps(result)
        self.state.event("tool", name=name, args=args, outcome=outcome, result=text[:600],
                         ms=round((time.monotonic() - started) * 1000, 1))
        return text

    def _require_patient(self, tool: str) -> None:
        if tool in self.state.workflow.in_call.require_patient_for and not self.state.patient:
            raise PolicyError("This needs a registered patient and the caller is not matched to"
                              " one. Offer to transfer them to the front desk.")

    def _slot_view(self, slot: Slot) -> dict[str, str]:
        return {"slot_id": slot.id, "time": spoken_time(slot.start, self.state.workflow.clinic
                                                        .timezone), "provider": slot.provider_name}

    def _own_appointment(self, appointment_id: str) -> None:
        if appointment_id not in {a.id for a in self.state.appointments}:
            raise PolicyError("That appointment id is not one of this caller's appointments."
                              " Use an id from their upcoming appointments.")

    def _offered(self, slot_id: str) -> None:
        if slot_id not in self.state.offered_slots:
            raise PolicyError("That slot id was not offered on this call. Call find_open_slots"
                              " and use one of the slot ids it returns.")

    # -- tools ------------------------------------------------------------------------

    @function_tool()
    async def find_open_slots(
        self, context: RunContext, day: str | None = None, provider_id: str | None = None
    ) -> str:
        """Find open appointment times.

        Args:
            day: Date to search, as YYYY-MM-DD. Leave empty for the next available times.
            provider_id: dr_rao, dr_patel or np_nair. Leave empty for any provider.
        """
        async def body() -> Any:
            # Without a named provider, try the caller's own doctor first.
            preferred = provider_id or (self.state.patient.primary_provider
                                        if self.state.patient else None)
            slots = await self.state.crm.open_slots(on=day, provider_id=preferred, want=3)
            if not slots and preferred and not provider_id:
                slots = await self.state.crm.open_slots(on=day, want=3)
            for slot in slots:
                self.state.offered_slots[slot.id] = slot
            if not slots:
                return "No open times match. Offer a different day or provider."
            return {"slots": [self._slot_view(s) for s in slots]}
        return await self._tool("find_open_slots", {"day": day, "provider_id": provider_id}, body)

    @function_tool()
    async def book_appointment(self, context: RunContext, slot_id: str, reason: str) -> str:
        """Book an open slot for the caller, after they have said yes to the time.

        Args:
            slot_id: A slot_id returned by find_open_slots on this call.
            reason: The reason for the visit, in a few words.
        """
        async def body() -> Any:
            self._require_patient("book_appointment")
            self._offered(slot_id)
            assert self.state.patient is not None
            appt = await self.state.crm.book(self.state.patient.id, slot_id, reason)
            self.state.appointments.append(appt)
            self.state.facts.append({"action": "booked", "appointment_id": appt.id,
                                     "start": appt.start, "provider": appt.provider_name})
            return {"booked": True, "time": spoken_time(appt.start, self.state.workflow.clinic
                                                         .timezone),
                    "provider": appt.provider_name}
        return await self._tool("book_appointment", {"slot_id": slot_id, "reason": reason}, body)

    @function_tool()
    async def reschedule_appointment(
        self, context: RunContext, appointment_id: str, new_slot_id: str
    ) -> str:
        """Move one of the caller's appointments to a new open slot, after they confirm.

        Args:
            appointment_id: The id of the caller's existing appointment.
            new_slot_id: A slot_id returned by find_open_slots on this call.
        """
        async def body() -> Any:
            self._require_patient("reschedule_appointment")
            self._own_appointment(appointment_id)
            self._offered(new_slot_id)
            appt = await self.state.crm.reschedule(appointment_id, new_slot_id)
            self.state.appointments = [appt if a.id == appt.id else a
                                       for a in self.state.appointments]
            self.state.facts.append({"action": "rescheduled", "appointment_id": appt.id,
                                     "start": appt.start, "provider": appt.provider_name})
            return {"rescheduled": True, "time": spoken_time(appt.start, self.state.workflow
                                                              .clinic.timezone)}
        return await self._tool("reschedule_appointment",
                                {"appointment_id": appointment_id, "new_slot_id": new_slot_id},
                                body)

    @function_tool()
    async def cancel_appointment(self, context: RunContext, appointment_id: str) -> str:
        """Cancel one of the caller's appointments, after they confirm.

        Args:
            appointment_id: The id of the caller's existing appointment.
        """
        async def body() -> Any:
            self._require_patient("cancel_appointment")
            self._own_appointment(appointment_id)
            appt = await self.state.crm.cancel(appointment_id)
            self.state.appointments = [a for a in self.state.appointments if a.id != appt.id]
            self.state.facts.append({"action": "cancelled", "appointment_id": appt.id,
                                     "start": appt.start})
            return {"cancelled": True}
        return await self._tool("cancel_appointment", {"appointment_id": appointment_id}, body)

    @function_tool()
    async def search_clinic_info(self, context: RunContext, question: str) -> str:
        """Look up clinic policy: hours, location, parking, fees, insurance, cancellations,
        refills, test results, telehealth.

        Args:
            question: The caller's question in their words.
        """
        async def body() -> Any:
            passages = self.state.kb.search(question)
            self.state.facts.append({"action": "answered", "question": question,
                                     "sources": [f"{p.source}#{p.heading}" for p in passages]})
            if not passages:
                return ("No matching clinic information. Say you don't know and offer the"
                        " front desk.")
            return {"passages": [{"source": f"{p.source}#{p.heading}", "text": p.text}
                                 for p in passages]}
        return await self._tool("search_clinic_info", {"question": question}, body)

    @function_tool()
    async def transfer_call(self, context: RunContext, destination: Destination,
                            reason: str) -> None:
        """Transfer the caller to a person. Use when they ask for a person, when you cannot
        help, or for billing questions you cannot answer.

        Args:
            destination: nurse_line, front_desk or billing.
            reason: Why the call is being transferred, in a few words.
        """
        label = self.state.workflow.transfers[destination].label
        self.state.event("tool", name="transfer_call",
                         args={"destination": destination, "reason": reason}, outcome="ok",
                         result=f"transferring to {label}", ms=0)
        await transfer(self.session, self.state, destination, reason,
                       f"I'm transferring you to the {label.lower()} now. Please hold.")
        raise StopResponse()

    @function_tool()
    async def end_call(self, context: RunContext, reason: str) -> None:
        """End the call after the caller is done and you have said goodbye.

        Args:
            reason: Why the call is ending, e.g. "booking done".
        """
        self.state.ended_by_agent = True
        self.state.event("tool", name="end_call", args={"reason": reason}, outcome="ok",
                         result="hanging up", ms=0)
        hang_up_after(self.session, context.speech_handle)
        raise StopResponse()


class PolicyError(Exception):
    """A tool call the workflow refuses, explained to the model in plain words."""


async def run_guards(session: AgentSession[Any], state: CallState, text: str, *,
                     interrupt: bool = True) -> bool:
    """Check a finished caller turn against the workflow's guards; act if one matches.

    `interrupt` stops a reply already under way, which a realtime model starts on its own.
    """
    if state.guard_fired or state.transfer:
        return False
    hit = state.workflow.check_guards(text)
    if not hit:
        return False
    guard, phrase = hit
    state.guard_fired = guard.name
    state.event("guard", name=guard.name, phrase=phrase, action=guard.action,
                destination=guard.destination)
    if interrupt:
        session.interrupt()
    await transfer(session, state, guard.destination, f"guard:{guard.name}", guard.say)
    return True


async def transfer(session: AgentSession[Any], state: CallState, destination: str, reason: str,
                   say: str) -> None:
    """Speak, then hand the caller to a person.

    On a phone call (a SIP participant) LiveKit asks the carrier to transfer the call once
    the message has played. A browser or simulated call has no phone line, so the transfer
    is recorded and the session ends after the message. The wait happens in a background
    task: a tool that awaited its own follow-up speech would deadlock the turn.
    """
    target = state.workflow.transfers[destination]
    state.transfer = {"destination": destination, "label": target.label, "reason": reason}
    state.event("agent_say", text=say, purpose="transfer")
    handle = speak(session, say)

    async def _after_message() -> None:
        mode = "simulated"
        try:
            await handle.wait_for_playout()
            sip = _sip_participant()
            if sip is not None:
                from livekit import api
                from livekit.agents import get_job_context

                job = get_job_context()
                await job.api.sip.transfer_sip_participant(api.TransferSIPParticipantRequest(
                    room_name=job.room.name, participant_identity=sip.identity,
                    transfer_to=f"tel:{target.phone}"))
                mode = "sip_refer"
        except Exception as exc:  # a failed transfer must still end the call cleanly
            mode = f"failed: {type(exc).__name__}"
        state.transfer = {**(state.transfer or {}), "mode": mode}
        state.event("transfer", destination=destination, mode=mode, reason=reason)
        if mode != "sip_refer":
            session.shutdown(drain=True)

    asyncio.get_running_loop().create_task(_after_message())


def _sip_participant() -> Any:
    from livekit import rtc
    from livekit.agents import get_job_context

    try:
        room = get_job_context().room
    except RuntimeError:
        return None  # no job: a text simulation
    return next((p for p in room.remote_participants.values()
                 if p.kind == rtc.ParticipantKind.PARTICIPANT_KIND_SIP), None)


def hang_up_after(session: AgentSession[Any], handle: Any) -> None:
    async def _later() -> None:
        try:
            await handle.wait_for_playout()
        finally:
            session.shutdown(drain=True)
    asyncio.get_running_loop().create_task(_later())
