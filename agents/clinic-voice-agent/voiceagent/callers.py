"""Simulated callers: who is on the other end of a simulated call.

FixedCaller reads lines written in advance. It is deterministic and free, so it is the
regression test for the workflow, but it does not listen: if the agent asks "which of
these times?", its next line may be "That's all, bye".

ModelCaller is a second model playing a person with a goal ("book a visit for a sore
throat, take the first time offered"). It answers what the agent actually asked, so a
live run measures whether the agent gets the caller to their goal, not whether the
agent happened to follow one script.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Protocol

from pydantic import BaseModel, Field

from .config import settings

MAX_CALLER_TURNS = 8


@dataclass
class CallerTurn:
    text: str
    hang_up: bool = False


class Caller(Protocol):
    kind: str

    async def next_line(self, transcript: list[dict[str, str]]) -> CallerTurn | None:
        """The caller's next line given the call so far, or None to hang up silently."""
        ...


@dataclass
class FixedCaller:
    turns: list[str]
    kind: str = "fixed"
    _next: int = 0

    async def next_line(self, transcript: list[dict[str, str]]) -> CallerTurn | None:
        if self._next >= len(self.turns):
            return None
        self._next += 1
        return CallerTurn(self.turns[self._next - 1])


class CallerReply(BaseModel):
    say: str = Field(description="What you say next, as a caller on the phone.")
    hang_up: bool = Field(description="True once your goal is done, impossible, or you are"
                          " being transferred. Say goodbye in `say` first.")


Generate = Callable[[str], Awaitable[tuple[CallerReply, dict[str, int]]]]

PROMPT = """You are role-playing a person phoning {clinic}, to test its phone receptionist.

Who you are: {persona}
Your goal: {goal}

How to behave:
- Talk like a caller on the phone: one or two short sentences, plain words.
- Answer the receptionist's questions directly. If it asks you to confirm something that
  fits your goal, say yes.
- Only use the details given above. If asked something you don't know, say you're not sure.
- Never mention ids, tools, tests or that you are role-playing.
- When your goal is done, cannot be done, or the receptionist is transferring you, say a
  short goodbye and set hang_up to true.

The call so far:
{transcript}

What do you say next?"""


@dataclass
class ModelCaller:
    persona: str
    goal: str
    opening: str
    clinic: str
    generate: Generate | None = None
    kind: str = "model"
    usage: dict[str, int] = field(default_factory=lambda: {"input": 0, "output": 0})
    _turns: int = 0

    async def next_line(self, transcript: list[dict[str, str]]) -> CallerTurn | None:
        self._turns += 1
        if self._turns == 1:
            return CallerTurn(self.opening)  # every run of a scenario starts the same way
        if self._turns > MAX_CALLER_TURNS:
            return None
        lines = "\n".join(f"{'Receptionist' if t['role'] == 'assistant' else 'You'}: {t['text']}"
                          for t in transcript)
        prompt = PROMPT.format(clinic=self.clinic, persona=self.persona, goal=self.goal,
                               transcript=lines)
        reply, usage = await (self.generate or gemini_generate)(prompt)
        for key in self.usage:
            self.usage[key] += usage.get(key, 0)
        return CallerTurn(reply.say.strip(), reply.hang_up)


async def gemini_generate(prompt: str) -> tuple[CallerReply, dict[str, int]]:
    import asyncio

    from google import genai
    from google.genai import types

    cfg = settings()
    client = genai.Client(api_key=cfg.gemini_api_key)
    response: Any = await asyncio.wait_for(client.aio.models.generate_content(
        model=cfg.caller_model, contents=prompt,
        config=types.GenerateContentConfig(
            response_mime_type="application/json", response_schema=CallerReply,
            temperature=0.3),
    ), timeout=30)
    meta = response.usage_metadata
    usage = {"input": getattr(meta, "prompt_token_count", 0) or 0,
             "output": getattr(meta, "candidates_token_count", 0) or 0}
    return CallerReply.model_validate_json(response.text or "{}"), usage
