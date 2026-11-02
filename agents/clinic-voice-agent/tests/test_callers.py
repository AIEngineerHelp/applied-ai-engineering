from __future__ import annotations

from voiceagent.callers import MAX_CALLER_TURNS, CallerReply, FixedCaller, ModelCaller
from voiceagent.kb import KnowledgeBase
from voiceagent.simulation import load_scenarios, run_scenario


def scenario(name: str):  # type: ignore[no-untyped-def]
    return next(s for s in load_scenarios() if s.name == name)


async def test_fixed_caller_reads_its_lines_then_stops() -> None:
    caller = FixedCaller(["hello", "bye"])
    assert (await caller.next_line([])).text == "hello"  # type: ignore[union-attr]
    assert (await caller.next_line([])).text == "bye"  # type: ignore[union-attr]
    assert await caller.next_line([]) is None


async def test_model_caller_opens_fixed_then_answers_the_transcript() -> None:
    prompts: list[str] = []

    async def fake(prompt: str):  # type: ignore[no-untyped-def]
        prompts.append(prompt)
        return CallerReply(say="The first one, please.", hang_up=False), {"input": 10, "output": 3}

    caller = ModelCaller(persona="Maya", goal="Book a visit.", opening="Hi there.",
                         clinic="Birchwood", generate=fake)
    first = await caller.next_line([])
    assert first is not None and first.text == "Hi there." and not prompts
    second = await caller.next_line([
        {"role": "assistant", "text": "I have 9 am or 10 am. Which works?"},
        {"role": "user", "text": "Hi there."},
    ])
    assert second is not None and second.text == "The first one, please."
    assert "Receptionist: I have 9 am or 10 am. Which works?" in prompts[0]
    assert "You: Hi there." in prompts[0]
    assert "Your goal: Book a visit." in prompts[0]
    assert caller.usage == {"input": 10, "output": 3}


async def test_model_caller_is_bounded() -> None:
    async def fake(prompt: str):  # type: ignore[no-untyped-def]
        return CallerReply(say="Hmm.", hang_up=False), {}

    caller = ModelCaller(persona="p", goal="g", opening="o", clinic="c", generate=fake)
    lines = [await caller.next_line([]) for _ in range(MAX_CALLER_TURNS + 1)]
    assert lines[-1] is None and all(lines[:-1])


class GoalCaller:
    """Stands in for a model caller offline: a line, then a goodbye that hangs up."""

    kind = "model"

    def __init__(self, lines: list[tuple[str, bool]]) -> None:
        self.lines = lines

    async def next_line(self, transcript):  # type: ignore[no-untyped-def]
        from voiceagent.callers import CallerTurn

        return CallerTurn(*self.lines.pop(0)) if self.lines else None


async def test_hang_up_ends_the_call_and_skips_fixed_only_checks(store) -> None:  # type: ignore[no-untyped-def]
    caller = GoalCaller([("I'd like to book an appointment.", False),
                         ("Okay, I'll call back to register. Bye.", True)])
    result = await run_scenario(scenario("unknown-caller-cannot-book"), live=False, store=store,
                                kb=KnowledgeBase(), caller=caller)
    names = [c["check"] for c in result["checks"]]
    assert result["passed"], result["checks"]
    assert "book_appointment -> refused" not in names  # fixed_expect: fixed callers only
    assert result["caller"] == "model"


async def test_fixed_callers_also_assert_fixed_expect(store) -> None:  # type: ignore[no-untyped-def]
    result = await run_scenario(scenario("unknown-caller-cannot-book"), live=False, store=store,
                                kb=KnowledgeBase())
    assert "book_appointment -> refused" in [c["check"] for c in result["checks"]]
